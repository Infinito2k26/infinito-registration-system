import { Global, Injectable, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';

/** Typed access to environment settings, with the defaults documented in .env.example. */
@Injectable()
export class AppConfig {
  private readonly logger = new Logger(AppConfig.name);
  readonly appSecret: string;

  constructor(private readonly config: ConfigService) {
    const secret = this.str('APP_SECRET');
    if (!secret && !this.isProduction) {
      this.logger.warn('APP_SECRET not set; using a random one (forms break on restart)');
    }
    this.appSecret = secret || randomBytes(32).toString('hex');
    if (this.isProduction) {
      const problems = this.productionProblems();
      if (problems.length) throw new Error(`Refusing to start in production: ${problems.join('; ')}`);
    }
  }

  /** Settings that are tolerable in development but unsafe in production. */
  productionProblems(): string[] {
    const problems: string[] = [];
    if (this.str('APP_SECRET').length < 32) problems.push('APP_SECRET must be at least 32 characters');
    const webhookSecret = this.str('FORMS_WEBHOOK_SECRET');
    if (webhookSecret.length < 24 || webhookSecret === 'change-this-secret') {
      problems.push('FORMS_WEBHOOK_SECRET must be a random value of at least 24 characters');
    }
    if (!this.str('APP_BASE_URL').startsWith('https://')) {
      problems.push('APP_BASE_URL must be the public https:// URL');
    }
    if (!this.str('RESEND_API_KEY')) problems.push('RESEND_API_KEY must be set');
    return problems;
  }

  get isProduction() {
    return this.str('NODE_ENV') === 'production';
  }

  get baseUrl() {
    return (this.str('APP_BASE_URL') || 'http://localhost:3000').replace(/\/+$/, '');
  }

  get secureCookies() {
    return this.baseUrl.startsWith('https://');
  }

  get sessionTtlHours() {
    return this.num('SESSION_TTL_HOURS', 168);
  }

  get magicLinkTtlMinutes() {
    return this.num('MAGIC_LINK_TTL_MINUTES', 15);
  }

  /** Delay before a QR / payment-issue email goes out, so a mis-click can be undone. */
  get decisionEmailDelaySeconds() {
    return this.num('DECISION_EMAIL_DELAY_SECONDS', 120);
  }

  /** Manual "Resend QR email" clicks allowed per registration (the initial send is not counted). */
  get qrManualResendLimit() {
    return this.num('QR_MANUAL_RESEND_LIMIT', 3);
  }

  get bootstrapAdminEmails(): string[] {
    return this.str('BOOTSTRAP_ADMIN_EMAILS')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);
  }

  get email() {
    return {
      resendApiKey: this.str('RESEND_API_KEY'),
      webhookSecret: this.str('RESEND_WEBHOOK_SECRET'),
      /** "Name <address>" on a domain verified in the Resend account. No default on purpose. */
      from: this.str('MAIL_FROM'),
      replyTo: this.str('MAIL_REPLY_TO') || undefined,
      /**
       * Development only: deliver every email to this address instead of the real recipient
       * (the original recipient is shown in the subject). Ignored in production.
       */
      testRecipient: this.isProduction ? '' : this.str('EMAIL_TEST_RECIPIENT').toLowerCase(),
      workerEnabled: this.str('EMAIL_WORKER_ENABLED') !== 'false',
      pollIntervalMs: this.num('EMAIL_POLL_INTERVAL_MS', 10_000),
      sendIntervalMs: this.num('EMAIL_SEND_INTERVAL_MS', 600),
      batchSize: this.num('EMAIL_BATCH_SIZE', 20),
      maxAttempts: this.num('EMAIL_MAX_ATTEMPTS', 5),
      /** 0 = no cap. Counts emails sent in the last 24 hours. */
      dailyCap: this.num('EMAIL_DAILY_CAP', 0),
    };
  }

  /** Human-readable problems with the email settings; empty when sending can start. */
  emailConfigProblems(): string[] {
    const { resendApiKey, from, replyTo } = this.email;
    const problems: string[] = [];
    if (!resendApiKey) return problems;
    if (!resendApiKey.startsWith('re_')) problems.push('RESEND_API_KEY should start with "re_"');
    const address = from.match(/<([^<>\s]+@[^<>\s]+)>\s*$/)?.[1] ?? (/^[^<>\s]+@[^<>\s]+$/.test(from) ? from : '');
    if (!address) problems.push('MAIL_FROM must be "Name <address@your-verified-domain>"');
    if (replyTo && !/^[^<>\s]+@[^<>\s]+$/.test(replyTo)) problems.push('MAIL_REPLY_TO must be a plain email address');
    return problems;
  }

  /** Service-account JSON (raw or base64) with read access to the form upload folders. */
  get googleServiceAccountJson() {
    const raw = this.str('GOOGLE_SERVICE_ACCOUNT_JSON');
    if (!raw || raw.startsWith('{')) return raw;
    return Buffer.from(raw, 'base64').toString('utf8');
  }

  /** Optional display names, e.g. EVENT_NAMES={"tt":"Table Tennis"}. Otherwise derived from the slug. */
  get eventNames(): Record<string, string> {
    const raw = this.str('EVENT_NAMES');
    if (!raw) return {};
    try {
      return JSON.parse(raw) as Record<string, string>;
    } catch {
      this.logger.warn('EVENT_NAMES is not valid JSON; ignoring');
      return {};
    }
  }

  eventName(slug: string): string {
    return (
      this.eventNames[slug] ??
      slug
        .split('-')
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ')
    );
  }

  private str(key: string): string {
    return (this.config.get<string>(key) ?? '').trim();
  }

  private num(key: string, fallback: number): number {
    const value = Number(this.str(key));
    return this.str(key) !== '' && Number.isFinite(value) ? value : fallback;
  }
}

@Global()
@Module({ providers: [AppConfig], exports: [AppConfig] })
export class AppConfigModule {}
