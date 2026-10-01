import { Injectable } from '@nestjs/common';
import { ActivityType, EntryStatus, PaymentStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { recordActivity } from '../registrations/activity';

export type EntryOutcome =
  | { result: 'entered'; enteredAt: Date }
  | { result: 'already-entered'; enteredAt: Date; byName: string | null; gate: string | null }
  | { result: 'not-verified' }
  | { result: 'not-found' };

@Injectable()
export class EntryService {
  constructor(private readonly prisma: PrismaService) {}

  /** Everything the gate needs for one QR token: the person and their registrations, with entry state. */
  async lookup(qrToken: string) {
    if (!/^[\w-]{16,200}$/.test(qrToken)) return null;
    return this.prisma.person.findUnique({
      where: { qrToken },
      include: {
        registrations: {
          orderBy: { eventSlug: 'asc' },
          include: {
            team: { select: { id: true, name: true } },
            enteredBy: { select: { name: true, email: true } },
            entryLogs: {
              where: { status: EntryStatus.ENTERED },
              orderBy: { enteredAt: 'desc' },
              take: 1,
              select: { gate: true },
            },
          },
        },
      },
    });
  }

  /**
   * Marks one registration entered. The conditional update (enteredAt IS NULL) is the
   * guarantee: of two simultaneous scans only one can succeed. Every attempt is logged.
   */
  async markEntered(params: {
    qrToken: string;
    registrationId: string;
    staffId: string;
    gate?: string;
  }): Promise<EntryOutcome> {
    const { qrToken, registrationId, staffId } = params;
    const gate = params.gate?.trim().slice(0, 60) || null;

    return this.prisma.$transaction(async (tx) => {
      const reg = await tx.registration.findFirst({
        where: { id: registrationId, person: { qrToken } },
        select: { id: true, personId: true, eventSlug: true, paymentStatus: true },
      });
      if (!reg) return { result: 'not-found' };

      const log = (status: EntryStatus, notes?: string) =>
        tx.entryLog.create({
          data: {
            personId: reg.personId,
            registrationId: reg.id,
            eventSlug: reg.eventSlug,
            volunteerId: staffId,
            status,
            gate,
            notes,
          },
        });

      if (reg.paymentStatus !== PaymentStatus.VERIFIED) {
        await log(EntryStatus.REJECTED, 'payment not verified');
        await recordActivity(tx, [
          { registrationId: reg.id, type: ActivityType.ENTRY_DENIED, actorId: staffId, details: { reason: 'payment not verified', gate } },
        ]);
        return { result: 'not-verified' };
      }

      const now = new Date();
      const claimed = await tx.registration.updateMany({
        where: { id: reg.id, enteredAt: null, paymentStatus: PaymentStatus.VERIFIED },
        data: { enteredAt: now, enteredById: staffId },
      });

      if (claimed.count === 1) {
        await log(EntryStatus.ENTERED);
        await recordActivity(tx, [
          { registrationId: reg.id, type: ActivityType.ENTERED, actorId: staffId, details: { gate } },
        ]);
        return { result: 'entered', enteredAt: now };
      }

      const previous = await tx.registration.findUniqueOrThrow({
        where: { id: reg.id },
        select: {
          enteredAt: true,
          enteredBy: { select: { name: true, email: true } },
          entryLogs: { where: { status: EntryStatus.ENTERED }, orderBy: { enteredAt: 'desc' }, take: 1 },
        },
      });
      await log(EntryStatus.REJECTED, 'already entered');
      await recordActivity(tx, [
        { registrationId: reg.id, type: ActivityType.ENTRY_DENIED, actorId: staffId, details: { reason: 'already entered', gate } },
      ]);
      return {
        result: 'already-entered',
        enteredAt: previous.enteredAt!,
        byName: previous.enteredBy?.name ?? previous.enteredBy?.email ?? null,
        gate: previous.entryLogs[0]?.gate ?? null,
      };
    });
  }
}
