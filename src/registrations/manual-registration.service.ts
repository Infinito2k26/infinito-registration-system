import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { getFormFieldMap, hasFormFieldOverrides } from '../forms/form-field-map';
import {
  RawAnswers,
  aadhaarLast4,
  extractDriveFileIds,
  normalizeEmail,
  normalizePhone,
  parseExpectedDate,
  parseFormResponse,
} from '../forms/form-response.parser';
import { PrismaService } from '../prisma/prisma.service';
import { DUPLICATE_EMAIL_MESSAGE, emailOwnedByOther } from './participants.service';
import { RegistrationConflictError, RegistrationRetryableError, RegistrationsService } from './registrations.service';

/** The admin form's fields: the same questions as the Google Form (one individual participant). */
export const MANUAL_FIELDS = [
  'name',
  'email',
  'phone',
  'college',
  'rollNumber',
  'idCardLink',
  'aadhaarNumber',
  'aadhaarCardLink',
  'sports',
  'checkIn',
  'checkOut',
  'accommodation',
  'accommodationPeriod',
  'remark',
] as const;
export type ManualParticipantInput = Record<(typeof MANUAL_FIELDS)[number], string>;

const MAX_LENGTH: Partial<Record<(typeof MANUAL_FIELDS)[number], number>> = { remark: 500, idCardLink: 500, aadhaarCardLink: 500 };

/** Shown on the form as-is. Nothing was written. */
export class ManualRegistrationError extends Error {
  constructor(readonly errors: string[]) {
    super(errors.join('; '));
  }
}

/** Source of a manual entry; its response ID is "manual-<submission id>". */
export const MANUAL_SOURCE_FORM = 'manual';
export const manualResponseId = (submissionId: string) => `manual-${submissionId}`;

const emailSchema = z.email();

/**
 * Admin "Add Participant Manually". The entry is turned into the same answers a Google Form row
 * has and goes through the SAME parser and RegistrationsService.ingest as the webhook: same
 * Person / Team / TeamMember / Registration records, Sports slug, Aadhaar handling (last 4 +
 * encrypted full number), college grouping, PENDING status and SUBMITTED audit (with the admin as
 * actor). No email is sent. One individual participant per entry (a team of one, like solo forms).
 */
@Injectable()
export class ManualRegistrationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registrations: RegistrationsService,
  ) {}

  /** Returns the created registration IDs (one per sport). Re-submitting the same entry (double click) returns the same ones. */
  async create(raw: Partial<Record<string, unknown>>, submissionId: string, actorId: string): Promise<{ registrationIds: string[]; warnings: string[] }> {
    const responseId = manualResponseId(submissionId);
    const existing = await this.registrationIdsFor(responseId);
    if (existing.length) return { registrationIds: existing, warnings: [] };

    const input = sanitize(raw);
    const errors = validate(input);
    const email = input.email ? normalizeEmail(input.email) : '';
    if (email && errors.length === 0) {
      // One email = one participant: a manual entry never attaches itself to someone else.
      const owner = await this.prisma.person.findFirst({ where: emailOwnedByOther(email), select: { id: true } });
      const alias = owner ? null : await this.prisma.personEmailAlias.findUnique({ where: { email } });
      if (owner || alias) errors.push(DUPLICATE_EMAIL_MESSAGE);
    }
    if (errors.length) throw new ManualRegistrationError(errors);

    const answers = toAnswers(input);
    let parsed = parseFormResponse(answers, getFormFieldMap());
    if (parsed.ok && parsed.value.eventSlugs.length === 1 && hasFormFieldOverrides(parsed.value.eventSlugs[0])) {
      parsed = parseFormResponse(answers, getFormFieldMap(parsed.value.eventSlugs[0]));
    }
    if (!parsed.ok) throw new ManualRegistrationError(parsed.errors);

    try {
      const result = await this.registrations.ingest(
        {
          eventSlugs: parsed.value.eventSlugs,
          sourceForm: MANUAL_SOURCE_FORM,
          sourceSheet: 'Added manually by admin',
          responseId,
          addedById: actorId,
        },
        parsed.value,
      );
      return { registrationIds: await this.registrationIdsFor(responseId), warnings: [...parsed.warnings, ...result.warnings] };
    } catch (error) {
      if (error instanceof RegistrationConflictError) throw new ManualRegistrationError(error.errors);
      if (error instanceof RegistrationRetryableError) {
        // The same entry submitted twice at once: the other request created it.
        const created = await this.registrationIdsFor(responseId);
        if (created.length) return { registrationIds: created, warnings: [] };
        // Otherwise a concurrent registration took the same email first (unique constraint).
        throw new ManualRegistrationError([email ? DUPLICATE_EMAIL_MESSAGE : 'Someone else saved at the same moment; please submit again']);
      }
      throw error;
    }
  }

  private async registrationIdsFor(responseId: string): Promise<string[]> {
    const regs = await this.prisma.registration.findMany({ where: { responseId }, orderBy: { eventSlug: 'asc' }, select: { id: true } });
    return regs.map((r) => r.id);
  }
}

export function sanitize(raw: Partial<Record<string, unknown>>): ManualParticipantInput {
  const out = {} as ManualParticipantInput;
  for (const key of MANUAL_FIELDS) {
    const value = typeof raw[key] === 'string' ? raw[key] : '';
    // Control characters (newlines, tabs, NUL...) become spaces; the remark is a single line too.
    const clean = Array.from(value, (c) => (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? ' ' : c)).join('');
    out[key] = clean.trim().slice(0, MAX_LENGTH[key] ?? 200);
  }
  return out;
}

/** Stricter than a form import: a typo is an error here instead of a dropped value. */
function validate(input: ManualParticipantInput): string[] {
  const errors: string[] = [];
  if (!input.name) errors.push('Name is required');
  if (!input.sports) errors.push('Sports / event is required');
  if (input.email && !emailSchema.safeParse(normalizeEmail(input.email)).success) errors.push(`"${input.email}" is not a valid email`);
  if (input.phone && !normalizePhone(input.phone)) errors.push(`"${input.phone}" is not a valid mobile number`);
  if (input.aadhaarNumber && !aadhaarLast4(input.aadhaarNumber).valid) errors.push('Aadhaar number must have 12 digits');
  for (const [key, label] of [['idCardLink', 'College ID card'], ['aadhaarCardLink', 'Aadhaar card']] as const) {
    if (input[key] && extractDriveFileIds(input[key]).length === 0) errors.push(`${label}: not a Google Drive link or file ID`);
  }
  for (const [key, label] of [['checkIn', 'Check In Date'], ['checkOut', 'Check Out Date']] as const) {
    if (input[key] && !parseExpectedDate(input[key])) errors.push(`${label} "${input[key]}" is not a date`);
  }
  return errors;
}

/** The entry as Google Form answers (titles the field map already understands). */
function toAnswers(input: ManualParticipantInput): RawAnswers {
  const answers: RawAnswers = {
    Name: input.name,
    'Email Address': input.email,
    'Mobile No': input.phone,
    'College Name': input.college,
    'College Roll No': input.rollNumber,
    'College ID Card Photo': input.idCardLink,
    'Aadhaar No': input.aadhaarNumber,
    'Aadhaar Card Photo': input.aadhaarCardLink,
    Sports: input.sports,
    'Check In Date': input.checkIn,
    'Check Out Date': input.checkOut,
    Accommodation: input.accommodation,
    'Accommodation Period': input.accommodationPeriod,
    Remark: input.remark,
  };
  return answers;
}
