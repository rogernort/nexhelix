/**
 * NexHelix Research Survey — Google Apps Script backend
 * =====================================================
 * Receives JSON POSTs from index.html, appends one row per submission to a
 * Google Sheet, and saves any uploaded files (base64) to a Drive folder,
 * writing the Drive links into the same row.
 *
 * Setup (details in README.md):
 *   1. Paste this whole file into a new project at script.google.com
 *   2. Run testSetup() once from the editor to grant permissions and
 *      create the Sheet + Drive folder (their URLs are logged).
 *   3. Deploy > New deployment > Web app
 *        Execute as:            Me
 *        Who has access:        Anyone
 *   4. Copy the /exec URL into CONFIG.ENDPOINT in index.html.
 *
 * Schema drift is handled automatically: every answer is written to a
 * column named after its question id. If a submission arrives with a
 * question id the Sheet hasn't seen, a new column is appended — old
 * responses are never broken by survey edits.
 */

var CONFIG = {
  // Leave these blank to have the script create + remember its own
  // spreadsheet and folder (IDs are stored in Script Properties).
  // Or pin existing ones by pasting their IDs here.
  SPREADSHEET_ID: '',
  FOLDER_ID: '',

  // Names used when auto-creating.
  SPREADSHEET_NAME: 'NexHelix Research Responses',
  FOLDER_NAME: 'NexHelix Research Uploads',
  SHEET_NAME: 'Responses',

  // Server-side safety cap per uploaded file (client caps at 10MB).
  MAX_FILE_BYTES: 15 * 1024 * 1024
};

/**
 * Handles form submissions. The page POSTs with Content-Type text/plain
 * (the standard Apps Script CORS workaround), so the JSON body arrives
 * raw in e.postData.contents.
 */
function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000); // avoid races when two people submit at once
  try {
    var data = JSON.parse(e.postData.contents);

    // Honeypot: real respondents never fill this hidden field.
    // Pretend success so bots don't retry.
    if (data.hp) return jsonResponse_({ status: 'success' });

    var ss = getSpreadsheet_();
    var sheet = getSheet_(ss);

    // Save uploaded files (if any) and collect their Drive links.
    var fileLinks = [];
    var files = data.files || [];
    if (files.length > 0) {
      fileLinks = saveFiles_(files, getFolder_());
    }

    // Build the row keyed by question id.
    var row = {
      timestamp: new Date(),
      formVersion: data.formVersion || ''
    };
    var answers = data.answers || {};
    Object.keys(answers).forEach(function (key) {
      var value = answers[key];
      row[key] = Array.isArray(value) ? value.join('; ') : value;
    });
    if (fileLinks.length > 0) row['uploaded_files'] = fileLinks.join('\n');

    appendRowByHeader_(sheet, row);

    return jsonResponse_({ status: 'success' });
  } catch (err) {
    return jsonResponse_({ status: 'error', message: String(err && err.message || err) });
  } finally {
    lock.releaseLock();
  }
}

/** Visiting the /exec URL in a browser confirms the deployment is live. */
function doGet() {
  return ContentService
    .createTextOutput('NexHelix research endpoint is live. POST submissions here.')
    .setMimeType(ContentService.MimeType.TEXT);
}

/**
 * Run this once from the script editor before deploying. It triggers the
 * permission prompts and creates (or finds) the Sheet and Drive folder,
 * logging their URLs so you can bookmark them.
 */
function testSetup() {
  var ss = getSpreadsheet_();
  var folder = getFolder_();
  getSheet_(ss); // ensures the Responses tab + header row exist
  Logger.log('Responses sheet: %s', ss.getUrl());
  Logger.log('Uploads folder:  %s', folder.getUrl());
  Logger.log('Setup looks good. Now deploy as a Web App (see README).');
}

/* ---------------------------------------------------------------------
 * Helpers
 * ------------------------------------------------------------------- */

function getSpreadsheet_() {
  if (CONFIG.SPREADSHEET_ID) return SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('SPREADSHEET_ID');
  if (id) {
    try { return SpreadsheetApp.openById(id); } catch (e) { /* deleted — recreate */ }
  }
  var ss = SpreadsheetApp.create(CONFIG.SPREADSHEET_NAME);
  props.setProperty('SPREADSHEET_ID', ss.getId());
  return ss;
}

function getFolder_() {
  if (CONFIG.FOLDER_ID) return DriveApp.getFolderById(CONFIG.FOLDER_ID);
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('FOLDER_ID');
  if (id) {
    try { return DriveApp.getFolderById(id); } catch (e) { /* deleted — recreate */ }
  }
  var folder = DriveApp.createFolder(CONFIG.FOLDER_NAME);
  props.setProperty('FOLDER_ID', folder.getId());
  return folder;
}

function getSheet_(ss) {
  var sheet = ss.getSheetByName(CONFIG.SHEET_NAME);
  if (!sheet) {
    // Reuse the default empty tab if present, otherwise add one.
    var first = ss.getSheets()[0];
    if (first && first.getLastRow() === 0 && ss.getSheets().length === 1) {
      sheet = first.setName(CONFIG.SHEET_NAME);
    } else {
      sheet = ss.insertSheet(CONFIG.SHEET_NAME);
    }
  }
  return sheet;
}

/**
 * Appends `row` (an object keyed by column name) using the header row as
 * the column map. Any keys the header hasn't seen are appended as new
 * columns — this is what makes survey edits safe.
 */
function appendRowByHeader_(sheet, row) {
  var lastCol = sheet.getLastColumn();
  var header = lastCol > 0 ? sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(String) : [];

  if (header.length === 0) {
    header = ['timestamp', 'formVersion'];
    sheet.getRange(1, 1, 1, header.length).setValues([header]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, header.length).setFontWeight('bold');
  }

  var newCols = Object.keys(row).filter(function (key) {
    return header.indexOf(key) === -1;
  });
  if (newCols.length > 0) {
    sheet.getRange(1, header.length + 1, 1, newCols.length)
         .setValues([newCols])
         .setFontWeight('bold');
    header = header.concat(newCols);
  }

  var values = header.map(function (h) {
    return row.hasOwnProperty(h) ? row[h] : '';
  });
  sheet.appendRow(values);
}

/**
 * Decodes base64 file payloads, saves them to the uploads folder with a
 * timestamp prefix, and returns their Drive URLs. A single bad file is
 * skipped (noted in the links) rather than failing the whole submission.
 */
function saveFiles_(files, folder) {
  var links = [];
  var stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH.mm');
  files.forEach(function (f) {
    try {
      if (!f || !f.data) return;
      var bytes = Utilities.base64Decode(f.data);
      if (bytes.length > CONFIG.MAX_FILE_BYTES) {
        links.push('[skipped, too large: ' + (f.name || 'file') + ']');
        return;
      }
      var blob = Utilities.newBlob(bytes, f.mimeType || 'application/octet-stream',
                                   f.name || 'upload');
      var file = folder.createFile(blob);
      file.setName(stamp + ' — ' + (f.name || 'upload'));
      links.push(file.getUrl());
    } catch (err) {
      links.push('[failed to save: ' + (f && f.name || 'file') + ' — ' + err + ']');
    }
  });
  return links;
}

function jsonResponse_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
