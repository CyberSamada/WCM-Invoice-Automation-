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

/** Appends one row to the Invoice Log tab. `data` keys should match CONFIG.LOG_COLUMNS (case-insensitive, order-independent). */
function logInvoiceRow_(data) {
  const sheet = getOrCreateSheet_(CONFIG.SHEET_LOG_TAB, CONFIG.LOG_COLUMNS);
  const row = CONFIG.LOG_COLUMNS.map(col => data[col] !== undefined ? data[col] : '');
  sheet.appendRow(row);
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
