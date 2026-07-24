/**
 * Refile.gs (v2 — status-separated structure)
 * Reconciles EVERY already-filed invoice into the current folder structure:
 *
 *   <project folder>/
 *     <subproject folder>/            (when a subproject is assigned)
 *       YYYY-MM/                      real invoices (Filed/Captured/Paid), by processed month
 *         Needs Review/               invoices awaiting review — never mixed with statements
 *         Statements & Others/        ONLY "Not an Invoice" documents
 *     No Subprojects/                 (when NO subproject is assigned — same months inside)
 *
 * refileToCorrectFolders() recomputes each Invoice Log row's destination with
 * resolveInvoiceDestinationFolderId_ — the exact same resolver automatic filing and the dashboard
 * use — and moves the file if it isn't already there. Because the resolver now handles the
 * no-subproject case properly ("No Subprojects" folder, never an arbitrary sibling subproject) and
 * separates statuses, re-running this converges: a file is "in place" only when it's genuinely in
 * its correct folder.
 *
 * - Reads the active Invoice Log AND the archive tab. Rows with no Drive File ID, and "Duplicate"
 *   notice rows (their file belongs to the original invoice), are skipped.
 * - Drive-only: moves don't change file URLs, so the sheet needs no rewriting.
 * - Time-budgeted: if it can't finish in one run it says so — re-run until it reports "Done"
 *   (already-correct files are skipped cheaply, so each re-run gets further).
 * - Finishes with cleanupEmptyArchiveFolders(): a FULL sweep of every project/subproject folder that
 *   trashes empty structural folders (YYYY-MM, Needs Review, Statements & Others, No Subprojects,
 *   legacy Past Due) — including ones left behind by older refile runs. Trash is recoverable.
 *   cleanupEmptyArchiveFolders() can also be run on its own from the editor.
 */

function refileToCorrectFolders() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(0)) { Logger.log('Another run holds the script lock — wait a moment and try again.'); return; }
  try {
    refileToCorrectFoldersInner_();
  } finally {
    lock.releaseLock();
  }
}

function refileToCorrectFoldersInner_() {
  const referenceRows = getReferenceData_();
  const startTime = Date.now();
  const MAX_RUN_MS = 4 * 60 * 1000;
  const matchCache = {}; // "project|subproject" -> matchedRef (findReferenceMatch_ may hit Drive)
  const destCache = {};  // "project|subproject|statusBucket|monthKey" -> destination folder ID
  let checked = 0, moved = 0, skippedInPlace = 0, skippedNoFile = 0;
  let deferred = false;

  const tabs = [CONFIG.SHEET_LOG_TAB, CONFIG.SHEET_LOG_ARCHIVE_TAB];
  for (let t = 0; t < tabs.length && !deferred; t++) {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(tabs[t]);
    if (!sheet) continue;
    const values = sheet.getDataRange().getValues();
    if (values.length < 2) continue;
    const header = values[0];
    const idx = {};
    ['Status', 'Project Number', 'Subproject Number', 'Date Processed', 'Drive File ID'].forEach(c => { idx[c] = header.indexOf(c); });
    if (idx['Drive File ID'] === -1 || idx['Date Processed'] === -1) continue;

    for (let i = 1; i < values.length; i++) {
      if (Date.now() - startTime > MAX_RUN_MS) { deferred = true; break; }
      const row = values[i];
      const fileId = String(row[idx['Drive File ID']] || '').trim();
      if (!fileId) continue;
      const status = idx['Status'] > -1 ? String(row[idx['Status']] || '').trim() : '';
      if (status === 'Duplicate') continue; // notice row — its file belongs to the original invoice
      checked++;

      try {
        const projectNumber = idx['Project Number'] > -1 ? String(row[idx['Project Number']] || '').trim() : '';
        const subprojectNumber = idx['Subproject Number'] > -1 ? String(row[idx['Subproject Number']] || '').trim() : '';

        const matchKey = projectNumber + '|' + subprojectNumber;
        if (!(matchKey in matchCache)) {
          matchCache[matchKey] = projectNumber ? findReferenceMatch_(referenceRows, projectNumber, subprojectNumber) : null;
        }
        const matchedRef = matchCache[matchKey];

        // Statuses collapse to three folder buckets, all nested under the processed-month folder.
        const bucket = (status === 'Filed' || status === 'Captured' || status === 'Paid') ? 'Filed'
          : (status === 'Not an Invoice' ? 'Not an Invoice' : 'Needs Review');
        const destKey = matchKey + '|' + bucket + '|' + monthFolderKey_(row[idx['Date Processed']]);
        if (!(destKey in destCache)) {
          destCache[destKey] = resolveInvoiceDestinationFolderId_(matchedRef, bucket, row[idx['Date Processed']]);
        }
        const destFolderId = destCache[destKey];

        const file = DriveApp.getFileById(fileId);
        if (file.isTrashed()) { skippedNoFile++; continue; }

        // Already in the right folder? Leave it — this is what makes re-runs cheap and convergent.
        let inPlace = false;
        const parents = file.getParents();
        while (parents.hasNext()) {
          if (parents.next().getId() === destFolderId) { inPlace = true; break; }
        }
        if (inPlace) { skippedInPlace++; continue; }

        file.moveTo(DriveApp.getFolderById(destFolderId));
        moved++;
      } catch (err) {
        skippedNoFile++; // missing/inaccessible file — nothing to move
      }
    }
  }

  let removedFolders = 0;
  if (!deferred) {
    removedFolders = cleanupEmptyArchiveFoldersInner_(referenceRows, startTime, MAX_RUN_MS + 60 * 1000);
  }

  Logger.log(`refileToCorrectFolders: ${moved} file(s) moved, ${skippedInPlace} already in place, ` +
    `${skippedNoFile} skipped (missing/trashed file), ${checked} checked. ` +
    `${removedFolders} empty folder(s) trashed.` +
    (deferred ? ' TIME BUDGET HIT — re-run refileToCorrectFolders() to continue (already-correct files are skipped).' : ' Done.'));
}

/**
 * Full sweep for leftover empty structure: walks EVERY project/subproject folder on the Project
 * Reference sheet and trashes empty structural folders — "YYYY-MM" month folders, "Needs Review",
 * "Statements & Others", "No Subprojects", and legacy "Past Due" — wherever they sit (up to three
 * levels deep, e.g. project / No Subprojects / 2026-05 / Statements & Others). Never touches project
 * or subproject folders themselves, and never touches a folder that still has any content. Runs
 * automatically at the end of refileToCorrectFolders(); safe to run on its own any time.
 */
function cleanupEmptyArchiveFolders() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(0)) { Logger.log('Another run holds the script lock — wait a moment and try again.'); return; }
  try {
    const removed = cleanupEmptyArchiveFoldersInner_(getReferenceData_(), Date.now(), 4.5 * 60 * 1000);
    Logger.log(`cleanupEmptyArchiveFolders: ${removed} empty folder(s) trashed (recoverable from Trash).`);
  } finally {
    lock.releaseLock();
  }
}

/** True if a folder name is refile-managed structure (safe to trash when empty). */
function isStructuralFolderName_(name) {
  const n = String(name || '');
  return /^\d{4}-\d{2}$/.test(n)
    || n === CONFIG.STATEMENTS_SUBFOLDER_NAME
    || n === CONFIG.NEEDS_REVIEW_SUBFOLDER_NAME
    || n === CONFIG.NO_SUBPROJECT_FOLDER_NAME
    || n === CONFIG.PASTDUE_SUBFOLDER_NAME; // legacy — lane removed, empty leftovers can go
}

function cleanupEmptyArchiveFoldersInner_(referenceRows, startTime, maxRunMs) {
  // Every provisioned project/subproject folder is a root to sweep under (deduped).
  const rootIds = {};
  referenceRows.forEach(r => { if (r.driveFolderId) rootIds[r.driveFolderId] = true; });

  // Collect structural folders up to 3 levels below each root (only descending through structural
  // names — a project's own document folders are never entered or touched).
  const candidates = {};
  const collect = (folder, depth) => {
    if (depth > 3 || Date.now() - startTime > maxRunMs) return;
    const children = folder.getFolders();
    while (children.hasNext()) {
      const child = children.next();
      if (!isStructuralFolderName_(child.getName())) continue;
      candidates[child.getId()] = true;
      collect(child, depth + 1);
    }
  };
  Object.keys(rootIds).forEach(id => {
    if (Date.now() - startTime > maxRunMs) return;
    try { collect(DriveApp.getFolderById(id), 1); } catch (e) { /* missing/inaccessible root */ }
  });

  // Trash empties bottom-up: repeated passes so a month folder emptied by removing its
  // "Statements & Others" child gets caught on the next pass.
  let removed = 0;
  let ids = Object.keys(candidates);
  for (let pass = 0; pass < 4 && ids.length; pass++) {
    const stillCandidates = [];
    ids.forEach(id => {
      try {
        const folder = DriveApp.getFolderById(id);
        if (folder.isTrashed()) return;
        if (folder.getFiles().hasNext() || folder.getFolders().hasNext()) { stillCandidates.push(id); return; }
        folder.setTrashed(true);
        removed++;
      } catch (e) { /* gone/inaccessible */ }
    });
    ids = stillCandidates;
  }
  return removed;
}
