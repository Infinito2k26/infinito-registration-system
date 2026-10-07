import { EmailStatus, EntryKind, EntryStatus, PaymentStatus, StaffRole } from '@prisma/client';
import { EmailTemplate } from '../src/emails/email-templates';
import { MailTransport, OutgoingEmail, PermanentSendError } from '../src/emails/mail-transport';
import { ParticipantProfileService } from '../src/registrations/participant-profile.service';
import { Ctx, Staff, flash, getAs, postAs, resetDatabase, staff, startApp, submitRow } from './e2e-helpers';

/**
 * ONE FULL AADHAAR = ONE PARTICIPANT PROFILE = MANY REGISTRATIONS. Registrations, QR tokens,
 * emails and gate logs stay as they are; profiles only group them.
 */
describe('Aadhaar participant profiles (e2e)', () => {
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

  const A = '1234 5678 9012';
  const B = '9876 5432 1098';
  const row = (id: string, email: string | undefined, sport: string, aadhaar: string | undefined, name = 'Asha Rao') =>
    submitRow(ctx, id, {
      ...(email ? { 'Email Address': email } : {}),
      Name: name,
      'College Name': 'IIT Patna',
      Sports: sport,
      'Mobile No.': '9876500000',
      ...(aadhaar ? { 'Aadhaar No.': aadhaar } : {}),
    });
  const regsOf = (profileId: string) =>
    ctx.prisma.registration.findMany({ where: { person: { participantProfileId: profileId } }, include: { person: true }, orderBy: { eventSlug: 'asc' } });
  const personBy = (email: string) => ctx.prisma.person.findFirstOrThrow({ where: { email } });
  const regBy = (email: string, eventSlug: string) => ctx.prisma.registration.findFirstOrThrow({ where: { eventSlug, person: { email } }, include: { person: true } });
  const verify = async (email: string, eventSlug: string) => postAs(ctx, admin, `/admin/registrations/${(await regBy(email, eventSlug)).id}/verify`).expect(303);

  function fakeTransport(failFor: string[] = []) {
    const sent: OutgoingEmail[] = [];
    const transport: MailTransport = {
      name: 'fake',
      send: (email) => {
        if (failFor.includes(email.to)) return Promise.reject(new PermanentSendError('550 mailbox does not exist'));
        sent.push(email);
        return Promise.resolve(`msg-${sent.length}-${email.to}`);
      },
    };
    const worker = ctx.worker as unknown as { transport: MailTransport };
    const original = worker.transport;
    worker.transport = transport;
    return { sent, restore: () => (worker.transport = original) };
  }

  // ---------- profile creation and registration rules ----------

  it('1-7. one full Aadhaar = one profile: new event = new registration, same event = no duplicate, any email', async () => {
    await row('r1', 'asha@example.com', '100mt', A).expect(200); // 1. new Aadhaar -> new profile
    expect(await ctx.prisma.participantProfile.count()).toBe(1);
    const profile = await ctx.prisma.participantProfile.findFirstOrThrow();
    expect(profile.aadhaarLast4).toBe('9012');
    expect(JSON.stringify(profile)).not.toContain('123456789012'); // never the plain number

    // 2 + 4 + 6. Same Aadhaar (other format), other email, other event -> same profile, new registration.
    await row('r2', 'asha.alt@example.com', '200mt', '1234-5678-9012').expect(200);
    expect(await ctx.prisma.participantProfile.count()).toBe(1);
    expect((await regsOf(profile.id)).map((r) => [r.eventSlug, r.person.email])).toEqual([
      ['100mt', 'asha@example.com'],
      ['200mt', 'asha.alt@example.com'],
    ]);

    // 3. Different Aadhaar -> different profile.
    await row('r3', 'bina@example.com', '100mt', B, 'Bina').expect(200);
    expect(await ctx.prisma.participantProfile.count()).toBe(2);

    // 5 + 7. Same Aadhaar + same event, third email -> no duplicate registration; the email is kept on the profile.
    const dup = await row('r4', 'asha.third@example.com', '100mt', '123456789012').expect(200);
    expect(dup.body.warnings.join(' ')).toMatch(/same Aadhaar is already registered for 100mt.*duplicate registration not created/);
    await row('r4', 'asha.third@example.com', '100mt', A).expect(200); // resync: still none
    expect((await regsOf(profile.id)).filter((r) => r.eventSlug === '100mt')).toHaveLength(1);
    expect((await personBy('asha.third@example.com')).participantProfileId).toBe(profile.id);
    // Same email + same event again (existing behaviour): updated, not duplicated.
    await row('r1', 'asha@example.com', '100mt', A).expect(200);
    expect(await regsOf(profile.id)).toHaveLength(2);

    // The participant page shows every email of the profile and the profile's registrations.
    const page = (await getAs(ctx, admin, `/admin/registrations/${(await regBy('asha@example.com', '100mt')).id}`).expect(200)).text;
    for (const shown of ['<h2>Participant profile</h2>', 'asha@example.com', 'asha.alt@example.com', 'asha.third@example.com', 'Registrations</dt><dd>2 · Events: 2 · QR codes generated: 0']) {
      expect([shown, page.includes(shown)]).toEqual([shown, true]);
    }
    // Participants without Aadhaar get no profile and keep working as before.
    await row('r5', 'sita@example.com', 'Chess', undefined, 'Sita').expect(200);
    expect((await personBy('sita@example.com')).participantProfileId).toBeNull();
  });

  it('32. concurrent rows with the same Aadhaar create one profile and one registration per event', async () => {
    const results = await Promise.all([
      row('c1', 'p1@example.com', 'Relay', A),
      row('c2', 'p2@example.com', 'Relay', A),
      row('c3', 'p3@example.com', 'Kabaddi', A),
      row('c4', 'p4@example.com', '100mt', A),
    ]);
    // Any request that lost a race is answered "retry" (503) and the Apps Script retries it.
    for (const r of results.filter((x) => x.status === 503)) expect(r.body.retry).toBe(true);
    await Promise.all([row('c1', 'p1@example.com', 'Relay', A), row('c2', 'p2@example.com', 'Relay', A), row('c3', 'p3@example.com', 'Kabaddi', A), row('c4', 'p4@example.com', '100mt', A)]);
    expect(await ctx.prisma.participantProfile.count()).toBe(1);
    const regs = await ctx.prisma.registration.findMany({ select: { eventSlug: true } });
    expect(regs.map((r) => r.eventSlug).sort()).toEqual(['100mt', 'kabaddi', 'relay']);
  });

  // ---------- QR and gate ----------

  it('13-15. any QR of the profile opens the same participant and can act on its registrations; other profiles cannot', async () => {
    await row('r1', 'asha@example.com', '100mt', A).expect(200);
    await row('r2', 'asha.alt@example.com', '200mt', A).expect(200);
    await row('r3', 'bina@example.com', '100mt', B, 'Bina').expect(200);
    for (const [email, event] of [['asha@example.com', '100mt'], ['asha.alt@example.com', '200mt'], ['bina@example.com', '100mt']]) await verify(email, event);
    const q1 = (await personBy('asha@example.com')).qrToken!;
    const q2 = (await personBy('asha.alt@example.com')).qrToken!;
    const qb = (await personBy('bina@example.com')).qrToken!;
    expect(new Set([q1, q2, qb]).size).toBe(3); // QR tokens are per email record and unchanged
    const r200 = await regBy('asha.alt@example.com', '200mt');

    for (const token of [q1, q2]) {
      const card = (await getAs(ctx, volunteer, `/p/${token}`).expect(200)).text;
      expect([card.includes('<h2>100mt</h2>') || card.includes('100mt'), card.includes('200mt')]).toEqual([true, true]);
    }
    // QR 1 checks in the 200mt registration (other email record, same Aadhaar).
    expect(flash(await postAs(ctx, volunteer, `/p/${q1}/enter`, { registrationId: r200.id }))).toMatch(/^✅ ENTERED/);
    expect((await regBy('asha.alt@example.com', '200mt')).insideSince).not.toBeNull();
    // Another participant's QR cannot act on it.
    expect(flash(await postAs(ctx, volunteer, `/p/${qb}/exit`, { registrationId: r200.id }))).toBe('INVALID QR: registration not found for this pass');
    expect(flash(await postAs(ctx, volunteer, `/p/${q2}/exit`, { registrationId: r200.id }))).toMatch(/^⬅ CHECKED OUT/);
    const logs = await ctx.prisma.entryLog.findMany({ where: { registrationId: r200.id, status: EntryStatus.ENTERED }, orderBy: { enteredAt: 'asc' } });
    expect(logs.map((l) => l.kind)).toEqual([EntryKind.CHECK_IN, EntryKind.CHECK_OUT]);
    // A verified participant is admitted whichever registration is used (one physical status);
    // a participant with no verified registration at all is still refused (see below).
    await row('r4', 'asha.alt@example.com', 'Relay', A).expect(200);
    expect(flash(await postAs(ctx, volunteer, `/p/${q1}/enter`, { registrationId: (await regBy('asha.alt@example.com', 'relay')).id }))).toMatch(/^✅ ENTERED/);
  });

  // ---------- one IN/OUT status per participant ----------

  describe('gate entry is per participant (profile), not per event', () => {
    async function threeRegistrations() {
      await row('r1', 'asha@example.com', '100mt', A).expect(200);
      await row('r2', 'asha@example.com', '200mt', A).expect(200); // same email record, second event
      await row('r3', 'asha.alt@example.com', 'Relay', A).expect(200); // other email record
      await verify('asha@example.com', '100mt');
      await verify('asha@example.com', '200mt');
      await verify('asha.alt@example.com', 'relay');
      return {
        r100: await regBy('asha@example.com', '100mt'),
        r200: await regBy('asha@example.com', '200mt'),
        relay: await regBy('asha.alt@example.com', 'relay'),
        q1: (await personBy('asha@example.com')).qrToken!,
        q2: (await personBy('asha.alt@example.com')).qrToken!,
      };
    }
    const states = async () =>
      (await ctx.prisma.registration.findMany({ orderBy: { eventSlug: 'asc' }, select: { eventSlug: true, insideSince: true, enteredAt: true } })).map((r) => [r.eventSlug, r.insideSince !== null, r.enteredAt !== null]);
    const enter = (token: string, registrationId: string) => postAs(ctx, volunteer, `/p/${token}/enter`, { registrationId });
    const exit = (token: string, registrationId: string) => postAs(ctx, volunteer, `/p/${token}/exit`, { registrationId });

    it('IN with one QR puts the whole participant INSIDE; another QR/event sees ALREADY ENTERED; OUT applies to all', async () => {
      const { r100, r200, relay, q1, q2 } = await threeRegistrations();
      expect(flash(await enter(q1, r100.id))).toMatch(/^✅ ENTERED/);
      expect(await states()).toEqual([['100mt', true, true], ['200mt', true, true], ['relay', true, true]]);
      expect(flash(await enter(q2, relay.id))).toMatch(/^ALREADY ENTERED/); // other QR, other event: same person
      expect(flash(await enter(q1, r200.id))).toMatch(/^ALREADY ENTERED/); // same QR, other event
      expect(flash(await exit(q2, relay.id))).toMatch(/^⬅ CHECKED OUT/);
      expect(await states()).toEqual([['100mt', false, true], ['200mt', false, true], ['relay', false, true]]);
      expect(flash(await exit(q1, r100.id))).toMatch(/^Cannot check out: not inside/);
      // One gate log row per physical action, not per event.
      const logs = await ctx.prisma.entryLog.findMany({ where: { status: 'ENTERED' }, orderBy: { enteredAt: 'asc' } });
      expect(logs.map((l) => l.kind)).toEqual([EntryKind.CHECK_IN, EntryKind.CHECK_OUT]);
      // Inside / Ever entered lists follow: all three registrations, together.
      const ever = (await getAs(ctx, coordinator, '/admin/registrations?status=entered').expect(200)).text;
      for (const r of [r100, r200, relay]) expect(ever).toContain(`/admin/registrations/${r.id}`);
    });

    it('the gate card has ONE status and ONE button for the participant', async () => {
      const { r100, q2 } = await threeRegistrations();
      let card = (await getAs(ctx, volunteer, `/p/${q2}`).expect(200)).text;
      expect(card.match(/MARK ENTERED \(CHECK IN\)/g)).toHaveLength(1);
      expect(card).toContain('One IN/OUT status for this participant (all 3 registrations)');
      await enter(q2, r100.id).expect(303);
      card = (await getAs(ctx, volunteer, `/p/${q2}`).expect(200)).text;
      expect(card.match(/CHECK OUT \(OUT\)/g)).toHaveLength(1);
      expect(card).not.toContain('MARK ENTERED');
      // The manual gate and the participant page operate the same status.
      expect(flash(await postAs(ctx, volunteer, '/gate/exit', { registrationId: r100.id }))).toMatch(/^⬅ CHECKED OUT/);
      expect((await states()).every(([, inside]) => inside === false)).toBe(true);
      expect(flash(await postAs(ctx, admin, `/admin/registrations/${r100.id}/check-in`).expect(303))).toMatch(/^✅ ENTERED/);
      expect((await states()).every(([, inside]) => inside === true)).toBe(true);
    });

    it('same email, no Aadhaar: still one status across events', async () => {
      await row('r1', 'sita@example.com', 'Chess', undefined, 'Sita').expect(200);
      await row('r2', 'sita@example.com', 'Carrom', undefined, 'Sita').expect(200);
      await verify('sita@example.com', 'chess');
      await verify('sita@example.com', 'carrom');
      const token = (await personBy('sita@example.com')).qrToken!;
      expect(flash(await enter(token, (await regBy('sita@example.com', 'chess')).id))).toMatch(/^✅ ENTERED/);
      expect(flash(await enter(token, (await regBy('sita@example.com', 'carrom')).id))).toMatch(/^ALREADY ENTERED/);
      expect(await states()).toEqual([['carrom', true, true], ['chess', true, true]]);
    });

    it('verification: admitted if ANY registration is verified (all go inside); refused if none is', async () => {
      await row('r1', 'asha@example.com', '100mt', A).expect(200);
      await row('r2', 'asha@example.com', '200mt', A).expect(200);
      await verify('asha@example.com', '100mt');
      const token = (await personBy('asha@example.com')).qrToken!;
      await row('r3', 'bina@example.com', '100mt', B, 'Bina').expect(200);
      await verify('bina@example.com', '100mt');
      await postAs(ctx, admin, `/admin/registrations/${(await regBy('bina@example.com', '100mt')).id}/undo`).expect(303);
      const binaToken = (await personBy('bina@example.com')).qrToken!;
      expect(flash(await enter(binaToken, (await regBy('bina@example.com', '100mt')).id))).toBe('NOT VERIFIED. Do not admit.');
      // Asha: 200mt is still pending, but she is a verified participant.
      expect(flash(await enter(token, (await regBy('asha@example.com', '200mt')).id))).toMatch(/^✅ ENTERED/);
      expect((await regBy('asha@example.com', '100mt')).insideSince).not.toBeNull();
    });

    it('concurrent IN with two different QR codes of the same participant: exactly one entry', async () => {
      const { r100, relay, q1, q2 } = await threeRegistrations();
      const results = await Promise.all([enter(q1, r100.id), enter(q2, relay.id), enter(q1, r100.id), enter(q2, relay.id)]);
      expect(results.filter((r) => /^✅ ENTERED/.test(flash(r) ?? ''))).toHaveLength(1);
      expect(await ctx.prisma.entryLog.count({ where: { status: 'ENTERED', kind: EntryKind.CHECK_IN } })).toBe(1);
    });

    it('older data with only some registrations inside: the participant counts as inside; OUT clears all', async () => {
      const { r100, r200, relay, q1 } = await threeRegistrations();
      await ctx.prisma.registration.update({ where: { id: relay.id }, data: { insideSince: new Date(), lastCheckInAt: new Date(), enteredAt: new Date() } });
      expect(flash(await enter(q1, r100.id))).toMatch(/^ALREADY ENTERED/);
      expect(flash(await exit(q1, r200.id))).toMatch(/^⬅ CHECKED OUT/);
      expect((await states()).every(([, inside]) => inside === false)).toBe(true);
    });
  });

  // ---------- email statistics ----------

  it('16-18, 20-21. profile email counts and history come from EmailOutbox (sent / queued / failed), QR not duplicated', async () => {
    await row('r1', 'asha@example.com', '100mt', A).expect(200);
    await row('r2', 'asha.alt@example.com', '200mt', A).expect(200);
    await row('r3', 'asha.bounce@example.com', 'Relay', A).expect(200);
    await verify('asha@example.com', '100mt');
    await verify('asha.bounce@example.com', 'relay');
    const fake = fakeTransport(['asha.bounce@example.com']);
    try {
      await ctx.worker.processBatch(); // 100mt QR -> SENT, relay QR -> FAILED
    } finally {
      fake.restore();
    }
    await verify('asha.alt@example.com', '200mt'); // queued, not processed
    await verify('asha@example.com', '100mt'); // again: no second QR email
    const rows = await ctx.prisma.emailOutbox.findMany({ where: { template: EmailTemplate.QrPass } });
    expect(rows.map((r) => [r.toEmail, r.status]).sort()).toEqual([
      ['asha.alt@example.com', EmailStatus.PENDING],
      ['asha.bounce@example.com', EmailStatus.FAILED],
      ['asha@example.com', EmailStatus.SENT],
    ]);
    const page = (await getAs(ctx, admin, `/admin/registrations/${(await regBy('asha@example.com', '100mt')).id}`).expect(200)).text;
    for (const shown of ['Sent: 1 · Queued: 1 · Failed: 1', 'Total email records: 3', 'QR codes generated: 3', 'as***@example.com', '550 mailbox does not exist', 'asha.bounce@example.com']) {
      expect([shown, page.includes(shown)]).toEqual([shown, true]);
    }
    expect((await getAs(ctx, coordinator, `/admin/registrations/${(await regBy('asha@example.com', '100mt')).id}`).expect(200)).text).not.toContain('1234 5678 9012');
  });

  // ---------- existing data: backfill ----------

  it('8-12, 19, 22. backfill groups existing Person records by full Aadhaar without changing or requeueing anything', async () => {
    // Existing data: two Person records with the same Aadhaar, verified, emails sent, one gate IN/OUT.
    await row('r1', 'asha@example.com', '100mt', A).expect(200);
    await row('r2', 'asha.alt@example.com', '200mt', A).expect(200);
    await row('r3', 'bina@example.com', '100mt', B, 'Bina').expect(200);
    await verify('asha@example.com', '100mt');
    await verify('asha.alt@example.com', '200mt');
    const fake = fakeTransport();
    try {
      await ctx.worker.processBatch();
    } finally {
      fake.restore();
    }
    const asha = await regBy('asha@example.com', '100mt');
    await postAs(ctx, volunteer, `/p/${asha.person.qrToken}/enter`, { registrationId: asha.id }).expect(303);
    await postAs(ctx, volunteer, `/p/${asha.person.qrToken}/exit`, { registrationId: asha.id }).expect(303);
    // ...as it was before profiles existed.
    await ctx.prisma.person.updateMany({ data: { participantProfileId: null } });
    await ctx.prisma.participantProfile.deleteMany();

    const snapshot = async () => ({
      registrations: await ctx.prisma.registration.findMany({ orderBy: { id: 'asc' }, select: { id: true, personId: true, eventSlug: true, paymentStatus: true, teamId: true, enteredAt: true, insideSince: true } }),
      tokens: await ctx.prisma.person.findMany({ orderBy: { id: 'asc' }, select: { id: true, email: true, qrToken: true, blockedAt: true } }),
      emails: await ctx.prisma.emailOutbox.findMany({ orderBy: { id: 'asc' }, select: { id: true, status: true, attempts: true, sentAt: true, registrationId: true, personId: true } }),
      logs: await ctx.prisma.entryLog.findMany({ orderBy: { id: 'asc' }, select: { id: true, registrationId: true, kind: true } }),
      activities: await ctx.prisma.registrationActivity.count(),
    });
    const before = await snapshot();
    const service = ctx.app.get(ParticipantProfileService);

    const dry = await service.backfill(false);
    expect(await ctx.prisma.participantProfile.count()).toBe(0); // dry run writes nothing
    expect(dry).toMatchObject({ applied: false, distinctAadhaar: 2, profilesCreated: 2, peopleLinked: 3, groupsWithSeveralPeople: 1, countsUnchanged: true });

    const report = await service.backfill(true);
    expect(report).toMatchObject({ applied: true, profilesCreated: 2, peopleLinked: 3, groupsWithSeveralPeople: 1, peopleInSharedGroups: 2, registrationsLinked: 3, countsUnchanged: true });
    expect(report.after).toEqual(report.before);
    expect(await snapshot()).toEqual(before); // registrations, QR tokens, emails, gate logs, activity: identical
    const profile = (await personBy('asha@example.com')).participantProfileId!;
    expect((await personBy('asha.alt@example.com')).participantProfileId).toBe(profile);
    expect((await regsOf(profile)).map((r) => r.eventSlug)).toEqual(['100mt', '200mt']);

    // 19. Nothing is re-sent; 22. the history shows on the profile.
    const fake2 = fakeTransport();
    try {
      expect(await ctx.worker.processBatch()).toBe(0);
      expect(fake2.sent).toHaveLength(0);
    } finally {
      fake2.restore();
    }
    const page = (await getAs(ctx, admin, `/admin/registrations/${asha.id}`).expect(200)).text;
    expect(page).toContain('Sent: 2 · Queued: 0 · Failed: 0');
    // Idempotent.
    expect(await service.backfill(true)).toMatchObject({ profilesCreated: 0, peopleLinked: 0, countsUnchanged: true });
  });

  // ---------- manual participants ----------

  it('29-31. manual participants use the same profile logic', async () => {
    await row('r1', 'asha@example.com', '100mt', A).expect(200);
    const profile = (await personBy('asha@example.com')).participantProfileId!;
    const manual = (submissionId: string, overrides: Record<string, string>) =>
      postAs(ctx, admin, '/admin/registrations/new', { submissionId, name: 'Asha Rao', sports: 'Kabaddi', aadhaarNumber: A, ...overrides });
    // 29 + 31. Existing Aadhaar, new email, different event -> same profile, new registration.
    await manual('11111111-2222-4333-8444-000000000001', { email: 'asha.manual@example.com' }).expect(303);
    expect((await personBy('asha.manual@example.com')).participantProfileId).toBe(profile);
    expect((await regsOf(profile)).map((r) => r.eventSlug)).toEqual(['100mt', 'kabaddi']);
    // Same Aadhaar + same event -> refused as a duplicate, nothing new registered.
    const dup = await manual('11111111-2222-4333-8444-000000000002', { email: 'asha.again@example.com', sports: '100mt' }).expect(422);
    expect(dup.text).toContain('duplicate registration not created');
    expect(await regsOf(profile)).toHaveLength(2);
    // 30. New Aadhaar -> new profile.
    await manual('11111111-2222-4333-8444-000000000003', { name: 'Bina', email: 'bina@example.com', aadhaarNumber: B }).expect(303);
    expect((await personBy('bina@example.com')).participantProfileId).not.toBe(profile);
    expect(await ctx.prisma.participantProfile.count()).toBe(2);
  });

  it('a verified participant keeps the normal flow: QR email once per registration owner, verification unchanged', async () => {
    await row('r1', 'asha@example.com', '100mt', A).expect(200);
    await verify('asha@example.com', '100mt');
    expect((await regBy('asha@example.com', '100mt')).paymentStatus).toBe(PaymentStatus.VERIFIED);
    expect(await ctx.prisma.emailOutbox.count({ where: { template: EmailTemplate.QrPass } })).toBe(1);
  });

  // ---------- profile-wide blocking ----------

  describe('blocking is per participant (whole Aadhaar profile)', () => {
    /** Asha with two email records (two QR codes), one verified registration each. */
    async function twoRecords() {
      await row('r1', 'asha@example.com', '100mt', A).expect(200);
      await row('r2', 'asha.alt@example.com', '200mt', A).expect(200);
      await verify('asha@example.com', '100mt');
      await verify('asha.alt@example.com', '200mt');
      return {
        r100: await regBy('asha@example.com', '100mt'),
        r200: await regBy('asha.alt@example.com', '200mt'),
        q1: (await personBy('asha@example.com')).qrToken!,
        q2: (await personBy('asha.alt@example.com')).qrToken!,
      };
    }
    const enter = (token: string, registrationId: string) => postAs(ctx, volunteer, `/p/${token}/enter`, { registrationId });
    const exit = (token: string, registrationId: string) => postAs(ctx, volunteer, `/p/${token}/exit`, { registrationId });
    const BLOCKED = /^ACCESS BLOCKED/;

    it('blocking one record blocks every QR and registration of the profile; unblocking any record lifts it', async () => {
      const { r100, r200, q1, q2 } = await twoRecords();
      await enter(q2, r200.id).expect(303); // inside before the block
      expect(flash(await postAs(ctx, coordinator, `/admin/registrations/${r100.id}/block`, { reason: 'Fake ID' }).expect(303))).toMatch(/^Participant blocked/);
      expect((await personBy('asha@example.com')).blockedAt).not.toBeNull();
      expect((await personBy('asha.alt@example.com')).blockedAt).not.toBeNull(); // the whole profile

      // No way around it: either QR, either registration, the manual gate, check-out.
      expect(flash(await enter(q1, r100.id))).toMatch(BLOCKED);
      expect(flash(await enter(q2, r100.id))).toMatch(BLOCKED);
      expect(flash(await exit(q1, r200.id))).toMatch(BLOCKED);
      expect(flash(await exit(q2, r200.id))).toMatch(BLOCKED);
      expect(flash(await postAs(ctx, volunteer, '/gate/enter', { registrationId: r100.id }))).toMatch(BLOCKED);
      expect((await regBy('asha.alt@example.com', '200mt')).insideSince).not.toBeNull(); // unchanged
      const card = (await getAs(ctx, volunteer, `/p/${q2}`).expect(200)).text;
      expect(card).toContain('ACCESS BLOCKED');
      expect(card).not.toContain('MARK ENTERED');
      // The Blocked list shows both registrations of the participant.
      const blockedList = (await getAs(ctx, coordinator, '/admin/registrations?status=blocked').expect(200)).text;
      expect([blockedList.includes(`/admin/registrations/${r100.id}`), blockedList.includes(`/admin/registrations/${r200.id}`)]).toEqual([true, true]);
      // The admin override still records the exit of a blocked participant who is inside.
      expect(flash(await postAs(ctx, admin, `/admin/registrations/${r200.id}/check-out-override`).expect(303))).toMatch(/CHECKED OUT/);

      // Unblock from the OTHER record: lifted for the whole participant.
      expect(flash(await postAs(ctx, coordinator, `/admin/registrations/${r200.id}/unblock`).expect(303))).toMatch(/^Participant unblocked/);
      expect([(await personBy('asha@example.com')).blockedAt, (await personBy('asha.alt@example.com')).blockedAt]).toEqual([null, null]);
      expect(flash(await enter(q2, r100.id))).toMatch(/^✅ ENTERED/);
      expect(await ctx.prisma.registrationActivity.count({ where: { type: { in: ['BLOCKED', 'UNBLOCKED'] } } })).toBe(4); // both registrations, both actions
    });

    it('older data with the block on only one record: still enforced for the whole profile', async () => {
      const { r100, r200, q2 } = await twoRecords();
      await ctx.prisma.person.update({ where: { email: 'asha@example.com' }, data: { blockedAt: new Date(), blockReason: 'Legacy block' } });
      expect((await personBy('asha.alt@example.com')).blockedAt).toBeNull(); // the other record is not marked
      expect(flash(await enter(q2, r200.id))).toMatch(BLOCKED);
      expect(flash(await postAs(ctx, volunteer, '/gate/enter', { registrationId: r200.id }))).toMatch(BLOCKED);
      expect((await getAs(ctx, volunteer, `/p/${q2}`).expect(200)).text).toContain('blocked through another of their records');
      expect((await getAs(ctx, coordinator, `/admin/registrations/${r200.id}`).expect(200)).text).toContain('Unblock participant');
      expect((await getAs(ctx, coordinator, '/admin/registrations?status=blocked').expect(200)).text).toContain(`/admin/registrations/${r200.id}`);
      await postAs(ctx, coordinator, `/admin/registrations/${r200.id}/unblock`).expect(303);
      expect((await personBy('asha@example.com')).blockedAt).toBeNull();
      expect(flash(await enter(q2, r100.id))).toMatch(/^✅ ENTERED/);
    });

    it('a new email record joining a blocked profile is blocked too', async () => {
      const { r100 } = await twoRecords();
      await postAs(ctx, coordinator, `/admin/registrations/${r100.id}/block`, { reason: 'Fake ID' }).expect(303);
      await row('r3', 'asha.new@example.com', 'Relay', A).expect(200);
      const joined = await personBy('asha.new@example.com');
      expect([joined.blockedAt !== null, joined.blockReason]).toEqual([true, 'Fake ID']);
    });
  });

  // ---------- QR issuance ----------

  it('a new event for an existing email record reuses its QR token; QR codes count tokens, not registrations', async () => {
    await row('r1', 'asha@example.com', '100mt', A).expect(200);
    await verify('asha@example.com', '100mt');
    const token = (await personBy('asha@example.com')).qrToken;
    await row('r2', 'asha@example.com', '200mt', A).expect(200); // same email record, new event
    await verify('asha@example.com', '200mt');
    expect((await personBy('asha@example.com')).qrToken).toBe(token); // no new QR
    expect(await ctx.prisma.person.count({ where: { qrToken: { not: null } } })).toBe(1);
    // The existing send-once QR email per verified registration, both carrying the same token.
    const rows = await ctx.prisma.emailOutbox.findMany({ where: { template: EmailTemplate.QrPass } });
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => (r.payload as { qrToken: string }).qrToken))).toEqual(new Set([token]));
    await verify('asha@example.com', '200mt'); // again: nothing new
    expect(await ctx.prisma.emailOutbox.count({ where: { template: EmailTemplate.QrPass } })).toBe(2);
    const page = (await getAs(ctx, admin, `/admin/registrations/${(await regBy('asha@example.com', '200mt')).id}`).expect(200)).text;
    expect(page).toContain('Registrations</dt><dd>2 · Events: 2 · QR codes generated: 1');
  });
});
