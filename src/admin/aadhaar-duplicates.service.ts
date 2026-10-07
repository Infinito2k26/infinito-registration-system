import { Injectable } from '@nestjs/common';
import { PaymentStatus } from '@prisma/client';
import { AppConfig } from '../config/app-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { aadhaarFingerprint, decryptAadhaar, normalizeAadhaar } from '../registrations/aadhaar-crypto';

export { normalizeAadhaar } from '../registrations/aadhaar-crypto';

/** One registration of a participant who has an Aadhaar number on file. */
export interface AadhaarRegistration {
  registrationId: string;
  personId: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  college: string | null;
  eventSlug: string;
  paymentStatus: PaymentStatus;
  registeredAt: Date;
  reviewedAt: Date | null;
  enteredAt: Date | null;
  blocked: boolean;
  manual: boolean;
}

/** One participant (Aadhaar profile, or unlinked records of one number). The full number never leaves this service. */
export interface AadhaarGroup {
  last4: string;
  /** The ParticipantProfile, or null for records not linked yet (run the profile backfill) / last 4 only. */
  profileId: string | null;
  /** Person records (emails) in the group. */
  participants: number;
  registrations: AadhaarRegistration[];
  /** Events registered more than once in this group: the actual duplicate registrations. */
  duplicateEvents: string[];
}

export class AadhaarSearchError extends Error {}

const personSelect = {
  id: true,
  name: true,
  email: true,
  phone: true,
  college: true,
  blockedAt: true,
  aadhaarEncrypted: true,
  aadhaarLast4: true,
  participantProfileId: true,
  registrations: {
    select: { id: true, eventSlug: true, paymentStatus: true, createdAt: true, paymentReviewedAt: true, enteredAt: true, sourceForm: true },
  },
} as const;

/**
 * ADMIN Duplicate Aadhaar Check, by search only (nothing is listed until an admin searches).
 * Identity = the FULL Aadhaar: a 12-digit search finds the one ParticipantProfile of that number
 * (by its fingerprint); a last-4 search lists every possible profile separately and never merges
 * different numbers. Records not linked to a profile yet are found by decrypting in memory.
 */
@Injectable()
export class AadhaarDuplicatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
  ) {}

  /** Without AADHAAR_ENCRYPTION_KEY full numbers cannot be read, so only last-4 search works. */
  get canCompare(): boolean {
    return this.config.aadhaarKey !== null;
  }

  async search(raw: string): Promise<{ kind: 'full' | 'last4'; last4: string; groups: AadhaarGroup[] }> {
    const digits = normalizeAadhaar(raw);
    if (digits.length !== 12 && digits.length !== 4) throw new AadhaarSearchError('Enter the 12-digit Aadhaar number or its last 4 digits');
    const key = this.config.aadhaarKey;
    if (digits.length === 12) {
      if (!key) throw new AadhaarSearchError('Full numbers cannot be searched: AADHAAR_ENCRYPTION_KEY is not configured. Search by the last 4 digits.');
      const fp = aadhaarFingerprint(digits, key)!;
      const profile = await this.prisma.participantProfile.findUnique({ where: { aadhaarFingerprint: fp }, select: { id: true } });
      const people = [
        ...(profile ? await this.prisma.person.findMany({ where: { participantProfileId: profile.id }, select: personSelect }) : []),
        // Not linked yet (before the backfill): same number, read in memory.
        ...(await this.unlinked(digits.slice(-4))).filter((p) => this.digitsOf(p) === digits),
      ];
      return { kind: 'full', last4: digits.slice(-4), groups: this.group(people) };
    }
    const profiles = await this.prisma.participantProfile.findMany({ where: { aadhaarLast4: digits }, select: { id: true } });
    const people = [
      ...(await this.prisma.person.findMany({ where: { participantProfileId: { in: profiles.map((p) => p.id) } }, select: personSelect })),
      ...(await this.unlinked(digits)),
    ];
    return { kind: 'last4', last4: digits, groups: this.group(people) };
  }

  private unlinked(last4: string) {
    return this.prisma.person.findMany({ where: { participantProfileId: null, aadhaarLast4: last4 }, select: personSelect });
  }

  private digitsOf(p: { aadhaarEncrypted: string | null }): string | null {
    const d = decryptAadhaar(p.aadhaarEncrypted, this.config.aadhaarKey);
    return d && normalizeAadhaar(d).length === 12 ? normalizeAadhaar(d) : null;
  }

  /** One group per profile; unlinked records per decrypted number; last-4-only records each alone. */
  private group(people: { id: string; participantProfileId: string | null; aadhaarLast4: string | null; aadhaarEncrypted: string | null; name: string | null; email: string | null; phone: string | null; college: string | null; blockedAt: Date | null; registrations: { id: string; eventSlug: string; paymentStatus: PaymentStatus; createdAt: Date; paymentReviewedAt: Date | null; enteredAt: Date | null; sourceForm: string | null }[] }[]): AadhaarGroup[] {
    const byKey = new Map<string, { profileId: string | null; last4: string; people: typeof people }>();
    for (const p of people) {
      const digits = p.participantProfileId ? null : this.digitsOf(p);
      const key = p.participantProfileId ?? (digits ? `n:${digits}` : `p:${p.id}`);
      const last4 = digits?.slice(-4) ?? p.aadhaarLast4 ?? '';
      const g = byKey.get(key) ?? { profileId: p.participantProfileId, last4, people: [] };
      if (!g.people.some((x) => x.id === p.id)) g.people.push(p);
      byKey.set(key, g);
    }
    return [...byKey.values()]
      .map((g) => {
        const registrations: AadhaarRegistration[] = g.people
          .flatMap((p) =>
            p.registrations.map((r) => ({
              registrationId: r.id,
              personId: p.id,
              name: p.name,
              email: p.email,
              phone: p.phone,
              college: p.college,
              eventSlug: r.eventSlug,
              paymentStatus: r.paymentStatus,
              registeredAt: r.createdAt,
              reviewedAt: r.paymentReviewedAt,
              enteredAt: r.enteredAt,
              blocked: p.blockedAt !== null,
              manual: r.sourceForm === 'manual',
            })),
          )
          .sort((a, b) => a.eventSlug.localeCompare(b.eventSlug) || a.registeredAt.getTime() - b.registeredAt.getTime());
        const perEvent = new Map<string, number>();
        for (const r of registrations) perEvent.set(r.eventSlug, (perEvent.get(r.eventSlug) ?? 0) + 1);
        return {
          last4: g.last4,
          profileId: g.profileId,
          participants: g.people.length,
          registrations,
          duplicateEvents: [...perEvent].filter(([, n]) => n > 1).map(([slug]) => slug),
        };
      })
      .sort((a, b) => b.registrations.length - a.registrations.length);
  }
}
