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
}

export interface ParsedSubmission {
  teamName?: string;
  transactionId?: string;
  members: ParsedMember[];
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
    .replace(/\s*\*$/, '')
    .replace(/\s*:$/, '')
    .trim();
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

    if (n === 1 && !email && name && context.respondentEmail) {
      email = context.respondentEmail;
    }

    if (![name, email, phone, college, photo, idDocument].some(Boolean)) {
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

    members.push({
      position: n,
      isCaptain: members.length === 0,
      name: name.replace(/\s+/g, ' '),
      email: normalizedEmail,
      phone: normalizedPhone,
      college: college ?? teamCollege,
      photoDriveId: photoIds[0],
      idDocumentDriveId: idDocumentIds[0],
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

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    value: { teamName: pick(lookup, map.teamName), transactionId, members },
    warnings,
  };
}
