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
 * ONE-OFF SMOKE TEST — proves ProcoreClient.gs actually works end to end (auth, vendor match,
 * create, attach) against a real Procore sandbox, before any of the mapping UI (PR 2) or send
 * workflow (PR 3) exist. Run manually from the Apps Script editor:
 *
 *   testProcoreSendDirectCost('<a Row ID from the Invoice Log>', 362778)
 *
 * The vendor is NOT a parameter — it's read from the row's own Vendor column and matched by name
 * against Procore's real vendor directory for that project (procoreFindVendorByName_,
 * ProcoreClient.gs), so nobody has to already know or type a Procore vendor ID. Still asks for a
 * project ID, since there is no project crosswalk yet (PR 2) and sandbox has exactly one project to
 * test against anyway; per-WCM-project auto-matching is real future work, not something to fake here.
 *
 * Reads the row's real invoice number, vendor and PDF from the Invoice Log — READ ONLY, never writes
 * back to the sheet or changes the row's status. All writing happens on the Procore side only, and
 * only in whatever company PROCORE_COMPANY_ID / PROCORE_ENV currently point at (sandbox by default).
 *
 * Creates a Direct Cost, not a Subcontractor Invoice — no commitment or billing period needed, and
 * it sidesteps the still-unresolved "does creating a requisition notify the subcontractor" question
 * entirely (see HANDOFF.md), since a Direct Cost has no subcontractor attached to it at all.
 *
 * Attachment mechanism confirmed directly against Procore's own OAS schema while writing this (the
 * Procore integration repo's create_direct_cost_draft never actually attaches a file, so it wasn't a
 * usable reference here): direct_costs takes attachments as a separate multipart PATCH after create
 * — an `attachments[]` file field, NOT the two-step signed-upload UUID reference that requisitions
 * likely uses. Two different resources, two different attachment mechanisms — do not assume they
 * match without checking each one's schema. Split into create-then-attach (not one combined
 * multipart POST) on purpose: a failed attach still leaves a valid, findable draft record.
 *
 * Also callable from the dashboard (Dashboard.html's preview modal, gated on canControl +
 * procoreConfigured, same as Start/Pause and Manage hints) — hence the canControlAutomation_ gate
 * and the structured return value below; Logger.log calls stay too, for running this from the editor.
 *
 * @return {{ok: boolean, directCostId: (number|null), attached: boolean, message: string}}
 */
function testProcoreSendDirectCost(rowId, procoreProjectId) {
  if (!canControlAutomation_()) {
    throw new Error('You are not allowed to send test records to Procore. Ask the automation owner to add your email to DASHBOARD_CONTROL_EMAILS in Config.gs.');
  }
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEET_LOG_TAB);
  if (!sheet) throw new Error(`"${CONFIG.SHEET_LOG_TAB}" tab not found.`);
  const values = sheet.getDataRange().getValues();
  const header = values[0] || [];
  const idIdx = header.indexOf('Row ID');
  const invIdx = header.indexOf('Invoice Number');
  const vendorIdx = header.indexOf('Vendor');
  const fileIdx = header.indexOf('Drive File ID');
  const linkIdx = header.indexOf('Drive Link');
  if (idIdx === -1) throw new Error('No "Row ID" column in the Invoice Log.');

  let row = null;
  for (let r = 1; r < values.length; r++) {
    if (String(values[r][idIdx]) === String(rowId)) { row = values[r]; break; }
  }
  if (!row) throw new Error(`No row with Row ID "${rowId}" in the Invoice Log.`);

  const invoiceNumber = invIdx > -1 ? String(row[invIdx] || '').trim() : '';
  if (!invoiceNumber) throw new Error(`Row ${rowId} has no Invoice Number — Procore requires one.`);

  const vendorName = vendorIdx > -1 ? String(row[vendorIdx] || '').trim() : '';
  if (!vendorName) throw new Error(`Row ${rowId} has no Vendor — nothing to match against Procore's directory.`);

  let fileId = fileIdx > -1 ? String(row[fileIdx] || '').trim() : '';
  if (!fileId && linkIdx > -1) fileId = driveFileIdFromUrl_(row[linkIdx]);
  if (!fileId) throw new Error(`Row ${rowId} has no Drive file to attach.`);

  Logger.log(`Matching vendor "${vendorName}" against Procore project ${procoreProjectId}'s directory...`);
  const match = procoreFindVendorByName_(procoreProjectId, vendorName);
  if (!match.matched) {
    Logger.log(match.reason);
    return { ok: false, directCostId: null, attached: false, message: match.reason };
  }
  Logger.log(`Matched "${vendorName}" -> Procore company "${match.vendorName}" (id ${match.vendorId}).`);

  Logger.log(`Creating a Direct Cost draft on Procore project ${procoreProjectId} for invoice "${invoiceNumber}"...`);

  const createResponse = procoreFetch_('post', 'direct_costs', `projects/${procoreProjectId}/direct_costs`, {
    payload: JSON.stringify({
      item: {
        invoice_number: invoiceNumber,
        vendor_id: match.vendorId,
        direct_cost_type: 'invoice',
        status: 'draft'
      }
    }),
    contentType: 'application/json'
  });
  const created = JSON.parse(createResponse.getContentText());
  const directCostId = created.id;
  if (!directCostId) throw new Error(`Procore returned 20x with no id: ${createResponse.getContentText().slice(0, 300)}`);
  Logger.log(`Created — Procore direct cost id ${directCostId}, status "${created.status}". Not yet attached.`);

  const blob = DriveApp.getFileById(fileId).getBlob();
  try {
    procoreFetch_('patch', 'direct_costs', `projects/${procoreProjectId}/direct_costs/${directCostId}`, {
      payload: { 'attachments[]': blob } // no contentType set — this is what makes UrlFetchApp encode multipart
    });
    Logger.log(`Attached "${blob.getName()}" to direct cost ${directCostId}.`);
  } catch (e) {
    Logger.log(`Direct cost ${directCostId} WAS created, but the attach failed: ${e.message}`);
    Logger.log('The record still exists in Procore — this is the recoverable half of the split, not a failed test.');
    return {
      ok: false,
      directCostId: directCostId,
      attached: false,
      message: `Created (id ${directCostId}) but the PDF didn't attach: ${e.message}`
    };
  }

  Logger.log(`Done. Check Procore project ${procoreProjectId} > Direct Costs for id ${directCostId} — draft, with the PDF attached. Nothing in the Invoice Log was changed by this test.`);
  return {
    ok: true,
    directCostId: directCostId,
    attached: true,
    message: `Created direct cost ${directCostId} in Procore project ${procoreProjectId} for "${match.vendorName}" (id ${match.vendorId}), PDF attached.`
  };
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

/**
 * ONE-OFF DIAGNOSTIC: lists Invoice Log rows by Status, for picking real test cases without pulling
 * the whole sheet through a generic document reader. The sheet has 700+ rows; a tool that dumps the
 * whole file as text truncates well before the end and can silently miss most matches. This reads
 * the sheet directly and filters server-side, so the result is exactly right and stays small.
 *
 * Run manually from the Apps Script editor: listInvoicesByStatus('Paid') — status is matched
 * case-insensitively. Logs Vendor, Project/Subproject, Amount, Invoice #, and Row ID for each match
 * (capped at `limit`, default 20) and returns the same as an array.
 */
function listInvoicesByStatus(status, limit) {
  limit = limit || 20;
  const wanted = String(status || '').trim().toLowerCase();
  if (!wanted) throw new Error('Pass a status to filter on, e.g. listInvoicesByStatus("Paid").');

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEET_LOG_TAB);
  if (!sheet) throw new Error(`"${CONFIG.SHEET_LOG_TAB}" tab not found.`);
  const values = sheet.getDataRange().getValues();
  const header = values[0] || [];
  const idx = {};
  ['Row ID', 'Vendor', 'Project Number', 'Project Name', 'Subproject Number', 'Amount', 'Currency', 'Status', 'Invoice Number']
    .forEach(name => { idx[name] = header.indexOf(name); });

  const out = [];
  for (let r = 1; r < values.length && out.length < limit; r++) {
    const row = values[r];
    if (String(row[idx['Status']] || '').trim().toLowerCase() !== wanted) continue;
    out.push({
      rowId: row[idx['Row ID']],
      vendor: row[idx['Vendor']],
      projectNumber: row[idx['Project Number']],
      projectName: row[idx['Project Name']],
      subprojectNumber: row[idx['Subproject Number']],
      amount: row[idx['Amount']],
      currency: row[idx['Currency']],
      invoiceNumber: row[idx['Invoice Number']]
    });
  }

  Logger.log(`${out.length} row(s) with Status "${status}" (of ${values.length - 1} total, capped at ${limit}):`);
  out.forEach(o => Logger.log(`  ${o.vendor} | Project ${o.projectNumber} ${o.projectName || ''}${o.subprojectNumber ? ' / ' + o.subprojectNumber : ''} | ${o.amount} ${o.currency} | Inv# ${o.invoiceNumber} | Row ${o.rowId}`));
  return out;
}
