import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/app-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { EMAIL_PROVIDER_SETTING, EmailProviderError, EmailProviderService } from './email-provider.service';
import { EmailWorkerService } from './email-worker.service';

const smtpOnly = {
  EMAIL_PROVIDER: 'smtp',
  SMTP_HOST: 'smtpout.secureserver.net',
  SMTP_PORT: '465',
  SMTP_USER: 'info@infinito2k26.com',
  SMTP_PASS: 'super-secret-password',
  MAIL_FROM: 'Infinito 2K26 <info@infinito2k26.com>',
  RESEND_API_KEY: '',
};

/** In-memory stand-in for the SystemSetting table. */
function fakePrisma(initial?: string) {
  const store = new Map<string, { key: string; value: string; updatedAt: Date; updatedBy: null }>();
  if (initial) store.set(EMAIL_PROVIDER_SETTING, { key: EMAIL_PROVIDER_SETTING, value: initial, updatedAt: new Date(), updatedBy: null });
  return {
    store,
    systemSetting: {
      findUnique: ({ where }: { where: { key: string } }) => Promise.resolve(store.get(where.key) ?? null),
      upsert: ({ create }: { create: { key: string; value: string } }) => {
        store.set(create.key, { ...create, updatedAt: new Date(), updatedBy: null });
        return Promise.resolve(create);
      },
    },
  };
}

const service = (env: Record<string, string>, prisma = fakePrisma()) =>
  new EmailProviderService(prisma as unknown as PrismaService, new AppConfig(new ConfigService(env)));

describe('EmailProviderService', () => {
  it('uses EMAIL_PROVIDER until an admin saves a choice; the saved choice then wins', async () => {
    const prisma = fakePrisma();
    const providers = service({ ...smtpOnly, RESEND_API_KEY: 're_live_key' }, prisma);
    await expect(providers.active()).resolves.toMatchObject({ provider: 'smtp', source: 'env' });
    await providers.set('resend', 'admin-id');
    await expect(providers.active()).resolves.toMatchObject({ provider: 'resend', source: 'admin' });
    expect(prisma.store.get(EMAIL_PROVIDER_SETTING)?.value).toBe('resend'); // only the choice is stored
  });

  it('refuses to select a provider that is not configured in .env (nothing saved)', async () => {
    const prisma = fakePrisma();
    const providers = service(smtpOnly, prisma);
    await expect(providers.set('resend', 'admin-id')).rejects.toThrow(EmailProviderError);
    await expect(providers.set('resend', 'admin-id')).rejects.toThrow('Resend is not configured in .env');
    expect(prisma.store.size).toBe(0);
  });

  it('describes providers without secrets', () => {
    const providers = service({ ...smtpOnly, RESEND_API_KEY: 're_live_key_123' });
    const text = JSON.stringify([providers.status('smtp'), providers.status('resend')]);
    expect(text).toContain('smtpout.secureserver.net:465 as Infinito 2K26 <info@infinito2k26.com>');
    expect(text).not.toContain('super-secret-password');
    expect(text).not.toContain('re_live_key_123');
  });
});

describe('EmailWorkerService provider selection', () => {
  const production = { NODE_ENV: 'production', APP_SECRET: 'a'.repeat(64), FORMS_WEBHOOK_SECRET: 'b'.repeat(32), APP_BASE_URL: 'https://x.test', EMAIL_WORKER_ENABLED: 'false' };

  it('selected provider not configured: sends nothing and does not fall back to the configured one', async () => {
    const config = new AppConfig(new ConfigService({ ...production, ...smtpOnly }));
    const prisma = fakePrisma('resend'); // an admin chose Resend earlier; RESEND_API_KEY was removed since
    const providers = new EmailProviderService(prisma as unknown as PrismaService, config);
    const worker = new EmailWorkerService(prisma as unknown as PrismaService, config, providers);
    expect(worker.transportName).toBe('smtp'); // .env default before the saved choice is read
    await worker.refreshProvider();
    expect([worker.provider, worker.transportName]).toEqual(['resend', 'disabled']);
  });

  it('switches the sender when the saved choice changes', async () => {
    const config = new AppConfig(new ConfigService({ ...production, ...smtpOnly, RESEND_API_KEY: 're_live_key' }));
    const prisma = fakePrisma();
    const providers = new EmailProviderService(prisma as unknown as PrismaService, config);
    const worker = new EmailWorkerService(prisma as unknown as PrismaService, config, providers);
    await worker.refreshProvider();
    expect(worker.transportName).toBe('smtp');
    await providers.set('resend', 'admin-id');
    await worker.refreshProvider();
    expect(worker.transportName).toBe('resend');
  });
});
