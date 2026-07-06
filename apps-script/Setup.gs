/**
 * Setup.gs
 * Run setup() once, manually, from the Apps Script editor after pasting in these files.
 * See SETUP.md for the full walkthrough.
 */

function setup() {
  getOrCreateSheet_(CONFIG.SHEET_LOG_TAB, CONFIG.LOG_COLUMNS);
  getOrCreateSheet_(CONFIG.SHEET_ERRORS_TAB, ['Timestamp', 'Context', 'Error', 'Gmail Link']);

  const refSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEET_REFERENCE_TAB);
  if (!refSheet) {
    const created = SpreadsheetApp.getActiveSpreadsheet().insertSheet(CONFIG.SHEET_REFERENCE_TAB);
    created.appendRow(CONFIG.REFERENCE_COLUMNS);
    created.setFrozenRows(1);
    Logger.log(`Created "${CONFIG.SHEET_REFERENCE_TAB}" tab — now import project_reference.csv into it (File > Import > Insert new sheet, then copy the rows in), and add Drive Folder IDs per row.`);
  }

  Logger.log('Setup complete. Next: set the GEMINI_API_KEY script property, fill in the Project Reference tab, then create a time-driven trigger for processInvoices() — see SETUP.md.');
}

/** Optional helper: creates the time-driven trigger from code instead of the Triggers UI. Run once. */
function createTimeTrigger() {
  // Remove any existing trigger for this function first, so re-running doesn't create duplicates.
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'processInvoices')
    .forEach(t => ScriptApp.deleteTrigger(t));

  ScriptApp.newTrigger('processInvoices')
    .timeBased()
    .everyMinutes(15)
    .create();

  Logger.log('Trigger created: processInvoices() will run every 15 minutes.');
}
