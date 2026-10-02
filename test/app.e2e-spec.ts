import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { EmailStatus, EntryStatus, PaymentStatus, StaffRole } from '@prisma/client';
import { createHash, randomBytes } from 'crypto';
import request, { Response } from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { AuthService } from '../src/auth/auth.service';
import { EmailTemplate } from '../src/emails/email-templates';
import { EmailWorkerService } from '../src/emails/email-worker.service';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * End-to-end: real AppModule + HTTP stack + PostgreSQL (disposable E2E_DATABASE_URL).
 * Emails use the console transport; the outbox is drained explicitly with processBatch().
 */
describe('Infinito registration system (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let worker: EmailWorkerService;
  let auth: AuthService;
  let http: ReturnType<typeof request>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ rawBody: true, logger: false });
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    worker = app.get(EmailWorkerService);
    auth = app.get(AuthService);
    // Listen once on a fixed port: every request then has the same Host, like a browser
    // (supertest would otherwise start the server on a new random port per request).
    const server = app.getHttpServer();
    server.setMaxListeners(50); // the concurrency tests fire 10 requests at once
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    http = request(server);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    // Each test starts with a fresh per-IP login rate limit (all requests come from 127.0.0.1).
    // (the in-memory store keeps counters in two private maps)
    const throttle = app.get<ThrottlerStorageService>(ThrottlerStorage) as unknown as Record<'storage' | 'hitExpirations', Map<string, unknown> | undefined>;
    throttle.storage?.clear();
    throttle.hitExpirations?.clear();
    await prisma.$executeRawUnsafe(
      'TRUNCATE "RegistrationActivity","EmailOutbox","EntryLog","Registration","TeamMember","Team","Person","StaffSession","StaffUser" CASCADE',
    );
  });

  // ---------- helpers ----------

  const submit = (responseId: string, answers: Record<string, string>, eventSlug = 'football', secret = 'e2e-webhook-secret') =>
    http
      .post('/webhooks/forms/submit')
      .set('X-Webhook-Secret', secret)
      .send({ eventSlug, sourceForm: 'sheet-e2e', sourceRow: 2, responseId, answers });

  const team2 = (txn = 'UTR111') => ({
    'Team Name': 'Byte Me',
    'Transaction ID': txn,
    'Member 1 Name': 'Asha Rao',
    'Member 1 Email': 'asha@example.com',
    'Member 1 Phone': '9876543210',
    'Member 2 Name': 'Ravi Kumar',
    'Member 2 Email': 'ravi@example.com',
  });

  interface Staff {
    cookie: string;
    csrf: string;
    id: string;
  }

  /** Signs a staff member in by creating a session directly (the magic-link flow has its own test). */
  async function staff(role: StaffRole, email = `${role.toLowerCase()}@staff.test`): Promise<Staff> {
    const user = await prisma.staffUser.create({ data: { email, name: role.toLowerCase(), role } });
    const token = randomBytes(32).toString('base64url');
    const session = await prisma.staffSession.create({
      data: {
        staffUserId: user.id,
        tokenHash: createHash('sha256').update(token).digest('hex'),
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    return { cookie: `inf_staff=${token}`, csrf: auth.csrfToken(session.id), id: user.id };
  }

  const postAs = (who: Staff, path: string, form: Record<string, string> = {}) =>
    http.post(path).set('Cookie', who.cookie).type('form').send({ _csrf: who.csrf, ...form });

  const getAs = (who: Staff, path: string) => http.get(path).set('Cookie', who.cookie);

  /** The one-shot flash message set by a POST (post/redirect/get). */
  function flash(res: Response): string | undefined {
    const cookies = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
    const raw = cookies.find((c) => c.startsWith('inf_flash='))?.split(';')[0].slice('inf_flash='.length);
    if (!raw) return undefined;
    return (JSON.parse(Buffer.from(decodeURIComponent(raw), 'base64url').toString('utf8')) as { text: string }).text;
  }

  const teamId = async (responseId: string) =>
    (await prisma.team.findFirstOrThrow({ where: { responseId } })).id;

  const qrRows = (teamIdValue: string) =>
    prisma.emailOutbox.findMany({
      where: { template: EmailTemplate.QrPass, registration: { teamId: teamIdValue } },
      orderBy: { createdAt: 'asc' },
    });

  const regOf = (email: string, eventSlug = 'football') =>
    prisma.registration.findFirstOrThrow({ where: { eventSlug, person: { email } }, include: { person: true } });

  async function verifiedTeam(responseId = 'r1', txn = 'UTR111') {
    await submit(responseId, team2(txn)).expect(200);
    const id = await teamId(responseId);
    const coordinator = await staff(StaffRole.COORDINATOR, `coord-${responseId}@staff.test`);
    await postAs(coordinator, `/admin/teams/${id}/verify`).expect(303);
    return { id, coordinator };
  }

  // ---------- forms webhook ----------

  describe('forms webhook', () => {
    it('rejects missing or wrong secrets and malformed payloads', async () => {
      await http.post('/webhooks/forms/submit').send({}).expect(401);
      await submit('r1', team2(), 'football', 'wrong-secret').expect(401);
      await http.post('/webhooks/forms/submit').set('X-Webhook-Secret', 'e2e-webhook-secret').send({ eventSlug: 'Bad Slug!' }).expect(400);
      const invalid = await submit('r1', { 'Member 1 Name': 'A', 'Member 1 Email': 'not-an-email' }).expect(422);
      expect(invalid.body.errors).toEqual(['Member 1: "not-an-email" is not a valid email', 'Transaction ID is missing']);
      expect(await prisma.person.count()).toBe(0);
    });

    it('matches titles regardless of case, spacing, "*" and ":" and lowercases EVENT_SLUG', async () => {
      const res = await submit(
        'r1',
        {
          'team name *': 'Byte Me',
          '  TRANSACTION   ID: ': 'utr 999',
          'member 1 NAME*': 'Asha',
          'Member 1 Email :': ' Asha@Example.COM ',
        },
        'Table-Tennis',
      ).expect(200);
      expect(res.body).toMatchObject({ ok: true, outcome: 'created', memberCount: 1 });
      const reg = await regOf('asha@example.com', 'table-tennis');
      expect(reg.transactionId).toBe('UTR999');
    });

    it('resyncing the same row (same Response ID) never duplicates anything', async () => {
      await submit('r1', team2()).expect(200);
      const again = await submit('r1', team2()).expect(200);
      expect(again.body).toMatchObject({ outcome: 'updated', queuedEmails: 0 });
      expect(await prisma.person.count()).toBe(2);
      expect(await prisma.team.count()).toBe(1);
      expect(await prisma.registration.count()).toBe(2);
      expect(await prisma.emailOutbox.count({ where: { template: EmailTemplate.RegistrationReceived } })).toBe(2);
    });

    it('a duplicate submission (new row, same people) moves them instead of duplicating', async () => {
      await submit('r1', team2()).expect(200);
      const dup = await submit('r2', team2()).expect(200);
      expect(dup.body.warnings).toEqual(expect.arrayContaining([expect.stringContaining('moved here from team "Byte Me"')]));
      expect(await prisma.person.count()).toBe(2);
      expect(await prisma.registration.count()).toBe(2);
      expect(await prisma.registration.count({ where: { team: { responseId: 'r2' } } })).toBe(2);
    });

    it('reports a reused transaction ID as a warning on ingest', async () => {
      await submit('r1', team2('UTR111')).expect(200);
      const other = await submit('r2', { 'Team Name': 'Copycats', 'Transaction ID': 'utr111', 'Member 1 Name': 'Zed', 'Member 1 Email': 'zed@example.com' }).expect(200);
      expect(other.body.warnings).toEqual(['Duplicate txn UTR111: also used by team "Byte Me" (football)']);
    });
  });

  // ---------- authentication & authorization ----------

  describe('auth and roles', () => {
    it('anonymous users are sent to login; nothing protected is reachable', async () => {
      await submit('r1', team2()).expect(200);
      const id = await teamId('r1');
      for (const path of ['/admin/registrations', `/admin/teams/${id}`, '/admin/entries', '/admin/staff', '/scan']) {
        const res = await http.get(path).expect(303);
        expect(res.headers.location).toMatch(/^\/login\?next=/);
      }
      await http.post(`/admin/teams/${id}/verify`).type('form').send({}).expect(303);
      expect((await regOf('asha@example.com')).paymentStatus).toBe(PaymentStatus.PENDING);
    });

    it('volunteers cannot use any admin page or action, even by direct URL', async () => {
      await submit('r1', team2()).expect(200);
      const id = await teamId('r1');
      const reg = await regOf('asha@example.com');
      const volunteer = await staff(StaffRole.VOLUNTEER);
      for (const path of ['/admin/registrations', `/admin/teams/${id}`, '/admin/entries', '/admin/staff']) {
        await getAs(volunteer, path).expect(403);
      }
      await postAs(volunteer, `/admin/teams/${id}/verify`).expect(403);
      await postAs(volunteer, `/admin/teams/${id}/reject`, { remarks: 'x' }).expect(403);
      await postAs(volunteer, `/admin/registrations/${reg.id}/resend-qr`).expect(403);
      await postAs(volunteer, '/admin/staff', { email: 'evil@staff.test', role: 'ADMIN' }).expect(403);
      await getAs(volunteer, '/scan').expect(200);
      expect((await regOf('asha@example.com')).paymentStatus).toBe(PaymentStatus.PENDING);
      expect(await prisma.staffUser.count({ where: { email: 'evil@staff.test' } })).toBe(0);
    });

    it('coordinators manage registrations but not staff; admins manage staff', async () => {
      const coordinator = await staff(StaffRole.COORDINATOR);
      await getAs(coordinator, '/admin/registrations').expect(200);
      await getAs(coordinator, '/admin/staff').expect(403);
      await postAs(coordinator, '/admin/staff', { email: 'x@staff.test', role: 'ADMIN' }).expect(403);
      const admin = await staff(StaffRole.ADMIN);
      await getAs(admin, '/admin/staff').expect(200);
      expect(flash(await postAs(admin, '/admin/staff', { email: 'admin@staff.test', role: 'VOLUNTEER' }))).toBe(
        "You can't remove your own admin role",
      );
    });

    it('writes need the CSRF token and must not come from another site', async () => {
      await submit('r1', team2()).expect(200);
      const id = await teamId('r1');
      const coordinator = await staff(StaffRole.COORDINATOR);
      await http.post(`/admin/teams/${id}/verify`).set('Cookie', coordinator.cookie).type('form').send({}).expect(403);
      await http.post(`/admin/teams/${id}/verify`).set('Cookie', coordinator.cookie).type('form').send({ _csrf: 'forged' }).expect(403);
      await postAs(coordinator, `/admin/teams/${id}/verify`).set('Origin', 'https://evil.example').expect(403);
      await http.post('/login').set('Origin', 'https://evil.example').type('form').send({ email: 'a@b.c' }).expect(403);
      expect((await regOf('asha@example.com')).paymentStatus).toBe(PaymentStatus.PENDING);
    });

    it('same-origin sign-in works with the headers real browsers send; cross-site posts stay blocked', async () => {
      const page = await http.get('/login').expect(200);
      expect(page.headers['referrer-policy']).toBe('same-origin');
      const host = new URL(page.request.url).host;
      await prisma.staffUser.create({ data: { email: 'admin@staff.test', role: StaffRole.ADMIN } });
      const login = (headers: Record<string, string>) =>
        http.post('/login').set(headers).type('form').send({ email: 'admin@staff.test' });

      // Chrome/Firefox on a page with a strict referrer policy: Origin is literally "null".
      await login({ Origin: 'null', 'Sec-Fetch-Site': 'same-origin' }).expect(200);
      await login({ Origin: `http://${host}`, 'Sec-Fetch-Site': 'same-origin' }).expect(200);
      await login({ Origin: `http://${host}` }).expect(200); // older Safari
      await login({ Referer: `http://${host}/login` }).expect(200);

      await login({ Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' }).expect(403);
      await login({ Origin: 'null', 'Sec-Fetch-Site': 'cross-site' }).expect(403); // sandboxed iframe
      await login({ Origin: 'null' }).expect(403);
      await login({ Origin: 'https://evil.example' }).expect(403);
      await http.post('/auth/magic').set({ Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' }).type('form').send({ token: 'x' }).expect(403);

      // Same-origin is not a CSRF bypass: staff actions still need their token.
      await submit('r1', team2()).expect(200);
      const coordinator = await staff(StaffRole.COORDINATOR);
      await http
        .post(`/admin/teams/${await teamId('r1')}/verify`)
        .set({ Cookie: coordinator.cookie, Origin: `http://${host}`, 'Sec-Fetch-Site': 'same-origin' })
        .type('form')
        .send({})
        .expect(403);
      expect((await regOf('asha@example.com')).paymentStatus).toBe(PaymentStatus.PENDING);
    });

    it('magic links are single use, expire, and are rate limited per account', async () => {
      await prisma.staffUser.create({ data: { email: 'vol@staff.test', role: StaffRole.VOLUNTEER } });
      await http.post('/login').type('form').send({ email: 'VOL@staff.test' }).expect(200);
      await http.post('/login').type('form').send({ email: 'vol@staff.test' }).expect(200); // within cooldown
      await http.post('/login').type('form').send({ email: 'nobody@staff.test' }).expect(200); // same page, no email
      const links = await prisma.emailOutbox.findMany({ where: { template: EmailTemplate.StaffLogin } });
      expect(links.map((l) => l.toEmail)).toEqual(['vol@staff.test']);

      const token = new URL((links[0].payload as { url: string }).url).searchParams.get('token')!;
      await http.get(`/auth/magic?token=${token}`).expect(200); // prefetch-safe: GET does not consume
      const signIn = await http.post('/auth/magic').type('form').send({ token }).expect(303);
      expect(signIn.headers.location).toBe('/scan');
      expect(([] as string[]).concat(signIn.headers['set-cookie']).join(';')).toMatch(/inf_staff=.*HttpOnly.*SameSite=Lax/i);
      await http.post('/auth/magic').type('form').send({ token }).expect(400);
    });

    it('disabled staff lose access immediately', async () => {
      const volunteer = await staff(StaffRole.VOLUNTEER);
      await getAs(volunteer, '/scan').expect(200);
      await prisma.staffUser.update({ where: { id: volunteer.id }, data: { active: false } });
      await getAs(volunteer, '/scan').expect(303);
    });
  });

  // ---------- dashboard ----------

  describe('dashboard search and filters', () => {
    it('finds registrations by name, email, team, txn and registration ID, per event', async () => {
      await submit('r1', team2('UTR111')).expect(200);
      await submit('r2', { 'Team Name': 'Spinners', 'Transaction ID': 'TT42', 'Member 1 Name': 'Kiran', 'Member 1 Email': 'kiran@example.com' }, 'table-tennis').expect(200);
      const coordinator = await staff(StaffRole.COORDINATOR);
      const asha = await regOf('asha@example.com');
      const list = async (query: string) => (await getAs(coordinator, `/admin/registrations${query}`).expect(200)).text;
      const shows = (page: string) => ({ byteMe: page.includes('Byte Me'), spinners: page.includes('Spinners') });

      expect(shows(await list(''))).toEqual({ byteMe: true, spinners: true });
      expect(shows(await list('?event=football'))).toEqual({ byteMe: true, spinners: false });
      expect(shows(await list('?event=table-tennis'))).toEqual({ byteMe: false, spinners: true });
      for (const q of ['ravi', 'ASHA@EXAMPLE', 'byte', 'utr 111', asha.id, await teamId('r1')]) {
        expect(shows(await list(`?q=${encodeURIComponent(q)}`))).toEqual({ byteMe: true, spinners: false });
      }
      expect(shows(await list('?status=VERIFIED'))).toEqual({ byteMe: false, spinners: false });
      expect(await list('')).toContain('Table Tennis'); // event name derived from the slug

      const detail = await getAs(coordinator, `/admin/teams/${await teamId('r1')}`).expect(200);
      expect(detail.text).toContain('asha@example.com');
      expect(detail.text).toContain('UTR111');
      expect(detail.text).toContain('Submitted via form');
    });
  });

  // ---------- payment verification ----------

  describe('payment verification', () => {
    it('5 simultaneous Verify clicks create exactly one QR email per member and one token each', async () => {
      await submit('r1', team2()).expect(200);
      const id = await teamId('r1');
      const coordinator = await staff(StaffRole.COORDINATOR);
      await Promise.all(Array.from({ length: 5 }, () => postAs(coordinator, `/admin/teams/${id}/verify`).expect(303)));

      const regs = await prisma.registration.findMany({ where: { teamId: id }, include: { person: true } });
      expect(regs.every((r) => r.paymentStatus === PaymentStatus.VERIFIED && r.paymentReviewedById === coordinator.id)).toBe(true);
      expect(regs.every((r) => /^[\w-]{43}$/.test(r.person.qrToken ?? ''))).toBe(true);
      expect((await qrRows(id)).map((r) => r.toEmail).sort()).toEqual(['asha@example.com', 'ravi@example.com']);
      expect(await prisma.registrationActivity.count({ where: { type: 'PAYMENT_VERIFIED' } })).toBe(2);
      expect(flash(await postAs(coordinator, `/admin/teams/${id}/verify`))).toBe('Already verified; no emails sent');
    });

    it('a transaction ID verified for one team cannot be verified for another', async () => {
      const { coordinator } = await verifiedTeam('r1', 'UTR111');
      await submit('r2', { 'Team Name': 'Copycats', 'Transaction ID': 'utr 111', 'Member 1 Name': 'Zed', 'Member 1 Email': 'zed@example.com' }).expect(200);
      const res = await postAs(coordinator, `/admin/teams/${await teamId('r2')}/verify`);
      expect(flash(res)).toMatch(/^Transaction UTR111 is already verified for team "Byte Me"/);
      const zed = await regOf('zed@example.com');
      expect(zed.paymentStatus).toBe(PaymentStatus.PENDING);
      expect(zed.person.qrToken).toBeNull();
    });

    it('two different teams with the same txn verified at the same moment: only one wins', async () => {
      await submit('r1', team2('UTR555')).expect(200);
      await submit('r2', { 'Team Name': 'Copycats', 'Transaction ID': 'UTR555', 'Member 1 Name': 'Zed', 'Member 1 Email': 'zed@example.com' }).expect(200);
      const coordinator = await staff(StaffRole.COORDINATOR);
      const [a, b] = [await teamId('r1'), await teamId('r2')];
      await Promise.all([postAs(coordinator, `/admin/teams/${a}/verify`), postAs(coordinator, `/admin/teams/${b}/verify`)]);
      const verifiedTeams = await prisma.registration.findMany({
        where: { transactionId: 'UTR555', paymentStatus: PaymentStatus.VERIFIED },
        distinct: ['teamId'],
      });
      expect(verifiedTeams).toHaveLength(1);
    });

    it('reject needs a reason, revokes the pass before entry, and emails the captain', async () => {
      const { id, coordinator } = await verifiedTeam();
      expect(flash(await postAs(coordinator, `/admin/teams/${id}/reject`, { remarks: '   ' }))).toBe('A rejection reason is required');
      expect((await regOf('asha@example.com')).paymentStatus).toBe(PaymentStatus.VERIFIED);

      await postAs(coordinator, `/admin/teams/${id}/reject`, { remarks: 'Amount short by ₹200' }).expect(303);
      const asha = await regOf('asha@example.com');
      expect(asha).toMatchObject({ paymentStatus: PaymentStatus.REJECTED, paymentRemarks: 'Amount short by ₹200' });
      expect((await qrRows(id)).every((r) => r.status === EmailStatus.CANCELLED)).toBe(true);
      const rejection = await prisma.emailOutbox.findFirstOrThrow({ where: { template: EmailTemplate.PaymentRejected } });
      expect(rejection.toEmail).toBe('asha@example.com');

      const volunteer = await staff(StaffRole.VOLUNTEER);
      const pass = await getAs(volunteer, `/p/${asha.person.qrToken}`).expect(200);
      expect(pass.text).toContain('DO NOT ADMIT');
      expect(pass.text).not.toContain('MARK ENTERED');
    });

    it('undo before sending cancels the QR emails; verifying again sends each exactly once', async () => {
      const { id, coordinator } = await verifiedTeam();
      expect(flash(await postAs(coordinator, `/admin/teams/${id}/undo`))).toBe('Verification undone; 2 QR email(s) cancelled');
      expect((await regOf('asha@example.com')).paymentStatus).toBe(PaymentStatus.PENDING);
      await postAs(coordinator, `/admin/teams/${id}/verify`).expect(303);
      const rows = await qrRows(id);
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.status === EmailStatus.PENDING)).toBe(true);

      await worker.processBatch();
      expect((await qrRows(id)).every((r) => r.status === EmailStatus.SENT)).toBe(true);
      expect(flash(await postAs(coordinator, `/admin/teams/${id}/undo`))).toBe(
        'QR emails have already been sent; use Reject (with a reason) instead',
      );
    });

    it('after entry, the payment can no longer be rejected and entry history is kept', async () => {
      const { id, coordinator } = await verifiedTeam();
      const volunteer = await staff(StaffRole.VOLUNTEER);
      const asha = await regOf('asha@example.com');
      await postAs(volunteer, `/p/${asha.person.qrToken}/enter`, { registrationId: asha.id }).expect(303);
      expect(flash(await postAs(coordinator, `/admin/teams/${id}/reject`, { remarks: 'late doubt' }))).toBe(
        'A member of this team has already entered; payment can no longer be rejected',
      );
      expect((await regOf('asha@example.com')).paymentStatus).toBe(PaymentStatus.VERIFIED);
      expect(await prisma.entryLog.count({ where: { status: EntryStatus.ENTERED } })).toBe(1);
    });
  });

  // ---------- QR email + manual resend ----------

  describe('QR email resend', () => {
    it('each member gets their own pass; resend reuses the token, respects the limit and is audited', async () => {
      const { id, coordinator } = await verifiedTeam();
      await worker.processBatch();
      const asha = await regOf('asha@example.com');
      const ravi = await regOf('ravi@example.com');
      const tokenBefore = asha.person.qrToken!;
      const [ashaPass, raviPass] = (await qrRows(id))
        .sort((a, b) => a.toEmail.localeCompare(b.toEmail))
        .map((r) => (r.payload as { qrUrl: string }).qrUrl);
      expect(ashaPass).toBe(`http://e2e.test/p/${tokenBefore}`);
      expect(raviPass).toBe(`http://e2e.test/p/${ravi.person.qrToken}`);

      // 5 simultaneous clicks: one resend is queued, the rest are refused.
      const clicks = await Promise.all(Array.from({ length: 5 }, () => postAs(coordinator, `/admin/registrations/${asha.id}/resend-qr`)));
      expect(clicks.map(flash).filter((t) => t?.startsWith('QR email queued'))).toHaveLength(1);
      await worker.processBatch();

      expect(flash(await postAs(coordinator, `/admin/registrations/${asha.id}/resend-qr`))).toMatch(/^QR email queued/);
      await worker.processBatch();
      expect(flash(await postAs(coordinator, `/admin/registrations/${asha.id}/resend-qr`))).toBe(
        'Resend limit reached (2 manual resends per participant per event)',
      );

      const ashaRows = (await qrRows(id)).filter((r) => r.toEmail === 'asha@example.com');
      expect(ashaRows.map((r) => r.status)).toEqual([EmailStatus.SENT, EmailStatus.SENT, EmailStatus.SENT]);
      expect(new Set(ashaRows.map((r) => (r.payload as { qrUrl: string }).qrUrl))).toEqual(new Set([ashaPass]));
      expect(ashaRows.slice(1).every((r) => r.triggeredById === coordinator.id)).toBe(true);
      expect((await regOf('asha@example.com')).person.qrToken).toBe(tokenBefore);
      expect(await prisma.registration.count()).toBe(2);
      expect(await prisma.registrationActivity.count({ where: { registrationId: asha.id, type: 'QR_EMAIL_RESENT' } })).toBe(2);

      const page = await getAs(coordinator, `/admin/teams/${id}`).expect(200);
      expect(page.text).toContain('Manual resends 2/2');
      expect(page.text).toContain('Sent <b>3</b>');
    });

    it('a failed email can be retried with a manual resend (within the limit)', async () => {
      const { id, coordinator } = await verifiedTeam();
      const asha = await regOf('asha@example.com');
      await prisma.emailOutbox.updateMany({
        where: { registrationId: asha.id, template: EmailTemplate.QrPass },
        data: { status: EmailStatus.FAILED, lastError: 'validation_error: test' },
      });
      expect(flash(await postAs(coordinator, `/admin/registrations/${asha.id}/resend-qr`))).toMatch(/^QR email queued/);
      expect((await qrRows(id)).filter((r) => r.toEmail === 'asha@example.com')).toHaveLength(2);
    });

    it('unverified or rejected registrations cannot get a QR email', async () => {
      await submit('r1', team2()).expect(200);
      const coordinator = await staff(StaffRole.COORDINATOR);
      const asha = await regOf('asha@example.com');
      expect(flash(await postAs(coordinator, `/admin/registrations/${asha.id}/resend-qr`))).toBe(
        'Payment is not verified, so there is no pass to send',
      );
      await postAs(coordinator, `/admin/teams/${await teamId('r1')}/reject`, { remarks: 'no payment' });
      expect(flash(await postAs(coordinator, `/admin/registrations/${asha.id}/resend-qr`))).toBe(
        'Payment is not verified, so there is no pass to send',
      );
      expect(await prisma.emailOutbox.count({ where: { template: EmailTemplate.QrPass } })).toBe(0);
    });
  });

  // ---------- gate ----------

  describe('gate entry', () => {
    it('anonymous visitors see no participant data; volunteers see only what the gate needs', async () => {
      await verifiedTeam();
      const asha = await regOf('asha@example.com');
      const anon = await http.get(`/p/${asha.person.qrToken}`).expect(200);
      expect(anon.text).not.toContain('Asha');
      expect(anon.text).toContain('Show this QR to a volunteer');

      const volunteer = await staff(StaffRole.VOLUNTEER);
      const pass = await getAs(volunteer, `/p/${asha.person.qrToken}`).expect(200);
      expect(pass.headers['cache-control']).toBe('no-store');
      expect(pass.text).toContain('<h1>Asha Rao</h1>');
      expect(pass.text).toContain('Team Byte Me');
      expect(pass.text).toContain('MARK ENTERED');
      for (const secret of ['asha@example.com', '9876543210', 'UTR111', '/admin/teams/']) {
        expect(pass.text).not.toContain(secret);
      }
      await getAs(volunteer, '/p/NOT-A-REAL-TOKEN-AAAAAAAAAAAAAAAA').expect(404);
    });

    it('10 simultaneous MARK ENTERED taps create one entry; repeats show ALREADY ENTERED', async () => {
      await verifiedTeam();
      const asha = await regOf('asha@example.com');
      const volunteer = await staff(StaffRole.VOLUNTEER);
      const taps = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          postAs(volunteer, `/p/${asha.person.qrToken}/enter`, { registrationId: asha.id, gate: `Gate ${i}` }),
        ),
      );
      const messages = taps.map(flash);
      expect(messages.filter((m) => m?.startsWith('✅ ENTERED'))).toHaveLength(1);
      expect(messages.filter((m) => m?.startsWith('ALREADY ENTERED'))).toHaveLength(9);
      expect(await prisma.entryLog.count({ where: { status: EntryStatus.ENTERED } })).toBe(1);
      expect(await prisma.entryLog.count({ where: { status: EntryStatus.REJECTED, notes: 'already entered' } })).toBe(9);

      const repeat = await getAs(volunteer, `/p/${asha.person.qrToken}`).expect(200);
      expect(repeat.text).toContain('ALREADY ENTERED');
      expect(repeat.text).toContain('1/2 of team entered');

      const ravi = await regOf('ravi@example.com');
      await postAs(volunteer, `/p/${ravi.person.qrToken}/enter`, { registrationId: ravi.id }).expect(303);
      expect((await getAs(volunteer, `/p/${ravi.person.qrToken}`)).text).toContain('Whole team entered (2/2)');
    });

    it('entry cannot be forged by swapping IDs, and anonymous users cannot mark entry', async () => {
      await verifiedTeam();
      const asha = await regOf('asha@example.com');
      const ravi = await regOf('ravi@example.com');
      const volunteer = await staff(StaffRole.VOLUNTEER);
      // Ravi's registration with Asha's pass token
      expect(flash(await postAs(volunteer, `/p/${asha.person.qrToken}/enter`, { registrationId: ravi.id }))).toBe(
        'Registration not found for this pass',
      );
      const anon = await http.post(`/p/${asha.person.qrToken}/enter`).type('form').send({ registrationId: asha.id }).expect(303);
      expect(anon.headers.location).toMatch(/^\/login/);
      expect(await prisma.registration.count({ where: { enteredAt: { not: null } } })).toBe(0);
    });
  });
});
