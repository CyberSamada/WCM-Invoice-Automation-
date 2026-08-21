/**
 * ProcoreSend.gs
 * Workflow layer for the Procore send feature — which Invoice Log row goes with which Procore
 * record, called from the dashboard. A structural analogue of NexusSync.gs, referenced by name in
 * ProcoreClient.gs's own header comment since before this file existed. ProcoreClient.gs stays a pure
 * REST client with no SpreadsheetApp; this file is what reads the sheet, remembers a confirmed
 * vendor+project -> commitment pairing (the "Procore Commitment Map" tab), and actually creates the
 * Procore record.
 *
 * Four entry points, in the order a dashboard flow calls them:
 *   1. matchInvoiceToProcoreCommitment(rowId) — resolve (cached or live), auto-save when there's
 *      exactly one candidate.
 *   2. confirmProcoreCommitmentPick(rowId, candidate) — save a human's pick when there was more than
 *      one candidate.
 *   3. sendInvoiceToProcore(rowId, kind) — create the real Subcontractor Invoice (requisition) or
 *      Direct Cost against the now-confirmed commitment/vendor, attach the PDF, log it. Deliberately
 *      does NOT flip Status — Ahmed, 2026-08-21: sending to Procore and marking the WCM log "In
 *      Procore" are shown to the dashboard as two separate confirmations (create can succeed while an
 *      attach silently fails, per HANDOFF.md's attachment-bug note — a human should see that before
 *      the row is marked done), not one bundled step.
 *   4. markProcoreSentInvoices(rowIds) — the second confirmation: flips Status to
 *      STORED_PROCESSED_STATUS for rows the dashboard just sent, once the coordinator says yes.
 *
 * Genuinely unverified against a live Procore create call as of this writing — see the doc comments
 * on procoreCreateSubcontractorInvoice_/procoreAttachFileToRequisition_ (ProcoreClient.gs) and
 * HANDOFF.md §8/§9 for why (the live test call is blocked pending explicit permission in this
 * session). Everything here follows the documented request/response shapes as closely as possible;
 * whoever runs the first real send should treat any 4xx as informative, not surprising.
 */

/**
 * Reads one Invoice Log row's Vendor, Project Number and Subproject Number by Row ID — the fields
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
  const subprojectNumberIdx = header.indexOf('Subproject Number');
  const invoiceNumberIdx = header.indexOf('Invoice Number');
  // Gemini-extracted, only when the invoice itself states its own subcontract number — see
  // procoreFindCommitmentForInvoiceRow_ (ProcoreClient.gs) for how this strengthens matching.
  const commitmentNumberIdx = header.indexOf('Commitment Number');
  if (idIdx === -1) throw new Error('No "Row ID" column in the Invoice Log.');

  for (let r = 1; r < values.length; r++) {
    if (String(values[r][idIdx]) === String(rowId)) {
      const row = values[r];
      return {
        rowId: String(rowId),
        vendor: vendorIdx > -1 ? String(row[vendorIdx] || '').trim() : '',
        projectNumber: projectNumberIdx > -1 ? row[projectNumberIdx] : '',
        subprojectNumber: subprojectNumberIdx > -1 ? row[subprojectNumberIdx] : '',
        invoiceNumber: invoiceNumberIdx > -1 ? String(row[invoiceNumberIdx] || '').trim() : '',
        commitmentNumber: commitmentNumberIdx > -1 ? String(row[commitmentNumberIdx] || '').trim() : ''
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
  ['Row ID', 'Vendor', 'Project Number', 'Subproject Number', 'Invoice Number', 'Invoice Date', 'Amount', 'Currency', 'Drive File ID', 'Drive Link', 'Status']
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
        subprojectNumber: idx['Subproject Number'] > -1 ? row[idx['Subproject Number']] : '',
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

/**
 * The identifier actually used to resolve a Procore project for an invoice: its Subproject Number
 * when one is set, else the bare Project Number. Confirmed against real data 2026-08-20 (Ahmed):
 * this system's Subproject Number is already the full dotted form ("6.4" under project "06"), never a
 * bare child digit — so it is always a MORE SPECIFIC identifier than Project Number when present, not
 * a different one, and a Procore project numbered at the subproject grain (matching how Procore's own
 * project was actually set up here) resolves correctly without forcing every WCM row to carry a
 * matching bare project number. Falls back to Project Number when no subproject is set, so a
 * project-level invoice resolves exactly as it always did.
 */
function procoreProjectMatchKey_(projectNumber, subprojectNumber) {
  const sub = String(subprojectNumber == null ? '' : subprojectNumber).trim();
  return sub || projectNumber;
}

// --- Procore Commitment Map (the learned crosswalk) -----------------------------------------------

/** Same key shape on both sides of the crosswalk: normalized vendor + normalized project number.
 * "Project Number" here is whatever procoreProjectMatchKey_ resolved to for the row — a subproject
 * value when the invoice has one, so the crosswalk key matches at the same grain matching itself
 * resolves at. */
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
 * project from the row's own WCM Project Number, then the commitment — from a stated Commitment
 * Number when the invoice printed one (procoreFindCommitmentForInvoiceRow_ tries this first; it
 * resolves unambiguously even when the vendor has several commitments on the project), falling back
 * to Vendor when no number was given or none matched. Checks the Procore Commitment Map FIRST — a
 * previously confirmed vendor+project pairing resolves instantly with no Procore call at all. On a
 * fresh (uncached) match with exactly ONE candidate, the pairing is saved immediately (Ahmed,
 * 2026-08-20: "if only 1, assign directly" — nothing to pick, so nothing to wait on); more than one
 * candidate is left unsaved for confirmProcoreCommitmentPick to decide.
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
  const matchProjectNumber = procoreProjectMatchKey_(invoice.projectNumber, invoice.subprojectNumber);

  const cacheKey = procoreCommitmentMapKey_(invoice.vendor, matchProjectNumber);
  const cached = procoreLoadCommitmentMap_()[cacheKey];
  if (cached) {
    return Object.assign({
      ok: true,
      autoMatched: true,
      fromCache: true,
      vendorName: invoice.vendor,
      vendor: invoice.vendor,
      projectNumber: matchProjectNumber,
      invoiceNumber: invoice.invoiceNumber
    }, cached);
  }

  const result = procoreFindCommitmentForInvoiceRow_(
    { vendor: invoice.vendor, projectNumber: matchProjectNumber, commitmentNumber: invoice.commitmentNumber },
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
      projectNumber: matchProjectNumber,
      invoiceNumber: invoice.invoiceNumber
    };
  }

  // Exactly one candidate — nothing to pick, so this IS the decision. Save it now.
  procoreSaveCommitmentMatch_({
    vendor: invoice.vendor,
    projectNumber: matchProjectNumber,
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
    projectNumber: matchProjectNumber,
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
    // Same key grain matchInvoiceToProcoreCommitment used to produce this candidate list in the first
    // place — must match exactly, or this pick would be cached under a different key than future
    // lookups for this same invoice will use.
    projectNumber: procoreProjectMatchKey_(invoice.projectNumber, invoice.subprojectNumber),
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
 * Procore record for one WCM invoice, REGARDLESS of which kind (Subcontractor Invoice or Direct
 * Cost) either send used — sending the same invoice as both would still double-count it in Procore,
 * so this blocks on ANY prior send, not just a same-kind one.
 *
 * Only tells you what THIS repo's log recorded — the caller still has to confirm the record is
 * actually still there via procoreConfirmExistingSendStillExists_ before trusting it. This sheet has
 * no way to notice a requisition/direct cost that got deleted directly in Procore afterward.
 * @return {{requisitionId:(number|string), recordType:string, timestamp:string, attached:boolean,
 *           projectId:(number|string)}|null}
 */
function procoreFindExistingSend_(rowId) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEET_PROCORE_SEND_LOG_TAB);
  if (!sheet) return null;
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return null;
  const header = values[0];
  const idx = {};
  ['Row ID', 'Procore Record ID', 'Record Type', 'Timestamp', 'Attached', 'Environment', 'Procore Project ID', 'Outcome'].forEach(c => { idx[c] = header.indexOf(c); });
  if (idx['Row ID'] === -1) return null;

  const env = procoreEnv_();
  let found = null;
  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    if (String(row[idx['Row ID']] || '').trim() !== String(rowId)) continue;
    if (idx['Environment'] > -1 && String(row[idx['Environment']] || '').trim() !== env) continue;
    // Failed/refused attempts are logged to this same tab now — they must NEVER read as "already
    // sent", or one Procore outage would block that invoice's retry permanently. Blank counts as
    // sent (legacy rows) — see procoreSendLogRowIsSuccess_.
    if (idx['Outcome'] > -1 && !procoreSendLogRowIsSuccess_(row[idx['Outcome']])) continue;
    found = {
      requisitionId: idx['Procore Record ID'] > -1 ? row[idx['Procore Record ID']] : '',
      recordType: idx['Record Type'] > -1 ? String(row[idx['Record Type']] || '') : '',
      timestamp: idx['Timestamp'] > -1 ? String(row[idx['Timestamp']] || '') : '',
      attached: idx['Attached'] > -1 && String(row[idx['Attached']] || '').trim() === 'Yes',
      projectId: idx['Procore Project ID'] > -1 ? row[idx['Procore Project ID']] : ''
    };
  }
  return found;
}

/**
 * The live half of the idempotency guard (Ahmed, 2026-08-21: deleted test invoices/direct costs
 * directly in Procore to re-run a send, got refused anyway — "it should look in Procore to see if it
 * exists... right now I think it looks at a log and decides, which is weak"). Correct, and fixed here:
 * procoreFindExistingSend_ only proves our log SAYS something was sent, not that Procore still HAS it.
 * This dispatches to the matching live existence check (procoreRequisitionExists_ /
 * procoreDirectCostExists_, ProcoreClient.gs) by the logged Record Type and Project ID.
 *
 * Deliberately an ID lookup against Procore, NOT a vendor+amount+project search — this codebase
 * already has hard-won evidence (NexusSync.gs's own findings) that vendor+amount matching without an
 * id is genuinely non-unique in real data; reusing that approach here would trade one weak check for
 * another. We already have the exact record id our own prior send created, so confirming it by id is
 * both simpler and actually authoritative — no fuzzy matching involved.
 *
 * Fails SAFE toward "still exists" (blocks the resend) when the log itself doesn't have enough to
 * check — a missing Project ID (shouldn't happen; procoreLogSendRow_ always writes one, but an older
 * or hand-edited row might lack it) or a Record Type this function doesn't recognize. Silently
 * assuming "gone" in that situation risks creating a duplicate; blocking is the recoverable failure.
 */
function procoreConfirmExistingSendStillExists_(existing) {
  if (!existing.projectId || !existing.requisitionId) return true;
  if (existing.recordType === 'Direct Cost') return procoreDirectCostExists_(existing.projectId, existing.requisitionId);
  if (existing.recordType === 'Subcontractor Invoice') return procoreRequisitionExists_(existing.projectId, existing.requisitionId);
  return true;
}

/** The Outcome values the Procore Send Log records. Only PROCORE_OUTCOME_SENT_ counts as a real send
 *  for the idempotency guard — see procoreSendLogRowIsSuccess_. */
const PROCORE_OUTCOME_SENT_ = 'Sent';
const PROCORE_OUTCOME_FAILED_ = 'Failed';
const PROCORE_OUTCOME_NEEDS_MATCH_ = 'Needs Match';
const PROCORE_OUTCOME_SKIPPED_ = 'Skipped';

/**
 * Whether a Procore Send Log row represents an invoice that ACTUALLY reached Procore.
 *
 * A blank Outcome counts as sent, deliberately: rows written before the Outcome column existed are
 * all successes, because failures weren't logged at all back then. Getting this backwards in either
 * direction is a real-money bug — treating a failure as sent blocks a legitimate retry forever;
 * treating an old success as a failure invites a duplicate Procore record.
 */
function procoreSendLogRowIsSuccess_(outcomeValue) {
  const outcome = String(outcomeValue == null ? '' : outcomeValue).trim();
  return !outcome || outcome === PROCORE_OUTCOME_SENT_;
}

/**
 * Turns a raw Procore/Apps Script error into something a coordinator can act on, without throwing the
 * original away. procoreFetch_ throws messages shaped like
 * `Procore POST requisitions?project_id=362778 failed (400): {"errors":"The project must have an open
 * billing period ..."}` — accurate, but it leads with an HTTP verb and a URL and buries the one
 * sentence that says what to DO, which is the opposite of what someone triaging a failed batch needs.
 *
 * Known causes (both hit for real during this build — see HANDOFF.md §11/§12) get a plain-language
 * lead sentence; everything else falls back to the raw message rather than being swallowed or
 * paraphrased into something less precise. The original text is always appended, so nothing is lost
 * and the Send Log's Detail column stays diagnosable.
 */
function procoreHumanizeSendError_(message) {
  const raw = String(message == null ? '' : message).trim();
  if (!raw) return 'The send failed with no error message — see the Apps Script execution log.';

  if (/billing period/i.test(raw)) {
    return 'Procore needs an open billing period on this project before a Subcontractor Invoice can be created. Open one in Procore (or send this as a Direct Cost instead), then try again. — ' + raw;
  }
  if (/schedule of values/i.test(raw) && /approved/i.test(raw)) {
    return "The commitment's Schedule of Values has to be approved in Procore before it can be invoiced against. Approve it, then try again. — " + raw;
  }
  if (/\(403\)/.test(raw)) {
    return 'Procore refused this as not permitted — usually the project is missing from the app\'s permitted-projects list. Not a credentials problem. — ' + raw;
  }
  if (/\(401\)/.test(raw)) {
    return 'Procore rejected the credentials for this call — the app may not be installed on the company. — ' + raw;
  }
  if (/is not in Procore/i.test(raw) || /No commitment/i.test(raw)) {
    return raw; // already written for a person by procoreFindVendorByName_/procoreFindCommitmentForInvoice_
  }
  return raw;
}

/**
 * Appends one row to the Procore Send Log — the audit trail for what was actually sent (see file
 * header). Returns the sheet row number it wrote to, so sendInvoiceToProcore can flip just the
 * 'Attached' cell in place afterward instead of appending a second, near-duplicate row.
 *
 * `entry.outcome` defaults to 'Sent' so every pre-existing caller keeps its meaning unchanged; the
 * failure/refusal paths pass their own (see procoreLogSendAttempt_).
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
    'Record Type': entry.recordType,
    'Procore Project ID': entry.projectId,
    'Procore Project Name': entry.projectName,
    'Commitment ID': entry.commitmentId || '',
    'Commitment Number': entry.commitmentNumber || '',
    'Procore Record ID': entry.requisitionId,
    'Attached': entry.attached ? 'Yes' : 'No',
    'Environment': entry.environment,
    'Outcome': entry.outcome || PROCORE_OUTCOME_SENT_,
    'Detail': entry.detail || ''
  };
  sheet.appendRow(header.map(col => (filled[col] !== undefined ? filled[col] : '')));
  const lastRow = sheet.getLastRow();
  ['Row ID', 'Invoice Number', 'Procore Project ID', 'Commitment ID', 'Procore Record ID'].forEach(col => {
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
 * THE REAL SEND. Creates a Procore record for one invoice — either a Subcontractor Invoice
 * (`requisitions`, against the commitment the Procore Commitment Map already has confirmed for this
 * row's vendor+project) or a Direct Cost (`direct_costs`, matched by vendor+project only, no
 * commitment needed) — attaches the invoice PDF and logs it to the Procore Send Log.
 *
 * Deliberately does NOT touch the Invoice Log Status — that used to happen here automatically, but
 * Ahmed, 2026-08-21 wanted the two treated as separate confirmations: the dashboard now asks
 * "mark as In Procore?" after showing the send result (see markProcoreSentInvoices below), so a send
 * whose PDF attach failed, or that a coordinator wants to double check in Procore first, doesn't get
 * silently marked done. Callers that want the old bundled behavior should call
 * markProcoreSentInvoices([rowId]) themselves right after a successful, non-alreadySent send.
 *
 * Which kind depends entirely on `kind`; nothing here infers or defaults based on whether a commitment
 * happens to exist. Ahmed, 2026-08-20: real invoices split across both — some bill against a
 * commitment, some don't have one and should go in as a Direct Cost instead, per invoice, chosen by
 * whoever is sending. `kind: 'invoice'` REQUIRES a confirmed commitment match already exist
 * (matchInvoiceToProcoreCommitment or confirmProcoreCommitmentPick must have run first — this function
 * does NOT match a commitment on the fly, so an invoice send can never silently pick one nobody
 * confirmed); `kind: 'direct_cost'` resolves project + vendor live on every call (both cheap, no
 * "pick one" ambiguity to persist the way a commitment has), no prior matching step required.
 *
 * Create -> log -> attach, in that order (HANDOFF.md §4's design point): the ledger row is written
 * immediately after a successful create, before the attach is even attempted, so a mid-run failure
 * still leaves a findable record of what was created in Procore — a duplicate create on retry is the
 * recoverable failure mode; a created-but-unlogged record is not.
 *
 * @param {string} rowId
 * @param {string} [kind] - 'invoice' (default, Subcontractor Invoice against a commitment) or
 *   'direct_cost' (Direct Cost, vendor-matched only).
 * @return {{ok: true, requisitionId: number, attached: boolean, message: string,
 *           alreadySent: (boolean|undefined)}
 *          | {ok: false, message: string}}
 */
function sendInvoiceToProcore(rowId, kind) {
  kind = (kind === 'direct_cost') ? 'direct_cost' : 'invoice';
  const recordTypeLabel = kind === 'invoice' ? 'Subcontractor Invoice' : 'Direct Cost';

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
  if (existing && procoreConfirmExistingSendStillExists_(existing)) {
    return {
      ok: true,
      alreadySent: true,
      requisitionId: existing.requisitionId,
      attached: existing.attached,
      message: `Already sent — ${existing.recordType || 'a record'} ${existing.requisitionId} was created ${existing.timestamp} (${procoreEnv_()}). Not creating a second one.`
    };
  }
  // existing was found in our log but Procore no longer has it (deleted directly in Procore, e.g.
  // tearing down test data) — fall through and create a fresh record. The stale log row stays as a
  // historical record; this send appends its own new row, so the trail shows both.

  const matchProjectNumber = procoreProjectMatchKey_(invoice.projectNumber, invoice.subprojectNumber);

  let created, projectId, projectName, commitmentId = '', commitmentNumber = '';
  if (kind === 'invoice') {
    const match = procoreLoadCommitmentMap_()[procoreCommitmentMapKey_(invoice.vendor, matchProjectNumber)];
    if (!match) {
      throw new Error(`No confirmed Procore commitment for "${invoice.vendor}" on project ${matchProjectNumber} yet — match it first ("Send to Procore…"), or send this one as a Direct Cost instead.`);
    }
    const billingDate = invoice.invoiceDate
      ? Utilities.formatDate(new Date(invoice.invoiceDate), CONFIG_TIMEZONE_(), 'yyyy-MM-dd')
      : Utilities.formatDate(new Date(), CONFIG_TIMEZONE_(), 'yyyy-MM-dd');
    created = procoreCreateSubcontractorInvoice_(match.projectId, match.commitmentId, invoice.invoiceNumber, billingDate);
    projectId = match.projectId;
    projectName = match.projectName;
    commitmentId = match.commitmentId;
    commitmentNumber = match.commitmentNumber;
  } else {
    const projectResult = procoreFindProjectByNumber_(matchProjectNumber);
    if (!projectResult.matched) throw new Error(projectResult.reason);
    const vendorResult = procoreFindVendorByName_(projectResult.projectId, invoice.vendor);
    if (!vendorResult.matched) throw new Error(vendorResult.reason);
    created = procoreCreateDirectCost_(projectResult.projectId, vendorResult.vendorId, invoice.invoiceNumber);
    projectId = projectResult.projectId;
    projectName = projectResult.projectName;
  }
  const recordId = kind === 'invoice' ? created.requisitionId : created.directCostId;

  // Ledger row written NOW, before the attach is even attempted — see the function doc comment.
  const logRow = procoreLogSendRow_({
    rowId: invoice.rowId,
    invoiceNumber: invoice.invoiceNumber,
    vendor: invoice.vendor,
    amount: invoice.amount,
    currency: invoice.currency,
    recordType: recordTypeLabel,
    projectId: projectId,
    projectName: projectName,
    commitmentId: commitmentId,
    commitmentNumber: commitmentNumber,
    requisitionId: recordId,
    attached: false,
    environment: procoreEnv_()
  });

  let attached = false;
  let attachError = '';
  if (invoice.fileId) {
    try {
      const blob = DriveApp.getFileById(invoice.fileId).getBlob();
      if (kind === 'invoice') {
        const uuid = procoreUploadFile_(projectId, blob);
        procoreAttachFileToRequisition_(projectId, recordId, uuid);
      } else {
        procoreAttachFileToDirectCost_(projectId, recordId, blob);
      }
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

  const commitmentClause = kind === 'invoice' ? ` against commitment ${commitmentNumber}` : '';
  if (!attached) {
    return {
      ok: true,
      requisitionId: recordId,
      attached: false,
      message: `Created ${recordTypeLabel} ${recordId} in Procore project ${projectId}${commitmentClause}, but the PDF didn't attach: ${attachError || 'no Drive file found on this row'}. The record exists in Procore — attach the PDF by hand, then mark this row In Procore.`
    };
  }

  return {
    ok: true,
    requisitionId: recordId,
    attached: true,
    message: `Sent — ${recordTypeLabel} ${recordId} created in Procore project ${projectId}${commitmentClause}, PDF attached.`
  };
}

/**
 * The second confirmation (see sendInvoiceToProcore's doc comment): flips the Invoice Log Status to
 * STORED_PROCESSED_STATUS for a batch of rows the dashboard just sent to Procore, once a coordinator
 * says yes. Always routes through updateInvoiceRow — the single write path (CLAUDE.md) — never types
 * the literal 'Captured' here.
 *
 * Deliberately its own function rather than reusing markInvoicesProcessed (DashboardServer.gs): that
 * one gates on CAPTURABLE = {'Filed':1,'Needs Review':1} because it backs the download-zip "mark as
 * captured" checkbox, where only those two statuses make sense to bump. A row sent to Procore can
 * legitimately already be Paid (Nexus sync ran first, or it's a re-send after a rejected/corrected
 * Procore record) and should still be markable "In Procore" — this function doesn't filter by prior
 * status at all, it just does what the coordinator just confirmed.
 *
 * One row failing (e.g. it was deleted between send and confirm) doesn't stop the rest — collected
 * into `errors` instead, same no-silent-partial-failure shape as the other bulk endpoints here.
 *
 * @param {Array<string>} rowIds
 * @return {{ok: true, updated: Array<{rowId: string, row: Object}>, errors: Array<{rowId: string, message: string}>}}
 */
function markProcoreSentInvoices(rowIds) {
  if (!canControlAutomation_()) {
    throw new Error('You are not allowed to update invoice status. Ask the automation owner to add your email to DASHBOARD_CONTROL_EMAILS in Config.gs.');
  }
  const updated = [];
  const errors = [];
  (rowIds || []).forEach(rowId => {
    try {
      const row = updateInvoiceRow(rowId, { status: STORED_PROCESSED_STATUS });
      updated.push({ rowId: rowId, row: row });
    } catch (e) {
      errors.push({ rowId: rowId, message: e.message });
    }
  });
  return { ok: true, updated: updated, errors: errors };
}

// --- Bulk send (multi-select bar) -------------------------------------------------------------

// Real network calls per row (match/list, create, upload, attach) unlike downloadInvoicesZip's cheap
// per-file base64 reads. The dashboard sends one at a time (see sendProcoreInvoiceItem below) so there
// is no per-call execution-time budget to manage anymore, but a batch this size is still a lot of real
// Procore calls to fire from one review window — kept as a sanity cap on the client, checked before the
// send loop even starts, same shape as DOWNLOAD_MAX_FILES. A future need to send more than this at once
// should build a resumable design rather than raise this number blind.
const PROCORE_SEND_BULK_MAX_ = 25;

/**
 * One row of the bulk "Send to Procore" flow — called ONCE PER INVOICE, sequentially, by the
 * dashboard's client-side send loop (Dashboard.html), not as one big server call. That split is what
 * lets the UI show live per-item progress ("Sending 3 of 12…") and stay a non-blocking side panel
 * instead of the single frozen `sendInvoicesToProcoreBulk` call this replaced: a dashboard round trip
 * can update the DOM between calls, a single multi-minute server call cannot.
 *
 * Mirrors what the single-invoice flow does across two steps (match, then send) but folded into one
 * call for the bulk reviewer, which doesn't have a picker UI mid-batch: for `kind: 'invoice'`, resolves
 * a commitment via matchInvoiceToProcoreCommitment (cached instantly if this vendor+project pair was
 * ever confirmed before, live otherwise) and only actually sends when that resolves WITHOUT asking a
 * human — an ambiguous vendor (more than one commitment) is never auto-picked here, same "let user
 * pick" rule as the single-invoice flow; it just means picking it happens later from that invoice's own
 * preview panel instead of blocking the rest of the batch. For `kind: 'direct_cost'`: no commitment
 * matching step at all — sendInvoiceToProcore resolves project + vendor live and sends directly.
 * sendInvoiceToProcore's own idempotency guard (procoreFindExistingSend_) makes re-selecting an
 * already-sent row a safe no-op, not a duplicate, regardless of which kind either send used.
 *
 * Never throws for an expected/skippable outcome — everything is folded into `outcome` so the client's
 * classification logic has one shape to switch on, the same categories `sendInvoicesToProcoreBulk` used
 * to bucket a whole batch into: 'sent', 'alreadySent', 'needsMatch', 'skipped', 'error'.
 *
 * @param {string} rowId
 * @param {string} kind - 'invoice' (default if omitted) or 'direct_cost'.
 * @return {{outcome: string, rowId: string, invoiceNumber: (string|undefined), vendor: (string|undefined),
 *           kind: (string|undefined), requisitionId: (number|string|undefined), attached: (boolean|undefined),
 *           message: (string|undefined), ambiguous: (boolean|undefined), reason: (string|undefined)}}
 */
function sendProcoreInvoiceItem(rowId, kind) {
  kind = (kind === 'direct_cost') ? 'direct_cost' : 'invoice';
  if (!canControlAutomation_()) {
    throw new Error('You are not allowed to send invoices to Procore. Ask the automation owner to add your email to DASHBOARD_CONTROL_EMAILS in Config.gs.');
  }
  if (!procoreConfigured_()) {
    throw new Error('Procore is not configured — set the Script Properties and run setupProcore() first.');
  }

  let invoice;
  try {
    invoice = procoreLoadInvoiceRowForMatch_(rowId);
  } catch (e) {
    // No invoice context to log against beyond the Row ID itself — still worth a trail row.
    return procoreFailedItem_({ rowId: rowId }, kind, e.message);
  }
  if (!invoice.vendor) {
    return procoreFailedItem_(invoice, kind, 'No Vendor on this row.');
  }

  if (kind === 'invoice') {
    let matchResult;
    try {
      matchResult = matchInvoiceToProcoreCommitment(rowId);
    } catch (e) {
      return procoreFailedItem_(invoice, kind, e.message);
    }
    if (!matchResult.ok) {
      procoreLogSendAttempt_(invoice, kind, PROCORE_OUTCOME_NEEDS_MATCH_, matchResult.reason);
      return {
        outcome: 'needsMatch',
        rowId: rowId,
        invoiceNumber: invoice.invoiceNumber,
        vendor: invoice.vendor,
        ambiguous: !!matchResult.ambiguous,
        reason: matchResult.reason
      };
    }
  }

  try {
    const sendResult = sendInvoiceToProcore(rowId, kind);
    return {
      outcome: sendResult.alreadySent ? 'alreadySent' : 'sent',
      rowId: rowId,
      invoiceNumber: invoice.invoiceNumber,
      vendor: invoice.vendor,
      kind: kind,
      requisitionId: sendResult.requisitionId,
      attached: sendResult.attached,
      message: sendResult.message
    };
  } catch (e) {
    // The status guards inside sendInvoiceToProcore (Duplicate / Not an Invoice) throw — read them
    // back out as a skip rather than an error, since they're an expected outcome of a filtered
    // selection containing rows that were never eligible, not a failure.
    if (/Duplicate/.test(e.message) || /Not an Invoice/.test(e.message)) {
      procoreLogSendAttempt_(invoice, kind, PROCORE_OUTCOME_SKIPPED_, e.message);
      return { outcome: 'skipped', rowId: rowId, invoiceNumber: invoice.invoiceNumber, vendor: invoice.vendor, reason: e.message };
    }
    return procoreFailedItem_(invoice, kind, e.message);
  }
}

/**
 * Records a non-successful attempt in the Procore Send Log and returns the client's `error` shape,
 * with the message run through procoreHumanizeSendError_ first.
 *
 * Why failures are logged at all: before this, a failed or refused send existed ONLY in the dashboard
 * panel that reported it — close the panel and there was no record that the attempt ever happened, so
 * "did anyone try to send this?" and "why did it not go?" were unanswerable a day later. Successes had
 * a durable trail; failures did not, which is backwards — the failures are the ones somebody has to
 * come back to.
 */
function procoreFailedItem_(invoice, kind, rawMessage) {
  const message = procoreHumanizeSendError_(rawMessage);
  procoreLogSendAttempt_(invoice, kind, PROCORE_OUTCOME_FAILED_, message);
  return {
    outcome: 'error',
    rowId: invoice.rowId,
    invoiceNumber: invoice.invoiceNumber,
    vendor: invoice.vendor,
    message: message
  };
}

/**
 * Appends a non-Sent Procore Send Log row (Failed / Needs Match / Skipped). Best-effort by design:
 * a sheet write that fails here must never turn a reported outcome into an exception the coordinator
 * sees instead of the real reason — same reasoning as logNexusSyncRows_ being best-effort.
 */
function procoreLogSendAttempt_(invoice, kind, outcome, detail) {
  try {
    procoreLogSendRow_({
      rowId: invoice.rowId || '',
      invoiceNumber: invoice.invoiceNumber || '',
      vendor: invoice.vendor || '',
      amount: '',
      currency: '',
      recordType: kind === 'direct_cost' ? 'Direct Cost' : 'Subcontractor Invoice',
      projectId: '',
      projectName: '',
      commitmentId: '',
      commitmentNumber: '',
      requisitionId: '',
      attached: false,
      environment: procoreEnv_(),
      outcome: outcome,
      detail: detail || ''
    });
  } catch (e) {
    Logger.log(`Could not write a "${outcome}" Procore Send Log row for ${invoice.rowId}: ${e.message}`);
  }
}
