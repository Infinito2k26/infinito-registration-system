import { Injectable, Logger } from '@nestjs/common';
import { ActivityType, PaymentStatus, Prisma } from '@prisma/client';
import { AppConfig } from '../config/app-config.service';
import { EmailTemplate } from '../emails/email-templates';
import { EmailOutboxService } from '../emails/email-outbox.service';
import { ParsedMember, ParsedSubmission } from '../forms/form-response.parser';
import { PrismaService } from '../prisma/prisma.service';
import { ActivityEntry, recordActivity } from './activity';
import { encryptAadhaar } from './aadhaar-crypto';
import { collegeDisplayName, collegeNameKey } from './college';

export interface IngestSource {
  eventSlug: string;
  sourceForm: string;
  sourceSheet?: string;
  sourceRow?: number;
  /** Stable per response row; re-ingesting the same responseId updates instead of duplicating. */
  responseId: string;
}

/** One form row; it may register for several events (comma-separated Sports answer). */
export interface IngestRequest extends Omit<IngestSource, 'eventSlug'> {
  eventSlugs: string[];
}

export interface IngestResult {
  outcome: 'created' | 'updated';
  teamId: string;
  teamName: string;
  memberCount: number;
  queuedEmails: number;
  warnings: string[];
}

export interface IngestManyResult extends IngestResult {
  events: string[];
}

/** The submission clashes with data that must not be changed automatically. Nothing was written. */
export class RegistrationConflictError extends Error {
  constructor(readonly errors: string[]) {
    super(errors.join('; '));
  }
}

/** Another request inserted the same person/team concurrently. Safe to retry. */
export class RegistrationRetryableError extends Error {}

const isLocked = (reg: { paymentStatus: PaymentStatus; enteredAt: Date | null }) =>
  reg.paymentStatus === PaymentStatus.VERIFIED || reg.enteredAt !== null;

@Injectable()
export class RegistrationsService {
  private readonly logger = new Logger(RegistrationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: EmailOutboxService,
    private readonly config: AppConfig,
  ) {}

  /**
   * Upserts one form response: a Team, a Person per member (one person per email,
   * shared across events), TeamMember rows and one Registration per member, and
   * queues a "registration received" email per member. All-or-nothing.
   * QR tokens are not created here; see PaymentsService.verifyTeam.
   *
   * Re-submitting (Apps Script retry, resync, or an edited response) is idempotent.
   * Members removed from an edited response are dropped unless already verified/entered.
   * A member registered for the same event in another team is moved here if that
   * registration is still unverified; otherwise the whole submission is rejected.
   */
  async ingest(request: IngestRequest, submission: ParsedSubmission): Promise<IngestManyResult> {
    const { eventSlugs, ...base } = request;
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          const results: IngestResult[] = [];
          for (const eventSlug of eventSlugs) {
            const result = await this.ingestInTx(tx, { ...base, eventSlug }, submission);
            const prefix = eventSlugs.length > 1 ? `${this.config.eventName(eventSlug)}: ` : '';
            results.push({ ...result, warnings: result.warnings.map((w) => prefix + w) });
          }
          const staleWarnings = await this.removeDroppedEvents(tx, base.responseId, eventSlugs);
          return {
            outcome: results.some((r) => r.outcome === 'created') ? 'created' : 'updated',
            teamId: results[0].teamId,
            teamName: results[0].teamName,
            memberCount: results[0].memberCount,
            queuedEmails: results.reduce((n, r) => n + r.queuedEmails, 0),
            warnings: [...results.flatMap((r) => r.warnings), ...staleWarnings],
            events: eventSlugs,
          };
        },
        { maxWait: 10_000, timeout: 30_000 },
      );
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new RegistrationRetryableError('Concurrent submission for the same people; retry');
      }
      throw error;
    }
  }

  /**
   * An edited response that no longer lists an event: drop that event's unverified
   * registrations from this response. Verified/entered ones are kept with a warning.
   */
  private async removeDroppedEvents(tx: Prisma.TransactionClient, responseId: string, keep: string[]) {
    const warnings: string[] = [];
    const stale = await tx.team.findMany({
      where: { responseId, eventSlug: { notIn: keep } },
      include: { registrations: { include: { person: { select: { email: true } } } } },
    });
    for (const team of stale) {
      for (const reg of team.registrations) {
        if (isLocked(reg)) {
          warnings.push(
            `${reg.person.email} is no longer registered for ${this.config.eventName(team.eventSlug)} in the form but is already verified/entered; kept, fix manually`,
          );
          continue;
        }
        await tx.teamMember.deleteMany({ where: { teamId: team.id, personId: reg.personId } });
        await tx.registration.delete({ where: { id: reg.id } });
      }
    }
    return warnings;
  }

  /**
   * Finds the person by email, or by a previous email (after a staff email change), so a
   * resync of an old row never recreates the old address. Email itself is never overwritten.
   */
  private async resolvePerson(tx: Prisma.TransactionClient, member: ParsedMember) {
    let collegeId: string | undefined;
    if (member.college && collegeNameKey(member.college)) {
      const college = await tx.college.upsert({
        where: { nameKey: collegeNameKey(member.college) },
        create: { nameKey: collegeNameKey(member.college), name: collegeDisplayName(member.college) },
        update: {},
      });
      collegeId = college.id;
    }
    // undefined fields are left untouched on update, so a form without an upload
    // does not erase a photo collected earlier.
    const profile = {
      name: member.name,
      phone: member.phone,
      college: member.college ? collegeDisplayName(member.college) : undefined,
      collegeId,
      rollNumber: member.rollNumber,
      aadhaarLast4: member.aadhaarLast4,
      // Full number only encrypted, and only when a key is configured.
      aadhaarEncrypted: member.aadhaarFull && this.config.aadhaarKey ? encryptAadhaar(member.aadhaarFull, this.config.aadhaarKey) : undefined,
      aadhaarDriveId: member.aadhaarDriveId,
      photoDriveId: member.photoDriveId,
      idDocumentDriveId: member.idDocumentDriveId,
    };
    const existing =
      (await tx.person.findUnique({ where: { email: member.email } })) ??
      (await tx.personEmailAlias.findUnique({ where: { email: member.email }, include: { person: true } }))?.person;
    if (existing) return tx.person.update({ where: { id: existing.id }, data: profile });
    return tx.person.create({ data: { email: member.email, ...profile } });
  }

  private async ingestInTx(
    tx: Prisma.TransactionClient,
    source: IngestSource,
    submission: ParsedSubmission,
  ): Promise<IngestResult> {
    const { eventSlug, responseId } = source;
    const { members, transactionId } = submission;
    const captain = members.find((m) => m.isCaptain) ?? members[0];
    const teamName = submission.teamName ?? captain.name;
    const warnings: string[] = [];
    const errors: string[] = [];

    const teamKey = { eventSlug_responseId: { eventSlug, responseId } };
    const previousTeam = await tx.team.findUnique({
      where: teamKey,
      include: { members: { include: { person: { select: { email: true } } } } },
    });
    const team = await tx.team.upsert({
      where: teamKey,
      create: { eventSlug, responseId, name: teamName, captainEmail: captain.email },
      update: { name: teamName, captainEmail: captain.email },
    });

    const people = [];
    for (const member of members) {
      people.push({ member, person: await this.resolvePerson(tx, member) });
    }
    const personIds = people.map((p) => p.person.id);
    if (new Set(personIds).size !== personIds.length) {
      throw new RegistrationConflictError(['Two members of this response are the same participant (old and new email)']);
    }

    const existingRegs = new Map(
      (
        await tx.registration.findMany({
          where: { eventSlug, personId: { in: personIds } },
          include: { team: { select: { name: true } } },
        })
      ).map((reg) => [reg.personId, reg]),
    );

    for (const { member, person } of people) {
      const reg = existingRegs.get(person.id);
      if (!reg || reg.teamId === team.id) continue;
      const otherTeam = reg.team ? `team "${reg.team.name}"` : 'another submission';
      if (isLocked(reg)) {
        errors.push(
          `Member ${member.position} (${member.email}) is already registered for this event in ${otherTeam} with verified payment`,
        );
      } else {
        warnings.push(`Member ${member.position} (${member.email}) moved here from ${otherTeam}`);
      }
    }
    if (errors.length > 0) throw new RegistrationConflictError(errors);

    for (const { person } of people) {
      const reg = existingRegs.get(person.id);
      if (reg?.teamId && reg.teamId !== team.id) {
        await tx.teamMember.deleteMany({ where: { teamId: reg.teamId, personId: person.id } });
      }
    }

    for (const old of previousTeam?.members ?? []) {
      if (personIds.includes(old.personId)) continue;
      const reg = await tx.registration.findUnique({
        where: { eventSlug_personId: { eventSlug, personId: old.personId } },
      });
      if (reg?.teamId === team.id && isLocked(reg)) {
        warnings.push(
          `${old.person.email} was removed from the form but is already verified/entered; kept in the team, fix manually`,
        );
        continue;
      }
      await tx.teamMember.delete({ where: { id: old.id } });
      if (reg?.teamId === team.id) await tx.registration.delete({ where: { id: reg.id } });
    }

    const sourceFields = {
      sourceForm: source.sourceForm,
      sourceSheet: source.sourceSheet,
      sourceRow: source.sourceRow,
      responseId,
      ...submission.details,
    };

    const activity: ActivityEntry[] = [];
    const registrationIdByPerson = new Map<string, string>();
    for (const { member, person } of people) {
      const role = member.isCaptain ? 'CAPTAIN' : 'MEMBER';
      await tx.teamMember.upsert({
        where: { teamId_personId: { teamId: team.id, personId: person.id } },
        create: { teamId: team.id, personId: person.id, role },
        update: { role },
      });

      const reg = existingRegs.get(person.id);
      if (!reg) {
        const created = await tx.registration.create({
          data: { eventSlug, personId: person.id, teamId: team.id, transactionId, ...sourceFields },
        });
        registrationIdByPerson.set(person.id, created.id);
        activity.push({
          registrationId: created.id,
          type: ActivityType.SUBMITTED,
          details: {
            responseId,
            sourceRow: source.sourceRow ?? null,
            transactionId: transactionId ?? null,
            expectedArrival: submission.details.expectedArrivalText ?? null,
            expectedDeparture: submission.details.expectedDepartureText ?? null,
          },
        });
        continue;
      }

      const txnChanged = (reg.transactionId ?? undefined) !== transactionId;
      let payment: Prisma.RegistrationUpdateInput = {};
      if (txnChanged && reg.paymentStatus === PaymentStatus.VERIFIED) {
        warnings.push(
          `Member ${member.position}: payment already verified with txn ${reg.transactionId}; new txn ignored`,
        );
      } else if (txnChanged && reg.paymentStatus === PaymentStatus.REJECTED) {
        // A rejected team re-submitting with a new txn goes back into the verification queue.
        payment = {
          transactionId,
          paymentStatus: PaymentStatus.PENDING,
          paymentRemarks: null,
          paymentReviewedBy: { disconnect: true },
          paymentReviewedAt: null,
        };
      } else if (txnChanged) {
        payment = { transactionId };
      }

      await tx.registration.update({
        where: { id: reg.id },
        data: { team: { connect: { id: team.id } }, ...sourceFields, ...payment },
      });
      registrationIdByPerson.set(person.id, reg.id);
      activity.push({
        registrationId: reg.id,
        type: ActivityType.UPDATED,
        details: {
          responseId,
          movedFromTeamId: reg.teamId !== team.id ? reg.teamId : null,
          transactionId: payment.transactionId !== undefined ? (transactionId ?? null) : undefined,
          paymentResetFromRejected: payment.paymentStatus === PaymentStatus.PENDING || undefined,
          expectedArrival:
            submission.details.expectedArrivalText !== undefined && submission.details.expectedArrivalText !== reg.expectedArrivalText
              ? submission.details.expectedArrivalText
              : undefined,
          expectedDeparture:
            submission.details.expectedDepartureText !== undefined && submission.details.expectedDepartureText !== reg.expectedDepartureText
              ? submission.details.expectedDepartureText
              : undefined,
        },
      });
    }
    await recordActivity(tx, activity);

    if (transactionId) {
      const reused = await tx.registration.findMany({
        where: { transactionId, teamId: { not: team.id } },
        distinct: ['teamId'],
        select: { eventSlug: true, team: { select: { name: true } } },
      });
      for (const other of reused) {
        warnings.push(
          `Duplicate txn ${transactionId}: also used by team "${other.team?.name}" (${other.eventSlug})`,
        );
      }
    }

    const eventName = this.config.eventName(eventSlug);
    const queuedEmails = await this.outbox.enqueue(
      people.map(({ member, person }) => ({
        idempotencyKey: `registration-received:${eventSlug}:${person.id}`,
        personId: person.id,
        registrationId: registrationIdByPerson.get(person.id),
        toEmail: person.email,
        subject: `Infinito 2K26: registration received for ${eventName}`,
        template: EmailTemplate.RegistrationReceived,
        payload: {
          name: member.name,
          eventName,
          team: teamName,
          isCaptain: member.isCaptain,
          transactionId: transactionId ?? null,
        },
      })),
      tx,
    );

    this.logger.log(
      `${previousTeam ? 'Updated' : 'Created'} team ${team.id} (${eventSlug}/${responseId}), ${members.length} members, ${warnings.length} warnings`,
    );

    return {
      outcome: previousTeam ? 'updated' : 'created',
      teamId: team.id,
      teamName,
      memberCount: members.length,
      queuedEmails,
      warnings,
    };
  }
}
