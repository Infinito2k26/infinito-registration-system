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

  it('reads the resend limit and delay from env with defaults', () => {
    expect(config({}).qrManualResendLimit).toBe(3);
    expect(config({ QR_MANUAL_RESEND_LIMIT: '5' }).qrManualResendLimit).toBe(5);
    expect(config({}).decisionEmailDelaySeconds).toBe(120);
  });
});
