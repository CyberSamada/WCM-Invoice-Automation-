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
  // Per-vendor correction history, read ONCE per run from the Override Log — cheap, and lets each
  // invoice consult only its own vendor's history after extraction (no prompt bloat). See
  // SheetService.gs/buildVendorMemory_ and the memory check in processOneInvoice_.
  const vendorMemory = buildVendorMemory_();
  // Identity keys of every invoice already logged — so we never file/log the same bill twice, no
  // matter how it's seen again (a stale trigger reprocessing, the same PDF attached twice in a
  // thread, a vendor re-sending). Read once here; processOneInvoice_ adds to it as it logs so
  // within-run repeats are caught too. See SheetService.gs/invoiceIdentityKey_.
  const seenInvoiceKeys = buildInvoiceKeySet_();
  let threads = getUnprocessedThreads_();

  Logger.log(`Found ${threads.length} unprocessed thread(s) under label "${CONFIG.GMAIL_LABEL}"` +
    (CONFIG.LOOKBACK_DAYS ? ` (limited to the last ${CONFIG.LOOKBACK_DAYS} days)` : '') + '.');

  if (CONFIG.MAX_THREADS_PER_RUN !== null && threads.length > CONFIG.MAX_THREADS_PER_RUN) {
    Logger.log(`Limiting this run to ${CONFIG.MAX_THREADS_PER_RUN} thread(s) (MAX_THREADS_PER_RUN). The rest will be picked up on the next run.`);
    threads = threads.slice(0, CONFIG.MAX_THREADS_PER_RUN);
  }

  // Apps Script kills a trigger execution outright at its ~6-minute hard limit — a forced stop, not
  // a catchable exception. markThreadProcessed_() only ever runs AFTER a thread's every attachment
  // finishes, so a run killed mid-thread never labels that thread at all: the next trigger run picks
  // the EXACT SAME thread back up via getUnprocessedThreads_() and reprocesses it from scratch,
  // forever, since it can never finish in time. This produced runaway duplicate rows against very
  // few actually-labeled threads. Fix: never START a new unit of work (thread or attachment) once
  // we're this deep into the run's budget — bail out cleanly first, leaving remaining work correctly
  // UNLABELED for next run, instead of risking getting killed mid-flight. The 2.5-minute budget is
  // conservative on purpose: a single attachment's worst case (13s sleep + up to 150s of Gemini
  // retry backoff) is ~3 minutes, so this leaves real margin under the 6-minute ceiling even if one
  // last call goes the distance right after the check passes.
  const startTime = Date.now();
  const MAX_RUN_MS = 2.5 * 60 * 1000;
  let deferredCount = 0;

  for (let t = 0; t < threads.length; t++) {
    if (Date.now() - startTime > MAX_RUN_MS) {
      deferredCount = threads.length - t;
      break;
    }

    const thread = threads[t];
    const threadLink = getThreadLink_(thread);
    const attachments = getPdfAttachments_(thread);

    if (attachments.length === 0) {
      // No PDF on this thread — mark processed so it's not rechecked every run, but flag it for a
      // human, with a diagnostic of what was actually found so a real miss is self-explanatory
      // instead of needing a guess (see GmailService.gs/describeThreadAttachments_).
      logError_('No PDF attachment found', describeThreadAttachments_(thread), threadLink);
      markThreadProcessed_(thread);
      continue;
    }

    let timedOutMidThread = false;
    let threadHadTransientFailure = false;
    let dailyQuotaExhausted = false;
    for (let a = 0; a < attachments.length; a++) {
      if (Date.now() - startTime > MAX_RUN_MS) {
        timedOutMidThread = true;
        deferredCount = threads.length - t; // this thread (incomplete) and everything after it
        break;
      }
      const { blob, message } = attachments[a];
      try {
        processOneInvoice_(blob, message.getDate(), referenceRows, aliasRows, threadLink, vendorMemory, seenInvoiceKeys);
      } catch (err) {
        logError_('processOneInvoice_ failed', err.message, threadLink);
        // A rate-limit/overload failure (429/503) means THIS attachment never got extracted — the
        // thread must stay unlabeled so it's genuinely retried later, not skipped forever. Only a
        // non-transient error (bad PDF, etc.) still lets the thread be marked processed below,
        // since retrying those every run would just repeat the same failure.
        if (isTransientApiError_(err)) threadHadTransientFailure = true;
        if (isDailyQuotaError_(err)) { dailyQuotaExhausted = true; break; }
      }
      // Pace calls to respect the Gemini free tier's 5 requests/minute limit. Tunable via
      // CONFIG.GEMINI_PACING_MS — drop it once billing is enabled (see Config.gs) for more throughput.
      if (CONFIG.GEMINI_PACING_MS > 0) Utilities.sleep(CONFIG.GEMINI_PACING_MS);
    }

    if (timedOutMidThread) break; // leave this thread unlabeled — its completed attachments will
                                   // simply be reprocessed next run; better than losing the rest of
                                   // the batch to an unpredictable mid-flight kill.
    if (!threadHadTransientFailure) markThreadProcessed_(thread);

    if (dailyQuotaExhausted) {
      // Every further Gemini call today will fail the same way — stop burning execution time and
      // let everything left (including this thread) get picked up after the daily quota resets.
      Logger.log('Gemini daily quota exhausted — stopping this run. Remaining threads stay unprocessed and will be retried by later runs (quota resets daily).');
      break;
    }
  }

  if (deferredCount > 0) {
    Logger.log(`Stopped early to stay safely under Apps Script's execution time limit — ${deferredCount} thread(s) deferred to the next run.`);
  }
}

/** True for Gemini failures worth retrying on a later run (rate limit / temporary overload). */
function isTransientApiError_(err) {
  return /Gemini API returned (429|503)/.test(String(err && err.message || ''));
}

/** True specifically for the free tier's DAILY request cap ("…PerDay…" quota violation) — not per-minute. */
function isDailyQuotaError_(err) {
  const msg = String(err && err.message || '');
  return msg.indexOf('429') !== -1 && msg.indexOf('PerDay') !== -1;
}

function processOneInvoice_(pdfBlob, emailDate, referenceRows, aliasRows, threadLink, vendorMemory, seenInvoiceKeys) {
  const extracted = extractAndMatchInvoice_(pdfBlob, referenceRows, aliasRows, emailDate);
  // Standardize the vendor spelling to one canonical form (see SheetService.gs) before it's used
  // for the filename and the log, so the same company doesn't accrue multiple spellings — while
  // distinct divisions (J-AAR Civil vs J-AAR Structure) stay separate. Mutating extracted here
  // means both buildInvoiceFileName_ and logInvoiceRow_ below pick up the canonical name.
  extracted.vendor_name = canonicalizeVendorName_(extracted.vendor_name);

  // Duplicate guard: if this exact invoice (vendor + invoice number, or vendor + amount + date when
  // there's no number) is already in the log, DON'T file or log a second copy. Instead log a single
  // lightweight "Duplicate" row so a coordinator can see it was received again — pointing at where
  // the original is already filed in Drive. Capped at one notice per invoice (entry.noticed), so a
  // re-sending vendor or a misbehaving trigger can't spam duplicate rows.
  const idKey = seenInvoiceKeys
    ? invoiceIdentityKey_(extracted.vendor_name, extracted.invoice_number, extracted.amount, extracted.invoice_date)
    : '';
  if (idKey && seenInvoiceKeys[idKey]) {
    const entry = seenInvoiceKeys[idKey];
    if (!entry.noticed) {
      logDuplicateRow_(extracted, emailDate, entry, threadLink);
      entry.noticed = true;
    }
    return; // never double-file
  }

  let matchedRef = findReferenceMatch_(referenceRows, extracted.project_number, extracted.subproject_number);

  // Vendor memory: consult THIS invoice's vendor history only (no prompt bloat), applied after
  // extraction. Fires only for a vendor with a consistent past correction record, and only ever
  // routes to human review — never silently auto-files a guess. See applyVendorMemory_.
  const memoryNote = applyVendorMemory_(extracted, matchedRef, referenceRows, vendorMemory, ref => { matchedRef = ref; });

  const passesRuleCheck = validateMatch_(extracted, referenceRows);
  const isHighConfidence = extracted.confidence >= CONFIG.CONFIDENCE_THRESHOLD;
  const overDollarThreshold = CONFIG.DOLLAR_THRESHOLD_FOR_REVIEW !== null && extracted.amount > CONFIG.DOLLAR_THRESHOLD_FOR_REVIEW;
  const dueSoon = dueDateCramsPayPeriod_(extracted.due_date, emailDate);
  const daysPastDue = daysPastDue_(extracted.due_date);
  const pastDue = daysPastDue !== null && daysPastDue > 0;

  const shouldAutoFile = extracted.is_invoice && passesRuleCheck && isHighConfidence && !overDollarThreshold && !dueSoon && !pastDue && !memoryNote;

  const isFileable = matchedRef && matchedRef.driveFolderId;

  const fileName = buildInvoiceFileName_(extracted);
  let status = extracted.is_invoice ? 'Needs Review' : 'Not an Invoice';
  // Genuinely overdue (due date already passed as of TODAY, not just tight when the email arrived)
  // takes priority over ordinary auto-filing — this always needs a human's attention, regardless of
  // confidence. Only "Filed" when we're both confident enough to auto-file AND the matched project
  // actually has an archive folder on record — a matched-but-unprovisioned project still needs a
  // human, same as the original behavior (it lands in _Unmatched below via resolveInvoiceDestinationFolderId_).
  // A memoryNote (vendor-history rescue or conflict) always forces review — never auto-file on memory.
  if (extracted.is_invoice && pastDue && isFileable) status = 'Past Due';
  else if (shouldAutoFile && isFileable) status = 'Filed';

  // Known project but not confidently an invoice (statement, low-confidence match, over the dollar
  // threshold, past due, etc.) still gets filed — into that project's "Statements & Others" subfolder
  // (or "Past Due", for overdue ones) rather than left unfiled, so it's never lost, only sitting one
  // folder deeper awaiting review. No project match at all falls back to the top-level "_Unmatched"
  // folder. See DriveService.gs/resolveInvoiceDestinationFolderId_ — the same resolver the
  // dashboard's manual override uses, so automatic and manual filing can never disagree about where
  // something belongs.
  const destFolderId = resolveInvoiceDestinationFolderId_(matchedRef, status, extracted.invoice_date);
  const driveLink = fileInvoiceToDrive_(pdfBlob, destFolderId, fileName);

  logInvoiceRow_({
    'Date Processed': new Date(),
    'Date Received': emailDate instanceof Date && !isNaN(emailDate.getTime()) ? emailDate : '', // actual email arrival date — distinct from Date Processed (when the trigger got around to it) and Invoice Date (the date printed on the PDF)
    'Invoice Date': extracted.invoice_date || '',
    'Invoice Number': extracted.invoice_number || '',
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
    'Review Note': appendNote_(buildReviewNote_(status, extracted, { passesRuleCheck, isHighConfidence, overDollarThreshold, dueSoon, daysPastDue }), memoryNote)
  });

  // Register this now-filed invoice so a later copy (this run or a future one) is recognized as a
  // duplicate and pointed back at THIS file rather than filed again.
  if (idKey && seenInvoiceKeys) {
    seenInvoiceKeys[idKey] = { noticed: false, driveLink: driveLink, driveFileId: driveFileIdFromUrl_(driveLink) };
  }
}

/** Joins two note strings with a separator, dropping empties — for stacking a memory note onto a review note. */
function appendNote_(base, extra) {
  return [base, extra].filter(n => n).join(' ');
}

/**
 * Logs a single "Duplicate" row for an invoice we've already filed — so a coordinator sees it was
 * received again, without creating a second Drive copy. The row points (Drive Link + File ID) at
 * the ORIGINAL filed file, so the dashboard's preview / "Open in Drive" show where it already lives.
 */
function logDuplicateRow_(extracted, emailDate, originalEntry, threadLink) {
  const receivedStr = (emailDate instanceof Date && !isNaN(emailDate.getTime()))
    ? Utilities.formatDate(emailDate, CONFIG_TIMEZONE_(), 'yyyy-MM-dd') : '';
  logInvoiceRow_({
    'Date Processed': new Date(),
    'Date Received': (emailDate instanceof Date && !isNaN(emailDate.getTime())) ? emailDate : '',
    'Invoice Date': extracted.invoice_date || '',
    'Invoice Number': extracted.invoice_number || '',
    'Due Date': extracted.due_date || '',
    'Vendor': extracted.vendor_name || '',
    'Amount': extracted.amount || '',
    'Currency': extracted.currency || '',
    'Status': 'Duplicate',
    'Confidence': extracted.confidence,
    'Drive Link': originalEntry.driveLink || '',   // points at the ORIGINAL filed copy, not a new file
    'Drive File ID': originalEntry.driveFileId || '',
    'Gmail Link': threadLink,
    'Review Note': `Received again${receivedStr ? ' on ' + receivedStr : ''} — already filed previously; not re-filed. The file link points to the original copy in Drive.`
  });
}

/**
 * Applies a vendor's past-correction history to the CURRENT invoice, if and only if that specific
 * vendor has a consistent record (see buildVendorMemory_). Two conservative actions, both routing
 * to human review — memory NEVER silently auto-files:
 *   - Rescue: the extraction couldn't confidently match a project, but this vendor was repeatedly
 *     corrected to one — adopt it (for a human to confirm) so the invoice isn't left unmatched.
 *   - Conflict: the extraction matched a project that contradicts this vendor's strong history —
 *     keep the match but flag it so a human checks which is right.
 * Returns a note string to attach to the row (and whose mere presence forces review), or '' when
 * memory doesn't apply. onMatch(ref) lets the caller swap in the rescued reference match.
 *
 * @param {function(Object):void} onMatch - called with the new matchedRef in the rescue case only.
 * @return {string} note, or '' if nothing applied.
 */
function applyVendorMemory_(extracted, matchedRef, referenceRows, vendorMemory, onMatch) {
  if (!extracted.is_invoice) return ''; // don't second-guess non-invoices with vendor history
  if (!vendorMemory) return '';
  const mem = vendorMemory[vendorNormalizedKey_(extracted.vendor_name)];
  if (!mem || !mem.dominantProject) return '';

  const memMatch = findReferenceMatch_(referenceRows, mem.dominantProject, '');
  if (!memMatch) return ''; // the historical project isn't in the reference sheet anymore — ignore

  const times = mem.dominantCount;
  if (!matchedRef) {
    // Rescue: extraction gave no confident project; adopt the vendor's historical one for review.
    extracted.project_number = mem.dominantProject;
    extracted.subproject_number = '';
    onMatch(memMatch);
    return `Vendor memory: no confident project match, but ${times} past correction(s) filed "${extracted.vendor_name}" to project ${mem.dominantProject} — applied for review, please confirm.`;
  }
  if (normalizeNumberKey_(matchedRef.projectNumber) !== normalizeNumberKey_(mem.dominantProject)) {
    // Conflict: matched somewhere that disagrees with a strong history — keep it, flag it.
    return `Vendor memory conflict: matched to project ${matchedRef.projectNumber}, but ${times} past correction(s) filed "${extracted.vendor_name}" to project ${mem.dominantProject} — please confirm which is right.`;
  }
  return ''; // agrees with history — nothing to flag
}

/**
 * Days the due date has already passed as of TODAY (not relative to when the email arrived — see
 * dueDateCramsPayPeriod_ for that, a different, softer check). Returns null when there's no usable
 * due date or the date is today/in the future (i.e. not actually overdue).
 */
function daysPastDue_(dueDateStr) {
  const due = parseYmdDate_(dueDateStr);
  if (!due) return null;
  const today = new Date();
  const todayMidnight = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const days = Math.round((todayMidnight.getTime() - due.getTime()) / 86400000);
  return days > 0 ? days : null;
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

/**
 * One short line explaining WHY a document was classified as not-an-invoice, based on Gemini's
 * document_type — shared by Main.gs (Review Note) and Test.gs (test preview note) so a human sees
 * exactly what kind of document was found instead of a generic "not an invoice" for every case.
 */
function notInvoiceNote_(documentType) {
  if (documentType === 'purchase_order') {
    return 'Recognized as a Purchase Order / Agreement, not an invoice requesting payment — sets terms/authorizes future billing rather than billing for it now.';
  }
  if (documentType === 'statement') {
    return 'Recognized as an account statement summarizing multiple transactions, not a single invoice.';
  }
  return 'Not recognized as an invoice or bill.';
}

/** One short line explaining why an item wasn't auto-filed, for the "Review Note" column. '' when Filed. */
function buildReviewNote_(status, extracted, flags) {
  if (status === 'Filed') return '';
  if (!extracted.is_invoice) return notInvoiceNote_(extracted.document_type);
  if (status === 'Past Due') {
    return `Past due: due date passed ${flags.daysPastDue} day${flags.daysPastDue === 1 ? '' : 's'} ago — needs urgent review/payment.`;
  }
  const reasons = [];
  if (!flags.passesRuleCheck) reasons.push('no matching project found');
  else if (!flags.isHighConfidence) reasons.push(`low match confidence (${Math.round((Number(extracted.confidence) || 0) * 100)}%)`);
  if (flags.dueSoon) reasons.push(`due date is within ${CONFIG.DUE_SOON_DAYS} days of arrival, which crams the pay period`);
  if (flags.overDollarThreshold) reasons.push('amount is over the review threshold');
  if (!reasons.length) return 'Flagged for manual review.';
  return 'Needs review: ' + reasons.join('; ') + '.';
}
