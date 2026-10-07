import { Injectable, Logger } from '@nestjs/common';
import { EmailStatus, Prisma } from '@prisma/client';
import { AppConfig } from '../config/app-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { aadhaarFingerprint, decryptAadhaar, normalizeAadhaar } from './aadhaar-crypto';

type Tx = Prisma.TransactionClient;

/** Counts compared before and after a backfill: nothing but the profile links may change. */
export interface PreservedCounts {
  registrations: number;
  people: number;
  qrTokens: number;
  emailOutbox: number;
  emailOutboxSent: number;
  entryLogs: number;
  activities: number;
}

export interface BackfillReport {
  applied: boolean;
  before: PreservedCounts;
  after: PreservedCounts;
  /** Person records with a readable full Aadhaar. */
  peopleWithFullAadhaar: number;
  /** Person records with an Aadhaar that cannot be read (only last 4, or a different key): left unlinked. */
  peopleWithoutReadableAadhaar: number;
  /** Distinct full Aadhaar numbers = profiles that exist after the backfill. */
  distinctAadhaar: number;
  profilesCreated: number;
  peopleLinked: number;
  /** Full Aadhaar numbers shared by 2+ Person records (grouped, never merged). */
  groupsWithSeveralPeople: number;
  peopleInSharedGroups: number;
  registrationsLinked: number;
  countsUnchanged: boolean;
}

/**
 * ParticipantProfile: ONE FULL AADHAAR = ONE PARTICIPANT (one physical person), grouping the
 * Person records (different emails) that share it, and through them every registration, QR
 * token and email. Identity = HMAC fingerprint of the full number (see aadhaarFingerprint); the
 * number itself stays encrypted on Person. Without AADHAAR_ENCRYPTION_KEY there are no profiles.
 */
@Injectable()
export class ParticipantProfileService {
  private readonly logger = new Logger(ParticipantProfileService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
  ) {}

  fingerprint(aadhaar: string): string | null {
    const key = this.config.aadhaarKey;
    return key ? aadhaarFingerprint(aadhaar, key) : null;
  }

  /**
   * The profile for a full Aadhaar, created if missing, inside the caller's transaction. Race-safe:
   * INSERT ... ON CONFLICT DO NOTHING on the unique fingerprint (a concurrent insert of the same
   * number waits on the index, then this one does nothing), then re-read. Null without a usable
   * full number or key.
   */
  async ensureProfile(tx: Tx, aadhaar: string): Promise<string | null> {
    const fp = this.fingerprint(aadhaar);
    if (!fp) return null;
    const last4 = normalizeAadhaar(aadhaar).slice(-4);
    await tx.$executeRaw`
      INSERT INTO "ParticipantProfile" ("id", "aadhaarFingerprint", "aadhaarLast4", "createdAt", "updatedAt")
      VALUES (gen_random_uuid(), ${fp}, ${last4}, now(), now())
      ON CONFLICT ("aadhaarFingerprint") DO NOTHING`;
    const profile = await tx.participantProfile.findUniqueOrThrow({ where: { aadhaarFingerprint: fp }, select: { id: true } });
    return profile.id;
  }

  /** Serialises registration decisions for one profile (same Aadhaar + same event checks). */
  async lock(tx: Tx, profileId: string) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'profile:' + profileId}))`;
  }

  /** The profile of a full Aadhaar (any format), or null. */
  async findByAadhaar(aadhaar: string) {
    const fp = this.fingerprint(aadhaar);
    return fp ? this.prisma.participantProfile.findUnique({ where: { aadhaarFingerprint: fp }, select: { id: true } }) : null;
  }

  /** IDs of the Person records forming this person's participant (the profile, or just them). */
  async peopleOf(personId: string): Promise<string[]> {
    const person = await this.prisma.person.findUnique({ where: { id: personId }, select: { participantProfileId: true } });
    if (!person?.participantProfileId) return [personId];
    const people = await this.prisma.person.findMany({ where: { participantProfileId: person.participantProfileId }, select: { id: true } });
    return people.map((p) => p.id);
  }

  /**
   * Participant-level view for the participant page: every Person (email), registration, QR token
   * and email record of the profile. Counts come from the records themselves: QR codes = Person
   * records with a QR token (one per email identity, covering all its events); email statistics
   * = EmailOutbox rows by status (one row per email, retries are attempts of the same row).
   */
  async view(personId: string) {
    const person = await this.prisma.person.findUnique({
      where: { id: personId },
      select: { participantProfileId: true, participantProfile: { select: { id: true, aadhaarLast4: true, createdAt: true } } },
    });
    if (!person) return null;
    const people = await this.prisma.person.findMany({
      where: person.participantProfileId ? { participantProfileId: person.participantProfileId } : { id: personId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        college: true,
        qrToken: true,
        blockedAt: true,
        blockReason: true,
        blockedBy: { select: { name: true, email: true } },
        emailAliases: { select: { email: true } },
      },
    });
    const ids = people.map((p) => p.id);
    const registrations = await this.prisma.registration.findMany({
      where: { personId: { in: ids } },
      orderBy: [{ eventSlug: 'asc' }, { createdAt: 'asc' }],
      select: {
        id: true,
        eventSlug: true,
        paymentStatus: true,
        insideSince: true,
        enteredAt: true,
        createdAt: true,
        sourceForm: true,
        personId: true,
        person: { select: { name: true, email: true } },
      },
    });
    const emails = await this.prisma.emailOutbox.findMany({
      where: { OR: [{ personId: { in: ids } }, { registrationId: { in: registrations.map((r) => r.id) } }] },
      orderBy: { createdAt: 'desc' },
      select: { id: true, template: true, toEmail: true, status: true, attempts: true, createdAt: true, sendAt: true, sentAt: true, updatedAt: true, lastError: true, deliveryStatus: true },
    });
    const count = (...statuses: EmailStatus[]) => emails.filter((e) => statuses.includes(e.status)).length;
    const perEvent = new Map<string, number>();
    for (const r of registrations) perEvent.set(r.eventSlug, (perEvent.get(r.eventSlug) ?? 0) + 1);
    return {
      profile: person.participantProfile,
      people,
      emailAddresses: [...new Set(people.flatMap((p) => (p.email ? [p.email] : [])))],
      previousEmails: [...new Set(people.flatMap((p) => p.emailAliases.map((a) => a.email)))],
      registrations,
      events: perEvent.size,
      /** Events with more than one registration in this profile (older duplicates). */
      duplicateEvents: [...perEvent].filter(([, n]) => n > 1).map(([slug]) => slug),
      qrCodes: people.filter((p) => p.qrToken).length,
      emailStats: {
        records: emails.length,
        sent: count(EmailStatus.SENT),
        queued: count(EmailStatus.PENDING, EmailStatus.PROCESSING),
        failed: count(EmailStatus.FAILED),
        cancelled: count(EmailStatus.CANCELLED),
      },
      emails,
    };
  }

  private async counts(): Promise<PreservedCounts> {
    const [registrations, people, qrTokens, emailOutbox, emailOutboxSent, entryLogs, activities] = await Promise.all([
      this.prisma.registration.count(),
      this.prisma.person.count(),
      this.prisma.person.count({ where: { qrToken: { not: null } } }),
      this.prisma.emailOutbox.count(),
      this.prisma.emailOutbox.count({ where: { status: EmailStatus.SENT } }),
      this.prisma.entryLog.count(),
      this.prisma.registrationActivity.count(),
    ]);
    return { registrations, people, qrTokens, emailOutbox, emailOutboxSent, entryLogs, activities };
  }

  /**
   * Groups EXISTING data into profiles: every Person with a readable full Aadhaar is linked to the
   * profile of that number (created if missing). Only Person.participantProfileId changes; no
   * registration, QR token, email, gate log or activity is created, changed or deleted, and Person
   * records are grouped, never merged. Idempotent. Dry run (no writes) unless `apply`.
   */
  async backfill(apply: boolean): Promise<BackfillReport> {
    const key = this.config.aadhaarKey;
    if (!key) throw new Error('AADHAAR_ENCRYPTION_KEY is not set: full Aadhaar numbers cannot be read');
    const before = await this.counts();
    const people = await this.prisma.person.findMany({
      where: { aadhaarEncrypted: { not: null } },
      select: { id: true, aadhaarEncrypted: true, participantProfileId: true, _count: { select: { registrations: true } } },
    });
    const groups = new Map<string, { digits: string; people: typeof people }>();
    let unreadable = 0;
    for (const p of people) {
      const digits = decryptAadhaar(p.aadhaarEncrypted, key);
      const fp = digits ? aadhaarFingerprint(digits, key) : null;
      if (!digits || !fp) {
        unreadable++;
        continue;
      }
      const group = groups.get(fp) ?? { digits, people: [] };
      group.people.push(p);
      groups.set(fp, group);
    }
    const existing = new Set((await this.prisma.participantProfile.findMany({ select: { aadhaarFingerprint: true } })).map((p) => p.aadhaarFingerprint));
    const shared = [...groups.values()].filter((g) => g.people.length > 1);
    let profilesCreated = 0;
    let peopleLinked = 0;
    for (const [fp, group] of groups) {
      if (!existing.has(fp)) profilesCreated++;
      if (!apply) {
        peopleLinked += group.people.filter((p) => !p.participantProfileId).length;
        continue;
      }
      await this.prisma.$transaction(async (tx) => {
        const profileId = (await this.ensureProfile(tx, group.digits))!;
        const toLink = group.people.filter((p) => p.participantProfileId !== profileId).map((p) => p.id);
        if (toLink.length) {
          peopleLinked += (await tx.person.updateMany({ where: { id: { in: toLink } }, data: { participantProfileId: profileId } })).count;
        }
      });
    }
    const after = await this.counts();
    const report: BackfillReport = {
      applied: apply,
      before,
      after,
      peopleWithFullAadhaar: people.length - unreadable,
      peopleWithoutReadableAadhaar: unreadable + (await this.prisma.person.count({ where: { aadhaarEncrypted: null, aadhaarLast4: { not: null } } })),
      distinctAadhaar: groups.size,
      profilesCreated,
      peopleLinked,
      groupsWithSeveralPeople: shared.length,
      peopleInSharedGroups: shared.reduce((n, g) => n + g.people.length, 0),
      registrationsLinked: [...groups.values()].reduce((n, g) => n + g.people.reduce((m, p) => m + p._count.registrations, 0), 0),
      countsUnchanged: JSON.stringify(before) === JSON.stringify(after),
    };
    this.logger.log(`Profile backfill (${apply ? 'applied' : 'dry run'}): ${report.distinctAadhaar} profiles, ${report.peopleLinked} people linked, counts unchanged: ${report.countsUnchanged}`);
    return report;
  }
}
