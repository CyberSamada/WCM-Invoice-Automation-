/**
 * GmailService.gs
 * Finds unprocessed invoice threads and pulls PDF attachments off them.
 * Assumes this script is bound to / running under wcmmail@westdellcorp.com,
 * where billing@wcmcon.com mail lands under the CONFIG.GMAIL_LABEL label.
 */

/** Returns GmailThread objects under the billing label that haven't been marked processed yet. */
function getUnprocessedThreads_() {
  let query = `label:${CONFIG.GMAIL_LABEL} -label:${CONFIG.PROCESSED_LABEL}`;
  if (CONFIG.LOOKBACK_DAYS) {
    query += ` newer_than:${CONFIG.LOOKBACK_DAYS}d`;
  }
  return GmailApp.search(query);
}

/** Returns all PDF attachments (as Blobs) across every message in a thread. */
function getPdfAttachments_(thread) {
  const attachments = [];
  thread.getMessages().forEach(message => {
    message.getAttachments({ includeInlineImages: false }).forEach(attachment => {
      if (attachment.getContentType() === 'application/pdf') {
        attachments.push({ blob: attachment.copyBlob(), message: message });
      }
    });
  });
  return attachments;
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
