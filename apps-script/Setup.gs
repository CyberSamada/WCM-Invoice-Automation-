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

/**
 * Forces the Invoice Log's ID/code columns (CONFIG.LOG_TEXT_COLUMNS: invoice #, project/subproject
 * numbers, row/file IDs) to plain-text format so Sheets never coerces a value like "3050-4" into a
 * date. This runs automatically (once) on the next processing run or dashboard load; run it by hand
 * only if you want to apply it immediately. Safe to re-run.
 */
function ensureLogColumnFormats() {
  PropertiesService.getScriptProperties().deleteProperty(LOG_TEXT_FORMAT_PROPERTY);
  ensureLogTextFormats_();
  PropertiesService.getScriptProperties().setProperty(LOG_TEXT_FORMAT_PROPERTY, 'true');
  Logger.log('Forced text format on: ' + (CONFIG.LOG_TEXT_COLUMNS || []).join(', ') + '. Future values in these columns will no longer be coerced to dates/numbers.');
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

/**
 * ONE-TIME, MANUAL: makes the Status column consistent again.
 *
 * A short-lived earlier version wrote "Processed" into the Status column for rows that were edited
 * or Nexus-synced while it was live. The stored word is "Captured" everywhere else, and every code
 * path accepts both, so a mixed sheet behaves correctly - this just makes it READ consistently.
 *
 * Rewrites Status "Processed" -> "Captured" in the Invoice Log and the Invoice Log Archive.
 *
 * Safe by construction: only the Status column, only cells whose value is EXACTLY "Processed", the
 * column found by header NAME (never by position), one setValues per tab. Idempotent - run it twice
 * and the second run reports 0.
 */
function normalizeInvoiceStatuses() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const tabs = [CONFIG.SHEET_LOG_TAB, CONFIG.SHEET_LOG_ARCHIVE_TAB];
  let total = 0;

  tabs.forEach(tabName => {
    const sheet = ss.getSheetByName(tabName);
    if (!sheet) { Logger.log(`${tabName}: not present, skipped.`); return; }
    if (sheet.getLastRow() < 2) { Logger.log(`${tabName}: no data rows.`); return; }

    const header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    const col = header.indexOf('Status') + 1;
    if (col === 0) { Logger.log(`${tabName}: no "Status" column, skipped.`); return; }

    const range = sheet.getRange(2, col, sheet.getLastRow() - 1, 1);
    const values = range.getValues();
    let changed = 0;
    for (let i = 0; i < values.length; i++) {
      if (values[i][0] === 'Processed') { values[i][0] = 'Captured'; changed++; }
    }
    if (changed) range.setValues(values);
    total += changed;
    Logger.log(`${tabName}: ${changed} row(s) set back to "Captured".`);
  });

  Logger.log(`Done. ${total} row(s) normalized. The Status column now reads one word.`);
  return total;
}

/**
 * Run once, manually, after the four Procore Script Properties are set (see SETUP.md): checks they're
 * all present and that PROCORE_ENV resolves to a real value, without making any network call. Mirrors
 * the GEMINI_API_KEY pattern — credentials are entered directly into Project Settings > Script
 * Properties, never passed as a function argument, so nothing sensitive passes through the Apps
 * Script editor's execution log or this codebase. Run testProcoreConnection() next to actually talk
 * to Procore.
 */
function setupProcore() {
  const props = PropertiesService.getScriptProperties();
  const missing = [
    CONFIG.PROCORE_CLIENT_ID_PROPERTY,
    CONFIG.PROCORE_CLIENT_SECRET_PROPERTY,
    CONFIG.PROCORE_COMPANY_ID_PROPERTY
  ].filter(name => !props.getProperty(name));

  if (missing.length) {
    Logger.log(
      `Not configured yet. Missing Script Propert${missing.length === 1 ? 'y' : 'ies'}: ${missing.join(', ')}. ` +
      `Set ${missing.length === 1 ? 'it' : 'them'} under Project Settings > Script Properties, then run setupProcore() again.`
    );
    return;
  }

  const env = procoreEnv_();
  const envProp = props.getProperty(CONFIG.PROCORE_ENV_PROPERTY);
  if (!envProp) {
    Logger.log(`"${CONFIG.PROCORE_ENV_PROPERTY}" is not set — defaulting to "sandbox" (the safe default). Set it to "production" explicitly when ready to go live.`);
  } else if (envProp.trim().toLowerCase() !== 'production' && envProp.trim().toLowerCase() !== 'sandbox') {
    Logger.log(`"${CONFIG.PROCORE_ENV_PROPERTY}" is set to "${envProp}", which isn't recognized — treating it as "sandbox" (the safe default). Use exactly "production" to go live.`);
  }

  Logger.log(`Procore credentials are present. Environment: ${env}. Run testProcoreConnection() next to verify they actually work against Procore.`);
}

/**
 * Run manually after setupProcore(). Makes exactly one real, read-only call to Procore
 * (GET the configured company) to prove the credentials authenticate AND have access — the two are
 * separate failure modes (see ProcoreClient.gs), so this reports which one, if either, is wrong.
 */
function testProcoreConnection() {
  const env = procoreEnv_();
  const companyId = PropertiesService.getScriptProperties().getProperty(CONFIG.PROCORE_COMPANY_ID_PROPERTY);
  Logger.log(`Testing against Procore ${env} (company ${companyId})...`);

  let response;
  try {
    response = procoreFetch_('get', 'companies', `companies/${companyId}`, { maxRetries: 1 });
  } catch (e) {
    Logger.log(`FAILED: ${e.message}`);
    return;
  }

  const body = JSON.parse(response.getContentText());
  Logger.log(`OK — authenticated and permitted. Company: "${body.name || '(no name returned)'}" (id ${companyId}), environment: ${env}.`);
}
