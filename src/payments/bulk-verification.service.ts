import { Injectable, Logger } from '@nestjs/common';
import { EmailDeliveryStatus, EmailStatus, PaymentStatus, Prisma, VerificationBatchOutcome } from '@prisma/client';
import { initialQrKey } from '../emails/qr-email.service';
import { PrismaService } from '../prisma/prisma.service';
import { PaymentActionError, PaymentsService } from './payments.service';

/** Most registrations one "Verify Selected" may contain (the pending list shows 50 per page). */
export const BULK_VERIFY_MAX = 200;

const TEAMMATE_REASON = 'Same form response as a selected registration: verified together, exactly as its Verify button does';

export interface BulkVerifyResult {
  batchId: string;
  selected: number;
  verified: number;
  /** Of `verified`: teammates verified with a selected registration (not selected themselves). */
  teammates: number;
  skipped: number;
  failed: number;
  qrEmailsQueued: number;
  noEmail: number;
}

/** What the report shows for an email, from EmailOutbox only (never claims more than it knows). */
export type ReportEmailStatus = 'NO_EMAIL' | 'NOT_QUEUED' | 'QUEUED' | 'SENDING' | 'SENT' | 'DELIVERED' | 'DELAYED' | 'FAILED' | 'BOUNCED' | 'CANCELLED';

export function reportEmailStatus(
  item: { email: string | null; emailOutbox: { status: EmailStatus; deliveryStatus: EmailDeliveryStatus | null } | null },
): ReportEmailStatus {
  const row = item.emailOutbox;
  if (!row) return item.email ? 'NOT_QUEUED' : 'NO_EMAIL';
  switch (row.status) {
    case EmailStatus.PENDING:
      return 'QUEUED';
    case EmailStatus.PROCESSING:
      return 'SENDING';
    case EmailStatus.FAILED:
      return 'FAILED';
    case EmailStatus.CANCELLED:
      return 'CANCELLED';
    case EmailStatus.SENT:
      // Delivery is only known from the Resend webhook; SMTP reports "accepted by the mail server".
      if (row.deliveryStatus === EmailDeliveryStatus.DELIVERED) return 'DELIVERED';
      if (row.deliveryStatus === EmailDeliveryStatus.DELAYED) return 'DELAYED';
      if (row.deliveryStatus) return 'BOUNCED'; // BOUNCED / COMPLAINED / FAILED after sending
      return 'SENT';
  }
}

/** Live email totals of a set of batch items. */
export function emailTotals(items: Parameters<typeof reportEmailStatus>[0][]) {
  const statuses = items.map(reportEmailStatus);
  const count = (...s: ReportEmailStatus[]) => statuses.filter((x) => s.includes(x)).length;
  return {
    sent: count('SENT', 'DELIVERED', 'DELAYED'),
    failed: count('FAILED', 'BOUNCED'),
    pending: count('QUEUED', 'SENDING'),
    cancelled: count('CANCELLED'),
  };
}

const itemInclude = {
  emailOutbox: { select: { status: true, deliveryStatus: true, createdAt: true, sendAt: true, sentAt: true, lastError: true, toEmail: true } },
  registration: { select: { id: true, paymentStatus: true } },
} satisfies Prisma.VerificationBatchItemInclude;

/**
 * ADMIN "Verify Selected". Each selected registration goes through the SAME code as its Verify
 * button: PaymentsService.verifyTeam on its form response (team lock, QR token if missing,
 * VERIFIED + reviewer, activity record, the one automatic QR email via EmailOutbox). One
 * transaction per form response, so one failure never affects the others. The run and its
 * per-registration outcomes are recorded for the verification report.
 */
@Injectable()
export class BulkVerificationService {
  private readonly logger = new Logger(BulkVerificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly payments: PaymentsService,
  ) {}

  async verifySelected(registrationIds: string[], actorId: string): Promise<BulkVerifyResult> {
    const ids = [...new Set(registrationIds)].slice(0, BULK_VERIFY_MAX);
    const batch = await this.prisma.verificationBatch.create({ data: { triggeredById: actorId, selectedCount: ids.length } });
    const items: Prisma.VerificationBatchItemCreateManyInput[] = [];
    const add = (item: Omit<Prisma.VerificationBatchItemCreateManyInput, 'batchId'>) => items.push({ ...item, batchId: batch.id });

    const regs = await this.prisma.registration.findMany({
      where: { id: { in: ids } },
      select: { id: true, teamId: true, eventSlug: true, paymentStatus: true, person: { select: { name: true, email: true } } },
    });
    const byId = new Map(regs.map((r) => [r.id, r]));
    const byTeam = new Map<string, string[]>();
    for (const id of ids) {
      const reg = byId.get(id);
      if (!reg) {
        add({ registrationId: null, eventSlug: '', outcome: VerificationBatchOutcome.FAILED, reason: `Registration ${id} not found` });
        continue;
      }
      const base = { registrationId: reg.id, personName: reg.person.name, email: reg.person.email, eventSlug: reg.eventSlug };
      if (reg.paymentStatus !== PaymentStatus.PENDING) {
        add({ ...base, outcome: VerificationBatchOutcome.SKIPPED, reason: reg.paymentStatus === PaymentStatus.VERIFIED ? 'Already verified' : 'Rejected (not pending)' });
      } else if (!reg.teamId) {
        add({ ...base, outcome: VerificationBatchOutcome.FAILED, reason: 'Not linked to a form response, so it cannot be verified' });
      } else {
        byTeam.set(reg.teamId, [...(byTeam.get(reg.teamId) ?? []), reg.id]);
      }
    }

    for (const [teamId, selectedIds] of byTeam) {
      const selectedBase = (id: string) => {
        const reg = byId.get(id)!;
        return { registrationId: id, personName: reg.person.name, email: reg.person.email, eventSlug: reg.eventSlug };
      };
      try {
        const result = await this.payments.verifyTeam(teamId, actorId, { onlyIfPending: selectedIds });
        const verifiedIds = result.verifiedRegistrationIds ?? [];
        for (const id of selectedIds.filter((s) => !verifiedIds.includes(s))) {
          add({ ...selectedBase(id), outcome: VerificationBatchOutcome.SKIPPED, reason: 'Verified or rejected by someone else meanwhile' });
        }
        if (verifiedIds.length === 0) continue;
        const [verified, qrRows] = await Promise.all([
          this.prisma.registration.findMany({
            where: { id: { in: verifiedIds } },
            select: { id: true, eventSlug: true, person: { select: { name: true, email: true } } },
          }),
          this.prisma.emailOutbox.findMany({
            where: { idempotencyKey: { in: verifiedIds.map(initialQrKey) } },
            select: { id: true, idempotencyKey: true, toEmail: true },
          }),
        ]);
        const qrByKey = new Map(qrRows.map((r) => [r.idempotencyKey, r]));
        for (const reg of verified) {
          const qr = qrByKey.get(initialQrKey(reg.id));
          const selected = selectedIds.includes(reg.id);
          add({
            registrationId: reg.id,
            personName: reg.person.name,
            email: reg.person.email,
            eventSlug: reg.eventSlug,
            selected,
            outcome: VerificationBatchOutcome.VERIFIED,
            reason: [selected ? null : TEAMMATE_REASON, reg.person.email ? null : 'No email address: verified, no email queued'].filter(Boolean).join('. ') || null,
            emailOutboxId: qr?.id ?? null,
          });
        }
      } catch (error) {
        // verifyTeam runs in one transaction: on error nothing of this form response was changed.
        const reason = error instanceof PaymentActionError ? error.message : 'Unexpected error; this registration was not changed';
        if (!(error instanceof PaymentActionError)) this.logger.error(`Bulk verify team ${teamId}: ${error instanceof Error ? error.message : String(error)}`);
        for (const id of selectedIds) add({ ...selectedBase(id), outcome: VerificationBatchOutcome.FAILED, reason });
      }
    }

    const verifiedItems = items.filter((i) => i.outcome === VerificationBatchOutcome.VERIFIED);
    const result: BulkVerifyResult = {
      batchId: batch.id,
      selected: ids.length,
      verified: verifiedItems.length,
      teammates: verifiedItems.filter((i) => i.selected === false).length,
      skipped: items.filter((i) => i.outcome === VerificationBatchOutcome.SKIPPED).length,
      failed: items.filter((i) => i.outcome === VerificationBatchOutcome.FAILED).length,
      qrEmailsQueued: verifiedItems.filter((i) => i.emailOutboxId).length,
      noEmail: verifiedItems.filter((i) => !i.email).length,
    };
    await this.prisma.$transaction([
      this.prisma.verificationBatchItem.createMany({ data: items }),
      this.prisma.verificationBatch.update({
        where: { id: batch.id },
        data: {
          verifiedCount: result.verified,
          skippedCount: result.skipped,
          failedCount: result.failed,
          qrEmailsQueued: result.qrEmailsQueued,
          noEmailCount: result.noEmail,
        },
      }),
    ]);
    this.logger.log(`Bulk verify ${batch.id} by ${actorId}: ${JSON.stringify({ ...result, batchId: undefined })}`);
    return result;
  }

  /** Bulk runs created in [from, to), newest first, with live email totals. */
  async batches(from: Date, to: Date) {
    const batches = await this.prisma.verificationBatch.findMany({
      where: { createdAt: { gte: from, lt: to } },
      orderBy: { createdAt: 'desc' },
      include: { triggeredBy: { select: { name: true, email: true } }, items: { select: { email: true, ...itemInclude } } },
    });
    return batches.map(({ items, ...b }) => ({ ...b, email: emailTotals(items) }));
  }

  async batch(id: string) {
    const batch = await this.prisma.verificationBatch.findUnique({
      where: { id },
      include: {
        triggeredBy: { select: { name: true, email: true } },
        items: { orderBy: [{ outcome: 'asc' }, { personName: 'asc' }], include: itemInclude },
      },
    });
    return batch ? { ...batch, email: emailTotals(batch.items) } : null;
  }
}
