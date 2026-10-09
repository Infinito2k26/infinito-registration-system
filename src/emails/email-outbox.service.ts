import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface OutboxEmail {
  idempotencyKey: string;
  toEmail: string;
  subject: string;
  template: string;
  payload?: Prisma.InputJsonValue;
  personId?: string;
  registrationId?: string;
  /** Staff member whose action caused this email. */
  triggeredById?: string;
  /** Bulk college send this email belongs to. */
  batchId?: string;
  /** Admin notice recipient this delivery is for. */
  noticeRecipientId?: string;
  sendAt?: Date;
}

/**
 * Writes emails to EmailOutbox; EmailWorkerService renders and sends them.
 * Enqueueing an existing idempotencyKey is a silent no-op, so callers can retry freely.
 */
@Injectable()
export class EmailOutboxService {
  constructor(private readonly prisma: PrismaService) {}

  /** Pass a transaction client to enqueue atomically with the write that caused the email. */
  async enqueue(
    emails: OutboxEmail[],
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<number> {
    if (emails.length === 0) return 0;
    const { count } = await db.emailOutbox.createMany({
      data: emails,
      skipDuplicates: true,
    });
    return count;
  }
}
