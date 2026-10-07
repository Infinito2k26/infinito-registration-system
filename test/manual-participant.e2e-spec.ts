import { ActivityType, EntryKind, EntryStatus, PaymentStatus, StaffRole } from '@prisma/client';
import { EmailTemplate } from '../src/emails/email-templates';
import { DUPLICATE_EMAIL_MESSAGE } from '../src/registrations/participants.service';
import { Ctx, Staff, flash, getAs, postAs, resetDatabase, staff, startApp, submitRow } from './e2e-helpers';

/**
 * ADMIN "Add Participant Manually": the entry goes through the normal import, so the participant
 * is a normal registration (PENDING -> Verify -> QR pass -> gate), never a separate system.
 */
describe('Add participant manually (e2e)', () => {
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

  const SUBMISSION = '11111111-2222-4333-8444-555555555555';
  const entry = (overrides: Record<string, string> = {}) => ({
    submissionId: SUBMISSION,
    name: 'Ravi Kumar',
    email: 'Ravi.Kumar@Example.com',
    phone: '+91 98765-43210',
    college: 'NIT  Patna',
    rollNumber: '2201CS99',
    idCardLink: 'https://drive.google.com/open?id=1CollegeIdManualFileIdAAAAA',
    aadhaarNumber: '1234 5678 9012',
    aadhaarCardLink: 'https://drive.google.com/file/d/1AadhaarManualFileIdBBBBBB/view',
    sports: 'Table Tennis',
    checkIn: '2026-10-10',
    checkOut: '2026-10-12',
    accommodation: 'Yes',
    accommodationPeriod: '2 nights',
    remark: 'Walk-in registration',
    ...overrides,
  });
  const add = (body: Record<string, string>, who: Staff = admin) => postAs(ctx, who, '/admin/registrations/new', body);
  const reg = (name = 'Ravi Kumar') => ctx.prisma.registration.findFirstOrThrow({ where: { person: { name } }, include: { person: true } });
  const qrRows = () => ctx.prisma.emailOutbox.findMany({ where: { template: EmailTemplate.QrPass } });

  it('1. admins get the button and the form; coordinators and volunteers do not', async () => {
    expect((await getAs(ctx, admin, '/admin/registrations').expect(200)).text).toContain('href="/admin/registrations/new">+ Add Participant Manually</a>');
    expect((await getAs(ctx, coordinator, '/admin/registrations').expect(200)).text).not.toContain('Add Participant Manually');
    const form = (await getAs(ctx, admin, '/admin/registrations/new').expect(200)).text;
    for (const name of ['name', 'email', 'phone', 'college', 'rollNumber', 'idCardLink', 'aadhaarNumber', 'aadhaarCardLink', 'sports', 'checkIn', 'checkOut', 'accommodation', 'accommodationPeriod', 'remark', 'submissionId', '_csrf']) {
      expect([name, form.includes(`name="${name}"`)]).toEqual([name, true]);
    }
  });

  it('3 + 4. coordinators and volunteers cannot open or submit it (server-side)', async () => {
    for (const who of [coordinator, volunteer]) {
      await getAs(ctx, who, '/admin/registrations/new').expect(403);
      await add(entry(), who).expect(403);
    }
    expect(await ctx.prisma.person.count()).toBe(0);
  });

  it('2 + 5 + 6. creates a normal PENDING registration through the import (same fields, lists and audit)', async () => {
    const res = await add(entry()).expect(303);
    const r = await reg();
    expect(res.headers.location).toBe(`/admin/registrations/${r.id}`);
    expect(flash(res)).toBe('Participant added (pending verification)');
    expect(r).toMatchObject({
      eventSlug: 'table-tennis',
      paymentStatus: PaymentStatus.PENDING,
      sourceForm: 'manual',
      responseId: `manual-${SUBMISSION}`,
      accommodation: 'Yes',
      accommodationPeriod: '2 nights',
      remark: 'Walk-in registration',
      expectedArrivalDate: new Date('2026-10-10T00:00:00.000Z'),
      expectedDepartureDate: new Date('2026-10-12T00:00:00.000Z'),
    });
    expect(r.person).toMatchObject({
      email: 'ravi.kumar@example.com',
      phone: '9876543210',
      college: 'NIT Patna',
      rollNumber: '2201CS99',
      aadhaarLast4: '9012',
      idDocumentDriveId: '1CollegeIdManualFileIdAAAAA',
      aadhaarDriveId: '1AadhaarManualFileIdBBBBBB',
      qrToken: null,
    });
    expect(r.person.aadhaarEncrypted).toMatch(/^v1:/); // never stored in plain text
    expect(r.teamId).not.toBeNull();
    const submitted = await ctx.prisma.registrationActivity.findFirstOrThrow({ where: { registrationId: r.id, type: ActivityType.SUBMITTED } });
    expect(submitted).toMatchObject({ actorId: admin.id, details: expect.objectContaining({ manual: true }) });

    // The normal lists, search and gate directory; the college is grouped like form imports.
    expect((await getAs(ctx, coordinator, '/admin/registrations?status=pending').expect(200)).text).toContain(`/admin/registrations/${r.id}`);
    expect((await getAs(ctx, coordinator, '/admin/registrations?q=2201CS99').expect(200)).text).toContain(`/admin/registrations/${r.id}`);
    expect((await getAs(ctx, volunteer, '/scan/find?q=ravi').expect(200)).text).toContain(`/gate/${r.id}`);
    expect(await ctx.prisma.college.count({ where: { name: 'NIT Patna' } })).toBe(1);
    const page = (await getAs(ctx, admin, `/admin/registrations/${r.id}`).expect(200)).text;
    expect(page).toContain('Added manually');
    expect(page).toContain('1234 5678 9012'); // admin: full Aadhaar
    expect((await getAs(ctx, coordinator, `/admin/registrations/${r.id}`).expect(200)).text).not.toContain('1234 5678'); // coordinator: last 4 only
    // 11. No "registration received" (or any) email on creation.
    expect(await ctx.prisma.emailOutbox.count()).toBe(0);
  });

  it('7-9 + 11 + 12. verified with the normal Verify: QR token, exactly one QR email, and the gate works', async () => {
    await add(entry()).expect(303);
    const r = await reg();
    expect(flash(await postAs(ctx, admin, `/admin/registrations/${r.id}/verify`).expect(303))).toMatch(/^Verified 1 participant/);
    const verified = await reg();
    expect([verified.paymentStatus, verified.paymentReviewedById]).toEqual([PaymentStatus.VERIFIED, admin.id]);
    expect(verified.person.qrToken).toMatch(/^[\w-]{43}$/);
    const rows = await qrRows();
    expect(rows.map((q) => [q.toEmail, q.idempotencyKey])).toEqual([['ravi.kumar@example.com', `qr-pass:${r.id}:initial`]]);
    await postAs(ctx, admin, `/admin/registrations/${r.id}/verify`).expect(303); // again: nothing new
    expect(await qrRows()).toHaveLength(1);
    expect(await ctx.prisma.emailOutbox.count({ where: { template: EmailTemplate.RegistrationReceived } })).toBe(0);

    // Scan + gate IN/OUT with the QR token, exactly like a form registration.
    const token = verified.person.qrToken!;
    expect((await getAs(ctx, volunteer, `/scan/go?code=${token}`).expect(303)).headers.location).toBe(`/p/${token}`);
    expect(flash(await postAs(ctx, volunteer, `/p/${token}/enter`, { registrationId: r.id }))).toMatch(/^✅ ENTERED/);
    expect(flash(await postAs(ctx, volunteer, `/p/${token}/exit`, { registrationId: r.id }))).toMatch(/^⬅ CHECKED OUT/);
    const logs = await ctx.prisma.entryLog.findMany({ where: { status: EntryStatus.ENTERED }, orderBy: { enteredAt: 'asc' } });
    expect(logs.map((l) => l.kind)).toEqual([EntryKind.CHECK_IN, EntryKind.CHECK_OUT]);
    expect((await reg()).enteredAt).not.toBeNull(); // Ever entered
  });

  it('10. without an email: created and verified with a QR token, no email job; reject/undo work as usual', async () => {
    await add(entry({ email: '', name: 'Sita Devi', aadhaarNumber: '' })).expect(303);
    const r = await reg('Sita Devi');
    expect(r.person.email).toBeNull();
    await postAs(ctx, admin, `/admin/registrations/${r.id}/verify`).expect(303);
    expect((await reg('Sita Devi')).person.qrToken).toBeTruthy();
    expect(await ctx.prisma.emailOutbox.count()).toBe(0);
    await postAs(ctx, admin, `/admin/registrations/${r.id}/undo`).expect(303);
    expect((await reg('Sita Devi')).paymentStatus).toBe(PaymentStatus.PENDING);
    await postAs(ctx, admin, `/admin/registrations/${r.id}/reject`, { remarks: 'Not eligible' }).expect(303);
    expect((await reg('Sita Devi')).paymentStatus).toBe(PaymentStatus.REJECTED);
  });

  it('13. a duplicate email (any case) is refused; nothing is created or merged', async () => {
    await submitRow(ctx, 'r1', { 'Email Address': 'asha@example.com', Name: 'Asha', 'College Name': 'IIT Patna', Sports: 'Chess' }).expect(200);
    const res = await add(entry({ email: 'ASHA@example.com' })).expect(422);
    expect(res.text).toContain(DUPLICATE_EMAIL_MESSAGE);
    expect(res.text).toContain('value="Ravi Kumar"'); // the form keeps what was typed
    expect(await ctx.prisma.person.count()).toBe(1);
    expect((await ctx.prisma.person.findFirstOrThrow()).name).toBe('Asha'); // untouched
  });

  it('rejects invalid input with clear messages instead of saving bad data', async () => {
    const res = await add(entry({ email: 'not-an-email', phone: '12', aadhaarNumber: '1234', sports: '', idCardLink: 'my photo', checkIn: 'soon' })).expect(422);
    for (const message of ['"not-an-email" is not a valid email', '"12" is not a valid mobile number', 'Aadhaar number must have 12 digits', 'Sports / event is required', 'College ID card: not a Google Drive link or file ID', 'Check In Date "soon" is not a date']) {
      expect([message, res.text.includes(message.replace(/"/g, '&quot;'))]).toEqual([message, true]);
    }
    expect(await ctx.prisma.person.count()).toBe(0);
  });

  it('a double submit of the same entry creates it once; several sports = one registration each, one person', async () => {
    const both = await Promise.all([add(entry()), add(entry())]);
    expect(both.map((r) => r.status)).toEqual([303, 303]); // both land on the same participant
    expect(new Set(both.map((r) => r.headers.location)).size).toBe(1);
    expect(await ctx.prisma.person.count()).toBe(1);
    expect(await ctx.prisma.registration.count()).toBe(1);
    await add(entry({ submissionId: '99999999-2222-4333-8444-555555555555', name: 'Mira', email: 'mira@example.com', sports: 'Table Tennis, Chess' })).expect(303);
    const mira = await ctx.prisma.registration.findMany({ where: { person: { name: 'Mira' } } });
    expect(mira.map((m) => m.eventSlug).sort()).toEqual(['chess', 'table-tennis']);
    expect(new Set(mira.map((m) => m.personId)).size).toBe(1);
  });
});
