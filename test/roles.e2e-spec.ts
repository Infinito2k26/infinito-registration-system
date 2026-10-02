import { PaymentStatus, StaffRole } from '@prisma/client';
import { DriveService } from '../src/drive/drive.service';
import { EmailTemplate } from '../src/emails/email-templates';
import { Ctx, Staff, flash, getAs, postAs, resetDatabase, staff, startApp, submitRow } from './e2e-helpers';

/**
 * Role-based access, checked by calling every route directly (not by looking at the UI):
 * ADMIN full access (incl. full Aadhaar + Aadhaar image), COORDINATOR staff access (Aadhaar
 * last 4 only), VOLUNTEER gate-only access.
 */
describe('Role-based access control (e2e)', () => {
  let ctx: Ctx;
  let admin: Staff;
  let coordinator: Staff;
  let volunteer: Staff;
  let restoreDrive: () => void;

  beforeAll(async () => {
    ctx = await startApp();
    // A fake Drive, so document routes can return 200 without Google credentials. The access
    // checks in front of it are the real ones.
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

  let regId: string;
  let personId: string;
  let collegeId: string;

  beforeEach(async () => {
    await resetDatabase(ctx);
    admin = await staff(ctx, StaffRole.ADMIN);
    coordinator = await staff(ctx, StaffRole.COORDINATOR);
    volunteer = await staff(ctx, StaffRole.VOLUNTEER);
    await submitRow(ctx, 'r1', {
      'Email Address': 'priya@example.com',
      'College Name': 'NIT Patna',
      Sports: 'TT',
      Name: 'Priya',
      'Mobile No.': '9876500000',
      'College Roll No.': '2201CS42',
      'College ID Card Photo': 'https://drive.google.com/open?id=1CollegeIdCardFileIdAAAAA',
      'Aadhaar No.': '1234 5678 9012',
      'Aadhaar Card Photo': 'https://drive.google.com/open?id=1AadhaarCardFileIdBBBBBB',
    }).expect(200);
    const reg = await ctx.prisma.registration.findFirstOrThrow({ include: { person: true } });
    regId = reg.id;
    personId = reg.personId;
    collegeId = reg.person.collegeId!;
  });

  const verify = () => postAs(ctx, coordinator, `/admin/registrations/${regId}/verify`).expect(303);
  const page = (who: Staff, path: string) => getAs(ctx, who, path).then((r) => ({ status: r.status, text: r.text }));

  // ---------- ADMIN ----------

  describe('ADMIN', () => {
    it('sees the full Aadhaar, the Aadhaar image link and the College ID link; both documents load', async () => {
      const profile = await page(admin, `/admin/registrations/${regId}`);
      expect(profile.status).toBe(200);
      expect(profile.text).toContain('1234 5678 9012');
      expect(profile.text).toContain(`/staff/files/${personId}/aadhaar`);
      expect(profile.text).toContain(`/staff/files/${personId}/id`);
      expect(profile.text).not.toContain('v1:'); // the encrypted value itself is never rendered
      await getAs(ctx, admin, `/staff/files/${personId}/aadhaar`).expect(200);
      await getAs(ctx, admin, `/staff/files/${personId}/id`).expect(200);
    });

    it('can block/unblock, use college bulk email, gate log, arrivals and staff management', async () => {
      await verify();
      expect(flash(await postAs(ctx, admin, `/admin/registrations/${regId}/block`, { reason: 'x' }))).toMatch(/^Participant blocked/);
      expect(flash(await postAs(ctx, admin, `/admin/registrations/${regId}/unblock`))).toMatch(/^Participant unblocked/);
      expect(flash(await postAs(ctx, admin, `/admin/colleges/${collegeId}/send-each`))).toMatch(/^Queued 0 QR email\(s\)|^Queued 1 QR email\(s\)/);
      for (const path of ['/admin/entries', '/admin/arrivals', '/admin/departures', '/admin/colleges', '/admin/staff']) {
        await getAs(ctx, admin, path).expect(200);
      }
    });

    it('navigation shows every section', async () => {
      const nav = (await page(admin, '/admin/registrations')).text;
      for (const item of ['>Dashboard<', '>Inside<', '>Outside<', '>Blocked<', '>Arrivals<', '>Gate log<', '>Colleges<', '>Scan<', '>Staff<']) {
        expect([item, nav.includes(item)]).toEqual([item, true]);
      }
    });
  });

  // ---------- COORDINATOR ----------

  describe('COORDINATOR', () => {
    it('sees Aadhaar last 4 only: no full number, no Aadhaar link, Aadhaar document forbidden', async () => {
      const profile = await page(coordinator, `/admin/registrations/${regId}`);
      expect(profile.status).toBe(200);
      expect(profile.text).toContain('XXXX XXXX 9012');
      for (const secret of ['5678', '123456789012', '/aadhaar', 'v1:', 'Aadhaar card<']) {
        expect([secret, profile.text.includes(secret)]).toEqual([secret, false]);
      }
      expect(profile.text).toContain(`/staff/files/${personId}/id`); // College ID allowed
      await getAs(ctx, coordinator, `/staff/files/${personId}/aadhaar`).expect(403);
      await getAs(ctx, coordinator, `/staff/files/${personId}/id`).expect(200);
    });

    it('can verify, block/unblock, check IN/OUT, change email and resend QR', async () => {
      await verify();
      expect(flash(await postAs(ctx, coordinator, `/admin/registrations/${regId}/block`))).toMatch(/^Participant blocked/);
      expect(flash(await postAs(ctx, coordinator, `/admin/registrations/${regId}/unblock`))).toMatch(/^Participant unblocked/);
      expect(flash(await postAs(ctx, coordinator, `/admin/registrations/${regId}/check-in`))).toMatch(/^✅ ENTERED/);
      expect(flash(await postAs(ctx, coordinator, `/admin/registrations/${regId}/check-out`))).toMatch(/^⬅ CHECKED OUT/);
      expect(flash(await postAs(ctx, coordinator, `/admin/registrations/${regId}/change-email`, { email: 'p2@example.com' }))).toMatch(/^Email changed/);
      await ctx.worker.processBatch();
      expect(flash(await postAs(ctx, coordinator, `/admin/registrations/${regId}/resend-qr`))).toBe(
        'QR email queued to p2@example.com; it goes out within a minute',
      );
    });

    it('cannot reach staff management; navigation has no Staff', async () => {
      await getAs(ctx, coordinator, '/admin/staff').expect(403);
      await postAs(ctx, coordinator, '/admin/staff', { email: 'x@staff.test', role: 'ADMIN' }).expect(403);
      await postAs(ctx, coordinator, `/admin/registrations/${regId}/check-out-override`).expect(403);
      const nav = (await page(coordinator, '/admin/registrations')).text;
      expect(nav).not.toContain('>Staff<');
      expect(nav).toContain('>Inside<');
    });
  });

  // ---------- VOLUNTEER ----------

  describe('VOLUNTEER', () => {
    it('has Scan and a gate-safe participant profile (Aadhaar last 4, College ID, no private data)', async () => {
      await verify();
      await getAs(ctx, volunteer, '/scan').expect(200);
      const profile = await page(volunteer, `/gate/${regId}`);
      expect(profile.status).toBe(200);
      expect(profile.text).toContain('Priya');
      expect(profile.text).toContain('XXXX XXXX 9012');
      expect(profile.text).toContain(`/staff/files/${personId}/id`);
      for (const secret of ['5678', '/aadhaar', 'priya@example.com', '9876500000', '2201CS42', 'v1:']) {
        expect([secret, profile.text.includes(secret)]).toEqual([secret, false]);
      }
      await getAs(ctx, volunteer, `/staff/files/${personId}/aadhaar`).expect(403);
      await getAs(ctx, volunteer, `/staff/files/${personId}/id`).expect(200);
    });

    it('can send the participant their own QR email (individual only); address is masked', async () => {
      await verify();
      await ctx.worker.processBatch();
      expect(flash(await postAs(ctx, volunteer, `/gate/${regId}/send-qr`))).toBe('QR email queued to p•••@example.com');
      const last = await ctx.prisma.emailOutbox.findFirstOrThrow({ where: { template: EmailTemplate.QrPass, triggeredById: volunteer.id } });
      expect(last.toEmail).toBe('priya@example.com');
    });

    it('can verify only when VOLUNTEERS_CAN_VERIFY=true', async () => {
      await postAs(ctx, volunteer, `/gate/${regId}/verify`).expect(403);
      expect((await ctx.prisma.registration.findUniqueOrThrow({ where: { id: regId } })).paymentStatus).toBe(PaymentStatus.PENDING);
      expect((await page(volunteer, `/gate/${regId}`)).text).not.toContain('>Verify</button>');
      process.env.VOLUNTEERS_CAN_VERIFY = 'true';
      try {
        expect((await page(volunteer, `/gate/${regId}`)).text).toContain('>Verify</button>');
        expect(flash(await postAs(ctx, volunteer, `/gate/${regId}/verify`))).toMatch(/^Verified 1 participant/);
        expect((await ctx.prisma.registration.findUniqueOrThrow({ where: { id: regId } })).paymentStatus).toBe(PaymentStatus.VERIFIED);
      } finally {
        process.env.VOLUNTEERS_CAN_VERIFY = 'false';
      }
    });

    it('can check IN/OUT at the gate', async () => {
      await verify();
      expect(flash(await postAs(ctx, volunteer, '/gate/enter', { registrationId: regId }))).toMatch(/^✅ ENTERED/);
      expect(flash(await postAs(ctx, volunteer, '/gate/exit', { registrationId: regId }))).toMatch(/^⬅ CHECKED OUT/);
    });

    it('gets 403 from every restricted route, called directly', async () => {
      await verify();
      const posts: [string, Record<string, string>][] = [
        [`/admin/registrations/${regId}/block`, { reason: 'x' }],
        [`/admin/registrations/${regId}/unblock`, {}],
        [`/admin/colleges/${collegeId}/send-each`, {}], // bulk email
        [`/admin/colleges/${collegeId}/send-to-one`, { personId }],
        [`/admin/registrations/${regId}/verify`, {}],
        [`/admin/registrations/${regId}/change-email`, { email: 'x@example.com' }],
        [`/admin/registrations/${regId}/check-in`, {}],
        ['/admin/staff', { email: 'x@staff.test', role: 'ADMIN' }],
      ];
      for (const [path, form] of posts) {
        expect([path, (await postAs(ctx, volunteer, path, form)).status]).toEqual([path, 403]);
      }
      const gets = [
        '/admin/registrations',
        `/admin/registrations/${regId}`,
        '/admin/colleges',
        `/admin/colleges/${collegeId}`,
        '/admin/entries', // gate logs
        '/admin/arrivals', // expected arrivals
        '/admin/departures',
        '/admin/staff',
        `/staff/files/${personId}/aadhaar`,
      ];
      for (const path of gets) {
        expect([path, (await getAs(ctx, volunteer, path)).status]).toEqual([path, 403]);
      }
      expect(await ctx.prisma.emailBatch.count()).toBe(0);
      expect((await ctx.prisma.person.findUniqueOrThrow({ where: { id: personId } })).blockedAt).toBeNull();
    });

    it('Find participant lists ALL participants (no search needed), searchable, with gate-safe columns only', async () => {
      for (const [i, name] of ['Arjun', 'Zoya'].entries()) {
        await submitRow(ctx, `x${i}`, {
          'Email Address': `${name.toLowerCase()}@example.com`,
          'College Name': i ? 'IIT Patna' : 'NIT Patna',
          Sports: i ? 'Hoki' : 'TT',
          Name: name,
          'Mobile No.': '9123456789',
        }).expect(200);
      }
      const all = await page(volunteer, '/scan/find');
      expect(all.status).toBe(200);
      for (const name of ['Priya', 'Arjun', 'Zoya']) expect([name, all.text.includes(`>${name}</a>`)]).toEqual([name, true]);
      expect(all.text).toContain('3 participant registration(s)');
      for (const secret of ['@example.com', '9876500000', '9123456789', '2201CS42', '9012', '/aadhaar']) {
        expect([secret, all.text.includes(secret)]).toEqual([secret, false]);
      }
      const byCollege = await page(volunteer, '/scan/find?q=iit');
      expect([byCollege.text.includes('>Zoya</a>'), byCollege.text.includes('>Priya</a>')]).toEqual([true, false]);
      const byEvent = await page(volunteer, '/scan/find?q=hoki');
      expect([byEvent.text.includes('>Zoya</a>'), byEvent.text.includes('>Arjun</a>')]).toEqual([true, false]);
      const byName = await page(volunteer, '/scan/find?q=arj');
      expect(byName.text).toContain(`href="/gate/`);
      expect([byName.text.includes('>Arjun</a>'), byName.text.includes('>Priya</a>')]).toEqual([true, false]);
    });

    it('opens a participant from the list: allowed info only, email masked', async () => {
      await verify();
      const list = await page(volunteer, '/scan/find');
      expect(list.text).toContain(`data-href="/gate/${regId}"`);
      const profile = await page(volunteer, `/gate/${regId}`);
      expect(profile.status).toBe(200);
      for (const shown of ['Priya', 'NIT Patna', 'TT', 'XXXX XXXX 9012', `/staff/files/${personId}/id`, 'Email p•••@example.com', 'Change email', 'Send QR email']) {
        expect([shown, profile.text.includes(shown)]).toEqual([shown, true]);
      }
      for (const secret of ['priya@example.com', '9876500000', '2201CS42', '5678', '/aadhaar', 'Block participant', 'Unblock']) {
        expect([secret, profile.text.includes(secret)]).toEqual([secret, false]);
      }
    });

    it('can change the email from the participant profile (same shared logic, audited)', async () => {
      await verify();
      const before = await ctx.prisma.person.findUniqueOrThrow({ where: { id: personId } });
      expect(flash(await postAs(ctx, volunteer, `/gate/${regId}/change-email`, { email: ' Priya.New@Example.com ' }))).toBe(
        'Email changed from p•••@example.com to priya.new@example.com. No email was sent; use Send QR email if needed.',
      );
      const after = await ctx.prisma.registration.findUniqueOrThrow({ where: { id: regId }, include: { person: true } });
      expect(after.personId).toBe(personId);
      expect(after.person).toMatchObject({ email: 'priya.new@example.com', qrToken: before.qrToken });
      expect(after.paymentStatus).toBe(PaymentStatus.VERIFIED);
      expect(await ctx.prisma.personEmailAlias.count({ where: { email: 'priya@example.com', personId } })).toBe(1);
      const audit = await ctx.prisma.registrationActivity.findFirstOrThrow({ where: { type: 'EMAIL_CHANGED' } });
      expect(audit).toMatchObject({ actorId: volunteer.id, details: expect.objectContaining({ from: 'priya@example.com', to: 'priya.new@example.com' }) });
      // Same validation as everywhere else.
      expect(flash(await postAs(ctx, volunteer, `/gate/${regId}/change-email`, { email: 'nope' }))).toBe('"nope" is not a valid email');
      // The QR email then goes to the new address.
      await ctx.worker.processBatch();
      expect(flash(await postAs(ctx, volunteer, `/gate/${regId}/send-qr`))).toBe('QR email queued to p•••@example.com');
      const last = await ctx.prisma.emailOutbox.findFirstOrThrow({ where: { triggeredById: volunteer.id, template: EmailTemplate.QrPass } });
      expect(last.toEmail).toBe('priya.new@example.com');
    });

    it('navigation shows only Scan and Find participant', async () => {
      const nav = (await page(volunteer, '/scan')).text;
      expect(nav).toContain('>Scan<');
      expect(nav).toContain('>Find participant<');
      for (const item of ['>Dashboard<', '>Colleges<', '>Gate log<', '>Arrivals<', '>Staff<', '>Blocked<', '>Inside<']) {
        expect([item, nav.includes(item)]).toEqual([item, false]);
      }
    });
  });
});
