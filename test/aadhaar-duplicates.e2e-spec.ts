import { StaffRole } from '@prisma/client';
import { Ctx, Staff, flash, getAs, postAs, resetDatabase, staff, startApp, submitRow } from './e2e-helpers';

/**
 * ADMIN Duplicate Aadhaar Check (ParticipantProfile based): search first, full Aadhaar identity,
 * last 4 never merged, and the only place a registration can be deleted.
 */
describe('Duplicate Aadhaar Check (e2e)', () => {
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

  const row = (id: string, email: string, sport: string, aadhaar: string, name: string) =>
    submitRow(ctx, id, { 'Email Address': email, Name: name, 'College Name': 'IIT Patna', Sports: sport, 'Mobile No.': '9876500000', 'Aadhaar No.': aadhaar }).expect(200);
  const search = (aadhaar: string, who: Staff = admin) => postAs(ctx, who, '/admin/aadhaar-duplicates/search', { aadhaar });
  const headings = (text: string) => [...text.matchAll(/<h2 class="mono">XXXX XXXX (\d{4})[^—]*— (\d+) registration/g)].map((m) => [m[1], Number(m[2])]);

  async function seed() {
    await row('r1', 'rahul@example.com', 'Football', '1234 5678 9012', 'Rahul');
    await row('r2', 'rahul.alt@example.com', 'Cricket', '1234-5678-9012', 'Rahul');
    await row('r3', 'amit@example.com', 'Football', '5555 6666 9012', 'Amit'); // same last 4, different number
    await row('r4', 'sita@example.com', 'Chess', '1111 2222 3333', 'Sita');
  }

  it('23. admin only (server-side): coordinators and volunteers get 403, and do not see the link', async () => {
    await seed();
    for (const who of [coordinator, volunteer]) {
      await getAs(ctx, who, '/admin/aadhaar-duplicates').expect(403);
      await search('1234 5678 9012', who).expect(403);
      const reg = await ctx.prisma.registration.findFirstOrThrow();
      await getAs(ctx, who, `/admin/aadhaar-duplicates/registrations/${reg.id}/delete`).expect(403);
      await postAs(ctx, who, `/admin/aadhaar-duplicates/registrations/${reg.id}/delete`, { confirm: 'yes' }).expect(403);
    }
    expect(await ctx.prisma.registration.count()).toBe(4);
    expect((await getAs(ctx, coordinator, '/admin/registrations').expect(200)).text).not.toContain('Aadhaar duplicates');
  });

  it('24-26. search first; a full number finds its one profile (any format); last 4 never merges different numbers', async () => {
    await seed();
    const start = (await getAs(ctx, admin, '/admin/aadhaar-duplicates').expect(200)).text;
    expect(start).toContain('Search Aadhaar / last 4 digits');
    expect(headings(start)).toEqual([]); // nothing listed before a search

    const full = (await search('123456789012').expect(200)).text;
    expect(headings(full)).toEqual([['9012', 2]]); // Rahul's two emails, one profile
    expect(full).toContain('One participant profile (same full Aadhaar).');
    for (const shown of ['rahul@example.com', 'rahul.alt@example.com', 'Football', 'Cricket']) expect(full).toContain(shown);
    expect(full).not.toContain('Amit');
    expect(full).not.toContain('1234 5678 9012'); // masked

    const last4 = (await search('9012').expect(200)).text;
    expect(headings(last4).sort()).toEqual([['9012', 1], ['9012', 2]]);
    expect(last4).toContain('across 2 different participants');
    expect((await search('0000 0000 0000').expect(200)).text).toContain('No registrations with this Aadhaar number.');
  });

  it('shows actual duplicate registrations of one profile (older data: same Aadhaar, same event, two records)', async () => {
    await row('r1', 'rahul@example.com', 'Football', '1234 5678 9012', 'Rahul');
    await row('r2', 'rahul.alt@example.com', 'Cricket', '1234 5678 9012', 'Rahul');
    // Simulate an older duplicate: the second record also registered for Football before profiles existed.
    const alt = await ctx.prisma.person.findFirstOrThrow({ where: { email: 'rahul.alt@example.com' } });
    const cricket = await ctx.prisma.registration.findFirstOrThrow({ where: { personId: alt.id } });
    await ctx.prisma.registration.create({ data: { eventSlug: 'football', personId: alt.id, teamId: cricket.teamId, responseId: 'old-row' } });
    const text = (await search('1234 5678 9012').expect(200)).text;
    expect(text).toContain('<b>Duplicate registrations:</b> Football');
  });

  it('27-28. delete exists only here, needs confirmation, and removes just that registration', async () => {
    await seed();
    const football = await ctx.prisma.registration.findFirstOrThrow({ where: { eventSlug: 'football', person: { email: 'rahul@example.com' } }, include: { person: true } });
    const cricket = await ctx.prisma.registration.findFirstOrThrow({ where: { eventSlug: 'cricket' } });
    await postAs(ctx, admin, `/admin/registrations/${football.id}/verify`).expect(303);
    const token = (await ctx.prisma.person.findUniqueOrThrow({ where: { id: football.personId } })).qrToken!;
    await postAs(ctx, volunteer, `/p/${token}/enter`, { registrationId: football.id }).expect(303);

    // No Delete anywhere else.
    for (const path of ['/admin/registrations', '/admin/registrations?status=pending', `/admin/registrations/${football.id}`, `/admin/teams/${football.teamId}`]) {
      const text = (await getAs(ctx, admin, path).expect(200)).text;
      expect([path, text.includes('/delete')]).toEqual([path, false]);
    }
    expect((await getAs(ctx, volunteer, `/p/${token}`).expect(200)).text).not.toContain('/delete');
    expect((await search('1234 5678 9012').expect(200)).text).toContain(`/admin/aadhaar-duplicates/registrations/${football.id}/delete`);

    const confirm = (await getAs(ctx, admin, `/admin/aadhaar-duplicates/registrations/${football.id}/delete`).expect(200)).text;
    for (const shown of ['Are you sure you want to permanently delete this registration?', 'Rahul', 'Football', 'rahul@example.com']) expect(confirm).toContain(shown);
    expect(flash(await postAs(ctx, admin, `/admin/aadhaar-duplicates/registrations/${football.id}/delete`, {}).expect(303))).toBe('Tick the confirmation to delete the registration');
    expect(await ctx.prisma.registration.count({ where: { id: football.id } })).toBe(1);

    const res = await postAs(ctx, admin, `/admin/aadhaar-duplicates/registrations/${football.id}/delete`, { confirm: 'yes' }).expect(303);
    expect(flash(res)).toBe('Deleted the Football registration of Rahul');
    expect(await ctx.prisma.registration.count({ where: { id: football.id } })).toBe(0);
    // Everything else stays: other registrations, the person, QR token, profile, gate logs and emails (unlinked).
    expect(await ctx.prisma.registration.count({ where: { id: cricket.id } })).toBe(1);
    expect(await ctx.prisma.registration.count()).toBe(3);
    expect((await ctx.prisma.person.findUniqueOrThrow({ where: { id: football.personId } })).qrToken).toBe(token);
    expect(await ctx.prisma.participantProfile.count()).toBe(3);
    expect(await ctx.prisma.entryLog.count({ where: { personId: football.personId, registrationId: null } })).toBe(1);
    expect(await ctx.prisma.emailOutbox.count({ where: { personId: football.personId } })).toBe(1);
    const deletion = await ctx.prisma.registrationDeletion.findFirstOrThrow();
    expect(deletion).toMatchObject({ registrationId: football.id, deletedById: admin.id, eventSlug: 'football' });
    expect(JSON.stringify(deletion.snapshot)).toContain('PAYMENT_VERIFIED'); // its history is kept in the record

    // A resync of the same form row does not bring it back.
    const resync = await submitRow(ctx, 'r1', { 'Email Address': 'rahul@example.com', Name: 'Rahul', 'College Name': 'IIT Patna', Sports: 'Football', 'Aadhaar No.': '1234 5678 9012' }).expect(200);
    expect(resync.body.warnings.join(' ')).toMatch(/deleted by an admin; not recreated/);
    expect(await ctx.prisma.registration.count({ where: { eventSlug: 'football', personId: football.personId } })).toBe(0);
  });
});
