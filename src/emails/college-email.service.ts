import { Injectable } from '@nestjs/common';
import { ActivityType, EmailBatchKind, EmailStatus, PaymentStatus, Prisma } from '@prisma/client';
import { AppConfig } from '../config/app-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { ActivityEntry, recordActivity } from '../registrations/activity';
import { CollegePass, EmailTemplate } from './email-templates';
import { EmailOutboxService } from './email-outbox.service';
import { EmailWorkerService } from './email-worker.service';
import { QrEmailError, QrEmailService } from './qr-email.service';

/** Passes per consolidated email; larger colleges get several numbered emails. */
export const PASSES_PER_EMAIL = 40;

export interface BatchResult {
  batchId: string | null;
  eligible: number;
  queued: number;
  /** Eligible but skipped because a QR email for them is already waiting to send. */
  alreadyQueued: number;
  message: string;
}

/**
 * College-level QR email operations. Both only use VERIFIED registrations of people whose
 * collegeId is this college, reuse each student's existing QR token, and go through the outbox.
 * Each run is recorded as an EmailBatch (who, college, event, recipients, counts).
 */
@Injectable()
export class CollegeEmailService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: EmailOutboxService,
    private readonly qrEmails: QrEmailService,
    private readonly worker: EmailWorkerService,
    private readonly config: AppConfig,
  ) {}

  private eligibleWhere(collegeId: string, eventSlug?: string): Prisma.RegistrationWhereInput {
    return {
      paymentStatus: PaymentStatus.VERIFIED,
      person: { collegeId, qrToken: { not: null } },
      ...(eventSlug ? { eventSlug } : {}),
    };
  }

  /**
   * Every eligible student gets THEIR OWN pass at THEIR OWN current email (one email per registration).
   * Students without an email are skipped (counted in the message); they can be included in a
   * college email to one student instead, or get their pass once an email is added.
   */
  async sendToEach(collegeId: string, eventSlug: string | undefined, actorId: string): Promise<BatchResult> {
    const result = await this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'college-bulk:' + collegeId}))`;
        if (!(await tx.college.findUnique({ where: { id: collegeId } }))) throw new QrEmailError('College not found');
        const regs = await tx.registration.findMany({
          where: this.eligibleWhere(collegeId, eventSlug),
          include: { person: true, team: { select: { name: true } } },
          orderBy: { createdAt: 'asc' },
        });
        if (regs.length === 0) {
          return { batchId: null, eligible: 0, queued: 0, alreadyQueued: 0, message: 'No verified students to send to' };
        }

        // A double click (or a pending individual send) must not queue a second copy.
        const waiting = new Set(
          (
            await tx.emailOutbox.findMany({
              where: {
                registrationId: { in: regs.map((r) => r.id) },
                template: EmailTemplate.QrPass,
                status: { in: [EmailStatus.PENDING, EmailStatus.PROCESSING] },
              },
              select: { registrationId: true },
            })
          ).map((r) => r.registrationId),
        );
        const noEmail = regs.filter((r) => !r.person.email).length;
        const toSend = regs.flatMap((r) => (!waiting.has(r.id) && r.person.email ? [{ ...r, toEmail: r.person.email }] : []));

        const batch = await tx.emailBatch.create({
          data: {
            kind: EmailBatchKind.COLLEGE_EACH,
            collegeId,
            eventSlug: eventSlug ?? null,
            triggeredById: actorId,
            eligibleCount: regs.length,
            queuedCount: toSend.length,
          },
        });
        await this.outbox.enqueue(
          toSend.map((reg) => ({
            ...this.qrEmails.qrEmail(reg, reg.team?.name ?? ''),
            toEmail: reg.toEmail,
            idempotencyKey: `qr-pass:${reg.id}:bulk:${batch.id}`,
            triggeredById: actorId,
            batchId: batch.id,
          })),
          tx,
        );
        await recordActivity(
          tx,
          toSend.map((reg) => ({
            registrationId: reg.id,
            type: ActivityType.QR_EMAIL_BULK_QUEUED,
            actorId,
            details: { batchId: batch.id, toEmail: reg.toEmail, collegeId, eventSlug: eventSlug ?? null },
          })),
        );
        return {
          batchId: batch.id,
          eligible: regs.length,
          queued: toSend.length,
          alreadyQueued: regs.length - noEmail - toSend.length,
          message: `Queued ${toSend.length} QR email(s), each to the student's own address` +
            (regs.length - noEmail > toSend.length ? `; ${regs.length - noEmail - toSend.length} already had one waiting` : '') +
            (noEmail ? `; ${noEmail} skipped (no email)` : ''),
        };
      },
      { maxWait: 10_000, timeout: 60_000 },
    );
    this.worker.kick();
    return result;
  }

  /**
   * The passes of every eligible student of the college (each still that student's own QR)
   * in one consolidated email (split every PASSES_PER_EMAIL) to ONE selected student's
   * current address. The recipient must belong to this college and be verified.
   */
  async sendAllToOne(
    collegeId: string,
    recipientPersonId: string,
    eventSlug: string | undefined,
    actorId: string,
  ): Promise<BatchResult> {
    const result = await this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'college-bulk:' + collegeId}))`;
        const college = await tx.college.findUnique({ where: { id: collegeId } });
        if (!college) throw new QrEmailError('College not found');
        const recipient = await tx.person.findFirst({
          where: {
            id: recipientPersonId,
            collegeId,
            registrations: { some: { paymentStatus: PaymentStatus.VERIFIED } },
          },
        });
        if (!recipient) {
          throw new QrEmailError('The selected student must be a verified participant of this college');
        }
        const recipientEmail = recipient.email;
        if (!recipientEmail) throw new QrEmailError('The selected student has no email; add one first or choose another student');

        const pending = await tx.emailOutbox.count({
          where: {
            template: EmailTemplate.CollegePasses,
            personId: recipient.id,
            status: { in: [EmailStatus.PENDING, EmailStatus.PROCESSING] },
          },
        });
        if (pending > 0) throw new QrEmailError('College passes for this student are already queued');

        const regs = await tx.registration.findMany({
          where: this.eligibleWhere(collegeId, eventSlug),
          include: { person: true },
          orderBy: [{ person: { name: 'asc' } }, { eventSlug: 'asc' }],
        });
        if (regs.length === 0) {
          return { batchId: null, eligible: 0, queued: 0, alreadyQueued: 0, message: 'No verified students to include' };
        }

        // One pass per person (the QR is per person); list all their events in scope.
        const byPerson = new Map<string, { pass: CollegePass; regIds: string[] }>();
        for (const reg of regs) {
          const entry = byPerson.get(reg.personId) ?? {
            pass: {
              name: reg.person.name ?? reg.person.email ?? '',
              events: '',
              qrToken: reg.person.qrToken!,
            },
            regIds: [],
          };
          entry.pass.events = [entry.pass.events, this.config.eventName(reg.eventSlug)].filter(Boolean).join(', ');
          entry.regIds.push(reg.id);
          byPerson.set(reg.personId, entry);
        }
        const passes = [...byPerson.values()];
        const parts = Math.ceil(passes.length / PASSES_PER_EMAIL);
        const recipientReg = regs.find((r) => r.personId === recipient.id);

        const batch = await tx.emailBatch.create({
          data: {
            kind: EmailBatchKind.COLLEGE_TO_ONE,
            collegeId,
            eventSlug: eventSlug ?? null,
            recipientPersonId: recipient.id,
            recipientEmail,
            triggeredById: actorId,
            eligibleCount: passes.length,
            queuedCount: parts,
          },
        });
        await this.outbox.enqueue(
          Array.from({ length: parts }, (_, i) => ({
            idempotencyKey: `college-passes:${batch.id}:${i + 1}`,
            toEmail: recipientEmail,
            personId: recipient.id,
            registrationId: recipientReg?.id,
            triggeredById: actorId,
            batchId: batch.id,
            template: EmailTemplate.CollegePasses,
            subject: `Infinito 2K26 entry passes: ${college.name}${parts > 1 ? ` (${i + 1}/${parts})` : ''}`,
            payload: {
              recipientName: recipient.name ?? '',
              college: college.name,
              eventName: eventSlug ? this.config.eventName(eventSlug) : null,
              part: i + 1,
              parts,
              passes: passes.slice(i * PASSES_PER_EMAIL, (i + 1) * PASSES_PER_EMAIL).map((p) => ({ ...p.pass })),
            } as unknown as Prisma.InputJsonValue,
          })),
          tx,
        );

        const activity: ActivityEntry[] = passes.flatMap((p) =>
          p.regIds.map((registrationId) => ({
            registrationId,
            type: ActivityType.QR_PASSES_FORWARDED,
            actorId,
            details: {
              batchId: batch.id,
              collegeId,
              recipientPersonId: recipient.id,
              recipientEmail,
              passes: passes.length,
            },
          })),
        );
        await recordActivity(tx, activity);

        return {
          batchId: batch.id,
          eligible: passes.length,
          queued: parts,
          alreadyQueued: 0,
          message: `Queued ${passes.length} pass(es) in ${parts} email(s) to ${recipientEmail}`,
        };
      },
      { maxWait: 10_000, timeout: 60_000 },
    );
    this.worker.kick();
    return result;
  }

  /** Recent batches of a college with live per-email counts. */
  async batches(collegeId: string, take = 10) {
    const batches = await this.prisma.emailBatch.findMany({
      where: { collegeId },
      orderBy: { createdAt: 'desc' },
      take,
      include: {
        triggeredBy: { select: { name: true, email: true } },
        recipientPerson: { select: { name: true } },
      },
    });
    const counts = await this.prisma.emailOutbox.groupBy({
      by: ['batchId', 'status'],
      where: { batchId: { in: batches.map((b) => b.id) } },
      _count: { _all: true },
    });
    return batches.map((b) => {
      const of = (...statuses: EmailStatus[]) =>
        counts
          .filter((c) => c.batchId === b.id && statuses.includes(c.status))
          .reduce((n, c) => n + c._count._all, 0);
      return {
        ...b,
        sent: of(EmailStatus.SENT),
        failed: of(EmailStatus.FAILED),
        pending: of(EmailStatus.PENDING, EmailStatus.PROCESSING),
        cancelled: of(EmailStatus.CANCELLED),
      };
    });
  }
}
