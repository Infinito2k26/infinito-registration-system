import { Global, Injectable, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';
import { parseAadhaarKey } from '../registrations/aadhaar-crypto';

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
    const { provider, smtp } = this.email;
    if (provider === 'resend' && !this.str('RESEND_API_KEY')) problems.push('RESEND_API_KEY must be set');
    if (provider === 'smtp' && !(smtp.host && smtp.user && smtp.pass)) {
      problems.push('EMAIL_PROVIDER=smtp needs SMTP_HOST, SMTP_USER and SMTP_PASS');
    }
    if (provider !== 'resend' && provider !== 'smtp') problems.push('EMAIL_PROVIDER must be "resend" or "smtp"');
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

  /**
   * Manual "Send/Resend QR email" clicks allowed per registration (the automatic email on
   * verification is not counted). 0 = unlimited (default).
   */
  get qrManualResendLimit() {
    return Math.max(0, this.num('QR_MANUAL_RESEND_LIMIT', 0));
  }

  get bootstrapAdminEmails(): string[] {
    return this.str('BOOTSTRAP_ADMIN_EMAILS')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);
  }

  get email() {
    const provider = (this.str('EMAIL_PROVIDER') || 'resend').toLowerCase();
    const smtpPort = this.num('SMTP_PORT', 465);
    const smtp = {
      host: this.str('SMTP_HOST'),
      port: smtpPort,
      /** TLS from the start on 465; STARTTLS on other ports (587). SMTP_SECURE overrides. */
      secure: this.str('SMTP_SECURE') ? this.str('SMTP_SECURE') === 'true' : smtpPort === 465,
      user: this.str('SMTP_USER'),
      // Gmail shows app passwords in groups of four ("abcd efgh ..."); the spaces are not part of it.
      pass: this.str('SMTP_PASS').replace(/\s+/g, ''),
    };
    return {
      /** "resend" (default) or "smtp" (e.g. Gmail / Google Workspace with an app password). */
      provider,
      smtp,
      resendApiKey: this.str('RESEND_API_KEY'),
      webhookSecret: this.str('RESEND_WEBHOOK_SECRET'),
      /**
       * "Name <address>". Resend: on a verified domain, no default on purpose. SMTP: defaults to
       * the SMTP account itself (Gmail sends only as the signed-in address or its aliases).
       */
      from: this.str('MAIL_FROM') || (provider === 'smtp' && smtp.user ? `Infinito 2K26 <${smtp.user}>` : ''),
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

  /** Whether the chosen provider has its credentials; otherwise development prints emails to the log. */
  emailProviderConfigured(): boolean {
    const { provider, resendApiKey, smtp } = this.email;
    return provider === 'smtp' ? Boolean(smtp.host && smtp.user && smtp.pass) : Boolean(resendApiKey);
  }

  /** Human-readable problems with the email settings; empty when sending can start. */
  emailConfigProblems(): string[] {
    const { provider, resendApiKey, from, replyTo } = this.email;
    const problems: string[] = [];
    if (provider !== 'resend' && provider !== 'smtp') return ['EMAIL_PROVIDER must be "resend" or "smtp"'];
    if (!this.emailProviderConfigured()) return problems;
    if (provider === 'resend' && !resendApiKey.startsWith('re_')) problems.push('RESEND_API_KEY should start with "re_"');
    const address = from.match(/<([^<>\s]+@[^<>\s]+)>\s*$/)?.[1] ?? (/^[^<>\s]+@[^<>\s]+$/.test(from) ? from : '');
    if (!address) problems.push('MAIL_FROM must be "Name <address@your-verified-domain>"');
    if (replyTo && !/^[^<>\s]+@[^<>\s]+$/.test(replyTo)) problems.push('MAIL_REPLY_TO must be a plain email address');
    return problems;
  }

  private aadhaarKeyCache: Buffer | null | undefined;

  /** AES-256 key for full Aadhaar numbers (AADHAAR_ENCRYPTION_KEY); null = store last 4 only. */
  get aadhaarKey(): Buffer | null {
    if (this.aadhaarKeyCache === undefined) this.aadhaarKeyCache = parseAadhaarKey(this.str('AADHAAR_ENCRYPTION_KEY'));
    return this.aadhaarKeyCache;
  }

  /** Whether volunteers may verify registrations from the gate card (default: no). */
  get volunteersCanVerify() {
    return this.str('VOLUNTEERS_CAN_VERIFY') === 'true';
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
        // Very short words are usually abbreviations: "tt" -> "TT", "e-sports" -> "E Sports".
        .map((w) => (w.length <= 2 ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
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
