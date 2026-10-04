import { DEFAULT_FORM_FIELD_MAP, FormFieldMap } from './form-field-map';
import {
  extractDriveFileIds,
  aadhaarLast4,
  normalizePhone,
  parseExpectedDate,
  parseFormResponse,
} from './form-response.parser';

// Most tests below exercise other fields, so they don't repeat a Sports answer.
const map: FormFieldMap = { ...DEFAULT_FORM_FIELD_MAP, requireSports: false };

describe('parseFormResponse', () => {
  it('parses a team, normalising emails, phones, txn and Drive links', () => {
    const result = parseFormResponse(
      {
        'Team Name': 'Byte Me',
        'Transaction ID *': ' utr 1234 5678 ',
        'College:': 'IIT Patna',
        'Member 1 Name': 'Asha  Rao',
        'member 1 email': ' Asha@Example.COM ',
        'Member 1 Phone': '+91 98765 43210',
        'Member 1 Photo': 'https://drive.google.com/open?id=1AbCdEfGhIjKlMnOpQrStUv',
        'Member 2 Name': 'Ravi',
        'Member 2 Email': 'ravi@example.com',
        'Member 2 College': 'NIT Patna',
        'Member 2 ID': [
          'https://drive.google.com/file/d/1ZyXwVuTsRqPoNmLkJiHgFe/view',
        ],
        Payment: '',
      },
      map,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.teamName).toBe('Byte Me');
    expect(result.value.transactionId).toBe('UTR12345678');
    expect(result.value.members).toEqual([
      {
        position: 1,
        isCaptain: true,
        name: 'Asha Rao',
        email: 'asha@example.com',
        phone: '9876543210',
        college: 'IIT Patna',
        photoDriveId: '1AbCdEfGhIjKlMnOpQrStUv',
        idDocumentDriveId: undefined,
      },
      {
        position: 2,
        isCaptain: false,
        name: 'Ravi',
        email: 'ravi@example.com',
        phone: undefined,
        college: 'NIT Patna',
        photoDriveId: undefined,
        idDocumentDriveId: '1ZyXwVuTsRqPoNmLkJiHgFe',
      },
    ]);
  });

  it('skips blank member slots and makes the first filled one captain', () => {
    const result = parseFormResponse(
      {
        'Transaction ID': 'T1',
        'Member 2 Name': 'Solo',
        'Member 2 Email': 'solo@example.com',
      },
      map,
    );
    expect(result.ok && result.value.members.map((m) => [m.position, m.isCaptain])).toEqual([
      [2, true],
    ]);
  });

  it('falls back to captain aliases and the collected respondent email', () => {
    const result = parseFormResponse(
      { Name: 'Solo Person', 'UTR Number': 'abc' },
      map,
      { respondentEmail: 'solo@example.com' },
    );
    expect(result.ok && result.value.members[0]).toMatchObject({
      name: 'Solo Person',
      email: 'solo@example.com',
    });
  });

  it('reports every problem at once', () => {
    const result = parseFormResponse(
      {
        'Member 1 Name': 'A',
        'Member 1 Email': 'a@example',
        'Member 2 Email': 'b@example.com',
        'Member 3 Name': 'C',
        'Member 3 Email': 'b@example.com',
        'Member 4 Name': 'D',
        'Member 4 Email': 'B@example.com',
      },
      { ...map, requireTransactionId: true },
    );
    expect(result).toEqual({
      ok: false,
      // An invalid email is no longer an error (Member 1 is kept, without an email).
      errors: [
        'Member 2: name is missing',
        'Member 4: email b@example.com is also used by Member 3',
        'Transaction ID is missing',
      ],
    });
  });

  describe('email priority: "Email Address" first, then "Email"; email is optional', () => {
    const solo = (answers: Record<string, string>, respondentEmail?: string) =>
      parseFormResponse({ Name: 'Solo', Sports: 'TT', ...answers }, map, { respondentEmail });

    it('uses "Email Address" when it has a valid email (as an answer or as the collected column)', () => {
      const asAnswer = solo({ 'Email Address': 'A@Gmail.com', Email: 'b@gmail.com' });
      expect(asAnswer.ok && asAnswer.value.members[0].email).toBe('a@gmail.com');
      // The Apps Script sends the sheet's "Email Address" column as respondentEmail.
      const collected = solo({ Email: 'b@gmail.com' }, 'a@gmail.com');
      expect(collected.ok && collected.value.members[0].email).toBe('a@gmail.com');
      const onlyAddress = solo({ 'Email Address': 'a@gmail.com' });
      expect(onlyAddress.ok && onlyAddress.value.members[0].email).toBe('a@gmail.com');
    });

    it('falls back to "Email" when "Email Address" is empty or not a valid email', () => {
      const empty = solo({ 'Email Address': '  ', Email: 'b@gmail.com' }, '');
      expect(empty.ok && empty.value.members[0].email).toBe('b@gmail.com');
      const invalid = solo({ Email: 'b@gmail.com' }, 'not-an-email');
      expect(invalid.ok && invalid.value.members[0].email).toBe('b@gmail.com');
    });

    it('accepts the registration with no email when both are empty (warning only)', () => {
      const none = solo({ 'Email Address': '', Email: '' });
      expect(none.ok).toBe(true);
      if (!none.ok) return;
      expect(none.value.members).toHaveLength(1);
      expect(none.value.members[0]).toMatchObject({ name: 'Solo' });
      expect(none.value.members[0].email).toBeUndefined();
      expect(none.warnings.join(' ')).toMatch(/no email/);
    });

    it('accepts the registration with no email when the only email is invalid (warning only)', () => {
      const bad = solo({ Email: 'b@gmail' });
      expect(bad.ok && bad.value.members[0].email).toBeUndefined();
      expect(bad.ok && bad.warnings.join(' ')).toMatch(/"b@gmail" is not a valid email; registered without an email/);
    });
  });

  it('enforces per-event minimum members and optional txn', () => {
    const result = parseFormResponse(
      { 'Member 1 Name': 'A', 'Member 1 Email': 'a@example.com' },
      { ...map, minMembers: 2, requireTransactionId: false },
    );
    expect(result).toEqual({
      ok: false,
      errors: ['At least 2 member(s) required, found 1'],
    });
  });

  it('warns but does not fail on a bad phone number', () => {
    const result = parseFormResponse(
      {
        'Transaction ID': 'T1',
        'Member 1 Name': 'A',
        'Member 1 Email': 'a@example.com',
        'Member 1 Phone': '12345',
      },
      map,
    );
    expect(result.ok && result.warnings).toEqual([
      'Member 1: phone "12345" looks invalid',
    ]);
  });
});

describe('the actual individual registration form', () => {
  const row = {
    Timestamp: '2026-10-03T09:00:00.000Z',
    'Email Address *': ' Priya.S@Example.com ',
    'College Name': '  NIT   Patna ',
    'Sports:': 'Table Tennis',
    'Name ': 'Priya Sharma',
    'Mobile No.': '+91 98765 43210',
    'College Roll No.': ' 2201CS42 ',
    'College ID Card Photo': 'https://drive.google.com/open?id=1CollegeIdCardFileIdAAAAA',
    'Aadhaar No.': '1234 5678 9012',
    'Aadhaar Card Photo': 'https://drive.google.com/open?id=1AadhaarCardFileIdBBBBBB',
    'Check In Date': '10/10/2026',
    'Check Out Date': '12/10/2026',
    Accommodation: 'Yes',
    'Accommodation Period': '2 nights',
    Remark: 'Vegetarian',
  };

  it('maps every column, keeps only the last 4 Aadhaar digits and derives the event from Sports', () => {
    const result = parseFormResponse(row, map);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings).toEqual([]);
    expect(result.value.eventSlugs).toEqual(['table-tennis']);
    expect(result.value.transactionId).toBeUndefined();
    expect(result.value.members).toEqual([
      {
        position: 1,
        isCaptain: true,
        name: 'Priya Sharma',
        email: 'priya.s@example.com',
        phone: '9876543210',
        college: 'NIT   Patna', // trimmed here; spaces are collapsed when the college is resolved
        photoDriveId: undefined,
        idDocumentDriveId: '1CollegeIdCardFileIdAAAAA',
        rollNumber: '2201CS42',
        aadhaarLast4: '9012',
        aadhaarFull: '123456789012', // in memory only; stored encrypted
        aadhaarDriveId: '1AadhaarCardFileIdBBBBBB',
      },
    ]);
    expect(aadhaarLast4('1234 5678').full).toBeUndefined(); // only a valid 12-digit number is kept
    expect(result.value.details).toEqual({
      accommodation: 'Yes',
      accommodationPeriod: '2 nights',
      expectedArrivalText: '10/10/2026',
      expectedDepartureText: '12/10/2026',
      expectedArrivalDate: new Date('2026-10-10T00:00:00.000Z'),
      expectedDepartureDate: new Date('2026-10-12T00:00:00.000Z'),
      remark: 'Vegetarian',
    });
  });

  it.each(['Email', 'Email ID', 'Email Address', 'Email Address *', 'Email Address:', 'EMAIL  ID.'])(
    'recognises the email column titled %j',
    (title) => {
      const result = parseFormResponse({ Name: 'A', [title]: 'a@example.com' }, map);
      expect(result.ok && result.value.members[0].email).toBe('a@example.com');
    },
  );

  it('splits several sports into one event each, and leaves events empty without a Sports answer', () => {
    const multi = parseFormResponse({ ...row, 'Sports:': 'Football, Table Tennis' }, map);
    expect(multi.ok && multi.value.eventSlugs).toEqual(['football', 'table-tennis']);
    const none = parseFormResponse({ Name: 'A', Email: 'a@example.com' }, map);
    expect(none.ok && none.value.eventSlugs).toEqual([]);
  });

  it('warns about a malformed Aadhaar number but still imports', () => {
    const result = parseFormResponse({ ...row, 'Aadhaar No.': '12345' }, map);
    expect(result.ok && result.warnings).toEqual(['Member 1: Aadhaar number should have 12 digits']);
  });
});

describe('expected (planned) dates', () => {
  it.each([
    ['2026-10-05', '2026-10-05'],
    ['05/10/2026', '2026-10-05'], // day first (India)
    ['5/10/2026', '2026-10-05'],
    ['5-10-2026', '2026-10-05'],
    ['5.10.26', '2026-10-05'],
    ['2026-10-04T18:30:00.000Z', '2026-10-05'], // a date cell exported as UTC midnight IST
    ['5 October 2026', '2026-10-05'],
    ['05 Oct 2026', '2026-10-05'],
    ['October 5, 2026', '2026-10-05'],
    ['5th Oct, 2026', '2026-10-05'],
    ['31/02/2026', undefined],
    ['next week', undefined],
    ['', undefined],
  ])('parseExpectedDate(%j) = %j', (input, expected) => {
    expect(parseExpectedDate(input)).toBe(expected);
  });

  it('keeps an unreadable date as text with a warning, never rejecting the row', () => {
    const result = parseFormResponse({ Name: 'A', Email: 'a@example.com', 'Check In Date': 'around Diwali' }, map);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.details.expectedArrivalText).toBe('around Diwali');
    expect(result.value.details.expectedArrivalDate).toBeUndefined();
    expect(result.warnings).toEqual(['Check In Date (expected arrival) "around Diwali" is not a recognised date; kept as text']);
  });

  it('missing dates are fine', () => {
    const result = parseFormResponse({ Name: 'A', Email: 'a@example.com' }, map);
    expect(result.ok && result.value.details).toEqual({});
  });
});

describe('Sports decides the event', () => {
  const base = { Name: 'Priya', Email: 'priya@example.com' };

  it.each([
    ['Football', ['football']],
    ['Table Tennis', ['table-tennis']],
    ['  BADMINTON ', ['badminton']],
    ['Football, Table Tennis', ['football', 'table-tennis']],
  ])('Sports %j -> %j', (sports, slugs) => {
    const result = parseFormResponse({ ...base, Sports: sports }, DEFAULT_FORM_FIELD_MAP);
    expect(result.ok && result.value.eventSlugs).toEqual(slugs);
  });

  it('TT -> tt, hoki -> hoki', () => {
    for (const [sports, slug] of [['TT', 'tt'], ['hoki', 'hoki']]) {
      const result = parseFormResponse({ ...base, Sports: sports }, DEFAULT_FORM_FIELD_MAP);
      expect(result.ok && result.value.eventSlugs).toEqual([slug]);
    }
  });

  it('an explicit (even empty) Sports answer wins over Sport/Event/Game columns', () => {
    const both = parseFormResponse({ ...base, Sports: 'TT', Event: 'Hockey' }, DEFAULT_FORM_FIELD_MAP);
    expect(both.ok && both.value.eventSlugs).toEqual(['tt']);
    expect(parseFormResponse({ ...base, Sports: '', Event: 'Hockey' }, DEFAULT_FORM_FIELD_MAP)).toEqual({
      ok: false,
      errors: ['Sports is missing: the sport/event must be chosen in the form'],
    });
    const eventOnly = parseFormResponse({ ...base, Event: 'Hockey' }, DEFAULT_FORM_FIELD_MAP);
    expect(eventOnly.ok && eventOnly.value.eventSlugs).toEqual(['hockey']);
  });

  it('rejects a row without a Sports answer (there is no fallback event)', () => {
    expect(parseFormResponse(base, DEFAULT_FORM_FIELD_MAP)).toEqual({
      ok: false,
      errors: ['Sports is missing: the sport/event must be chosen in the form'],
    });
    expect(parseFormResponse({ ...base, Sports: '   ' }, DEFAULT_FORM_FIELD_MAP).ok).toBe(false);
  });
});

describe('helpers', () => {
  it.each([
    ['9876543210', '9876543210'],
    ['09876543210', '9876543210'],
    ['+91-98765-43210', '9876543210'],
    ['+1 415 555 0100', '+14155550100'],
    ['123', undefined],
  ])('normalizePhone(%s)', (input, expected) => {
    expect(normalizePhone(input)).toBe(expected);
  });

  it('extracts several comma-separated Drive files', () => {
    expect(
      extractDriveFileIds(
        'https://drive.google.com/open?id=1aaaaaaaaaaaaaaaaaaaaa, https://drive.google.com/open?id=1bbbbbbbbbbbbbbbbbbbbb',
      ),
    ).toEqual(['1aaaaaaaaaaaaaaaaaaaaa', '1bbbbbbbbbbbbbbbbbbbbb']);
  });
});
