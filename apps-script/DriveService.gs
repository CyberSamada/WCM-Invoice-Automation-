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
  const file = folder.createFile(pdfBlob).setName(fileName);
  return file.getUrl();
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
