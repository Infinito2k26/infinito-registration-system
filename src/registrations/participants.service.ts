import { Injectable } from '@nestjs/common';
import { ActivityType, EmailStatus } from '@prisma/client';
import { z } from 'zod';
import { normalizeEmail } from '../forms/form-response.parser';
import { PrismaService } from '../prisma/prisma.service';
import { recordActivity } from './activity';

/** Shown to the coordinator as-is. Nothing was changed. */
export class ParticipantActionError extends Error {}

const emailSchema = z.email();

@Injectable()
export class ParticipantsService {
  constructor(private readonly prisma: PrismaService) {}

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
   * still waiting in the outbox for this person are redirected. No email is sent by this.
   */
  async changeEmail(personId: string, rawEmail: string, actorId: string): Promise<{ from: string; to: string }> {
    const to = normalizeEmail(rawEmail);
    if (!emailSchema.safeParse(to).success) throw new ParticipantActionError(`"${rawEmail}" is not a valid email`);

    return this.prisma.$transaction(async (tx) => {
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
      await tx.personEmailAlias.upsert({
        where: { email: from },
        create: { email: from, personId },
        update: { personId },
      });
      const redirected = await tx.emailOutbox.updateMany({
        where: { personId, toEmail: from, status: EmailStatus.PENDING },
        data: { toEmail: to },
      });
      await recordActivity(
        tx,
        person.registrations.map((r) => ({
          registrationId: r.id,
          type: ActivityType.EMAIL_CHANGED,
          actorId,
          details: { from, to, redirectedQueuedEmails: redirected.count },
        })),
      );
      return { from, to };
    });
  }
}
