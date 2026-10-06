import { ActivityType, EntryKind, EntryStatus, PaymentStatus, StaffRole } from '@prisma/client';
import { EmailTemplate } from '../src/emails/email-templates';
import { Ctx, Staff, flash, getAs, postAs, resetDatabase, staff, startApp, submitRow } from './e2e-helpers';

/**
 * Change 1: email is optional ("Email Address" first, then "Email"); emails are queued only
 * once an address exists, never twice. Change 2: the "Ever entered" list (first successful
 * gate IN, permanent) next to the unchanged Inside / Outside lists.
 */
describe('Optional email and Ever entered (e2e)', () => {
  let ctx: Ctx;
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
    coordinator = await staff(ctx, StaffRole.COORDINATOR);
    volunteer = await staff(ctx, StaffRole.VOLUNTEER);
  });

  const row = (name: string, emails: { 'Email Address'?: string; Email?: string } = {}, extra: Record<string, string> = {}) => ({
    ...emails,
    Name: name,
    'College Name': 'NIT Patna',
    Sports: 'Table Tennis',
    'Mobile No.': '9876500000',
    ...extra,
  });

  /** As the Apps Script sends it: the sheet's "Email Address" column arrives as respondentEmail. */
  const submitWithRespondent = (responseId: string, respondentEmail: string, answers: Record<string, string>) =>
    ctx.http
      .post('/webhooks/forms/submit')
      .set('X-Webhook-Secret', 'e2e-webhook-secret')
      .send({ sourceForm: 'sheet-e2e', sourceRow: 2, responseId, respondentEmail, answers });

  const regOf = (name: string) =>
    ctx.prisma.registration.findFirstOrThrow({ where: { person: { name } }, include: { person: true } });
  const verify = async (name: string) => postAs(ctx, coordinator, `/admin/registrations/${(await regOf(name)).id}/verify`).expect(303);
  const changeEmail = async (name: string, email: string, who: Staff = coordinator) =>
    postAs(ctx, who, `/admin/registrations/${(await regOf(name)).id}/change-email`, { email });
  const outbox = (template?: string) =>
    ctx.prisma.emailOutbox.findMany({ where: template ? { template } : {}, orderBy: { createdAt: 'asc' } });

  // ================= Change 1: optional email =================

  describe('email priority', () => {
    it('1. "Email Address" present -> used (as an answer, and as the collected column)', async () => {
      await submitRow(ctx, 'r1', row('Asha', { 'Email Address': 'a@gmail.com', Email: 'b@gmail.com' })).expect(200);
      expect((await regOf('Asha')).person.email).toBe('a@gmail.com');
      await submitWithRespondent('r2', 'c@gmail.com', row('Bina', { Email: 'd@gmail.com' })).expect(200);
      expect((await regOf('Bina')).person.email).toBe('c@gmail.com');
      await submitRow(ctx, 'r3', row('Chetan', { 'Email Address': 'e@gmail.com' })).expect(200);
      expect((await regOf('Chetan')).person.email).toBe('e@gmail.com');
      // The form import itself sends no email.
      expect(await outbox()).toHaveLength(0);
    });

    it('importing, resyncing and editing a response never queues a "registration received" email', async () => {
      await submitRow(ctx, 'r1', row('Asha', { 'Email Address': 'asha@gmail.com' })).expect(200); // new
      await submitRow(ctx, 'r1', row('Asha', { 'Email Address': 'asha@gmail.com' })).expect(200); // resync
      await submitRow(ctx, 'r1', row('Asha', { 'Email Address': 'asha@gmail.com' }, { Sports: 'Table Tennis, Chess' })).expect(200); // edited
      const team = {
        'Team Name': 'Smash', Sports: 'Badminton', 'College Name': 'NIT Patna',
        'Member 1 Name': 'Bina', 'Member 1 Email': 'bina@gmail.com', 'Member 2 Name': 'Chetan', 'Member 2 Email': 'chetan@gmail.com',
      };
      const res = await submitRow(ctx, 't1', team).expect(200);
      expect(res.body).toMatchObject({ ok: true, queuedEmails: 0 });
      expect(await ctx.prisma.registration.count()).toBe(4);
      expect(await outbox(EmailTemplate.RegistrationReceived)).toHaveLength(0);
      expect(await outbox()).toHaveLength(0);
    });

    it('2. "Email Address" empty -> "Email" is used', async () => {
      await submitRow(ctx, 'r1', row('Asha', { 'Email Address': '', Email: 'b@gmail.com' })).expect(200);
      expect((await regOf('Asha')).person.email).toBe('b@gmail.com');
      await submitWithRespondent('r2', '', row('Bina', { Email: 'd@gmail.com' })).expect(200);
      expect((await regOf('Bina')).person.email).toBe('d@gmail.com');
    });

    it('3. both empty -> the registration still succeeds, with no email and no email job', async () => {
      const res = await submitRow(ctx, 'r1', row('Asha', { 'Email Address': '', Email: '' })).expect(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.warnings.join(' ')).toMatch(/no email/);
      const reg = await regOf('Asha');
      expect(reg.person.email).toBeNull();
      expect(reg.paymentStatus).toBe(PaymentStatus.PENDING);
      expect(await outbox()).toHaveLength(0);
      // Listed in the dashboard and searchable like everyone else.
      const list = (await getAs(ctx, coordinator, '/admin/registrations?q=Asha').expect(200)).text;
      expect(list).toContain(`/admin/registrations/${reg.id}`);
      const page = (await getAs(ctx, coordinator, `/admin/registrations/${reg.id}`).expect(200)).text;
      expect(page).toContain('No email');
    });
  });

  describe('email and verification', () => {
    it('4. no email + verify -> verified with a QR token, but no email is queued', async () => {
      await submitRow(ctx, 'r1', row('Asha')).expect(200);
      const res = await verify('Asha');
      expect(flash(res)).toMatch(/1 without an email/);
      const reg = await regOf('Asha');
      expect(reg.paymentStatus).toBe(PaymentStatus.VERIFIED);
      expect(reg.person.qrToken).toBeTruthy();
      expect(await outbox()).toHaveLength(0);
      // Sending the pass by hand explains why it cannot go out (nothing queued).
      expect(flash(await postAs(ctx, coordinator, `/admin/registrations/${reg.id}/resend-qr`))).toMatch(/no email yet/);
      expect(await outbox()).toHaveLength(0);
      // ...and the participant can use the gate.
      expect(flash(await postAs(ctx, volunteer, `/p/${reg.person.qrToken}/enter`, { registrationId: reg.id }))).toMatch(/^✅ ENTERED/);
    });

    it('5 + 10. verified, no email, email added -> only the QR email to it; same QR token', async () => {
      await submitRow(ctx, 'r1', row('Asha')).expect(200);
      await verify('Asha');
      const before = await regOf('Asha');

      const res = await changeEmail('Asha', 'Asha.New@Gmail.com');
      expect(flash(res)).toBe('Email added: asha.new@gmail.com. Queued 1 QR pass email(s).');

      const after = await regOf('Asha');
      expect(after.person.id).toBe(before.person.id);
      expect(after.person.email).toBe('asha.new@gmail.com');
      expect(after.person.qrToken).toBe(before.person.qrToken); // never regenerated
      expect(after.paymentStatus).toBe(PaymentStatus.VERIFIED);
      const mails = await outbox();
      expect(mails.map((m) => [m.template, m.toEmail])).toEqual([[EmailTemplate.QrPass, 'asha.new@gmail.com']]);
      const qr = mails.find((m) => m.template === EmailTemplate.QrPass)!;
      expect(qr.idempotencyKey).toBe(`qr-pass:${after.id}:initial`);
      expect((qr.payload as { qrToken: string }).qrToken).toBe(before.person.qrToken);
      const activity = await ctx.prisma.registrationActivity.findMany({ where: { registrationId: after.id }, orderBy: { createdAt: 'asc' } });
      expect(activity.map((a) => a.type)).toEqual(
        expect.arrayContaining([ActivityType.EMAIL_CHANGED, ActivityType.QR_EMAIL_QUEUED]),
      );

      // Changing that email again later sends nothing new (existing behaviour); alias kept.
      expect(flash(await changeEmail('Asha', 'asha.third@gmail.com'))).toMatch(/^Email changed from asha.new@gmail.com to asha.third@gmail.com/);
      expect(await outbox()).toHaveLength(1);
      expect((await regOf('Asha')).person.qrToken).toBe(before.person.qrToken);
    });

    it('6 + 7. pending, no email, email added -> no email yet; verification then sends only the QR email', async () => {
      await submitRow(ctx, 'r1', row('Asha')).expect(200);
      expect(flash(await changeEmail('Asha', 'asha@gmail.com'))).toBe(
        'Email added: asha@gmail.com. The QR pass is emailed once the registration is verified.',
      );
      expect(await outbox()).toHaveLength(0);

      await verify('Asha');
      expect((await outbox()).map((m) => [m.template, m.toEmail])).toEqual([[EmailTemplate.QrPass, 'asha@gmail.com']]);
      expect(await outbox(EmailTemplate.RegistrationReceived)).toHaveLength(0);
    });

    it('the reported case: imported without email, email added, then Verify (individual or bulk) -> exactly one QR email, no "registration received"', async () => {
      const admin = await staff(ctx, StaffRole.ADMIN);
      await submitRow(ctx, 'r1', row('Asha')).expect(200);
      await submitRow(ctx, 'r2', row('Bina')).expect(200);
      expect(await outbox()).toHaveLength(0); // import: nothing
      await changeEmail('Asha', 'asha@gmail.com');
      await changeEmail('Bina', 'bina@gmail.com');
      expect(await outbox()).toHaveLength(0); // email added while pending: nothing
      await verify('Asha'); // individual Verify
      await postAs(ctx, admin, '/admin/registrations/bulk-verify', { ids: [(await regOf('Bina')).id] } as never).expect(303); // bulk
      const mails = await outbox();
      expect(mails.map((m) => [m.template, m.toEmail]).sort()).toEqual([
        [EmailTemplate.QrPass, 'asha@gmail.com'],
        [EmailTemplate.QrPass, 'bina@gmail.com'],
      ]);
      expect(await ctx.prisma.emailOutbox.count({ where: { template: EmailTemplate.RegistrationReceived } })).toBe(0);
    });

    it('8. existing email + verification -> QR email as before', async () => {
      await submitRow(ctx, 'r1', row('Asha', { 'Email Address': 'asha@gmail.com' })).expect(200);
      await verify('Asha');
      const qr = await outbox(EmailTemplate.QrPass);
      expect(qr.map((m) => [m.toEmail, m.idempotencyKey])).toEqual([['asha@gmail.com', `qr-pass:${(await regOf('Asha')).id}:initial`]]);
      expect(await outbox(EmailTemplate.RegistrationReceived)).toHaveLength(0); // none on import
    });

    it('9. resyncs of a no-email row never create another person (before and after Change email)', async () => {
      await submitRow(ctx, 'r1', row('Asha')).expect(200);
      await submitRow(ctx, 'r1', row('Asha')).expect(200);
      expect(await ctx.prisma.person.count()).toBe(1);
      await verify('Asha');
      const token = (await regOf('Asha')).person.qrToken;
      await changeEmail('Asha', 'asha@gmail.com');
      await submitRow(ctx, 'r1', row('Asha')).expect(200); // the sheet row still has no email
      await submitRow(ctx, 'r1', row('Asha', { Email: 'other@gmail.com' })).expect(200); // staff email wins
      expect(await ctx.prisma.person.count()).toBe(1);
      expect(await ctx.prisma.registration.count()).toBe(1);
      const reg = await regOf('Asha');
      expect(reg.person.email).toBe('asha@gmail.com');
      expect(reg.person.qrToken).toBe(token);
      expect(reg.paymentStatus).toBe(PaymentStatus.VERIFIED);
      expect((await outbox()).map((m) => m.template)).toEqual([EmailTemplate.QrPass]); // the QR email, once
    });

    it('9b. a resynced row that now carries an email gives it to the same person; only the QR email is queued', async () => {
      await submitRow(ctx, 'r1', row('Asha')).expect(200);
      await verify('Asha');
      const before = await regOf('Asha');
      await submitRow(ctx, 'r1', row('Asha', { Email: 'asha@gmail.com' })).expect(200);
      await submitRow(ctx, 'r1', row('Asha', { Email: 'asha@gmail.com' })).expect(200);
      const after = await regOf('Asha');
      expect(await ctx.prisma.person.count()).toBe(1);
      expect(after.person.id).toBe(before.person.id);
      expect(after.person.email).toBe('asha@gmail.com');
      expect(after.person.qrToken).toBe(before.person.qrToken);
      expect((await outbox()).map((m) => m.template)).toEqual([EmailTemplate.QrPass]); // no "registration received" on import
    });

    it('11. duplicate clicks / webhooks / verifications cannot queue duplicate emails', async () => {
      await submitRow(ctx, 'r1', row('Asha')).expect(200);
      await verify('Asha');
      const id = (await regOf('Asha')).id;
      const clicks = await Promise.all(
        Array.from({ length: 5 }, () => postAs(ctx, coordinator, `/admin/registrations/${id}/change-email`, { email: 'asha@gmail.com' })),
      );
      expect(clicks.every((r) => r.status === 303)).toBe(true);
      await Promise.all(Array.from({ length: 3 }, () => submitRow(ctx, 'r1', row('Asha', { Email: 'asha@gmail.com' }))));
      await Promise.all(Array.from({ length: 3 }, () => postAs(ctx, coordinator, `/admin/registrations/${id}/verify`)));
      expect(await outbox(EmailTemplate.RegistrationReceived)).toHaveLength(0);
      expect(await outbox(EmailTemplate.QrPass)).toHaveLength(1);
      expect(await ctx.prisma.person.count()).toBe(1);
    });

    it('volunteers keep their existing Change email access at the gate; the old (empty) email is shown as such', async () => {
      await submitRow(ctx, 'r1', row('Asha')).expect(200);
      await verify('Asha');
      const reg = await regOf('Asha');
      const card = (await getAs(ctx, volunteer, `/p/${reg.person.qrToken}`).expect(200)).text;
      expect(card).toContain('No email');
      const res = await postAs(ctx, volunteer, `/gate/${reg.id}/change-email`, { email: 'asha@gmail.com' }).expect(303);
      expect(flash(res)).toMatch(/^Email added: asha@gmail.com/);
      expect(await outbox(EmailTemplate.QrPass)).toHaveLength(1);
    });
  });

  // ================= Change 2: Ever entered =================

  describe('Ever entered', () => {
    async function lists() {
      const view = async (status: string) => {
        const text = (await getAs(ctx, coordinator, `/admin/registrations?status=${status}`).expect(200)).text;
        return [...text.matchAll(/<tr data-href="\/admin\/registrations\/[0-9a-f-]+">\s*<td><a href="[^"]+">([^<]+)<\/a>/g)].map((m) => m[1]).sort();
      };
      const text = (await getAs(ctx, coordinator, '/admin/registrations').expect(200)).text;
      const counters: Record<string, number> = {};
      for (const m of text.matchAll(/<div class="label">([^<]+)<\/div><div class="value">(\d+)<\/div>/g)) counters[m[1]] = Number(m[2]);
      return { inside: await view('inside'), outside: await view('outside'), entered: await view('entered'), counters };
    }
    const qr = async (name: string, action: 'enter' | 'exit') => {
      const r = await regOf(name);
      return postAs(ctx, volunteer, `/p/${r.person.qrToken}/${action}`, { registrationId: r.id });
    };

    beforeEach(async () => {
      await submitRow(ctx, 'r1', row('Asha', { 'Email Address': 'asha@gmail.com' }, { 'Check In Date': '2026-10-04' })).expect(200);
      await submitRow(ctx, 'r2', row('Bina', { 'Email Address': 'bina@gmail.com' })).expect(200);
      await verify('Asha');
      await verify('Bina');
    });

    it('1 + 6 + 7 + 8. new / verified / expected-date / QR-holding participants are not Ever entered', async () => {
      const asha = await regOf('Asha');
      expect(asha.person.qrToken).toBeTruthy(); // QR generated
      expect(asha.expectedArrivalDate).not.toBeNull(); // planned Check In Date
      const l = await lists();
      expect(l.entered).toEqual([]);
      expect(l.counters['Ever entered']).toBe(0);
      expect(l.outside).toEqual(['Asha', 'Bina']);
      expect(l.inside).toEqual([]);
      // Expected arrival "today" (Arrivals) is a different concept and stays as it was.
      const arrivals = (await getAs(ctx, coordinator, '/admin/arrivals?date=2026-10-04').expect(200)).text;
      expect(arrivals).toContain('Asha');
    });

    it('2-5. IN -> OUT -> IN -> OUT: Inside/Outside follow the current state, Ever entered keeps one row', async () => {
      const step = async (action: 'enter' | 'exit', expected: { inside: string[]; outside: string[] }) => {
        expect((await qr('Asha', action)).status).toBe(303);
        const l = await lists();
        expect([action, l.inside, l.outside, l.entered]).toEqual([action, expected.inside, expected.outside, ['Asha']]);
        expect(l.counters['Ever entered']).toBe(1);
        expect(l.counters.Inside + l.counters.Outside).toBe(l.counters.Total);
      };
      await step('enter', { inside: ['Asha'], outside: ['Bina'] });
      const first = (await regOf('Asha')).enteredAt;
      await step('exit', { inside: [], outside: ['Asha', 'Bina'] });
      await step('enter', { inside: ['Asha'], outside: ['Bina'] });
      await step('exit', { inside: [], outside: ['Asha', 'Bina'] });
      expect((await regOf('Asha')).enteredAt).toEqual(first); // first entry kept, never moved

      // 10. The Gate log still records every IN and OUT.
      const logs = await ctx.prisma.entryLog.findMany({ where: { status: EntryStatus.ENTERED }, orderBy: { enteredAt: 'asc' } });
      expect(logs.map((l) => l.kind)).toEqual([EntryKind.CHECK_IN, EntryKind.CHECK_OUT, EntryKind.CHECK_IN, EntryKind.CHECK_OUT]);
      const gateLog = (await getAs(ctx, coordinator, '/admin/entries').expect(200)).text;
      expect(gateLog.match(/Asha/g)?.length).toBeGreaterThanOrEqual(4);

      // The list shows the first-entry details and filters/search like the others.
      const text = (await getAs(ctx, coordinator, '/admin/registrations?status=entered&event=table-tennis&q=asha').expect(200)).text;
      expect(text).toContain('first in');
      expect(text).toContain('Ever entered');
      const none = (await getAs(ctx, coordinator, '/admin/registrations?status=entered&q=bina').expect(200)).text;
      expect(none).toContain('No registrations are <b>ever entered</b>');
    });

    it('9. concurrent IN attempts: one IN recorded, one Ever entered row', async () => {
      const results = await Promise.all(Array.from({ length: 6 }, () => qr('Asha', 'enter')));
      expect(results.filter((r) => /^✅ ENTERED/.test(flash(r) ?? ''))).toHaveLength(1);
      expect(await ctx.prisma.entryLog.count({ where: { kind: EntryKind.CHECK_IN, status: EntryStatus.ENTERED } })).toBe(1);
      const l = await lists();
      expect(l.entered).toEqual(['Asha']);
      expect(l.counters['Ever entered']).toBe(1);
    });

    it('blocked participants still cannot enter (and so do not become Ever entered); a participant without email can', async () => {
      await postAs(ctx, coordinator, `/admin/registrations/${(await regOf('Bina')).id}/block`, { reason: 'test' }).expect(303);
      expect(flash(await qr('Bina', 'enter'))).toMatch(/BLOCKED/);
      await submitRow(ctx, 'r3', row('Chetan')).expect(200);
      await verify('Chetan');
      expect((await qr('Chetan', 'enter')).status).toBe(303);
      expect((await lists()).entered).toEqual(['Chetan']);
    });

    it('is in the Admin/Coordinator navigation only; volunteers neither see nor reach it', async () => {
      const nav = (await getAs(ctx, coordinator, '/admin/registrations?status=entered').expect(200)).text;
      expect(nav).toContain('href="/admin/registrations?status=entered" class="active">Ever entered<');
      const volunteerNav = (await getAs(ctx, volunteer, '/scan').expect(200)).text;
      expect(volunteerNav).not.toContain('Ever entered');
      await getAs(ctx, volunteer, '/admin/registrations?status=entered').expect(403);
    });
  });
});
