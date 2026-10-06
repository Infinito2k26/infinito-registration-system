import { ConfigService } from '@nestjs/config';
import { AppConfig } from './app-config.service';

const config = (env: Record<string, string>) => new AppConfig(new ConfigService(env));

const goodProduction = {
  NODE_ENV: 'production',
  APP_SECRET: 'a'.repeat(64),
  FORMS_WEBHOOK_SECRET: 'b'.repeat(32),
  APP_BASE_URL: 'https://register.infinito2k26.com',
  RESEND_API_KEY: 're_live_key',
};

describe('AppConfig', () => {
  it('starts in production with safe settings', () => {
    expect(config(goodProduction).secureCookies).toBe(true);
  });

  it.each([
    ['APP_SECRET', { APP_SECRET: 'short' }, 'APP_SECRET must be at least 32 characters'],
    ['default webhook secret', { FORMS_WEBHOOK_SECRET: 'change-this-secret' }, 'FORMS_WEBHOOK_SECRET'],
    ['http base URL', { APP_BASE_URL: 'http://register.example.com' }, 'APP_BASE_URL must be the public https:// URL'],
    ['missing Resend key', { RESEND_API_KEY: '' }, 'RESEND_API_KEY must be set'],
  ])('refuses to start in production with %s', (_label, override, message) => {
    expect(() => config({ ...goodProduction, ...override })).toThrow(message);
  });

  it('ignores EMAIL_TEST_RECIPIENT in production', () => {
    expect(config({ ...goodProduction, EMAIL_TEST_RECIPIENT: 'dev@example.com' }).email.testRecipient).toBe('');
    expect(config({ EMAIL_TEST_RECIPIENT: 'Dev@Example.com' }).email.testRecipient).toBe('dev@example.com');
  });

  it('has no built-in sender and validates MAIL_FROM when a key is set', () => {
    expect(config({}).email.from).toBe('');
    expect(config({ RESEND_API_KEY: 're_x', MAIL_FROM: 'oops' }).emailConfigProblems()).toEqual([
      'MAIL_FROM must be "Name <address@your-verified-domain>"',
    ]);
    expect(config({ RESEND_API_KEY: 're_x', MAIL_FROM: 'Infinito <no-reply@infinito2k26.com>' }).emailConfigProblems()).toEqual([]);
  });

  it('EMAIL_PROVIDER=smtp: needs SMTP settings in production; defaults the sender to the SMTP account', () => {
    const smtp = { ...goodProduction, RESEND_API_KEY: '', EMAIL_PROVIDER: 'smtp' };
    expect(() => config(smtp)).toThrow('EMAIL_PROVIDER=smtp needs SMTP_HOST, SMTP_USER and SMTP_PASS');
    const ok = config({ ...smtp, SMTP_HOST: 'smtp.gmail.com', SMTP_USER: 'sender@gmail.com', SMTP_PASS: 'abcd efgh ijkl mnop' });
    expect(ok.email.smtp).toEqual({ host: 'smtp.gmail.com', port: 465, secure: true, user: 'sender@gmail.com', pass: 'abcdefghijklmnop' });
    expect(ok.email.from).toBe('Infinito 2K26 <sender@gmail.com>');
    expect(ok.emailProviderConfigured()).toBe(true);
    expect(ok.emailConfigProblems()).toEqual([]);
    // Port 587 uses STARTTLS; an explicit MAIL_FROM wins.
    const starttls = config({ EMAIL_PROVIDER: 'smtp', SMTP_HOST: 'smtp-relay.brevo.com', SMTP_PORT: '587', SMTP_USER: 'u', SMTP_PASS: 'p', MAIL_FROM: 'Infinito <passes@example.com>' });
    expect(starttls.email.smtp.secure).toBe(false);
    expect(starttls.email.from).toBe('Infinito <passes@example.com>');
    expect(() => config({ ...goodProduction, EMAIL_PROVIDER: 'carrier-pigeon' })).toThrow('EMAIL_PROVIDER must be "resend" or "smtp"');
    // Resend stays the default and keeps requiring its key.
    expect(config({}).email.provider).toBe('resend');
  });

  it('derives event display names from the slug (short words uppercased)', () => {
    const c = config({});
    expect(['tt', 'hoki', 'table-tennis', 'e-sports-bgmi'].map((slug) => c.eventName(slug))).toEqual([
      'TT',
      'Hoki',
      'Table Tennis',
      'E Sports Bgmi',
    ]);
    expect(config({ EVENT_NAMES: '{"hoki":"Hockey"}' }).eventName('hoki')).toBe('Hockey');
  });

  it('reads the resend limit and delay from env with defaults', () => {
    expect(config({}).qrManualResendLimit).toBe(0); // 0 = unlimited
    expect(config({ QR_MANUAL_RESEND_LIMIT: '5' }).qrManualResendLimit).toBe(5);
    expect(config({}).decisionEmailDelaySeconds).toBe(120);
  });
});
