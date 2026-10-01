/**
 * Infinito 2K26: registration form -> server sync.
 *
 * Install once per event, in the form's RESPONSE SPREADSHEET (Extensions -> Apps Script):
 *   1. Paste this file.
 *   2. Project Settings -> Script properties:
 *        WEBHOOK_URL     https://<server>/webhooks/forms/submit
 *        WEBHOOK_SECRET  same value as the server's FORMS_WEBHOOK_SECRET
 *        EVENT_SLUG      e.g. code-sprint  (lowercase, hyphens)
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
// Payment / Remarks: columns from an earlier version of this script; never sent as answers.
var LEGACY_COLUMNS = ['Payment', 'Remarks'];
var SKIP_COLUMNS = ['Timestamp', 'Email Address'].concat(HELPER_COLUMNS, LEGACY_COLUMNS);
var MAX_ATTEMPTS = 3;

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
  var url = props.getProperty('WEBHOOK_URL');
  var secret = props.getProperty('WEBHOOK_SECRET');
  var eventSlug = props.getProperty('EVENT_SLUG');
  if (!url || !secret || !eventSlug) {
    throw new Error('Set WEBHOOK_URL, WEBHOOK_SECRET and EVENT_SLUG in Script properties');
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
    if (header === 'Timestamp' && values[i] instanceof Date) timestamp = values[i].toISOString();
    if (header === 'Email Address') respondentEmail = String(values[i] || '');
    if (!header || SKIP_COLUMNS.indexOf(header) !== -1) return;
    answers[header] = formatCell_(values[i]);
  });

  var payload = {
    eventSlug: eventSlug,
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
        if (body.warnings && body.warnings.length) text += ' · ⚠ ' + body.warnings.join(' | ');
        return text;
      }
      if (code === 401) return '❌ Webhook secret mismatch. Ask the tech team.';
      if (code === 400 || code === 409 || code === 422) {
        return '❌ ' + (body.errors || ['HTTP ' + code]).join(' | ');
      }
      lastProblem = 'HTTP ' + code; // 5xx / 503 retryable, or server waking up
    } catch (err) {
      lastProblem = String(err);
    }
    if (attempt < MAX_ATTEMPTS) Utilities.sleep(2000 * attempt);
  }
  return '⚠ Not synced (' + lastProblem + '). Use Infinito → Resync unsent rows.';
}

function formatCell_(value) {
  if (value instanceof Date) return value.toISOString();
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
