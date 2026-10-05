import { Injectable } from '@nestjs/common';
import { ActivityType, EntryKind, EntryStatus, PaymentStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { recordActivity } from '../registrations/activity';

/** Who the action was for, shown in the confirmation (no private data). */
export interface GateSubject {
  name: string;
  college: string | null;
  eventSlug: string;
}

export type CheckInOutcome =
  | { result: 'entered'; at: Date; who: GateSubject }
  | { result: 'already-inside'; since: Date; byName: string | null; gate: string | null; who: GateSubject }
  | { result: 'not-verified'; who: GateSubject }
  | { result: 'blocked'; who: GateSubject }
  | { result: 'not-found' };

export type CheckOutOutcome =
  | { result: 'checked-out'; at: Date; who: GateSubject; override: boolean }
  | { result: 'not-inside'; lastCheckOutAt: Date | null; neverEntered: boolean; who: GateSubject }
  | { result: 'blocked'; who: GateSubject }
  | { result: 'not-found' };

interface GateAction {
  registrationId: string;
  staffId: string;
  gate?: string;
  /** From a scanned pass: the registration must belong to this QR token. */
  qrToken?: string;
}

/** QR scan vs staff action without a scan; the same state and log, just labelled. */
const methodOf = (action: GateAction) => (action.qrToken ? 'qr' : 'manual');
const MANUAL_NOTE = 'manual (no QR scan)';

const lastCheckIn = {
  where: { status: EntryStatus.ENTERED, kind: EntryKind.CHECK_IN },
  orderBy: { enteredAt: 'desc' },
  take: 1,
  select: { gate: true, enteredAt: true, volunteer: { select: { name: true, email: true } } },
} satisfies Prisma.Registration$entryLogsArgs;

export const GATE_PAGE_SIZE = 50;

/** A registration may change state only while its participant is not blocked. */
const notBlocked = { person: { blockedAt: null } } satisfies Prisma.RegistrationWhereInput;

/**
 * Gate presence. The order of checks for every scan is: pass/registration exists -> verified
 * -> participant not blocked -> current IN/OUT state. Registration.insideSince is the state
 * (set = INSIDE) and only changes through conditional updates that also require "not
 * blocked", so concurrent taps cannot double check-in/out and a block that lands mid-scan
 * always wins. Every attempt is logged in EntryLog; enteredAt keeps the first-ever entry.
 * Actual times are the server's clock at the moment of the action, never the form's dates.
 */
@Injectable()
export class EntryService {
  constructor(private readonly prisma: PrismaService) {}

  /** Everything the gate needs for one QR token: the person and their registrations, with presence. */
  async lookup(qrToken: string) {
    if (!/^[\w-]{16,200}$/.test(qrToken)) return null;
    return this.lookupPerson({ qrToken });
  }

  async personIdFor(registrationId: string): Promise<string | null> {
    const reg = await this.prisma.registration.findUnique({ where: { id: registrationId }, select: { personId: true } });
    return reg?.personId ?? null;
  }

  async teamIdFor(registrationId: string): Promise<string | null> {
    const reg = await this.prisma.registration.findUnique({ where: { id: registrationId }, select: { teamId: true } });
    return reg?.teamId ?? null;
  }

  /** The same gate card, opened from a registration (manual gate, no QR). */
  async lookupByRegistration(registrationId: string) {
    const reg = await this.prisma.registration.findUnique({ where: { id: registrationId }, select: { personId: true } });
    return reg ? this.lookupPerson({ id: reg.personId }) : null;
  }

  /**
   * Participant directory for the gate (any staff role): every registration, optionally
   * filtered by name, college or event, returning only what the gate shows (no email,
   * mobile, roll number or IDs). Paged by GATE_PAGE_SIZE.
   */
  async searchForGate(q: string, page = 1) {
    const text = q.trim();
    const contains = { contains: text, mode: Prisma.QueryMode.insensitive };
    const eventSlug = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const where: Prisma.RegistrationWhereInput = text
      ? {
          OR: [
            { person: { name: contains } },
            { person: { college: contains } },
            ...(eventSlug ? [{ eventSlug: { contains: eventSlug } }] : []),
          ],
        }
      : {};
    const [rows, total] = await Promise.all([
      this.prisma.registration.findMany({
        where,
        orderBy: [{ person: { name: 'asc' } }, { eventSlug: 'asc' }, { id: 'asc' }],
        skip: (page - 1) * GATE_PAGE_SIZE,
        take: GATE_PAGE_SIZE,
        // Only gate-safe columns leave the database: no email, mobile, roll number or IDs.
        select: {
          id: true,
          eventSlug: true,
          paymentStatus: true,
          insideSince: true,
          person: { select: { name: true, college: true, blockedAt: true } },
        },
      }),
      this.prisma.registration.count({ where }),
    ]);
    return { rows, total };
  }

  /**
   * Gate log and history of one participant (all events), for the volunteer's participant
   * view: the same records the participant page shows to coordinators/admins.
   */
  async historyFor(personId: string) {
    const [entryLogs, activity] = await Promise.all([
      this.prisma.entryLog.findMany({
        where: { personId },
        orderBy: { enteredAt: 'desc' },
        include: { volunteer: { select: { name: true, email: true } } },
      }),
      this.prisma.registrationActivity.findMany({
        where: { registration: { personId } },
        orderBy: { createdAt: 'desc' },
        include: { actor: { select: { name: true, email: true } }, registration: { select: { eventSlug: true } } },
      }),
    ]);
    return { entryLogs, activity };
  }

  private lookupPerson(where: Prisma.PersonWhereUniqueInput) {
    return this.prisma.person.findUnique({
      where,
      include: {
        registrations: {
          orderBy: { eventSlug: 'asc' },
          include: {
            team: { select: { id: true, name: true, registrations: { select: { enteredAt: true } } } },
            entryLogs: lastCheckIn,
          },
        },
      },
    });
  }

  private async findTarget(tx: Prisma.TransactionClient, action: GateAction) {
    const reg = await tx.registration.findFirst({
      where: { id: action.registrationId, ...(action.qrToken ? { person: { qrToken: action.qrToken } } : {}) },
      select: {
        id: true,
        personId: true,
        eventSlug: true,
        paymentStatus: true,
        person: { select: { name: true, email: true, college: true, blockedAt: true } },
      },
    });
    if (!reg) return null;
    const who: GateSubject = { name: reg.person.name ?? reg.person.email ?? 'Participant', college: reg.person.college, eventSlug: reg.eventSlug };
    return { ...reg, who };
  }

  private isBlocked(tx: Prisma.TransactionClient, personId: string) {
    return tx.person.findUnique({ where: { id: personId }, select: { blockedAt: true } }).then((p) => Boolean(p?.blockedAt));
  }

  async checkIn(action: GateAction): Promise<CheckInOutcome> {
    const gate = action.gate?.trim().slice(0, 60) || null;
    return this.prisma.$transaction(async (tx) => {
      const reg = await this.findTarget(tx, action);
      if (!reg) return { result: 'not-found' };
      const { who } = reg;
      const log = (status: EntryStatus, notes?: string) =>
        tx.entryLog.create({
          data: {
            personId: reg.personId,
            registrationId: reg.id,
            eventSlug: reg.eventSlug,
            volunteerId: action.staffId,
            kind: EntryKind.CHECK_IN,
            status,
            gate,
            notes,
          },
        });
      const deny = async (reason: string) => {
        await log(EntryStatus.REJECTED, reason);
        await recordActivity(tx, [
          { registrationId: reg.id, type: ActivityType.ENTRY_DENIED, actorId: action.staffId, details: { reason, gate } },
        ]);
      };

      if (reg.paymentStatus !== PaymentStatus.VERIFIED) {
        await deny('not verified');
        return { result: 'not-verified', who };
      }
      if (reg.person.blockedAt) {
        await deny('blocked');
        return { result: 'blocked', who };
      }

      const now = new Date();
      const claimed = await tx.registration.updateMany({
        where: { id: reg.id, insideSince: null, paymentStatus: PaymentStatus.VERIFIED, ...notBlocked },
        data: { insideSince: now, lastCheckInAt: now },
      });
      if (claimed.count === 1) {
        await tx.registration.updateMany({
          where: { id: reg.id, enteredAt: null },
          data: { enteredAt: now, enteredById: action.staffId },
        });
        await log(EntryStatus.ENTERED, methodOf(action) === 'manual' ? MANUAL_NOTE : undefined);
        await recordActivity(tx, [
          {
            registrationId: reg.id,
            type: ActivityType.ENTERED,
            actorId: action.staffId,
            details: { gate, at: now.toISOString(), method: methodOf(action) },
          },
        ]);
        return { result: 'entered', at: now, who };
      }

      if (await this.isBlocked(tx, reg.personId)) {
        await deny('blocked');
        return { result: 'blocked', who };
      }
      const current = await tx.registration.findUniqueOrThrow({
        where: { id: reg.id },
        select: { insideSince: true, entryLogs: lastCheckIn },
      });
      await deny('already inside');
      const last = current.entryLogs[0];
      return {
        result: 'already-inside',
        since: current.insideSince ?? now,
        byName: last?.volunteer?.name ?? last?.volunteer?.email ?? null,
        gate: last?.gate ?? null,
        who,
      };
    });
  }

  /**
   * Check-out. Blocked participants are refused, except through the admin-only override
   * (`adminOverride`), which exists so a blocked participant who is inside can be recorded as
   * having left; it is logged as an override.
   */
  async checkOut(action: GateAction & { adminOverride?: boolean }): Promise<CheckOutOutcome> {
    const gate = action.gate?.trim().slice(0, 60) || null;
    const override = action.adminOverride === true;
    return this.prisma.$transaction(async (tx) => {
      const reg = await this.findTarget(tx, action);
      if (!reg) return { result: 'not-found' };
      const { who } = reg;
      const log = (status: EntryStatus, notes?: string) =>
        tx.entryLog.create({
          data: {
            personId: reg.personId,
            registrationId: reg.id,
            eventSlug: reg.eventSlug,
            volunteerId: action.staffId,
            kind: EntryKind.CHECK_OUT,
            status,
            gate,
            notes,
          },
        });
      const deny = async (reason: string) => {
        await log(EntryStatus.REJECTED, reason);
        await recordActivity(tx, [
          { registrationId: reg.id, type: ActivityType.CHECKOUT_DENIED, actorId: action.staffId, details: { reason, gate } },
        ]);
      };

      if (reg.person.blockedAt && !override) {
        await deny('blocked');
        return { result: 'blocked', who };
      }

      const now = new Date();
      const released = await tx.registration.updateMany({
        where: { id: reg.id, insideSince: { not: null }, ...(override ? {} : notBlocked) },
        data: { insideSince: null, lastCheckOutAt: now },
      });
      if (released.count === 1) {
        await log(
          EntryStatus.ENTERED,
          override ? 'admin override (blocked participant)' : methodOf(action) === 'manual' ? MANUAL_NOTE : undefined,
        );
        await recordActivity(tx, [
          {
            registrationId: reg.id,
            type: ActivityType.CHECKED_OUT,
            actorId: action.staffId,
            details: { gate, at: now.toISOString(), method: methodOf(action), adminOverride: override || undefined },
          },
        ]);
        return { result: 'checked-out', at: now, who, override };
      }

      if (!override && (await this.isBlocked(tx, reg.personId))) {
        await deny('blocked');
        return { result: 'blocked', who };
      }
      const current = await tx.registration.findUniqueOrThrow({
        where: { id: reg.id },
        select: { enteredAt: true, lastCheckOutAt: true },
      });
      await deny(current.enteredAt ? 'not inside' : 'never checked in');
      return { result: 'not-inside', lastCheckOutAt: current.lastCheckOutAt, neverEntered: !current.enteredAt, who };
    });
  }
}
