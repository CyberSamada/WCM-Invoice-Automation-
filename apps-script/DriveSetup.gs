/**
 * DriveSetup.gs
 * Keeps the Invoice Archive (Drive) and the "Project Reference" tab in sync — with each other,
 * and with the real project folder structure in Drive — so a newly created project or subproject
 * folder doesn't require a manual update, and Gemini's project/subproject match never has to guess
 * at something that isn't in the reference list (which is exactly how a real invoice could get
 * misfiled).
 *
 * Two entry points:
 *
 *   - syncProjectReferenceFromDrive() — scans the real project folder structure under
 *     PROJECTS_ROOT_FOLDER_ID ("+ Properties - Const"), adds any project/subproject rows to
 *     "Project Reference" that aren't there yet, then calls createInvoiceArchiveFolders(). This is
 *     the one to run regularly (or put on a daily trigger via createSyncTrigger()) so new folders
 *     get picked up automatically. ADDITIVE ONLY — it never deletes or overwrites an existing row,
 *     only adds missing ones. Safe to re-run any time.
 *
 *   - createInvoiceArchiveFolders() — for every unique project number in "Project Reference",
 *     makes sure an Invoice Archive subfolder exists and that the Drive Folder ID column is filled
 *     in for every one of its rows. ID-BASED, not name-based: once a project has an ID on file, that
 *     ID is reused as-is and never re-derived by searching Drive for a matching folder name — this is
 *     what makes it safe against sheet formatting quirks (e.g. "02" silently becoming the number 2)
 *     and manual renames. If a project's name on file doesn't match its archive folder's current
 *     name, the folder gets renamed to match (self-healing — see note below on today's run).
 *
 * Fixing today's run: your project numbers 00/02/05/06/08 lost their leading zero because the
 * "Project Number" column in the sheet is formatted as a number, not text (so "02" became 2), and
 * project 00 was skipped entirely. Fix it in the sheet — select the Project Number column, Format >
 * Number > Plain text, then re-enter 00/02/05/06/08 so they display with the leading zero (typing
 * '02 with a leading apostrophe forces text). Then just re-run createInvoiceArchiveFolders() (or
 * syncProjectReferenceFromDrive()) — it will automatically rename the 4 mis-named folders
 * ("2 - ..." -> "02 - ...", etc.) and create the missing "00 - PROJECT TEMPLATE" folder. No manual
 * Drive cleanup needed.
 */

const INVOICE_ARCHIVE_PARENT_FOLDER_ID = '1YnKkKhNNElDpmkBCLPoadlD00MTuYaxh'; // Invoice Archive root in Drive (fresh root, July 2026 reset — replaced the original "Outputs" folder, which had accumulated duplicate project folders)
const PROJECTS_ROOT_FOLDER_ID = '1Ci3WI0U7URbMsOg7ecJ4_7gxrnd8hFZ0'; // "+ Properties - Const" folder in Drive — needed only for syncProjectReferenceFromDrive()
const IGNORED_PROJECT_NUMBERS = new Set(['00', '0']); // "00 - PROJECT TEMPLATE" is a template folder, not a real project — never gets a reference row or an Invoice Archive folder. ('0' included too in case the sheet cell is still numeric.)

/** Converts a Sheet cell value to a trimmed string. Deliberately does NOT use `value || ''` —
 *  that treats the number 0 as falsy and silently turns project "00" into an empty string,
 *  which is the bug that made project 00 vanish from today's run. */
function cellToString_(value) {
  return (value === null || value === undefined) ? '' : String(value).trim();
}

/**
 * Scans the real project folder structure in Drive and adds any project/subproject combo found
 * there but missing from "Project Reference" as a new row, then provisions/refreshes Invoice
 * Archive folders for everything (including whatever was just added). Additive only.
 */
function syncProjectReferenceFromDrive() {
  if (!PROJECTS_ROOT_FOLDER_ID || PROJECTS_ROOT_FOLDER_ID.indexOf('PASTE_') === 0) {
    throw new Error('Set PROJECTS_ROOT_FOLDER_ID in DriveSetup.gs to the Drive folder ID of "+ Properties - Const" first.');
  }

  const rootFolder = DriveApp.getFolderById(PROJECTS_ROOT_FOLDER_ID);
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEET_REFERENCE_TAB);
  if (!sheet) {
    throw new Error(`Missing "${CONFIG.SHEET_REFERENCE_TAB}" tab. Run setup() first.`);
  }

  const values = sheet.getDataRange().getValues();
  const header = values[0];
  const idx = {
    projectNumber: header.indexOf('Project Number'),
    projectName: header.indexOf('Project Name'),
    subprojectNumber: header.indexOf('Subproject Number'),
    subprojectName: header.indexOf('Subproject Name'),
    driveFolderId: header.indexOf('Drive Folder ID')
  };
  Object.keys(idx).forEach(k => {
    if (idx[k] === -1) throw new Error(`"${CONFIG.SHEET_REFERENCE_TAB}" tab is missing a "${k}" column.`);
  });

  // What's already on file: known project+subproject combos, and each project's existing Drive Folder ID (if any).
  const knownProjectFolderId = {}; // projectNumber -> Drive Folder ID (first non-blank one found)
  const knownCombos = new Set();   // "projectNumber||subprojectNumber"
  for (let i = 1; i < values.length; i++) {
    const num = cellToString_(values[i][idx.projectNumber]);
    if (!num) continue;
    const sub = cellToString_(values[i][idx.subprojectNumber]);
    knownCombos.add(num + '||' + sub);
    const fid = cellToString_(values[i][idx.driveFolderId]);
    if (fid && !knownProjectFolderId[num]) knownProjectFolderId[num] = fid;
  }

  const newRows = []; // [Project Number, Project Name, Subproject Number, Subproject Name, Drive Folder ID]
  const projectFolders = rootFolder.getFolders();
  while (projectFolders.hasNext()) {
    const projFolder = projectFolders.next();
    const projMatch = projFolder.getName().match(/^(\S+)\s*-\s*(.+)$/); // "<number> - <name>"
    if (!projMatch) continue; // doesn't match the naming convention — skip rather than guess
    const projectNumber = projMatch[1].trim();
    const projectName = projMatch[2].trim();
    if (IGNORED_PROJECT_NUMBERS.has(projectNumber)) {
      Logger.log(`Skipping "${projFolder.getName()}" — ignored project number.`);
      continue;
    }
    const existingFolderId = knownProjectFolderId[projectNumber] || '';

    let sawAnySubproject = false;
    const subFolders = projFolder.getFolders();
    while (subFolders.hasNext()) {
      const subFolder = subFolders.next();
      // "<subproject number> <name>", e.g. "2.1 North Expansions" — number must look numeric so
      // generic phase/admin folders (Design Development, Coordinations, Reports, etc.) get skipped.
      const subMatch = subFolder.getName().match(/^(\d+(?:\.\d+)?)\s+(.+)$/);
      if (!subMatch) continue;
      sawAnySubproject = true;
      const subprojectNumber = subMatch[1].trim();
      const subprojectName = subMatch[2].trim();
      const comboKey = projectNumber + '||' + subprojectNumber;
      if (!knownCombos.has(comboKey)) {
        newRows.push([projectNumber, projectName, subprojectNumber, subprojectName, existingFolderId]);
        knownCombos.add(comboKey);
        Logger.log(`New subproject found: ${projectNumber} / ${subprojectNumber} ${subprojectName}`);
      }
    }

    // No numbered subprojects at all (template/admin-only project) — make sure it has one row.
    if (!sawAnySubproject && !knownCombos.has(projectNumber + '||')) {
      newRows.push([projectNumber, projectName, '', '', existingFolderId]);
      knownCombos.add(projectNumber + '||');
      Logger.log(`New project found (no numbered subprojects): ${projectNumber} ${projectName}`);
    }
  }

  if (newRows.length > 0) {
    sheet.getRange(sheet.getLastRow() + 1, 1, newRows.length, 5).setValues(newRows);
    Logger.log(`Added ${newRows.length} new row(s) to "${CONFIG.SHEET_REFERENCE_TAB}".`);
  } else {
    Logger.log('No new projects or subprojects found in Drive — reference data already up to date.');
  }

  // Make sure every project (including anything just added) has an Invoice Archive folder + ID.
  createInvoiceArchiveFolders();
}

/**
 * Ensures every unique project number in "Project Reference" has an Invoice Archive subfolder,
 * AND that every one of its subprojects has its own subfolder nested underneath — so invoices for
 * subproject 43.5 file into "43 - HYLAND CENTRE/43.5 - 3F (3A - WCM)/", not the flat project
 * folder. ID-based idempotency at both levels: a project or subproject that already has an ID on
 * file keeps that exact ID, only its name is kept in sync (renamed if drifted).
 *
 * Migration note: rows logged before subproject folders existed have their Drive Folder ID set to
 * the *project's* folder ID (the only kind that existed then). Resolving the project folder first
 * lets this function recognize that case (a subproject row's "existing" ID that's actually just
 * the shared project ID) and provision a real subfolder instead of mistakenly treating the project
 * folder itself as if it were that subproject's folder.
 */
function createInvoiceArchiveFolders() {
  // Concurrent runs (the daily sync trigger overlapping a manual run, or two manual runs) would
  // each see "no folder ID on file" for the same project and BOTH create one — real duplicate
  // folders observed in the archive. Same tryLock(0) pattern as processInvoices().
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(0)) {
    Logger.log('Another folder-provisioning run is already in progress — skipping this one.');
    return;
  }
  try {
    createInvoiceArchiveFoldersInner_();
  } finally {
    lock.releaseLock();
  }
}

function createInvoiceArchiveFoldersInner_() {
  const parentFolder = DriveApp.getFolderById(INVOICE_ARCHIVE_PARENT_FOLDER_ID);

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEET_REFERENCE_TAB);
  if (!sheet) {
    throw new Error(`Missing "${CONFIG.SHEET_REFERENCE_TAB}" tab. Run setup() first, then import project_reference.csv into it.`);
  }

  const values = sheet.getDataRange().getValues();
  const header = values[0];
  const idx = {
    projectNumber: header.indexOf('Project Number'),
    projectName: header.indexOf('Project Name'),
    subprojectNumber: header.indexOf('Subproject Number'),
    subprojectName: header.indexOf('Subproject Name'),
    driveFolderId: header.indexOf('Drive Folder ID')
  };
  Object.keys(idx).forEach(k => {
    if (idx[k] === -1) throw new Error(`"${CONFIG.SHEET_REFERENCE_TAB}" tab is missing a "${k}" column.`);
  });

  // Unique project -> { number, name, existingFolderId, subRowFolderIds }, keyed by
  // normalizeNumberKey_ so "05" and "5" (zero-padding lost to cell formatting on some rows) are ONE
  // project, not two — they used to each get their own folder. The displayed number prefers the
  // longer (zero-padded) form seen on any row. existingFolderId comes only from a blank-subproject
  // ("main") row; subproject-row IDs are collected separately for the parent-derivation fallback.
  const projects = {};
  for (let i = 1; i < values.length; i++) {
    const rawNum = cellToString_(values[i][idx.projectNumber]);
    if (!rawNum || IGNORED_PROJECT_NUMBERS.has(rawNum)) continue;
    const key = normalizeNumberKey_(rawNum);
    if (!projects[key]) projects[key] = { number: rawNum, name: '', existingFolderId: '', subRowFolderIds: [] };
    if (rawNum.length > projects[key].number.length) projects[key].number = rawNum; // prefer "05" over "5"
    const name = cellToString_(values[i][idx.projectName]);
    if (name && !projects[key].name) projects[key].name = name;
    const fid = cellToString_(values[i][idx.driveFolderId]);
    if (!cellToString_(values[i][idx.subprojectNumber])) {
      if (fid && !projects[key].existingFolderId) projects[key].existingFolderId = fid;
    } else if (fid) {
      projects[key].subRowFolderIds.push(fid);
    }
  }

  const resolvedProjectFolderId = {}; // normalized project key -> folder ID
  let createdCount = 0, renamedCount = 0, reusedCount = 0;

  Object.keys(projects).sort().forEach(key => {
    const p = projects[key];
    // A project with only subproject rows has no blank-subproject row to carry its folder ID, so
    // "existing ID on file" alone can never see it — this is exactly what caused a fresh duplicate
    // project folder on EVERY run (including the daily sync trigger). Derive it instead from where
    // an existing subproject folder actually lives: its parent IS the project folder.
    let existingFolderId = p.existingFolderId || deriveProjectFolderFromSubfolders_(p.subRowFolderIds);
    // Only trust an ID that actually lives directly under the CURRENT archive root. This is what
    // makes swapping INVOICE_ARCHIVE_PARENT_FOLDER_ID to a new root self-executing: every stale ID
    // pointing into the old tree is ignored, so one run provisions everything fresh under the new
    // root and rewrites the sheet — no manual clearing of the Drive Folder ID column needed.
    if (existingFolderId && !isDirectChildOfArchiveRoot_(existingFolderId)) existingFolderId = '';
    const expectedName = `${p.number} - ${p.name}`;
    resolvedProjectFolderId[key] = resolveNamedFolder_(
      parentFolder, existingFolderId, expectedName, p.number,
      (c) => { if (c === 'created') createdCount++; else if (c === 'renamed') renamedCount++; else reusedCount++; }
    );
  });

  // Subproject folders, nested under their project's folder. existingFolderId for a subproject row
  // is only trusted if it's NOT the same as the project's own folder ID — see migration note above.
  const resolvedSubfolderId = {}; // "projectKey||subprojectNumber" -> folder ID
  let subCreated = 0, subRenamed = 0, subReused = 0;
  for (let i = 1; i < values.length; i++) {
    const num = cellToString_(values[i][idx.projectNumber]);
    const sub = cellToString_(values[i][idx.subprojectNumber]);
    if (!num || IGNORED_PROJECT_NUMBERS.has(num) || !sub) continue;
    const comboKey = normalizeNumberKey_(num) + '||' + sub;
    if (resolvedSubfolderId[comboKey]) continue; // already handled (a subproject can span multiple rows)

    const projectFolderId = resolvedProjectFolderId[normalizeNumberKey_(num)];
    if (!projectFolderId) continue; // shouldn't happen, but don't blow up the whole run over one bad row

    const subName = cellToString_(values[i][idx.subprojectName]);
    const rawExisting = cellToString_(values[i][idx.driveFolderId]);
    // Trust a subproject row's ID only if that folder actually sits inside THIS project's resolved
    // folder — an ID from the old archive root (or the migration-era shared project ID) is ignored,
    // so a fresh subfolder gets created in the right place instead of the old tree being reused.
    const existingSubFolderId = (rawExisting && rawExisting !== projectFolderId && isDirectChildOf_(rawExisting, projectFolderId))
      ? rawExisting : '';
    const expectedSubName = `${sub} - ${subName}`;
    const projectFolder = DriveApp.getFolderById(projectFolderId);

    resolvedSubfolderId[comboKey] = resolveNamedFolder_(
      projectFolder, existingSubFolderId, expectedSubName, comboKey,
      (c) => { if (c === 'created') subCreated++; else if (c === 'renamed') subRenamed++; else subReused++; }
    );
  }

  // Write/refresh the Drive Folder ID column for every row: subproject rows get their own
  // subfolder's ID, blank-subproject rows get the project folder's ID.
  let updatedCount = 0;
  for (let i = 1; i < values.length; i++) {
    const num = cellToString_(values[i][idx.projectNumber]);
    if (!num) continue;
    const sub = cellToString_(values[i][idx.subprojectNumber]);
    const target = sub ? resolvedSubfolderId[normalizeNumberKey_(num) + '||' + sub] : resolvedProjectFolderId[normalizeNumberKey_(num)];
    if (!target) continue;
    const currentValue = cellToString_(values[i][idx.driveFolderId]);
    if (currentValue !== target) {
      sheet.getRange(i + 1, idx.driveFolderId + 1).setValue(target);
      updatedCount++;
    }
  }

  Logger.log(`Projects: ${createdCount} created, ${renamedCount} renamed, ${reusedCount} up to date. ` +
    `Subprojects: ${subCreated} created, ${subRenamed} renamed, ${subReused} up to date. ${updatedCount} row(s) had their Drive Folder ID written/refreshed.`);
}

/**
 * Finds a project's archive folder via its existing subproject folders: each subproject folder
 * lives directly inside the project folder, so the first healthy one's parent IS the project
 * folder. Migration-era rows whose "subproject" ID is actually the project folder itself (a direct
 * child of the archive root) are recognized and returned as-is. Returns '' if nothing usable —
 * only then does the caller create a fresh project folder.
 */
function deriveProjectFolderFromSubfolders_(subRowFolderIds) {
  for (let i = 0; i < subRowFolderIds.length; i++) {
    try {
      const folder = DriveApp.getFolderById(subRowFolderIds[i]);
      if (folder.isTrashed()) continue;
      const parents = folder.getParents();
      if (!parents.hasNext()) continue;
      const parent = parents.next();
      if (parent.isTrashed()) continue;
      // Direct child of the archive root = this "subproject" ID is really the project folder itself.
      if (parent.getId() === INVOICE_ARCHIVE_PARENT_FOLDER_ID) return folder.getId();
      // Otherwise the parent is the candidate project folder — but only if IT sits directly under
      // the current archive root; a subfolder from the old (pre-reset) tree must not resurrect it.
      if (isDirectChildOfArchiveRoot_(parent.getId())) return parent.getId();
    } catch (err) { /* inaccessible ID — try the next row */ }
  }
  return '';
}

/** True if the folder's first parent is the current archive root (i.e. it's a top-level project folder in THIS archive). */
function isDirectChildOfArchiveRoot_(folderId) {
  return isDirectChildOf_(folderId, INVOICE_ARCHIVE_PARENT_FOLDER_ID);
}

/** True if `folderId` exists, isn't trashed, and its first parent is `parentId`. False on any error. */
function isDirectChildOf_(folderId, parentId) {
  try {
    const folder = DriveApp.getFolderById(folderId);
    if (folder.isTrashed()) return false;
    const parents = folder.getParents();
    return parents.hasNext() && parents.next().getId() === parentId;
  } catch (err) {
    return false;
  }
}

/**
 * Shared get-or-create-or-rename logic for one folder level (used for both the project folder and
 * each subproject folder): reuse an existing ID as-is if it's valid, replace it if trashed, rename
 * it if the expected name has drifted, or create it fresh if there's no ID on file yet. Never
 * matches by searching for a same-named folder — that's what caused mismatched/duplicate folders
 * before switching to ID-based tracking.
 *
 * @param {string} existingFolderId - '' if none on file yet.
 * @param {function(string)} onOutcome - called with 'created' | 'renamed' | 'reused' for logging/counting.
 * @return {string} the resolved folder ID.
 */
function resolveNamedFolder_(parentFolder, existingFolderId, expectedName, label, onOutcome) {
  if (!existingFolderId) {
    const newFolder = parentFolder.createFolder(expectedName);
    Logger.log(`Created: ${expectedName} -> ${newFolder.getId()}`);
    onOutcome('created');
    return newFolder.getId();
  }
  try {
    const folder = DriveApp.getFolderById(existingFolderId);
    if (folder.isTrashed()) {
      // getFolderById() still resolves a trashed folder by ID — it doesn't throw — so a deleted
      // archive folder would otherwise silently look "fine" here forever, and worse, invoices
      // would keep quietly filing into an invisible trashed folder (see fileInvoiceToDrive_ in
      // DriveService.gs, which now guards against this too). Treat trashed exactly like missing.
      const newFolder = parentFolder.createFolder(expectedName);
      Logger.log(`${label}'s folder (${existingFolderId}) was deleted (in Trash) — created a replacement: ${expectedName} -> ${newFolder.getId()}`);
      onOutcome('created');
      return newFolder.getId();
    }
    if (folder.getName() !== expectedName) {
      const oldName = folder.getName();
      folder.setName(expectedName);
      Logger.log(`Renamed folder for ${label}: "${oldName}" -> "${expectedName}"`);
      onOutcome('renamed');
      return existingFolderId;
    }
    onOutcome('reused');
    return existingFolderId;
  } catch (err) {
    Logger.log(`WARNING: ${label} has Drive Folder ID "${existingFolderId}" on file, but it's not accessible (${err.message}). Not auto-replacing it — check manually.`);
    onOutcome('reused');
    return existingFolderId;
  }
}

/** Strips a leading "- " (with any spacing) and collapses repeated whitespace, so rows that only
 *  differ by stray formatting (e.g. a pasted "- Forest Edge Commons..." vs "Forest Edge Commons...")
 *  are still recognized as the same subproject name when checking for exact duplicates. */
function normalizeReferenceName_(name) {
  return String(name || '').replace(/^\s*-\s*/, '').replace(/\s+/g, ' ').trim();
}

/**
 * One-time cleanup for "Project Reference": removes rows that are exact duplicates of an earlier
 * row (same Project Number + Subproject Number + Subproject Name, ignoring stray dash/whitespace
 * formatting, and the same or blank Drive Folder ID) — the kind of duplication a CSV/list pasted in
 * more than once produces. Safe to re-run; a clean sheet is a no-op.
 *
 * Deliberately does NOT touch rows that share a Project+Subproject Number but disagree on name or
 * Drive Folder ID (e.g. a unit that changed tenants) — those aren't safe to auto-resolve since
 * picking one over the other could silently discard a real business fact. Those get logged as
 * "CONFLICT" instead so a human decides, never deleted automatically.
 */
function dedupeProjectReference() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEET_REFERENCE_TAB);
  if (!sheet) throw new Error(`Missing "${CONFIG.SHEET_REFERENCE_TAB}" tab.`);

  const values = sheet.getDataRange().getValues();
  const header = values[0];
  const idx = {
    projectNumber: header.indexOf('Project Number'),
    projectName: header.indexOf('Project Name'),
    subprojectNumber: header.indexOf('Subproject Number'),
    subprojectName: header.indexOf('Subproject Name'),
    driveFolderId: header.indexOf('Drive Folder ID')
  };
  Object.keys(idx).forEach(k => {
    if (idx[k] === -1) throw new Error(`"${CONFIG.SHEET_REFERENCE_TAB}" tab is missing a "${k}" column.`);
  });

  const keptByCombo = {}; // "num||sub" -> the kept row (array)
  const seenExact = new Set(); // "num||sub||name||id" already kept, to detect exact repeats
  const kept = [];
  const conflicts = []; // rows that share a combo with a kept row but disagree on name/ID
  let removed = 0;

  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const num = cellToString_(row[idx.projectNumber]);
    if (!num) continue; // skip fully blank rows
    const sub = cellToString_(row[idx.subprojectNumber]);
    const name = normalizeReferenceName_(row[idx.subprojectName]);
    const folderId = cellToString_(row[idx.driveFolderId]);
    const comboKey = num + '||' + sub;
    const exactKey = comboKey + '||' + name.toLowerCase() + '||' + folderId;

    const existing = keptByCombo[comboKey];
    if (!existing) {
      keptByCombo[comboKey] = row;
      seenExact.add(exactKey);
      kept.push(row);
      continue;
    }

    if (seenExact.has(exactKey)) {
      removed++; // true duplicate of a row already kept
      continue;
    }

    const existingName = normalizeReferenceName_(existing[idx.subprojectName]);
    const existingId = cellToString_(existing[idx.driveFolderId]);
    if (existingName.toLowerCase() === name.toLowerCase() && (!existingId || !folderId || existingId === folderId)) {
      // Same name, and IDs agree or one side is just blank — same subproject, safe to treat as a
      // duplicate. Merge in a Drive Folder ID if the kept row is missing one.
      if (!existingId && folderId) existing[idx.driveFolderId] = folderId;
      removed++;
    } else {
      // Disagreement on name or on two different non-blank IDs — don't guess, flag for a human.
      conflicts.push(`Project ${num} / Subproject ${sub}: kept "${existingName}" (${existingId || 'no folder ID'}) — ` +
        `also found "${name}" (${folderId || 'no folder ID'}) at row ${i + 1}.`);
      seenExact.add(exactKey);
      kept.push(row);
    }
  }

  if (removed === 0 && conflicts.length === 0) {
    Logger.log('No duplicate or conflicting rows found in "Project Reference" — nothing to clean up.');
    return;
  }

  if (removed > 0) {
    sheet.getRange(2, 1, sheet.getLastRow() - 1, header.length).clearContent();
    if (kept.length) {
      sheet.getRange(2, 1, kept.length, header.length).setValues(kept);
    }
  }

  Logger.log(`Removed ${removed} duplicate row(s) from "Project Reference". ${kept.length} row(s) remain.`);
  if (conflicts.length) {
    Logger.log(`${conflicts.length} row(s) share a Project/Subproject Number but disagree on name or Drive Folder ID — ` +
      `NOT auto-merged, left in the sheet for manual review:\n` + conflicts.join('\n'));
  }
}

/** Optional: runs syncProjectReferenceFromDrive() automatically once a day, separate from the 15-minute invoice trigger. */
function createSyncTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'syncProjectReferenceFromDrive')
    .forEach(t => ScriptApp.deleteTrigger(t));

  ScriptApp.newTrigger('syncProjectReferenceFromDrive')
    .timeBased()
    .everyDays(1)
    .atHour(6)
    .create();

  Logger.log('Trigger created: syncProjectReferenceFromDrive() will run daily around 6am.');
}
