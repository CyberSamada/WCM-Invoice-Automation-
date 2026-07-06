/**
 * Main.gs
 * Entry point the time-driven trigger calls. See SETUP.md for how to wire up the trigger.
 */

function processInvoices() {
  const referenceRows = getReferenceData_();
  const threads = getUnprocessedThreads_();

  Logger.log(`Found ${threads.length} unprocessed thread(s) under label "${CONFIG.GMAIL_LABEL}".`);

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
    });

    markThreadProcessed_(thread);
  });
}

function processOneInvoice_(pdfBlob, referenceRows, threadLink) {
  const extracted = extractAndMatchInvoice_(pdfBlob, referenceRows);
  const passesRuleCheck = validateMatch_(extracted, referenceRows);
  const isHighConfidence = extracted.confidence >= CONFIG.CONFIDENCE_THRESHOLD;
  const overDollarThreshold = CONFIG.DOLLAR_THRESHOLD_FOR_REVIEW !== null && extracted.amount > CONFIG.DOLLAR_THRESHOLD_FOR_REVIEW;

  const shouldAutoFile = passesRuleCheck && isHighConfidence && !overDollarThreshold;

  const matchedRef = referenceRows.find(r =>
    r.projectNumber === extracted.project_number &&
    (r.subprojectNumber || '') === (extracted.subproject_number || '')
  );

  let driveLink = '';
  let status = 'Needs Review';

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
