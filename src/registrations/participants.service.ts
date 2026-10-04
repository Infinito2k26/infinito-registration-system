import { Injectable } from '@nestjs/common';
import { ActivityType, EmailStatus, PaymentStatus, Prisma } from '@prisma/client';
import { z } from 'zod';
import { AppConfig } from '../config/app-config.service';
import { EmailOutboxService } from '../emails/email-outbox.service';
import { EmailTemplate } from '../emails/email-templates';
import { EmailWorkerService } from '../emails/email-worker.service';
import { QrEmailService } from '../emails/qr-email.service';
import { normalizeEmail } from '../forms/form-response.parser';
import { PrismaService } from '../prisma/prisma.service';
import { ActivityEntry, recordActivity } from './activity';

/** Shown to the coordinator as-is. Nothing was changed. */
export class ParticipantActionError extends Error {}

const emailSchema = z.email();

export const registrationReceivedKey = (eventSlug: string, personId: string) => `registration-received:${eventSlug}:${personId}`;

/** Flash text after a Change email. `shownFrom` lets the gate mask the old address for volunteers. */
export function changeEmailMessage(result: { from: string | null; to: string; queued: NewAddressEmails }, shownFrom = result.from): string {
  if (result.from) return `Email changed from ${shownFrom} to ${result.to}. No email was sent; use Send QR email if needed.`;
  const { registrationEmails, qrEmails } = result.queued;
  return (
    `Email added: ${result.to}. Queued ${registrationEmails} registration email(s)` +
    (qrEmails ? ` and ${qrEmails} QR pass email(s).` : '. The QR pass is emailed once the registration is verified.')
  );
}

export interface NewAddressEmails {
  /** "Registration received" emails queued now (one per event not emailed before). */
  registrationEmails: number;
  /** QR pass emails queued now (verified registrations only). */
  qrEmails: number;
}

@Injectable()
export class ParticipantsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: EmailOutboxService,
    private readonly qrEmails: QrEmailService,
    private readonly worker: EmailWorkerService,
    private readonly config: AppConfig,
  ) {}

  /**
   * A participant who had NO email now has one (staff Change email, or a resynced form row).
   * Queues, to that address, what they could not be sent before:
   *   - the normal "registration received" email for every registration, and
   *   - the QR pass email for every VERIFIED registration (same existing QR token).
   * Pending registrations get no QR email here; verification queues it as usual.
   * The idempotency keys are the ones ingest/verification use, so repeating this (double
   * click, resync, retry) or a later verification never sends either email twice.
   * Call inside the transaction that set the email.
   */
  async queueEmailsForNewAddress(tx: Prisma.TransactionClient, personId: string, actorId?: string): Promise<NewAddressEmails> {
    const person = await tx.person.findUniqueOrThrow({
      where: { id: personId },
      include: {
        registrations: {
          orderBy: { createdAt: 'asc' },
          include: { team: { select: { name: true, members: { where: { personId }, select: { role: true } } } } },
        },
      },
    });
    const email = person.email;
    if (!email) return { registrationEmails: 0, qrEmails: 0 };

    const registrationEmails = await this.outbox.enqueue(
      person.registrations.map((reg) => ({
        idempotencyKey: registrationReceivedKey(reg.eventSlug, personId),
        personId,
        registrationId: reg.id,
        triggeredById: actorId,
        toEmail: email,
        subject: `Infinito 2K26: registration received for ${this.config.eventName(reg.eventSlug)}`,
        template: EmailTemplate.RegistrationReceived,
        payload: {
          name: person.name ?? '',
          eventName: this.config.eventName(reg.eventSlug),
          team: reg.team?.name ?? person.name ?? '',
          isCaptain: reg.team?.members[0]?.role === 'CAPTAIN',
          transactionId: reg.transactionId ?? null,
          verified: reg.paymentStatus === PaymentStatus.VERIFIED,
        },
      })),
      tx,
    );

    let qrEmails = 0;
    const activity: ActivityEntry[] = [];
    for (const reg of person.registrations) {
      if (reg.paymentStatus !== PaymentStatus.VERIFIED || !person.qrToken) continue;
      const queued = await this.qrEmails.queueInitial(tx, { ...reg, person }, { teamName: reg.team?.name ?? '', actorId, sendAt: new Date() });
      if (!queued) continue;
      qrEmails++;
      activity.push({ registrationId: reg.id, type: ActivityType.QR_EMAIL_QUEUED, actorId, details: { toEmail: email, reason: 'email added' } });
    }
    await recordActivity(tx, activity);
    return { registrationEmails, qrEmails };
  }

  /**
   * Blocks the participant's QR at the gate (every event): no check-in, no check-out, until
   * unblocked. Verification, QR token and IN/OUT history are untouched.
   */
  async block(personId: string, actorId: string, rawReason: string): Promise<void> {
    const reason = rawReason.trim().slice(0, 500) || null;
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'person-block:' + personId}))`;
      const person = await tx.person.findUnique({ where: { id: personId }, include: { registrations: { select: { id: true, insideSince: true } } } });
      if (!person) throw new ParticipantActionError('Participant not found');
      if (person.blockedAt) throw new ParticipantActionError('Already blocked');
      await tx.person.update({
        where: { id: personId },
        data: { blockedAt: new Date(), blockedById: actorId, blockReason: reason },
      });
      await recordActivity(
        tx,
        person.registrations.map((r) => ({
          registrationId: r.id,
          type: ActivityType.BLOCKED,
          actorId,
          details: { reason, wasInside: r.insideSince !== null },
        })),
      );
    });
  }

  /** Lifts the block; the gate then follows the participant's current IN/OUT state again. */
  async unblock(personId: string, actorId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'person-block:' + personId}))`;
      const person = await tx.person.findUnique({ where: { id: personId }, include: { registrations: { select: { id: true } } } });
      if (!person) throw new ParticipantActionError('Participant not found');
      if (!person.blockedAt) throw new ParticipantActionError('Not blocked');
      await tx.person.update({
        where: { id: personId },
        data: { blockedAt: null, blockedById: null, blockReason: null },
      });
      await recordActivity(
        tx,
        person.registrations.map((r) => ({
          registrationId: r.id,
          type: ActivityType.UNBLOCKED,
          actorId,
          details: { previousReason: person.blockReason, blockedSince: person.blockedAt?.toISOString() ?? null },
        })),
      );
    });
  }

  /**
   * Changes a participant's email in place: same person, same registrations, same QR token,
   * same verification and entry history. The old address becomes an alias so a resync of an
   * old sheet row maps back to this person instead of recreating the old address. Emails
   * still waiting in the outbox for this person are redirected. Changing an existing email
   * sends nothing; adding the FIRST email queues what could not be sent before (see
   * queueEmailsForNewAddress): registration email always, QR email only if verified.
   */
  async changeEmail(
    personId: string,
    rawEmail: string,
    actorId: string,
  ): Promise<{ from: string | null; to: string; queued: NewAddressEmails }> {
    const to = normalizeEmail(rawEmail);
    if (!emailSchema.safeParse(to).success) throw new ParticipantActionError(`"${rawEmail}" is not a valid email`);

    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'person-email:' + personId}))`;
      const person = await tx.person.findUnique({
        where: { id: personId },
        include: { registrations: { select: { id: true } } },
      });
      if (!person) throw new ParticipantActionError('Participant not found');
      const from = person.email;
      if (from === to) throw new ParticipantActionError('That is already the participant’s email');

      const owner = await tx.person.findUnique({ where: { email: to } });
      if (owner) {
        throw new ParticipantActionError(`${to} already belongs to another participant (${owner.name ?? 'unnamed'}); records are never merged`);
      }
      const alias = await tx.personEmailAlias.findUnique({ where: { email: to } });
      if (alias && alias.personId !== personId) {
        throw new ParticipantActionError(`${to} was previously used by another participant; choose a different address`);
      }
      if (alias) await tx.personEmailAlias.delete({ where: { email: to } }); // changing back

      await tx.person.update({
        where: { id: personId },
        data: { email: to, emailBouncedAt: null, emailBounceReason: null },
      });
      let redirected = 0;
      if (from) {
        await tx.personEmailAlias.upsert({
          where: { email: from },
          create: { email: from, personId },
          update: { personId },
        });
        redirected = (
          await tx.emailOutbox.updateMany({
            where: { personId, toEmail: from, status: EmailStatus.PENDING },
            data: { toEmail: to },
          })
        ).count;
      }
      await recordActivity(
        tx,
        person.registrations.map((r) => ({
          registrationId: r.id,
          type: ActivityType.EMAIL_CHANGED,
          actorId,
          details: { from, to, redirectedQueuedEmails: redirected },
        })),
      );
      const queued = from ? { registrationEmails: 0, qrEmails: 0 } : await this.queueEmailsForNewAddress(tx, personId, actorId);
      return { from, to, queued };
    });
    if (result.queued.registrationEmails + result.queued.qrEmails > 0) this.worker.kick();
    return result;
  }
}
