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

const INVOICE_ARCHIVE_PARENT_FOLDER_ID = '17X2BqaT4GxhrqAUjAWbV-d_QnkpCAHfb'; // "Outputs" folder in Drive
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
 * and that the Drive Folder ID column is filled in for all its rows. ID-based idempotency: a
 * project that already has an ID on file keeps that exact ID (never re-derived from a folder-name
 * search), and its archive folder gets renamed to match the current project name if they've drifted.
 */
function createInvoiceArchiveFolders() {
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
    driveFolderId: header.indexOf('Drive Folder ID')
  };
  Object.keys(idx).forEach(k => {
    if (idx[k] === -1) throw new Error(`"${CONFIG.SHEET_REFERENCE_TAB}" tab is missing a "${k}" column.`);
  });

  // Unique project number -> { name, existingFolderId } (first non-blank value seen for each).
  const projects = {};
  for (let i = 1; i < values.length; i++) {
    const num = cellToString_(values[i][idx.projectNumber]);
    if (!num || IGNORED_PROJECT_NUMBERS.has(num)) continue;
    const name = cellToString_(values[i][idx.projectName]);
    const fid = cellToString_(values[i][idx.driveFolderId]);
    if (!projects[num]) projects[num] = { name: '', existingFolderId: '' };
    if (name && !projects[num].name) projects[num].name = name;
    if (fid && !projects[num].existingFolderId) projects[num].existingFolderId = fid;
  }

  const resolvedFolderId = {}; // projectNumber -> folder ID (existing or newly created)
  let createdCount = 0, renamedCount = 0, reusedCount = 0;

  Object.keys(projects).sort().forEach(projectNumber => {
    const { name, existingFolderId } = projects[projectNumber];
    const expectedName = `${projectNumber} - ${name}`;

    if (existingFolderId) {
      // Already provisioned — reuse the ID as-is (unless it's been trashed), just keep the folder name in sync.
      try {
        const folder = DriveApp.getFolderById(existingFolderId);
        if (folder.isTrashed()) {
          // getFolderById() still resolves a trashed folder by ID — it doesn't throw — so a deleted
          // archive folder would otherwise silently look "fine" here forever, and worse, invoices
          // would keep quietly filing into an invisible trashed folder (see fileInvoiceToDrive_ in
          // DriveService.gs, which now guards against this too). Treat trashed exactly like missing.
          const newFolder = parentFolder.createFolder(expectedName);
          resolvedFolderId[projectNumber] = newFolder.getId();
          Logger.log(`Project ${projectNumber}'s folder (${existingFolderId}) was deleted (in Trash) — created a replacement: ${expectedName} -> ${newFolder.getId()}`);
          createdCount++;
        } else if (folder.getName() !== expectedName) {
          const oldName = folder.getName();
          folder.setName(expectedName);
          Logger.log(`Renamed folder for project ${projectNumber}: "${oldName}" -> "${expectedName}"`);
          renamedCount++;
          resolvedFolderId[projectNumber] = existingFolderId;
        } else {
          reusedCount++;
          resolvedFolderId[projectNumber] = existingFolderId;
        }
      } catch (err) {
        Logger.log(`WARNING: project ${projectNumber} has Drive Folder ID "${existingFolderId}" on file, but it's not accessible (${err.message}). Not auto-replacing it — check manually.`);
        resolvedFolderId[projectNumber] = existingFolderId;
      }
    } else {
      // No ID on file yet — create a fresh folder. (Never matched by searching for an existing
      // folder with this name — that's what caused mismatched/duplicate folders before.)
      const newFolder = parentFolder.createFolder(expectedName);
      resolvedFolderId[projectNumber] = newFolder.getId();
      Logger.log(`Created: ${expectedName} -> ${newFolder.getId()}`);
      createdCount++;
    }
  });

  // Write/refresh the Drive Folder ID column for every row.
  let updatedCount = 0;
  for (let i = 1; i < values.length; i++) {
    const num = cellToString_(values[i][idx.projectNumber]);
    if (!num || !resolvedFolderId[num]) continue;
    const currentValue = cellToString_(values[i][idx.driveFolderId]);
    if (currentValue !== resolvedFolderId[num]) {
      sheet.getRange(i + 1, idx.driveFolderId + 1).setValue(resolvedFolderId[num]);
      updatedCount++;
    }
  }

  Logger.log(`Done. ${createdCount} folder(s) created, ${renamedCount} renamed, ${reusedCount} already up to date. ${updatedCount} row(s) had their Drive Folder ID written/refreshed.`);
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
