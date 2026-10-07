import { Injectable } from '@nestjs/common';
import { PaymentStatus } from '@prisma/client';
import { AppConfig } from '../config/app-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { decryptAadhaar } from '../registrations/aadhaar-crypto';

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
  blocked: boolean;
  manual: boolean;
}

/** Registrations sharing one Aadhaar number. The full number never leaves this service. */
export interface AadhaarGroup {
  last4: string;
  /** Different participants (Person records) in the group. */
  participants: number;
  registrations: AadhaarRegistration[];
}

export class AadhaarSearchError extends Error {}

/** Only the digits: "1234 5678-9012" and "123456789012" are the same number. */
export const normalizeAadhaar = (value: string) => value.replace(/\D/g, '');

interface Holder {
  /** Full 12 digits (decrypted on the server for this request), or null when only the last 4 are stored. */
  digits: string | null;
  last4: string;
  registrations: AadhaarRegistration[];
}

/**
 * ADMIN Aadhaar duplicate check over the existing Person/Registration data (form imports and
 * manual entries alike). Full numbers are stored AES-GCM encrypted with a random IV, so equal
 * numbers cannot be compared in SQL: they are decrypted in memory for the admin's request only,
 * normalised, and grouped. Nothing is stored, logged or rejected; the admin decides.
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

  /** Aadhaar numbers used by more than one registration (optionally: by more than one participant). */
  async duplicates(onlyDifferentParticipants = false) {
    const holders = await this.holders();
    const comparable = holders.filter((h) => h.digits);
    const groups = this.group(comparable).filter((g) => g.registrations.length > 1 && (!onlyDifferentParticipants || g.participants > 1));
    return {
      groups,
      comparableParticipants: comparable.length,
      /** Participants with only the last 4 digits (invalid number in the form, or no key): not comparable. */
      last4OnlyParticipants: holders.length - comparable.length,
    };
  }

  /** All registrations for a full Aadhaar number or its last 4 digits (any spacing / hyphens). */
  async search(raw: string): Promise<{ kind: 'full' | 'last4'; last4: string; groups: AadhaarGroup[] }> {
    const digits = normalizeAadhaar(raw);
    if (digits.length !== 12 && digits.length !== 4) throw new AadhaarSearchError('Enter the 12-digit Aadhaar number or its last 4 digits');
    const holders = await this.holders();
    if (digits.length === 12) {
      if (!this.canCompare) throw new AadhaarSearchError('Full numbers cannot be searched: AADHAAR_ENCRYPTION_KEY is not configured. Search by the last 4 digits.');
      return { kind: 'full', last4: digits.slice(-4), groups: this.group(holders.filter((h) => h.digits === digits)) };
    }
    // Last 4: one group per distinct full number; participants with only the last 4 stored form their own group.
    return { kind: 'last4', last4: digits, groups: this.group(holders.filter((h) => h.last4 === digits)) };
  }

  private group(holders: Holder[]): AadhaarGroup[] {
    const byKey = new Map<string, Holder[]>();
    for (const h of holders) {
      const key = h.digits ?? `last4-only:${h.last4}`;
      byKey.set(key, [...(byKey.get(key) ?? []), h]);
    }
    return [...byKey.values()]
      .map((members) => ({
        last4: members[0].last4,
        participants: members.length,
        registrations: members.flatMap((m) => m.registrations).sort((a, b) => a.registeredAt.getTime() - b.registeredAt.getTime()),
      }))
      .filter((g) => g.registrations.length > 0)
      .sort((a, b) => b.registrations.length - a.registrations.length || b.participants - a.participants || a.last4.localeCompare(b.last4));
  }

  private async holders(): Promise<Holder[]> {
    const people = await this.prisma.person.findMany({
      where: { OR: [{ aadhaarEncrypted: { not: null } }, { aadhaarLast4: { not: null } }] },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        college: true,
        blockedAt: true,
        aadhaarEncrypted: true,
        aadhaarLast4: true,
        registrations: {
          select: { id: true, eventSlug: true, paymentStatus: true, createdAt: true, paymentReviewedAt: true, sourceForm: true },
        },
      },
    });
    const key = this.config.aadhaarKey;
    return people.flatMap((p) => {
      const decrypted = decryptAadhaar(p.aadhaarEncrypted, key);
      const digits = decrypted && normalizeAadhaar(decrypted).length === 12 ? normalizeAadhaar(decrypted) : null;
      const last4 = digits?.slice(-4) ?? p.aadhaarLast4;
      if (!last4) return [];
      return [
        {
          digits,
          last4,
          registrations: p.registrations.map((r) => ({
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
            blocked: p.blockedAt !== null,
            manual: r.sourceForm === 'manual',
          })),
        },
      ];
    });
  }
}
