import { readFileSync } from 'fs';
import { join } from 'path';
import { createContext, runInContext } from 'vm';
import { Ctx, resetDatabase, startApp } from './e2e-helpers';

/**
 * Runs the REAL apps-script/registration-form.gs in Node with fake Google services:
 * the script builds the webhook payload from a fake response sheet; the test captures it,
 * sends exactly that payload to the real backend, and feeds the server's reply back so the
 * script writes its Status cell. Proves Sports = "TT" travels as answers.Sports and becomes
 * the event "tt", through both handleFormSubmit and resyncUnsent.
 */

type Cell = string | number | Date;

/** Minimal in-memory Sheet: 1-based getRange(row, col, rows?, cols?). */
class FakeSheet {
  constructor(
    public rows: Cell[][],
    private readonly name = 'Form Responses 1',
  ) {}
  getName() {
    return this.name;
  }
  getFormUrl() {
    return 'https://docs.google.com/forms/d/fake/edit';
  }
  getLastColumn() {
    return Math.max(...this.rows.map((r) => r.length));
  }
  getLastRow() {
    return this.rows.length;
  }
  getRange(row: number, col: number, numRows = 1, numCols = 1) {
    const rows = this.rows;
    const range = {
      getValues: () =>
        Array.from({ length: numRows }, (_, i) =>
          Array.from({ length: numCols }, (__, j) => rows[row - 1 + i]?.[col - 1 + j] ?? ''),
        ),
      setValue: (value: Cell) => {
        while (rows.length < row) rows.push([]);
        rows[row - 1][col - 1] = value;
        return range;
      },
      setFontWeight: () => range,
    };
    return range;
  }
  cell(row: number, header: string) {
    return this.rows[row - 1][this.rows[0].indexOf(header)];
  }
}

interface Captured {
  url: string;
  secret: string;
  payload: { sourceRow: number; responseId: string; answers: Record<string, string>; eventSlug?: string };
}

/** Loads the .gs file into a sandbox with fake SpreadsheetApp/UrlFetchApp/etc. */
function loadScript(sheet: FakeSheet, reply: () => { code: number; body: unknown }) {
  const captured: Captured[] = [];
  const logs: string[] = [];
  let uuid = 0;
  const sandbox: Record<string, unknown> = {
    console: { log: (...args: unknown[]) => logs.push(args.join(' ')) },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (key: string) =>
          ({ WEBHOOK_URL: 'https://registration.example.com', WEBHOOK_SECRET: 'e2e-webhook-secret', EVENT_SLUG: 'old-slug-ignored' })[key] ?? null,
      }),
    },
    SpreadsheetApp: {
      getActive: () => ({
        getId: () => 'spreadsheet-e2e',
        getSheets: () => [sheet],
        getSpreadsheetTimeZone: () => 'Asia/Kolkata',
        toast: () => undefined,
      }),
    },
    UrlFetchApp: {
      fetch: (url: string, options: { headers: Record<string, string>; payload: string }) => {
        captured.push({ url, secret: options.headers['X-Webhook-Secret'], payload: JSON.parse(options.payload) });
        const r = reply();
        return { getResponseCode: () => r.code, getContentText: () => JSON.stringify(r.body) };
      },
    },
    Utilities: {
      getUuid: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, '0')}`,
      sleep: () => undefined,
      formatDate: (date: Date, tz: string, pattern: string) => {
        const parts = Object.fromEntries(
          new Intl.DateTimeFormat('en-GB', {
            timeZone: tz,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hourCycle: 'h23',
          })
            .formatToParts(date)
            .map((p) => [p.type, p.value]),
        );
        return pattern === 'yyyy-MM-dd' ? `${parts.year}-${parts.month}-${parts.day}` : `${parts.hour}:${parts.minute}:${parts.second}`;
      },
    },
  };
  createContext(sandbox);
  runInContext(readFileSync(join(__dirname, '..', 'apps-script', 'registration-form.gs'), 'utf8'), sandbox);
  return {
    captured,
    logs,
    handleFormSubmit: (row: number) =>
      (sandbox.handleFormSubmit as (e: unknown) => void)({ range: { getSheet: () => sheet, getRow: () => row } }),
    resyncUnsent: () => (sandbox.resyncUnsent as () => void)(),
  };
}

/** A response sheet laid out like the real one (no helper columns yet). */
function responseSheet(rows: Cell[][], headers: string[] = HEADERS) {
  return new FakeSheet([headers, ...rows]);
}

const HEADERS = ['Timestamp', 'Email', 'College Name', 'Sports', 'Name', 'Mobile No.', 'College Roll No.', 'Check In Date', 'Check Out Date', 'Accommodation', 'Remark'];
const personRow = (name: string, sports: string): Cell[] => [
  new Date('2026-10-01T10:00:00Z'),
  `${name.toLowerCase()}@example.com`,
  'NIT Patna',
  sports,
  name,
  '9876500000',
  'R1',
  new Date('2026-10-04T18:30:00Z'), // a date cell at midnight IST
  '',
  'Yes',
  '',
];

describe('Apps Script -> webhook -> event (e2e)', () => {
  let ctx: Ctx;

  beforeAll(async () => {
    ctx = await startApp();
  });
  afterAll(async () => {
    await ctx.app.close();
  });
  beforeEach(async () => {
    await resetDatabase(ctx);
  });

  /** Sends the script's captured payload to the real backend, exactly as the script would. */
  const deliver = (c: Captured) =>
    ctx.http.post('/webhooks/forms/submit').set('X-Webhook-Secret', c.secret).set('Content-Type', 'application/json').send(JSON.stringify(c.payload));

  it('handleFormSubmit: a row with Sports = TT sends answers.Sports "TT" and creates event "tt"', async () => {
    const sheet = responseSheet([personRow('Priya', 'TT')]);
    let serverReply = { code: 0, body: {} as unknown };
    const script = loadScript(sheet, () => serverReply);

    script.handleFormSubmit(2);
    expect(script.captured).toHaveLength(3); // first pass: no reply yet -> the script retries 3x
    const sent = script.captured[0];
    expect(sent.url).toBe('https://registration.example.com/webhooks/forms/submit');
    expect(sent.payload.answers.Sports).toBe('TT'); // "Sports": "TT"
    expect(JSON.stringify(sent.payload)).toContain('"Sports":"TT"');
    expect(sent.payload).not.toHaveProperty('eventSlug'); // EVENT_SLUG is never sent
    expect(sent.payload.answers['Check In Date']).toBe('2026-10-05');
    expect(script.logs).toContain('Infinito sync row 2: Sports column "Sports", answers.Sports = "TT"');

    const res = await deliver(sent).expect(200);
    expect(res.body.events).toEqual(['tt']);
    const reg = await ctx.prisma.registration.findFirstOrThrow({ include: { person: true } });
    expect(reg).toMatchObject({ eventSlug: 'tt', responseId: sent.payload.responseId });
    expect(reg.person.email).toBe('priya@example.com');

    // Same row again with the server's real reply: Status shows the event; no duplicate.
    serverReply = { code: res.status, body: res.body };
    script.handleFormSubmit(2);
    await deliver(script.captured[3]).expect(200);
    expect(sheet.cell(2, 'Status')).toBe('✅ Received · 1 member(s) · tt');
    expect(await ctx.prisma.registration.count()).toBe(1);
  });

  it('resyncUnsent uses the same extraction for every unsent row (TT, hoki, Table Tennis)', async () => {
    const sheet = responseSheet([personRow('Priya', 'TT'), personRow('Arjun', 'hoki'), personRow('Zoya', 'Table Tennis')]);
    const script = loadScript(sheet, () => ({ code: 200, body: { memberCount: 1, events: [] } }));
    script.resyncUnsent();
    expect(script.captured.map((c) => c.payload.answers.Sports)).toEqual(['TT', 'hoki', 'Table Tennis']);
    for (const c of script.captured) await deliver(c).expect(200);
    const events = await ctx.prisma.registration.findMany({ include: { person: true }, orderBy: { eventSlug: 'asc' } });
    expect(events.map((r) => [r.person.name, r.eventSlug])).toEqual([
      ['Arjun', 'hoki'],
      ['Zoya', 'table-tennis'],
      ['Priya', 'tt'],
    ]);
  });

  it.each([
    ['sports '],
    ['SPORT'],
    ['Sports​'], // invisible zero-width space pasted into the question title
    ['Sports *'],
    ['Event'],
    ['Game:'],
    ['Sports (TT, Hockey, Football)'],
  ])('finds the sport column titled %j', async (header) => {
    const sheet = responseSheet([personRow('Priya', 'TT')], HEADERS.map((h) => (h === 'Sports' ? header : h)));
    const script = loadScript(sheet, () => ({ code: 200, body: { memberCount: 1, events: ['tt'] } }));
    script.handleFormSubmit(2);
    expect(script.captured[0].payload.answers.Sports).toBe('TT');
    expect((await deliver(script.captured[0]).expect(200)).body.events).toEqual(['tt']);
  });

  it('empty Sports value -> "Sports is missing" in Status', async () => {
    const sheet = responseSheet([personRow('Priya', '')]);
    let reply = { code: 0, body: {} as unknown };
    const script = loadScript(sheet, () => reply);
    script.handleFormSubmit(2);
    expect(script.captured[0].payload.answers.Sports).toBe('');
    const res = await deliver(script.captured[0]).expect(422);
    expect(res.body.errors).toEqual(['Sports is missing: the sport/event must be chosen in the form']);
    reply = { code: res.status, body: res.body };
    script.handleFormSubmit(2);
    expect(sheet.cell(2, 'Status')).toBe('❌ Sports is missing: the sport/event must be chosen in the form');
    expect(await ctx.prisma.registration.count()).toBe(0);
  });

  it('no sport column at all -> rejected, and Status says the column was not found', async () => {
    const headers = HEADERS.map((h) => (h === 'Sports' ? 'Favourite colour' : h));
    const sheet = responseSheet([personRow('Priya', 'blue')], headers);
    let reply = { code: 0, body: {} as unknown };
    const script = loadScript(sheet, () => reply);
    script.handleFormSubmit(2);
    expect(script.captured[0].payload.answers).not.toHaveProperty('Sports');
    expect(script.logs[0]).toMatch(/^Infinito sync row 2: Sports column NOT FOUND \(headers: Timestamp \| Email/);
    const res = await deliver(script.captured[0]).expect(422);
    reply = { code: res.status, body: res.body };
    script.handleFormSubmit(2);
    expect(sheet.cell(2, 'Status')).toBe(
      '❌ Sports is missing: the sport/event must be chosen in the form (no Sports/Sport/Event/Game column found in this sheet)',
    );
  });
});
