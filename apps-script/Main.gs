/**
 * Main.gs
 * Entry point the time-driven trigger calls. See SETUP.md for how to wire up the trigger.
 */

function processInvoices() {
  if (isAutomationPaused_()) {
    Logger.log('Automation is paused (dashboard Pause button). Skipping this run — press Start on the dashboard to resume.');
    return;
  }

  // Prevent overlapping runs. Time-driven triggers can fire again before a slow run finishes; two
  // runs at once would race to process (and label) the same threads, filing invoices and writing
  // log rows twice, and could each create a duplicate month folder. tryLock(0) means: if another
  // run already holds the lock, skip this one immediately — its threads get picked up next tick.
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(0)) {
    Logger.log('Another processInvoices run is already in progress — skipping this run to avoid double-processing.');
    return;
  }
  try {
    processInvoicesInner_();
  } finally {
    lock.releaseLock();
  }
}

function processInvoicesInner_() {
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

    attachments.forEach(({ blob, message }) => {
      try {
        processOneInvoice_(blob, message.getDate(), referenceRows, aliasRows, threadLink);
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

function processOneInvoice_(pdfBlob, emailDate, referenceRows, aliasRows, threadLink) {
  const extracted = extractAndMatchInvoice_(pdfBlob, referenceRows, aliasRows);
  const passesRuleCheck = validateMatch_(extracted, referenceRows);
  const isHighConfidence = extracted.confidence >= CONFIG.CONFIDENCE_THRESHOLD;
  const overDollarThreshold = CONFIG.DOLLAR_THRESHOLD_FOR_REVIEW !== null && extracted.amount > CONFIG.DOLLAR_THRESHOLD_FOR_REVIEW;
  const dueSoon = dueDateCramsPayPeriod_(extracted.due_date, emailDate);

  const shouldAutoFile = extracted.is_invoice && passesRuleCheck && isHighConfidence && !overDollarThreshold && !dueSoon;

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
    'Match Note': extracted.match_reasoning || '',
    'Review Note': buildReviewNote_(status, extracted, { passesRuleCheck, isHighConfidence, overDollarThreshold, dueSoon })
  });
}

/**
 * True when the invoice's due date leaves too little time to pay — i.e. it falls on or within
 * CONFIG.DUE_SOON_DAYS days of when the email arrived (a due date already in the past counts too).
 * A due date comfortably in the future gives us room and is fine. Returns false whenever the due
 * date is missing/unparseable or the check is disabled (DUE_SOON_DAYS = null), so nothing is
 * flagged just for lacking a due date.
 */
function dueDateCramsPayPeriod_(dueDateStr, emailDate) {
  if (CONFIG.DUE_SOON_DAYS == null) return false;
  const due = parseYmdDate_(dueDateStr);
  if (!due || !(emailDate instanceof Date) || isNaN(emailDate.getTime())) return false;
  const emailDay = new Date(emailDate.getFullYear(), emailDate.getMonth(), emailDate.getDate());
  const daysUntilDue = Math.round((due.getTime() - emailDay.getTime()) / 86400000);
  return daysUntilDue <= CONFIG.DUE_SOON_DAYS;
}

/** Parses a "YYYY-MM-DD" (or other Date-parseable) string to a local midnight Date, or null. */
function parseYmdDate_(s) {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s).trim());
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** One short line explaining why an item wasn't auto-filed, for the "Review Note" column. '' when Filed. */
function buildReviewNote_(status, extracted, flags) {
  if (status === 'Filed') return '';
  if (!extracted.is_invoice) return 'Not recognized as an invoice or bill.';
  const reasons = [];
  if (!flags.passesRuleCheck) reasons.push('no matching project found');
  else if (!flags.isHighConfidence) reasons.push(`low match confidence (${Math.round((Number(extracted.confidence) || 0) * 100)}%)`);
  if (flags.dueSoon) reasons.push(`due date is within ${CONFIG.DUE_SOON_DAYS} days of arrival, which crams the pay period`);
  if (flags.overDollarThreshold) reasons.push('amount is over the review threshold');
  if (!reasons.length) return 'Flagged for manual review.';
  return 'Needs review: ' + reasons.join('; ') + '.';
}
