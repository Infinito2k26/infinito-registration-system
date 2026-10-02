import { Injectable } from '@nestjs/common';
import { EntryKind, EntryStatus, PaymentStatus, Prisma } from '@prisma/client';
import { normalizeTransactionId } from '../forms/form-response.parser';
import { PrismaService } from '../prisma/prisma.service';

export const PAGE_SIZE = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The status chips / counter tiles of the registrations list; each one is a filter. */
export const REGISTRATION_VIEWS = ['PENDING', 'VERIFIED', 'REJECTED', 'BLOCKED', 'INSIDE', 'OUTSIDE'] as const;
export type RegistrationView = (typeof REGISTRATION_VIEWS)[number];

export interface RegistrationFilters {
  event?: string;
  /** College ID. */
  college?: string;
  /** Planned dates from the form (DATE columns, UTC midnight). */
  arrival?: Date;
  departure?: Date;
  /** One status/gate view; undefined = All. */
  view?: RegistrationView;
  q?: string;
  page: number;
}

/** Status / gate-state condition of a view. INSIDE = checked in and not checked out since. */
export function viewWhere(view: RegistrationView): Prisma.RegistrationWhereInput {
  switch (view) {
    case 'PENDING':
    case 'VERIFIED':
    case 'REJECTED':
      return { paymentStatus: view };
    case 'BLOCKED':
      return { person: { blockedAt: { not: null } } };
    case 'INSIDE':
      return { insideSince: { not: null } };
    case 'OUTSIDE':
      return { insideSince: null };
  }
}

/**
 * Dashboard counters, over registrations (one per participant per event):
 *   total = all; verified/pending/rejected by verification status;
 *   inside = checked in and not checked out; outside = total - inside.
 */
export interface Counters {
  total: number;
  verified: number;
  pending: number;
  rejected: number;
  /** Registrations whose participant is blocked at the gate (independent of the others). */
  blocked: number;
  inside: number;
  outside: number;
}

export type ExpectedKind = 'arrival' | 'departure';

/** Planned (form) date vs. actual QR gate records, for one day. */
export interface ExpectedSummary {
  expected: number;
  /** Arrivals: checked in at least once (QR IN). */
  arrived: number;
  notArrived: number;
  /** Departures: checked out (QR OUT) and not inside now. */
  checkedOut: number;
  stillInside: number;
  blocked: number;
}

export interface CollegeRow extends Counters {
  id: string;
  name: string;
}

export type TeamPaymentState = PaymentStatus | 'MIXED';

export function teamPaymentState(regs: { paymentStatus: PaymentStatus }[]): TeamPaymentState {
  const states = new Set(regs.map((r) => r.paymentStatus));
  return states.size === 1 ? [...states][0] : 'MIXED';
}

/** Read models for the coordinator dashboard. A "team" is one form response (solo events = team of one). */
@Injectable()
export class AdminQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async eventSummary() {
    const live = { registrations: { some: {} } } satisfies Prisma.TeamWhereInput;
    const [teams, pending, participants, entered] = await Promise.all([
      this.prisma.team.groupBy({ by: ['eventSlug'], where: live, _count: { _all: true } }),
      this.prisma.team.groupBy({
        by: ['eventSlug'],
        where: { registrations: { some: { paymentStatus: PaymentStatus.PENDING } } },
        _count: { _all: true },
      }),
      this.prisma.registration.groupBy({ by: ['eventSlug'], _count: { _all: true } }),
      this.prisma.registration.groupBy({
        by: ['eventSlug'],
        where: { enteredAt: { not: null } },
        _count: { _all: true },
      }),
    ]);
    const countOf = (rows: { eventSlug: string; _count: { _all: number } }[], slug: string) =>
      rows.find((r) => r.eventSlug === slug)?._count._all ?? 0;
    return teams
      .map((t) => ({
        slug: t.eventSlug,
        teams: t._count._all,
        pendingTeams: countOf(pending, t.eventSlug),
        participants: countOf(participants, t.eventSlug),
        entered: countOf(entered, t.eventSlug),
      }))
      .sort((a, b) => a.slug.localeCompare(b.slug));
  }

  /**
   * Every filter except the status/gate view. The counters use exactly this, so the counts
   * always match the rows of each view under the same event/college/search/date filters.
   */
  private registrationWhere(filters: Omit<RegistrationFilters, 'page' | 'view'>): Prisma.RegistrationWhereInput {
    const and: Prisma.RegistrationWhereInput[] = [];
    if (filters.event) and.push({ eventSlug: filters.event });
    if (filters.college) and.push({ person: { collegeId: filters.college } });
    if (filters.arrival) and.push({ expectedArrivalDate: filters.arrival });
    if (filters.departure) and.push({ expectedDepartureDate: filters.departure });
    const q = filters.q?.trim();
    if (q) {
      const contains = { contains: q, mode: Prisma.QueryMode.insensitive };
      const personMatch: Prisma.PersonWhereInput[] = [
        { name: contains },
        { email: contains },
        { rollNumber: contains },
        { college: contains },
      ];
      // Mobile numbers are stored as 10 digits; accept "+91 98765-43210" style input.
      const digits = q.replace(/\D/g, '');
      if (digits.length >= 4 && digits.length === q.replace(/[\s+-]/g, '').length) {
        personMatch.push({ phone: { contains: digits.length > 10 ? digits.slice(-10) : digits } });
      }
      const or: Prisma.RegistrationWhereInput[] = [
        { person: { OR: personMatch } },
        { team: { name: contains } },
        { transactionId: { contains: normalizeTransactionId(q) } },
      ];
      if (UUID.test(q)) or.push({ id: q }, { teamId: q });
      and.push({ OR: or });
    }
    return and.length ? { AND: and } : {};
  }

  /** One row per registration (participant x event), so rows and counters always agree. */
  async listRegistrations(filters: RegistrationFilters) {
    const base = this.registrationWhere(filters);
    const where: Prisma.RegistrationWhereInput = filters.view ? { AND: [base, viewWhere(filters.view)] } : base;
    const [registrations, total, counters] = await Promise.all([
      this.prisma.registration.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip: (filters.page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
        include: {
          person: { select: { name: true, email: true, phone: true, college: true, collegeId: true, blockedAt: true } },
          team: { select: { id: true, name: true, _count: { select: { registrations: true } } } },
        },
      }),
      this.prisma.registration.count({ where }),
      this.countersFor(base),
    ]);
    const txns = [...new Set(registrations.map((r) => r.transactionId).filter(Boolean))] as string[];
    const duplicateTxns = await this.duplicateTxns(txns);
    return { registrations, total, counters, duplicateTxns };
  }

  async counters(filter: { event?: string; college?: string } = {}): Promise<Counters> {
    return this.countersFor(this.registrationWhere(filter));
  }

  /** TOTAL/VERIFIED/PENDING/REJECTED/BLOCKED/INSIDE/OUTSIDE over registrations matching `where`. */
  async countersFor(where: Prisma.RegistrationWhereInput): Promise<Counters> {
    const count = (view: RegistrationView) => this.prisma.registration.count({ where: { AND: [where, viewWhere(view)] } });
    const [byStatus, inside, blocked] = await Promise.all([
      this.prisma.registration.groupBy({ by: ['paymentStatus'], where, _count: { _all: true } }),
      count('INSIDE'),
      count('BLOCKED'),
    ]);
    const of = (status: PaymentStatus) => byStatus.find((b) => b.paymentStatus === status)?._count._all ?? 0;
    const total = byStatus.reduce((n, b) => n + b._count._all, 0);
    return {
      total,
      verified: of(PaymentStatus.VERIFIED),
      pending: of(PaymentStatus.PENDING),
      rejected: of(PaymentStatus.REJECTED),
      blocked,
      inside,
      outside: total - inside,
    };
  }

  /**
   * Registrations whose PLANNED arrival/departure (form "Check In/Out Date") is `day`, with their
   * ACTUAL gate state from QR scans. The two are never mixed: expected comes from the form,
   * arrived/checked-out/inside from EntryLog-backed fields.
   */
  async expected(kind: ExpectedKind, day: Date, filter: { event?: string; college?: string } = {}) {
    const rows = await this.prisma.registration.findMany({
      where: {
        ...(kind === 'arrival' ? { expectedArrivalDate: day } : { expectedDepartureDate: day }),
        ...(filter.event ? { eventSlug: filter.event } : {}),
        ...(filter.college ? { person: { collegeId: filter.college } } : {}),
      },
      orderBy: [{ person: { college: 'asc' } }, { person: { name: 'asc' } }],
      include: {
        person: { select: { id: true, name: true, email: true, phone: true, college: true, collegeId: true, blockedAt: true } },
      },
    });
    const summarize = (list: typeof rows): ExpectedSummary => {
      const arrived = list.filter((r) => r.enteredAt).length;
      const stillInside = list.filter((r) => r.insideSince).length;
      return {
        expected: list.length,
        arrived,
        notArrived: list.length - arrived,
        checkedOut: list.filter((r) => !r.insideSince && r.lastCheckOutAt).length,
        stillInside,
        blocked: list.filter((r) => r.person.blockedAt).length,
      };
    };
    const byCollege = new Map<string, { id: string | null; name: string; rows: typeof rows }>();
    for (const r of rows) {
      const key = r.person.collegeId ?? '';
      const group = byCollege.get(key) ?? { id: r.person.collegeId, name: r.person.college ?? 'No college', rows: [] };
      group.rows.push(r);
      byCollege.set(key, group);
    }
    return {
      rows,
      summary: summarize(rows),
      colleges: [...byCollege.values()].map((g) => ({ id: g.id, name: g.name, summary: summarize(g.rows) })),
    };
  }

  async collegeOptions() {
    return this.prisma.college.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true } });
  }

  /** Colleges with registration counters, optionally for one event and/or a name search. */
  async colleges(filter: { event?: string; q?: string } = {}): Promise<CollegeRow[]> {
    const event = filter.event ?? null;
    const q = filter.q ?? null;
    const rows = await this.prisma.$queryRaw<
      { id: string; name: string; total: bigint; verified: bigint; pending: bigint; rejected: bigint; blocked: bigint; inside: bigint }[]
    >`
      SELECT c."id", c."name",
        COUNT(r."id") AS total,
        COUNT(r."id") FILTER (WHERE r."paymentStatus" = 'VERIFIED') AS verified,
        COUNT(r."id") FILTER (WHERE r."paymentStatus" = 'PENDING') AS pending,
        COUNT(r."id") FILTER (WHERE r."paymentStatus" = 'REJECTED') AS rejected,
        COUNT(r."id") FILTER (WHERE p."blockedAt" IS NOT NULL) AS blocked,
        COUNT(r."id") FILTER (WHERE r."insideSince" IS NOT NULL) AS inside
      FROM "College" c
      JOIN "Person" p ON p."collegeId" = c."id"
      JOIN "Registration" r ON r."personId" = p."id"
      WHERE (${event}::text IS NULL OR r."eventSlug" = ${event})
        AND (${q}::text IS NULL OR c."name" ILIKE '%' || ${q} || '%')
      GROUP BY c."id", c."name"
      ORDER BY c."name"`;
    return rows.map((r) => {
      const total = Number(r.total);
      const inside = Number(r.inside);
      return {
        id: r.id,
        name: r.name,
        total,
        verified: Number(r.verified),
        pending: Number(r.pending),
        rejected: Number(r.rejected),
        blocked: Number(r.blocked),
        inside,
        outside: total - inside,
      };
    });
  }

  async collegeParticipants(collegeId: string, event?: string) {
    const college = await this.prisma.college.findUnique({ where: { id: collegeId } });
    if (!college) return null;
    const registrations = await this.prisma.registration.findMany({
      where: { person: { collegeId }, ...(event ? { eventSlug: event } : {}) },
      orderBy: [{ person: { name: 'asc' } }, { eventSlug: 'asc' }],
      include: {
        person: { select: { id: true, name: true, email: true, phone: true, rollNumber: true, qrToken: true, blockedAt: true } },
      },
    });
    const events = await this.prisma.registration.groupBy({
      by: ['eventSlug'],
      where: { person: { collegeId } },
      _count: { _all: true },
      orderBy: { eventSlug: 'asc' },
    });
    return { college, registrations, events: events.map((e) => ({ slug: e.eventSlug, count: e._count._all })) };
  }

  async participantDetail(registrationId: string) {
    const reg = await this.prisma.registration.findUnique({
      where: { id: registrationId },
      include: {
        person: {
          include: {
            collegeRef: true,
            blockedBy: { select: { name: true, email: true } },
            registrations: { select: { id: true, eventSlug: true } },
          },
        },
        team: { include: { registrations: { select: { id: true } } } },
        paymentReviewedBy: { select: { name: true, email: true } },
        entryLogs: {
          orderBy: { enteredAt: 'desc' },
          take: 50,
          include: { volunteer: { select: { name: true, email: true } } },
        },
      },
    });
    if (!reg) return null;
    const [activity, emails] = await Promise.all([
      this.prisma.registrationActivity.findMany({
        where: { registrationId },
        orderBy: { createdAt: 'desc' },
        take: 200,
        include: { actor: { select: { name: true, email: true } } },
      }),
      this.prisma.emailOutbox.findMany({
        where: { registrationId },
        orderBy: { createdAt: 'desc' },
        include: { triggeredBy: { select: { name: true, email: true } } },
      }),
    ]);
    return { reg, activity, emails };
  }

  /** Transaction IDs used by more than one team. */
  private async duplicateTxns(txns: string[]): Promise<Set<string>> {
    if (txns.length === 0) return new Set();
    const pairs = await this.prisma.registration.findMany({
      where: { transactionId: { in: txns }, teamId: { not: null } },
      distinct: ['transactionId', 'teamId'],
      select: { transactionId: true },
    });
    const seen = new Map<string, number>();
    for (const p of pairs) seen.set(p.transactionId!, (seen.get(p.transactionId!) ?? 0) + 1);
    return new Set([...seen].filter(([, n]) => n > 1).map(([t]) => t));
  }

  async teamDetail(id: string) {
    const team = await this.prisma.team.findUnique({
      where: { id },
      include: {
        registrations: {
          orderBy: { createdAt: 'asc' },
          include: {
            person: true,
            paymentReviewedBy: { select: { name: true, email: true } },
            enteredBy: { select: { name: true, email: true } },
            entryLogs: { where: { status: EntryStatus.ENTERED, kind: EntryKind.CHECK_IN }, orderBy: { enteredAt: 'desc' }, take: 1 },
            team: { select: { captainEmail: true } },
          },
        },
      },
    });
    if (!team) return null;
    const regIds = team.registrations.map((r) => r.id);
    const txn = team.registrations.find((r) => r.transactionId)?.transactionId ?? null;

    const [activity, emails, txnUsers] = await Promise.all([
      this.prisma.registrationActivity.findMany({
        where: { registrationId: { in: regIds } },
        orderBy: { createdAt: 'desc' },
        take: 200,
        include: {
          actor: { select: { name: true, email: true } },
          registration: { select: { person: { select: { name: true, email: true } } } },
        },
      }),
      this.prisma.emailOutbox.findMany({
        where: { registrationId: { in: regIds } },
        orderBy: { createdAt: 'desc' },
        include: { triggeredBy: { select: { name: true, email: true } } },
      }),
      txn
        ? this.prisma.registration.findMany({
            where: { transactionId: txn, teamId: { not: team.id } },
            distinct: ['teamId'],
            select: {
              eventSlug: true,
              paymentStatus: true,
              team: { select: { id: true, name: true } },
            },
          })
        : Promise.resolve([]),
    ]);
    return { team, txn, activity, emails, otherTeamsWithTxn: txnUsers };
  }

  async teamIdForRegistration(registrationId: string): Promise<string | null> {
    const reg = await this.prisma.registration.findUnique({
      where: { id: registrationId },
      select: { teamId: true },
    });
    return reg?.teamId ?? null;
  }

  async personIdForRegistration(registrationId: string): Promise<string | null> {
    const reg = await this.prisma.registration.findUnique({
      where: { id: registrationId },
      select: { personId: true },
    });
    return reg?.personId ?? null;
  }

  async collegeName(collegeId: string): Promise<string | null> {
    return (await this.prisma.college.findUnique({ where: { id: collegeId }, select: { name: true } }))?.name ?? null;
  }

  async entries(event: string | undefined, page: number) {
    const where: Prisma.EntryLogWhereInput = event ? { eventSlug: event } : {};
    const [logs, total] = await Promise.all([
      this.prisma.entryLog.findMany({
        where,
        orderBy: { enteredAt: 'desc' },
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
        include: {
          person: { select: { name: true, email: true } },
          volunteer: { select: { name: true, email: true } },
          registration: { select: { team: { select: { id: true, name: true } } } },
        },
      }),
      this.prisma.entryLog.count({ where }),
    ]);
    return { logs, total };
  }
}
