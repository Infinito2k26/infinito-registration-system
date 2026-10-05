import { EntryKind, EntryStatus, PaymentStatus, Prisma, StaffRole } from '@prisma/client';
import jsQR from 'jsqr';
import { DriveService } from '../src/drive/drive.service';
import { EmailTemplate, renderEmail } from '../src/emails/email-templates';
import { DUPLICATE_EMAIL_MESSAGE } from '../src/registrations/participants.service';
import { Ctx, Staff, flash, getAs, postAs, resetDatabase, staff, startApp, submitRow } from './e2e-helpers';

// pngjs ships with the qrcode library (no types of its own); only used here to read QR images back.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { PNG } = require('pngjs') as { PNG: { sync: { read(png: Buffer): { width: number; height: number; data: Buffer } } } };
const decodeQr = (png: Buffer) => {
  const image = PNG.sync.read(png);
  return jsQR(new Uint8ClampedArray(image.data), image.width, image.height)?.data;
};

/**
 * 1. Email optional, but one email = one participant (case-insensitive, race-safe).
 * 2. QR codes contain only the raw token; the signed-in scanner looks everything up.
 * 3. Volunteers see the full participant details (incl. full Aadhaar), signed in only.
 */
describe('Unique email, token-only QR and volunteer details (e2e)', () => {
  let ctx: Ctx;
  let coordinator: Staff;
  let volunteer: Staff;
  let restoreDrive: () => void;

  beforeAll(async () => {
    ctx = await startApp();
    // A fake Drive so document routes can return 200; the access checks in front are the real ones.
    const drive = ctx.app.get(DriveService);
    const fetchFile = drive.fetchFile.bind(drive);
    Object.defineProperty(drive, 'enabled', { configurable: true, get: () => true });
    drive.fetchFile = () => Promise.resolve({ contentType: 'image/png', data: Buffer.from('fake-image') });
    restoreDrive = () => {
      delete (drive as unknown as Record<string, unknown>).enabled;
      drive.fetchFile = fetchFile;
    };
  });
  afterAll(async () => {
    restoreDrive();
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
  const regOf = (name: string) =>
    ctx.prisma.registration.findFirstOrThrow({ where: { person: { name } }, include: { person: true } });
  const changeEmail = async (name: string, email: string, who: Staff = coordinator) =>
    postAs(ctx, who, `/admin/registrations/${(await regOf(name)).id}/change-email`, { email });
  const verify = async (name: string) => postAs(ctx, coordinator, `/admin/registrations/${(await regOf(name)).id}/verify`).expect(303);

  // ================= 1. One email = one participant =================

  describe('email: optional, unique, case-insensitive', () => {
    it('1 + 9. participants without an email are created and stay valid (several can coexist)', async () => {
      await submitRow(ctx, 'r1', row('Asha')).expect(200);
      await submitRow(ctx, 'r2', row('Bina', { 'Email Address': '', Email: '' })).expect(200);
      const people = await ctx.prisma.person.findMany({ orderBy: { name: 'asc' } });
      expect(people.map((p) => [p.name, p.email])).toEqual([
        ['Asha', null],
        ['Bina', null],
      ]);
      await verify('Asha');
      expect((await regOf('Asha')).paymentStatus).toBe(PaymentStatus.VERIFIED);
      // Adding emails later still works, and each address is unique.
      expect(flash(await changeEmail('Asha', 'asha@gmail.com'))).toMatch(/^Email added: asha@gmail.com/);
      expect(flash(await changeEmail('Bina', 'ASHA@gmail.com'))).toBe(DUPLICATE_EMAIL_MESSAGE);
      expect((await regOf('Bina')).person.email).toBeNull();
    });

    it('2 + 3. a unique email creates one participant; the same email never creates a second one', async () => {
      await submitRow(ctx, 'r1', row('Asha', { 'Email Address': 'asha@gmail.com' })).expect(200);
      await submitRow(ctx, 'r2', row('Asha', { 'Email Address': 'asha@gmail.com' }, { Sports: 'Chess' })).expect(200);
      expect(await ctx.prisma.person.count()).toBe(1);
      expect(await ctx.prisma.registration.count()).toBe(2); // same participant, two events
    });

    it('4. uniqueness is case-insensitive, in the application and in the database itself', async () => {
      await submitRow(ctx, 'r1', row('Asha', { 'Email Address': 'Test@gmail.com' })).expect(200);
      await submitRow(ctx, 'r2', row('Asha', { 'Email Address': 'TEST@GMAIL.COM' }, { Sports: 'Chess' })).expect(200);
      await submitRow(ctx, 'r3', row('Asha', { Email: 'test@gmail.com' }, { Sports: 'Football' })).expect(200);
      expect((await ctx.prisma.person.findMany()).map((p) => p.email)).toEqual(['test@gmail.com']);
      // Even a write that bypasses the application cannot add a case variant.
      await expect(ctx.prisma.person.create({ data: { email: 'TEST@gmail.com', name: 'Other' } })).rejects.toMatchObject({ code: 'P2002' });
    });

    it('5. "Email Address" has priority over "Email"', async () => {
      await submitRow(ctx, 'r1', row('Asha', { 'Email Address': 'first@gmail.com', Email: 'second@gmail.com' })).expect(200);
      expect((await regOf('Asha')).person.email).toBe('first@gmail.com');
      await submitRow(ctx, 'r2', row('Bina', { 'Email Address': '', Email: 'second@gmail.com' })).expect(200);
      expect((await regOf('Bina')).person.email).toBe('second@gmail.com');
    });

    it('6. Change Email to an unused address succeeds (same participant, QR token and status)', async () => {
      await submitRow(ctx, 'r1', row('Asha', { 'Email Address': 'asha@gmail.com' })).expect(200);
      await verify('Asha');
      const before = await regOf('Asha');
      expect(flash(await changeEmail('Asha', 'Asha.New@Gmail.com'))).toMatch(/^Email changed from asha@gmail.com to asha.new@gmail.com/);
      const after = await regOf('Asha');
      expect(after.person).toMatchObject({ id: before.person.id, email: 'asha.new@gmail.com', qrToken: before.person.qrToken });
      expect(after.paymentStatus).toBe(PaymentStatus.VERIFIED);
    });

    it("7 + 8. Change Email to another participant's email (any case) fails and changes nothing", async () => {
      await submitRow(ctx, 'r1', row('Asha', { 'Email Address': 'asha@gmail.com' })).expect(200);
      await submitRow(ctx, 'r2', row('Bina', { 'Email Address': 'bina@gmail.com' })).expect(200);
      for (const taken of ['bina@gmail.com', 'BINA@Gmail.com', ' Bina@gmail.com ']) {
        expect(flash(await changeEmail('Asha', taken))).toBe(DUPLICATE_EMAIL_MESSAGE);
        expect((await changeEmail('Asha', taken, volunteer)).status).toBe(403); // volunteers use the gate route
        expect(flash(await postAs(ctx, volunteer, `/gate/${(await regOf('Asha')).id}/change-email`, { email: taken }))).toBe(DUPLICATE_EMAIL_MESSAGE);
      }
      expect((await regOf('Asha')).person.email).toBe('asha@gmail.com');
      expect((await regOf('Bina')).person.email).toBe('bina@gmail.com');
      expect(await ctx.prisma.registrationActivity.count({ where: { type: 'EMAIL_CHANGED' } })).toBe(0);
    });

    it('10. concurrent registrations and Change Emails cannot give one email to two participants', async () => {
      // Same new email in several form rows at once: one participant; losers get the retry answer.
      const results = await Promise.all(
        ['r1', 'r2', 'r3', 'r4'].map((id, i) => submitRow(ctx, id, row('Asha', { 'Email Address': i % 2 ? 'RACE@gmail.com' : 'race@gmail.com' }))),
      );
      expect(results.every((r) => r.status === 200 || r.status === 503)).toBe(true);
      expect(await ctx.prisma.person.count({ where: { email: { equals: 'race@gmail.com', mode: Prisma.QueryMode.insensitive } } })).toBe(1);

      // Two different participants changed to the same email at the same moment: exactly one wins.
      await submitRow(ctx, 'c1', row('Chetan')).expect(200);
      await submitRow(ctx, 'd1', row('Divya', { 'Email Address': 'divya@gmail.com' })).expect(200);
      const [c, d] = [await regOf('Chetan'), await regOf('Divya')];
      const clash = await Promise.all([
        postAs(ctx, coordinator, `/admin/registrations/${c.id}/change-email`, { email: 'same@gmail.com' }),
        postAs(ctx, volunteer, `/gate/${d.id}/change-email`, { email: 'SAME@gmail.com' }),
      ]);
      expect(clash.map((r) => r.status)).toEqual([303, 303]); // no server error
      expect(clash.map(flash).filter((t) => t === DUPLICATE_EMAIL_MESSAGE)).toHaveLength(1);
      expect(await ctx.prisma.person.count({ where: { email: 'same@gmail.com' } })).toBe(1);
      const loser = (await regOf('Chetan')).person.email === 'same@gmail.com' ? 'Divya' : 'Chetan';
      expect((await regOf(loser)).person.email).toBe(loser === 'Divya' ? 'divya@gmail.com' : null);
    });
  });

  // ================= 2. Token-only QR =================

  describe('QR: only the raw token', () => {
    let reg: Awaited<ReturnType<typeof regOf>>;
    let token: string;
    beforeEach(async () => {
      await submitRow(ctx, 'r1', row('Asha', { 'Email Address': 'asha@gmail.com' }, { 'College Roll No.': '2201CS42', 'Aadhaar No.': '1234 5678 9012' })).expect(200);
      await verify('Asha');
      reg = await regOf('Asha');
      token = reg.person.qrToken!;
    });
    const enter = (t: string, registrationId = reg.id) => postAs(ctx, volunteer, `/p/${t}/enter`, { registrationId });
    const exit = (t: string, registrationId = reg.id) => postAs(ctx, volunteer, `/p/${t}/exit`, { registrationId });

    it('11-13. the emailed QR decodes to exactly the 43-character token: no URL, domain or personal data', async () => {
      expect(token).toMatch(/^[\w-]{43}$/); // 32 random bytes, base64url
      const row = await ctx.prisma.emailOutbox.findFirstOrThrow({ where: { template: EmailTemplate.QrPass } });
      const email = await renderEmail(row.template!, row.payload as Record<string, unknown>);
      const content = decodeQr(email.attachments![0].content)!;
      expect(content).toBe(token);
      expect(content).not.toMatch(/https?:|e2e\.test|sirvihostelpali|\/p\//);
      for (const personal of ['Asha', 'asha@gmail.com', 'NIT', '9876500000', '2201CS42', '9012', reg.id, reg.personId]) {
        expect([personal, content.includes(personal)]).toEqual([personal, false]);
      }
      expect(email.text).not.toContain('http');
    });

    it('14 + 21. the scanner accepts the raw token, and old URL-format passes still work', async () => {
      for (const code of [token, `  ${token}  `, `https://sirvihostelpali.com/p/${token}`, `http://e2e.test/p/${token}`]) {
        const res = await getAs(ctx, volunteer, `/scan/go?code=${encodeURIComponent(code)}`).expect(303);
        expect([code, res.headers.location]).toEqual([code, `/p/${token}`]);
      }
      const card = (await getAs(ctx, volunteer, `/p/${token}`).expect(200)).text;
      expect(card).toContain('<h1>Asha</h1>');
      expect(card).toContain('MARK ENTERED (CHECK IN)');
    });

    it('15. an invalid token is rejected', async () => {
      const bad = await getAs(ctx, volunteer, `/scan/go?code=${encodeURIComponent('not a pass!')}`).expect(303);
      expect([bad.headers.location, flash(bad)]).toEqual(['/scan', 'That is not an Infinito pass code']);
      const unknown = 'A'.repeat(43);
      expect((await getAs(ctx, volunteer, `/p/${unknown}`).expect(404)).text).toContain('INVALID QR');
      expect(flash(await enter(unknown))).toBe('INVALID QR: registration not found for this pass');
      expect(await ctx.prisma.entryLog.count({ where: { status: EntryStatus.ENTERED } })).toBe(0);
    });

    it('16. an unverified participant is rejected (token kept from an undone verification)', async () => {
      await postAs(ctx, coordinator, `/admin/registrations/${reg.id}/undo`).expect(303);
      expect((await regOf('Asha')).paymentStatus).toBe(PaymentStatus.PENDING);
      expect(flash(await enter(token))).toBe('NOT VERIFIED. Do not admit.');
      expect((await regOf('Asha')).insideSince).toBeNull();
    });

    it('17. a blocked participant is rejected', async () => {
      await postAs(ctx, coordinator, `/admin/registrations/${reg.id}/block`, { reason: 'x' }).expect(303);
      expect(flash(await enter(token))).toMatch(/^ACCESS BLOCKED/);
      expect((await regOf('Asha')).insideSince).toBeNull();
    });

    it('18-20. verified + outside -> CHECK IN; inside -> CHECK OUT; the token never changes', async () => {
      expect(flash(await enter(token))).toMatch(/^✅ ENTERED/);
      expect((await regOf('Asha')).insideSince).not.toBeNull();
      expect(flash(await exit(token))).toMatch(/^⬅ CHECKED OUT/);
      expect((await regOf('Asha')).insideSince).toBeNull();
      const logs = await ctx.prisma.entryLog.findMany({ where: { status: EntryStatus.ENTERED }, orderBy: { enteredAt: 'asc' } });
      expect(logs.map((l) => [l.kind, l.volunteerId])).toEqual([
        [EntryKind.CHECK_IN, volunteer.id],
        [EntryKind.CHECK_OUT, volunteer.id],
      ]);
      await postAs(ctx, coordinator, `/admin/registrations/${reg.id}/resend-qr`).expect(303);
      await changeEmail('Asha', 'asha.new@gmail.com');
      expect((await regOf('Asha')).person.qrToken).toBe(token);
    });

    it('the token alone authorises nothing: no session, no gate action', async () => {
      const anon = await ctx.http.post(`/p/${token}/enter`).type('form').send({ registrationId: reg.id });
      expect(anon.status).toBe(303);
      expect(anon.headers.location).toMatch(/^\/login/);
      // A token with someone else's registration ID is refused too.
      await submitRow(ctx, 'r2', row('Bina', { 'Email Address': 'bina@gmail.com' })).expect(200);
      await verify('Bina');
      expect(flash(await enter(token, (await regOf('Bina')).id))).toBe('INVALID QR: registration not found for this pass');
      expect(await ctx.prisma.entryLog.count({ where: { status: EntryStatus.ENTERED } })).toBe(0);
    });
  });

  // ================= 3. Volunteer: full participant details =================

  describe('volunteer participant view', () => {
    let reg: Awaited<ReturnType<typeof regOf>>;
    beforeEach(async () => {
      await submitRow(
        ctx,
        'r1',
        row('Priya', { 'Email Address': 'priya@example.com' }, {
          'College Roll No.': '2201CS42',
          'College ID Card Photo': 'https://drive.google.com/open?id=1CollegeIdCardFileIdAAAAA',
          'Aadhaar No.': '1234 5678 9012',
          'Aadhaar Card Photo': 'https://drive.google.com/open?id=1AadhaarCardFileIdBBBBBB',
          'Check In Date': '10/10/2026',
          'Check Out Date': '12/10/2026',
          Accommodation: 'Yes',
          'Accommodation Period': '2 nights',
          Remark: 'Vegetarian',
        }),
      ).expect(200);
      await verify('Priya');
      reg = await regOf('Priya');
      await postAs(ctx, volunteer, `/p/${reg.person.qrToken}/enter`, { registrationId: reg.id }).expect(303);
      await postAs(ctx, volunteer, `/p/${reg.person.qrToken}/exit`, { registrationId: reg.id }).expect(303);
    });

    it('22 + 23. a signed-in volunteer sees the full details, full Aadhaar and the Aadhaar card', async () => {
      for (const path of [`/gate/${reg.id}`, `/p/${reg.person.qrToken}`]) {
        const text = (await getAs(ctx, volunteer, path).expect(200)).text;
        for (const shown of [
          'Priya', 'priya@example.com', '9876500000', 'NIT Patna', '2201CS42', `/staff/files/${reg.personId}/id`,
          '1234 5678 9012', `/staff/files/${reg.personId}/aadhaar`, 'Table Tennis', '10 Oct 2026', '12 Oct 2026', 'Yes', '2 nights',
          'Vegetarian', 'Verified', 'Not blocked', 'Actual check-in', 'Actual check-out', 'Gate log', 'History', 'Checked in', 'Checked out',
        ]) {
          expect([path, shown, text.includes(shown)]).toEqual([path, shown, true]);
        }
        expect(text).not.toContain('v1:'); // the encrypted Aadhaar is never rendered
      }
      const file = await getAs(ctx, volunteer, `/staff/files/${reg.personId}/aadhaar`).expect(200);
      expect(file.headers['content-type']).toBe('image/png');
      // Coordinators keep their existing access: last 4 digits, no Aadhaar image.
      await getAs(ctx, coordinator, `/staff/files/${reg.personId}/aadhaar`).expect(403);
    });

    it('rejection reason and block status are shown to volunteers', async () => {
      await submitRow(ctx, 'r2', row('Ravi', { 'Email Address': 'ravi@example.com' })).expect(200);
      const ravi = await regOf('Ravi');
      await postAs(ctx, coordinator, `/admin/registrations/${ravi.id}/reject`, { remarks: 'ID unreadable' }).expect(303);
      await postAs(ctx, coordinator, `/admin/registrations/${ravi.id}/block`, { reason: 'Misconduct' }).expect(303);
      const text = (await getAs(ctx, volunteer, `/gate/${ravi.id}`).expect(200)).text;
      for (const shown of ['Rejected', 'ID unreadable', 'BLOCKED', 'Misconduct']) expect([shown, text.includes(shown)]).toEqual([shown, true]);
    });

    it('24 + 25. without a session nothing is shown: no details, no Aadhaar, no files', async () => {
      const anonPass = await ctx.http.get(`/p/${reg.person.qrToken}`).expect(200);
      for (const secret of ['Priya', 'priya@example.com', '9876500000', '2201CS42', '9012', '/staff/files/', 'Vegetarian']) {
        expect([secret, anonPass.text.includes(secret)]).toEqual([secret, false]);
      }
      for (const path of [`/gate/${reg.id}`, `/staff/files/${reg.personId}/aadhaar`, `/staff/files/${reg.personId}/id`, '/scan/find']) {
        const res = await ctx.http.get(path);
        expect([path, res.status, res.headers.location?.startsWith('/login')]).toEqual([path, 303, true]);
        expect(res.text).not.toContain('1234 5678 9012');
      }
      // A forged or expired session cookie is the same as none.
      const forged = await ctx.http.get(`/gate/${reg.id}`).set('Cookie', 'inf_staff=forged-session-token');
      expect([forged.status, forged.text.includes('9012')]).toEqual([303, false]);
    });

    it('26. volunteer Change Email still works (same participant, QR and history)', async () => {
      const res = await postAs(ctx, volunteer, `/gate/${reg.id}/change-email`, { email: 'priya.new@example.com' });
      expect(flash(res)).toBe('Email changed from priya@example.com to priya.new@example.com. No email was sent; use Send QR email if needed.');
      const after = await regOf('Priya');
      expect(after.person).toMatchObject({ id: reg.personId, email: 'priya.new@example.com', qrToken: reg.person.qrToken });
      expect(after.paymentStatus).toBe(PaymentStatus.VERIFIED);
    });

    it('27. volunteers cannot see application secrets or reach admin pages', async () => {
      const texts = await Promise.all(
        [`/gate/${reg.id}`, `/p/${reg.person.qrToken}`, '/scan', '/scan/find'].map(async (p) => (await getAs(ctx, volunteer, p).expect(200)).text),
      );
      const secrets = [
        process.env.APP_SECRET!,
        process.env.FORMS_WEBHOOK_SECRET!,
        process.env.AADHAAR_ENCRYPTION_KEY!,
        process.env.DATABASE_URL!,
        volunteer.cookie.split('=')[1], // the raw session token
        coordinator.csrf,
      ];
      for (const text of texts) for (const secret of secrets) expect(text.includes(secret)).toBe(false);
      const staffUser = await ctx.prisma.staffUser.findUniqueOrThrow({ where: { id: volunteer.id } });
      for (const text of texts) expect(text).not.toContain(staffUser.id);
      for (const path of ['/admin/staff', '/admin/registrations', `/admin/registrations/${reg.id}`]) {
        expect([path, (await getAs(ctx, volunteer, path)).status]).toEqual([path, 403]);
      }
    });
  });
});
