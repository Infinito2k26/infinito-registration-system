import { StaffRole } from '@prisma/client';
import { Ctx, Staff, getAs, postAs, resetDatabase, staff, startApp, submitRow } from './e2e-helpers';

/**
 * ADMIN Aadhaar duplicate check: registrations sharing one Aadhaar number (form and manual entries),
 * compared on the 12 digits, shown masked. Report only; admin-only on the server.
 */
describe('Aadhaar duplicate check (e2e)', () => {
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

  const person = (id: string, name: string, sport: string, aadhaar?: string, email = `${name.toLowerCase()}@example.com`) =>
    submitRow(ctx, id, {
      'Email Address': email,
      Name: name,
      'College Name': 'IIT Patna',
      Sports: sport,
      'Mobile No.': '9876500000',
      ...(aadhaar !== undefined ? { 'Aadhaar No.': aadhaar } : {}),
    }).expect(200);

  async function seed() {
    // 3 registrations, 3 people, written three different ways.
    await person('r1', 'Rahul', 'Football', '1234 5678 9012');
    await person('r2', 'Amit', 'Football', '1234-5678-9012');
    await person('r3', 'Mohit', 'Cricket', '123456789012');
    // 2 registrations of the same person (two sports).
    await person('r4', 'Neha', 'Table Tennis', '5555 6666 7777');
    await person('r5', 'Neha', 'Chess', '5555 6666 7777');
    // Different numbers that only look alike: never grouped.
    await person('r6', 'Kiran', 'Chess', '1111 2222 3333');
    await person('r7', 'Lata', 'Chess', '1111 2222 3334');
    // No Aadhaar: excluded.
    await person('r8', 'Sita', 'Chess');
    // Manual participant + a form participant with the same number.
    await postAs(ctx, admin, '/admin/registrations/new', {
      submissionId: '11111111-2222-4333-8444-555555555555',
      name: 'Manoj',
      email: 'manoj@example.com',
      aadhaarNumber: '9999 8888 7777',
      sports: 'Badminton',
    }).expect(303);
    await person('r9', 'Vikas', 'Badminton', '9999-8888-7777');
  }

  /** "XXXX XXXX 9012 — 3 registrations" headings -> { last4: count }. */
  const groups = (text: string) =>
    Object.fromEntries([...text.matchAll(/<h2 class="mono">XXXX XXXX (\d{4})[^—]*— (\d+) registrations?/g)].map((m) => [m[1], Number(m[2])]));

  it('groups 2 and 3+ registrations sharing a number (spaces/hyphens ignored), incl. manual entries; excludes others', async () => {
    await seed();
    const page = (await getAs(ctx, admin, '/admin/aadhaar-duplicates').expect(200)).text;
    expect(groups(page)).toEqual({ '9012': 3, '7777': 2 });
    // Two different "…7777" numbers: Neha (one participant, two sports) and Manoj+Vikas.
    expect(page.match(/XXXX XXXX 7777/g)).toHaveLength(2);
    for (const shown of ['Rahul', 'Amit', 'Mohit', 'rahul@example.com', '9876500000', 'IIT Patna', 'Football', 'Cricket', '3 different participants', 'Manoj', 'Vikas', '>manual<']) {
      expect([shown, page.includes(shown)]).toEqual([shown, true]);
    }
    for (const hidden of ['Kiran', 'Lata', 'Sita', '1234 5678 9012', '123456789012', '1234-5678-9012']) {
      expect([hidden, page.includes(hidden)]).toEqual([hidden, false]); // never the full number
    }
    const rahul = await ctx.prisma.registration.findFirstOrThrow({ where: { person: { name: 'Rahul' } } });
    expect(page).toContain(`href="/admin/registrations/${rahul.id}"`);

    // Only numbers used by different participants: Neha's two sports drop out.
    const people = (await getAs(ctx, admin, '/admin/aadhaar-duplicates?people=1').expect(200)).text;
    expect(people.match(/<h2 class="mono">XXXX XXXX (\d{4})[^—]*— (\d+)/g)).toHaveLength(2); // 9012 and Manoj/Vikas 7777
    expect(people).not.toContain('Neha');
  });

  it('reporting changes nothing (no rejection, no verification)', async () => {
    await seed();
    await getAs(ctx, admin, '/admin/aadhaar-duplicates').expect(200);
    expect(await ctx.prisma.registration.count({ where: { paymentStatus: 'PENDING' } })).toBe(await ctx.prisma.registration.count());
  });

  it('search by the full number (any format) or the last 4 digits', async () => {
    await seed();
    const full = (await postAs(ctx, admin, '/admin/aadhaar-duplicates/search', { aadhaar: '1234-5678 9012' }).expect(200)).text;
    expect(full).toContain('This Aadhaar number: 3 registration(s)');
    for (const name of ['Rahul', 'Amit', 'Mohit']) expect(full).toContain(name);
    expect(full).not.toContain('123456789012');

    const last4 = (await postAs(ctx, admin, '/admin/aadhaar-duplicates/search', { aadhaar: '7777' }).expect(200)).text;
    expect(last4).toContain('4 registration(s) across 2 different numbers');
    for (const name of ['Neha', 'Manoj', 'Vikas']) expect(last4).toContain(name);

    const one = (await postAs(ctx, admin, '/admin/aadhaar-duplicates/search', { aadhaar: '1111 2222 3333' }).expect(200)).text;
    expect(one).toContain('This Aadhaar number: 1 registration(s)');
    expect(one).toContain('Kiran');

    const none = (await postAs(ctx, admin, '/admin/aadhaar-duplicates/search', { aadhaar: '0000 0000 0000' }).expect(200)).text;
    expect(none).toContain('No registrations with this Aadhaar number.');
    const bad = (await postAs(ctx, admin, '/admin/aadhaar-duplicates/search', { aadhaar: '12345' }).expect(200)).text;
    expect(bad).toContain('Enter the 12-digit Aadhaar number or its last 4 digits');
  });

  it('participants with only the last 4 digits (invalid number in the form) are not compared but are searchable', async () => {
    await person('r1', 'Ravi', 'Chess', '9012'); // stored as last 4 only
    await person('r2', 'Rahul', 'Chess', '1234 5678 9012');
    const page = (await getAs(ctx, admin, '/admin/aadhaar-duplicates').expect(200)).text;
    expect(groups(page)).toEqual({});
    expect(page).toContain('1 with only the last 4 digits');
    const last4 = (await postAs(ctx, admin, '/admin/aadhaar-duplicates/search', { aadhaar: '9012' }).expect(200)).text;
    expect(last4).toContain('2 registration(s) across 2 different numbers');
  });

  it('coordinators and volunteers cannot open or search it (server-side); only admins see the link', async () => {
    await seed();
    for (const who of [coordinator, volunteer]) {
      await getAs(ctx, who, '/admin/aadhaar-duplicates').expect(403);
      await postAs(ctx, who, '/admin/aadhaar-duplicates/search', { aadhaar: '1234 5678 9012' }).expect(403);
    }
    expect((await getAs(ctx, admin, '/admin/registrations').expect(200)).text).toContain('>Aadhaar duplicates<');
    expect((await getAs(ctx, coordinator, '/admin/registrations').expect(200)).text).not.toContain('Aadhaar duplicates');
  });
});
