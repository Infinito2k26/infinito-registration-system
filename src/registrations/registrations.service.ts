import { Injectable, Logger } from '@nestjs/common';
import { ActivityType, PaymentStatus, Prisma } from '@prisma/client';
import { AppConfig } from '../config/app-config.service';
import { ParsedMember, ParsedSubmission } from '../forms/form-response.parser';
import { PrismaService } from '../prisma/prisma.service';
import { ActivityEntry, recordActivity } from './activity';
import { encryptAadhaar } from './aadhaar-crypto';
import { collegeDisplayName, collegeNameKey } from './college';
import { ParticipantProfileService } from './participant-profile.service';
import { ParticipantsService, emailOwnedByOther } from './participants.service';

export interface IngestSource {
  eventSlug: string;
  sourceForm: string;
  sourceSheet?: string;
  sourceRow?: number;
  /** Stable per response row; re-ingesting the same responseId updates instead of duplicating. */
  responseId: string;
  /** Admin who added the participant manually (no form row); recorded on the SUBMITTED activity. */
  addedById?: string;
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
    private readonly config: AppConfig,
    private readonly participants: ParticipantsService,
    private readonly profiles: ParticipantProfileService,
  ) {}

  /**
   * Upserts one form response: a Team, a Person per member (one person per email,
   * shared across events), TeamMember rows and one Registration per member. All-or-nothing.
   * No "registration received" email is sent on import or resync.
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
      // A lock conflict with a simultaneous staff action (verification / Change email); nothing was written.
      if (error instanceof Prisma.PrismaClientKnownRequestError && (error.code === 'P2034' || /deadlock/i.test(error.message))) {
        throw new RegistrationRetryableError('Concurrent staff action on the same people; retry');
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
            `${reg.person.email ?? 'A participant without an email'} is no longer registered for ${this.config.eventName(team.eventSlug)} in the form but is already verified/entered; kept, fix manually`,
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
   * Finds the person by email, or by a previous email (after a staff email change), or, for a
   * participant first created without an email, by this form row + member position (sourceKey),
   * so a resync never creates a duplicate. An existing email is never overwritten; a person who
   * has none adopts the row's email (then their pending emails are queued, see below).
   */
  private async resolvePerson(tx: Prisma.TransactionClient, member: ParsedMember, responseId: string) {
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
    const sourceKey = `${responseId}#${member.position}`;
    const existing =
      (member.email
        ? // Case-insensitive, so an email can never be split across two participants by letter case.
          ((await tx.person.findFirst({ where: emailOwnedByOther(member.email) })) ??
          (await tx.personEmailAlias.findUnique({ where: { email: member.email }, include: { person: true } }))?.person)
        : undefined) ?? (await tx.person.findUnique({ where: { sourceKey } }));
    if (!existing) {
      const created = await tx.person.create({ data: { email: member.email, sourceKey: member.email ? undefined : sourceKey, ...profile } });
      return { person: await this.linkProfile(tx, created, member), emailAdded: false };
    }
    let emailAdded = false;
    if (!existing.email && member.email) {
      // Same per-person lock as Change email and verification, and only while still empty, so a
      // staff-entered email is never overwritten and the emails owed are queued exactly once.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'person-email:' + existing.id}))`;
      emailAdded = (await tx.person.updateMany({ where: { id: existing.id, email: null }, data: { email: member.email } })).count === 1;
    }
    const person = await tx.person.update({ where: { id: existing.id }, data: profile });
    return { person: await this.linkProfile(tx, person, member), emailAdded };
  }

  /**
   * ONE FULL AADHAAR = ONE PARTICIPANT PROFILE: links the person to the profile of the member's
   * full Aadhaar (created if missing, race-safe). Different emails with the same Aadhaar stay
   * separate Person records in the same profile. Without a full Aadhaar nothing changes.
   */
  private async linkProfile<T extends { id: string; participantProfileId: string | null }>(tx: Prisma.TransactionClient, person: T, member: ParsedMember): Promise<T> {
    if (!member.aadhaarFull) return person;
    const profileId = await this.profiles.ensureProfile(tx, member.aadhaarFull);
    if (!profileId || person.participantProfileId === profileId) return person;
    await tx.person.update({ where: { id: person.id }, data: { participantProfileId: profileId } });
    // A blocked participant stays blocked: a record joining a blocked profile takes its block.
    const blocked = await tx.person.findFirst({
      where: { participantProfileId: profileId, id: { not: person.id }, blockedAt: { not: null } },
      select: { blockedAt: true, blockedById: true, blockReason: true },
    });
    if (blocked) await tx.person.updateMany({ where: { id: person.id, blockedAt: null }, data: blocked });
    return { ...person, participantProfileId: profileId };
  }

  /**
   * Why a NEW registration for this person and event must not be created, or null:
   * - an admin deleted it (Duplicate Aadhaar Check): a resync of the form row does not bring it back;
   * - the same full Aadhaar (same profile) is already registered for this event under another
   *   email: duplicate registration (the new email stays on the profile).
   * Serialised per profile, so two rows arriving together cannot both register.
   */
  private async skipNewRegistration(
    tx: Prisma.TransactionClient,
    source: IngestSource,
    member: ParsedMember,
    person: { id: string; participantProfileId: string | null },
  ): Promise<string | null> {
    const eventName = this.config.eventName(source.eventSlug);
    const who = `Member ${member.position} (${member.email ?? member.name})`;
    const deleted = await tx.registrationDeletion.findFirst({
      where: { responseId: source.responseId, eventSlug: source.eventSlug, personId: person.id },
      select: { id: true },
    });
    if (deleted) return `${who}: the ${eventName} registration was deleted by an admin; not recreated`;
    if (!person.participantProfileId) return null;
    await this.profiles.lock(tx, person.participantProfileId);
    const other = await tx.registration.findFirst({
      where: { eventSlug: source.eventSlug, personId: { not: person.id }, person: { participantProfileId: person.participantProfileId } },
      select: { person: { select: { name: true, email: true } } },
    });
    if (!other) return null;
    return `${who}: the same Aadhaar is already registered for ${eventName} (${other.person.email ?? other.person.name ?? 'another record'}); duplicate registration not created`;
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
    const emailAdded: string[] = [];
    for (const member of members) {
      const resolved = await this.resolvePerson(tx, member, responseId);
      people.push({ member, person: resolved.person });
      if (resolved.emailAdded) emailAdded.push(resolved.person.id);
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
          `Member ${member.position} (${member.email ?? member.name}) is already registered for this event in ${otherTeam} with verified payment`,
        );
      } else {
        warnings.push(`Member ${member.position} (${member.email ?? member.name}) moved here from ${otherTeam}`);
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
          `${old.person.email ?? 'A participant without an email'} was removed from the form but is already verified/entered; kept in the team, fix manually`,
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
    for (const { member, person } of people) {
      const reg = existingRegs.get(person.id);
      if (!reg) {
        const skip = await this.skipNewRegistration(tx, source, member, person);
        if (skip) {
          warnings.push(skip);
          continue;
        }
      }
      const role = member.isCaptain ? 'CAPTAIN' : 'MEMBER';
      await tx.teamMember.upsert({
        where: { teamId_personId: { teamId: team.id, personId: person.id } },
        create: { teamId: team.id, personId: person.id, role },
        update: { role },
      });

      if (!reg) {
        const created = await tx.registration.create({
          data: { eventSlug, personId: person.id, teamId: team.id, transactionId, ...sourceFields },
        });
        activity.push({
          registrationId: created.id,
          type: ActivityType.SUBMITTED,
          actorId: source.addedById,
          details: {
            manual: source.addedById ? true : undefined,
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

    // The form row now carries an email for a participant who had none: if already verified,
    // their QR passes go to it (no "registration received" email on import).
    let queuedEmails = 0;
    for (const personId of emailAdded) {
      const to = people.find((p) => p.person.id === personId)?.person.email ?? null;
      const regs = await tx.registration.findMany({ where: { personId }, select: { id: true } });
      await recordActivity(
        tx,
        regs.map((r) => ({ registrationId: r.id, type: ActivityType.EMAIL_CHANGED, details: { from: null, to, source: 'form' } })),
      );
      const queued = await this.participants.queueEmailsForNewAddress(tx, personId);
      queuedEmails += queued.qrEmails;
    }

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
