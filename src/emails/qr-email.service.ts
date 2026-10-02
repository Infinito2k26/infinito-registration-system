import { Injectable } from '@nestjs/common';
import {
  ActivityType,
  EmailDeliveryStatus,
  EmailStatus,
  PaymentStatus,
  Person,
  Prisma,
  Registration,
} from '@prisma/client';
import { AppConfig } from '../config/app-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { qrPassUrl } from '../qr/qr-image';
import { recordActivity } from '../registrations/activity';
import { EmailTemplate } from './email-templates';
import { EmailOutboxService } from './email-outbox.service';
import { EmailWorkerService } from './email-worker.service';

export const initialQrKey = (registrationId: string) => `qr-pass:${registrationId}:initial`;
const resendKeyPrefix = (registrationId: string) => `qr-pass:${registrationId}:resend:`;

export class QrEmailError extends Error {}

export interface QrEmailSummary {
  /** Successfully handed to the provider. */
  sentCount: number;
  lastSentAt: Date | null;
  /** Delivery status of the most recent sent email, if Resend has reported it. */
  lastDeliveryStatus: EmailDeliveryStatus | null;
  /** A QR email is waiting to be sent (e.g. inside the undo window). */
  queued: { sendAt: Date } | null;
  lastFailure: string | null;
  manualResendsUsed: number;
  manualResendLimit: number;
}

type RegistrationWithPerson = Registration & { person: Person };

@Injectable()
export class QrEmailService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: EmailOutboxService,
    private readonly worker: EmailWorkerService,
    private readonly config: AppConfig,
  ) {}

  /**
   * Queues the one-and-only automatic QR email for a newly verified registration.
   * Re-verifying never adds a second one: the key is fixed per registration. If an earlier
   * one was cancelled by an undo/reject before it went out, it is re-armed instead.
   * Returns true when an email is now scheduled because of this call.
   */
  async queueInitial(
    tx: Prisma.TransactionClient,
    reg: RegistrationWithPerson,
    context: { teamName: string; actorId: string },
  ): Promise<boolean> {
    if (!reg.person.qrToken) throw new QrEmailError('Person has no QR token');
    const key = initialQrKey(reg.id);
    const sendAt = new Date(Date.now() + this.config.decisionEmailDelaySeconds * 1000);

    const revived = await tx.emailOutbox.updateMany({
      where: { idempotencyKey: key, status: EmailStatus.CANCELLED },
      data: { status: EmailStatus.PENDING, sendAt, triggeredById: context.actorId, attempts: 0, lastError: null },
    });
    const created =
      revived.count > 0
        ? 0
        : await this.outbox.enqueue(
            [{ ...this.qrEmail(reg, context.teamName), idempotencyKey: key, triggeredById: context.actorId, sendAt }],
            tx,
          );
    return revived.count + created > 0;
  }

  /** Staff-initiated resend, capped at QR_MANUAL_RESEND_LIMIT per registration. */
  async resend(registrationId: string, actorId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'qr-resend:' + registrationId}))`;
      const reg = await tx.registration.findUnique({
        where: { id: registrationId },
        include: { person: true, team: { select: { name: true } } },
      });
      if (!reg) throw new QrEmailError('Registration not found');
      if (reg.paymentStatus !== PaymentStatus.VERIFIED || !reg.person.qrToken) {
        throw new QrEmailError('Payment is not verified, so there is no pass to send');
      }

      const qrRows = await tx.emailOutbox.findMany({
        where: { registrationId, template: EmailTemplate.QrPass },
        select: { idempotencyKey: true, status: true },
      });
      if (qrRows.some((r) => r.status === EmailStatus.PENDING || r.status === EmailStatus.PROCESSING)) {
        throw new QrEmailError('A QR email for this participant is already queued');
      }
      const resends = qrRows.filter((r) => r.idempotencyKey.startsWith(resendKeyPrefix(registrationId)));
      const used = resends.filter((r) => r.status !== EmailStatus.CANCELLED).length;
      const limit = this.config.qrManualResendLimit;
      if (used >= limit) {
        throw new QrEmailError(`Resend limit reached (${limit} manual resends per participant per event)`);
      }

      const attempt = resends.length + 1;
      await this.outbox.enqueue(
        [
          {
            ...this.qrEmail(reg, reg.team?.name ?? reg.person.name ?? ''),
            idempotencyKey: `${resendKeyPrefix(registrationId)}${attempt}`,
            triggeredById: actorId,
          },
        ],
        tx,
      );
      await recordActivity(tx, [
        {
          registrationId,
          type: ActivityType.QR_EMAIL_RESENT,
          actorId,
          details: { resend: used + 1, limit, toEmail: reg.person.email },
        },
      ]);
    });
    this.worker.kick();
  }

  async summaries(registrationIds: string[]): Promise<Map<string, QrEmailSummary>> {
    const rows = await this.prisma.emailOutbox.findMany({
      where: { registrationId: { in: registrationIds }, template: EmailTemplate.QrPass },
      orderBy: { createdAt: 'asc' },
    });
    const limit = this.config.qrManualResendLimit;
    const result = new Map<string, QrEmailSummary>();
    for (const id of registrationIds) {
      const mine = rows.filter((r) => r.registrationId === id);
      const sent = mine.filter((r) => r.status === EmailStatus.SENT);
      const last = sent.reduce<(typeof sent)[number] | null>(
        (acc, r) => (!acc || (r.sentAt ?? 0) > (acc.sentAt ?? 0) ? r : acc),
        null,
      );
      const queued = mine.find((r) => r.status === EmailStatus.PENDING || r.status === EmailStatus.PROCESSING);
      const failed = [...mine].reverse().find((r) => r.status === EmailStatus.FAILED);
      result.set(id, {
        sentCount: sent.length,
        lastSentAt: last?.sentAt ?? null,
        lastDeliveryStatus: last?.deliveryStatus ?? null,
        queued: queued ? { sendAt: queued.sendAt } : null,
        lastFailure: failed?.lastError ?? null,
        manualResendsUsed: mine.filter(
          (r) => r.idempotencyKey.startsWith(resendKeyPrefix(id)) && r.status !== EmailStatus.CANCELLED,
        ).length,
        manualResendLimit: limit,
      });
    }
    return result;
  }

  private qrEmail(reg: RegistrationWithPerson, teamName: string) {
    const eventName = this.config.eventName(reg.eventSlug);
    return {
      toEmail: reg.person.email,
      personId: reg.personId,
      registrationId: reg.id,
      template: EmailTemplate.QrPass,
      subject: `Your Infinito 2K26 entry pass: ${eventName}`,
      payload: {
        name: reg.person.name ?? '',
        eventName,
        team: teamName,
        qrUrl: qrPassUrl(this.config.baseUrl, reg.person.qrToken!),
      },
    };
  }
}
