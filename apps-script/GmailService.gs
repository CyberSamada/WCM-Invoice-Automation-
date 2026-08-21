/**
 * GmailService.gs
 * Finds unprocessed invoice threads and pulls PDF attachments off them.
 * Assumes this script is bound to / running under wcmmail@westdellcorp.com,
 * where billing@wcmcon.com mail lands under the CONFIG.GMAIL_LABEL label.
 */

/** Returns GmailThread objects under the billing label that haven't been marked processed yet. */
function getUnprocessedThreads_() {
  return GmailApp.search(`label:${CONFIG.GMAIL_LABEL} -label:${CONFIG.PROCESSED_LABEL}` + dateRangeQuerySuffix_());
}

/**
 * Builds the "newer_than:"/"after:" portion of a Gmail search query from CONFIG.LOOKBACK_DAYS and
 * CONFIG.PROCESS_FROM_DATE — shared by the real run (above) and testRun() (Test.gs) so both
 * respect the same date window instead of drifting apart.
 *
 * NOTE: an earlier version of this implemented the cutoff in the WRONG DIRECTION (a PROCESS_UNTIL
 * upper bound via before:, processing everything back to 2025 and older) — the intended behavior
 * was always "ignore the old backlog, only process mail from the fresh-start date onward". Gmail's
 * after: operator means "from 00:00 of that date", so the configured date itself is included.
 */
function dateRangeQuerySuffix_() {
  let suffix = '';
  if (CONFIG.LOOKBACK_DAYS) {
    suffix += ` newer_than:${CONFIG.LOOKBACK_DAYS}d`;
  }
  if (CONFIG.PROCESS_FROM_DATE) {
    const from = parseYmdDate_(CONFIG.PROCESS_FROM_DATE);
    if (from) {
      const y = from.getFullYear();
      const m = String(from.getMonth() + 1).padStart(2, '0');
      const d = String(from.getDate()).padStart(2, '0');
      suffix += ` after:${y}/${m}/${d}`;
    }
  }
  return suffix;
}

/** The PROCESS_FROM_DATE cutoff as a Date (local midnight, inclusive), or null when not set. */
function processFromDate_() {
  return CONFIG.PROCESS_FROM_DATE ? parseYmdDate_(CONFIG.PROCESS_FROM_DATE) : null;
}

/**
 * Runs `fn` against a thread and puts its read/unread state back exactly as it was.
 *
 * **Why this exists.** Reading a thread's messages through GmailApp marks the thread READ. That is a
 * side effect of looking, not of deciding anything, and it destroys information the owner of the
 * mailbox relies on: unread means "I have not dealt with this yet". Ahmed asked, 2026-08-21, that
 * nothing here ever touch his read state.
 *
 * The test path already knew this and guarded against it — `testRun()` (Test.gs) captures `wasUnread`
 * and restores it in a `finally`, and SETUP.md promises "Read/unread status is restored
 * automatically". The REAL path never did. So every invoice thread `processInvoices()` looked at was
 * silently marked read, and only the safe-looking test run cleaned up after itself. That asymmetry is
 * the bug.
 *
 * Fixing it here rather than in Main.gs means every caller is covered — the real run, the test run,
 * and anything added later — instead of one loop remembering and the next one forgetting.
 */
function withReadStateRestored_(thread, fn) {
  const wasUnread = thread.isUnread();
  try {
    return fn();
  } finally {
    // Only ever restore TOWARDS unread. If the thread was already read, leave it alone rather than
    // calling markRead(), so this can never be the thing that marks something read.
    if (wasUnread && !thread.isUnread()) thread.markUnread();
  }
}

/** True if an attachment is a PDF — by content type OR a ".pdf" filename (see getPdfAttachments_). */
function isPdfAttachment_(attachment) {
  return attachment.getContentType() === 'application/pdf' || /\.pdf$/i.test(attachment.getName() || '');
}

/**
 * Returns PDF attachments (as Blobs) across a thread's messages — but ONLY from messages dated on or
 * after CONFIG.PROCESS_FROM_DATE.
 *
 * The per-MESSAGE date check matters because the start-date cutoff is applied in the Gmail search via
 * `after:` (see dateRangeQuerySuffix_), and Gmail's `after:` matches a whole THREAD if ANY message in
 * it is recent. So a months-old invoice whose thread just got a follow-up reply ("when will this be
 * paid?") resurfaces in the search, and without this check its original, pre-cutoff PDF would be
 * pulled off the old message and filed as if new. Filtering per message means only genuinely new
 * invoices are processed; old attachments on resurfaced threads are left alone.
 *
 * Matches by content type OR a ".pdf" filename, not content type alone — some senders' mail systems
 * attach real PDFs under a generic type like "application/octet-stream" instead of "application/pdf"
 * (this silently dropped valid PDFs before). The extension check catches that without accepting
 * non-PDF files.
 */
function getPdfAttachments_(thread) {
  return withReadStateRestored_(thread, () => getPdfAttachmentsInner_(thread));
}

function getPdfAttachmentsInner_(thread) {
  const attachments = [];
  const fromDate = processFromDate_();
  thread.getMessages().forEach(message => {
    if (fromDate && message.getDate() < fromDate) return; // skip messages before the start-date cutoff
    message.getAttachments({ includeInlineImages: false }).forEach(attachment => {
      if (isPdfAttachment_(attachment)) {
        attachments.push({ blob: attachment.copyBlob(), message: message });
      }
    });
  });
  return attachments;
}

/** True if the thread has ANY PDF attachment at all, ignoring the date cutoff — lets the caller tell
 *  a genuine "no PDF on this thread" miss from a thread whose only PDF(s) predate PROCESS_FROM_DATE. */
function threadHasAnyPdf_(thread) {
  return withReadStateRestored_(thread, () => threadHasAnyPdfInner_(thread));
}

function threadHasAnyPdfInner_(thread) {
  let found = false;
  thread.getMessages().forEach(message => {
    message.getAttachments({ includeInlineImages: false }).forEach(attachment => {
      if (isPdfAttachment_(attachment)) found = true;
    });
  });
  return found;
}

/**
 * Describes every attachment actually found on a thread (name + content type), for the "no PDF
 * attachment" error message — so a genuine miss (an attachment Gmail shows but this code didn't
 * recognize) is immediately diagnosable from the Errors tab instead of requiring a guess.
 */
function describeThreadAttachments_(thread) {
  return withReadStateRestored_(thread, () => describeThreadAttachmentsInner_(thread));
}

function describeThreadAttachmentsInner_(thread) {
  const found = [];
  thread.getMessages().forEach(message => {
    message.getAttachments({ includeInlineImages: false }).forEach(attachment => {
      found.push(`"${attachment.getName()}" (${attachment.getContentType()})`);
    });
  });
  return found.length ? `Attachments found on this thread: ${found.join(', ')}.` : 'No attachments of any kind found on this thread.';
}

/** Labels a thread as processed so the next run skips it. Creates the label the first time it's needed. */
function markThreadProcessed_(thread) {
  const label = GmailApp.getUserLabelByName(CONFIG.PROCESSED_LABEL) || GmailApp.createLabel(CONFIG.PROCESSED_LABEL);
  thread.addLabel(label);
}

/** Builds a stable link back to the Gmail thread, for logging. */
function getThreadLink_(thread) {
  return `https://mail.google.com/mail/u/0/#all/${thread.getId()}`;
}
