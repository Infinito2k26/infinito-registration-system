import { Injectable } from '@nestjs/common';
import { ActivityType, EmailStatus, PaymentStatus, Prisma } from '@prisma/client';
import { z } from 'zod';
import { EmailWorkerService } from '../emails/email-worker.service';
import { QrEmailService } from '../emails/qr-email.service';
import { normalizeEmail } from '../forms/form-response.parser';
import { PrismaService } from '../prisma/prisma.service';
import { ActivityEntry, recordActivity } from './activity';

/** Shown to the coordinator as-is. Nothing was changed. */
export class ParticipantActionError extends Error {}

/** One email address = one participant (case-insensitive). */
export const DUPLICATE_EMAIL_MESSAGE = 'This email address is already registered to another participant.';

/** Another participant, whatever the letter case, already has this (normalized) email. */
export const emailOwnedByOther = (email: string, personId?: string): Prisma.PersonWhereInput => ({
  email: { equals: email, mode: Prisma.QueryMode.insensitive },
  ...(personId ? { id: { not: personId } } : {}),
});

const emailSchema = z.email();

/** Flash text after a Change email. `shownFrom` lets the gate mask the old address for volunteers. */
export function changeEmailMessage(result: { from: string | null; to: string; queued: NewAddressEmails }, shownFrom = result.from): string {
  if (result.from) return `Email changed from ${shownFrom} to ${result.to}. No email was sent; use Send QR email if needed.`;
  const { qrEmails } = result.queued;
  return `Email added: ${result.to}. ` + (qrEmails ? `Queued ${qrEmails} QR pass email(s).` : 'The QR pass is emailed once the registration is verified.');
}

export interface NewAddressEmails {
  /** QR pass emails queued now (verified registrations only). */
  qrEmails: number;
}

@Injectable()
export class ParticipantsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly qrEmails: QrEmailService,
    private readonly worker: EmailWorkerService,
  ) {}

  /**
   * A participant who had NO email now has one (staff Change email, or a resynced form row).
   * Queues the QR pass email, which could not be sent before, for every VERIFIED registration
   * (same existing QR token). Nothing else: no "registration received" email is ever sent.
   * Pending registrations get no email here; verification queues the QR email as usual.
   * The QR email's idempotency key is the one verification uses, so repeating this (double
   * click, resync, retry) or a later verification never sends it twice.
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
    if (!email) return { qrEmails: 0 };

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
    return { qrEmails };
  }

  /**
   * The Person records forming this participant, locked for a block decision: the whole Aadhaar
   * profile (every email / QR record), or just this person without a profile.
   */
  private async blockScope(tx: Prisma.TransactionClient, personId: string) {
    const person = await tx.person.findUnique({ where: { id: personId }, select: { participantProfileId: true } });
    if (!person) throw new ParticipantActionError('Participant not found');
    const scope = person.participantProfileId ? `profile:${person.participantProfileId}` : `person:${personId}`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'participant-block:' + scope}))`;
    return tx.person.findMany({
      where: person.participantProfileId ? { participantProfileId: person.participantProfileId } : { id: personId },
      include: { registrations: { select: { id: true, insideSince: true } } },
    });
  }

  /**
   * Blocks the participant at the gate (every event): no check-in, no check-out, until unblocked.
   * Profile-wide: every record of the same full Aadhaar (other emails / QR codes) is blocked too, so
   * the block cannot be bypassed with another QR. Verification, QR tokens and IN/OUT history are
   * untouched.
   */
  async block(personId: string, actorId: string, rawReason: string): Promise<void> {
    const reason = rawReason.trim().slice(0, 500) || null;
    await this.prisma.$transaction(async (tx) => {
      const people = await this.blockScope(tx, personId);
      if (people.some((p) => p.blockedAt)) throw new ParticipantActionError('Already blocked');
      await tx.person.updateMany({
        where: { id: { in: people.map((p) => p.id) } },
        data: { blockedAt: new Date(), blockedById: actorId, blockReason: reason },
      });
      await recordActivity(
        tx,
        people.flatMap((p) =>
          p.registrations.map((r) => ({
            registrationId: r.id,
            type: ActivityType.BLOCKED,
            actorId,
            details: { reason, wasInside: r.insideSince !== null, profileWide: people.length > 1 || undefined },
          })),
        ),
      );
    });
  }

  /** Lifts the block for the whole participant (every record of the profile); the gate then follows each registration's IN/OUT state again. */
  async unblock(personId: string, actorId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const people = await this.blockScope(tx, personId);
      const blocked = people.find((p) => p.blockedAt);
      if (!blocked) throw new ParticipantActionError('Not blocked');
      await tx.person.updateMany({
        where: { id: { in: people.map((p) => p.id) } },
        data: { blockedAt: null, blockedById: null, blockReason: null },
      });
      await recordActivity(
        tx,
        people.flatMap((p) =>
          p.registrations.map((r) => ({
            registrationId: r.id,
            type: ActivityType.UNBLOCKED,
            actorId,
            details: { previousReason: blocked.blockReason, blockedSince: blocked.blockedAt?.toISOString() ?? null, profileWide: people.length > 1 || undefined },
          })),
        ),
      );
    });
  }

  /**
   * Changes a participant's email in place: same person, same registrations, same QR token,
   * same verification and entry history. The old address becomes an alias so a resync of an
   * old sheet row maps back to this person instead of recreating the old address. Emails
   * still waiting in the outbox for this person are redirected. Changing an existing email
   * sends nothing; adding the FIRST email queues the QR email if the participant is already
   * verified (see queueEmailsForNewAddress).
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
      if (from?.toLowerCase() === to) throw new ParticipantActionError('That is already the participant’s email');

      // One email = one participant: refused (nothing changed) if anyone else has it, in any case.
      if (await tx.person.findFirst({ where: emailOwnedByOther(to, personId), select: { id: true } })) {
        throw new ParticipantActionError(DUPLICATE_EMAIL_MESSAGE);
      }
      // A previous email of another participant still identifies them on form resyncs.
      const alias = await tx.personEmailAlias.findUnique({ where: { email: to } });
      if (alias && alias.personId !== personId) throw new ParticipantActionError(DUPLICATE_EMAIL_MESSAGE);
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
      const queued = from ? { qrEmails: 0 } : await this.queueEmailsForNewAddress(tx, personId, actorId);
      return { from, to, queued };
    }).catch((error: unknown) => {
      // A simultaneous change/registration took the address first: the unique constraint on
      // Person.email is the final guard. The whole change was rolled back.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ParticipantActionError(DUPLICATE_EMAIL_MESSAGE);
      }
      throw error;
    });
    if (result.queued.qrEmails > 0) this.worker.kick();
    return result;
  }
}
