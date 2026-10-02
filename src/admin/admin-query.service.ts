import { Injectable } from '@nestjs/common';
import { EntryStatus, PaymentStatus, Prisma } from '@prisma/client';
import { normalizeTransactionId } from '../forms/form-response.parser';
import { PrismaService } from '../prisma/prisma.service';

export const PAGE_SIZE = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface TeamFilters {
  event?: string;
  status?: PaymentStatus;
  q?: string;
  page: number;
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

  private teamWhere(filters: Omit<TeamFilters, 'page' | 'status'>): Prisma.TeamWhereInput {
    const where: Prisma.TeamWhereInput = { registrations: { some: {} } };
    if (filters.event) where.eventSlug = filters.event;
    const q = filters.q?.trim();
    if (q) {
      const contains = { contains: q, mode: Prisma.QueryMode.insensitive };
      const or: Prisma.TeamWhereInput[] = [
        { name: contains },
        {
          registrations: {
            some: {
              OR: [
                { person: { name: contains } },
                { person: { email: contains } },
                { transactionId: { contains: normalizeTransactionId(q) } },
              ],
            },
          },
        },
      ];
      if (UUID.test(q)) or.push({ id: q }, { registrations: { some: { id: q } } });
      where.AND = [{ OR: or }];
    }
    return where;
  }

  async listTeams(filters: TeamFilters) {
    const base = this.teamWhere(filters);
    const where: Prisma.TeamWhereInput = filters.status
      ? { ...base, registrations: { some: { paymentStatus: filters.status } } }
      : base;

    const [teams, total, statusCounts] = await Promise.all([
      this.prisma.team.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (filters.page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
        include: {
          registrations: {
            orderBy: { createdAt: 'asc' },
            select: {
              id: true,
              paymentStatus: true,
              transactionId: true,
              enteredAt: true,
              person: { select: { name: true, email: true } },
            },
          },
        },
      }),
      this.prisma.team.count({ where }),
      this.statusCounts(base),
    ]);

    const txns = [...new Set(teams.flatMap((t) => t.registrations.map((r) => r.transactionId)).filter(Boolean))] as string[];
    const duplicateTxns = await this.duplicateTxns(txns);
    return { teams, total, statusCounts, duplicateTxns };
  }

  /** Team counts per payment status for the current event/search, for the filter chips. */
  private async statusCounts(base: Prisma.TeamWhereInput) {
    const count = (status?: PaymentStatus) =>
      this.prisma.team.count({
        where: status ? { ...base, registrations: { some: { paymentStatus: status } } } : base,
      });
    const [all, pending, verified, rejected] = await Promise.all([
      count(),
      count(PaymentStatus.PENDING),
      count(PaymentStatus.VERIFIED),
      count(PaymentStatus.REJECTED),
    ]);
    return { all, PENDING: pending, VERIFIED: verified, REJECTED: rejected };
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
            entryLogs: { where: { status: EntryStatus.ENTERED }, orderBy: { enteredAt: 'desc' }, take: 1 },
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
