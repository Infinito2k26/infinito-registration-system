import { EntryKind, EntryStatus, PaymentStatus, StaffRole } from '@prisma/client';
import { Ctx, Staff, flash, getAs, postAs, resetDatabase, staff, startApp, submitRow } from './e2e-helpers';

/**
 * Sports as the only event source, dashboard status/gate views, clickable participant rows,
 * and manual (no-QR) IN/OUT sharing the exact state of QR scanning.
 */
describe('Sports events, dashboard views and manual gate (e2e)', () => {
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

  const row = (name: string, sports: string | undefined, college = 'NIT Patna') => ({
    'Email Address': `${name.toLowerCase()}@example.com`,
    'College Name': college,
    ...(sports !== undefined ? { Sports: sports } : {}),
    Name: name,
    'Mobile No.': '9876500000',
  });

  const reg = (name: string, eventSlug?: string) =>
    ctx.prisma.registration.findFirstOrThrow({
      where: { person: { email: `${name.toLowerCase()}@example.com` }, ...(eventSlug ? { eventSlug } : {}) },
      include: { person: true },
    });

  async function verified(name: string, eventSlug?: string) {
    const r = await reg(name, eventSlug);
    await postAs(ctx, coordinator, `/admin/registrations/${r.id}/verify`).expect(303);
    return reg(name, eventSlug);
  }

  const qrIn = (r: { id: string; person: { qrToken: string | null } }) =>
    postAs(ctx, volunteer, `/p/${r.person.qrToken}/enter`, { registrationId: r.id });
  const qrOut = (r: { id: string; person: { qrToken: string | null } }) =>
    postAs(ctx, volunteer, `/p/${r.person.qrToken}/exit`, { registrationId: r.id });

  /** Names listed on a registrations page (rows link to /admin/registrations/<id>). */
  async function listed(query: string, who: Staff = coordinator) {
    const text = (await getAs(ctx, who, `/admin/registrations${query}`).expect(200)).text;
    const names = [...text.matchAll(/<tr data-href="\/admin\/registrations\/[0-9a-f-]+">\s*<td><a href="[^"]+">([^<]+)<\/a>/g)].map((m) => m[1]);
    const counters: Record<string, number> = {};
    for (const m of text.matchAll(/<div class="label">([^<]+)<\/div><div class="value">(\d+)<\/div>/g)) counters[m[1]] = Number(m[2]);
    return { text, names: names.sort(), counters };
  }

  // ---------- 1-4: Sports is the event ----------

  describe('Sports decides the event', () => {
    it('slugifies Sports into the event; EVENT_SLUG is not needed (and ignored if an old script sends it)', async () => {
      const football = await submitRow(ctx, 'r1', row('Priya', 'Football')).expect(200);
      expect(football.body.events).toEqual(['football']);
      const tt = await submitRow(ctx, 'r2', row('Arjun', 'Table Tennis'), 'cricket').expect(200); // legacy EVENT_SLUG ignored
      expect(tt.body.events).toEqual(['table-tennis']);
      expect((await reg('Arjun')).eventSlug).toBe('table-tennis');
      expect(await ctx.prisma.registration.count({ where: { eventSlug: 'cricket' } })).toBe(0);
    });

    it('rejects a row without Sports, with a clear error', async () => {
      const res = await submitRow(ctx, 'r1', row('Priya', undefined)).expect(422);
      expect(res.body.errors).toEqual(['Sports is missing: the sport/event must be chosen in the form']);
      await submitRow(ctx, 'r2', row('Arjun', '   ')).expect(422);
      expect(await ctx.prisma.person.count()).toBe(0);
    });

    it('the same person in several sports: one Person, one QR token, one registration per sport', async () => {
      await submitRow(ctx, 'r1', row('Priya', 'Football')).expect(200);
      await submitRow(ctx, 'r2', row('Priya', 'Badminton')).expect(200);
      await submitRow(ctx, 'r2', row('Priya', 'Badminton')).expect(200); // resync: idempotent
      expect(await ctx.prisma.person.count()).toBe(1);
      expect((await ctx.prisma.registration.findMany({ orderBy: { eventSlug: 'asc' } })).map((r) => r.eventSlug)).toEqual([
        'badminton',
        'football',
      ]);
      const a = await verified('Priya', 'football');
      const b = await verified('Priya', 'badminton');
      expect(a.person.qrToken).toBeTruthy();
      expect(b.person.qrToken).toBe(a.person.qrToken);
    });
  });

  // ---------- 5-8: dashboard views ----------

  describe('dashboard status and gate views', () => {
    /** Inside: Asha. Checked out: Bala. Never entered: Chitra. Pending: Dev. Blocked (outside): Esha. Rejected: Farid. */
    async function seed() {
      for (const [i, name] of ['Asha', 'Bala', 'Chitra', 'Dev', 'Esha', 'Farid'].entries()) {
        await submitRow(ctx, `r${i}`, row(name, i < 5 ? 'Football' : 'Chess')).expect(200);
      }
      const asha = await verified('Asha');
      const bala = await verified('Bala');
      await verified('Chitra');
      const esha = await verified('Esha');
      await qrIn(asha);
      await qrIn(bala);
      await qrOut(bala);
      await postAs(ctx, coordinator, `/admin/registrations/${esha.id}/block`, { reason: 'x' });
      await postAs(ctx, coordinator, `/admin/registrations/${(await reg('Farid')).id}/reject`, { remarks: 'not eligible' });
    }

    it('every tile/chip is a filter and the rows always match the counts', async () => {
      await seed();
      const all = await listed('');
      expect(all.names).toEqual(['Asha', 'Bala', 'Chitra', 'Dev', 'Esha', 'Farid']);
      expect(all.counters).toEqual({ Total: 6, Verified: 4, Pending: 1, Rejected: 1, Blocked: 1, Inside: 1, Outside: 5, 'Ever entered': 2 });

      const views: [string, string[]][] = [
        ['inside', ['Asha']],
        ['outside', ['Bala', 'Chitra', 'Dev', 'Esha', 'Farid']],
        ['entered', ['Asha', 'Bala']], // Bala checked out but has entered
        ['verified', ['Asha', 'Bala', 'Chitra', 'Esha']],
        ['pending', ['Dev']],
        ['rejected', ['Farid']],
        ['blocked', ['Esha']],
      ];
      for (const [view, names] of views) {
        const page = await listed(`?status=${view}`);
        expect([view, page.names]).toEqual([view, names]);
        expect(page.counters).toEqual(all.counters); // counts don't change with the view
        expect(page.text).toMatch(new RegExp(`<a class="counter [^"]* active" [^>]*href="/admin/registrations\\?status=${view}"`));
      }
      expect((await listed('?status=INSIDE')).names).toEqual(['Asha']); // any case
      expect((await listed('?blocked=1')).names).toEqual(['Esha']); // old link still works
    });

    it('views combine with event/search filters, and an empty view says why', async () => {
      await seed();
      const footballOutside = await listed('?event=football&status=outside');
      expect(footballOutside.names).toEqual(['Bala', 'Chitra', 'Dev', 'Esha']);
      expect(footballOutside.counters).toMatchObject({ Total: 5, Inside: 1, Outside: 4 });
      const search = await listed('?q=asha&status=inside');
      expect(search.names).toEqual(['Asha']);
      const chessInside = await listed('?event=chess&status=inside');
      expect(chessInside.names).toEqual([]);
      expect(chessInside.text).toContain('No registrations are <b>inside</b> under these filters. 1 registration(s) match otherwise');
      expect(chessInside.text).not.toContain('No registrations match.');
    });

    it('every row opens that participant’s page with the full record', async () => {
      await submitRow(ctx, 'r1', {
        ...row('Priya', 'Football'),
        'College Roll No.': '2201CS42',
        'Check In Date': '05/10/2026',
        'Check Out Date': '07/10/2026',
      }).expect(200);
      const r = await verified('Priya');
      await postAs(ctx, coordinator, `/admin/registrations/${r.id}/block`, { reason: 'Registration issue' });
      const list = await listed('');
      expect(list.text).toContain(`<tr data-href="/admin/registrations/${r.id}">`);
      const page = (await getAs(ctx, coordinator, `/admin/registrations/${r.id}`).expect(200)).text;
      for (const field of [
        'Priya',
        'priya@example.com',
        '9876500000',
        'NIT Patna',
        '2201CS42',
        'Football',
        'Verified',
        'QR pass</dt><dd>created',
        '05 Oct 2026',
        '07 Oct 2026',
        'Outside',
        'Actual check-in',
        'Actual check-out',
        'BLOCKED',
        'Reason: Registration issue',
        'History',
      ]) {
        expect([field, page.includes(field)]).toEqual([field, true]);
      }
    });
  });

  // ---------- 9-13: manual IN/OUT ----------

  describe('manual CHECK IN / CHECK OUT (no QR)', () => {
    it('participant page: CHECK IN when outside, CHECK OUT when inside; same state, EntryLog and history as QR', async () => {
      await submitRow(ctx, 'r1', row('Priya', 'Football')).expect(200);
      const r = await verified('Priya');
      const page = () => getAs(ctx, coordinator, `/admin/registrations/${r.id}`).expect(200).then((p) => p.text);
      expect(await page()).toContain('>CHECK IN</button>');

      expect(flash(await postAs(ctx, coordinator, `/admin/registrations/${r.id}/check-in`))).toMatch(/^✅ ENTERED \(CHECK IN\): Priya/);
      expect(await page()).toContain('>CHECK OUT</button>');
      // The QR now sees the same state: inside -> CHECK OUT works by scan.
      expect(flash(await qrOut(r))).toMatch(/^⬅ CHECKED OUT/);
      // ...and the participant page now refuses a second OUT, because the scan already did it.
      expect(flash(await postAs(ctx, coordinator, `/admin/registrations/${r.id}/check-out`))).toMatch(/^Cannot check out: not inside \(checked out at /);

      const logs = await ctx.prisma.entryLog.findMany({ where: { status: EntryStatus.ENTERED }, orderBy: { enteredAt: 'asc' } });
      expect(logs.map((l) => [l.kind, l.notes, l.volunteerId])).toEqual([
        [EntryKind.CHECK_IN, 'manual (no QR scan)', coordinator.id],
        [EntryKind.CHECK_OUT, null, volunteer.id],
      ]);
      const activity = await ctx.prisma.registrationActivity.findFirstOrThrow({ where: { type: 'ENTERED' } });
      expect(activity).toMatchObject({ actorId: coordinator.id, details: expect.objectContaining({ method: 'manual', at: expect.any(String) }) });
    });

    it('volunteers can do manual IN/OUT from the gate search (list: gate columns only; card: full details)', async () => {
      await submitRow(ctx, 'r1', row('Priya', 'Football')).expect(200);
      const r = await verified('Priya');
      const found = (await getAs(ctx, volunteer, '/scan/find?q=pri').expect(200)).text;
      expect(found).toContain(`/gate/${r.id}`);
      expect(found).not.toContain('priya@example.com');
      expect(found).not.toContain('9876500000');
      const card = (await getAs(ctx, volunteer, `/gate/${r.id}`).expect(200)).text;
      expect(card).toContain('Manual gate (no QR scanned)');
      expect(card).toContain('MARK ENTERED (CHECK IN)');
      expect(card).toContain('priya@example.com'); // volunteers see the full participant details

      expect(flash(await postAs(ctx, volunteer, '/gate/enter', { registrationId: r.id }))).toMatch(/^✅ ENTERED \(CHECK IN\)/);
      expect((await reg('Priya')).insideSince).not.toBeNull();
      expect(flash(await postAs(ctx, volunteer, '/gate/exit', { registrationId: r.id }))).toMatch(/^⬅ CHECKED OUT/);
      expect(await ctx.prisma.entryLog.count({ where: { status: EntryStatus.ENTERED, notes: 'manual (no QR scan)', volunteerId: volunteer.id } })).toBe(2);

      // Not signed in: nothing happens.
      await ctx.http.post('/gate/enter').type('form').send({ registrationId: r.id }).expect(303);
      expect((await reg('Priya')).insideSince).toBeNull();
      // Volunteers still can't use the admin participant page.
      await postAs(ctx, volunteer, `/admin/registrations/${r.id}/check-in`).expect(403);
    });

    it('simultaneous manual and QR check-ins (and check-outs) give exactly one state change', async () => {
      await submitRow(ctx, 'r1', row('Priya', 'Football')).expect(200);
      const r = await verified('Priya');
      await Promise.all([
        ...Array.from({ length: 4 }, () => qrIn(r)),
        ...Array.from({ length: 3 }, () => postAs(ctx, volunteer, '/gate/enter', { registrationId: r.id })),
        ...Array.from({ length: 3 }, () => postAs(ctx, coordinator, `/admin/registrations/${r.id}/check-in`)),
      ]);
      expect(await ctx.prisma.entryLog.count({ where: { kind: EntryKind.CHECK_IN, status: EntryStatus.ENTERED } })).toBe(1);
      await Promise.all([
        ...Array.from({ length: 4 }, () => qrOut(r)),
        ...Array.from({ length: 3 }, () => postAs(ctx, volunteer, '/gate/exit', { registrationId: r.id })),
        ...Array.from({ length: 3 }, () => postAs(ctx, admin, `/admin/registrations/${r.id}/check-out`)),
      ]);
      expect(await ctx.prisma.entryLog.count({ where: { kind: EntryKind.CHECK_OUT, status: EntryStatus.ENTERED } })).toBe(1);
      expect((await reg('Priya')).insideSince).toBeNull();
    });

    it('blocked participants cannot be manually checked in/out; the admin override still works', async () => {
      await submitRow(ctx, 'r1', row('Priya', 'Football')).expect(200);
      await submitRow(ctx, 'r2', row('Arjun', 'Football')).expect(200);
      const priya = await verified('Priya');
      const arjun = await verified('Arjun');
      await qrIn(arjun);
      for (const r of [priya, arjun]) await postAs(ctx, coordinator, `/admin/registrations/${r.id}/block`);

      const blocked = 'ACCESS BLOCKED: registration access has been blocked. Please contact the coordinator/admin.';
      expect(flash(await postAs(ctx, volunteer, '/gate/enter', { registrationId: priya.id }))).toBe(blocked);
      expect(flash(await postAs(ctx, coordinator, `/admin/registrations/${priya.id}/check-in`))).toBe(blocked);
      expect(flash(await postAs(ctx, volunteer, '/gate/exit', { registrationId: arjun.id }))).toBe(blocked);
      expect(flash(await postAs(ctx, coordinator, `/admin/registrations/${arjun.id}/check-out`))).toBe(blocked);
      const card = (await getAs(ctx, volunteer, `/gate/${priya.id}`).expect(200)).text;
      expect(card).toContain('ACCESS BLOCKED');
      expect(card).not.toContain('MARK ENTERED');
      expect((await reg('Priya')).insideSince).toBeNull();
      expect((await reg('Arjun')).insideSince).not.toBeNull();

      expect(flash(await postAs(ctx, admin, `/admin/registrations/${arjun.id}/check-out-override`))).toMatch(/\(admin override\)$/);
      expect((await reg('Arjun')).insideSince).toBeNull();
    });
  });

  // ---------- 14-15: change email ----------

  describe('change email permissions', () => {
    it('coordinators and admins can change email (same Person, QR, verification, gate history); volunteers cannot', async () => {
      await submitRow(ctx, 'r1', row('Priya', 'Football')).expect(200);
      const r = await verified('Priya');
      await qrIn(r);
      await qrOut(r);
      const logsBefore = await ctx.prisma.entryLog.count({ where: { personId: r.personId } });
      const gateBefore = await reg('Priya');

      await postAs(ctx, volunteer, `/admin/registrations/${r.id}/change-email`, { email: 'v@example.com' }).expect(403);
      expect(flash(await postAs(ctx, coordinator, `/admin/registrations/${r.id}/change-email`, { email: 'priya.c@example.com' }))).toMatch(
        /^Email changed from priya@example.com to priya.c@example.com/,
      );
      expect(flash(await postAs(ctx, admin, `/admin/registrations/${r.id}/change-email`, { email: 'priya.a@example.com' }))).toMatch(
        /^Email changed from priya.c@example.com to priya.a@example.com/,
      );

      const after = await ctx.prisma.registration.findUniqueOrThrow({ where: { id: r.id }, include: { person: true } });
      expect(after.personId).toBe(r.personId);
      expect(after.person).toMatchObject({ email: 'priya.a@example.com', qrToken: r.person.qrToken });
      expect(after.paymentStatus).toBe(PaymentStatus.VERIFIED);
      expect([after.enteredAt, after.lastCheckInAt, after.lastCheckOutAt]).toEqual([
        gateBefore.enteredAt,
        gateBefore.lastCheckInAt,
        gateBefore.lastCheckOutAt,
      ]);
      expect(await ctx.prisma.entryLog.count({ where: { personId: r.personId } })).toBe(logsBefore);
      expect((await ctx.prisma.personEmailAlias.findMany({ orderBy: { email: 'asc' } })).map((a) => a.email)).toEqual([
        'priya.c@example.com',
        'priya@example.com',
      ]);
      expect(await ctx.prisma.registrationActivity.count({ where: { type: 'EMAIL_CHANGED' } })).toBe(2);
    });
  });
});
