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

  // Create the alias + notes tabs if missing, then seed both from the shipped defaults. The tabs are
  // the single editable home; ensureKnowledgeSeeded_ copies AliasSeed.gs/ExtractionNotes.gs into them
  // once (guarded, idempotent) so a fresh install starts with the known aliases and notes without any
  // manual import — coordinators tune them from the dashboard's "Manage hints" panel afterward.
  getOrCreateSheet_(CONFIG.SHEET_ALIASES_TAB, CONFIG.ALIAS_COLUMNS);
  getOrCreateSheet_(CONFIG.SHEET_AI_NOTES_TAB, CONFIG.AI_NOTES_COLUMNS);
  ensureKnowledgeSeeded_();
  Logger.log(`Seeded the "${CONFIG.SHEET_ALIASES_TAB}" and "${CONFIG.SHEET_AI_NOTES_TAB}" tabs from the shipped defaults (edit them from the dashboard's Manage hints panel, or directly).`);

  Logger.log('Setup complete. Next: set the GEMINI_API_KEY script property, fill in the Project Reference tab, then create a time-driven trigger for processInvoices() — see SETUP.md.');
}

/**
 * Escape hatch: forces the shipped defaults (AliasSeed.gs + ExtractionNotes.gs) to be re-copied into
 * the "Project Aliases" / "AI Notes" tabs — e.g. to restore a default someone deleted. Clears the
 * one-time guard flag and re-runs the seeder (which still skips rows already present, so it only ever
 * ADDS the missing defaults back; it never removes anyone's hand-added rows). Run manually. Rarely
 * needed — normal editing is done in the tabs / dashboard, not through re-seeding.
 */
function reseedKnowledge() {
  PropertiesService.getScriptProperties().deleteProperty(KNOWLEDGE_SEEDED_PROPERTY);
  ensureKnowledgeSeeded_();
  Logger.log('Re-seeded: any missing shipped-default aliases/notes were added back to their tabs. Hand-added rows were left untouched.');
}

/** Optional helper: creates the time-driven trigger from code instead of the Triggers UI. Run once. */
function createTimeTrigger() {
  // Remove any existing trigger for this function first, so re-running doesn't create duplicates.
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'processInvoices')
    .forEach(t => ScriptApp.deleteTrigger(t));

  const mins = CONFIG.TRIGGER_INTERVAL_MINUTES || 15;
  ScriptApp.newTrigger('processInvoices')
    .timeBased()
    .everyMinutes(mins)
    .create();

  Logger.log(`Trigger created: processInvoices() will run every ${mins} minutes.`);
}

/**
 * Optional: runs the rolling Invoice Log auto-archive (SheetService.gs/archiveOldInvoiceLogRows)
 * once a month, so the active log never grows unbounded. Run this ONCE to set it up. Idempotent —
 * re-running replaces the existing archive trigger rather than stacking a duplicate.
 */
function createArchiveTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'archiveOldInvoiceLogRows')
    .forEach(t => ScriptApp.deleteTrigger(t));

  ScriptApp.newTrigger('archiveOldInvoiceLogRows')
    .timeBased()
    .onMonthDay(1)
    .atHour(4)
    .create();

  Logger.log('Archive trigger created: archiveOldInvoiceLogRows() runs monthly on the 1st, ~4am.');
}

/**
 * Optional: runs the Drive drift auditor (Reconcile.gs/reconcileDriveLocations) once a day, so files
 * moved or deleted directly in Drive get caught and either synced back into the log or flagged for
 * review. Run this ONCE to set it up. Idempotent — re-running replaces the existing trigger.
 */
function createReconcileTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'reconcileDriveLocations')
    .forEach(t => ScriptApp.deleteTrigger(t));

  ScriptApp.newTrigger('reconcileDriveLocations')
    .timeBased()
    .everyDays(1)
    .atHour(3)
    .create();

  Logger.log('Reconcile trigger created: reconcileDriveLocations() runs daily, ~3am.');
}
