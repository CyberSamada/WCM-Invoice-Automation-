/**
 * Test.gs
 * Safe, non-destructive test run against real invoice emails.
 *
 * - Runs the real Gemini extraction + matching, so you get a genuine accuracy signal.
 * - NEVER touches real project folders — test file copies go to CONFIG.TEST_FOLDER_ID instead,
 *   organized exactly like the real Invoice Archive would be: a subfolder per matched project (e.g.
 *   "54 - WHITE OAKS MALL") with high-confidence invoices at its root and anything else (statements,
 *   low-confidence matches, non-invoices) inside that project's "Statements & Others" subfolder.
 *   Anything with no project match at all goes into a top-level "_Unmatched" subfolder. This mirrors
 *   processOneInvoice_() in Main.gs exactly, so a test run is a true preview of where things would
 *   land for real — zero risk of a test file landing in a real, shared folder. A "Would File To" link
 *   on each row also shows the real archive folder it corresponds to.
 * - Applies CONFIG.TEST_LABEL, not CONFIG.PROCESSED_LABEL — tested threads stay fully available
 *   to the real processInvoices() run afterward. Nothing needs to be undone.
 * - Restores each thread's original read/unread state when done, as a safety net.
 *
 * One-time setup: create a Drive folder for test output, paste its ID into CONFIG.TEST_FOLDER_ID
 * (Config.gs). Then just run testRun() from the function dropdown whenever you want to test.
 */

function testRun() {
  if (!CONFIG.TEST_FOLDER_ID) {
    throw new Error('Set CONFIG.TEST_FOLDER_ID in Config.gs first — create a Drive folder for test output and paste its ID in.');
  }

  const referenceRows = getReferenceData_();
  const aliasRows = getAliasData_();
  // Excludes threads already handled for real, AND threads already covered by a previous test run.
  // Shares dateRangeQuerySuffix_ (GmailService.gs) with the real run so both respect the same
  // LOOKBACK_DAYS/PROCESS_UNTIL_DATE window instead of drifting apart.
  const query = `label:${CONFIG.GMAIL_LABEL} -label:${CONFIG.PROCESSED_LABEL} -label:${CONFIG.TEST_LABEL}` + dateRangeQuerySuffix_();
  let threads = GmailApp.search(query);

  Logger.log(`Found ${threads.length} untested thread(s) under label "${CONFIG.GMAIL_LABEL}". Testing up to ${CONFIG.TEST_MAX_THREADS}.`);
  threads = threads.slice(0, CONFIG.TEST_MAX_THREADS);

  // Same defensive time budget as processInvoicesInner_ (Main.gs) and for the same reason: Apps
  // Script kills a run outright at its ~6-minute hard limit, and markTestLabel_() only runs after a
  // thread's every attachment finishes — a run killed mid-thread would leave it unlabeled and get
  // the exact same thread retested from scratch next time. See Main.gs for the full explanation.
  const startTime = Date.now();
  const MAX_RUN_MS = 2.5 * 60 * 1000;
  let deferredCount = 0;

  for (let t = 0; t < threads.length; t++) {
    if (Date.now() - startTime > MAX_RUN_MS) {
      deferredCount = threads.length - t;
      break;
    }

    const thread = threads[t];
    const wasUnread = thread.isUnread();
    const threadLink = getThreadLink_(thread);
    let timedOutMidThread = false;

    try {
      const attachments = getPdfAttachments_(thread);

      if (attachments.length === 0) {
        logTestRow_({ 'Vendor': '(no PDF)', 'Status': 'Test-Error', 'Note': describeThreadAttachments_(thread), 'Gmail Link': threadLink });
      } else {
        for (let a = 0; a < attachments.length; a++) {
          if (Date.now() - startTime > MAX_RUN_MS) {
            timedOutMidThread = true;
            deferredCount = threads.length - t;
            break;
          }
          const { blob, message } = attachments[a];
          testOneInvoice_(blob, message.getDate(), referenceRows, aliasRows, threadLink);
          // Pace calls per CONFIG.GEMINI_PACING_MS (free tier = 5/min). See Config.gs.
          if (CONFIG.GEMINI_PACING_MS > 0) Utilities.sleep(CONFIG.GEMINI_PACING_MS);
        }
      }

      if (!timedOutMidThread) markTestLabel_(thread);
    } catch (err) {
      logTestRow_({ 'Vendor': '(error)', 'Status': 'Test-Error', 'Note': err.message, 'Gmail Link': threadLink });
    } finally {
      // Restore original read state no matter what happened above.
      if (wasUnread) { thread.markUnread(); } else { thread.markRead(); }
    }

    if (timedOutMidThread) break;
  }

  if (deferredCount > 0) {
    Logger.log(`Stopped early to stay safely under Apps Script's execution time limit — ${deferredCount} thread(s) deferred to the next test run.`);
  }

  Logger.log('Test run complete — check the "Test Log" tab. Nothing here touched the real Invoice Log or any real project folder.');
}

function testOneInvoice_(pdfBlob, emailDate, referenceRows, aliasRows, threadLink) {
  const extracted = extractAndMatchInvoice_(pdfBlob, referenceRows, aliasRows, emailDate);
  const passesRuleCheck = validateMatch_(extracted, referenceRows);
  const isHighConfidence = extracted.confidence >= CONFIG.CONFIDENCE_THRESHOLD;
  const dueSoon = dueDateCramsPayPeriod_(extracted.due_date, emailDate);

  const matchedRef = findReferenceMatch_(referenceRows, extracted.project_number, extracted.subproject_number);

  const wouldFileLink = (matchedRef && matchedRef.driveFolderId)
    ? `https://drive.google.com/drive/folders/${matchedRef.driveFolderId}`
    : '(no Drive Folder ID on file for this project/subproject yet)';

  const wouldAutoFile = extracted.is_invoice && passesRuleCheck && isHighConfidence && !dueSoon && matchedRef && !!matchedRef.driveFolderId;

  // Mirrors the real "<project> / <subproject>" nesting so a test run previews the real archive
  // structure — see DriveSetup.gs/createInvoiceArchiveFolders and getOrCreateTestProjectFolder_.
  const testFileName = `TEST_${buildInvoiceFileName_(extracted)}`;
  let testDestFolder;
  if (matchedRef) {
    const testProjectFolder = getOrCreateTestProjectFolder_(matchedRef.projectNumber, matchedRef.projectName);
    const testMatchFolder = matchedRef.exactSubproject
      ? getOrCreateNamedSubfolder_(testProjectFolder.getId(), `${matchedRef.subprojectNumber} - ${matchedRef.subprojectName}`)
      : testProjectFolder;
    const testMonthFolderId = getMonthSubfolderId_(testMatchFolder.getId(), new Date()); // processed date, matching Main.gs
    testDestFolder = wouldAutoFile
      ? DriveApp.getFolderById(testMonthFolderId)
      : getOrCreateNamedSubfolder_(testMonthFolderId, CONFIG.STATEMENTS_SUBFOLDER_NAME);
  } else {
    testDestFolder = getOrCreateNamedSubfolder_(CONFIG.TEST_FOLDER_ID, CONFIG.UNMATCHED_SUBFOLDER_NAME);
  }
  const testFileLink = fileInvoiceToDrive_(pdfBlob, testDestFolder.getId(), testFileName);

  let statusText;
  let note = '';
  if (!extracted.is_invoice) {
    statusText = 'Test-Not an Invoice';
    note = notInvoiceNote_(extracted.document_type) + ' (extracted fields are best-guess only.)';
  } else if (wouldAutoFile) {
    statusText = 'Test-OK (would auto-file)';
  } else {
    statusText = 'Test-Needs Review';
  }
  if (dueSoon) {
    note = (note ? note + ' ' : '') + `Due date is within ${CONFIG.DUE_SOON_DAYS} days of arrival — crams the pay period.`;
  }
  if (matchedRef && !matchedRef.exactSubproject && extracted.subproject_number) {
    note = (note ? note + ' ' : '') +
      `Subproject "${extracted.subproject_number}" isn't listed under project ${matchedRef.projectNumber} — matched at the project level instead.`;
  }
  if (!matchedRef && extracted.match_reasoning) {
    // Gemini declined to pick a project (project_number came back "UNKNOWN") — surface its
    // reasoning/best-guess here so a human can review quickly instead of just seeing "no match".
    note = (note ? note + ' ' : '') + `Gemini's notes: ${extracted.match_reasoning}`;
  }

  logTestRow_({
    'Date Tested': new Date(),
    'Invoice Date': extracted.invoice_date || '',
    'Invoice Number': extracted.invoice_number || '',
    'Due Date': extracted.due_date || '',
    'Vendor': extracted.vendor_name || '',
    'Matched Project Number': extracted.project_number || '',
    'Matched Project Name': matchedRef ? matchedRef.projectName : '(no match found)',
    'Matched Subproject Number': extracted.subproject_number || '',
    'Matched Subproject Name': matchedRef ? matchedRef.subprojectName : '',
    'Amount': extracted.amount || '',
    'Currency': extracted.currency || '',
    'Confidence': extracted.confidence,
    'Rule Check Passed': passesRuleCheck,
    'Would File To': wouldFileLink,
    'Test File Copy': testFileLink,
    'Status': statusText,
    'Note': note,
    'Gmail Link': threadLink
  });
}

/**
 * Gets or creates a subfolder under CONFIG.TEST_FOLDER_ID matching the same naming convention as
 * the real Invoice Archive ("<project number> - <project name>"), so the test folder mirrors the
 * real structure and can be browsed the same way.
 */
function getOrCreateTestProjectFolder_(projectNumber, projectName) {
  return getOrCreateNamedSubfolder_(CONFIG.TEST_FOLDER_ID, `${projectNumber} - ${projectName}`);
}

/** Applies the test label, creating it the first time it's needed. Distinct from PROCESSED_LABEL on purpose. */
function markTestLabel_(thread) {
  const label = GmailApp.getUserLabelByName(CONFIG.TEST_LABEL) || GmailApp.createLabel(CONFIG.TEST_LABEL);
  thread.addLabel(label);
}

/** Appends one row to the Test Log tab (separate from the real Invoice Log — see SheetService.gs for getOrCreateSheet_). */
function logTestRow_(data) {
  const sheet = getOrCreateSheet_(CONFIG.TEST_LOG_TAB, CONFIG.TEST_LOG_COLUMNS);
  // Header-based lookup, not positional array order — see SheetService.gs/buildRowByHeader_ for why.
  sheet.appendRow(buildRowByHeader_(sheet, data));
}
