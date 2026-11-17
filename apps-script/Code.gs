/**
 * PIN — Google Apps Script backend
 * ------------------------------------
 * Turns a Google Sheet into a tiny JSON API your static site can call.
 *
 * SETUP (see README.md for the full walkthrough):
 *   1. Create a Google Sheet. In it: Extensions → Apps Script.
 *   2. Delete the sample code, paste THIS file in, Save.
 *   3. Project Settings → Script Properties → add a property named TOKEN with
 *      a secret value of your choosing. This is the shared secret every
 *      request must present; it is never written into this source file.
 *   4. Deploy → New deployment → type "Web app".
 *        - Execute as: Me
 *        - Who has access: Anyone
 *   5. Copy the /exec web-app URL and paste it, with your TOKEN, into
 *      PIN's Settings/Sync tab.
 *
 * HTTP contract (03_DOMAIN_CONSTANTS.md Part C, D26):
 *   GET  <execURL>             → {"ok":true}                      (liveness ping only, no data)
 *   POST <execURL> {"action":"load","token":"<TOKEN>"}
 *                               → {"ok":true,"version":<n>,"tasks":[...],"slots":[...]}
 *   POST <execURL> {"action":"save","token":"<TOKEN>","version":<n>,"tasks":[...],"slots":[...]}
 *                               → {"ok":true}
 *   Wrong/missing token, on any action → {"ok":false,"error":"unauthorized"}, no data touched.
 */

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function sheet_(name) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  return sh;
}

/** Slot (03_DOMAIN_CONSTANTS.md Part A) written one ROW per slot (D27 fix), this column order. */
var SLOT_FIELDS = ['id', 'owner', 'date', 'start', 'durationMin', 'taskId'];

function readTasksTab_() {
  var raw = sheet_('tasks').getRange('A1').getValue();
  if (!raw) return [];
  try {
    var arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
}

function readSlotsTab_() {
  var sh = sheet_('slots');
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return []; // header only, or empty tab
  var rows = sh.getRange(2, 1, lastRow - 1, SLOT_FIELDS.length).getValues();
  return rows
    .filter(function (row) { return row[0] !== '' && row[0] !== null; })
    .map(function (row) {
      var slot = {};
      SLOT_FIELDS.forEach(function (field, i) { slot[field] = row[i]; });
      slot.durationMin = Number(slot.durationMin);
      return slot;
    });
}

function readVersion_() {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('meta');
  if (!sh) return 1;
  var v = sh.getRange('A1').getValue();
  return v ? Number(v) : 1;
}

function writeTasksTab_(tasks) {
  sheet_('tasks').getRange('A1').setValue(JSON.stringify(tasks));
}

/** Clears the tab first so a SHRINKING slot list doesn't leave orphaned old rows (D26/D27). */
function writeSlotsTab_(slots) {
  var sh = sheet_('slots');
  sh.clearContents();
  sh.getRange(1, 1, 1, SLOT_FIELDS.length).setValues([SLOT_FIELDS]);
  if (slots.length) {
    var rows = slots.map(function (slot) {
      return SLOT_FIELDS.map(function (field) { return slot[field]; });
    });
    var dataRange = sh.getRange(2, 1, rows.length, SLOT_FIELDS.length);
    // Plain Text BEFORE writing: Sheets auto-detects "YYYY-MM-DD"/"HH:mm"-shaped strings and
    // silently converts the cell to a real Date, corrupting date/start on the next read back
    // (03 Part A requires these stay literal strings) — found via a real Sheet in 6.S-INT.
    dataRange.setNumberFormat('@');
    dataRange.setValues(rows);
  }
}

function writeVersion_(version) {
  sheet_('meta').getRange('A1').setValue(version);
}

/** Unauthenticated liveness ping ONLY — never reads a tab, never returns data. */
function doGet(e) {
  return json_({ ok: true });
}

function doPost(e) {
  var body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: 'invalid JSON' });
  }

  var expected = PropertiesService.getScriptProperties().getProperty('TOKEN');
  if (!expected || body.token !== expected) {
    return json_({ ok: false, error: 'unauthorized' });
  }

  if (body.action === 'load') return json_(handleLoad_(body));
  if (body.action === 'save') return json_(handleSave_(body));
  return json_({ ok: false, error: 'unknown action' });
}

function handleLoad_(body) {
  return {
    ok: true,
    version: readVersion_(),
    tasks: readTasksTab_(),
    slots: readSlotsTab_()
  };
}

function handleSave_(body) {
  if (!Array.isArray(body.tasks) || !Array.isArray(body.slots)) {
    return { ok: false, error: 'invalid payload' };
  }
  writeTasksTab_(body.tasks);
  writeSlotsTab_(body.slots);
  writeVersion_(body.version);
  return { ok: true };
}
