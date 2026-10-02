import { EntryKind, EntryStatus, PaymentStatus, StaffRole } from '@prisma/client';
import { Ctx, Staff, flash, getAs, postAs, resetDatabase, staff, startApp, submitRow } from './e2e-helpers';

/**
 * Planned dates from the form ("Check In/Out Date") vs actual QR IN/OUT, and participant blocking.
 */
describe('Expected dates, QR IN/OUT and blocking (e2e)', () => {
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

  const row = (name: string, college: string, arrival?: string, departure?: string) => ({
    'Email Address': `${name.toLowerCase()}@example.com`,
    'College Name': college,
    Sports: 'Football',
    Name: name,
    'Mobile No.': '9876500000',
    ...(arrival !== undefined ? { 'Check In Date': arrival } : {}),
    ...(departure !== undefined ? { 'Check Out Date': departure } : {}),
  });

  const reg = (name: string) =>
    ctx.prisma.registration.findFirstOrThrow({ where: { person: { email: `${name.toLowerCase()}@example.com` } }, include: { person: true } });

  async function verified(name: string) {
    const r = await reg(name);
    await postAs(ctx, coordinator, `/admin/registrations/${r.id}/verify`).expect(303);
    return reg(name);
  }

  const enter = (r: { id: string; person: { qrToken: string | null } }, who = volunteer) =>
    postAs(ctx, who, `/p/${r.person.qrToken}/enter`, { registrationId: r.id });
  const exit = (r: { id: string; person: { qrToken: string | null } }, who = volunteer) =>
    postAs(ctx, who, `/p/${r.person.qrToken}/exit`, { registrationId: r.id });

  /** Reads the labelled counter values on a page. */
  function counters(text: string): Record<string, number> {
    const out: Record<string, number> = {};
    for (const m of text.matchAll(/<div class="label">([^<]+)<\/div><div class="value">(\d+)<\/div>/g)) out[m[1]] = Number(m[2]);
    return out;
  }

  const festDay = (offset = 0) =>
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(Date.now() + offset * 86_400_000));

  // ---------- expected dates ----------

  describe('expected arrival / departure', () => {
    it('imports the form dates as PLANNED dates, separate from the actual gate times', async () => {
      await submitRow(ctx, 'r1', row('Priya', 'NIT Patna', '05/10/2026', '2026-10-07')).expect(200);
      const r = await reg('Priya');
      expect(r).toMatchObject({
        expectedArrivalText: '05/10/2026',
        expectedArrivalDate: new Date('2026-10-05T00:00:00.000Z'),
        expectedDepartureText: '2026-10-07',
        expectedDepartureDate: new Date('2026-10-07T00:00:00.000Z'),
        insideSince: null,
        enteredAt: null,
        lastCheckInAt: null,
        lastCheckOutAt: null,
      });
      const imported = await ctx.prisma.registrationActivity.findFirstOrThrow({ where: { type: 'SUBMITTED' } });
      expect(imported.details).toMatchObject({ expectedArrival: '05/10/2026', expectedDeparture: '2026-10-07' });
    });

    it('missing or unreadable dates never reject the registration', async () => {
      const res = await submitRow(ctx, 'r1', row('Priya', 'X', 'around Diwali')).expect(200);
      expect(res.body.warnings).toEqual(['Check In Date (expected arrival) "around Diwali" is not a recognised date; kept as text']);
      await submitRow(ctx, 'r2', row('Arjun', 'X')).expect(200);
      expect((await reg('Priya')).expectedArrivalDate).toBeNull();
      expect((await reg('Arjun')).expectedArrivalText).toBeNull();
    });

    it('EXPECTED ARRIVALS counts by planned date; "arrived" comes only from QR IN', async () => {
      await submitRow(ctx, 'r1', row('Priya', 'NIT Patna', '05/10/2026')).expect(200);
      await submitRow(ctx, 'r2', row('Arjun', 'NIT Patna', '05/10/2026')).expect(200);
      await submitRow(ctx, 'r3', row('Zoya', 'IIT Patna', '05/10/2026')).expect(200);
      await submitRow(ctx, 'r4', row('Kabir', 'NIT Patna', '06/10/2026')).expect(200);
      await enter(await verified('Priya')); // arrived (actual IN today, planned 5 Oct)
      await enter(await verified('Kabir')); // actually arrived, but planned for another day
      const zoya = await verified('Zoya');
      await postAs(ctx, coordinator, `/admin/registrations/${zoya.id}/block`, { reason: 'Registration issue' });

      const page = await getAs(ctx, coordinator, '/admin/arrivals?date=2026-10-05').expect(200);
      expect(counters(page.text)).toMatchObject({
        'Expected arrivals': 3,
        'Already arrived': 1,
        'Not arrived yet': 2,
        Blocked: 1,
      });
      expect(page.text).toContain('Expected arrivals: 05 Oct 2026');
      expect(page.text).not.toContain('Kabir');
      // College breakdown: NIT Patna 2 expected / 1 arrived; IIT Patna 1 expected / 0 arrived / 1 blocked.
      expect(page.text).toMatch(/NIT Patna<\/a><\/td>\s*<td class="num">2<\/td><td class="num">1<\/td><td class="num">1<\/td><td class="num">0<\/td>/);
      expect(page.text).toMatch(/IIT Patna<\/a><\/td>\s*<td class="num">1<\/td><td class="num">0<\/td><td class="num">1<\/td><td class="num">1<\/td>/);

      const nit = await ctx.prisma.college.findFirstOrThrow({ where: { nameKey: 'nit patna' } });
      const nitOnly = await getAs(ctx, coordinator, `/admin/arrivals?date=2026-10-05&college=${nit.id}`).expect(200);
      expect(counters(nitOnly.text)).toMatchObject({ 'Expected arrivals': 2, 'Already arrived': 1 });
    });

    it('EXPECTED DEPARTURES: checked out vs still inside come from QR OUT, not the form date', async () => {
      for (const [i, name] of ['Priya', 'Arjun', 'Meera', 'Zoya'].entries()) {
        await submitRow(ctx, `r${i}`, row(name, 'NIT Patna', '05/10/2026', '07/10/2026')).expect(200);
      }
      const priya = await verified('Priya');
      const arjun = await verified('Arjun');
      await enter(priya);
      await exit(priya); // checked out
      await enter(arjun); // still inside
      // Meera never arrived; Zoya pending.
      const page = await getAs(ctx, coordinator, '/admin/departures?date=2026-10-07').expect(200);
      expect(counters(page.text)).toMatchObject({
        'Expected departures': 4,
        'Checked out': 1,
        'Still inside': 1,
        'Never arrived': 2,
        Blocked: 0,
      });
    });

    it('today / tomorrow shortcuts and the registrations date filter', async () => {
      await submitRow(ctx, 'r1', row('Priya', 'X', festDay())).expect(200);
      await submitRow(ctx, 'r2', row('Arjun', 'X', festDay(1))).expect(200);
      const today = await getAs(ctx, coordinator, '/admin/arrivals?date=today').expect(200);
      expect(counters(today.text)['Expected arrivals']).toBe(1);
      expect(today.text).toContain('>Priya<');
      const tomorrow = await getAs(ctx, coordinator, '/admin/arrivals?date=tomorrow').expect(200);
      expect(tomorrow.text).toContain('>Arjun<');
      expect(tomorrow.text).not.toContain('>Priya<');
      const filtered = await getAs(ctx, coordinator, `/admin/registrations?arrival=${festDay(1)}`).expect(200);
      expect(filtered.text).toContain('>Arjun<');
      expect(filtered.text).not.toContain('>Priya<');
      await getAs(ctx, volunteer, '/admin/arrivals').expect(403);
    });
  });

  // ---------- QR IN / OUT ----------

  describe('QR IN / OUT cycle', () => {
    it('OUTSIDE shows CHECK IN, INSIDE shows CHECK OUT, and re-entry works; times are server times', async () => {
      await submitRow(ctx, 'r1', row('Priya', 'NIT Patna', '01/01/2020', '02/01/2020')).expect(200);
      const r = await verified('Priya');
      const pass = () => getAs(ctx, volunteer, `/p/${r.person.qrToken}`).expect(200).then((p) => p.text);

      expect(await pass()).toContain('MARK ENTERED (CHECK IN)');
      const before = Date.now();
      expect(flash(await enter(r))).toMatch(/^✅ ENTERED \(CHECK IN\): Priya · NIT Patna · Football · /);
      const inside = await pass();
      expect(inside).toContain('CHECK OUT (OUT)');
      expect(inside).not.toContain('MARK ENTERED (CHECK IN)');

      expect(flash(await exit(r))).toMatch(/^⬅ CHECKED OUT: Priya · NIT Patna · Football · /);
      expect(await pass()).toContain('MARK ENTERED (CHECK IN)');
      expect(flash(await enter(r))).toMatch(/^✅ ENTERED/);

      const after = await reg('Priya');
      // Actual times are "now", never the planned dates from the form (2020).
      expect(after.lastCheckInAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
      expect(after.lastCheckOutAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
      expect(after.expectedArrivalDate).toEqual(new Date('2020-01-01T00:00:00.000Z'));
      const logs = await ctx.prisma.entryLog.findMany({ where: { status: EntryStatus.ENTERED }, orderBy: { enteredAt: 'asc' } });
      expect(logs.map((l) => l.kind)).toEqual([EntryKind.CHECK_IN, EntryKind.CHECK_OUT, EntryKind.CHECK_IN]);
    });

    it('10 simultaneous IN -> 1 success; 10 simultaneous OUT -> 1 success', async () => {
      await submitRow(ctx, 'r1', row('Priya', 'X')).expect(200);
      const r = await verified('Priya');
      await Promise.all(Array.from({ length: 10 }, () => enter(r)));
      expect(await ctx.prisma.entryLog.count({ where: { kind: EntryKind.CHECK_IN, status: EntryStatus.ENTERED } })).toBe(1);
      await Promise.all(Array.from({ length: 10 }, () => exit(r)));
      expect(await ctx.prisma.entryLog.count({ where: { kind: EntryKind.CHECK_OUT, status: EntryStatus.ENTERED } })).toBe(1);
      expect((await reg('Priya')).insideSince).toBeNull();
    });

    it('invalid QR and unverified participants', async () => {
      await getAs(ctx, volunteer, '/p/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA').expect(404).then((p) => expect(p.text).toContain('INVALID QR'));
      await submitRow(ctx, 'r1', row('Priya', 'X')).expect(200);
      await submitRow(ctx, 'r2', row('Arjun', 'X')).expect(200);
      const priya = await verified('Priya');
      const arjun = await reg('Arjun');
      // Arjun is not verified; even his registration id with Priya's QR is refused.
      expect(flash(await postAs(ctx, volunteer, `/p/${priya.person.qrToken}/enter`, { registrationId: arjun.id }))).toBe(
        'INVALID QR: registration not found for this pass',
      );
      expect(flash(await postAs(ctx, coordinator, `/admin/registrations/${arjun.id}/check-in`))).toBe('NOT VERIFIED. Do not admit.');
    });
  });

  // ---------- block ----------

  describe('block / unblock', () => {
    it('a blocked QR is refused for IN and OUT (UI and direct POSTs); unblock restores it with the same pass', async () => {
      await submitRow(ctx, 'r1', row('Priya', 'NIT Patna')).expect(200);
      const r = await verified('Priya');
      const token = r.person.qrToken;

      expect(flash(await postAs(ctx, coordinator, `/admin/registrations/${r.id}/block`, { reason: 'Registration issue' }))).toBe(
        'Participant blocked: the QR is refused at the gate until unblocked',
      );
      const blocked = await reg('Priya');
      expect(blocked.person).toMatchObject({ blockReason: 'Registration issue', blockedById: coordinator.id });
      expect(blocked.person.blockedAt).not.toBeNull();

      const pass = await getAs(ctx, volunteer, `/p/${token}`).expect(200);
      expect(pass.text).toContain('ACCESS BLOCKED');
      expect(pass.text).toContain('Please contact the coordinator/admin');
      expect(pass.text).not.toContain('MARK ENTERED');
      expect(pass.text).not.toContain('CHECK OUT');
      expect(pass.text).not.toContain('Registration issue'); // the reason is internal

      const refused = 'ACCESS BLOCKED: registration access has been blocked. Please contact the coordinator/admin.';
      expect(flash(await enter(blocked))).toBe(refused);
      expect(flash(await exit(blocked))).toBe(refused);
      expect(flash(await postAs(ctx, coordinator, `/admin/registrations/${r.id}/check-in`))).toBe(refused);
      expect((await reg('Priya')).insideSince).toBeNull();
      expect(await ctx.prisma.entryLog.count({ where: { status: EntryStatus.REJECTED, notes: 'blocked' } })).toBe(3);

      const admin = await getAs(ctx, coordinator, '/admin/registrations').expect(200);
      expect(counters(admin.text).Blocked).toBe(1);
      const chip = await getAs(ctx, coordinator, '/admin/registrations?blocked=1').expect(200);
      expect(chip.text).toContain('>Priya<');

      expect(flash(await postAs(ctx, coordinator, `/admin/registrations/${r.id}/unblock`))).toBe(
        'Participant unblocked: the QR works again (same pass)',
      );
      const unblocked = await reg('Priya');
      expect(unblocked.person.qrToken).toBe(token);
      expect(unblocked.paymentStatus).toBe(PaymentStatus.VERIFIED);
      expect(flash(await enter(unblocked))).toMatch(/^✅ ENTERED/);

      const history = await ctx.prisma.registrationActivity.findMany({
        where: { registrationId: r.id, type: { in: ['BLOCKED', 'UNBLOCKED'] } },
        orderBy: { createdAt: 'asc' },
      });
      expect(history.map((h) => [h.type, h.actorId])).toEqual([
        ['BLOCKED', coordinator.id],
        ['UNBLOCKED', coordinator.id],
      ]);
      expect(history[0].details).toMatchObject({ reason: 'Registration issue' });
      expect(history[1].details).toMatchObject({ previousReason: 'Registration issue' });
    });

    it('blocked while INSIDE: history kept, no IN/OUT at the gate, admin-only override can record the exit', async () => {
      await submitRow(ctx, 'r1', row('Priya', 'X')).expect(200);
      const r = await verified('Priya');
      await enter(r);
      await postAs(ctx, coordinator, `/admin/registrations/${r.id}/block`, { reason: 'Misconduct' });

      expect(flash(await exit(r))).toMatch(/^ACCESS BLOCKED/);
      expect(flash(await enter(r))).toMatch(/^ACCESS BLOCKED/);
      expect((await reg('Priya')).insideSince).not.toBeNull(); // still recorded inside
      expect(await ctx.prisma.entryLog.count({ where: { kind: EntryKind.CHECK_IN, status: EntryStatus.ENTERED } })).toBe(1);

      await postAs(ctx, coordinator, `/admin/registrations/${r.id}/check-out-override`).expect(403); // coordinators can't
      await postAs(ctx, volunteer, `/admin/registrations/${r.id}/check-out-override`).expect(403);
      const admin = await staff(ctx, StaffRole.ADMIN, 'boss@staff.test');
      expect(flash(await postAs(ctx, admin, `/admin/registrations/${r.id}/check-out-override`))).toMatch(/^⬅ CHECKED OUT: .*\(admin override\)$/);
      const after = await reg('Priya');
      expect(after.insideSince).toBeNull();
      expect(after.person.blockedAt).not.toBeNull(); // still blocked
      const override = await ctx.prisma.registrationActivity.findFirstOrThrow({ where: { type: 'CHECKED_OUT' } });
      expect(override.details).toMatchObject({ adminOverride: true });
    });

    it('concurrent scans of a blocked QR: zero IN, zero OUT', async () => {
      await submitRow(ctx, 'r1', row('Priya', 'X')).expect(200);
      await submitRow(ctx, 'r2', row('Arjun', 'X')).expect(200);
      const priya = await verified('Priya');
      const arjun = await verified('Arjun');
      await enter(arjun); // Arjun inside before the block
      for (const r of [priya, arjun]) await postAs(ctx, coordinator, `/admin/registrations/${r.id}/block`);

      await Promise.all([...Array.from({ length: 10 }, () => enter(priya)), ...Array.from({ length: 10 }, () => exit(arjun))]);
      expect(await ctx.prisma.entryLog.count({ where: { personId: priya.personId, status: EntryStatus.ENTERED } })).toBe(0);
      expect(await ctx.prisma.entryLog.count({ where: { personId: arjun.personId, kind: EntryKind.CHECK_OUT, status: EntryStatus.ENTERED } })).toBe(0);
      expect((await reg('Priya')).insideSince).toBeNull();
      expect((await reg('Arjun')).insideSince).not.toBeNull();
    });

    it('unblocking during a burst of scans never corrupts the state', async () => {
      await submitRow(ctx, 'r1', row('Priya', 'X')).expect(200);
      const r = await verified('Priya');
      await postAs(ctx, coordinator, `/admin/registrations/${r.id}/block`);
      await Promise.all([
        ...Array.from({ length: 10 }, () => enter(r)),
        postAs(ctx, coordinator, `/admin/registrations/${r.id}/unblock`),
      ]);
      const ins = await ctx.prisma.entryLog.count({ where: { kind: EntryKind.CHECK_IN, status: EntryStatus.ENTERED } });
      const state = await reg('Priya');
      expect(ins).toBeLessThanOrEqual(1);
      expect(state.insideSince !== null).toBe(ins === 1); // presence matches the log exactly
      expect(state.person.blockedAt).toBeNull();
    });

    it('volunteers cannot block or unblock; double block/unblock is refused', async () => {
      await submitRow(ctx, 'r1', row('Priya', 'X')).expect(200);
      const r = await reg('Priya');
      await postAs(ctx, volunteer, `/admin/registrations/${r.id}/block`, { reason: 'x' }).expect(403);
      expect(flash(await postAs(ctx, coordinator, `/admin/registrations/${r.id}/unblock`))).toBe('Not blocked');
      await postAs(ctx, coordinator, `/admin/registrations/${r.id}/block`);
      expect(flash(await postAs(ctx, coordinator, `/admin/registrations/${r.id}/block`))).toBe('Already blocked');
      await postAs(ctx, volunteer, `/admin/registrations/${r.id}/unblock`).expect(403);
      expect((await reg('Priya')).person.blockedAt).not.toBeNull();
    });
  });
});
