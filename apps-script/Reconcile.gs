/**
 * Reconcile.gs
 * Drive drift auditor — a safety net for when someone moves (or deletes) an invoice file directly in
 * Google Drive instead of through the dashboard. Because the archive lives in a broadly-shared folder,
 * direct moves can't be fully blocked by permissions; this keeps the Invoice Log honest so the
 * dashboard never silently disagrees with where files actually live.
 *
 * For every filed invoice it finds where the file ACTUALLY is now (by walking up its Drive parent
 * folders to a known project/subproject archive folder) and compares that to the log:
 *   - matches            → in sync, left alone.
 *   - moved to a DIFFERENT but KNOWN project/subproject → the log row is rewritten to match Drive, so
 *     the dashboard reflects reality. Recorded in the "Drive Audit" tab as a tracked trail.
 *   - moved somewhere unrecognized, or trashed/deleted → can't be safely mapped, so the row is flagged
 *     (Status → Needs Review, with a note) to surface on the dashboard for a human.
 *
 * Detection is by polling (Drive gives no move events to Apps Script), so run it on a daily trigger —
 * see createReconcileTrigger() in Setup.gs. Scoped to the ACTIVE log (the archive tab keeps that
 * bounded), one Drive lookup per filed row.
 */

function reconcileDriveLocations() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) { Logger.log('Reconcile: another run holds the script lock — skipping this time.'); return; }
  try {
    reconcileDriveLocationsInner_();
  } finally {
    lock.releaseLock();
  }
}

function reconcileDriveLocationsInner_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEET_LOG_TAB);
  if (!sheet) { Logger.log('Reconcile: no Invoice Log tab.'); return; }
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) { Logger.log('Reconcile: Invoice Log has no data rows.'); return; }

  const header = values[0];
  const idx = {};
  ['Status', 'Project Number', 'Project Name', 'Subproject Number', 'Subproject Name',
   'Vendor', 'Invoice Number', 'Drive File ID', 'Review Note', 'Row ID'].forEach(c => { idx[c] = header.indexOf(c); });
  if (idx['Drive File ID'] === -1) { Logger.log('Reconcile: no "Drive File ID" column — nothing to check against.'); return; }

  const folderMap = buildArchiveFolderMap_(getReferenceData_());

  const startTime = Date.now();
  const MAX_RUN_MS = 4.5 * 60 * 1000; // stay under Apps Script's ~6-min ceiling; unfinished rows are rechecked next daily run
  const stamp = Utilities.formatDate(new Date(), CONFIG_TIMEZONE_(), 'yyyy-MM-dd HH:mm');
  let checked = 0, synced = 0, flagged = 0, deferred = 0;

  for (let i = 1; i < values.length; i++) {
    if (Date.now() - startTime > MAX_RUN_MS) { deferred = values.length - i; break; }

    const row = values[i];
    const fileId = String(row[idx['Drive File ID']] || '').trim();
    if (!fileId) continue;
    // A "Duplicate" notice row intentionally points at ANOTHER row's file — not its own — so skip it.
    if (idx['Status'] > -1 && String(row[idx['Status']] || '').trim() === 'Duplicate') continue;
    checked++;

    const auditBase = {
      rowId: idx['Row ID'] > -1 ? row[idx['Row ID']] : '',
      vendor: idx['Vendor'] > -1 ? row[idx['Vendor']] : '',
      invoiceNumber: idx['Invoice Number'] > -1 ? row[idx['Invoice Number']] : '',
      from: loggedLocationLabel_(row, idx)
    };

    let file = null;
    try {
      file = DriveApp.getFileById(fileId);
    } catch (err) {
      flagReconcileRow_(sheet, i + 1, idx, row, `Drive mismatch (${stamp}): file not found in Drive — deleted, or the script lost access.`);
      logDriveAudit_(Object.assign({}, auditBase, { detected: 'File not found', to: '(missing)', action: 'Flagged → Needs Review' }));
      flagged++;
      continue;
    }

    if (file.isTrashed()) {
      flagReconcileRow_(sheet, i + 1, idx, row, `Drive mismatch (${stamp}): file is in the Drive Trash — restore it, or refile via the dashboard.`);
      logDriveAudit_(Object.assign({}, auditBase, { detected: 'In Trash', to: '(trash)', action: 'Flagged → Needs Review' }));
      flagged++;
      continue;
    }

    const actual = deriveFileArchiveLocation_(file, folderMap);
    if (!actual) {
      flagReconcileRow_(sheet, i + 1, idx, row, `Drive mismatch (${stamp}): file is in a folder that isn't a known project archive folder — move it back via the dashboard.`);
      logDriveAudit_(Object.assign({}, auditBase, { detected: 'Unrecognized folder', to: '(outside archive)', action: 'Flagged → Needs Review' }));
      flagged++;
      continue;
    }

    const loggedPn = normalizeNumberKey_(idx['Project Number'] > -1 ? row[idx['Project Number']] : '');
    const loggedSn = normalizeNumberKey_(idx['Subproject Number'] > -1 ? row[idx['Subproject Number']] : '');
    if (loggedPn === normalizeNumberKey_(actual.projectNumber) && loggedSn === normalizeNumberKey_(actual.subprojectNumber)) {
      continue; // file is where the log says — in sync
    }

    // Moved to a DIFFERENT but known project/subproject → sync the log to match Drive.
    if (idx['Project Number'] > -1) sheet.getRange(i + 1, idx['Project Number'] + 1).setValue(actual.projectNumber);
    if (idx['Project Name'] > -1) sheet.getRange(i + 1, idx['Project Name'] + 1).setValue(actual.projectName);
    if (idx['Subproject Number'] > -1) sheet.getRange(i + 1, idx['Subproject Number'] + 1).setValue(actual.subprojectNumber);
    if (idx['Subproject Name'] > -1) sheet.getRange(i + 1, idx['Subproject Name'] + 1).setValue(actual.subprojectName);
    const toLabel = actual.projectNumber + (actual.subprojectNumber ? '/' + actual.subprojectNumber : '');
    appendReconcileNote_(sheet, i + 1, idx, row, `Reconciled ${stamp} to match a manual Drive move: ${auditBase.from} → ${toLabel}.`);
    logDriveAudit_(Object.assign({}, auditBase, { detected: 'Moved to known project', to: toLabel, action: 'Log updated to match Drive' }));
    synced++;
  }

  Logger.log(`Reconcile: checked ${checked} filed row(s). Synced ${synced} to match manual Drive moves; flagged ${flagged} for review.` +
    (deferred > 0 ? ` ${deferred} row(s) deferred to the next daily run (time budget).` : ''));
}

/** folderId -> { projectNumber, projectName, subprojectNumber, subprojectName } for every archive folder on record. */
function buildArchiveFolderMap_(referenceRows) {
  const map = {};
  referenceRows.forEach(r => {
    if (r.driveFolderId) {
      map[r.driveFolderId] = {
        projectNumber: r.projectNumber,
        projectName: r.projectName,
        subprojectNumber: r.subprojectNumber,
        subprojectName: r.subprojectName
      };
    }
  });
  return map;
}

/**
 * Walks up a file's Drive parent folders (breadth-first, capped) and returns the location of the first
 * folder that matches a known project/subproject archive folder — so a file sitting inside a month
 * subfolder (or "Statements & Others") still resolves to its project/subproject. Returns null if none
 * of its ancestors are a known archive folder (i.e. it's been moved outside the archive structure).
 */
function deriveFileArchiveLocation_(file, folderMap) {
  const seen = {};
  let frontier = collectParents_(file);
  let depth = 0;
  while (frontier.length && depth < 10) {
    const next = [];
    for (let k = 0; k < frontier.length; k++) {
      const folder = frontier[k];
      const id = folder.getId();
      if (folderMap[id]) return folderMap[id];
      if (seen[id]) continue;
      seen[id] = true;
      const ps = folder.getParents();
      while (ps.hasNext()) next.push(ps.next());
    }
    frontier = next;
    depth++;
  }
  return null;
}

/** Collects a file's (or folder's) immediate parents into an array. */
function collectParents_(item) {
  const out = [];
  const it = item.getParents();
  while (it.hasNext()) out.push(it.next());
  return out;
}

/** A short "project/subproject" label for the row's currently-logged location, for notes/audit. */
function loggedLocationLabel_(row, idx) {
  const pn = idx['Project Number'] > -1 ? String(row[idx['Project Number']] || '').trim() : '';
  const sn = idx['Subproject Number'] > -1 ? String(row[idx['Subproject Number']] || '').trim() : '';
  if (!pn) return '(unmatched)';
  return pn + (sn ? '/' + sn : '');
}

/** Sets a row's Status to Needs Review and appends a mismatch note. */
function flagReconcileRow_(sheet, rowNum1, idx, row, note) {
  if (idx['Status'] > -1) sheet.getRange(rowNum1, idx['Status'] + 1).setValue('Needs Review');
  appendReconcileNote_(sheet, rowNum1, idx, row, note);
}

/** Appends a note to a row's Review Note cell, preserving any existing text. */
function appendReconcileNote_(sheet, rowNum1, idx, row, note) {
  if (idx['Review Note'] === -1) return;
  const existing = String(row[idx['Review Note']] || '');
  sheet.getRange(rowNum1, idx['Review Note'] + 1).setValue(existing ? existing + ' ' + note : note);
}

/** Appends one row to the "Drive Audit" tab — the tracked trail of detected drift and what was done. */
function logDriveAudit_(o) {
  const sheet = getOrCreateSheet_(CONFIG.SHEET_DRIVE_AUDIT_TAB, CONFIG.DRIVE_AUDIT_COLUMNS);
  ensureSheetHasColumns_(sheet, CONFIG.DRIVE_AUDIT_COLUMNS);
  sheet.appendRow(buildRowByHeader_(sheet, {
    'Timestamp': new Date(),
    'Row ID': o.rowId || '',
    'Vendor': o.vendor || '',
    'Invoice Number': o.invoiceNumber || '',
    'Detected': o.detected || '',
    'From (logged)': o.from || '',
    'To (actual)': o.to || '',
    'Action': o.action || ''
  }));
}
