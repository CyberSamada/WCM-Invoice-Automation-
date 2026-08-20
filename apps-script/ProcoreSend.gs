/**
 * ProcoreSend.gs
 * Workflow layer for the Procore send feature — which Invoice Log row goes with which Procore
 * record, called from the dashboard. A structural analogue of NexusSync.gs, referenced by name in
 * ProcoreClient.gs's own header comment since before this file existed. ProcoreClient.gs stays a pure
 * REST client with no SpreadsheetApp; this file is what reads the sheet, remembers a confirmed
 * vendor+project -> commitment pairing (the "Procore Commitment Map" tab), and actually creates the
 * Procore record.
 *
 * Three entry points, in the order a dashboard flow calls them:
 *   1. matchInvoiceToProcoreCommitment(rowId) — resolve (cached or live), auto-save when there's
 *      exactly one candidate.
 *   2. confirmProcoreCommitmentPick(rowId, candidate) — save a human's pick when there was more than
 *      one candidate.
 *   3. sendInvoiceToProcore(rowId) — create the real Subcontractor Invoice (requisition) against the
 *      now-confirmed commitment, attach the PDF, log it, flip Status.
 *
 * Genuinely unverified against a live Procore create call as of this writing — see the doc comments
 * on procoreCreateSubcontractorInvoice_/procoreAttachFileToRequisition_ (ProcoreClient.gs) and
 * HANDOFF.md §8/§9 for why (the live test call is blocked pending explicit permission in this
 * session). Everything here follows the documented request/response shapes as closely as possible;
 * whoever runs the first real send should treat any 4xx as informative, not surprising.
 */

/**
 * Reads one Invoice Log row's Vendor and Project Number by Row ID — the two fields
 * procoreFindCommitmentForInvoiceRow_ needs. Same header-name-lookup, byte-for-byte row scan as
 * testProcoreSendDirectCost (Setup.gs) — CLAUDE.md's rule against positional column access applies
 * here the same as everywhere else this sheet is read.
 */
function procoreLoadInvoiceRowForMatch_(rowId) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEET_LOG_TAB);
  if (!sheet) throw new Error(`"${CONFIG.SHEET_LOG_TAB}" tab not found.`);
  const values = sheet.getDataRange().getValues();
  const header = values[0] || [];
  const idIdx = header.indexOf('Row ID');
  const vendorIdx = header.indexOf('Vendor');
  const projectNumberIdx = header.indexOf('Project Number');
  const invoiceNumberIdx = header.indexOf('Invoice Number');
  if (idIdx === -1) throw new Error('No "Row ID" column in the Invoice Log.');

  for (let r = 1; r < values.length; r++) {
    if (String(values[r][idIdx]) === String(rowId)) {
      const row = values[r];
      return {
        rowId: String(rowId),
        vendor: vendorIdx > -1 ? String(row[vendorIdx] || '').trim() : '',
        projectNumber: projectNumberIdx > -1 ? row[projectNumberIdx] : '',
        invoiceNumber: invoiceNumberIdx > -1 ? String(row[invoiceNumberIdx] || '').trim() : ''
      };
    }
  }
  throw new Error(`No row with Row ID "${rowId}" in the Invoice Log.`);
}

/**
 * Same lookup as procoreLoadInvoiceRowForMatch_, extended with everything sendInvoiceToProcore
 * additionally needs: Amount, Currency, a Drive file to attach, and a date to bill on. Kept as a
 * separate function rather than widening the match-only loader above, so the cheap matching path
 * (called on every preview open) doesn't do more sheet reading than it needs.
 */
function procoreLoadInvoiceRowForSend_(rowId) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEET_LOG_TAB);
  if (!sheet) throw new Error(`"${CONFIG.SHEET_LOG_TAB}" tab not found.`);
  const values = sheet.getDataRange().getValues();
  const header = values[0] || [];
  const idx = {};
  ['Row ID', 'Vendor', 'Project Number', 'Invoice Number', 'Invoice Date', 'Amount', 'Currency', 'Drive File ID', 'Drive Link', 'Status']
    .forEach(name => { idx[name] = header.indexOf(name); });
  if (idx['Row ID'] === -1) throw new Error('No "Row ID" column in the Invoice Log.');

  for (let r = 1; r < values.length; r++) {
    if (String(values[r][idx['Row ID']]) === String(rowId)) {
      const row = values[r];
      let fileId = idx['Drive File ID'] > -1 ? String(row[idx['Drive File ID']] || '').trim() : '';
      if (!fileId && idx['Drive Link'] > -1) fileId = driveFileIdFromUrl_(row[idx['Drive Link']]);
      let invoiceDate = idx['Invoice Date'] > -1 ? row[idx['Invoice Date']] : null;
      return {
        rowId: String(rowId),
        vendor: idx['Vendor'] > -1 ? String(row[idx['Vendor']] || '').trim() : '',
        projectNumber: idx['Project Number'] > -1 ? row[idx['Project Number']] : '',
        invoiceNumber: idx['Invoice Number'] > -1 ? String(row[idx['Invoice Number']] || '').trim() : '',
        invoiceDate: invoiceDate,
        amount: idx['Amount'] > -1 ? row[idx['Amount']] : '',
        currency: idx['Currency'] > -1 ? String(row[idx['Currency']] || '').trim() : '',
        fileId: fileId,
        status: idx['Status'] > -1 ? String(row[idx['Status']] || '').trim() : ''
      };
    }
  }
  throw new Error(`No row with Row ID "${rowId}" in the Invoice Log.`);
}

// --- Procore Commitment Map (the learned crosswalk) -----------------------------------------------

/** Same key shape on both sides of the crosswalk: normalized vendor + normalized project number. */
function procoreCommitmentMapKey_(vendor, projectNumber) {
  return vendorNormalizedKey_(vendor) + '|' + normalizeNumberKey_(projectNumber);
}

/**
 * Reads the whole Procore Commitment Map into a lookup keyed by procoreCommitmentMapKey_. Small
 * table (one row per vendor+project pair ever confirmed, not one per invoice) — read whole, same as
 * getAliasData_/getReferenceData_ read their tabs whole rather than searching row by row.
 * @return {Object<string, {projectId:number, projectName:string, commitmentId:number,
 *   commitmentTitle:string, commitmentNumber:string, commitmentKind:string}>}
 */
function procoreLoadCommitmentMap_() {
  const map = {};
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEET_PROCORE_COMMITMENT_MAP_TAB);
  if (!sheet) return map;
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return map;
  const header = values[0];
  const idx = {};
  CONFIG.PROCORE_COMMITMENT_MAP_COLUMNS.forEach(c => { idx[c] = header.indexOf(c); });
  if (idx['Vendor'] === -1 || idx['Project Number'] === -1) return map;

  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    const vendor = String(row[idx['Vendor']] || '').trim();
    if (!vendor) continue;
    const key = procoreCommitmentMapKey_(vendor, row[idx['Project Number']]);
    map[key] = {
      projectId: Number(row[idx['Procore Project ID']]),
      projectName: String(row[idx['Procore Project Name']] || ''),
      commitmentId: Number(row[idx['Commitment ID']]),
      commitmentTitle: String(row[idx['Commitment Title']] || ''),
      commitmentNumber: String(row[idx['Commitment Number']] || ''),
      commitmentKind: String(row[idx['Commitment Kind']] || '')
    };
  }
  return map;
}

/**
 * Appends one confirmed vendor+project -> commitment pairing. Always appends, never edits an
 * existing row in place — same shape as the Nexus maps, and consistent with procoreLoadCommitmentMap_
 * only ever needing the tab read in full (a later row for the same key would simply overwrite the
 * earlier one in the in-memory lookup, which is the desired "most recent confirmation wins"
 * behavior if a pairing is ever deliberately re-confirmed).
 */
function procoreSaveCommitmentMatch_(entry) {
  const sheet = getOrCreateSheet_(CONFIG.SHEET_PROCORE_COMMITMENT_MAP_TAB, CONFIG.PROCORE_COMMITMENT_MAP_COLUMNS);
  ensureSheetHasColumns_(sheet, CONFIG.PROCORE_COMMITMENT_MAP_COLUMNS);
  const header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const stamp = Utilities.formatDate(new Date(), CONFIG_TIMEZONE_(), 'yyyy-MM-dd HH:mm');
  const filled = {
    'Vendor': entry.vendor,
    'Project Number': entry.projectNumber,
    'Procore Project ID': entry.projectId,
    'Procore Project Name': entry.projectName,
    'Commitment ID': entry.commitmentId,
    'Commitment Title': entry.commitmentTitle,
    'Commitment Number': entry.commitmentNumber,
    'Commitment Kind': entry.commitmentKind,
    'Confirmed At': stamp,
    'Confirmed By': currentViewerEmail_() || '(unknown)'
  };
  sheet.appendRow(header.map(col => (filled[col] !== undefined ? filled[col] : '')));
  // Force ID-ish columns to text so Sheets can't coerce e.g. project number "06" or a numeric-looking
  // commitment id into something else on a later read — same trap CLAUDE.md documents for the log.
  const lastRow = sheet.getLastRow();
  ['Project Number', 'Procore Project ID', 'Commitment ID'].forEach(col => {
    const i = header.indexOf(col);
    if (i > -1) sheet.getRange(lastRow, i + 1).setNumberFormat('@');
  });
}

// --- Matching (cached first, then live) ------------------------------------------------------------

/**
 * Dashboard entry point for the invoice-to-commitment matcher. Given a Row ID, resolves the Procore
 * project from the row's own WCM Project Number, then the commitment from its Vendor. Checks the
 * Procore Commitment Map FIRST — a previously confirmed vendor+project pairing resolves instantly
 * with no Procore call at all. On a fresh (uncached) match with exactly ONE candidate, the pairing is
 * saved immediately (Ahmed, 2026-08-20: "if only 1, assign directly" — nothing to pick, so nothing to
 * wait on); more than one candidate is left unsaved for confirmProcoreCommitmentPick to decide.
 *
 * READ-ONLY with respect to Procore and the Invoice Log — the only write this can ever make is
 * appending to the Procore Commitment Map, which is the point of the whole crosswalk. Gated the same
 * as the Procore smoke test (testProcoreSendDirectCost, Setup.gs): canControlAutomation_ +
 * procoreConfigured_.
 *
 * @param {string} rowId
 * @return {{ok: true, autoMatched: true, fromCache: boolean, projectId: number, projectName: string,
 *            commitmentId: number, commitmentTitle: string, commitmentNumber: string,
 *            commitmentKind: string, vendorName: string, vendor: string, projectNumber: (string|number),
 *            invoiceNumber: string}
 *          | {ok: false, stage: 'project'|'commitment', ambiguous: boolean, candidates: (Array|null),
 *             reason: string, vendor: string, projectNumber: (string|number), invoiceNumber: string,
 *             projectId: (number|undefined), projectName: (string|undefined)}}
 */
function matchInvoiceToProcoreCommitment(rowId) {
  if (!canControlAutomation_()) {
    throw new Error('You are not allowed to match invoices against Procore. Ask the automation owner to add your email to DASHBOARD_CONTROL_EMAILS in Config.gs.');
  }
  if (!procoreConfigured_()) {
    throw new Error('Procore is not configured — set the Script Properties and run setupProcore() first.');
  }

  const invoice = procoreLoadInvoiceRowForMatch_(rowId);
  if (!invoice.vendor) {
    throw new Error(`Row ${rowId} has no Vendor — nothing to match against Procore.`);
  }

  const cacheKey = procoreCommitmentMapKey_(invoice.vendor, invoice.projectNumber);
  const cached = procoreLoadCommitmentMap_()[cacheKey];
  if (cached) {
    return Object.assign({
      ok: true,
      autoMatched: true,
      fromCache: true,
      vendorName: invoice.vendor,
      vendor: invoice.vendor,
      projectNumber: invoice.projectNumber,
      invoiceNumber: invoice.invoiceNumber
    }, cached);
  }

  const result = procoreFindCommitmentForInvoiceRow_(
    { vendor: invoice.vendor, projectNumber: invoice.projectNumber },
    'all'
  );

  if (!result.matched) {
    return {
      ok: false,
      stage: result.stage,
      ambiguous: !!(result.candidates && result.candidates.length > 1),
      candidates: result.candidates || null,
      reason: result.reason,
      projectId: result.projectId,
      projectName: result.projectName,
      vendor: invoice.vendor,
      projectNumber: invoice.projectNumber,
      invoiceNumber: invoice.invoiceNumber
    };
  }

  // Exactly one candidate — nothing to pick, so this IS the decision. Save it now.
  procoreSaveCommitmentMatch_({
    vendor: invoice.vendor,
    projectNumber: invoice.projectNumber,
    projectId: result.projectId,
    projectName: result.projectName,
    commitmentId: result.commitmentId,
    commitmentTitle: result.commitmentTitle,
    commitmentNumber: result.commitmentNumber,
    commitmentKind: result.commitmentKind
  });

  return {
    ok: true,
    autoMatched: true,
    fromCache: false,
    projectId: result.projectId,
    projectName: result.projectName,
    commitmentId: result.commitmentId,
    commitmentTitle: result.commitmentTitle,
    commitmentNumber: result.commitmentNumber,
    commitmentKind: result.commitmentKind,
    vendorName: result.vendorName,
    vendor: invoice.vendor,
    projectNumber: invoice.projectNumber,
    invoiceNumber: invoice.invoiceNumber
  };
}

/**
 * Saves a human's pick from the ambiguous-candidate list matchInvoiceToProcoreCommitment returned.
 * This is the "let user pick" half of Ahmed's instruction — the pick becomes exactly as permanent as
 * an auto-assigned single match: appended to the Procore Commitment Map, so the same vendor+project
 * resolves from cache on every later invoice without asking again.
 *
 * @param {string} rowId
 * @param {{commitmentId:number, commitmentTitle:string, commitmentNumber:string, commitmentKind:string}} candidate
 *   - one entry from a prior matchInvoiceToProcoreCommitment ambiguous result's `candidates` array.
 * @param {number} projectId - from that same result (`projectId`/`projectName` are present whenever
 *   stage was 'commitment' — see procoreFindCommitmentForInvoiceRow_).
 * @param {string} projectName
 * @return {{ok: true, commitmentId: number, commitmentTitle: string, commitmentNumber: string}}
 */
function confirmProcoreCommitmentPick(rowId, candidate, projectId, projectName) {
  if (!canControlAutomation_()) {
    throw new Error('You are not allowed to match invoices against Procore. Ask the automation owner to add your email to DASHBOARD_CONTROL_EMAILS in Config.gs.');
  }
  if (!candidate || !candidate.commitmentId) {
    throw new Error('No commitment candidate was given to confirm.');
  }
  if (!projectId) {
    throw new Error('No Procore project ID was given alongside the candidate — re-run the match first.');
  }

  const invoice = procoreLoadInvoiceRowForMatch_(rowId);
  if (!invoice.vendor) {
    throw new Error(`Row ${rowId} has no Vendor — nothing to confirm against Procore.`);
  }

  procoreSaveCommitmentMatch_({
    vendor: invoice.vendor,
    projectNumber: invoice.projectNumber,
    projectId: projectId,
    projectName: projectName || '',
    commitmentId: candidate.commitmentId,
    commitmentTitle: candidate.commitmentTitle,
    commitmentNumber: candidate.commitmentNumber,
    commitmentKind: candidate.commitmentKind
  });

  return {
    ok: true,
    commitmentId: candidate.commitmentId,
    commitmentTitle: candidate.commitmentTitle,
    commitmentNumber: candidate.commitmentNumber
  };
}

// --- The actual send ---------------------------------------------------------------------------

/**
 * Looks for a prior Procore Send Log entry for this Row ID in the CURRENT environment
 * (procoreEnv_()) — scoped to environment so a sandbox test send never blocks a later real
 * production send of the same row, or vice versa. Returns the most recent matching row (last one
 * wins, same "later row overwrites" reading procoreLoadCommitmentMap_ already uses) or null.
 *
 * This is the guard that makes sendInvoiceToProcore safe to call twice on the same row — a double
 * click, or the same row appearing in two overlapping bulk selections — without creating a second
 * Subcontractor Invoice for one WCM invoice. Nothing enforced this before sendInvoicesToProcoreBulk
 * existed; a single accidental re-click was a real but low-probability risk, a bulk button pressed
 * twice on the same selection was not.
 * @return {{requisitionId:(number|string), timestamp:string, attached:boolean}|null}
 */
function procoreFindExistingSend_(rowId) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEET_PROCORE_SEND_LOG_TAB);
  if (!sheet) return null;
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return null;
  const header = values[0];
  const idx = {};
  ['Row ID', 'Requisition ID', 'Timestamp', 'Attached', 'Environment'].forEach(c => { idx[c] = header.indexOf(c); });
  if (idx['Row ID'] === -1) return null;

  const env = procoreEnv_();
  let found = null;
  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    if (String(row[idx['Row ID']] || '').trim() !== String(rowId)) continue;
    if (idx['Environment'] > -1 && String(row[idx['Environment']] || '').trim() !== env) continue;
    found = {
      requisitionId: idx['Requisition ID'] > -1 ? row[idx['Requisition ID']] : '',
      timestamp: idx['Timestamp'] > -1 ? String(row[idx['Timestamp']] || '') : '',
      attached: idx['Attached'] > -1 && String(row[idx['Attached']] || '').trim() === 'Yes'
    };
  }
  return found;
}

/**
 * Appends one row to the Procore Send Log — the audit trail for what was actually sent (see file
 * header). Returns the sheet row number it wrote to, so sendInvoiceToProcore can flip just the
 * 'Attached' cell in place afterward instead of appending a second, near-duplicate row.
 */
function procoreLogSendRow_(entry) {
  const sheet = getOrCreateSheet_(CONFIG.SHEET_PROCORE_SEND_LOG_TAB, CONFIG.PROCORE_SEND_LOG_COLUMNS);
  ensureSheetHasColumns_(sheet, CONFIG.PROCORE_SEND_LOG_COLUMNS);
  const header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const stamp = Utilities.formatDate(new Date(), CONFIG_TIMEZONE_(), 'yyyy-MM-dd HH:mm');
  const filled = {
    'Timestamp': stamp,
    'Sent By': currentViewerEmail_() || '(unknown)',
    'Row ID': entry.rowId,
    'Invoice Number': entry.invoiceNumber,
    'Vendor': entry.vendor,
    'Amount': entry.amount == null ? '' : entry.amount,
    'Currency': entry.currency || '',
    'Procore Project ID': entry.projectId,
    'Procore Project Name': entry.projectName,
    'Commitment ID': entry.commitmentId,
    'Commitment Number': entry.commitmentNumber,
    'Requisition ID': entry.requisitionId,
    'Attached': entry.attached ? 'Yes' : 'No',
    'Environment': entry.environment
  };
  sheet.appendRow(header.map(col => (filled[col] !== undefined ? filled[col] : '')));
  const lastRow = sheet.getLastRow();
  ['Row ID', 'Invoice Number', 'Procore Project ID', 'Commitment ID', 'Requisition ID'].forEach(col => {
    const i = header.indexOf(col);
    if (i > -1) sheet.getRange(lastRow, i + 1).setNumberFormat('@');
  });
  return lastRow;
}

/** Flips an already-written Procore Send Log row's 'Attached' cell to 'Yes' — see procoreLogSendRow_. */
function procoreMarkSendRowAttached_(sheetRow) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEET_PROCORE_SEND_LOG_TAB);
  if (!sheet) return; // shouldn't happen — procoreLogSendRow_ just created it — but never fail a send over this
  const header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const i = header.indexOf('Attached');
  if (i > -1) sheet.getRange(sheetRow, i + 1).setValue('Yes');
}

/**
 * THE REAL SEND. Creates a Subcontractor Invoice (Procore `requisitions`) against the commitment the
 * Procore Commitment Map already has confirmed for this row's vendor+project, attaches the invoice
 * PDF, logs it to the Procore Send Log, and flips the Invoice Log Status to STORED_PROCESSED_STATUS
 * through updateInvoiceRow — the single write path (CLAUDE.md), never the literal 'Captured' typed
 * here.
 *
 * Requires a confirmed match to already exist (matchInvoiceToProcoreCommitment or
 * confirmProcoreCommitmentPick must have run first) — this function does NOT match on the fly, so a
 * send can never silently pick a commitment nobody confirmed.
 *
 * Create -> log -> attach -> status, in that order (HANDOFF.md §4's design point): the ledger row is
 * written immediately after a successful create, before the attach is even attempted, so a mid-run
 * failure still leaves a findable record of what was created in Procore — a duplicate create on retry
 * is the recoverable failure mode; a created-but-unlogged requisition is not.
 *
 * @param {string} rowId
 * @return {{ok: true, requisitionId: number, attached: boolean, message: string,
 *           row: (Object|undefined), alreadySent: (boolean|undefined)}
 *          | {ok: false, message: string}}
 *   `row` is updateInvoiceRow's own return value (display-translated Status included) — present on
 *   every real send, absent on the alreadySent short-circuit (nothing was updated that time).
 */
function sendInvoiceToProcore(rowId) {
  if (!canControlAutomation_()) {
    throw new Error('You are not allowed to send invoices to Procore. Ask the automation owner to add your email to DASHBOARD_CONTROL_EMAILS in Config.gs.');
  }
  if (!procoreConfigured_()) {
    throw new Error('Procore is not configured — set the Script Properties and run setupProcore() first.');
  }

  const invoice = procoreLoadInvoiceRowForSend_(rowId);
  if (!invoice.vendor) throw new Error(`Row ${rowId} has no Vendor.`);
  if (!invoice.invoiceNumber) throw new Error(`Row ${rowId} has no Invoice Number — Procore requires one.`);
  if (invoice.status === 'Duplicate') {
    throw new Error(`Row ${rowId} is a Duplicate — its file belongs to another row. Send the canon invoice instead.`);
  }
  if (invoice.status === 'Not an Invoice') {
    throw new Error(`Row ${rowId} is marked "Not an Invoice" — nothing to send.`);
  }

  const existing = procoreFindExistingSend_(rowId);
  if (existing) {
    return {
      ok: true,
      alreadySent: true,
      requisitionId: existing.requisitionId,
      attached: existing.attached,
      message: `Already sent — Subcontractor Invoice ${existing.requisitionId} was created ${existing.timestamp} (${procoreEnv_()}). Not creating a second one.`
    };
  }

  const match = procoreLoadCommitmentMap_()[procoreCommitmentMapKey_(invoice.vendor, invoice.projectNumber)];
  if (!match) {
    throw new Error(`No confirmed Procore commitment for "${invoice.vendor}" on project ${invoice.projectNumber} yet — match it first ("Send to Procore…").`);
  }

  const billingDate = invoice.invoiceDate
    ? Utilities.formatDate(new Date(invoice.invoiceDate), CONFIG_TIMEZONE_(), 'yyyy-MM-dd')
    : Utilities.formatDate(new Date(), CONFIG_TIMEZONE_(), 'yyyy-MM-dd');

  const created = procoreCreateSubcontractorInvoice_(match.projectId, match.commitmentId, invoice.invoiceNumber, billingDate);

  // Ledger row written NOW, before the attach is even attempted — see the function doc comment.
  const logRow = procoreLogSendRow_({
    rowId: invoice.rowId,
    invoiceNumber: invoice.invoiceNumber,
    vendor: invoice.vendor,
    amount: invoice.amount,
    currency: invoice.currency,
    projectId: match.projectId,
    projectName: match.projectName,
    commitmentId: match.commitmentId,
    commitmentNumber: match.commitmentNumber,
    requisitionId: created.requisitionId,
    attached: false,
    environment: procoreEnv_()
  });

  let attached = false;
  let attachError = '';
  if (invoice.fileId) {
    try {
      const blob = DriveApp.getFileById(invoice.fileId).getBlob();
      const uuid = procoreUploadFile_(match.projectId, blob);
      procoreAttachFileToRequisition_(match.projectId, created.requisitionId, uuid);
      attached = true;
    } catch (e) {
      attachError = e.message;
    }
  }

  if (attached) {
    // Flip the same row's 'Attached' cell rather than appending a second, near-duplicate log row —
    // best-effort: a failed cell update never undoes the real create the log row already recorded.
    try { procoreMarkSendRowAttached_(logRow); } catch (e) { /* logged, not fatal */ }
  }

  // Capture and return the updated row (not just flip it) — updateInvoiceRow already returns the
  // display-translated Status (displayStatus_) as CLAUDE.md requires; a caller patching its own local
  // record cache (the dashboard's bulk send results) should use THIS, never retype 'In Procore' by
  // hand — that's exactly the stored-vs-displayed mixup CLAUDE.md calls out as the bug to watch for.
  const updatedRow = updateInvoiceRow(rowId, { status: STORED_PROCESSED_STATUS });

  if (!attached) {
    return {
      ok: true,
      requisitionId: created.requisitionId,
      attached: false,
      row: updatedRow,
      message: `Created Subcontractor Invoice ${created.requisitionId} in Procore project ${match.projectId} against commitment ${match.commitmentNumber}, but the PDF didn't attach: ${attachError || 'no Drive file found on this row'}. Status updated anyway — the record exists in Procore, attach it by hand.`
    };
  }

  return {
    ok: true,
    requisitionId: created.requisitionId,
    attached: true,
    row: updatedRow,
    message: `Sent — Subcontractor Invoice ${created.requisitionId} created in Procore project ${match.projectId} against commitment ${match.commitmentNumber}, PDF attached, status updated.`
  };
}

// --- Bulk send (multi-select bar) -------------------------------------------------------------

// Real network calls per row (match/list, create, upload, attach) unlike downloadInvoicesZip's cheap
// per-file base64 reads — capped well under DOWNLOAD_MAX_FILES (100) so one call comfortably fits the
// ~6-minute execution limit even with a couple of retries per row. No resumable/multi-call design yet
// (see PROCORE_SEND_BULK_TIME_BUDGET_MS_ below for the same reasoning applied as a time cutoff too) —
// a future need to send more than this at once should build that rather than raise this number blind.
const PROCORE_SEND_BULK_MAX_ = 25;
// Stops starting new rows once elapsed time passes this, leaving the rest in `remaining` rather than
// risking Apps Script's own kill cutting a send off mid-create. Apps Script gives ~6 minutes; this
// stops with real margin for the last row's own retries to finish inside the limit.
const PROCORE_SEND_BULK_TIME_BUDGET_MS_ = 4.5 * 60 * 1000;

/**
 * Bulk "Send to Procore" for the dashboard's multi-select bar. For each Row ID: skip the same
 * statuses sendInvoiceToProcore itself refuses (Duplicate, Not an Invoice); otherwise resolve a
 * commitment via matchInvoiceToProcoreCommitment (cached instantly if this vendor+project pair was
 * ever confirmed before, live otherwise) and only actually send when that resolves WITHOUT asking a
 * human — an ambiguous vendor (more than one commitment) is never auto-picked here, same "let user
 * pick" rule as the single-invoice flow, it just means picking it happens later from that invoice's
 * own preview panel instead of blocking the whole batch. sendInvoiceToProcore's own idempotency guard
 * (procoreFindExistingSend_) makes re-selecting an already-sent row a safe no-op, not a duplicate.
 *
 * NO SILENT CAPS: exceeding PROCORE_SEND_BULK_MAX_ refuses the whole call up front (same shape as
 * DOWNLOAD_MAX_FILES) rather than silently sending only the first N; running out of time budget mid-
 * batch reports exactly which Row IDs were never attempted in `remaining`, not just how many.
 *
 * @param {Array<string>} rowIds
 * @return {{ok: true, sent: Array, alreadySent: Array, needsMatch: Array, skipped: Array,
 *           errors: Array, remaining: Array<string>}
 *          | {ok: false, message: string}}
 */
function sendInvoicesToProcoreBulk(rowIds) {
  if (!canControlAutomation_()) {
    throw new Error('You are not allowed to send invoices to Procore. Ask the automation owner to add your email to DASHBOARD_CONTROL_EMAILS in Config.gs.');
  }
  if (!procoreConfigured_()) {
    throw new Error('Procore is not configured — set the Script Properties and run setupProcore() first.');
  }
  if (!rowIds || !rowIds.length) {
    return { ok: true, sent: [], alreadySent: [], needsMatch: [], skipped: [], errors: [], remaining: [] };
  }
  if (rowIds.length > PROCORE_SEND_BULK_MAX_) {
    return {
      ok: false,
      message: `${rowIds.length} invoices selected — Send to Procore is capped at ${PROCORE_SEND_BULK_MAX_} per batch (each one is a real Procore API call, not a cheap file copy). Select fewer, or send in two batches.`
    };
  }

  const startedAt = Date.now();
  const sent = [];
  const alreadySent = [];
  const needsMatch = [];
  const skipped = [];
  const errors = [];
  const remaining = [];

  for (let i = 0; i < rowIds.length; i++) {
    const rowId = rowIds[i];
    if (Date.now() - startedAt > PROCORE_SEND_BULK_TIME_BUDGET_MS_) {
      remaining.push(rowId);
      continue;
    }

    let invoice;
    try {
      invoice = procoreLoadInvoiceRowForMatch_(rowId);
    } catch (e) {
      errors.push({ rowId: rowId, message: e.message });
      continue;
    }
    if (!invoice.vendor) {
      errors.push({ rowId: rowId, invoiceNumber: invoice.invoiceNumber, message: 'No Vendor on this row.' });
      continue;
    }

    let matchResult;
    try {
      matchResult = matchInvoiceToProcoreCommitment(rowId);
    } catch (e) {
      errors.push({ rowId: rowId, invoiceNumber: invoice.invoiceNumber, vendor: invoice.vendor, message: e.message });
      continue;
    }
    if (!matchResult.ok) {
      needsMatch.push({
        rowId: rowId,
        invoiceNumber: invoice.invoiceNumber,
        vendor: invoice.vendor,
        ambiguous: !!matchResult.ambiguous,
        reason: matchResult.reason
      });
      continue;
    }

    try {
      const sendResult = sendInvoiceToProcore(rowId);
      const record = {
        rowId: rowId,
        invoiceNumber: invoice.invoiceNumber,
        vendor: invoice.vendor,
        requisitionId: sendResult.requisitionId,
        attached: sendResult.attached,
        message: sendResult.message,
        row: sendResult.row || null // the dashboard patches its local cache from this — never guesses a status string
      };
      if (sendResult.alreadySent) alreadySent.push(record);
      else sent.push(record);
    } catch (e) {
      // The status guards inside sendInvoiceToProcore (Duplicate / Not an Invoice) throw — read them
      // back out as skips rather than errors, since they're expected outcomes of a filtered selection
      // containing rows that were never eligible, not failures.
      if (invoice && (/Duplicate/.test(e.message) || /Not an Invoice/.test(e.message))) {
        skipped.push({ rowId: rowId, invoiceNumber: invoice.invoiceNumber, vendor: invoice.vendor, reason: e.message });
      } else {
        errors.push({ rowId: rowId, invoiceNumber: invoice.invoiceNumber, vendor: invoice.vendor, message: e.message });
      }
    }
  }

  return { ok: true, sent: sent, alreadySent: alreadySent, needsMatch: needsMatch, skipped: skipped, errors: errors, remaining: remaining };
}
