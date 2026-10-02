import { z } from 'zod';
import { FormFieldMap } from './form-field-map';

export type RawAnswers = Record<string, string | string[]>;

export interface ParsedMember {
  /** 1-based member number from the form. */
  position: number;
  isCaptain: boolean;
  name: string;
  email: string;
  phone?: string;
  college?: string;
  photoDriveId?: string;
  idDocumentDriveId?: string;
  rollNumber?: string;
  /** Last 4 digits (shown to coordinators/volunteers). */
  aadhaarLast4?: string;
  /** Full 12 digits, only when valid. Stored ENCRYPTED (admin-only), never in plain text. */
  aadhaarFull?: string;
  aadhaarDriveId?: string;
}

/**
 * Per-registration form details. The expected dates are the participant's PLANNED arrival and
 * departure ("Check In Date" / "Check Out Date" in the form), never the actual gate times.
 */
export interface SubmissionDetails {
  accommodation?: string;
  accommodationPeriod?: string;
  expectedArrivalText?: string;
  expectedDepartureText?: string;
  /** Parsed, as a UTC-midnight Date for a Postgres DATE column; undefined if missing/unparseable. */
  expectedArrivalDate?: Date;
  expectedDepartureDate?: Date;
  remark?: string;
}

export interface ParsedSubmission {
  teamName?: string;
  transactionId?: string;
  members: ParsedMember[];
  /** Event slugs from the form's Sports answer; empty = use the sheet's EVENT_SLUG. */
  eventSlugs: string[];
  details: SubmissionDetails;
}

export type ParseResult =
  | { ok: true; value: ParsedSubmission; warnings: string[] }
  | { ok: false; errors: string[] };

export interface ParseContext {
  /** Email collected by the form itself ("Collect email addresses"), used if member 1 has none. */
  respondentEmail?: string;
}

const emailSchema = z.email();

export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\s*:.?]+$/, '');
}

/** "Table Tennis" -> "table-tennis"; matches the EVENT_SLUG format. */
export function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const FEST_TIME_ZONE = 'Asia/Kolkata';

function ymd(year: number, month: number, day: number): string | undefined {
  if (year < 100) year += 2000;
  const date = new Date(Date.UTC(year, month - 1, day));
  const valid = date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  return valid ? date.toISOString().slice(0, 10) : undefined;
}

/**
 * A planned date as typed into / exported from the form, to "YYYY-MM-DD" (fest-local, India).
 * Accepts YYYY-MM-DD, ISO timestamps (a date cell sent as UTC is converted back to India's date),
 * DD/MM/YYYY (also with "-" or "."; day first, as used in India), "5 October 2026",
 * "05 Oct 2026" and "October 5, 2026". Returns undefined for anything else.
 */
export function parseExpectedDate(value: string): string | undefined {
  const t = value.trim();
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return ymd(+m[1], +m[2], +m[3]);
  if (/^\d{4}-\d{2}-\d{2}T/.test(t)) {
    const instant = new Date(t);
    if (Number.isNaN(instant.getTime())) return undefined;
    return new Intl.DateTimeFormat('en-CA', { timeZone: FEST_TIME_ZONE }).format(instant);
  }
  m = t.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/);
  if (m) return ymd(+m[3], +m[2], +m[1]);
  m = t.match(/^(\d{1,2})(?:st|nd|rd|th)?[\s-]+([a-z]{3,9})\.?,?[\s-]+(\d{4})$/i);
  if (m && MONTHS.includes(m[2].slice(0, 3).toLowerCase())) {
    return ymd(+m[3], MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()) + 1, +m[1]);
  }
  m = t.match(/^([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/i);
  if (m && MONTHS.includes(m[1].slice(0, 3).toLowerCase())) {
    return ymd(+m[3], MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1, +m[2]);
  }
  return undefined;
}

/** "YYYY-MM-DD" -> the Date Prisma stores in a DATE column. */
export const dateOnly = (isoDate: string) => new Date(`${isoDate}T00:00:00.000Z`);

/** Digits only; returns the last 4 when there are at least 4. */
export function aadhaarLast4(value: string): { last4?: string; full?: string; valid: boolean } {
  const digits = value.replace(/\D/g, '');
  const valid = digits.length === 12;
  return { last4: digits.length >= 4 ? digits.slice(-4) : undefined, full: valid ? digits : undefined, valid };
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Uppercase, no whitespace, so "utr 1234 5678" and "UTR12345678" compare equal. */
export function normalizeTransactionId(txn: string): string {
  return txn.replace(/\s+/g, '').toUpperCase();
}

/**
 * Indian numbers are reduced to 10 digits; anything else keeps "+<digits>".
 * Returns undefined when the input cannot be a phone number.
 */
export function normalizePhone(phone: string): string | undefined {
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10) return digits;
  if (digits.length === 11 && digits.startsWith('0')) return digits.slice(1);
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2);
  if (digits.length >= 8 && digits.length <= 15) return `+${digits}`;
  return undefined;
}

/**
 * Accepts a bare Drive file ID or any Drive URL form the response sheet uses
 * ("open?id=", "/file/d/<id>/"). Multiple uploads are comma-separated in the sheet.
 */
export function extractDriveFileIds(value: string): string[] {
  return value
    .split(/[,\s]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const byQuery = part.match(/[?&]id=([\w-]+)/);
      if (byQuery) return byQuery[1];
      const byPath = part.match(/\/d\/([\w-]+)/);
      if (byPath) return byPath[1];
      return /^[\w-]{20,}$/.test(part) ? part : undefined;
    })
    .filter((id): id is string => Boolean(id));
}

function buildLookup(answers: RawAnswers): Map<string, string> {
  const lookup = new Map<string, string>();
  for (const [title, raw] of Object.entries(answers)) {
    const value = (Array.isArray(raw) ? raw.join(', ') : raw).trim();
    const key = normalizeTitle(title);
    // Keep the first non-empty answer if a title appears twice.
    if (value && !lookup.get(key)) lookup.set(key, value);
  }
  return lookup;
}

function pick(lookup: Map<string, string>, aliases: string[], n?: number) {
  for (const alias of aliases) {
    const title = n === undefined ? alias : alias.replace('{n}', String(n));
    const value = lookup.get(normalizeTitle(title));
    if (value) return value;
  }
  return undefined;
}

export function parseFormResponse(
  answers: RawAnswers,
  map: FormFieldMap,
  context: ParseContext = {},
): ParseResult {
  const lookup = buildLookup(answers);
  const errors: string[] = [];
  const warnings: string[] = [];
  const members: ParsedMember[] = [];
  const seenEmails = new Map<string, number>();

  const teamCollege = pick(lookup, map.college);

  for (let n = 1; n <= map.maxMembers; n++) {
    const field = (key: keyof typeof map.member) =>
      pick(lookup, map.member[key], n) ??
      (n === 1 ? pick(lookup, map.captain[key] ?? []) : undefined);

    const name = field('name');
    let email = field('email');
    const phone = field('phone');
    const college = field('college');
    const photo = field('photo');
    const idDocument = field('idDocument');
    const rollNumber = field('rollNumber');
    const aadhaarNumber = field('aadhaarNumber');
    const aadhaarPhoto = field('aadhaarPhoto');

    if (n === 1 && !email && name && context.respondentEmail) {
      email = context.respondentEmail;
    }

    if (![name, email, phone, college, photo, idDocument, rollNumber, aadhaarNumber, aadhaarPhoto].some(Boolean)) {
      continue;
    }

    const label = `Member ${n}`;
    if (!name) errors.push(`${label}: name is missing`);
    if (!email) {
      errors.push(`${label}: email is missing`);
    } else if (!emailSchema.safeParse(normalizeEmail(email)).success) {
      errors.push(`${label}: "${email}" is not a valid email`);
    }
    if (!name || !email) continue;

    const normalizedEmail = normalizeEmail(email);
    const duplicateOf = seenEmails.get(normalizedEmail);
    if (duplicateOf !== undefined) {
      errors.push(
        `${label}: email ${normalizedEmail} is also used by Member ${duplicateOf}`,
      );
      continue;
    }
    seenEmails.set(normalizedEmail, n);

    let normalizedPhone: string | undefined;
    if (phone) {
      normalizedPhone = normalizePhone(phone);
      if (!normalizedPhone) warnings.push(`${label}: phone "${phone}" looks invalid`);
    }

    const photoIds = photo ? extractDriveFileIds(photo) : [];
    const idDocumentIds = idDocument ? extractDriveFileIds(idDocument) : [];
    if (photo && photoIds.length === 0) warnings.push(`${label}: photo upload not recognised`);
    if (idDocument && idDocumentIds.length === 0) {
      warnings.push(`${label}: ID upload not recognised`);
    }
    const aadhaarIds = aadhaarPhoto ? extractDriveFileIds(aadhaarPhoto) : [];
    if (aadhaarPhoto && aadhaarIds.length === 0) warnings.push(`${label}: Aadhaar upload not recognised`);
    const aadhaar = aadhaarNumber ? aadhaarLast4(aadhaarNumber) : undefined;
    if (aadhaar && !aadhaar.valid) warnings.push(`${label}: Aadhaar number should have 12 digits`);

    members.push({
      position: n,
      isCaptain: members.length === 0,
      name: name.replace(/\s+/g, ' '),
      email: normalizedEmail,
      phone: normalizedPhone,
      college: college ?? teamCollege,
      photoDriveId: photoIds[0],
      idDocumentDriveId: idDocumentIds[0],
      rollNumber: rollNumber?.replace(/\s+/g, ' ').slice(0, 60),
      aadhaarLast4: aadhaar?.last4,
      aadhaarFull: aadhaar?.full,
      aadhaarDriveId: aadhaarIds[0],
    });
  }

  if (members.length < map.minMembers && errors.length === 0) {
    errors.push(
      `At least ${map.minMembers} member(s) required, found ${members.length}`,
    );
  }

  const rawTxn = pick(lookup, map.transactionId);
  const transactionId = rawTxn ? normalizeTransactionId(rawTxn) : undefined;
  if (map.requireTransactionId && !transactionId) {
    errors.push('Transaction ID is missing');
  }

  // answers.Sports (sent explicitly by the Apps Script) is the single source when present, even
  // if empty; the other aliases (Sport / Event / Game) only apply when there is no Sports key.
  const explicitSports = Object.entries(answers).find(([title]) => normalizeTitle(title) === 'sports');
  const sportsAnswer = explicitSports
    ? (Array.isArray(explicitSports[1]) ? explicitSports[1].join(', ') : explicitSports[1]).trim() || undefined
    : pick(lookup, map.sports);
  const eventSlugs = [
    ...new Set((sportsAnswer ?? '').split(/[,;\n]/).map(slugify).filter(Boolean)),
  ];
  if (sportsAnswer && eventSlugs.length === 0) errors.push(`Sports "${sportsAnswer}" is not a valid event name`);
  if (!sportsAnswer && map.requireSports) errors.push('Sports is missing: the sport/event must be chosen in the form');

  if (errors.length > 0) return { ok: false, errors };

  const detail = (aliases: string[]) => pick(lookup, aliases)?.slice(0, 500);
  const expected = (aliases: string[], label: string) => {
    const text = detail(aliases);
    const iso = text ? parseExpectedDate(text) : undefined;
    // Optional: a missing or unreadable planned date never rejects the registration.
    if (text && !iso) warnings.push(`${label} "${text}" is not a recognised date; kept as text`);
    return { text, date: iso ? dateOnly(iso) : undefined };
  };
  const arrival = expected(map.expectedArrival, 'Check In Date (expected arrival)');
  const departure = expected(map.expectedDeparture, 'Check Out Date (expected departure)');
  if (arrival.date && departure.date && departure.date < arrival.date) {
    warnings.push('Expected departure is before expected arrival');
  }
  return {
    ok: true,
    value: {
      teamName: pick(lookup, map.teamName),
      transactionId,
      members,
      eventSlugs,
      details: {
        accommodation: detail(map.accommodation),
        accommodationPeriod: detail(map.accommodationPeriod),
        expectedArrivalText: arrival.text,
        expectedDepartureText: departure.text,
        expectedArrivalDate: arrival.date,
        expectedDepartureDate: departure.date,
        remark: detail(map.remark),
      },
    },
    warnings,
  };
}
