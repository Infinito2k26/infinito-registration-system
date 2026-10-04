/**
 * Google Form question titles -> registration fields.
 *
 * This is the only file to touch when the frozen form template changes.
 * Titles are matched case-insensitively, ignoring extra whitespace and trailing
 * "*", ":", "." and "?" (so "Email Address *", "Email Address:" and "Mobile No."
 * all match). Each field accepts several aliases; the first alias
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
  rollNumber: string[];
  /** Only the last 4 digits are kept. */
  aadhaarNumber: string[];
  aadhaarPhoto: string[];
}

export interface FormFieldMap {
  teamName: string[];
  transactionId: string[];
  /** Team-level college question, used for members who have no college of their own. */
  college: string[];
  /**
   * Sport/event chosen in the form: the ONLY source of the event (slugified, e.g.
   * "Table Tennis" -> table-tennis; several comma-separated choices = one registration each).
   */
  sports: string[];
  /** A row without a Sports answer is rejected (there is no fallback event). */
  requireSports: boolean;
  accommodation: string[];
  accommodationPeriod: string[];
  /** Form "Check In Date": the PLANNED arrival date (not the gate check-in time). */
  expectedArrival: string[];
  /** Form "Check Out Date": the PLANNED departure date (not the gate check-out time). */
  expectedDeparture: string[];
  remark: string[];
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
  college: ['College Name', 'College', 'Institute', 'Institute Name'],
  sports: ['Sports', 'Sport', 'Event', 'Game'],
  accommodation: ['Accommodation', 'Accommodation Required'],
  accommodationPeriod: ['Accommodation Period'],
  expectedArrival: ['Check In Date', 'Check-in Date', 'Check In', 'Arrival Date', 'Expected Arrival Date'],
  expectedDeparture: ['Check Out Date', 'Check-out Date', 'Check Out', 'Departure Date', 'Expected Departure Date'],
  remark: ['Remark', 'Remarks', 'Comments'],
  member: {
    name: ['Member {n} Name', 'Member {n} Full Name'],
    email: ['Member {n} Email', 'Member {n} Email ID', 'Member {n} Email Address'],
    phone: ['Member {n} Phone', 'Member {n} Phone Number', 'Member {n} Contact Number', 'Member {n} Mobile No', 'Member {n} Mobile Number'],
    college: ['Member {n} College', 'Member {n} College Name'],
    photo: ['Member {n} Photo', 'Member {n} Photograph'],
    idDocument: ['Member {n} ID', 'Member {n} College ID', 'Member {n} ID Proof', 'Member {n} College ID Card Photo'],
    rollNumber: ['Member {n} Roll No', 'Member {n} Roll Number', 'Member {n} College Roll No'],
    aadhaarNumber: ['Member {n} Aadhaar No', 'Member {n} Aadhaar Number', 'Member {n} Aadhar No'],
    aadhaarPhoto: ['Member {n} Aadhaar Card Photo', 'Member {n} Aadhar Card Photo'],
  },
  /** Individual forms ("Name", "Email", "Mobile No." ...) map to member 1. */
  captain: {
    name: ['Captain Name', 'Team Leader Name', 'Name', 'Full Name', 'Participant Name'],
    // "Email Address" (first priority, also the form's collected email) before "Email" (second).
    // The first alias holding a VALID email wins; none = registered without an email.
    email: ['Captain Email', 'Team Leader Email', 'Email Address', 'Email', 'Email ID', 'E-mail'],
    phone: ['Captain Phone', 'Team Leader Phone', 'Mobile No', 'Mobile Number', 'Mobile', 'Phone', 'Phone Number', 'Contact Number'],
    photo: ['Captain Photo', 'Photo', 'Passport Size Photo'],
    idDocument: ['Captain ID', 'College ID Card Photo', 'College ID Card', 'College ID', 'ID Card Photo', 'ID Proof'],
    rollNumber: ['College Roll No', 'College Roll Number', 'Roll No', 'Roll Number'],
    aadhaarNumber: ['Aadhaar No', 'Aadhaar Number', 'Aadhar No', 'Aadhar Number', 'Aadhaar Card Number'],
    aadhaarPhoto: ['Aadhaar Card Photo', 'Aadhar Card Photo', 'Aadhaar Photo', 'Aadhaar Card'],
  },
  maxMembers: 12,
  minMembers: 1,
  // The forms have no payment question; verification is a manual dashboard action.
  // Set true per event (EVENT_FORM_FIELD_OVERRIDES) only for forms that collect a transaction ID.
  requireTransactionId: false,
  requireSports: true,
};

/**
 * Per-event differences from the default template, keyed by the event slug derived from
 * the Sports answer (applied when a row names exactly one sport).
 * Only list what differs; everything else falls back to the default.
 *
 * Example:
 *   'football': { minMembers: 7, maxMembers: 11 },
 *   'paid-workshop': { requireTransactionId: true },
 */
export const EVENT_FORM_FIELD_OVERRIDES: Record<string, Partial<FormFieldMap>> =
  {};

export function hasFormFieldOverrides(eventSlug: string): boolean {
  return Object.prototype.hasOwnProperty.call(EVENT_FORM_FIELD_OVERRIDES, eventSlug);
}

export function getFormFieldMap(eventSlug?: string): FormFieldMap {
  const override = (eventSlug && EVENT_FORM_FIELD_OVERRIDES[eventSlug]) || {};
  return {
    ...DEFAULT_FORM_FIELD_MAP,
    ...override,
    member: { ...DEFAULT_FORM_FIELD_MAP.member, ...override.member },
    captain: { ...DEFAULT_FORM_FIELD_MAP.captain, ...override.captain },
  };
}
