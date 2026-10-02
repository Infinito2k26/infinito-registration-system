import { Logger } from '@nestjs/common';
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

/** Development fallback when RESEND_API_KEY is empty: prints the email (and its links) to the log. */
export class ConsoleTransport implements MailTransport {
  readonly name = 'console';
  private readonly logger = new Logger('ConsoleMail');

  send(email: OutgoingEmail): Promise<string | null> {
    this.logger.log(`To: ${email.to} | ${email.subject}\n${email.text}`);
    return Promise.resolve(null);
  }
}
