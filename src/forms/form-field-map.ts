/**
 * Google Form question titles -> registration fields.
 *
 * This is the only file to touch when the frozen form template changes.
 * Titles are matched case-insensitively, ignoring extra whitespace, a trailing
 * "*" and a trailing ":". Each field accepts several aliases; the first alias
 * with a non-empty answer wins. In member titles, "{n}" is the member number
 * (1-based).
 */
export interface MemberFieldAliases {
  name: string[];
  email: string[];
  phone: string[];
  college: string[];
  photo: string[];
  idDocument: string[];
}

export interface FormFieldMap {
  teamName: string[];
  transactionId: string[];
  /** Team-level college question, used for members who have no college of their own. */
  college: string[];
  member: MemberFieldAliases;
  /** Extra aliases tried for member 1 only, e.g. "Captain Name". */
  captain: Partial<MemberFieldAliases>;
  /** Highest member number the parser looks for. */
  maxMembers: number;
  minMembers: number;
  requireTransactionId: boolean;
}

export const DEFAULT_FORM_FIELD_MAP: FormFieldMap = {
  teamName: ['Team Name'],
  transactionId: [
    'Transaction ID',
    'UPI Transaction ID',
    'UTR Number',
    'UTR',
  ],
  college: ['College', 'College Name', 'Institute'],
  member: {
    name: ['Member {n} Name', 'Member {n} Full Name'],
    email: ['Member {n} Email', 'Member {n} Email ID', 'Member {n} Email Address'],
    phone: ['Member {n} Phone', 'Member {n} Phone Number', 'Member {n} Contact Number'],
    college: ['Member {n} College', 'Member {n} College Name'],
    photo: ['Member {n} Photo', 'Member {n} Photograph'],
    idDocument: ['Member {n} ID', 'Member {n} College ID', 'Member {n} ID Proof'],
  },
  captain: {
    name: ['Captain Name', 'Team Leader Name', 'Name', 'Full Name'],
    email: ['Captain Email', 'Team Leader Email', 'Email', 'Email Address'],
    phone: ['Captain Phone', 'Team Leader Phone', 'Phone', 'Phone Number'],
    photo: ['Captain Photo', 'Photo'],
    idDocument: ['Captain ID', 'College ID', 'ID Proof'],
  },
  maxMembers: 12,
  minMembers: 1,
  requireTransactionId: true,
};

/**
 * Per-event differences from the default template, keyed by event slug.
 * Only list what differs; everything else falls back to the default.
 *
 * Example:
 *   'football': { minMembers: 7, maxMembers: 11 },
 *   'open-mic': { requireTransactionId: false },
 */
export const EVENT_FORM_FIELD_OVERRIDES: Record<string, Partial<FormFieldMap>> =
  {};

export function getFormFieldMap(eventSlug: string): FormFieldMap {
  const override = EVENT_FORM_FIELD_OVERRIDES[eventSlug] ?? {};
  return {
    ...DEFAULT_FORM_FIELD_MAP,
    ...override,
    member: { ...DEFAULT_FORM_FIELD_MAP.member, ...override.member },
    captain: { ...DEFAULT_FORM_FIELD_MAP.captain, ...override.captain },
  };
}
