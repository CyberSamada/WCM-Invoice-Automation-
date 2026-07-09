/**
 * Main.gs
 * Entry point the time-driven trigger calls. See SETUP.md for how to wire up the trigger.
 */

function processInvoices() {
  const referenceRows = getReferenceData_();
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
        processOneInvoice_(blob, referenceRows, threadLink);
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

function processOneInvoice_(pdfBlob, referenceRows, threadLink) {
  const extracted = extractAndMatchInvoice_(pdfBlob, referenceRows);
  const passesRuleCheck = validateMatch_(extracted, referenceRows);
  const isHighConfidence = extracted.confidence >= CONFIG.CONFIDENCE_THRESHOLD;
  const overDollarThreshold = CONFIG.DOLLAR_THRESHOLD_FOR_REVIEW !== null && extracted.amount > CONFIG.DOLLAR_THRESHOLD_FOR_REVIEW;

  const shouldAutoFile = extracted.is_invoice && passesRuleCheck && isHighConfidence && !overDollarThreshold;

  const matchedRef = referenceRows.find(r =>
    r.projectNumber === extracted.project_number &&
    (r.subprojectNumber || '') === (extracted.subproject_number || '')
  );

  let driveLink = '';
  let status = extracted.is_invoice ? 'Needs Review' : 'Not an Invoice';

  if (shouldAutoFile && matchedRef) {
    const fileName = buildInvoiceFileName_(extracted);
    driveLink = fileInvoiceToDrive_(pdfBlob, matchedRef.driveFolderId, fileName);
    status = 'Filed';
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
    'Gmail Link': threadLink
  });
}
