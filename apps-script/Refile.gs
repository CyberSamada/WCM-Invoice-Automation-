/**
 * Refile.gs
 * One-time consolidation for the switch to processed-date month folders: moves every already-filed
 * invoice into the "YYYY-MM" folder of its Date PROCESSED — the same date its filename carries — so
 * (for example) the whole June-backlog batch that was processed in July consolidates under 2026-07,
 * and filename/folder always agree.
 *
 * - Reads the active Invoice Log AND the archive tab. Rows with no Drive File ID, and "Duplicate"
 *   notice rows (their file belongs to the original invoice), are skipped.
 * - Recomputes each row's correct destination with resolveInvoiceDestinationFolderId_ (the same
 *   resolver every other filing path uses): Filed rows to the month folder, everything else to that
 *   month's "Statements & Others". A file already in the right place is left untouched — idempotent,
 *   safe to re-run.
 * - Drive-only: a move doesn't change a file's URL, so the sheet needs no rewriting.
 * - Afterwards, month-shaped folders (YYYY-MM) and "Statements & Others" subfolders left EMPTY by the
 *   moves are trashed (recoverable), so the old scattered month folders disappear.
 * - Time-budgeted like every long job here: if it can't finish in one run, re-run it — already-moved
 *   files are skipped, so it picks up where it left off.
 *
 * Run refileByProcessedMonth() ONCE from the editor after this deploys (re-run until it reports done).
 */

function refileByProcessedMonth() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(0)) { Logger.log('Another run holds the script lock — wait a moment and try again.'); return; }
  try {
    refileByProcessedMonthInner_();
  } finally {
    lock.releaseLock();
  }
}

function refileByProcessedMonthInner_() {
  const referenceRows = getReferenceData_();
  const startTime = Date.now();
  const MAX_RUN_MS = 4.5 * 60 * 1000;
  const oldParentIds = {}; // folders files were moved OUT of — candidates for empty-folder cleanup
  let checked = 0, moved = 0, skippedInPlace = 0, skippedNoFile = 0, deferred = 0;

  const tabs = [CONFIG.SHEET_LOG_TAB, CONFIG.SHEET_LOG_ARCHIVE_TAB];
  for (let t = 0; t < tabs.length; t++) {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(tabs[t]);
    if (!sheet) continue;
    const values = sheet.getDataRange().getValues();
    if (values.length < 2) continue;
    const header = values[0];
    const idx = {};
    ['Status', 'Project Number', 'Subproject Number', 'Date Processed', 'Drive File ID'].forEach(c => { idx[c] = header.indexOf(c); });
    if (idx['Drive File ID'] === -1 || idx['Date Processed'] === -1) continue;

    for (let i = 1; i < values.length; i++) {
      if (Date.now() - startTime > MAX_RUN_MS) { deferred++; break; }
      const row = values[i];
      const fileId = String(row[idx['Drive File ID']] || '').trim();
      if (!fileId) continue;
      const status = idx['Status'] > -1 ? String(row[idx['Status']] || '').trim() : '';
      if (status === 'Duplicate') continue; // notice row — its file belongs to the original invoice
      checked++;

      try {
        const projectNumber = idx['Project Number'] > -1 ? String(row[idx['Project Number']] || '').trim() : '';
        const subprojectNumber = idx['Subproject Number'] > -1 ? String(row[idx['Subproject Number']] || '').trim() : '';
        const matchedRef = projectNumber ? findReferenceMatch_(referenceRows, projectNumber, subprojectNumber) : null;
        const destFolderId = resolveInvoiceDestinationFolderId_(matchedRef, status, row[idx['Date Processed']]);

        const file = DriveApp.getFileById(fileId);
        if (file.isTrashed()) { skippedNoFile++; continue; }

        // Already in the right folder? Leave it (this is what makes re-runs cheap and idempotent).
        let inPlace = false;
        const parents = file.getParents();
        const parentIds = [];
        while (parents.hasNext()) {
          const p = parents.next();
          parentIds.push(p.getId());
          if (p.getId() === destFolderId) inPlace = true;
        }
        if (inPlace) { skippedInPlace++; continue; }

        file.moveTo(DriveApp.getFolderById(destFolderId));
        parentIds.forEach(id => { oldParentIds[id] = true; });
        moved++;
      } catch (err) {
        skippedNoFile++; // missing/inaccessible file — nothing to move
      }
    }
    if (deferred) break;
  }

  const removedFolders = cleanupEmptiedMonthFolders_(oldParentIds);

  Logger.log(`refileByProcessedMonth: ${moved} file(s) moved to their processed-month folder, ` +
    `${skippedInPlace} already in place, ${skippedNoFile} skipped (missing/trashed file), ${checked} checked. ` +
    `${removedFolders} emptied folder(s) trashed.` +
    (deferred ? ' TIME BUDGET HIT — re-run refileByProcessedMonth() to continue (already-moved files are skipped).' : ' Done.'));
}

/**
 * Trashes folders left empty by the refile — but ONLY month-shaped ("YYYY-MM") folders and
 * "Statements & Others" subfolders, never project folders. Removing an empty "Statements & Others"
 * can empty its parent month folder, so this cascades upward until nothing more qualifies. Trash is
 * recoverable.
 */
function cleanupEmptiedMonthFolders_(folderIdSet) {
  const MONTH_RE = /^\d{4}-\d{2}$/;
  let removed = 0;
  let candidates = Object.keys(folderIdSet || {});
  for (let pass = 0; pass < 4 && candidates.length; pass++) {
    const next = {};
    candidates.forEach(id => {
      try {
        const folder = DriveApp.getFolderById(id);
        if (folder.isTrashed()) return;
        const name = String(folder.getName() || '');
        if (!MONTH_RE.test(name) && name !== CONFIG.STATEMENTS_SUBFOLDER_NAME) return; // never touch project/other folders
        if (folder.getFiles().hasNext() || folder.getFolders().hasNext()) return;      // not empty — leave it
        const parents = folder.getParents();
        folder.setTrashed(true);
        removed++;
        while (parents.hasNext()) next[parents.next().getId()] = true; // parent may now be empty too
      } catch (e) { /* gone/inaccessible — nothing to do */ }
    });
    candidates = Object.keys(next);
  }
  return removed;
}
