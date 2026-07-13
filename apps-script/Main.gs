/**
 * Main.gs
 * Entry point the time-driven trigger calls. See SETUP.md for how to wire up the trigger.
 */

function processInvoices() {
  if (isAutomationPaused_()) {
    Logger.log('Automation is paused (dashboard Pause button). Skipping this run — press Start on the dashboard to resume.');
    return;
  }

  const referenceRows = getReferenceData_();
  const aliasRows = getAliasData_();
  let threads = getUnprocessedThreads_();

  Logger.log(`Found ${threads.length} unprocessed thread(s) under label "${CONFIG.GMAIL_LABEL}"` +
    (CONFIG.LOOKBACK_DAYS ? ` (limited to the last ${CONFIG.LOOKBACK_DAYS} days)` : '') + '.');

  if (CONFIG.MAX_THREADS_PER_RUN !== null && threads.length > CONFIG.MAX_THREADS_PER_RUN) {
    Logger.log(`Limiting this run to ${CONFIG.MAX_THREADS_PER_RUN} thread(s) (MAX_THREADS_PER_RUN). The rest will be picked up on the next run.`);
    threads = threads.slice(0, CONFIG.MAX_THREADS_PER_RUN);
  }

  threads.forEach(thread => {
    const threadLink = getThreadLink_(thread);
    const attachments = getPdfAttachments_(thread);

    if (attachments.length === 0) {
      // No PDF on this thread — mark processed so it's not rechecked every run, but flag it for a human.
      logError_('No PDF attachment found', 'Thread matched the billing label but had no PDF attachment.', threadLink);
      markThreadProcessed_(thread);
      return;
    }

    attachments.forEach(({ blob }) => {
      try {
        processOneInvoice_(blob, referenceRows, aliasRows, threadLink);
      } catch (err) {
        logError_('processOneInvoice_ failed', err.message, threadLink);
      }
      // Free-tier Gemini API keys cap at 5 requests/minute — space calls out to avoid
      // burning through the quota in one burst (on top of the retry logic in fetchWithRetry_).
      Utilities.sleep(13000);
    });

    markThreadProcessed_(thread);
  });
}

function processOneInvoice_(pdfBlob, referenceRows, aliasRows, threadLink) {
  const extracted = extractAndMatchInvoice_(pdfBlob, referenceRows, aliasRows);
  const passesRuleCheck = validateMatch_(extracted, referenceRows);
  const isHighConfidence = extracted.confidence >= CONFIG.CONFIDENCE_THRESHOLD;
  const overDollarThreshold = CONFIG.DOLLAR_THRESHOLD_FOR_REVIEW !== null && extracted.amount > CONFIG.DOLLAR_THRESHOLD_FOR_REVIEW;

  const shouldAutoFile = extracted.is_invoice && passesRuleCheck && isHighConfidence && !overDollarThreshold;

  const matchedRef = findReferenceMatch_(referenceRows, extracted.project_number, extracted.subproject_number);

  const fileName = buildInvoiceFileName_(extracted);
  let driveLink = '';
  let status = extracted.is_invoice ? 'Needs Review' : 'Not an Invoice';

  if (matchedRef && matchedRef.driveFolderId) {
    if (shouldAutoFile) {
      const monthFolderId = getMonthSubfolderId_(matchedRef.driveFolderId, extracted.invoice_date);
      driveLink = fileInvoiceToDrive_(pdfBlob, monthFolderId, fileName);
      status = 'Filed';
    } else {
      // Known project, but not confidently an invoice (statement, low-confidence match, over the
      // dollar threshold, etc.) — file into that project's "Statements & Others" subfolder rather
      // than leaving it unfiled, so it's never lost, only sitting one folder deeper awaiting review.
      const reviewFolder = getOrCreateNamedSubfolder_(matchedRef.driveFolderId, CONFIG.STATEMENTS_SUBFOLDER_NAME);
      driveLink = fileInvoiceToDrive_(pdfBlob, reviewFolder.getId(), fileName);
    }
  } else {
    // No project match at all (or no archive folder on file yet for the matched project) — still
    // capture it somewhere findable instead of relying solely on the Gmail Link.
    const unmatchedFolder = getOrCreateNamedSubfolder_(INVOICE_ARCHIVE_PARENT_FOLDER_ID, CONFIG.UNMATCHED_SUBFOLDER_NAME);
    driveLink = fileInvoiceToDrive_(pdfBlob, unmatchedFolder.getId(), fileName);
  }

  logInvoiceRow_({
    'Date Processed': new Date(),
    'Invoice Date': extracted.invoice_date || '',
    'Due Date': extracted.due_date || '',
    'Vendor': extracted.vendor_name || '',
    'Project Number': extracted.project_number || '',
    'Project Name': matchedRef ? matchedRef.projectName : '',
    'Subproject Number': extracted.subproject_number || '',
    'Subproject Name': matchedRef ? matchedRef.subprojectName : '',
    'Amount': extracted.amount || '',
    'Currency': extracted.currency || '',
    'Status': status,
    'Confidence': extracted.confidence,
    'Drive Link': driveLink,
    'Gmail Link': threadLink,
    'Match Note': extracted.match_reasoning || ''
  });
}
