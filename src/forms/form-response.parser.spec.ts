import { DEFAULT_FORM_FIELD_MAP, FormFieldMap } from './form-field-map';
import {
  extractDriveFileIds,
  normalizePhone,
  parseFormResponse,
} from './form-response.parser';

const map: FormFieldMap = DEFAULT_FORM_FIELD_MAP;

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
      map,
    );
    expect(result).toEqual({
      ok: false,
      errors: [
        'Member 1: "a@example" is not a valid email',
        'Member 2: name is missing',
        'Member 4: email b@example.com is also used by Member 3',
        'Transaction ID is missing',
      ],
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
