import { EmailStatus, EntryKind, EntryStatus, PaymentStatus, StaffRole } from '@prisma/client';
import { CollegePass, EmailTemplate } from '../src/emails/email-templates';
import { MailTransport, OutgoingEmail, PermanentSendError } from '../src/emails/mail-transport';
import { Ctx, Staff, flash, getAs, postAs, resetDatabase, staff, startApp, submitRow } from './e2e-helpers';

/**
 * The individual-form workflow end to end: form row -> import (pending) -> manual verify ->
 * QR email -> repeated resends -> email change -> college bulk sends -> gate IN/OUT.
 */
describe('Individual form workflow (e2e)', () => {
  let ctx: Ctx;
  let coordinator: Staff;

  beforeAll(async () => {
    ctx = await startApp();
  });
  afterAll(async () => {
    await ctx.app.close();
  });
  beforeEach(async () => {
    await resetDatabase(ctx);
    coordinator = await staff(ctx, StaffRole.COORDINATOR);
  });

  /** A row of the actual response sheet. */
  const row = (o: { name: string; email: string; college: string; sport?: string; roll?: string; mobile?: string }) => ({
    'Email Address *': o.email,
    'College Name': o.college,
    'Sports:': o.sport ?? 'Table Tennis',
    Name: o.name,
    'Mobile No.': o.mobile ?? '9876500000',
    'College Roll No.': o.roll ?? `R-${o.name}`,
    'College ID Card Photo': 'https://drive.google.com/open?id=1CollegeIdCardFileIdAAAAA',
    'Aadhaar No.': '1234 5678 9012',
    'Aadhaar Card Photo': 'https://drive.google.com/open?id=1AadhaarCardFileIdBBBBBB',
    'Check In Date': '10/10/2026',
    'Check Out Date': '12/10/2026',
    Accommodation: 'Yes',
    'Accommodation Period': '2 nights',
    Remark: 'Vegetarian',
  });

  const reg = (email: string, eventSlug = 'table-tennis') =>
    ctx.prisma.registration.findFirstOrThrow({ where: { eventSlug, person: { email } }, include: { person: true } });

  const qrRows = (email: string) =>
    ctx.prisma.emailOutbox.findMany({ where: { template: EmailTemplate.QrPass, toEmail: email }, orderBy: { createdAt: 'asc' } });

  const verify = async (email: string) => postAs(ctx, coordinator, `/admin/registrations/${(await reg(email)).id}/verify`);

  /** Swaps the worker's transport for one that fails for chosen recipients and records sends. */
  function fakeTransport(failFor: string[] = []) {
    const sent: OutgoingEmail[] = [];
    const transport: MailTransport = {
      name: 'fake',
      send: (email) => {
        if (failFor.includes(email.to)) return Promise.reject(new PermanentSendError('validation_error: Invalid `to` field'));
        sent.push(email);
        return Promise.resolve(`email_${sent.length}`);
      },
    };
    const worker = ctx.worker as unknown as { transport: MailTransport };
    const original = worker.transport;
    worker.transport = transport;
    return { sent, restore: () => (worker.transport = original) };
  }

  // ---------- form import ----------

  describe('form import', () => {
    it('imports the actual sheet row as PENDING, with no QR and no QR email', async () => {
      const res = await submitRow(ctx, 'r1', row({ name: 'Priya', email: ' Priya@Example.com', college: 'NIT  Patna' })).expect(200);
      expect(res.body).toMatchObject({ ok: true, outcome: 'created', events: ['table-tennis'] });

      const r = await reg('priya@example.com');
      expect(r).toMatchObject({
        paymentStatus: PaymentStatus.PENDING,
        insideSince: null,
        accommodation: 'Yes',
        accommodationPeriod: '2 nights',
        // Form "Check In/Out Date" = planned dates, kept separate from the actual gate times.
        expectedArrivalText: '10/10/2026',
        expectedDepartureText: '12/10/2026',
        expectedArrivalDate: new Date('2026-10-10T00:00:00.000Z'),
        expectedDepartureDate: new Date('2026-10-12T00:00:00.000Z'),
        lastCheckInAt: null,
        lastCheckOutAt: null,
        remark: 'Vegetarian',
        transactionId: null,
      });
      expect(r.person).toMatchObject({
        phone: '9876500000',
        rollNumber: 'R-Priya',
        college: 'NIT Patna',
        aadhaarLast4: '9012',
        aadhaarDriveId: '1AadhaarCardFileIdBBBBBB',
        idDocumentDriveId: '1CollegeIdCardFileIdAAAAA',
        qrToken: null,
      });
      // The full Aadhaar number is never stored in plain text (only encrypted, admin-only).
      const people = await ctx.prisma.person.findMany();
      expect(people[0].aadhaarEncrypted).toMatch(/^v1:/);
      const dump = JSON.stringify(people.map(({ aadhaarEncrypted: _e, ...p }) => p)) + JSON.stringify(await ctx.prisma.registration.findMany());
      expect(dump).not.toContain('5678');
      expect(people[0].aadhaarEncrypted).not.toContain('123456789012');
      expect(await ctx.prisma.emailOutbox.count({ where: { template: EmailTemplate.QrPass } })).toBe(0);
      expect(await ctx.prisma.emailOutbox.count({ where: { template: EmailTemplate.RegistrationReceived } })).toBe(0);
    });

    it('resync and duplicate submissions never duplicate people or registrations; colleges are grouped', async () => {
      await submitRow(ctx, 'r1', row({ name: 'Priya', email: 'priya@example.com', college: 'NIT Patna' })).expect(200);
      await submitRow(ctx, 'r1', row({ name: 'Priya', email: 'priya@example.com', college: 'NIT Patna' })).expect(200); // resync
      await submitRow(ctx, 'r2', row({ name: 'Priya', email: 'PRIYA@example.com', college: 'nit  patna' })).expect(200); // resubmitted
      await submitRow(ctx, 'r3', row({ name: 'Arjun', email: 'arjun@example.com', college: ' NIT patna ' })).expect(200);
      expect(await ctx.prisma.person.count()).toBe(2);
      expect(await ctx.prisma.registration.count()).toBe(2);
      expect(await ctx.prisma.college.count()).toBe(1);
      expect((await ctx.prisma.college.findFirstOrThrow()).name).toBe('NIT Patna');
    });

    it('Sports decides the event (several = one registration each); without Sports the row is rejected', async () => {
      const multi = await submitRow(ctx, 'r1', row({ name: 'Priya', email: 'priya@example.com', college: 'X', sport: 'Football, Table Tennis' })).expect(200);
      expect(multi.body.events).toEqual(['football', 'table-tennis']);
      const noSport: Record<string, string> = row({ name: 'Arjun', email: 'arjun@example.com', college: 'X' });
      delete noSport['Sports:'];
      const rejected = await submitRow(ctx, 'r2', noSport, 'Cricket').expect(422); // an old EVENT_SLUG is ignored
      expect(rejected.body.errors).toEqual(['Sports is missing: the sport/event must be chosen in the form']);
      expect((await ctx.prisma.registration.findMany({ orderBy: { eventSlug: 'asc' } })).map((r) => r.eventSlug)).toEqual([
        'football',
        'table-tennis',
      ]);
      // Editing the response to drop Football removes that (unverified) registration.
      await submitRow(ctx, 'r1', row({ name: 'Priya', email: 'priya@example.com', college: 'X', sport: 'Table Tennis' })).expect(200);
      expect(await ctx.prisma.registration.count({ where: { person: { email: 'priya@example.com' } } })).toBe(1);
    });
  });

  // ---------- verification & individual QR email ----------

  describe('verification and individual QR email', () => {
    beforeEach(async () => {
      await submitRow(ctx, 'r1', row({ name: 'Priya', email: 'priya@example.com', college: 'NIT Patna' })).expect(200);
    });

    it('5 simultaneous VERIFY clicks: one QR token, one automatic QR email, audited', async () => {
      const id = (await reg('priya@example.com')).id;
      await Promise.all(Array.from({ length: 5 }, () => postAs(ctx, coordinator, `/admin/registrations/${id}/verify`)));
      const r = await reg('priya@example.com');
      expect(r.paymentStatus).toBe(PaymentStatus.VERIFIED);
      expect(r.paymentReviewedById).toBe(coordinator.id);
      expect(r.person.qrToken).toMatch(/^[\w-]{43}$/);
      expect(await qrRows('priya@example.com')).toHaveLength(1);
      const activity = await ctx.prisma.registrationActivity.findMany({ where: { registrationId: id, type: 'PAYMENT_VERIFIED' } });
      expect(activity).toHaveLength(1);
      expect(activity[0]).toMatchObject({ actorId: coordinator.id, details: expect.objectContaining({ qrTokenCreated: true }) });
    });

    it('manual QR email can be sent repeatedly (no limit), always with the same token, to the current email', async () => {
      await verify('priya@example.com');
      const fake = fakeTransport();
      try {
        await ctx.worker.processBatch(); // automatic first QR email
        const r = await reg('priya@example.com');
        for (let i = 0; i < 5; i++) {
          expect(flash(await postAs(ctx, coordinator, `/admin/registrations/${r.id}/resend-qr`))).toBe(
            'QR email queued to priya@example.com; it goes out within a minute',
          );
          await ctx.worker.processBatch();
        }
        expect(fake.sent.filter((e) => e.subject.startsWith('Your Infinito 2K26 entry pass'))).toHaveLength(6); // 1 automatic + 5 manual
        const tokens = new Set(
          (await qrRows('priya@example.com')).map((e) => (e.payload as { qrToken: string }).qrToken),
        );
        expect(tokens).toEqual(new Set([r.person.qrToken]));
        expect((await reg('priya@example.com')).person.qrToken).toBe(r.person.qrToken);
        expect(await ctx.prisma.registrationActivity.count({ where: { registrationId: r.id, type: 'QR_EMAIL_RESENT' } })).toBe(5);
        const page = await getAs(ctx, coordinator, `/admin/registrations/${r.id}`).expect(200);
        expect(page.text).toContain('Manual sends 5 (no limit)');
        expect(page.text).toContain('Resend QR email');
      } finally {
        fake.restore();
      }
    });

    it('concurrent resend clicks queue only one email; a failed email can be retried', async () => {
      await verify('priya@example.com');
      const r = await reg('priya@example.com');
      const fake = fakeTransport(['priya@example.com']);
      try {
        await ctx.worker.processBatch(); // first email fails permanently
        expect((await qrRows('priya@example.com'))[0].status).toBe(EmailStatus.FAILED);
      } finally {
        fake.restore();
      }
      const clicks = await Promise.all(Array.from({ length: 5 }, () => postAs(ctx, coordinator, `/admin/registrations/${r.id}/resend-qr`)));
      expect(clicks.map(flash).filter((m) => m?.startsWith('QR email queued'))).toHaveLength(1);
      await ctx.worker.processBatch();
      expect((await qrRows('priya@example.com')).map((e) => e.status)).toEqual([EmailStatus.FAILED, EmailStatus.SENT]);
    });

    it('unverified and rejected participants cannot receive a QR email', async () => {
      const r = await reg('priya@example.com');
      expect(flash(await postAs(ctx, coordinator, `/admin/registrations/${r.id}/resend-qr`))).toBe('Not verified, so there is no pass to send');
      await postAs(ctx, coordinator, `/admin/registrations/${r.id}/reject`, { remarks: 'Not a student' });
      expect(flash(await postAs(ctx, coordinator, `/admin/registrations/${r.id}/resend-qr`))).toBe('Not verified, so there is no pass to send');
      expect(await ctx.prisma.emailOutbox.count({ where: { template: EmailTemplate.QrPass } })).toBe(0);
    });
  });

  // ---------- change email ----------

  describe('change email', () => {
    it('changes the address in place; QR, status and history are kept; resync of the old row does not revert it', async () => {
      await submitRow(ctx, 'r1', row({ name: 'Priya', email: 'priya@example.com', college: 'NIT Patna' })).expect(200);
      await verify('priya@example.com');
      await ctx.worker.processBatch();
      const before = await reg('priya@example.com');

      expect(flash(await postAs(ctx, coordinator, `/admin/registrations/${before.id}/change-email`, { email: ' Priya.New@Example.com ' }))).toBe(
        'Email changed from priya@example.com to priya.new@example.com. No email was sent; use Send QR email if needed.',
      );
      const after = await reg('priya.new@example.com');
      expect(after.id).toBe(before.id);
      expect(after.personId).toBe(before.personId);
      expect(after.person.qrToken).toBe(before.person.qrToken);
      expect(after.paymentStatus).toBe(PaymentStatus.VERIFIED);
      expect(await ctx.prisma.emailOutbox.count({ where: { toEmail: 'priya.new@example.com' } })).toBe(0); // nothing sent automatically
      const changed = await ctx.prisma.registrationActivity.findFirstOrThrow({ where: { type: 'EMAIL_CHANGED' } });
      expect(changed).toMatchObject({ actorId: coordinator.id, details: expect.objectContaining({ from: 'priya@example.com', to: 'priya.new@example.com' }) });

      await postAs(ctx, coordinator, `/admin/registrations/${after.id}/resend-qr`);
      const newest = (await ctx.prisma.emailOutbox.findMany({ where: { template: EmailTemplate.QrPass }, orderBy: { createdAt: 'desc' } }))[0];
      expect(newest.toEmail).toBe('priya.new@example.com');
      expect((newest.payload as { qrToken: string }).qrToken).toBe(before.person.qrToken);

      // The sheet still has the old email: resync maps to the same person and keeps the new email.
      await submitRow(ctx, 'r1', row({ name: 'Priya', email: 'priya@example.com', college: 'NIT Patna' })).expect(200);
      expect(await ctx.prisma.person.count()).toBe(1);
      expect(await ctx.prisma.registration.count()).toBe(1);
      expect((await ctx.prisma.person.findFirstOrThrow()).email).toBe('priya.new@example.com');
      expect((await reg('priya.new@example.com')).paymentStatus).toBe(PaymentStatus.VERIFIED);
    });

    it('refuses invalid and conflicting addresses without merging records', async () => {
      await submitRow(ctx, 'r1', row({ name: 'Priya', email: 'priya@example.com', college: 'X' })).expect(200);
      await submitRow(ctx, 'r2', row({ name: 'Arjun', email: 'arjun@example.com', college: 'X' })).expect(200);
      const priya = await reg('priya@example.com');
      expect(flash(await postAs(ctx, coordinator, `/admin/registrations/${priya.id}/change-email`, { email: 'not-an-email' }))).toBe(
        '"not-an-email" is not a valid email',
      );
      expect(flash(await postAs(ctx, coordinator, `/admin/registrations/${priya.id}/change-email`, { email: 'ARJUN@example.com' }))).toBe(
        'This email address is already registered to another participant.',
      );
      expect(await ctx.prisma.person.count()).toBe(2);
      expect((await reg('priya@example.com')).person.email).toBe('priya@example.com');
    });
  });

  // ---------- colleges ----------

  describe('colleges', () => {
    /** NIT Patna: Priya + Arjun verified, Meera pending, Kabir rejected. IIT Patna: Zoya verified. */
    async function seedColleges() {
      await submitRow(ctx, 'r1', row({ name: 'Priya', email: 'priya@nitp.test', college: 'NIT Patna' })).expect(200);
      await submitRow(ctx, 'r2', row({ name: 'Arjun', email: 'arjun@nitp.test', college: 'nit patna', sport: 'Football' })).expect(200);
      await submitRow(ctx, 'r3', row({ name: 'Meera', email: 'meera@nitp.test', college: 'NIT Patna' })).expect(200);
      await submitRow(ctx, 'r4', row({ name: 'Kabir', email: 'kabir@nitp.test', college: 'NIT Patna' })).expect(200);
      await submitRow(ctx, 'r5', row({ name: 'Zoya', email: 'zoya@iitp.test', college: 'IIT Patna' })).expect(200);
      await verify('priya@nitp.test');
      await postAs(ctx, coordinator, `/admin/registrations/${(await reg('arjun@nitp.test', 'football')).id}/verify`);
      await verify('zoya@iitp.test');
      await postAs(ctx, coordinator, `/admin/registrations/${(await reg('kabir@nitp.test')).id}/reject`, { remarks: 'duplicate' });
      await ctx.worker.processBatch(); // automatic first emails
      const nit = await ctx.prisma.college.findFirstOrThrow({ where: { nameKey: 'nit patna' } });
      const iit = await ctx.prisma.college.findFirstOrThrow({ where: { nameKey: 'iit patna' } });
      return { nit, iit };
    }

    it('groups participants by college with TOTAL/VERIFIED/PENDING/INSIDE/OUTSIDE, per event too', async () => {
      const { nit } = await seedColleges();
      const list = await getAs(ctx, coordinator, '/admin/colleges').expect(200);
      expect(list.text).toMatch(/NIT Patna<\/a><\/td>\s*<td class="num">4<\/td><td class="num">2<\/td><td class="num">1<\/td><td class="num">0<\/td><td class="num">4<\/td>/);
      const tt = await getAs(ctx, coordinator, '/admin/colleges?event=table-tennis').expect(200);
      expect(tt.text).toMatch(/NIT Patna<\/a><\/td>\s*<td class="num">3<\/td><td class="num">1<\/td>/);
      const page = await getAs(ctx, coordinator, `/admin/colleges/${nit.id}`).expect(200);
      for (const name of ['Priya', 'Arjun', 'Meera', 'Kabir']) expect(page.text).toContain(name);
      expect(page.text).not.toContain('Zoya');
      const filtered = await getAs(ctx, coordinator, `/admin/registrations?college=${nit.id}`).expect(200);
      expect(filtered.text).toContain('Priya');
      expect(filtered.text).not.toContain('Zoya');
    });

    it('SEND QR TO ALL VERIFIED STUDENTS: each gets their own QR at their own email; one failure does not stop the rest', async () => {
      const { nit } = await seedColleges();
      const fake = fakeTransport(['arjun@nitp.test']);
      try {
        const res = await postAs(ctx, coordinator, `/admin/colleges/${nit.id}/send-each`);
        expect(flash(res)).toBe("Queued 2 QR email(s), each to the student's own address");
        await ctx.worker.processBatch();
      } finally {
        fake.restore();
      }
      const batch = await ctx.prisma.emailBatch.findFirstOrThrow({ include: { emails: true } });
      expect(batch).toMatchObject({ kind: 'COLLEGE_EACH', collegeId: nit.id, eligibleCount: 2, queuedCount: 2, triggeredById: coordinator.id });
      const byTo = Object.fromEntries(batch.emails.map((e) => [e.toEmail, e]));
      expect(Object.keys(byTo).sort()).toEqual(['arjun@nitp.test', 'priya@nitp.test']); // Meera (pending), Kabir (rejected), Zoya (other college) excluded
      expect(byTo['priya@nitp.test'].status).toBe(EmailStatus.SENT);
      expect(byTo['arjun@nitp.test'].status).toBe(EmailStatus.FAILED);
      for (const email of ['priya@nitp.test', 'arjun@nitp.test']) {
        const person = await ctx.prisma.person.findUniqueOrThrow({ where: { email } });
        expect((byTo[email].payload as { qrToken: string }).qrToken).toBe(person.qrToken);
      }
      const page = await getAs(ctx, coordinator, `/admin/colleges/${nit.id}`).expect(200);
      expect(page.text).toContain('Each student, own email');

      // A double click while emails are waiting does not queue duplicates.
      await postAs(ctx, coordinator, `/admin/colleges/${nit.id}/send-each`);
      const again = await postAs(ctx, coordinator, `/admin/colleges/${nit.id}/send-each`);
      expect(flash(again)).toBe("Queued 0 QR email(s), each to the student's own address; 2 already had one waiting");
    });

    it('SEND ALL COLLEGE QR PASSES TO ONE STUDENT: one email to the selected student with every verified pass', async () => {
      const { nit } = await seedColleges();
      const priya = await ctx.prisma.person.findUniqueOrThrow({ where: { email: 'priya@nitp.test' } });
      const arjun = await ctx.prisma.person.findUniqueOrThrow({ where: { email: 'arjun@nitp.test' } });
      const tokensBefore = (await ctx.prisma.person.findMany({ orderBy: { email: 'asc' } })).map((p) => p.qrToken);

      const res = await postAs(ctx, coordinator, `/admin/colleges/${nit.id}/send-to-one`, { personId: priya.id });
      expect(flash(res)).toBe('Queued 2 pass(es) in 1 email(s) to priya@nitp.test');
      const mails = await ctx.prisma.emailOutbox.findMany({ where: { template: EmailTemplate.CollegePasses } });
      expect(mails).toHaveLength(1);
      expect(mails[0].toEmail).toBe('priya@nitp.test');
      const passes = (mails[0].payload as unknown as { passes: CollegePass[] }).passes;
      expect(passes.map((p) => [p.name, p.qrToken]).sort()).toEqual(
        [
          ['Arjun', arjun.qrToken],
          ['Priya', priya.qrToken],
        ].sort(),
      );
      expect(JSON.stringify(mails[0].payload)).not.toMatch(/Zoya|Meera|Kabir/);
      expect((await ctx.prisma.person.findMany({ orderBy: { email: 'asc' } })).map((p) => p.qrToken)).toEqual(tokensBefore);

      const batch = await ctx.prisma.emailBatch.findFirstOrThrow({ where: { kind: 'COLLEGE_TO_ONE' } });
      expect(batch).toMatchObject({ recipientPersonId: priya.id, recipientEmail: 'priya@nitp.test', eligibleCount: 2, triggeredById: coordinator.id });
      expect(await ctx.prisma.registrationActivity.count({ where: { type: 'QR_PASSES_FORWARDED' } })).toBe(2);

      const fake = fakeTransport();
      try {
        await ctx.worker.processBatch();
        const sent = fake.sent.find((e) => e.subject.startsWith('Infinito 2K26 entry passes'))!;
        expect(sent.to).toBe('priya@nitp.test');
        expect(sent.attachments?.map((a) => a.contentId)).toEqual(['pass-0', 'pass-1']);
        expect(sent.html).toContain('Each QR belongs to the student named next to it');
      } finally {
        fake.restore();
      }
    });

    it('refuses recipients from another college, unverified recipients, and unknown IDs', async () => {
      const { nit, iit } = await seedColleges();
      const zoya = await ctx.prisma.person.findUniqueOrThrow({ where: { email: 'zoya@iitp.test' } });
      const meera = await ctx.prisma.person.findUniqueOrThrow({ where: { email: 'meera@nitp.test' } });
      const refused = 'The selected student must be a verified participant of this college';
      expect(flash(await postAs(ctx, coordinator, `/admin/colleges/${nit.id}/send-to-one`, { personId: zoya.id }))).toBe(refused);
      expect(flash(await postAs(ctx, coordinator, `/admin/colleges/${nit.id}/send-to-one`, { personId: meera.id }))).toBe(refused);
      expect(flash(await postAs(ctx, coordinator, `/admin/colleges/${iit.id}/send-to-one`, { personId: meera.id }))).toBe(refused);
      expect(flash(await postAs(ctx, coordinator, `/admin/colleges/00000000-0000-4000-8000-000000000000/send-each`))).toBe('College not found');
      await getAs(ctx, coordinator, '/admin/colleges/00000000-0000-4000-8000-000000000000').expect(404);
      await getAs(ctx, coordinator, '/admin/registrations/00000000-0000-4000-8000-000000000000').expect(404);
      expect(await ctx.prisma.emailBatch.count()).toBe(0);
    });
  });

  // ---------- gate IN / OUT ----------

  describe('check-in / check-out', () => {
    beforeEach(async () => {
      await submitRow(ctx, 'r1', row({ name: 'Priya', email: 'priya@example.com', college: 'NIT Patna' })).expect(200);
      await submitRow(ctx, 'r2', row({ name: 'Arjun', email: 'arjun@example.com', college: 'NIT Patna' })).expect(200);
      await verify('priya@example.com');
    });

    const counters = async () => {
      const text = (await getAs(ctx, coordinator, '/admin/registrations').expect(200)).text;
      const value = (label: string) => Number(text.match(new RegExp(`<div class="label">${label}</div><div class="value">(\\d+)</div>`))![1]);
      return { total: value('Total'), verified: value('Verified'), pending: value('Pending'), inside: value('Inside'), outside: value('Outside') };
    };

    it('IN -> duplicate IN refused -> OUT -> duplicate OUT refused -> IN again; counters follow', async () => {
      const volunteer = await staff(ctx, StaffRole.VOLUNTEER);
      const r = await reg('priya@example.com');
      const token = r.person.qrToken!;
      expect(await counters()).toEqual({ total: 2, verified: 1, pending: 1, inside: 0, outside: 2 });

      expect(flash(await postAs(ctx, volunteer, `/p/${token}/exit`, { registrationId: r.id }))).toBe(
        'Cannot check out: this participant has never checked in.',
      );
      expect(flash(await postAs(ctx, volunteer, `/p/${token}/enter`, { registrationId: r.id, gate: 'Main' }))).toMatch(
        /^✅ ENTERED \(CHECK IN\): Priya · NIT Patna · Table Tennis · \d{2} \w{3} \d{4}, \d{2}:\d{2}:\d{2}\. Now INSIDE\.$/,
      );
      expect(flash(await postAs(ctx, volunteer, `/p/${token}/enter`, { registrationId: r.id }))).toMatch(/^ALREADY ENTERED: inside since/);
      expect(await counters()).toMatchObject({ inside: 1, outside: 1 });

      expect(flash(await postAs(ctx, volunteer, `/p/${token}/exit`, { registrationId: r.id, gate: 'Main' }))).toMatch(
        /^⬅ CHECKED OUT: Priya · NIT Patna · Table Tennis · \d{2} \w{3} \d{4}, \d{2}:\d{2}:\d{2}\. Now OUTSIDE\.$/,
      );
      expect(flash(await postAs(ctx, volunteer, `/p/${token}/exit`, { registrationId: r.id }))).toMatch(/^Cannot check out: not inside/);
      expect(await counters()).toMatchObject({ inside: 0, outside: 2 });

      expect(flash(await postAs(ctx, volunteer, `/p/${token}/enter`, { registrationId: r.id }))).toMatch(/^✅ ENTERED/);
      const logs = await ctx.prisma.entryLog.findMany({ orderBy: { enteredAt: 'asc' } });
      expect(logs.map((l) => `${l.kind}:${l.status}`)).toEqual([
        'CHECK_OUT:REJECTED',
        'CHECK_IN:ENTERED',
        'CHECK_IN:REJECTED',
        'CHECK_OUT:ENTERED',
        'CHECK_OUT:REJECTED',
        'CHECK_IN:ENTERED',
      ]);
      const after = await reg('priya@example.com');
      expect(after.enteredAt).not.toBeNull(); // first entry is kept
      expect(after.insideSince).not.toBeNull();
      expect(after.lastCheckOutAt).not.toBeNull();
    });

    it('concurrent check-ins and check-outs cannot corrupt the state', async () => {
      const volunteer = await staff(ctx, StaffRole.VOLUNTEER);
      const r = await reg('priya@example.com');
      const token = r.person.qrToken!;
      await Promise.all(Array.from({ length: 8 }, () => postAs(ctx, volunteer, `/p/${token}/enter`, { registrationId: r.id })));
      expect(await ctx.prisma.entryLog.count({ where: { kind: EntryKind.CHECK_IN, status: EntryStatus.ENTERED } })).toBe(1);
      await Promise.all(Array.from({ length: 8 }, () => postAs(ctx, volunteer, `/p/${token}/exit`, { registrationId: r.id })));
      expect(await ctx.prisma.entryLog.count({ where: { kind: EntryKind.CHECK_OUT, status: EntryStatus.ENTERED } })).toBe(1);
      expect((await reg('priya@example.com')).insideSince).toBeNull();
    });

    it('unverified participants cannot check in; admins can check in/out from the participant page', async () => {
      const arjun = await reg('arjun@example.com');
      expect(flash(await postAs(ctx, coordinator, `/admin/registrations/${arjun.id}/check-in`))).toBe('NOT VERIFIED. Do not admit.');
      const priya = await reg('priya@example.com');
      expect(flash(await postAs(ctx, coordinator, `/admin/registrations/${priya.id}/check-in`))).toMatch(/^✅ ENTERED/);
      expect(flash(await postAs(ctx, coordinator, `/admin/registrations/${priya.id}/check-out`))).toMatch(/^⬅ CHECKED OUT/);
      const page = await getAs(ctx, coordinator, `/admin/registrations/${priya.id}`).expect(200);
      expect(page.text).toContain('Actual check-out');
      expect(page.text).toContain('<b>Checked out</b>');
    });
  });

  // ---------- roles & privacy ----------

  describe('roles and privacy', () => {
    it('volunteers cannot change emails, verify, send QR or bulk emails, or see Aadhaar', async () => {
      await submitRow(ctx, 'r1', row({ name: 'Priya', email: 'priya@nitp.test', college: 'NIT Patna' })).expect(200);
      await verify('priya@nitp.test');
      const r = await reg('priya@nitp.test');
      const college = await ctx.prisma.college.findFirstOrThrow();
      const volunteer = await staff(ctx, StaffRole.VOLUNTEER);
      for (const [path, form] of [
        [`/admin/registrations/${r.id}/change-email`, { email: 'evil@x.test' }],
        [`/admin/registrations/${r.id}/verify`, {}],
        [`/admin/registrations/${r.id}/resend-qr`, {}],
        [`/admin/registrations/${r.id}/check-in`, {}],
        [`/admin/colleges/${college.id}/send-each`, {}],
        [`/admin/colleges/${college.id}/send-to-one`, { personId: r.personId }],
      ] as const) {
        await postAs(ctx, volunteer, path, form).expect(403);
      }
      for (const path of [`/admin/registrations/${r.id}`, '/admin/colleges', `/admin/colleges/${college.id}`]) {
        await getAs(ctx, volunteer, path).expect(403);
      }
      expect((await reg('priya@nitp.test')).person.email).toBe('priya@nitp.test');
      expect(await ctx.prisma.emailBatch.count()).toBe(0);

      // Volunteers (trusted event staff) see the full participant details on their participant view.
      const pass = await getAs(ctx, volunteer, `/p/${r.person.qrToken}`).expect(200);
      for (const shown of ['Priya', 'NIT Patna', 'priya@nitp.test', '9876500000', '1234 5678 9012', 'R-Priya', 'Aadhaar card', 'Vegetarian']) {
        expect([shown, pass.text.includes(shown)]).toEqual([shown, true]);
      }
    });

    it('coordinators see the full participant page (Aadhaar masked) but not staff management', async () => {
      await submitRow(ctx, 'r1', row({ name: 'Priya', email: 'priya@nitp.test', college: 'NIT Patna' })).expect(200);
      const r = await reg('priya@nitp.test');
      const page = await getAs(ctx, coordinator, `/admin/registrations/${r.id}`).expect(200);
      for (const field of ['priya@nitp.test', '9876500000', 'R-Priya', 'XXXX XXXX 9012', '2 nights', 'Vegetarian', '10/10/2026']) {
        expect(page.text).toContain(field);
      }
      await getAs(ctx, coordinator, '/admin/staff').expect(403);
    });

    it('cross-site posts are blocked even for signed-in coordinators', async () => {
      await submitRow(ctx, 'r1', row({ name: 'Priya', email: 'priya@nitp.test', college: 'NIT Patna' })).expect(200);
      const r = await reg('priya@nitp.test');
      await postAs(ctx, coordinator, `/admin/registrations/${r.id}/change-email`, { email: 'evil@x.test' })
        .set({ Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' })
        .expect(403);
      await ctx.http
        .post(`/admin/registrations/${r.id}/change-email`)
        .set('Cookie', coordinator.cookie)
        .type('form')
        .send({ email: 'evil@x.test' })
        .expect(403); // no CSRF token
      expect((await reg('priya@nitp.test')).person.email).toBe('priya@nitp.test');
    });
  });

  // ---------- search ----------

  describe('search', () => {
    it('finds participants by name, email, mobile, roll number, college, registration ID and event', async () => {
      await submitRow(ctx, 'r1', row({ name: 'Priya', email: 'priya@nitp.test', college: 'NIT Patna', mobile: '9811122233', roll: '2201CS42' })).expect(200);
      await submitRow(ctx, 'r2', row({ name: 'Zoya', email: 'zoya@iitp.test', college: 'IIT Patna', sport: 'Football', mobile: '9700000001', roll: 'EE77' })).expect(200);
      const priya = await reg('priya@nitp.test');
      const shows = async (query: string) => {
        const text = (await getAs(ctx, coordinator, `/admin/registrations${query}`).expect(200)).text;
        return { priya: text.includes('>Priya<'), zoya: text.includes('>Zoya<') };
      };
      for (const q of ['priya', 'PRIYA@NITP', '98111 22233', '+91 98111-22233', '2201cs42', 'nit patna', priya.id]) {
        expect([q, await shows(`?q=${encodeURIComponent(q)}`)]).toEqual([q, { priya: true, zoya: false }]);
      }
      expect(await shows('?event=football')).toEqual({ priya: false, zoya: true });
      expect(await shows('?event=table-tennis')).toEqual({ priya: true, zoya: false });
    });
  });
});
