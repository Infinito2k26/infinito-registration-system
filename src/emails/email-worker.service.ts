import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { EmailOutbox, EmailStatus } from '@prisma/client';
import { AppConfig } from '../config/app-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { renderEmail } from './email-templates';
import {
  ConsoleTransport,
  MailTransport,
  OutgoingEmail,
  PermanentSendError,
  ResendTransport,
  SendPausedError,
} from './mail-transport';

const STUCK_AFTER_MS = 5 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Polls EmailOutbox and sends due emails one at a time, throttled to stay under
 * the provider's rate limit. Rows are claimed with a conditional update, so
 * several server instances never send the same row twice.
 *
 * Failure handling:
 *  - PermanentSendError (e.g. invalid recipient): row FAILED immediately.
 *  - SendPausedError (rate limit, quota, bad key, unverified sender): row stays queued,
 *    attempt not counted, the whole queue pauses.
 *  - anything else (5xx, network): retry with exponential backoff up to EMAIL_MAX_ATTEMPTS.
 */
@Injectable()
export class EmailWorkerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(EmailWorkerService.name);
  private readonly transport: MailTransport | null;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private rerun = false;
  private stopped = false;
  private pausedUntil = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
  ) {
    this.transport = this.createTransport();
  }

  private createTransport(): MailTransport | null {
    const { resendApiKey, from, replyTo, testRecipient } = this.config.email;
    if (!resendApiKey) {
      if (this.config.isProduction) {
        this.logger.error('RESEND_API_KEY is not set; emails stay queued and are not sent');
        return null;
      }
      this.logger.warn('RESEND_API_KEY is not set; emails are printed to the log instead of sent');
      return new ConsoleTransport();
    }
    const problems = this.config.emailConfigProblems();
    if (problems.length > 0) {
      this.logger.error(`Email sending disabled, fix .env: ${problems.join('; ')}`);
      return null;
    }
    this.logger.log(
      `Sending via Resend as ${from}${replyTo ? `, reply-to ${replyTo}` : ''}` +
        (testRecipient ? `. TEST MODE: every email is delivered to ${testRecipient}` : ''),
    );
    return new ResendTransport(resendApiKey, from, replyTo);
  }

  get transportName() {
    return this.transport?.name ?? 'disabled';
  }

  onApplicationBootstrap() {
    if (!this.config.email.workerEnabled || !this.transport) return;
    this.schedule(1_000);
  }

  onModuleDestroy() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  /** Process the queue now (e.g. right after queueing a login link) instead of waiting for the next poll. */
  kick() {
    if (!this.config.email.workerEnabled || !this.transport || this.stopped) return;
    if (this.running) {
      this.rerun = true;
      return;
    }
    this.schedule(0);
  }

  private schedule(delayMs: number) {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), delayMs);
  }

  private async tick() {
    this.running = true;
    try {
      do {
        this.rerun = false;
        await this.processBatch();
      } while (this.rerun && !this.stopped && Date.now() >= this.pausedUntil);
    } catch (error) {
      this.logger.error(`Email worker tick failed: ${String(error)}`);
    } finally {
      this.running = false;
      this.schedule(Math.max(this.config.email.pollIntervalMs, this.pausedUntil - Date.now()));
    }
  }

  async processBatch(): Promise<number> {
    if (!this.transport || Date.now() < this.pausedUntil) return 0;
    const { batchSize, sendIntervalMs, dailyCap } = this.config.email;
    const now = new Date();

    // Recover rows left PROCESSING by a crashed instance; Resend's idempotency key prevents a double send.
    await this.prisma.emailOutbox.updateMany({
      where: { status: EmailStatus.PROCESSING, updatedAt: { lt: new Date(now.getTime() - STUCK_AFTER_MS) } },
      data: { status: EmailStatus.PENDING },
    });

    let limit = batchSize;
    if (dailyCap > 0) {
      const sentToday = await this.prisma.emailOutbox.count({
        where: { status: EmailStatus.SENT, sentAt: { gte: new Date(now.getTime() - DAY_MS) } },
      });
      limit = Math.min(limit, dailyCap - sentToday);
      if (limit <= 0) return 0;
    }

    const due = await this.prisma.emailOutbox.findMany({
      where: { status: EmailStatus.PENDING, sendAt: { lte: now } },
      orderBy: { sendAt: 'asc' },
      take: limit,
    });

    let sent = 0;
    for (const row of due) {
      if (this.stopped || Date.now() < this.pausedUntil) break;
      const claimed = await this.prisma.emailOutbox.updateMany({
        where: { id: row.id, status: EmailStatus.PENDING },
        data: { status: EmailStatus.PROCESSING, attempts: { increment: 1 } },
      });
      if (claimed.count === 0) continue; // cancelled or taken by another instance
      if (await this.sendOne({ ...row, attempts: row.attempts + 1 })) sent++;
      await sleep(sendIntervalMs);
    }
    return sent;
  }

  private async buildEmail(row: EmailOutbox): Promise<OutgoingEmail> {
    if (!row.template) throw new PermanentSendError('Outbox row has no template');
    const rendered = await renderEmail(row.template, (row.payload ?? {}) as Record<string, unknown>);
    const testRecipient = this.config.email.testRecipient;
    return {
      ...rendered,
      to: testRecipient || row.toEmail,
      subject: testRecipient ? `[TEST → ${row.toEmail}] ${row.subject}` : row.subject,
      idempotencyKey: row.idempotencyKey,
      tags: { template: row.template, outbox_id: row.id },
    };
  }

  private async sendOne(row: EmailOutbox): Promise<boolean> {
    try {
      const providerMessageId = await this.transport!.send(await this.buildEmail(row));
      await this.prisma.emailOutbox.update({
        where: { id: row.id },
        data: { status: EmailStatus.SENT, sentAt: new Date(), providerMessageId, lastError: null },
      });
      return true;
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 1000);

      if (error instanceof SendPausedError) {
        this.pausedUntil = Date.now() + error.pauseMs;
        await this.prisma.emailOutbox.update({
          where: { id: row.id },
          data: { status: EmailStatus.PENDING, attempts: { decrement: 1 }, lastError: message },
        });
        this.logger.warn(`Email sending paused ${Math.round(error.pauseMs / 1000)}s: ${message}`);
        return false;
      }

      const giveUp = error instanceof PermanentSendError || row.attempts >= this.config.email.maxAttempts;
      // Exponential backoff: 1, 2, 4, 8... minutes.
      const retryAt = new Date(Date.now() + 60_000 * 2 ** (row.attempts - 1));
      await this.prisma.emailOutbox.update({
        where: { id: row.id },
        data: giveUp
          ? { status: EmailStatus.FAILED, lastError: message }
          : { status: EmailStatus.PENDING, sendAt: retryAt, lastError: message },
      });
      this.logger.warn(
        `Email ${row.idempotencyKey} to ${row.toEmail} ${giveUp ? 'failed permanently' : 'will retry'} (attempt ${row.attempts}): ${message}`,
      );
      return false;
    }
  }
}
