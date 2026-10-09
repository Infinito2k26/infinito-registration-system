import { Logger } from '@nestjs/common';
import { Transporter, createTransport } from 'nodemailer';
import { Resend } from 'resend';
import { RenderedEmail } from './email-templates';

export interface OutgoingEmail extends RenderedEmail {
  to: string;
  subject: string;
  idempotencyKey: string;
  /** Shown in the Resend dashboard; letters, digits, "_" and "-" only. */
  tags?: Record<string, string>;
}

/** Retrying this email cannot help (invalid recipient, bad attachment...). */
export class PermanentSendError extends Error {}

/**
 * Sending must pause for the whole queue (rate limit, quota, bad credentials, unverified sender).
 * The email stays queued and the attempt is not counted against it.
 */
export class SendPausedError extends Error {
  constructor(
    message: string,
    readonly pauseMs: number,
  ) {
    super(message);
  }
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;

/** Resend error names that block every email, not just this one. */
const PAUSE_FOR: Record<string, number> = {
  rate_limit_exceeded: 2 * SECOND,
  concurrent_idempotent_requests: 10 * SECOND,
  daily_quota_exceeded: 60 * MINUTE,
  monthly_quota_exceeded: 60 * MINUTE,
  missing_api_key: 5 * MINUTE,
  invalid_api_key: 5 * MINUTE,
  restricted_api_key: 5 * MINUTE,
  invalid_from_address: 5 * MINUTE,
  security_error: 5 * MINUTE,
};

export interface MailTransport {
  readonly name: string;
  /** Returns the provider message ID, if any. */
  send(email: OutgoingEmail): Promise<string | null>;
  /** Optional connection/login check at start-up. */
  verify?(): Promise<void>;
}

const tagValue = (v: string) => v.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 256);

export class ResendTransport implements MailTransport {
  readonly name = 'resend';
  private readonly client: Resend;

  constructor(
    apiKey: string,
    private readonly from: string,
    private readonly replyTo?: string,
  ) {
    this.client = new Resend(apiKey);
  }

  async send(email: OutgoingEmail): Promise<string | null> {
    const { data, error } = await this.client.emails.send(
      {
        from: this.from,
        to: email.to,
        replyTo: this.replyTo,
        subject: email.subject,
        html: email.html,
        text: email.text,
        attachments: email.attachments,
        tags: Object.entries(email.tags ?? {}).map(([name, value]) => ({ name: tagValue(name), value: tagValue(value) })),
      },
      // Resend ignores a repeat of the same key within 24h, so a crash between
      // "sent" and "marked SENT" cannot produce a second email.
      { idempotencyKey: email.idempotencyKey },
    );
    if (error) {
      const status = error.statusCode ?? 0;
      const message = `${error.name}: ${error.message}`;
      const pauseMs = PAUSE_FOR[error.name] ?? (status === 429 ? 2 * SECOND : undefined);
      if (pauseMs !== undefined) throw new SendPausedError(message, pauseMs);
      // Other 4xx (invalid recipient, test sender to a non-owner, bad attachment...) affect only this email.
      if (status >= 400 && status < 500) throw new PermanentSendError(message);
      throw new Error(message); // 5xx / network: retry with backoff
    }
    return data?.id ?? null;
  }
}

export interface SmtpOptions {
  /** Transport name in logs and the status JSON (default "smtp"; "brevo" for Brevo's relay). */
  name?: string;
  host: string;
  port: number;
  /** TLS from the start (port 465). false = STARTTLS upgrade (port 587). */
  secure: boolean;
  user: string;
  pass: string;
}

/** Gmail/Workspace texts for "this account cannot send more today". */
const QUOTA_TEXT = /5\.4\.5|daily user sending limit|sending limit exceeded|quota/i;

/**
 * Maps an SMTP failure onto the worker's three outcomes:
 * - pause the whole queue (bad login, daily limit, server-side throttling): nothing else can go out;
 * - permanent for this email (recipient/message refused with a 5xx);
 * - transient (network, timeouts): retried with backoff.
 */
export function classifySmtpError(error: unknown): Error {
  const err = error as { code?: string; responseCode?: number; response?: string; message?: string };
  const message = `smtp ${err.responseCode ?? err.code ?? 'error'}: ${err.response ?? err.message ?? String(error)}`;
  const code = err.responseCode ?? 0;
  if (QUOTA_TEXT.test(message)) return new SendPausedError(message, 60 * MINUTE);
  if (err.code === 'EAUTH' || code === 534 || code === 535) return new SendPausedError(message, 5 * MINUTE);
  if (code >= 400 && code < 500) return new SendPausedError(message, MINUTE); // throttling / temporary
  if (err.code === 'EENVELOPE' || code >= 500) return new PermanentSendError(message);
  return new Error(message); // connection, timeout, DNS: retry with backoff
}

/**
 * Any SMTP server, e.g. Gmail / Google Workspace (smtp.gmail.com:465 with an app password) or
 * Brevo. One connection, reused. There is no provider idempotency key and no delivery webhook:
 * delivered/bounced status is only known from the SMTP reply when the email is handed over.
 */
export class SmtpTransport implements MailTransport {
  readonly name: string;
  private readonly transporter: Transporter;

  constructor(
    options: SmtpOptions,
    private readonly from: string,
    private readonly replyTo?: string,
    transporter?: Transporter,
  ) {
    this.name = options.name ?? 'smtp';
    this.transporter =
      transporter ??
      createTransport({
        host: options.host,
        port: options.port,
        secure: options.secure,
        auth: { user: options.user, pass: options.pass },
        pool: true,
        maxConnections: 1,
      });
  }

  /** Checks the login once at start-up, so a wrong app password shows in the log immediately. */
  async verify(): Promise<void> {
    await this.transporter.verify();
  }

  /** Closes the pooled connection (one-off scripts; the worker keeps it open). */
  close(): void {
    this.transporter.close();
  }

  async send(email: OutgoingEmail): Promise<string | null> {
    try {
      const info = (await this.transporter.sendMail({
        from: this.from,
        to: email.to,
        replyTo: this.replyTo,
        subject: email.subject,
        html: email.html,
        text: email.text,
        attachments: email.attachments?.map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType, cid: a.contentId })),
        headers: { 'X-Infinito-Ref': email.idempotencyKey },
      })) as { messageId?: string };
      return info.messageId ?? null;
    } catch (error) {
      throw classifySmtpError(error);
    }
  }
}

/** Development fallback when no provider is configured: prints the email (and its links) to the log. */
export class ConsoleTransport implements MailTransport {
  readonly name = 'console';
  private readonly logger = new Logger('ConsoleMail');

  send(email: OutgoingEmail): Promise<string | null> {
    this.logger.log(`To: ${email.to} | ${email.subject}\n${email.text}`);
    return Promise.resolve(null);
  }
}
