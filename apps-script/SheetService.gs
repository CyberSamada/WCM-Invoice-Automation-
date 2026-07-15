/**
 * SheetService.gs
 * Everything that reads/writes the bound Google Sheet: the project reference data,
 * the invoice log, and the error log.
 */

/** Reads the "Project Reference" tab into an array of plain objects. */
function getReferenceData_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEET_REFERENCE_TAB);
  if (!sheet) {
    throw new Error(`Missing "${CONFIG.SHEET_REFERENCE_TAB}" tab. Run setup() first, then import project_reference.csv into it and add Drive Folder IDs.`);
  }
  const values = sheet.getDataRange().getValues();
  const header = values.shift();
  const idx = {
    projectNumber: header.indexOf('Project Number'),
    projectName: header.indexOf('Project Name'),
    subprojectNumber: header.indexOf('Subproject Number'),
    subprojectName: header.indexOf('Subproject Name'),
    driveFolderId: header.indexOf('Drive Folder ID')
  };
  Object.keys(idx).forEach(k => {
    if (idx[k] === -1) throw new Error(`"${CONFIG.SHEET_REFERENCE_TAB}" tab is missing a "${k}" column.`);
  });

  return values
    .filter(row => row[idx.projectNumber] !== '')
    .map(row => ({
      projectNumber: String(row[idx.projectNumber]).trim(),
      projectName: String(row[idx.projectName]).trim(),
      subprojectNumber: String(row[idx.subprojectNumber] || '').trim(),
      subprojectName: String(row[idx.subprojectName] || '').trim(),
      driveFolderId: String(row[idx.driveFolderId] || '').trim()
    }));
}

/**
 * Rows from getReferenceData_() with CONFIG.EXCLUDE_PROJECT_NUMBERS (e.g. "00 PROJECT TEMPLATE")
 * removed. Use this — not the raw reference rows — everywhere a project could actually be chosen
 * or matched against (the Gemini schema, findReferenceMatch_/validateMatch_), so a placeholder
 * template row can never become a filing destination even if something upstream returns its number.
 */
function getMatchableReferenceRows_(referenceRows) {
  const excluded = (CONFIG.EXCLUDE_PROJECT_NUMBERS || []).map(normalizeNumberKey_);
  return referenceRows.filter(r => excluded.indexOf(normalizeNumberKey_(r.projectNumber)) === -1);
}

/**
 * Reads the optional "Project Aliases" tab: known alternate names/addresses that map straight to
 * a project (e.g. a street address invoices use instead of the project's marketing name), for
 * cases Gemini can't reliably infer from the Project Reference sheet alone. Returns [] if the tab
 * doesn't exist — this feature is optional, not required for the automation to run.
 */
function getAliasData_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEET_ALIASES_TAB);
  if (!sheet) return [];
  const values = sheet.getDataRange().getValues();
  const header = values.shift() || [];
  const idx = {
    alias: header.indexOf('Alias'),
    projectNumber: header.indexOf('Project Number'),
    subprojectNumber: header.indexOf('Subproject Number')
  };
  if (idx.alias === -1 || idx.projectNumber === -1) return [];

  return values
    .filter(row => row[idx.alias] !== '' && row[idx.projectNumber] !== '')
    .map(row => ({
      alias: String(row[idx.alias]).trim(),
      projectNumber: String(row[idx.projectNumber]).trim(),
      subprojectNumber: idx.subprojectNumber === -1 ? '' : String(row[idx.subprojectNumber] || '').trim()
    }));
}

/**
 * Appends one row to the Invoice Log tab. `data` keys should match CONFIG.LOG_COLUMNS
 * (case-insensitive, order-independent). Auto-fills two columns callers don't need to set
 * themselves: 'Row ID' (a UUID — the stable key the dashboard's manual-edit feature uses to find
 * this exact row later, since row *position* shifts as the sheet grows) and 'Drive File ID'
 * (parsed from the Drive Link, so the edit feature can move the actual file without re-deriving
 * its ID from the URL every time).
 */
function logInvoiceRow_(data) {
  const sheet = getOrCreateSheet_(CONFIG.SHEET_LOG_TAB, CONFIG.LOG_COLUMNS);
  ensureSheetHasColumns_(sheet, CONFIG.LOG_COLUMNS);
  const filled = Object.assign({}, data);
  if (!filled['Row ID']) filled['Row ID'] = Utilities.getUuid();
  if (!filled['Drive File ID']) filled['Drive File ID'] = driveFileIdFromUrl_(filled['Drive Link']);
  const row = CONFIG.LOG_COLUMNS.map(col => filled[col] !== undefined ? filled[col] : '');
  sheet.appendRow(row);
}

/** Extracts the file ID from a standard Drive file URL ("...file/d/<ID>/view"), or '' if it doesn't match. */
function driveFileIdFromUrl_(url) {
  const m = /\/file\/d\/([^/]+)/.exec(String(url || ''));
  return m ? m[1] : '';
}

/**
 * One-time migration: fills in 'Row ID' and 'Drive File ID' for any Invoice Log rows logged before
 * those columns existed, so the dashboard's manual-edit feature (which looks up rows by Row ID)
 * works on old invoices too, not just ones processed from now on. Safe to re-run — only touches
 * blank cells. Run once from the function dropdown after deploying this update.
 */
function backfillLogRowIds() {
  const sheet = getOrCreateSheet_(CONFIG.SHEET_LOG_TAB, CONFIG.LOG_COLUMNS);
  ensureSheetHasColumns_(sheet, CONFIG.LOG_COLUMNS);

  const values = sheet.getDataRange().getValues();
  const header = values[0];
  const idx = {
    rowId: header.indexOf('Row ID'),
    driveFileId: header.indexOf('Drive File ID'),
    driveLink: header.indexOf('Drive Link')
  };

  let filled = 0;
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    if (row.every(cell => cell === '')) continue; // skip fully blank rows
    let touched = false;
    if (!row[idx.rowId]) {
      sheet.getRange(i + 1, idx.rowId + 1).setValue(Utilities.getUuid());
      touched = true;
    }
    if (!row[idx.driveFileId] && row[idx.driveLink]) {
      const fileId = driveFileIdFromUrl_(row[idx.driveLink]);
      if (fileId) {
        sheet.getRange(i + 1, idx.driveFileId + 1).setValue(fileId);
        touched = true;
      }
    }
    if (touched) filled++;
  }

  Logger.log(`Backfilled Row ID/Drive File ID on ${filled} existing Invoice Log row(s).`);
}

/** Appends one row to the "Feedback" tab. Called from the dashboard — open to any viewer, not gated. */
function logFeedback_(message, pageContext) {
  const sheet = getOrCreateSheet_(CONFIG.SHEET_FEEDBACK_TAB, CONFIG.FEEDBACK_COLUMNS);
  sheet.appendRow([new Date(), message, pageContext || '']);
}

/**
 * Adds any header names in `requiredHeaders` that aren't already present in `sheet`'s row 1,
 * appending them as new columns at the end. Lets CONFIG.LOG_COLUMNS grow over time (e.g. the
 * "Match Note" column) without anyone needing to manually edit an already-existing sheet.
 */
function ensureSheetHasColumns_(sheet, requiredHeaders) {
  const lastCol = Math.max(sheet.getLastColumn(), 1);
  const existing = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(h => String(h).trim());
  const missing = requiredHeaders.filter(h => existing.indexOf(h) === -1);
  if (missing.length) {
    sheet.getRange(1, existing.length + 1, 1, missing.length).setValues([missing]);
  }
}

/** Appends one row to the Errors tab. */
function logError_(context, errorMessage, gmailLink) {
  const sheet = getOrCreateSheet_(CONFIG.SHEET_ERRORS_TAB, ['Timestamp', 'Context', 'Error', 'Gmail Link']);
  sheet.appendRow([new Date(), context, errorMessage, gmailLink || '']);
}

/** Gets a tab by name, creating it with a header row if it doesn't exist yet. */
function getOrCreateSheet_(name, header) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(header);
    sheet.setFrozenRows(1);
  }
  return sheet;
}
