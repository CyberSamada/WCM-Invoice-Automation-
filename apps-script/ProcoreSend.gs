/**
 * ProcoreSend.gs
 * Workflow layer for the Procore send feature — which Invoice Log row goes with which Procore
 * record, called from the dashboard. A structural analogue of NexusSync.gs, referenced by name in
 * ProcoreClient.gs's own header comment since before this file existed. ProcoreClient.gs stays a pure
 * REST client with no SpreadsheetApp; this file is what reads the sheet and turns a Row ID into
 * something ProcoreClient.gs's matchers can use.
 *
 * Only the matching step exists here so far (see matchInvoiceToProcoreCommitment). The real send
 * (creating a Subcontractor Invoice / requisition in Procore, writing the send log, flipping Status)
 * is PR 3 in HANDOFF.md and is NOT built yet — this file does not write anywhere, in the Invoice Log
 * or in Procore.
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
 * Dashboard entry point for the invoice-to-commitment matcher. Given a Row ID, resolves the Procore
 * project from the row's own WCM Project Number, then the commitment from its Vendor — exactly the
 * chain in procoreFindCommitmentForInvoiceRow_ (ProcoreClient.gs). Per Ahmed, 2026-08-20: "if there
 * is multiple commitments, let user pick, if only 1, assign directly" — that's the `autoMatched` vs.
 * `candidates` split below, not a decision this function makes itself; it's just reporting how many
 * candidates the matcher actually found.
 *
 * READ-ONLY. Does not write to the Invoice Log, does not create anything in Procore — this is
 * strictly the matching step (see file header). Gated the same as the Procore smoke test
 * (testProcoreSendDirectCost, Setup.gs): canControlAutomation_ + procoreConfigured_.
 *
 * @param {string} rowId
 * @return {{ok: true, autoMatched: true, projectId: number, projectName: string, commitmentId: number,
 *            commitmentTitle: string, commitmentNumber: string, commitmentKind: string,
 *            vendorName: string, vendor: string, projectNumber: (string|number), invoiceNumber: string}
 *          | {ok: false, stage: 'project'|'commitment', ambiguous: boolean, candidates: (Array|null),
 *             reason: string, vendor: string, projectNumber: (string|number), invoiceNumber: string}}
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
      vendor: invoice.vendor,
      projectNumber: invoice.projectNumber,
      invoiceNumber: invoice.invoiceNumber
    };
  }

  return {
    ok: true,
    autoMatched: true,
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
