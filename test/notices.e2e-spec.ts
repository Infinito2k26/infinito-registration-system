import { EmailStatus, NoticeStatus, PaymentStatus, StaffRole } from '@prisma/client';
import { EmailTemplate } from '../src/emails/email-templates';
import { ConsoleTransport, OutgoingEmail, PermanentSendError, SendPausedError } from '../src/emails/mail-transport';
import { Ctx, Staff, flash, getAs, postAs, resetDatabase, staff, startApp, submitRow } from './e2e-helpers';

/**
 * Admin → Notices: write a notice, select recipients (persisted), confirm, and the normal email
 * worker sends one private email per unique address. Sent / Pending / Failed / Not yet selected /
 * Ineligible stay separate, and nobody gets the same notice twice.
 */
describe('Admin notices (e2e)', () => {
  let ctx: Ctx;
  let admin: Staff;
  let coordinator: Staff;
  let volunteer: Staff;

  beforeAll(async () => {
    ctx = await startApp();
  });
  afterAll(async () => {
    jest.restoreAllMocks();
    await ctx.app.close();
  });
  beforeEach(async () => {
    jest.restoreAllMocks();
    await resetDatabase(ctx);
    unpause();
    admin = await staff(ctx, StaffRole.ADMIN);
    coordinator = await staff(ctx, StaffRole.COORDINATOR);
    volunteer = await staff(ctx, StaffRole.VOLUNTEER);
  });

  const unpause = () => ((ctx.worker as unknown as { pausedUntil: number }).pausedUntil = 0);
  const uuids = (text: string, name = 'ids') => [...text.matchAll(new RegExp(`name="${name}" value="([0-9a-f-]{36})"`, 'g'))].map((m) => m[1]);

  /** n participants with valid emails (p001@example.com ...), one registration each. */
  async function people(n: number, opts: { from?: number; event?: string; collegeId?: string; payment?: PaymentStatus; prefix?: string } = {}) {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const k = String((opts.from ?? 1) + i).padStart(3, '0');
      const p = await ctx.prisma.person.create({
        data: {
          name: `${opts.prefix ?? 'Student'} ${k}`,
          email: `${(opts.prefix ?? 'p').toLowerCase()}${k}@example.com`,
          phone: `98765${k.padStart(5, '0')}`,
          college: opts.collegeId ? 'NIT Patna' : 'IIT Patna',
          collegeId: opts.collegeId,
          registrations: { create: { eventSlug: opts.event ?? 'football', responseId: `resp-${opts.prefix ?? 'p'}-${k}`, paymentStatus: opts.payment ?? PaymentStatus.PENDING } },
        },
      });
      ids.push(p.id);
    }
    return ids;
  }

  async function createNotice(action = 'ready', fields: Partial<Record<'title' | 'subject' | 'body', string>> = {}) {
    const res = await postAs(ctx, admin, '/admin/notices', { title: 'Schedule update', subject: 'Infinito schedule changed', body: 'Football moves to 4 pm.\n\nSee https://example.test/schedule', action, ...fields }).expect(303);
    const id = /\/admin\/notices\/([0-9a-f-]{36})$/.exec(res.headers.location)![1];
    return id;
  }

  const notSelectedPage = async (id: string, query = '') => (await getAs(ctx, admin, `/admin/notices/${id}?tab=not-selected${query}`).expect(200)).text;
  const add = (id: string, ids: string[]) => postAs(ctx, admin, `/admin/notices/${id}/recipients`, { ids } as never);
  const reviewedAt = () => new Date(Date.now() + 1000).toISOString();
  const confirmSend = (id: string, who: Staff = admin) => postAs(ctx, who, `/admin/notices/${id}/send`, { confirm: 'yes', reviewedAt: reviewedAt() });
  const states = async (id: string) => {
    const rows = await ctx.prisma.noticeRecipient.findMany({ where: { noticeId: id }, include: { outbox: true } });
    const by = { SELECTED: 0, PENDING: 0, SENT: 0, FAILED: 0 };
    for (const r of rows) {
      const s = r.outbox?.status;
      by[!s ? 'SELECTED' : s === 'SENT' ? 'SENT' : s === 'FAILED' || s === 'CANCELLED' ? 'FAILED' : 'PENDING']++;
    }
    return by;
  };

  /** Runs the worker until nothing is due (or the provider paused it). */
  async function drain() {
    for (let i = 0; i < 100; i++) {
      await ctx.worker.processBatch();
      if (ctx.worker.pausedUntilAt) return;
      if ((await ctx.prisma.emailOutbox.count({ where: { status: EmailStatus.PENDING, sendAt: { lte: new Date() } } })) === 0) return;
    }
  }

  /** Records every email handed to the provider (console transport in tests). */
  function sends(behaviour: (email: OutgoingEmail, n: number) => Promise<string | null> = () => Promise.resolve(null)) {
    const sent: OutgoingEmail[] = [];
    jest.spyOn(ConsoleTransport.prototype, 'send').mockImplementation((email: OutgoingEmail) => {
      sent.push(email);
      return behaviour(email, sent.length);
    });
    return sent;
  }

  it('1. admin only on the server: coordinators and volunteers get 403 everywhere, and no nav link', async () => {
    const id = await createNotice();
    const [pid] = await people(1);
    await add(id, [pid]).expect(303);
    const rid = (await ctx.prisma.noticeRecipient.findFirstOrThrow()).id;
    for (const who of [coordinator, volunteer]) {
      for (const path of ['/admin/notices', '/admin/notices/new', `/admin/notices/${id}`, `/admin/notices/${id}/edit`, `/admin/notices/${id}/send`, `/admin/notices/${id}/report`, `/admin/notices/${id}/report.csv`, `/admin/notices/${id}/recipients/${rid}`]) {
        expect([path, (await getAs(ctx, who, path)).status]).toEqual([path, 403]);
      }
      for (const path of ['/admin/notices', `/admin/notices/${id}/edit`, `/admin/notices/${id}/test`, `/admin/notices/${id}/recipients`, `/admin/notices/${id}/recipients/remove`, `/admin/notices/${id}/send`, `/admin/notices/${id}/retry`, `/admin/notices/${id}/resume`, `/admin/notices/${id}/recipients/${rid}/retry`]) {
        expect([path, (await postAs(ctx, who, path, { title: 'x', subject: 'x', body: 'x', action: 'ready', ids: pid, confirm: 'yes', reviewedAt: reviewedAt() })).status]).toEqual([path, 403]);
      }
    }
    expect(await ctx.prisma.notice.count()).toBe(1);
    expect(await ctx.prisma.emailOutbox.count()).toBe(0);
    expect((await getAs(ctx, coordinator, '/admin/registrations').expect(200)).text).not.toContain('href="/admin/notices"');
    expect((await getAs(ctx, admin, '/admin/registrations').expect(200)).text).toContain('href="/admin/notices"');
  });

  it('2. a notice is saved first (draft or ready), persists, can be edited and previewed; preview saves nothing', async () => {
    // Preview: nothing saved, the message shown escaped.
    const preview = await postAs(ctx, admin, '/admin/notices', { title: 'T', subject: 'S', body: 'Hi <script>alert(1)</script>', action: 'preview' }).expect(200);
    expect(preview.text).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(preview.text).not.toContain('<script>alert(1)');
    expect(await ctx.prisma.notice.count()).toBe(0);
    // Validation.
    const bad = await postAs(ctx, admin, '/admin/notices', { title: '', subject: '', body: '', action: 'ready' }).expect(422);
    expect(bad.text).toContain('Enter a notice title');

    const id = await createNotice('draft');
    expect(await ctx.prisma.notice.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: NoticeStatus.DRAFT, createdById: admin.id, lockedAt: null, subject: 'Infinito schedule changed' });
    const list = (await getAs(ctx, admin, '/admin/notices').expect(200)).text;
    for (const shown of ['Schedule update', 'Infinito schedule changed', 'Draft', 'admin']) expect(list).toContain(shown);

    // Edit the draft, then save it as ready.
    expect((await getAs(ctx, admin, `/admin/notices/${id}/edit`).expect(200)).text).toContain('Football moves to 4 pm.');
    expect(flash(await postAs(ctx, admin, `/admin/notices/${id}/edit`, { title: 'Schedule v2', subject: 'New schedule', body: 'Football at 5 pm.', action: 'ready' }).expect(303))).toBe('Notice saved');
    expect(await ctx.prisma.notice.findUniqueOrThrow({ where: { id } })).toMatchObject({ title: 'Schedule v2', status: NoticeStatus.READY, body: 'Football at 5 pm.' });
    expect((await ctx.prisma.noticeEvent.findMany({ where: { noticeId: id }, orderBy: { createdAt: 'asc' } })).map((e) => e.type)).toEqual(['CREATED', 'EDITED']);
    // Persisted: a restarted app shows the same notice.
    const restarted = await startApp();
    try {
      expect((await restarted.http.get(`/admin/notices/${id}`).set('Cookie', admin.cookie).expect(200)).text).toContain('Schedule v2');
    } finally {
      await restarted.app.close();
    }
  });

  it('test email goes to the admin only, is not a recipient, and one at a time', async () => {
    const id = await createNotice('draft');
    expect(flash(await postAs(ctx, admin, `/admin/notices/${id}/test`).expect(303))).toMatch(/Test email queued to admin@staff.test/);
    expect(flash(await postAs(ctx, admin, `/admin/notices/${id}/test`).expect(303))).toBe('A test email of this notice is already queued');
    const sent = sends();
    await drain();
    expect(sent.map((e) => [e.to, e.subject])).toEqual([['admin@staff.test', '[Test] Infinito schedule changed']]);
    expect(await ctx.prisma.noticeRecipient.count()).toBe(0);
    // A draft cannot be sent to participants.
    const [pid] = await people(1);
    await add(id, [pid]).expect(303);
    expect(flash(await confirmSend(id).expect(303))).toMatch(/This notice is a draft/);
    expect(await ctx.prisma.emailOutbox.count({ where: { noticeRecipientId: { not: null } } })).toBe(0);
  });

  it('3-5. select 50 on a page, more on other pages (kept across pages), search and filters; the total is not limited to 50', async () => {
    const nit = await ctx.prisma.college.create({ data: { name: 'NIT Patna', nameKey: 'nit patna' } });
    await people(110);
    await people(5, { from: 200, event: 'chess', collegeId: nit.id, payment: PaymentStatus.VERIFIED, prefix: 'Zz' }); // sorted last: still unselected below
    const id = await createNotice();

    const page1 = await notSelectedPage(id);
    expect(page1).toContain('Not yet selected (115)');
    const ids1 = uuids(page1);
    expect(ids1).toHaveLength(50);
    expect(page1).toContain('Page 1 of 3');
    const ids2 = uuids(await notSelectedPage(id, '&page=2'));
    expect(ids2).toHaveLength(50);
    expect(ids2.some((x) => ids1.includes(x))).toBe(false);

    // Ticks from two pages sent together (what the page script does), then 50 more later.
    const res = await add(id, [...ids1, ...ids2.slice(0, 10)]).expect(303);
    expect(flash(res)).toBe('Added 60 recipient(s). Nothing is sent until you review and confirm.');
    expect((await notSelectedPage(id)).includes('Not yet selected (55)')).toBe(true);
    const rest = uuids(await notSelectedPage(id));
    expect(rest).toHaveLength(50);
    await add(id, rest).expect(303);
    expect(await ctx.prisma.noticeRecipient.count({ where: { noticeId: id } })).toBe(110);
    expect(await ctx.prisma.emailOutbox.count()).toBe(0); // selecting sends nothing

    // Search and filters (of the remaining 5 not selected).
    const remaining = await ctx.prisma.person.findMany({ where: { noticeRecipients: { none: { noticeId: id } } }, select: { name: true } });
    expect(remaining).toHaveLength(5);
    expect(await notSelectedPage(id, `&college=${nit.id}`)).toContain('Not yet selected (5 matching)');
    expect(await notSelectedPage(id, '&event=chess&payment=VERIFIED')).toContain('Not yet selected (5 matching)');
    expect(await notSelectedPage(id, '&event=football')).toContain('Not yet selected (0 matching)');
    expect(await notSelectedPage(id, '&q=zz201')).toContain('Not yet selected (1 matching)');
    expect(await notSelectedPage(id, '&q=Zz%20203')).toContain('Not yet selected (1 matching)');
    expect(await notSelectedPage(id, '&payment=PENDING')).toContain('Not yet selected (0 matching)');

    // "Add all matching" respects the filter.
    expect(flash(await postAs(ctx, admin, `/admin/notices/${id}/recipients`, { all: '1', q: 'zz20' }).expect(303))).toMatch(/^Added 5 recipient/);
    expect(await notSelectedPage(id)).toContain('Not yet selected (0)');

    // Persisted across refreshes: the Selected tab lists them, page by page.
    const selected = (await getAs(ctx, admin, `/admin/notices/${id}?tab=selected`).expect(200)).text;
    expect(selected).toContain('Selected, awaiting confirmation (115)');
    expect(selected).toContain('Page 1 of 3');
  });

  it('6-7. one recipient per email address; missing/invalid emails are Ineligible and never queued', async () => {
    const [a, b] = await people(2);
    await ctx.prisma.person.create({ data: { name: 'No Email', registrations: { create: { eventSlug: 'football', responseId: 'ne' } } } });
    const bad = await ctx.prisma.person.create({ data: { name: 'Bad Email', email: 'not-an-email', registrations: { create: { eventSlug: 'football', responseId: 'be' } } } });
    const id = await createNotice();

    const ineligible = (await getAs(ctx, admin, `/admin/notices/${id}?tab=ineligible`).expect(200)).text;
    expect(ineligible).toContain('Ineligible (2)');
    expect(ineligible).toContain('No email address');
    expect(ineligible).toContain('Invalid email address');
    expect(await notSelectedPage(id)).toContain('Not yet selected (2)');
    expect(await notSelectedPage(id)).not.toContain('Bad Email');

    // The same participant ticked twice, plus an invalid one forced in: one recipient, one skipped.
    expect(flash(await add(id, [a, a, bad.id]).expect(303))).toBe('Added 1 recipient(s) (1 without a valid email skipped). Nothing is sent until you review and confirm.');
    expect(flash(await add(id, [a]).expect(303))).toMatch(/^Added 0 recipient\(s\) \(1 already selected/);

    // Another record now using an address that is already a recipient: skipped (and not listed).
    await ctx.prisma.person.update({ where: { id: a }, data: { email: 'moved@example.com' } });
    const sameAddress = await ctx.prisma.person.create({ data: { name: 'Same Address', email: 'p001@example.com', registrations: { create: { eventSlug: 'football', responseId: 'sa' } } } });
    expect(await notSelectedPage(id)).not.toContain('Same Address');
    expect(flash(await add(id, [sameAddress.id, b]).expect(303))).toMatch(/^Added 1 recipient\(s\) \(1 already selected/);
    expect((await ctx.prisma.noticeRecipient.findMany({ where: { noticeId: id }, orderBy: { email: 'asc' } })).map((r) => r.email)).toEqual(['p001@example.com', 'p002@example.com']);

    await confirmSend(id).expect(303);
    expect((await ctx.prisma.emailOutbox.findMany({ orderBy: { toEmail: 'asc' } })).map((o) => o.toEmail)).toEqual(['p001@example.com', 'p002@example.com']);
    // The report counts ineligible separately.
    const report = (await getAs(ctx, admin, `/admin/notices/${id}/report`).expect(200)).text;
    expect(report).toMatch(/Ineligible<\/div><div class="value">2</);
  });

  it('8-11. Sent / Pending (quota pause) / Failed / Not yet selected stay separate; adding more later keeps them; resume sends only the rest', async () => {
    const ids = await people(12);
    const id = await createNotice();
    await add(id, ids.slice(0, 10)).expect(303);
    expect((await getAs(ctx, admin, `/admin/notices/${id}/send`).expect(200)).text).toContain('Recipients to queue (10)');
    expect(flash(await confirmSend(id).expect(303))).toMatch(/^Queued 10 email/);
    expect(await states(id)).toEqual({ SELECTED: 0, PENDING: 10, SENT: 0, FAILED: 0 });

    // Send in address order (p001 first), so the outcome below is deterministic.
    const queuedRows = await ctx.prisma.emailOutbox.findMany({ orderBy: { toEmail: 'asc' } });
    for (const [i, row] of queuedRows.entries()) await ctx.prisma.emailOutbox.update({ where: { id: row.id }, data: { sendAt: new Date(Date.now() - 60_000 + i * 1000 - 20_000) } });
    // 6 accepted, 2 rejected permanently, then the provider quota runs out.
    let accepted = 0;
    const sent = sends((email) => {
      if (email.to === 'p003@example.com' || email.to === 'p004@example.com') return Promise.reject(new PermanentSendError('Invalid recipient'));
      if (accepted === 6) return Promise.reject(new SendPausedError('daily_quota_exceeded: You have reached your daily email sending quota', 3_600_000));
      return Promise.resolve(`msg-${++accepted}`);
    });
    await drain();
    expect(ctx.worker.pausedUntilAt).not.toBeNull();
    expect(await states(id)).toEqual({ SELECTED: 0, PENDING: 2, SENT: 6, FAILED: 2 });

    const pending = (await getAs(ctx, admin, `/admin/notices/${id}?tab=pending`).expect(200)).text;
    expect(pending).toContain('Pending / queued (2)');
    expect(pending).toContain('daily_quota_exceeded');
    expect(pending).toContain('Email sending is paused by the provider');
    const failed = (await getAs(ctx, admin, `/admin/notices/${id}?tab=failed`).expect(200)).text;
    expect(failed).toContain('Failed (2)');
    expect(failed).toContain('Invalid recipient');
    const sentTab = (await getAs(ctx, admin, `/admin/notices/${id}?tab=sent`).expect(200)).text;
    expect(sentTab).toContain('Sent (6)');
    expect(sentTab).toMatch(/msg-\d+/);
    // Failed and sent recipients are not "Not yet selected".
    const notSelected = await notSelectedPage(id);
    expect(notSelected).toContain('Not yet selected (2)');
    for (const e of ['p001', 'p003', 'p009']) expect([e, notSelected.includes(`${e}@example.com`)]).toEqual([e, false]);
    expect((await getAs(ctx, admin, '/admin/notices').expect(200)).text).toContain('Sending');

    // Hours later: 2 more recipients added and confirmed while the quota pause is still on.
    await add(id, ids.slice(10)).expect(303);
    expect(await states(id)).toEqual({ SELECTED: 2, PENDING: 2, SENT: 6, FAILED: 2 });
    expect((await getAs(ctx, admin, `/admin/notices/${id}/send`).expect(200)).text).toContain('Recipients to queue (2)');
    expect(flash(await confirmSend(id).expect(303))).toMatch(/^Queued 2 email/);
    expect(await states(id)).toEqual({ SELECTED: 0, PENDING: 4, SENT: 6, FAILED: 2 });
    // Resume during the pause does not hammer the provider.
    const before = sent.length;
    expect(flash(await postAs(ctx, admin, `/admin/notices/${id}/resume`).expect(303))).toMatch(/stay queued: the provider paused sending/);
    await ctx.worker.processBatch();
    expect(sent.length).toBe(before);

    // Quota back: only the 4 pending go out; nobody already sent gets it again.
    unpause();
    sends((_, n) => Promise.resolve(`late-${n}`));
    await drain();
    expect(await states(id)).toEqual({ SELECTED: 0, PENDING: 0, SENT: 10, FAILED: 2 });
    const perAddress = await ctx.prisma.emailOutbox.groupBy({ by: ['toEmail'], where: { status: EmailStatus.SENT }, _count: { _all: true } });
    expect(perAddress).toHaveLength(10);
    expect(perAddress.every((r) => r._count._all === 1)).toBe(true);
    expect((await getAs(ctx, admin, '/admin/notices').expect(200)).text).toContain('Partially sent');

    // 12. Retry one failed recipient (same record, new attempt), then all: sent ones untouched.
    const p3 = await ctx.prisma.noticeRecipient.findFirstOrThrow({ where: { noticeId: id, email: 'p003@example.com' } });
    expect(flash(await postAs(ctx, admin, `/admin/notices/${id}/recipients/${p3.id}/retry`).expect(303))).toBe('Retry queued');
    expect(flash(await postAs(ctx, admin, `/admin/notices/${id}/recipients/${p3.id}/retry`).expect(303))).toBe('This recipient has no failed delivery to retry');
    expect(flash(await postAs(ctx, admin, `/admin/notices/${id}/retry`).expect(303))).toBe('Retrying 1 failed delivery(ies)');
    expect(await ctx.prisma.noticeRecipient.count({ where: { noticeId: id } })).toBe(12);
    expect((await ctx.prisma.emailOutbox.findMany({ where: { noticeRecipientId: p3.id }, orderBy: { createdAt: 'asc' } })).map((o) => [o.idempotencyKey, o.status])).toEqual([
      [`notice:${p3.id}:1`, EmailStatus.FAILED],
      [`notice:${p3.id}:2`, EmailStatus.PENDING],
    ]);
    const resent = sends();
    await drain();
    expect(resent.map((e) => e.to).sort()).toEqual(['p003@example.com', 'p004@example.com']);
    expect(await states(id)).toEqual({ SELECTED: 0, PENDING: 0, SENT: 12, FAILED: 0 });
    expect((await getAs(ctx, admin, '/admin/notices').expect(200)).text).toContain('Completed');

    // Recipient history shows both attempts.
    const history = (await getAs(ctx, admin, `/admin/notices/${id}/recipients/${p3.id}`).expect(200)).text;
    expect(history).toContain('Invalid recipient');
    expect(history).toMatch(/<td class="num">2<\/td><td>.*sent/);

    // 14. Confirming again, or retrying, sends nothing more.
    expect(flash(await confirmSend(id).expect(303))).toBe('Nothing new to queue: every reviewed recipient was already queued');
    expect(flash(await postAs(ctx, admin, `/admin/notices/${id}/retry`).expect(303))).toBe('No failed deliveries to retry');
    expect(await ctx.prisma.emailOutbox.count({ where: { status: EmailStatus.PENDING } })).toBe(0);

    // Report and CSV.
    const report = (await getAs(ctx, admin, `/admin/notices/${id}/report`).expect(200)).text;
    expect(report).toMatch(/Sent %<\/div><div class="value">100%/);
    const csv = await getAs(ctx, admin, `/admin/notices/${id}/report.csv?state=sent`).expect(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.text.trim().split('\r\n')).toHaveLength(13);
    expect(csv.text).toContain('p003@example.com,SENT');
  });

  it('13. double clicks and concurrent requests never queue a recipient twice', async () => {
    const ids = await people(30);
    const id = await createNotice();
    await Promise.all([add(id, ids), add(id, ids), add(id, ids.slice(0, 10))]);
    expect(await ctx.prisma.noticeRecipient.count({ where: { noticeId: id } })).toBe(30);
    const results = await Promise.all(Array.from({ length: 5 }, () => confirmSend(id)));
    expect(results.map((r) => flash(r)).filter((t) => t?.startsWith('Queued 30'))).toHaveLength(1);
    expect(await ctx.prisma.emailOutbox.count()).toBe(30);
    const sent = sends();
    await drain();
    await Promise.all([postAs(ctx, admin, `/admin/notices/${id}/retry`), confirmSend(id), postAs(ctx, admin, `/admin/notices/${id}/resume`)]);
    await drain();
    expect(sent).toHaveLength(30);
    expect(new Set(sent.map((e) => e.to)).size).toBe(30);
  });

  it('15. the content locks when sending starts: every recipient gets the same subject and message', async () => {
    const ids = await people(3);
    const id = await createNotice();
    await add(id, ids.slice(0, 2)).expect(303);
    await confirmSend(id).expect(303);
    expect((await ctx.prisma.notice.findUniqueOrThrow({ where: { id } })).lockedAt).not.toBeNull();
    expect(flash(await getAs(ctx, admin, `/admin/notices/${id}/edit`).expect(303))).toMatch(/can no longer be edited/);
    expect(flash(await postAs(ctx, admin, `/admin/notices/${id}/edit`, { title: 'Changed', subject: 'Changed', body: 'Changed', action: 'ready' }).expect(303))).toMatch(/can no longer be edited/);
    await add(id, ids.slice(2)).expect(303);
    await confirmSend(id).expect(303);
    const sent = sends();
    await drain();
    expect(sent).toHaveLength(3);
    expect(new Set(sent.map((e) => `${e.subject}|${e.text}`))).toEqual(new Set(['Infinito schedule changed|Football moves to 4 pm.\n\nSee https://example.test/schedule']));
    expect(sent.every((e) => e.tags?.template === EmailTemplate.Notice)).toBe(true);
    expect((await ctx.prisma.notice.findUniqueOrThrow({ where: { id } })).title).toBe('Schedule update');
  });

  it('only never-queued recipients can be removed', async () => {
    const ids = await people(3);
    const id = await createNotice();
    await add(id, ids.slice(0, 2)).expect(303);
    await confirmSend(id).expect(303);
    await add(id, ids.slice(2)).expect(303);
    const all = await ctx.prisma.noticeRecipient.findMany({ where: { noticeId: id } });
    expect(flash(await postAs(ctx, admin, `/admin/notices/${id}/recipients/remove`, { ids: all.map((r) => r.id) } as never).expect(303))).toBe('Removed 1 recipient(s) (queued or sent recipients are kept)');
    expect(await ctx.prisma.noticeRecipient.count({ where: { noticeId: id } })).toBe(2);
    // Cross-notice: another notice's recipient cannot be touched through this one.
    const other = await createNotice();
    expect((await postAs(ctx, admin, `/admin/notices/${other}/recipients/${all[0].id}/retry`).expect(303)).headers.location).toContain(other);
    expect(await getAs(ctx, admin, `/admin/notices/${other}/recipients/${all[0].id}`).expect(404));
  });

  it('16. QR emails, verification and the gate are unchanged, and QR passes go out before a big notice', async () => {
    await submitRow(ctx, 'r1', { 'Email Address': 'asha@example.com', Name: 'Asha', 'College Name': 'IIT Patna', Sports: 'Football', 'Aadhaar No.': '1111 2222 3333' }).expect(200);
    const ids = await people(25);
    const id = await createNotice();
    await add(id, ids).expect(303);
    await confirmSend(id).expect(303);
    const reg = await ctx.prisma.registration.findFirstOrThrow({ where: { person: { email: 'asha@example.com' } } });
    await postAs(ctx, admin, `/admin/registrations/${reg.id}/verify`).expect(303);
    expect(await ctx.prisma.emailOutbox.findUniqueOrThrow({ where: { idempotencyKey: `qr-pass:${reg.id}:initial` } })).toMatchObject({ noticeRecipientId: null, template: EmailTemplate.QrPass });

    const sent = sends();
    await ctx.worker.processBatch(); // one batch of 20: the QR pass first, then 19 notices
    expect(sent[0].to).toBe('asha@example.com');
    expect(sent[0].tags?.template).toBe(EmailTemplate.QrPass);
    await drain();
    expect(sent).toHaveLength(26);
    expect(sent.filter((e) => e.to === 'asha@example.com')).toHaveLength(1);

    const token = (await ctx.prisma.person.findFirstOrThrow({ where: { email: 'asha@example.com' } })).qrToken!;
    await postAs(ctx, volunteer, `/p/${token}/enter`, { registrationId: reg.id }).expect(303);
    expect((await ctx.prisma.registration.findUniqueOrThrow({ where: { id: reg.id } })).insideSince).not.toBeNull();
  });
});
