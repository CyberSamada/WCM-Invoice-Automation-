/**
 * DriveService.gs
 * Files a PDF into the matched project/subproject's Drive folder, using the folder's ID
 * directly (from the "Project Reference" sheet's Drive Folder ID column) rather than
 * searching by name — see plan doc Section 5 for why (duplicate folder names exist).
 */

/**
 * @param {GoogleAppsScript.Base.Blob} pdfBlob
 * @param {string} folderId
 * @param {string} fileName
 * @return {string} URL of the newly created file
 */
function fileInvoiceToDrive_(pdfBlob, folderId, fileName) {
  if (!folderId) {
    throw new Error('No Drive Folder ID provided for this project/subproject — check the "Project Reference" sheet.');
  }
  const folder = DriveApp.getFolderById(folderId); // throws if the ID is invalid or inaccessible
  if (folder.isTrashed()) {
    // getFolderById() resolves a trashed folder without throwing, so without this check a deleted
    // archive folder would silently keep accepting files — they'd just be invisible in Trash. Fail
    // loudly instead so it shows up in the Errors tab rather than vanishing invoices.
    throw new Error(`Drive Folder ID "${folderId}" points to a folder that has been deleted (in Trash). Run createInvoiceArchiveFolders() to provision a replacement.`);
  }
  const file = folder.createFile(pdfBlob).setName(fileName);
  return file.getUrl();
}

/**
 * Gets or creates a subfolder with the given name directly under parentFolderId (one level, not
 * recursive). Used to place non-auto-filed documents (statements, low-confidence matches, etc.)
 * into a predictable subfolder instead of leaving them unfiled — see Main.gs/processOneInvoice_.
 */
function getOrCreateNamedSubfolder_(parentFolderId, name) {
  const parent = DriveApp.getFolderById(parentFolderId); // resolves a trashed folder without throwing
  if (parent.isTrashed()) {
    // Without this check, a trashed parent would silently accept a new subfolder created inside it —
    // invisible in normal Drive navigation until the parent is restored. Fail loudly instead (caught
    // by the caller's try/catch, surfaces in the Errors tab) — matches fileInvoiceToDrive_'s same check.
    throw new Error(`Drive Folder ID "${parentFolderId}" points to a folder that has been deleted (in Trash). Run createInvoiceArchiveFolders() to provision a replacement.`);
  }
  const existing = parent.getFoldersByName(name);
  if (existing.hasNext()) {
    return existing.next();
  }
  return parent.createFolder(name);
}

/**
 * Gets or creates a "YYYY-MM" month subfolder under the project folder, derived from the PROCESSED
 * date (the same date the filename carries), so filed invoices are grouped by the month they were
 * handled. Returns the parent folder itself when CONFIG.FILE_BY_MONTH is off.
 */
function getMonthSubfolderId_(projectFolderId, monthDate) {
  if (!CONFIG.FILE_BY_MONTH) return projectFolderId;
  return getOrCreateNamedSubfolder_(projectFolderId, monthFolderKey_(monthDate)).getId();
}

/**
 * The "YYYY-MM" folder name for an invoice, based on its PROCESSED date - the same date the filename
 * uses ("YYMMDD - ..."), so the filename and folder always agree, and a batch processed in one month
 * consolidates into that month's folder. Accepts a Date or a "YYYY-MM-DD" string; a Date is formatted
 * in the script timezone, a string is read directly (no timezone shift). Falls back to the current
 * month if neither is usable.
 */
function monthFolderKey_(monthDate) {
  if (monthDate instanceof Date && !isNaN(monthDate.getTime())) {
    return Utilities.formatDate(monthDate, CONFIG_TIMEZONE_(), 'yyyy-MM');
  }
  const m = /^\s*(\d{4})-(\d{2})/.exec(String(monthDate || ''));
  if (m) return `${m[1]}-${m[2]}`;
  return Utilities.formatDate(new Date(), CONFIG_TIMEZONE_(), 'yyyy-MM');
}

/**
 * The BASE folder an invoice belongs under, before status is considered:
 *   - subproject assigned  -> that subproject's own folder (created with the standard
 *                             "<number> - <name>" naming if it isn't provisioned yet)
 *   - no subproject        -> a "No Subprojects" folder directly under the project folder
 *   - no project folder resolvable at all -> '' (caller falls back to _Unmatched)
 * Never an arbitrary sibling subproject's folder — that was the old "weird spot" bug.
 */
function resolveBaseFolderId_(matchedRef) {
  if (!matchedRef) return '';
  if (matchedRef.exactSubproject && matchedRef.subprojectNumber) {
    if (matchedRef.subprojectFolderId) return matchedRef.subprojectFolderId;
    if (matchedRef.projectFolderId) {
      return getOrCreateNamedSubfolder_(matchedRef.projectFolderId,
        `${matchedRef.subprojectNumber} - ${matchedRef.subprojectName}`).getId();
    }
    return '';
  }
  if (matchedRef.projectFolderId) {
    return getOrCreateNamedSubfolder_(matchedRef.projectFolderId, CONFIG.NO_SUBPROJECT_FOLDER_NAME).getId();
  }
  return '';
}

/**
 * Resolves the Drive folder a matched invoice should live in — the single source of truth shared by
 * automatic filing (Main.gs), the dashboard's manual override (DashboardServer.gs), and the refile
 * reconciler (Refile.gs), so the paths can never disagree. Statuses are strictly SEPARATED under the
 * base folder (subproject, or "No Subprojects" under the project):
 *   Filed           -> <base>/YYYY-MM        (processed month — matches the filename's date)
 *   Not an Invoice  -> <base>/Statements & Others
 *   anything else   -> <base>/Needs Review   (awaiting human review; never mixed with statements)
 * No project match at all falls back to the top-level "_Unmatched" folder.
 */
function resolveInvoiceDestinationFolderId_(matchedRef, status, monthDate) {
  const baseId = resolveBaseFolderId_(matchedRef);
  if (!baseId) {
    return getOrCreateNamedSubfolder_(INVOICE_ARCHIVE_PARENT_FOLDER_ID, CONFIG.UNMATCHED_SUBFOLDER_NAME).getId();
  }
  if (status === 'Filed') return getMonthSubfolderId_(baseId, monthDate);
  if (status === 'Not an Invoice') return getOrCreateNamedSubfolder_(baseId, CONFIG.STATEMENTS_SUBFOLDER_NAME).getId();
  return getOrCreateNamedSubfolder_(baseId, CONFIG.NEEDS_REVIEW_SUBFOLDER_NAME).getId();
}

/**
 * Builds the standardized filename: "YYMMDD - InvoiceNumber - Vendor.pdf" — e.g. an invoice
 * processed on 2026-07-15 becomes "260715 - 5205HB - JNF Concrete Ltd.pdf". The date is the
 * PROCESSED date (when the automation handled it, i.e. now), not the invoice's printed date.
 * extracted.vendor_name is expected to already be the canonical name (see
 * SheetService.gs/canonicalizeVendorName_, applied in Main.gs before this is called) so filenames
 * use one consistent spelling per vendor.
 */
function buildInvoiceFileName_(extracted) {
  const datePart = Utilities.formatDate(new Date(), CONFIG_TIMEZONE_(), 'yyMMdd');
  const safeInvoiceNumber = sanitizeForFileName_(extracted.invoice_number || 'NoInvoiceNumber');
  const safeVendor = sanitizeForFileName_(extracted.vendor_name || 'UnknownVendor');
  return `${datePart} - ${safeInvoiceNumber} - ${safeVendor}.pdf`;
}

/**
 * Rebuilds an invoice's standardized filename when its invoice number is corrected on the dashboard —
 * same "YYMMDD - InvoiceNumber - Vendor.pdf" format as buildInvoiceFileName_, but from already-logged
 * fields and using the row's ORIGINAL Date Processed (not now), so only the number changes.
 */
function buildRenamedInvoiceFileName_(dateProcessed, invoiceNumber, vendor) {
  const d = (dateProcessed instanceof Date && !isNaN(dateProcessed.getTime())) ? dateProcessed : new Date(dateProcessed);
  const datePart = !isNaN(d.getTime())
    ? Utilities.formatDate(d, CONFIG_TIMEZONE_(), 'yyMMdd')
    : Utilities.formatDate(new Date(), CONFIG_TIMEZONE_(), 'yyMMdd');
  const safeInvoiceNumber = sanitizeForFileName_(String(invoiceNumber || 'NoInvoiceNumber'));
  const safeVendor = sanitizeForFileName_(String(vendor || 'UnknownVendor'));
  return `${datePart} - ${safeInvoiceNumber} - ${safeVendor}.pdf`;
}

/** Strips characters Drive/most filesystems reject in names, and collapses whitespace. */
function sanitizeForFileName_(value) {
  return String(value).replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim();
}

function CONFIG_TIMEZONE_() {
  return Session.getScriptTimeZone();
}
