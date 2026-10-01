import { Injectable, Logger } from '@nestjs/common';
import {
  ActivityType,
  EmailStatus,
  PaymentStatus,
  Prisma,
  RegistrationStatus,
} from '@prisma/client';
import { AppConfig } from '../config/app-config.service';
import { EmailTemplate } from '../emails/email-templates';
import { EmailOutboxService } from '../emails/email-outbox.service';
import { QrEmailService } from '../emails/qr-email.service';
import { PrismaService } from '../prisma/prisma.service';
import { generateQrToken } from '../qr/qr-token';
import { ActivityEntry, recordActivity } from '../registrations/activity';

/** The action is not allowed in the current state; the message is shown to the coordinator. */
export class PaymentActionError extends Error {}

export interface PaymentActionResult {
  changed: number;
  emailsQueued: number;
  message: string;
}

type Tx = Prisma.TransactionClient;

/**
 * Payment decisions are made per team (= one form response, one transaction ID)
 * and applied to every member's registration in one transaction.
 * A per-team advisory lock serialises concurrent clicks; verification also takes
 * a per-transaction-ID lock so two teams with the same txn can't both be verified.
 */
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: EmailOutboxService,
    private readonly qrEmails: QrEmailService,
    private readonly config: AppConfig,
  ) {}

  async verifyTeam(teamId: string, actorId: string): Promise<PaymentActionResult> {
    return this.inTeamLock(teamId, async (tx, team) => {
      const toVerify = team.registrations.filter((r) => r.paymentStatus !== PaymentStatus.VERIFIED);
      if (toVerify.length === 0) {
        return { changed: 0, emailsQueued: 0, message: 'Already verified; no emails sent' };
      }

      const txn = team.registrations.find((r) => r.transactionId)?.transactionId;
      if (txn) {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'txn:' + txn}))`;
        const clash = await tx.registration.findFirst({
          where: { transactionId: txn, teamId: { not: team.id }, paymentStatus: PaymentStatus.VERIFIED },
          include: { team: { select: { name: true } } },
        });
        if (clash) {
          throw new PaymentActionError(
            `Transaction ${txn} is already verified for team "${clash.team?.name ?? 'unknown'}" (${this.config.eventName(clash.eventSlug)}). Reject this one or check with that team.`,
          );
        }
      }

      const now = new Date();
      let emailsQueued = 0;
      const activity: ActivityEntry[] = [];
      for (const reg of toVerify) {
        // Conditional update so two verifications touching the same person agree on one token.
        await tx.person.updateMany({
          where: { id: reg.personId, qrToken: null },
          data: { qrToken: generateQrToken() },
        });
        const person = await tx.person.findUniqueOrThrow({ where: { id: reg.personId } });

        const updated = await tx.registration.update({
          where: { id: reg.id },
          data: {
            paymentStatus: PaymentStatus.VERIFIED,
            status: RegistrationStatus.CONFIRMED,
            paymentRemarks: null,
            paymentReviewedById: actorId,
            paymentReviewedAt: now,
          },
        });
        activity.push({
          registrationId: reg.id,
          type: ActivityType.PAYMENT_VERIFIED,
          actorId,
          details: { transactionId: txn ?? null, previousStatus: reg.paymentStatus },
        });

        if (await this.qrEmails.queueInitial(tx, { ...updated, person }, { teamName: team.name, actorId })) {
          emailsQueued++;
          activity.push({ registrationId: reg.id, type: ActivityType.QR_EMAIL_QUEUED, actorId, details: { toEmail: person.email } });
        }
      }

      // A rejection email still inside its undo window is now wrong; drop it.
      await this.cancelPending(tx, team.registrations.map((r) => r.id), EmailTemplate.PaymentRejected);
      await recordActivity(tx, activity);

      return {
        changed: toVerify.length,
        emailsQueued,
        message: `Verified ${toVerify.length} member(s); ${emailsQueued} QR email(s) go out in ${this.config.decisionEmailDelaySeconds}s unless undone`,
      };
    });
  }

  async rejectTeam(teamId: string, actorId: string, remarks: string): Promise<PaymentActionResult> {
    const reason = remarks.trim();
    if (!reason) throw new PaymentActionError('A rejection reason is required');

    return this.inTeamLock(teamId, async (tx, team) => {
      if (team.registrations.some((r) => r.enteredAt)) {
        throw new PaymentActionError('A member of this team has already entered; payment can no longer be rejected');
      }
      const alreadyRejected = team.registrations.every(
        (r) => r.paymentStatus === PaymentStatus.REJECTED && r.paymentRemarks === reason,
      );
      if (alreadyRejected) return { changed: 0, emailsQueued: 0, message: 'Already rejected with this reason' };

      const now = new Date();
      await tx.registration.updateMany({
        where: { id: { in: team.registrations.map((r) => r.id) } },
        data: {
          paymentStatus: PaymentStatus.REJECTED,
          status: RegistrationStatus.PENDING,
          paymentRemarks: reason,
          paymentReviewedById: actorId,
          paymentReviewedAt: now,
        },
      });
      // Revoking a verification: any QR email not yet sent must not go out.
      const cancelledQr = await this.cancelPending(tx, team.registrations.map((r) => r.id), EmailTemplate.QrPass);

      await recordActivity(
        tx,
        team.registrations.map((r) => ({
          registrationId: r.id,
          type: ActivityType.PAYMENT_REJECTED,
          actorId,
          details: { remarks: reason, previousStatus: r.paymentStatus, cancelledQrEmails: cancelledQr },
        })),
      );

      const captain =
        team.registrations.find((r) => r.person.email === team.captainEmail) ?? team.registrations[0];
      const previous = await tx.emailOutbox.count({
        where: { idempotencyKey: { startsWith: `payment-rejected:${team.id}:` } },
      });
      const emailsQueued = await this.outbox.enqueue(
        [
          {
            idempotencyKey: `payment-rejected:${team.id}:${previous + 1}`,
            toEmail: captain.person.email,
            personId: captain.personId,
            registrationId: captain.id,
            triggeredById: actorId,
            template: EmailTemplate.PaymentRejected,
            subject: `Infinito 2K26: payment issue with your ${this.config.eventName(team.eventSlug)} registration`,
            sendAt: new Date(now.getTime() + this.config.decisionEmailDelaySeconds * 1000),
            payload: {
              name: captain.person.name ?? '',
              eventName: this.config.eventName(team.eventSlug),
              team: team.name,
              transactionId: captain.transactionId ?? null,
              remarks: reason,
            },
          },
        ],
        tx,
      );

      return {
        changed: team.registrations.length,
        emailsQueued,
        message: `Rejected. The captain (${captain.person.email}) is emailed in ${this.config.decisionEmailDelaySeconds}s`,
      };
    });
  }

  /** Undo a verification while no QR email has gone out yet and nobody has entered. */
  async undoVerification(teamId: string, actorId: string): Promise<PaymentActionResult> {
    return this.inTeamLock(teamId, async (tx, team) => {
      const verified = team.registrations.filter((r) => r.paymentStatus === PaymentStatus.VERIFIED);
      if (verified.length === 0) throw new PaymentActionError('Nothing to undo: no member is verified');
      if (verified.some((r) => r.enteredAt)) {
        throw new PaymentActionError('A member has already entered; reject the payment instead if needed');
      }
      const ids = verified.map((r) => r.id);
      const gone = await tx.emailOutbox.count({
        where: {
          registrationId: { in: ids },
          template: EmailTemplate.QrPass,
          status: { in: [EmailStatus.PROCESSING, EmailStatus.SENT] },
        },
      });
      if (gone > 0) {
        throw new PaymentActionError('QR emails have already been sent; use Reject (with a reason) instead');
      }

      const cancelled = await this.cancelPending(tx, ids, EmailTemplate.QrPass);
      await tx.registration.updateMany({
        where: { id: { in: ids } },
        data: {
          paymentStatus: PaymentStatus.PENDING,
          status: RegistrationStatus.PENDING,
          paymentReviewedById: actorId,
          paymentReviewedAt: new Date(),
        },
      });
      await recordActivity(
        tx,
        ids.map((registrationId) => ({
          registrationId,
          type: ActivityType.PAYMENT_UNVERIFIED,
          actorId,
          details: { cancelledQrEmails: cancelled },
        })),
      );
      return { changed: ids.length, emailsQueued: 0, message: `Verification undone; ${cancelled} QR email(s) cancelled` };
    });
  }

  private async cancelPending(tx: Tx, registrationIds: string[], template: string): Promise<number> {
    const { count } = await tx.emailOutbox.updateMany({
      where: { registrationId: { in: registrationIds }, template, status: EmailStatus.PENDING },
      data: { status: EmailStatus.CANCELLED },
    });
    return count;
  }

  private async inTeamLock<T>(
    teamId: string,
    fn: (tx: Tx, team: Prisma.TeamGetPayload<{ include: { registrations: { include: { person: true } } } }>) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'team:' + teamId}))`;
        const team = await tx.team.findUnique({
          where: { id: teamId },
          include: { registrations: { include: { person: true }, orderBy: { createdAt: 'asc' } } },
        });
        if (!team || team.registrations.length === 0) throw new PaymentActionError('Team not found');
        const result = await fn(tx, team);
        this.logger.log(`Team ${teamId}: ${JSON.stringify(result)}`);
        return result;
      },
      { maxWait: 10_000, timeout: 20_000 },
    );
  }
}
