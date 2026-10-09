import { Injectable } from '@nestjs/common';
import { EmailStatus, NoticeStatus, PaymentStatus, Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { EmailOutboxService } from '../emails/email-outbox.service';
import { EmailTemplate, noticeText } from '../emails/email-templates';
import { EmailWorkerService } from '../emails/email-worker.service';
import { PrismaService } from '../prisma/prisma.service';

/** Shown to the admin as a message instead of an error page. */
export class NoticeError extends Error {}

/** Participants per page in the selection lists: one page = one "select 50" batch. */
export const NOTICE_PAGE_SIZE = 50;
/** Most participants one "Add all matching" click adds (repeat for more). */
export const NOTICE_ADD_ALL_MAX = 5000;
export const NOTICE_LIMITS = { title: 200, subject: 200, body: 20_000 } as const;

/** A sendable address. The same rule runs in SQL (NOTICE_EMAIL_SQL) for the lists. */
export const VALID_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NOTICE_EMAIL_SQL = '^[^[:space:]@]+@[^[:space:]@]+\\.[^[:space:]@]+$';

/**
 * Where one recipient stands, from its current EmailOutbox row (the worker's real result):
 * SELECTED = chosen but not queued yet (awaiting the admin's confirmation), PENDING = queued /
 * sending / waiting for a retry or a quota pause, SENT = accepted by the provider, FAILED =
 * failed permanently or out of retries.
 */
export type RecipientState = 'SELECTED' | 'PENDING' | 'SENT' | 'FAILED';
export const RECIPIENT_STATES: RecipientState[] = ['SELECTED', 'PENDING', 'SENT', 'FAILED'];

export const recipientState = (outbox: { status: EmailStatus } | null): RecipientState =>
  !outbox
    ? 'SELECTED'
    : outbox.status === EmailStatus.SENT
      ? 'SENT'
      : outbox.status === EmailStatus.FAILED || outbox.status === EmailStatus.CANCELLED
        ? 'FAILED'
        : 'PENDING';

const STATE_WHERE: Record<RecipientState, Prisma.NoticeRecipientWhereInput> = {
  SELECTED: { outboxId: null },
  PENDING: { outbox: { status: { in: [EmailStatus.PENDING, EmailStatus.PROCESSING] } } },
  SENT: { outbox: { status: EmailStatus.SENT } },
  FAILED: { outbox: { status: { in: [EmailStatus.FAILED, EmailStatus.CANCELLED] } } },
};

export interface NoticeCounts {
  /** Recipient records (one per unique email address). */
  selected: number;
  /** Selected, not queued yet. */
  awaiting: number;
  pending: number;
  sent: number;
  failed: number;
  firstSentAt: Date | null;
  lastSentAt: Date | null;
}

export type NoticeDisplayStatus = 'Draft' | 'Ready' | 'Sending' | 'Partially sent' | 'Completed' | 'Failed';

/** Draft / Ready until something is queued; then from the real delivery results. */
export function noticeDisplayStatus(notice: { status: NoticeStatus }, c: NoticeCounts): NoticeDisplayStatus {
  const queued = c.pending + c.sent + c.failed;
  if (queued === 0) return notice.status === NoticeStatus.DRAFT ? 'Draft' : 'Ready';
  if (c.pending > 0) return 'Sending';
  if (c.sent === 0) return 'Failed';
  return c.failed > 0 || c.awaiting > 0 ? 'Partially sent' : 'Completed';
}

/** Participant filters of the selection lists. */
export interface NoticeFilter {
  q?: string;
  collegeId?: string;
  event?: string;
  payment?: PaymentStatus;
}

export interface NoticeCandidate {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  college: string | null;
  blockedAt: Date | null;
  emailBouncedAt: Date | null;
  events: string[];
}

export interface NoticeInput {
  title: string;
  subject: string;
  body: string;
}

const emptyCounts = (): NoticeCounts => ({ selected: 0, awaiting: 0, pending: 0, sent: 0, failed: 0, firstSentAt: null, lastSentAt: null });
const escapeLike = (value: string) => value.replace(/[\\%_]/g, (c) => `\\${c}`);
/** Send-once key of a recipient's n-th delivery attempt (1 = first send, 2+ = admin retries). */
const deliveryKey = (recipientId: string, attempt: number) => `notice:${recipientId}:${attempt}`;
const testKeyPrefix = (noticeId: string) => `notice-test:${noticeId}:`;

/**
 * Admin notices: a notice is written and saved first, then recipients are selected (persisted as
 * NoticeRecipient rows, one per unique email address), then the admin explicitly confirms and the
 * deliveries are queued as ordinary EmailOutbox rows. The normal email worker sends them with the
 * active provider, with its send-once keys, quota pauses, retries and backoff.
 *
 * Every write to a notice's recipients or content holds an advisory lock on that notice, so
 * double clicks and concurrent requests can neither queue a recipient twice nor change the
 * message while it is being queued. Sent recipients are never queued again.
 */
@Injectable()
export class NoticesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: EmailOutboxService,
    private readonly worker: EmailWorkerService,
  ) {}

  private lock(tx: Prisma.TransactionClient, noticeId: string) {
    return tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'notice:' + noticeId}))`;
  }

  private event(tx: Prisma.TransactionClient, noticeId: string, type: string, actorId: string, details?: Prisma.InputJsonValue) {
    return tx.noticeEvent.create({ data: { noticeId, type, actorId, details } });
  }

  /** Trimmed and length-checked notice fields; the errors to show, if any. */
  validate(raw: Record<string, unknown>): { input: NoticeInput; errors: string[] } {
    const str = (v: unknown) => (typeof v === 'string' ? v : '');
    const input = { title: str(raw.title).trim(), subject: str(raw.subject).replace(/\s+/g, ' ').trim(), body: noticeText(str(raw.body)) };
    const errors: string[] = [];
    if (!input.title) errors.push('Enter a notice title');
    if (!input.subject) errors.push('Enter the email subject');
    if (!input.body) errors.push('Enter the message');
    if (input.title.length > NOTICE_LIMITS.title) errors.push(`The title can be at most ${NOTICE_LIMITS.title} characters`);
    if (input.subject.length > NOTICE_LIMITS.subject) errors.push(`The subject can be at most ${NOTICE_LIMITS.subject} characters`);
    if (input.body.length > NOTICE_LIMITS.body) errors.push(`The message can be at most ${NOTICE_LIMITS.body} characters`);
    return { input, errors };
  }

  async create(input: NoticeInput, status: NoticeStatus, actorId: string): Promise<string> {
    return this.prisma.$transaction(async (tx) => {
      const notice = await tx.notice.create({ data: { ...input, status, createdById: actorId } });
      await this.event(tx, notice.id, 'CREATED', actorId, { status });
      return notice.id;
    });
  }

  /** Content changes only before the first delivery is queued (then every recipient gets one version). */
  async update(noticeId: string, input: NoticeInput, status: NoticeStatus, actorId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.lock(tx, noticeId);
      const notice = await tx.notice.findUnique({ where: { id: noticeId } });
      if (!notice) throw new NoticeError('Notice not found');
      if (notice.lockedAt) throw new NoticeError('This notice can no longer be edited: sending has started, so every recipient gets the same version');
      await tx.notice.update({ where: { id: noticeId }, data: { ...input, status } });
      const changed = (['title', 'subject', 'body'] as const).filter((k) => notice[k] !== input[k]);
      await this.event(tx, noticeId, 'EDITED', actorId, { changed, status });
    });
  }

  get(noticeId: string) {
    return this.prisma.notice.findUnique({ where: { id: noticeId }, include: { createdBy: { select: { name: true, email: true } } } });
  }

  // ---------- counts and lists ----------

  async counts(noticeIds: string[]): Promise<Map<string, NoticeCounts>> {
    const result = new Map(noticeIds.map((id) => [id, emptyCounts()]));
    if (noticeIds.length === 0) return result;
    const rows = await this.prisma.$queryRaw<(NoticeCounts & { noticeId: string })[]>`
      SELECT r."noticeId"::text AS "noticeId",
        count(*)::int AS selected,
        count(*) FILTER (WHERE r."outboxId" IS NULL)::int AS awaiting,
        count(*) FILTER (WHERE o."status" IN ('PENDING', 'PROCESSING'))::int AS pending,
        count(*) FILTER (WHERE o."status" = 'SENT')::int AS sent,
        count(*) FILTER (WHERE o."status" IN ('FAILED', 'CANCELLED'))::int AS failed,
        min(o."sentAt") AS "firstSentAt",
        max(o."sentAt") AS "lastSentAt"
      FROM "NoticeRecipient" r LEFT JOIN "EmailOutbox" o ON o."id" = r."outboxId"
      WHERE r."noticeId"::text IN (${Prisma.join(noticeIds)})
      GROUP BY r."noticeId"`;
    for (const { noticeId, ...c } of rows) result.set(noticeId, c);
    return result;
  }

  /** Every notice, newest first, with its delivery counts and Not-yet-selected count. */
  async list() {
    const notices = await this.prisma.notice.findMany({ orderBy: { createdAt: 'desc' }, include: { createdBy: { select: { name: true, email: true } } } });
    const counts = await this.counts(notices.map((n) => n.id));
    return Promise.all(
      notices.map(async (n) => {
        const c = counts.get(n.id)!;
        return { ...n, counts: c, notSelected: await this.candidateCount(n.id, {}), display: noticeDisplayStatus(n, c) };
      }),
    );
  }

  private filterSql(f: NoticeFilter): Prisma.Sql[] {
    const parts: Prisma.Sql[] = [
      Prisma.sql`EXISTS (SELECT 1 FROM "Registration" rg WHERE rg."personId" = p."id"
        ${f.event ? Prisma.sql`AND rg."eventSlug" = ${f.event}` : Prisma.empty}
        ${f.payment ? Prisma.sql`AND rg."paymentStatus" = ${f.payment}::"PaymentStatus"` : Prisma.empty})`,
    ];
    if (f.collegeId) parts.push(Prisma.sql`p."collegeId"::text = ${f.collegeId}`);
    const q = f.q?.trim();
    if (q) {
      const like = `%${escapeLike(q)}%`;
      parts.push(
        Prisma.sql`(p."name" ILIKE ${like} OR p."email" ILIKE ${like} OR p."phone" ILIKE ${like} OR p."college" ILIKE ${like} OR p."rollNumber" ILIKE ${like})`,
      );
    }
    return parts;
  }

  /** Eligible (valid email) participants with no recipient record in this notice yet. */
  private candidateWhere(noticeId: string, f: NoticeFilter): Prisma.Sql {
    return Prisma.join(
      [
        ...this.filterSql(f),
        Prisma.sql`p."email" ~ ${NOTICE_EMAIL_SQL}`,
        Prisma.sql`NOT EXISTS (SELECT 1 FROM "NoticeRecipient" nr WHERE nr."noticeId"::text = ${noticeId} AND (nr."personId" = p."id" OR nr."email" = lower(p."email")))`,
      ],
      ' AND ',
    );
  }

  private ineligibleWhere(f: NoticeFilter): Prisma.Sql {
    return Prisma.join([...this.filterSql(f), Prisma.sql`(p."email" IS NULL OR p."email" !~ ${NOTICE_EMAIL_SQL})`], ' AND ');
  }

  private personRows(where: Prisma.Sql, page: number) {
    return this.prisma.$queryRaw<NoticeCandidate[]>`
      SELECT p."id"::text AS id, p."name", p."email", p."phone", p."college", p."blockedAt", p."emailBouncedAt",
        ARRAY(SELECT DISTINCT rg."eventSlug" FROM "Registration" rg WHERE rg."personId" = p."id" ORDER BY 1) AS events
      FROM "Person" p WHERE ${where}
      ORDER BY lower(coalesce(p."name", '')), p."email", p."id"
      LIMIT ${NOTICE_PAGE_SIZE} OFFSET ${(page - 1) * NOTICE_PAGE_SIZE}`;
  }

  private async personCount(where: Prisma.Sql): Promise<number> {
    const [row] = await this.prisma.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM "Person" p WHERE ${where}`;
    return row.n;
  }

  candidateCount(noticeId: string, f: NoticeFilter) {
    return this.personCount(this.candidateWhere(noticeId, f));
  }

  /** "Not yet selected": computed from the database on every request, never from browser state. */
  async candidates(noticeId: string, f: NoticeFilter, page: number) {
    const where = this.candidateWhere(noticeId, f);
    const [rows, total] = await Promise.all([this.personRows(where, page), this.personCount(where)]);
    return { rows, total };
  }

  /** Participants with no email or an unusable one: never queued, never counted as sent/pending/failed. */
  async ineligible(f: NoticeFilter, page: number) {
    const where = this.ineligibleWhere(f);
    const [rows, total] = await Promise.all([this.personRows(where, page), this.personCount(where)]);
    return { rows, total };
  }

  ineligibleCount() {
    return this.personCount(this.ineligibleWhere({}));
  }

  private readonly recipientInclude = {
    outbox: {
      select: { id: true, status: true, attempts: true, sendAt: true, sentAt: true, providerMessageId: true, deliveryStatus: true, lastError: true, createdAt: true, updatedAt: true },
    },
    _count: { select: { deliveries: true } },
  } satisfies Prisma.NoticeRecipientInclude;

  private recipientWhere(noticeId: string, state: RecipientState | undefined, q: string | undefined): Prisma.NoticeRecipientWhereInput {
    const text = q?.trim();
    return {
      noticeId,
      ...(state ? STATE_WHERE[state] : {}),
      ...(text ? { OR: [{ name: { contains: text, mode: 'insensitive' } }, { email: { contains: text, mode: 'insensitive' } }] } : {}),
    };
  }

  async recipients(noticeId: string, state: RecipientState | undefined, q: string | undefined, page: number, pageSize = NOTICE_PAGE_SIZE) {
    const where = this.recipientWhere(noticeId, state, q);
    const [rows, total] = await Promise.all([
      this.prisma.noticeRecipient.findMany({
        where,
        include: this.recipientInclude,
        orderBy: [{ addedAt: 'asc' }, { email: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.noticeRecipient.count({ where }),
    ]);
    return { rows: rows.map((r) => ({ ...r, state: recipientState(r.outbox) })), total };
  }

  /** Report rows for the CSV export (every recipient, optionally one state). */
  async allRecipients(noticeId: string, state: RecipientState | undefined, q: string | undefined) {
    const rows = await this.prisma.noticeRecipient.findMany({
      where: this.recipientWhere(noticeId, state, q),
      include: this.recipientInclude,
      orderBy: [{ addedAt: 'asc' }, { email: 'asc' }],
    });
    return rows.map((r) => ({ ...r, state: recipientState(r.outbox) }));
  }

  /** One recipient with every delivery attempt; scoped to its notice. */
  async recipient(noticeId: string, recipientId: string) {
    const r = await this.prisma.noticeRecipient.findFirst({
      where: { id: recipientId, noticeId },
      include: {
        ...this.recipientInclude,
        person: { select: { registrations: { take: 1, orderBy: { createdAt: 'asc' }, select: { id: true } } } },
        deliveries: {
          orderBy: { createdAt: 'asc' },
          select: { id: true, idempotencyKey: true, toEmail: true, status: true, attempts: true, createdAt: true, sendAt: true, sentAt: true, updatedAt: true, providerMessageId: true, deliveryStatus: true, lastError: true, triggeredBy: { select: { name: true, email: true } } },
        },
      },
    });
    return r ? { ...r, state: recipientState(r.outbox) } : null;
  }

  history(noticeId: string) {
    return this.prisma.noticeEvent.findMany({ where: { noticeId }, orderBy: { createdAt: 'desc' }, take: 200, include: { actor: { select: { name: true, email: true } } } });
  }

  /** Filter choices: colleges with participants, and events with registrations. */
  async filterOptions() {
    const [colleges, events] = await Promise.all([
      this.prisma.college.findMany({ where: { people: { some: {} } }, orderBy: { name: 'asc' }, select: { id: true, name: true } }),
      this.prisma.registration.groupBy({ by: ['eventSlug'], orderBy: { eventSlug: 'asc' } }),
    ]);
    return { colleges, events: events.map((e) => e.eventSlug) };
  }

  // ---------- selecting recipients ----------

  /**
   * Adds participants as recipients (persisted; nothing is sent). One recipient per unique email
   * address: a participant whose address is already a recipient of this notice (also through
   * another record) is skipped, and so is anyone without a valid email. Never changes existing
   * recipients or the notice's content.
   */
  async addRecipients(
    noticeId: string,
    selection: { personIds: string[] } | { all: NoticeFilter },
    actorId: string,
  ): Promise<{ added: number; alreadySelected: number; ineligible: number; capped: boolean }> {
    return this.prisma.$transaction(
      async (tx) => {
        await this.lock(tx, noticeId);
        if (!(await tx.notice.findUnique({ where: { id: noticeId }, select: { id: true } }))) throw new NoticeError('Notice not found');

        let ids: string[];
        let capped = false;
        if ('all' in selection) {
          const rows = await tx.$queryRaw<{ id: string }[]>`
            SELECT p."id"::text AS id FROM "Person" p WHERE ${this.candidateWhere(noticeId, selection.all)}
            ORDER BY lower(coalesce(p."name", '')), p."email", p."id" LIMIT ${NOTICE_ADD_ALL_MAX + 1}`;
          capped = rows.length > NOTICE_ADD_ALL_MAX;
          ids = rows.slice(0, NOTICE_ADD_ALL_MAX).map((r) => r.id);
        } else {
          ids = [...new Set(selection.personIds)];
        }
        if (ids.length === 0) return { added: 0, alreadySelected: 0, ineligible: 0, capped };

        const people = await tx.person.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, email: true } });
        const seen = new Set<string>();
        const data: Prisma.NoticeRecipientCreateManyInput[] = [];
        let ineligible = 0;
        for (const p of people) {
          const email = p.email?.trim().toLowerCase() ?? '';
          if (!VALID_EMAIL.test(email)) {
            ineligible++;
            continue;
          }
          if (seen.has(email)) continue;
          seen.add(email);
          data.push({ noticeId, personId: p.id, name: p.name, email });
        }
        // Unique (notice, email) and (notice, person): an address/person already selected is skipped.
        const { count: added } = await tx.noticeRecipient.createMany({ data, skipDuplicates: true });
        const alreadySelected = people.length - ineligible - added;
        await this.event(tx, noticeId, 'RECIPIENTS_ADDED', actorId, {
          added,
          alreadySelected,
          ineligible,
          ...('all' in selection ? { allMatching: { ...selection.all }, capped } : {}),
        });
        return { added, alreadySelected, ineligible, capped };
      },
      { timeout: 60_000 },
    );
  }

  /** Removes selected recipients that were never queued (queued/sent ones stay for the record). */
  async removeRecipients(noticeId: string, recipientIds: string[], actorId: string): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      await this.lock(tx, noticeId);
      const { count } = await tx.noticeRecipient.deleteMany({ where: { noticeId, id: { in: recipientIds }, outboxId: null, deliveries: { none: {} } } });
      if (count) await this.event(tx, noticeId, 'RECIPIENTS_REMOVED', actorId, { removed: count });
      return count;
    });
  }

  // ---------- sending ----------

  /** Selected recipients awaiting confirmation (the review screen). */
  awaiting(noticeId: string) {
    return this.prisma.noticeRecipient.findMany({ where: { noticeId, outboxId: null }, orderBy: [{ addedAt: 'asc' }, { email: 'asc' }] });
  }

  private deliveryRow(notice: { id: string; subject: string; body: string }, recipient: { id: string; email: string }, attempt: number, actorId: string) {
    return {
      toEmail: recipient.email,
      subject: notice.subject,
      template: EmailTemplate.Notice,
      // Snapshot of the locked content: every delivery of the notice carries the same version.
      payload: { noticeId: notice.id, subject: notice.subject, body: notice.body },
      idempotencyKey: deliveryKey(recipient.id, attempt),
      triggeredById: actorId,
      noticeRecipientId: recipient.id,
    };
  }

  /** Points each recipient at its newly created delivery row. */
  private linkDeliveries(tx: Prisma.TransactionClient, keys: string[]) {
    return tx.$executeRaw`
      UPDATE "NoticeRecipient" r SET "outboxId" = o."id", "queuedAt" = now()
      FROM "EmailOutbox" o
      WHERE o."noticeRecipientId" = r."id" AND o."idempotencyKey" IN (${Prisma.join(keys)})`;
  }

  /**
   * The admin's confirmation: queues one private email (one recipient per email) for every
   * selected recipient that has never been queued and was on the review screen (added at or
   * before `reviewedAt`). Locks the notice's content. A repeat (double click, refresh) finds
   * nothing left to queue. Sending itself happens in the email worker.
   */
  async queue(noticeId: string, reviewedAt: Date, actorId: string): Promise<number> {
    const queued = await this.prisma.$transaction(
      async (tx) => {
        await this.lock(tx, noticeId);
        const notice = await tx.notice.findUnique({ where: { id: noticeId } });
        if (!notice) throw new NoticeError('Notice not found');
        if (notice.status === NoticeStatus.DRAFT) throw new NoticeError('This notice is a draft. Edit it and choose Save notice before sending');
        const recipients = await tx.noticeRecipient.findMany({
          where: { noticeId, outboxId: null, addedAt: { lte: reviewedAt } },
          select: { id: true, email: true, _count: { select: { deliveries: true } } },
        });
        if (recipients.length === 0) return 0;
        const rows = recipients.map((r) => this.deliveryRow(notice, r, r._count.deliveries + 1, actorId));
        await this.outbox.enqueue(rows, tx);
        await this.linkDeliveries(tx, rows.map((r) => r.idempotencyKey));
        if (!notice.lockedAt) await tx.notice.update({ where: { id: noticeId }, data: { lockedAt: new Date() } });
        await this.event(tx, noticeId, 'QUEUED', actorId, { queued: rows.length });
        return rows.length;
      },
      { timeout: 60_000 },
    );
    if (queued) this.worker.kick();
    return queued;
  }

  /**
   * Retries FAILED deliveries (all of the notice, or one recipient): a new attempt row with its
   * own send-once key, on the same recipient record. Sent and pending recipients are untouched.
   */
  async retryFailed(noticeId: string, actorId: string, recipientId?: string): Promise<number> {
    const retried = await this.prisma.$transaction(
      async (tx) => {
        await this.lock(tx, noticeId);
        const notice = await tx.notice.findUnique({ where: { id: noticeId } });
        if (!notice) throw new NoticeError('Notice not found');
        const recipients = await tx.noticeRecipient.findMany({
          where: { noticeId, ...(recipientId ? { id: recipientId } : {}), ...STATE_WHERE.FAILED },
          select: { id: true, email: true, _count: { select: { deliveries: true } } },
        });
        if (recipients.length === 0) return 0;
        const rows = recipients.map((r) => this.deliveryRow(notice, r, r._count.deliveries + 1, actorId));
        await this.outbox.enqueue(rows, tx);
        await this.linkDeliveries(tx, rows.map((r) => r.idempotencyKey));
        await this.event(tx, noticeId, 'RETRIED', actorId, { retried: rows.length, ...(recipientId ? { recipient: recipients[0].email } : {}) });
        return rows.length;
      },
      { timeout: 60_000 },
    );
    if (retried) this.worker.kick();
    return retried;
  }

  /**
   * Asks the worker to process the queue now. Pending deliveries are never re-created; a quota
   * pause is still respected (the worker resumes by itself when it ends).
   */
  async resume(noticeId: string, actorId: string): Promise<{ pending: number; pausedUntil: Date | null }> {
    const pending = await this.prisma.noticeRecipient.count({ where: { noticeId, ...STATE_WHERE.PENDING } });
    await this.prisma.noticeEvent.create({ data: { noticeId, type: 'RESUMED', actorId, details: { pending } } });
    this.worker.kick();
    return { pending, pausedUntil: this.worker.pausedUntilAt };
  }

  /** A test copy to the signed-in admin only (not a recipient; one queued at a time per notice). */
  async sendTest(noticeId: string, actor: { id: string; email: string }): Promise<string> {
    await this.prisma.$transaction(async (tx) => {
      await this.lock(tx, noticeId);
      const notice = await tx.notice.findUnique({ where: { id: noticeId } });
      if (!notice) throw new NoticeError('Notice not found');
      const busy = await tx.emailOutbox.count({
        where: { idempotencyKey: { startsWith: testKeyPrefix(noticeId) }, status: { in: [EmailStatus.PENDING, EmailStatus.PROCESSING] } },
      });
      if (busy) throw new NoticeError('A test email of this notice is already queued');
      await this.outbox.enqueue(
        [
          {
            toEmail: actor.email,
            subject: `[Test] ${notice.subject}`,
            template: EmailTemplate.Notice,
            payload: { noticeId, subject: notice.subject, body: notice.body, test: true },
            idempotencyKey: `${testKeyPrefix(noticeId)}${randomUUID()}`,
            triggeredById: actor.id,
          },
        ],
        tx,
      );
      await this.event(tx, noticeId, 'TEST_SENT', actor.id, { to: actor.email });
    });
    this.worker.kick();
    return actor.email;
  }
}
