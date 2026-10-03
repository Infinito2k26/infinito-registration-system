import { StaffRole } from '@prisma/client';
import { Ctx, getAs, resetDatabase, staff, startApp, submitRow } from './e2e-helpers';

/** The public landing page at "/" (and that nothing else changed around it). */
describe('Public landing page (e2e)', () => {
  let ctx: Ctx;

  beforeAll(async () => {
    ctx = await startApp();
  });
  afterAll(async () => {
    await ctx.app.close();
  });
  beforeEach(async () => {
    await resetDatabase(ctx);
  });

  it('shows the landing page to visitors, with staff login links and the footer links', async () => {
    const res = await ctx.http.get('/').expect(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    for (const text of [
      '<h1 id="hero-title">Infinito 2K26</h1>',
      'Registration System',
      'Welcome to the Infinito 2K26 Registration System, the portal for participant registration, verification, QR pass management and entry/exit operations.',
      '>Admin / Staff Login</a>',
      'Welcome to Infinito 2K26 Registration System',
      'Participant Registration',
      'Registration Verification',
      'QR Pass Management',
      'Entry &amp; Exit Tracking',
      'Staff Operations',
      'Staff Portal',
      'Authorized Infinito staff can access participant verification and entry/exit operations.',
      '>Staff Login →</a>',
      'IIT Patna',
      'Registration &amp; Entry-Exit Management System',
      '© 2026 Infinito 2K26, IIT Patna. All rights reserved.',
      'href="/assets/landing.css"',
    ]) {
      expect([text, res.text.includes(text)]).toEqual([text, true]);
    }
    expect(res.text.match(/href="\/login"/g)?.length).toBeGreaterThanOrEqual(3);
    expect(res.text).toContain('href="https://infinito2k26.com/" target="_blank" rel="noopener noreferrer"');
    expect(res.text).toContain('href="https://www.instagram.com/infinito_iitp/" target="_blank" rel="noopener noreferrer"');
    await ctx.http.get('/assets/landing.css').expect(200);
  });

  it('exposes no participant, staff or system data', async () => {
    await submitRow(ctx, 'r1', { 'Email Address': 'priya@example.com', 'College Name': 'NIT Patna', Sports: 'TT', Name: 'Priya', 'Aadhaar No.': '1234 5678 9012' }).expect(200);
    await staff(ctx, StaffRole.ADMIN, 'boss@staff.test');
    const text = (await ctx.http.get('/').expect(200)).text;
    for (const secret of ['Priya', 'priya@example.com', 'NIT Patna', '9012', 'boss@staff.test', 'webhook', '/admin', '_csrf', 'DATABASE', 'SECRET']) {
      expect([secret, text.includes(secret)]).toEqual([secret, false]);
    }
  });

  it('signed-in staff are still sent to their home page; /login is unchanged', async () => {
    const coordinator = await staff(ctx, StaffRole.COORDINATOR);
    const volunteer = await staff(ctx, StaffRole.VOLUNTEER);
    expect((await getAs(ctx, coordinator, '/').expect(303)).headers.location).toBe('/admin/registrations');
    expect((await getAs(ctx, volunteer, '/').expect(303)).headers.location).toBe('/scan');
    const login = await ctx.http.get('/login').expect(200);
    expect(login.text).toContain('<h1>Staff sign in</h1>');
    expect(login.text).toContain('Email me a sign-in link');
    expect(login.text).not.toContain('landing.css');
  });
});
