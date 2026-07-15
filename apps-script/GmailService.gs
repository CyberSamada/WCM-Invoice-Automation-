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
 * Builds the "newer_than:"/"before:" portion of a Gmail search query from CONFIG.LOOKBACK_DAYS and
 * CONFIG.PROCESS_UNTIL_DATE — shared by the real run (above) and testRun() (Test.gs) so both
 * respect the same date window instead of drifting apart. PROCESS_UNTIL_DATE is inclusive of the
 * date itself; Gmail's before: operator is exclusive, so this searches "before" the following day
 * to compensate.
 */
function dateRangeQuerySuffix_() {
  let suffix = '';
  if (CONFIG.LOOKBACK_DAYS) {
    suffix += ` newer_than:${CONFIG.LOOKBACK_DAYS}d`;
  }
  if (CONFIG.PROCESS_UNTIL_DATE) {
    const cutoff = parseYmdDate_(CONFIG.PROCESS_UNTIL_DATE);
    if (cutoff) {
      const dayAfter = new Date(cutoff.getFullYear(), cutoff.getMonth(), cutoff.getDate() + 1);
      const y = dayAfter.getFullYear();
      const m = String(dayAfter.getMonth() + 1).padStart(2, '0');
      const d = String(dayAfter.getDate()).padStart(2, '0');
      suffix += ` before:${y}/${m}/${d}`;
    }
  }
  return suffix;
}

/**
 * Returns all PDF attachments (as Blobs) across every message in a thread.
 *
 * Matches by content type OR a ".pdf" filename, not content type alone — some senders' mail
 * systems attach real PDFs under a generic type like "application/octet-stream" instead of
 * "application/pdf" (this is what silently dropped valid PDFs before: they showed up as a normal
 * attachment in Gmail, but the strict content-type check never counted them, logging a false "no
 * PDF attachment" error). The extension check catches that without accepting non-PDF files.
 */
function getPdfAttachments_(thread) {
  const attachments = [];
  thread.getMessages().forEach(message => {
    message.getAttachments({ includeInlineImages: false }).forEach(attachment => {
      const isPdfType = attachment.getContentType() === 'application/pdf';
      const isPdfName = /\.pdf$/i.test(attachment.getName() || '');
      if (isPdfType || isPdfName) {
        attachments.push({ blob: attachment.copyBlob(), message: message });
      }
    });
  });
  return attachments;
}

/**
 * Describes every attachment actually found on a thread (name + content type), for the "no PDF
 * attachment" error message — so a genuine miss (an attachment Gmail shows but this code didn't
 * recognize) is immediately diagnosable from the Errors tab instead of requiring a guess.
 */
function describeThreadAttachments_(thread) {
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
