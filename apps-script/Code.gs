/**
 * Ledger — Google Apps Script backend
 * ------------------------------------
 * Turns a Google Sheet into a tiny JSON API your static site can call.
 *
 * SETUP (see README.md for the full walkthrough):
 *   1. Create a Google Sheet. In it: Extensions → Apps Script.
 *   2. Delete the sample code, paste THIS file in, Save.
 *   3. Deploy → New deployment → type "Web app".
 *        - Execute as: Me
 *        - Who has access: Anyone
 *   4. Copy the /exec web-app URL and paste it into Ledger's sync settings.
 *
 * The sheet stores two tabs ("tasks" and "slots"), each holding one JSON
 * blob in cell A1. Simple, robust, and human-inspectable.
 */

var TABS = ['tasks', 'slots'];

function tab_(name) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  return sh;
}

function readTab_(name) {
  var raw = tab_(name).getRange('A1').getValue();
  if (!raw) return [];
  try { return JSON.parse(raw); } catch (e) { return []; }
}

function writeTab_(name, arr) {
  tab_(name).getRange('A1').setValue(JSON.stringify(arr || []));
}

/** GET  ?action=load  → returns { tasks:[...], slots:[...] } */
function doGet(e) {
  var out = { tasks: readTab_('tasks'), slots: readTab_('slots') };
  return ContentService
    .createTextOutput(JSON.stringify(out))
    .setMimeType(ContentService.MimeType.JSON);
}

/** POST body { action:"save", tasks:[...], slots:[...] } */
function doPost(e) {
  var res = { ok: false };
  try {
    var body = JSON.parse(e.postData.contents);
    if (body.action === 'save') {
      writeTab_('tasks', body.tasks || []);
      writeTab_('slots', body.slots || []);
      res.ok = true;
    }
  } catch (err) {
    res.error = String(err);
  }
  return ContentService
    .createTextOutput(JSON.stringify(res))
    .setMimeType(ContentService.MimeType.JSON);
}
