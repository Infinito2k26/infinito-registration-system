import { EmailStatus, StaffRole } from '@prisma/client';
import { EmailTemplate } from '../src/emails/email-templates';
import { PermanentSendError, ResendTransport, SendPausedError, SmtpTransport } from '../src/emails/mail-transport';
import { Ctx, Staff, flash, getAs, postAs, resetDatabase, staff, startApp, submitRow } from './e2e-helpers';

/**
 * Admin-only Email provider setting (Staff -> Email provider): which already-configured
 * provider (.env credentials) sends the email queue, persisted in the database.
 */
describe('Email provider setting (e2e)', () => {
  let ctx: Ctx;
  let admin: Staff;
  let coordinator: Staff;
  let volunteer: Staff;
  // Both providers configured (fake values; nothing leaves the machine: sends are stubbed).
  const providerEnv = {
    SMTP_HOST: 'smtp.example.test',
    SMTP_PORT: '465',
    SMTP_USER: 'info@example.test',
    SMTP_PASS: 'not-a-real-password',
    RESEND_API_KEY: 're_not_a_real_key',
    MAIL_FROM: 'Infinito 2K26 <info@example.test>',
  };
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    for (const [k, v] of Object.entries(providerEnv)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    ctx = await startApp();
  });
  afterAll(async () => {
    jest.restoreAllMocks();
    await ctx.app.close();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  beforeEach(async () => {
    await resetDatabase(ctx);
    jest.restoreAllMocks();
    admin = await staff(ctx, StaffRole.ADMIN);
    coordinator = await staff(ctx, StaffRole.COORDINATOR);
    volunteer = await staff(ctx, StaffRole.VOLUNTEER);
  });

  const current = async (who: Staff = admin) => (await getAs(ctx, who, '/admin/staff/email-provider').expect(200)).body as { provider: string; source: string; providers: { provider: string; detail: string }[] };
  const choose = (provider: string, who: Staff = admin) => postAs(ctx, who, '/admin/staff/email-provider', { provider });

  it('admin reads the current provider (the .env default first), without secrets', async () => {
    const state = await current();
    expect([state.provider, state.source]).toEqual(['resend', 'env']); // EMAIL_PROVIDER unset -> resend
    const raw = JSON.stringify(state);
    expect(raw).toContain('smtp.example.test:465 as Infinito 2K26 <info@example.test>');
    expect(raw).not.toContain('not-a-real-password');
    expect(raw).not.toContain('re_not_a_real_key');
    const page = (await getAs(ctx, admin, '/admin/staff').expect(200)).text;
    expect(page).toContain('<h2>Email provider</h2>');
    expect(page).toContain('Active: <b>Resend</b>');
    expect(page).not.toContain('not-a-real-password');
  });

  it('admin switches SMTP -> Resend -> SMTP; the choice persists (also across a restart)', async () => {
    expect(flash(await choose('smtp').expect(303))).toBe('Email provider set to SMTP');
    expect(await current()).toMatchObject({ provider: 'smtp', source: 'admin' });
    expect(flash(await choose('resend').expect(303))).toBe('Email provider set to Resend');
    expect((await current()).provider).toBe('resend');
    expect(flash(await choose('smtp').expect(303))).toBe('Email provider set to SMTP');
    expect(await ctx.prisma.systemSetting.findMany()).toEqual([expect.objectContaining({ key: 'email.provider', value: 'smtp', updatedById: admin.id })]);
    expect((await getAs(ctx, admin, '/admin/staff').expect(200)).text).toContain('Active: <b>SMTP</b>');

    // A restarted app (same database) uses the saved choice, not the .env default.
    const restarted = await startApp();
    try {
      await restarted.worker.processBatch();
      expect(restarted.worker.provider).toBe('smtp');
    } finally {
      await restarted.app.close();
    }
  });

  it('coordinators and volunteers can neither read nor change it (server-side)', async () => {
    for (const who of [coordinator, volunteer]) {
      await getAs(ctx, who, '/admin/staff/email-provider').expect(403);
      await choose('smtp', who).expect(403);
      expect((await getAs(ctx, who, '/admin/staff')).status).toBe(403);
    }
    expect(await ctx.prisma.systemSetting.count()).toBe(0);
  });

  it('rejects invalid values and unconfigured providers; nothing changes', async () => {
    await choose('smtp').expect(303);
    for (const bad of ['carrier-pigeon', 'SMTP ', '']) {
      expect(flash(await choose(bad).expect(303))).toBe('Choose SMTP or Resend');
    }
    expect((await current()).provider).toBe('smtp');
    process.env.RESEND_API_KEY = '';
    try {
      expect(flash(await choose('resend').expect(303))).toMatch(/^Resend is not configured in \.env/);
      expect((await current()).provider).toBe('smtp');
    } finally {
      process.env.RESEND_API_KEY = providerEnv.RESEND_API_KEY;
    }
  });

  it('the selected provider sends the queue; switching never sends an email twice', async () => {
    const smtpSend = jest.spyOn(SmtpTransport.prototype, 'send').mockResolvedValue('<smtp-id@example.test>');
    const resendSend = jest.spyOn(ResendTransport.prototype, 'send').mockResolvedValue('resend-id-1');
    const verifyNew = async (responseId: string, name: string) => {
      await submitRow(ctx, responseId, { 'Email Address': `${name.toLowerCase()}@example.com`, Name: name, 'College Name': 'NIT Patna', Sports: 'TT' }).expect(200);
      const reg = await ctx.prisma.registration.findFirstOrThrow({ where: { person: { name } } });
      await postAs(ctx, admin, `/admin/registrations/${reg.id}/verify`).expect(303);
    };

    await choose('smtp').expect(303);
    await verifyNew('r1', 'Asha');
    expect(await ctx.worker.processBatch()).toBe(1);
    expect(ctx.worker.transportName).toBe('smtp');
    expect([smtpSend.mock.calls.length, resendSend.mock.calls.length]).toEqual([1, 0]);
    expect(smtpSend.mock.calls[0][0].to).toBe('asha@example.com');

    await choose('resend').expect(303);
    await verifyNew('r2', 'Bina');
    expect(await ctx.worker.processBatch()).toBe(1);
    expect(ctx.worker.transportName).toBe('resend');
    expect([smtpSend.mock.calls.length, resendSend.mock.calls.length]).toEqual([1, 1]);
    expect(resendSend.mock.calls[0][0].to).toBe('bina@example.com');

    // Switching back and processing again sends nothing new.
    await choose('smtp').expect(303);
    expect(await ctx.worker.processBatch()).toBe(0);
    expect([smtpSend.mock.calls.length, resendSend.mock.calls.length]).toEqual([1, 1]);
    const rows = await ctx.prisma.emailOutbox.findMany({ where: { template: EmailTemplate.QrPass }, orderBy: { createdAt: 'asc' } });
    expect(rows.map((r) => [r.toEmail, r.status, r.providerMessageId])).toEqual([
      ['asha@example.com', EmailStatus.SENT, '<smtp-id@example.test>'],
      ['bina@example.com', EmailStatus.SENT, 'resend-id-1'],
    ]);
  });

  describe('switching after a Resend quota pause', () => {
    const verifyNew = async (responseId: string, name: string) => {
      await submitRow(ctx, responseId, { 'Email Address': `${name.toLowerCase()}@example.com`, Name: name, 'College Name': 'NIT Patna', Sports: 'TT' }).expect(200);
      const reg = await ctx.prisma.registration.findFirstOrThrow({ where: { person: { name } } });
      await postAs(ctx, admin, `/admin/registrations/${reg.id}/verify`).expect(303);
    };
    const rowOf = (email: string) => ctx.prisma.emailOutbox.findFirstOrThrow({ where: { template: EmailTemplate.QrPass, toEmail: email } });

    it('quota pause -> switch to SMTP: the pending email and new ones are sent once; switching back works', async () => {
      const resendSend = jest
        .spyOn(ResendTransport.prototype, 'send')
        .mockRejectedValue(new SendPausedError('daily_quota_exceeded: You have reached your daily email sending quota.', 3_600_000));
      let smtpIds = 0;
      // Like a real SMTP server: a distinct Message-ID per email (providerMessageId is unique).
      const smtpSend = jest.spyOn(SmtpTransport.prototype, 'send').mockImplementation(() => Promise.resolve(`<smtp-${++smtpIds}@example.test>`));

      await choose('resend').expect(303);
      await verifyNew('r1', 'Asha');
      expect(await ctx.worker.processBatch()).toBe(0); // Resend: quota -> paused
      expect(resendSend).toHaveBeenCalledTimes(1);
      expect(await rowOf('asha@example.com')).toMatchObject({ status: EmailStatus.PENDING, attempts: 0 }); // kept, attempt not used up
      expect(await ctx.worker.processBatch()).toBe(0); // still paused for Resend
      expect(resendSend).toHaveBeenCalledTimes(1);

      // Switch to SMTP: the Resend pause no longer blocks anything.
      await choose('smtp').expect(303);
      expect(await ctx.worker.processBatch()).toBe(1);
      expect(smtpSend).toHaveBeenCalledTimes(1);
      expect(await rowOf('asha@example.com')).toMatchObject({ status: EmailStatus.SENT, providerMessageId: '<smtp-1@example.test>' });

      // A new email queued after the switch is sent via SMTP too.
      await verifyNew('r2', 'Bina');
      expect(await ctx.worker.processBatch()).toBe(1);
      expect(smtpSend).toHaveBeenCalledTimes(2);
      expect((await rowOf('bina@example.com')).status).toBe(EmailStatus.SENT);

      // Nothing is sent twice.
      expect(await ctx.worker.processBatch()).toBe(0);
      expect([smtpSend.mock.calls.length, resendSend.mock.calls.length]).toEqual([2, 1]);
      expect(smtpSend.mock.calls.map((c) => c[0].to).sort()).toEqual(['asha@example.com', 'bina@example.com']);

      // Back to Resend (quota fine again): new emails go through Resend.
      resendSend.mockResolvedValue('resend-id-2');
      await choose('resend').expect(303);
      await verifyNew('r3', 'Chetan');
      expect(await ctx.worker.processBatch()).toBe(1);
      expect((await rowOf('chetan@example.com')).providerMessageId).toBe('resend-id-2');
      expect(smtpSend).toHaveBeenCalledTimes(2);
      expect(await ctx.prisma.emailOutbox.count({ where: { template: EmailTemplate.QrPass } })).toBe(3);
    });

    it('an SMTP failure follows the normal retry rules', async () => {
      const smtpSend = jest.spyOn(SmtpTransport.prototype, 'send').mockRejectedValueOnce(new Error('smtp ETIMEDOUT: connection timed out'));
      await choose('smtp').expect(303);
      await verifyNew('r1', 'Asha');
      expect(await ctx.worker.processBatch()).toBe(0);
      const retry = await rowOf('asha@example.com');
      expect(retry).toMatchObject({ status: EmailStatus.PENDING, attempts: 1, lastError: 'smtp ETIMEDOUT: connection timed out' });
      expect(retry.sendAt.getTime()).toBeGreaterThan(Date.now()); // backoff: retried later, not now
      expect(await ctx.worker.processBatch()).toBe(0);
      expect(smtpSend).toHaveBeenCalledTimes(1);

      // When due again it is sent once; a refused recipient fails only that email.
      await ctx.prisma.emailOutbox.update({ where: { id: retry.id }, data: { sendAt: new Date() } });
      smtpSend.mockResolvedValueOnce('<smtp-id@example.test>');
      expect(await ctx.worker.processBatch()).toBe(1);
      expect(await rowOf('asha@example.com')).toMatchObject({ status: EmailStatus.SENT, attempts: 2 });
      smtpSend.mockRejectedValueOnce(new PermanentSendError('smtp 550: 550 5.1.1 mailbox does not exist'));
      await verifyNew('r2', 'Bina');
      expect(await ctx.worker.processBatch()).toBe(0);
      expect(await rowOf('bina@example.com')).toMatchObject({ status: EmailStatus.FAILED, lastError: 'smtp 550: 550 5.1.1 mailbox does not exist' });
    });
  });
});
