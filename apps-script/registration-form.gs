/**
 * Infinito 2K26: registration form -> server sync.
 *
 * Install once per form, in the form's RESPONSE SPREADSHEET (Extensions -> Apps Script):
 *   1. Paste this file.
 *   2. Project Settings -> Script properties:
 *        WEBHOOK_URL     https://<server>/webhooks/forms/submit  (or just https://<server>)
 *        WEBHOOK_SECRET  same value as the server's FORMS_WEBHOOK_SECRET
 *      (No EVENT_SLUG: the event comes from each row's "Sports" answer. An old EVENT_SLUG
 *       property is simply ignored.)
 *   3. Run `setup` once from the editor and approve the permissions.
 *
 * This sheet is the import layer only. Payment verification, QR emails and entry happen
 * in the coordinator dashboard (<server>/admin), never here.
 *
 * `setup` adds two helper columns to the right of the form columns and installs the
 * form-submit trigger. Forms never write into these columns.
 *   Status       sync result written by this script from the server's reply
 *   Response ID  stable ID for the row. Do not edit, sort, or delete rows.
 */

var HELPER_COLUMNS = ['Status', 'Response ID'];
// Every other column (including a form question called "Remark(s)") is sent as an answer;
// the server ignores titles it doesn't map.
var SKIP_COLUMNS = ['Timestamp', 'Email Address'].concat(HELPER_COLUMNS);
var MAX_ATTEMPTS = 3;
var WEBHOOK_PATH = '/webhooks/forms/submit';
// The event comes ONLY from this column; its value is always sent as answers.Sports.
var SPORT_HEADERS = ['sports', 'sport', 'event', 'game'];

function setup() {
  var sheet = getResponseSheet_();
  ensureHelperColumns_(sheet);

  var ss = SpreadsheetApp.getActive();
  var exists = ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === 'handleFormSubmit';
  });
  if (!exists) {
    ScriptApp.newTrigger('handleFormSubmit').forSpreadsheet(ss).onFormSubmit().create();
  }
  SpreadsheetApp.getUi().alert('Infinito sync is set up for "' + sheet.getName() + '".');
}

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Infinito')
    .addItem('Resync unsent rows', 'resyncUnsent')
    .addItem('Resync selected rows', 'resyncSelected')
    .addToUi();
}

/** Installable trigger. Also fires when a respondent edits their response. */
function handleFormSubmit(e) {
  syncRow_(e.range.getSheet(), e.range.getRow());
}

/** Rows never synced, or whose last sync failed for a transient reason. */
function resyncUnsent() {
  var sheet = getResponseSheet_();
  var cols = ensureHelperColumns_(sheet);
  var last = sheet.getLastRow();
  if (last < 2) return;
  var statuses = sheet.getRange(2, cols.Status, last - 1, 1).getValues();
  var started = Date.now();
  var synced = 0;
  for (var i = 0; i < statuses.length; i++) {
    var status = String(statuses[i][0]);
    if (status && status.indexOf('⚠ Not synced') !== 0) continue;
    if (Date.now() - started > 5 * 60 * 1000) break; // Apps Script stops at 6 min
    syncRow_(sheet, i + 2);
    synced++;
  }
  SpreadsheetApp.getActive().toast('Resynced ' + synced + ' row(s).', 'Infinito');
}

/** Use after fixing a row that showed ❌. */
function resyncSelected() {
  var range = SpreadsheetApp.getActiveRange();
  var sheet = range.getSheet();
  for (var row = Math.max(range.getRow(), 2); row <= range.getLastRow(); row++) {
    syncRow_(sheet, row);
  }
}

function syncRow_(sheet, row) {
  var props = PropertiesService.getScriptProperties();
  var url = normalizeWebhookUrl_(props.getProperty('WEBHOOK_URL'));
  var secret = props.getProperty('WEBHOOK_SECRET');
  if (!url || !secret) {
    throw new Error('Set WEBHOOK_URL and WEBHOOK_SECRET in Script properties');
  }

  var cols = ensureHelperColumns_(sheet);
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var values = sheet.getRange(row, 1, 1, headers.length).getValues()[0];

  var responseId = String(values[cols['Response ID'] - 1] || '');
  if (!responseId) {
    responseId = Utilities.getUuid();
    sheet.getRange(row, cols['Response ID']).setValue(responseId);
  }

  var answers = {};
  var timestamp = null;
  var respondentEmail = '';
  headers.forEach(function (header, i) {
    header = String(header).trim();
    if (header === 'Timestamp' && isDate_(values[i])) timestamp = values[i].toISOString();
    if (header === 'Email Address') respondentEmail = String(values[i] || '');
    if (!header || SKIP_COLUMNS.indexOf(header) !== -1) return;
    answers[header] = formatCell_(values[i]);
  });

  // The event: read the sport column explicitly and always send it as answers.Sports, whatever
  // the exact header text is. An empty or missing value is sent as '' / left out, and the
  // server answers "Sports is missing" (there is no fallback event).
  var sportCol = findSportColumn_(headers);
  var sportValue = sportCol === -1 ? '' : formatCell_(values[sportCol]).trim();
  if (sportCol !== -1) answers.Sports = sportValue;
  console.log(
    'Infinito sync row ' + row + ': Sports column ' +
      (sportCol === -1 ? 'NOT FOUND (headers: ' + headers.join(' | ') + ')' : '"' + headers[sportCol] + '"') +
      ', answers.Sports = ' + JSON.stringify(answers.Sports),
  );

  var payload = {
    sourceForm: SpreadsheetApp.getActive().getId(),
    sourceSheet: sheet.getName(),
    sourceRow: row,
    responseId: responseId,
    respondentEmail: respondentEmail,
    answers: answers,
  };
  if (timestamp) payload.submittedAt = timestamp;

  var status = post_(url, secret, payload);
  sheet.getRange(row, cols.Status).setValue(status);
}

function post_(url, secret, payload) {
  var lastProblem = '';
  for (var attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      var res = UrlFetchApp.fetch(url, {
        method: 'post',
        contentType: 'application/json',
        headers: { 'X-Webhook-Secret': secret },
        payload: JSON.stringify(payload),
        muteHttpExceptions: true,
      });
      var code = res.getResponseCode();
      var body = {};
      try {
        body = JSON.parse(res.getContentText());
      } catch (ignored) {}

      if (code === 200) {
        var text = '✅ Received · ' + body.memberCount + ' member(s)';
        if (body.events && body.events.length) text += ' · ' + body.events.join(', ');
        if (body.warnings && body.warnings.length) text += ' · ⚠ ' + body.warnings.join(' | ');
        return text;
      }
      if (code === 401) return '❌ Webhook secret mismatch. Ask the tech team.';
      if (code === 404) return '⚠ Not synced (HTTP 404: check the WEBHOOK_URL script property). Use Infinito → Resync unsent rows.';
      if (code === 400 || code === 409 || code === 422) {
        var problem = '❌ ' + (body.errors || ['HTTP ' + code]).join(' | ');
        if (!('Sports' in payload.answers)) problem += ' (no Sports/Sport/Event/Game column found in this sheet)';
        return problem;
      }
      lastProblem = 'HTTP ' + code; // 5xx / 503 retryable, or server waking up
    } catch (err) {
      lastProblem = String(err);
    }
    if (attempt < MAX_ATTEMPTS) Utilities.sleep(2000 * attempt);
  }
  return '⚠ Not synced (' + lastProblem + '). Use Infinito → Resync unsent rows.';
}

/** Lowercase, single spaces, no invisible characters, no trailing "*", ":", "." or "?". */
function normalizeHeader_(header) {
  return String(header || '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[\s\u00A0]+/g, ' ')
    .trim()
    .replace(/[\s*:.?]+$/, '')
    .toLowerCase();
}

/**
 * 0-based index of the sport column: an exact match of Sports / Sport / Event / Game
 * (normalised), else a header starting with "sport" (e.g. "Sports (TT, Hockey, ...)"); -1 if none.
 */
function findSportColumn_(headers) {
  var normalized = headers.map(normalizeHeader_);
  for (var i = 0; i < SPORT_HEADERS.length; i++) {
    var exact = normalized.indexOf(SPORT_HEADERS[i]);
    if (exact !== -1) return exact;
  }
  for (var j = 0; j < normalized.length; j++) {
    if (normalized[j].indexOf('sport') === 0) return j;
  }
  return -1;
}

/** Accepts the full endpoint or just the server's base URL. */
function normalizeWebhookUrl_(raw) {
  var url = String(raw || '').trim().replace(/\/+$/, '');
  if (!url) return '';
  return url.slice(-WEBHOOK_PATH.length) === WEBHOOK_PATH ? url : url + WEBHOOK_PATH;
}

/** Date check that doesn't depend on which Date constructor created the value. */
function isDate_(value) {
  return Object.prototype.toString.call(value) === '[object Date]';
}

function formatCell_(value) {
  if (isDate_(value)) {
    // Date-only answers (e.g. "Check In Date") are sent as yyyy-MM-dd in the sheet's own
    // timezone, so the planned date can't shift by a day; real date-times stay ISO.
    var tz = SpreadsheetApp.getActive().getSpreadsheetTimeZone();
    if (Utilities.formatDate(value, tz, 'HH:mm:ss') === '00:00:00') {
      return Utilities.formatDate(value, tz, 'yyyy-MM-dd');
    }
    return value.toISOString();
  }
  if (value === null || value === undefined) return '';
  return String(value);
}

function getResponseSheet_() {
  var sheets = SpreadsheetApp.getActive().getSheets();
  for (var i = 0; i < sheets.length; i++) {
    if (sheets[i].getFormUrl()) return sheets[i];
  }
  throw new Error('No sheet in this spreadsheet is linked to a Google Form');
}

/** Returns { headerName: 1-based column } for helper columns, adding any that are missing. */
function ensureHelperColumns_(sheet) {
  var lastCol = sheet.getLastColumn();
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) {
    return String(h).trim();
  });
  var cols = {};
  HELPER_COLUMNS.forEach(function (name) {
    var idx = headers.indexOf(name);
    if (idx === -1) {
      lastCol++;
      sheet.getRange(1, lastCol).setValue(name).setFontWeight('bold');
      idx = lastCol - 1;
    }
    cols[name] = idx + 1;
  });
  return cols;
}
