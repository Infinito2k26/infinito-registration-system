import { ActivityType, EmailStatus, PaymentStatus, StaffRole } from '@prisma/client';
import { EmailTemplate } from '../src/emails/email-templates';
import { MailTransport, OutgoingEmail, PermanentSendError } from '../src/emails/mail-transport';
import { Ctx, Staff, flash, getAs, postAs, resetDatabase, staff, startApp, submitRow } from './e2e-helpers';

/**
 * ADMIN bulk verify on the Pending list: every selected registration goes through the normal
 * Verify (same QR token, same single QR email via EmailOutbox, same audit), recorded in the
 * admin verification report with live email status.
 */
describe('Admin bulk verify and verification report (e2e)', () => {
  let ctx: Ctx;
  let admin: Staff;
  let coordinator: Staff;
  let volunteer: Staff;

  beforeAll(async () => {
    ctx = await startApp();
  });
  afterAll(async () => {
    await ctx.app.close();
  });
  beforeEach(async () => {
    await resetDatabase(ctx);
    admin = await staff(ctx, StaffRole.ADMIN);
    coordinator = await staff(ctx, StaffRole.COORDINATOR);
    volunteer = await staff(ctx, StaffRole.VOLUNTEER);
  });

  const solo = (name: string, email?: string, extra: Record<string, string> = {}) => ({
    ...(email ? { 'Email Address': email } : {}),
    Name: name,
    'College Name': 'NIT Patna',
    Sports: 'Table Tennis',
    ...extra,
  });
  const reg = (name: string) => ctx.prisma.registration.findFirstOrThrow({ where: { person: { name } }, include: { person: true } });
  const ids = async (...names: string[]) => Promise.all(names.map(async (n) => (await reg(n)).id));
  const bulk = (who: Staff, registrationIds: string[]) => postAs(ctx, who, '/admin/registrations/bulk-verify', { ids: registrationIds } as never);
  const qrRows = (registrationId?: string) =>
    ctx.prisma.emailOutbox.findMany({ where: { template: EmailTemplate.QrPass, ...(registrationId ? { registrationId } : {}) } });
  const batchIdFrom = (location: string) => location.split('/').pop()!;

  function fakeTransport(failFor: string[] = []) {
    const sent: OutgoingEmail[] = [];
    const transport: MailTransport = {
      name: 'fake',
      send: (email) => {
        if (failFor.includes(email.to)) return Promise.reject(new PermanentSendError('550 5.1.1 mailbox does not exist'));
        sent.push(email);
        return Promise.resolve(`msg_${sent.length}`);
      },
    };
    const worker = ctx.worker as unknown as { transport: MailTransport };
    const original = worker.transport;
    worker.transport = transport;
    return { sent, restore: () => (worker.transport = original) };
  }

  async function seed() {
    await submitRow(ctx, 'r1', solo('Asha', 'asha@example.com')).expect(200);
    await submitRow(ctx, 'r2', solo('Bina', 'bina@example.com')).expect(200);
    await submitRow(ctx, 'r3', solo('Chetan')).expect(200); // no email
    await submitRow(ctx, 'r4', solo('Dev', 'dev@example.com')).expect(200);
  }

  // ---------- selection UI and permissions ----------

  it('1 + 3. admins get checkboxes, Select All and "Verify selected" on Pending; coordinators do not', async () => {
    await seed();
    const page = (await getAs(ctx, admin, '/admin/registrations?status=pending').expect(200)).text;
    expect(page).toContain('data-bulk-verify');
    expect(page).toContain('data-select-all');
    expect(page).toContain('Verify selected');
    for (const id of await ids('Asha', 'Bina', 'Chetan', 'Dev')) expect(page).toContain(`name="ids" value="${id}" form="bulk-verify"`);
    // Only on the Pending view.
    expect((await getAs(ctx, admin, '/admin/registrations').expect(200)).text).not.toContain('data-bulk-verify');
    expect((await getAs(ctx, coordinator, '/admin/registrations?status=pending').expect(200)).text).not.toContain('data-bulk-verify');
    // Admin-only navigation entry.
    expect((await getAs(ctx, admin, '/admin/registrations').expect(200)).text).toContain('>Verification log<');
    expect((await getAs(ctx, coordinator, '/admin/registrations').expect(200)).text).not.toContain('Verification log');
  });

  it('3 + 4. coordinators and volunteers cannot bulk verify or open the report (server-side)', async () => {
    await seed();
    const all = await ids('Asha', 'Bina');
    for (const who of [coordinator, volunteer]) {
      await bulk(who, all).expect(403);
      await getAs(ctx, who, '/admin/verification-report').expect(403);
    }
    expect(await ctx.prisma.registration.count({ where: { paymentStatus: PaymentStatus.VERIFIED } })).toBe(0);
    expect(await ctx.prisma.verificationBatch.count()).toBe(0);
    expect(await qrRows()).toHaveLength(0);
  });

  // ---------- verification = the normal Verify ----------

  it('2 + 5-9. verifies the selected rows exactly like Verify: VERIFIED, QR token, one QR email each, audit; no email -> no job', async () => {
    await seed();
    const [asha, bina, chetan] = await ids('Asha', 'Bina', 'Chetan');
    const res = await bulk(admin, [asha, bina, chetan]).expect(303);
    expect(res.headers.location).toMatch(/^\/admin\/verification-report\/[0-9a-f-]{36}$/);
    expect(flash(res)).toBe('Bulk verify: 3 selected, 3 verified, 0 skipped, 0 failed, 2 QR email(s) queued, 1 without email');

    for (const name of ['Asha', 'Bina', 'Chetan']) {
      const r = await reg(name);
      expect([name, r.paymentStatus, r.status, r.paymentReviewedById]).toEqual([name, PaymentStatus.VERIFIED, 'CONFIRMED', admin.id]);
      expect(r.paymentReviewedAt).not.toBeNull();
      expect(r.person.qrToken).toMatch(/^[\w-]{43}$/);
      const activity = await ctx.prisma.registrationActivity.findMany({ where: { registrationId: r.id, type: { in: [ActivityType.PAYMENT_VERIFIED, ActivityType.QR_EMAIL_QUEUED] } } });
      expect(activity.map((a) => [a.type, a.actorId]).sort()).toEqual(
        (r.person.email ? [[ActivityType.PAYMENT_VERIFIED, admin.id], [ActivityType.QR_EMAIL_QUEUED, admin.id]] : [[ActivityType.PAYMENT_VERIFIED, admin.id]]).sort(),
      );
    }
    // Exactly one QR email per participant with an email, to their current address, same key as Verify.
    const rows = await qrRows();
    expect(rows.map((r) => [r.toEmail, r.idempotencyKey, r.triggeredById]).sort()).toEqual(
      [
        ['asha@example.com', `qr-pass:${asha}:initial`, admin.id],
        ['bina@example.com', `qr-pass:${bina}:initial`, admin.id],
      ].sort(),
    );
    expect(await qrRows(chetan)).toHaveLength(0); // no invalid email job
    expect(await ctx.prisma.emailOutbox.count({ where: { template: EmailTemplate.RegistrationReceived } })).toBe(0);
    // Dev (not selected) is untouched.
    expect((await reg('Dev')).paymentStatus).toBe(PaymentStatus.PENDING);

    // 15 + 16. Same records as the individual Verify button produces.
    await postAs(ctx, admin, `/admin/registrations/${(await reg('Dev')).id}/verify`).expect(303);
    const [bulkRow] = await qrRows(asha);
    const [single] = await qrRows((await reg('Dev')).id);
    expect(Object.keys(bulkRow.payload as object).sort()).toEqual(Object.keys(single.payload as object).sort());
    expect([bulkRow.subject.replace('Asha', 'X'), bulkRow.template]).toEqual([single.subject.replace('Dev', 'X'), single.template]);
    expect((bulkRow.payload as { qrToken: string }).qrToken).toBe((await reg('Asha')).person.qrToken);
  });

  it('a selected team member verifies the whole form response (as Verify does); teammates are reported', async () => {
    await submitRow(ctx, 't1', {
      'Team Name': 'Smash', Sports: 'Badminton', 'College Name': 'NIT Patna',
      'Member 1 Name': 'Ira', 'Member 1 Email': 'ira@example.com', 'Member 2 Name': 'Jai', 'Member 2 Email': 'jai@example.com',
    }).expect(200);
    const res = await bulk(admin, await ids('Ira')).expect(303);
    expect(flash(res)).toContain('2 verified (incl. 1 teammate(s))');
    expect((await reg('Jai')).paymentStatus).toBe(PaymentStatus.VERIFIED);
    expect((await qrRows()).map((r) => r.toEmail).sort()).toEqual(['ira@example.com', 'jai@example.com']);
    const items = await ctx.prisma.verificationBatchItem.findMany({ orderBy: { personName: 'asc' } });
    expect(items.map((i) => [i.personName, i.selected, i.outcome])).toEqual([
      ['Ira', true, 'VERIFIED'],
      ['Jai', false, 'VERIFIED'],
    ]);
  });

  // ---------- safety ----------

  it('10. already verified, rejected, unknown and empty selections are handled without changing anything', async () => {
    await seed();
    const [asha, bina, chetan] = await ids('Asha', 'Bina', 'Chetan');
    await postAs(ctx, admin, `/admin/registrations/${asha}/verify`).expect(303); // verified individually
    await postAs(ctx, admin, `/admin/registrations/${bina}/reject`, { remarks: 'ID unreadable' }).expect(303);
    const tokenBefore = (await reg('Asha')).person.qrToken;
    const unknown = '00000000-0000-4000-8000-000000000000';
    const res = await bulk(admin, [asha, bina, chetan, unknown, 'not-a-uuid']).expect(303);
    expect(flash(res)).toBe('Bulk verify: 4 selected, 1 verified, 2 skipped, 1 failed, 0 QR email(s) queued, 1 without email');
    const items = await ctx.prisma.verificationBatchItem.findMany();
    const byReg = (id: string) => items.find((i) => i.registrationId === id)!;
    expect([byReg(asha).outcome, byReg(asha).reason]).toEqual(['SKIPPED', 'Already verified']);
    expect([byReg(bina).outcome, byReg(bina).reason]).toEqual(['SKIPPED', 'Rejected (not pending)']);
    expect(items.find((i) => i.registrationId === null)).toMatchObject({ outcome: 'FAILED', reason: `Registration ${unknown} not found` });
    expect((await reg('Bina')).paymentStatus).toBe(PaymentStatus.REJECTED); // never verified by bulk
    expect((await reg('Asha')).person.qrToken).toBe(tokenBefore);
    expect(await qrRows(asha)).toHaveLength(1); // still the one from the individual Verify
    // Nothing selected.
    const none = await postAs(ctx, admin, '/admin/registrations/bulk-verify', {}).expect(303);
    expect(flash(none)).toBe('No registrations selected');
  });

  it('a failure for one form response does not affect the others (and leaves it unchanged)', async () => {
    await submitRow(ctx, 'r1', solo('Kiran', 'kiran@example.com', { 'UTR Number': 'UTR777' })).expect(200);
    await submitRow(ctx, 'r2', solo('Lata', 'lata@example.com', { 'UTR Number': 'UTR777' })).expect(200); // same txn
    await submitRow(ctx, 'r3', solo('Mohan', 'mohan@example.com')).expect(200);
    await postAs(ctx, admin, `/admin/registrations/${(await reg('Kiran')).id}/verify`).expect(303);
    const res = await bulk(admin, await ids('Lata', 'Mohan')).expect(303);
    expect(flash(res)).toBe('Bulk verify: 2 selected, 1 verified, 0 skipped, 1 failed, 1 QR email(s) queued, 0 without email');
    const failed = await ctx.prisma.verificationBatchItem.findFirstOrThrow({ where: { outcome: 'FAILED' } });
    expect(failed.personName).toBe('Lata');
    expect(failed.reason).toMatch(/^Transaction UTR777 is already verified for team/);
    const lata = await reg('Lata');
    expect([lata.paymentStatus, lata.person.qrToken]).toEqual([PaymentStatus.PENDING, null]); // untouched
    expect((await reg('Mohan')).paymentStatus).toBe(PaymentStatus.VERIFIED);
  });

  it('11. double submits, two admins and an individual Verify at once: one QR token and one QR email per participant', async () => {
    await seed();
    const admin2 = await staff(ctx, StaffRole.ADMIN, 'admin2@staff.test');
    const selected = await ids('Asha', 'Bina', 'Dev');
    await Promise.all([
      bulk(admin, selected),
      bulk(admin, selected), // double click
      bulk(admin2, selected),
      postAs(ctx, admin, `/admin/registrations/${selected[0]}/verify`),
    ]);
    for (const id of selected) {
      expect(await qrRows(id)).toHaveLength(1);
      expect(await ctx.prisma.registrationActivity.count({ where: { registrationId: id, type: ActivityType.PAYMENT_VERIFIED } })).toBe(1);
    }
    const tokens = (await ctx.prisma.person.findMany({ where: { qrToken: { not: null } } })).map((p) => p.qrToken);
    expect(new Set(tokens).size).toBe(tokens.length);
    // Across all runs each registration was verified once; the rest were skipped.
    const verifiedItems = await ctx.prisma.verificationBatchItem.findMany({ where: { outcome: 'VERIFIED' } });
    expect(verifiedItems.filter((i) => selected.includes(i.registrationId!)).length).toBeLessThanOrEqual(3);
    expect(await ctx.prisma.registration.count({ where: { paymentStatus: PaymentStatus.VERIFIED } })).toBe(3);
  });

  it('accepts the form exactly as a browser sends it (repeated ids fields)', async () => {
    await seed();
    const [asha, bina] = await ids('Asha', 'Bina');
    const res = await ctx.http
      .post('/admin/registrations/bulk-verify')
      .set('Cookie', admin.cookie)
      .type('form')
      .send(`_csrf=${encodeURIComponent(admin.csrf)}&ids=${asha}&ids=${bina}&back=${encodeURIComponent('/admin/registrations?status=pending')}`)
      .expect(303);
    expect(flash(res)).toMatch(/^Bulk verify: 2 selected, 2 verified/);
  });

  // ---------- report ----------

  it('12-14. the report shows totals and every participant with live email status (queued, sent, failed, no email)', async () => {
    await seed();
    const res = await bulk(admin, await ids('Asha', 'Bina', 'Chetan')).expect(303);
    const batchId = batchIdFrom(res.headers.location);

    let detail = (await getAs(ctx, admin, `/admin/verification-report/${batchId}`).expect(200)).text;
    expect(detail.match(/<span class="badge badge-warn">Queued<\/span>/g)).toHaveLength(2);
    expect(detail).toContain('No email address');

    const fake = fakeTransport(['bina@example.com']);
    try {
      await ctx.worker.processBatch();
    } finally {
      fake.restore();
    }
    expect((await qrRows()).map((r) => [r.toEmail, r.status]).sort()).toEqual([
      ['asha@example.com', EmailStatus.SENT],
      ['bina@example.com', EmailStatus.FAILED],
    ]);

    detail = (await getAs(ctx, admin, `/admin/verification-report/${batchId}`).expect(200)).text;
    for (const shown of ['Asha', 'Bina', 'Chetan', 'asha@example.com', 'bina@example.com', 'Table Tennis', 'Sent (accepted by mail server)', 'Failed', '550 5.1.1 mailbox does not exist', 'No email address', 'by admin']) {
      expect([shown, detail.includes(shown)]).toEqual([shown, true]);
    }
    expect(detail).not.toContain('badge-ok">Delivered<'); // SMTP/console cannot confirm delivery
    const tile = (text: string, label: string) => Number(text.match(new RegExp(`<div class="label">${label}</div><div class="value">(\\d+)</div>`))?.[1]);
    expect([tile(detail, 'Selected'), tile(detail, 'Verified'), tile(detail, 'Failed'), tile(detail, 'QR emails queued'), tile(detail, 'Emails sent'), tile(detail, 'Email failures'), tile(detail, 'No email')]).toEqual([3, 3, 0, 2, 1, 1, 1]);

    // Today's list (default) contains the run with the same totals; other dates do not.
    const today = (await getAs(ctx, admin, '/admin/verification-report').expect(200)).text;
    expect(today).toContain(`/admin/verification-report/${batchId}`);
    expect([tile(today, 'Selected'), tile(today, 'Emails sent'), tile(today, 'Email failures'), tile(today, 'No email')]).toEqual([3, 1, 1, 1]);
    const past = (await getAs(ctx, admin, '/admin/verification-report?from=2020-01-01&to=2020-01-31').expect(200)).text;
    expect(past).toContain('No bulk verifications in this period.');
    await getAs(ctx, admin, '/admin/verification-report/00000000-0000-4000-8000-000000000000').expect(404);
  });
});
