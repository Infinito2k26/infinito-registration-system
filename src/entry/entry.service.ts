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

/**
 * A registration may change state only while its participant is not blocked. The participant is
 * the whole Aadhaar profile: a block on ANY of its Person records (emails / QR codes) blocks every
 * registration of the profile, so another email or QR cannot bypass it.
 */
const notBlocked = {
  person: {
    blockedAt: null,
    OR: [{ participantProfileId: null }, { participantProfile: { people: { none: { blockedAt: { not: null } } } } }],
  },
} satisfies Prisma.RegistrationWhereInput;

/** Selects what profileBlocked() needs. */
const blockSelect = {
  blockedAt: true,
  blockReason: true,
  participantProfile: { select: { people: { where: { blockedAt: { not: null } }, select: { blockedAt: true, blockReason: true }, take: 1 } } },
} as const;

/** The participant's block: this record's, else any other record of the same Aadhaar profile. */
function profileBlock(p: { blockedAt: Date | null; blockReason: string | null; participantProfile: { people: { blockedAt: Date | null; blockReason: string | null }[] } | null }) {
  if (p.blockedAt) return { blockedAt: p.blockedAt, blockReason: p.blockReason, byOtherRecord: false };
  const other = p.participantProfile?.people[0];
  return other?.blockedAt ? { blockedAt: other.blockedAt, blockReason: other.blockReason, byOtherRecord: true } : null;
}

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
          person: { select: { name: true, college: true, ...blockSelect } },
        },
      }),
      this.prisma.registration.count({ where }),
    ]);
    // Blocked = the whole participant (profile); reasons are not shown at the gate.
    return {
      rows: rows.map(({ person: { blockReason: _r, participantProfile: _p, ...person }, ...r }) => ({ ...r, person: { ...person, blockedAt: profileBlock({ ...person, blockReason: _r, participantProfile: _p })?.blockedAt ?? null } })),
      total,
    };
  }

  /**
   * Gate log and history of one participant (all events), for the volunteer's participant
   * view: the same records the participant page shows to coordinators/admins.
   */
  async historyFor(personId: string) {
    // The whole participant: every Person record of the same Aadhaar profile.
    const person = await this.prisma.person.findUnique({ where: { id: personId }, select: { participantProfileId: true } });
    const people = person?.participantProfileId
      ? (await this.prisma.person.findMany({ where: { participantProfileId: person.participantProfileId }, select: { id: true } })).map((p) => p.id)
      : [personId];
    const [entryLogs, activity] = await Promise.all([
      this.prisma.entryLog.findMany({
        where: { personId: { in: people } },
        orderBy: { enteredAt: 'desc' },
        include: { volunteer: { select: { name: true, email: true } } },
      }),
      this.prisma.registrationActivity.findMany({
        where: { registration: { personId: { in: people } } },
        orderBy: { createdAt: 'desc' },
        include: { actor: { select: { name: true, email: true } }, registration: { select: { eventSlug: true } } },
      }),
    ]);
    return { entryLogs, activity };
  }

  /**
   * The scanned person and EVERY registration of their participant profile (same full Aadhaar,
   * possibly under other emails/QR codes): one profile = one physical participant, so any of
   * their QR codes opens the same card. Without a profile: the person's own registrations.
   */
  private async lookupPerson(where: Prisma.PersonWhereUniqueInput) {
    const registrationInclude = {
      orderBy: { eventSlug: 'asc' },
      include: {
        team: { select: { id: true, name: true, registrations: { select: { enteredAt: true } } } },
        entryLogs: lastCheckIn,
        person: { select: { id: true, name: true, email: true, blockedAt: true } },
      },
    } satisfies Prisma.Person$registrationsArgs;
    const found = await this.prisma.person.findUnique({
      where,
      include: { registrations: registrationInclude, participantProfile: blockSelect.participantProfile },
    });
    if (!found) return null;
    // The card shows the participant's (profile-wide) block, whichever record holds it.
    const { participantProfile, ...person } = found;
    const block = profileBlock({ ...person, participantProfile });
    const blocked = { blockedAt: block?.blockedAt ?? null, blockReason: block?.blockReason ?? null, blockedByOtherRecord: block?.byOtherRecord ?? false };
    if (!person.participantProfileId) return { ...person, ...blocked };
    const registrations = await this.prisma.registration.findMany({
      where: { person: { participantProfileId: person.participantProfileId } },
      orderBy: [{ eventSlug: 'asc' }, { createdAt: 'asc' }],
      include: registrationInclude.include,
    });
    return { ...person, ...blocked, registrations };
  }

  private async findTarget(tx: Prisma.TransactionClient, action: GateAction) {
    // A scanned QR may act on any registration of its participant profile (same full Aadhaar):
    // its own person's, or another email record's of the same profile.
    const tokenBinding: Prisma.RegistrationWhereInput = action.qrToken
      ? { person: { OR: [{ qrToken: action.qrToken }, { participantProfile: { people: { some: { qrToken: action.qrToken } } } }] } }
      : {};
    const reg = await tx.registration.findFirst({
      where: { id: action.registrationId, ...tokenBinding },
      select: {
        id: true,
        personId: true,
        eventSlug: true,
        paymentStatus: true,
        person: { select: { name: true, email: true, college: true, ...blockSelect } },
      },
    });
    if (!reg) return null;
    const who: GateSubject = { name: reg.person.name ?? reg.person.email ?? 'Participant', college: reg.person.college, eventSlug: reg.eventSlug };
    return { ...reg, who, blocked: profileBlock(reg.person) !== null };
  }

  /**
   * The participant of a registration, locked for an IN/OUT decision: the whole Aadhaar profile
   * (every email/QR record), or the person alone without one. ONE participant = ONE IN/OUT status:
   * all their registrations always move IN or OUT together, whichever QR or event is used.
   */
  private async participant(tx: Prisma.TransactionClient, personId: string) {
    const person = await tx.person.findUnique({ where: { id: personId }, select: { participantProfileId: true } });
    const profileId = person?.participantProfileId ?? null;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'presence:' + (profileId ? `profile:${profileId}` : `person:${personId}`)}))`;
    const where: Prisma.RegistrationWhereInput = profileId ? { person: { participantProfileId: profileId } } : { personId };
    const regs = await tx.registration.findMany({
      where,
      select: { id: true, personId: true, paymentStatus: true, insideSince: true, enteredAt: true, lastCheckOutAt: true },
    });
    return { where, regs, personIds: [...new Set([personId, ...regs.map((r) => r.personId)])] };
  }

  async checkIn(action: GateAction): Promise<CheckInOutcome> {
    const gate = action.gate?.trim().slice(0, 60) || null;
    return this.prisma.$transaction(async (tx) => {
      const reg = await this.findTarget(tx, action);
      if (!reg) return { result: 'not-found' };
      const { who } = reg;
      const part = await this.participant(tx, reg.personId);
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

      // The participant may enter if any of their registrations is verified.
      if (!part.regs.some((r) => r.paymentStatus === PaymentStatus.VERIFIED)) {
        await deny('not verified');
        return { result: 'not-verified', who };
      }
      if (reg.blocked) {
        await deny('blocked');
        return { result: 'blocked', who };
      }
      const insideSince = part.regs.map((r) => r.insideSince).filter((d): d is Date => d !== null);
      if (insideSince.length) {
        const last = await tx.entryLog.findFirst({
          where: { personId: { in: part.personIds }, status: EntryStatus.ENTERED, kind: EntryKind.CHECK_IN },
          orderBy: { enteredAt: 'desc' },
          select: { gate: true, volunteer: { select: { name: true, email: true } } },
        });
        await deny('already inside');
        return {
          result: 'already-inside',
          since: new Date(Math.min(...insideSince.map((d) => d.getTime()))),
          byName: last?.volunteer?.name ?? last?.volunteer?.email ?? null,
          gate: last?.gate ?? null,
          who,
        };
      }

      const now = new Date();
      // Every registration of the participant goes INSIDE together; the block condition is part
      // of the same statement, so a block that lands meanwhile still wins.
      const claimed = await tx.registration.updateMany({
        where: { AND: [part.where, { insideSince: null }, notBlocked] },
        data: { insideSince: now, lastCheckInAt: now },
      });
      if (claimed.count === 0) {
        await deny('blocked');
        return { result: 'blocked', who };
      }
      await tx.registration.updateMany({
        where: { AND: [part.where, { enteredAt: null }] },
        data: { enteredAt: now, enteredById: action.staffId },
      });
      await log(EntryStatus.ENTERED, methodOf(action) === 'manual' ? MANUAL_NOTE : undefined);
      await recordActivity(
        tx,
        part.regs.map((r) => ({
          registrationId: r.id,
          type: ActivityType.ENTERED,
          actorId: action.staffId,
          details: { gate, at: now.toISOString(), method: methodOf(action), via: r.id === reg.id ? undefined : reg.id },
        })),
      );
      return { result: 'entered', at: now, who };
    });
  }

  /**
   * Check-out of the participant (all their registrations together). Blocked participants are
   * refused, except through the admin-only override (`adminOverride`), which exists so a blocked
   * participant who is inside can be recorded as having left; it is logged as an override.
   */
  async checkOut(action: GateAction & { adminOverride?: boolean }): Promise<CheckOutOutcome> {
    const gate = action.gate?.trim().slice(0, 60) || null;
    const override = action.adminOverride === true;
    return this.prisma.$transaction(async (tx) => {
      const reg = await this.findTarget(tx, action);
      if (!reg) return { result: 'not-found' };
      const { who } = reg;
      const part = await this.participant(tx, reg.personId);
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

      if (reg.blocked && !override) {
        await deny('blocked');
        return { result: 'blocked', who };
      }
      if (!part.regs.some((r) => r.insideSince)) {
        const entered = part.regs.some((r) => r.enteredAt);
        const outs = part.regs.map((r) => r.lastCheckOutAt).filter((d): d is Date => d !== null);
        await deny(entered ? 'not inside' : 'never checked in');
        return {
          result: 'not-inside',
          lastCheckOutAt: outs.length ? new Date(Math.max(...outs.map((d) => d.getTime()))) : null,
          neverEntered: !entered,
          who,
        };
      }

      const now = new Date();
      const released = await tx.registration.updateMany({
        where: { AND: [part.where, { insideSince: { not: null } }, ...(override ? [] : [notBlocked])] },
        data: { insideSince: null, lastCheckOutAt: now },
      });
      if (released.count === 0) {
        await deny('blocked');
        return { result: 'blocked', who };
      }
      // Older data may have only some registrations inside: the participant is OUTSIDE everywhere now.
      await tx.registration.updateMany({ where: { AND: [part.where, { insideSince: null }, { lastCheckOutAt: null }, { enteredAt: { not: null } }] }, data: { lastCheckOutAt: now } });
      await log(
        EntryStatus.ENTERED,
        override ? 'admin override (blocked participant)' : methodOf(action) === 'manual' ? MANUAL_NOTE : undefined,
      );
      await recordActivity(
        tx,
        part.regs.map((r) => ({
          registrationId: r.id,
          type: ActivityType.CHECKED_OUT,
          actorId: action.staffId,
          details: { gate, at: now.toISOString(), method: methodOf(action), adminOverride: override || undefined, via: r.id === reg.id ? undefined : reg.id },
        })),
      );
      return { result: 'checked-out', at: now, who, override };
    });
  }
}
