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
  const parent = DriveApp.getFolderById(parentFolderId);
  const existing = parent.getFoldersByName(name);
  if (existing.hasNext()) {
    return existing.next();
  }
  return parent.createFolder(name);
}

/**
 * Gets or creates a "YYYY-MM" month subfolder under the project folder, derived from the invoice
 * date, so filed invoices are grouped by month under the project name folder. Returns the parent
 * folder itself when CONFIG.FILE_BY_MONTH is off.
 */
function getMonthSubfolderId_(projectFolderId, invoiceDate) {
  if (!CONFIG.FILE_BY_MONTH) return projectFolderId;
  return getOrCreateNamedSubfolder_(projectFolderId, invoiceMonthKey_(invoiceDate)).getId();
}

/**
 * The "YYYY-MM" folder name for an invoice. Reads the year+month straight off the invoice date
 * STRING (which Gemini returns as "YYYY-MM-DD") rather than constructing a Date — a Date would be
 * parsed as UTC midnight and then shifted by the script timezone, which pushes a 1st-of-month
 * invoice into the previous month's folder. String slicing has no timezone and is deterministic,
 * so the same date always maps to the same folder. Falls back to the current month only when the
 * invoice has no usable date at all.
 */
function invoiceMonthKey_(invoiceDate) {
  const m = /^\s*(\d{4})-(\d{2})/.exec(String(invoiceDate || ''));
  if (m) return `${m[1]}-${m[2]}`;
  return Utilities.formatDate(new Date(), CONFIG_TIMEZONE_(), 'yyyy-MM');
}

/**
 * Resolves the Drive folder a matched invoice should live in, given its status — the single source
 * of truth shared by automatic filing (Main.gs/processOneInvoice_) and the dashboard's manual
 * override (DashboardServer.gs/updateInvoiceRow), so the two paths can never disagree about where
 * something belongs. 'Filed' goes straight into the month folder; 'Past Due' goes into a top-level
 * "Past Due" subfolder directly under the project/subproject folder — a SIBLING of the month
 * folders, not nested under one, so every overdue invoice for a project is visible in one place
 * without digging through months. Anything else (Needs Review, Not an Invoice) goes into that
 * month's "Statements & Others" subfolder — nested under the month, so a project's archive stays
 * organized by month at a glance either way. No project match at all falls back to the top-level
 * "_Unmatched" folder.
 */
function resolveInvoiceDestinationFolderId_(matchedRef, status, invoiceDate) {
  if (matchedRef && matchedRef.driveFolderId) {
    if (status === 'Past Due') {
      return getOrCreateNamedSubfolder_(matchedRef.driveFolderId, CONFIG.PASTDUE_SUBFOLDER_NAME).getId();
    }
    const monthFolderId = getMonthSubfolderId_(matchedRef.driveFolderId, invoiceDate);
    if (status === 'Filed') return monthFolderId;
    return getOrCreateNamedSubfolder_(monthFolderId, CONFIG.STATEMENTS_SUBFOLDER_NAME).getId();
  }
  return getOrCreateNamedSubfolder_(INVOICE_ARCHIVE_PARENT_FOLDER_ID, CONFIG.UNMATCHED_SUBFOLDER_NAME).getId();
}

/** Builds the standardized filename: YYYY-MM-DD_Vendor_InvoiceNumber.pdf */
function buildInvoiceFileName_(extracted) {
  const safeVendor = String(extracted.vendor_name || 'UnknownVendor').replace(/[\\/:*?"<>|]/g, '-');
  const safeInvoiceNumber = String(extracted.invoice_number || 'NoInvoiceNumber').replace(/[\\/:*?"<>|]/g, '-');
  const date = extracted.invoice_date || Utilities.formatDate(new Date(), CONFIG_TIMEZONE_(), 'yyyy-MM-dd');
  return `${date}_${safeVendor}_${safeInvoiceNumber}.pdf`;
}

function CONFIG_TIMEZONE_() {
  return Session.getScriptTimeZone();
}
