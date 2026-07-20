/**
 * SheetService.gs
 * Everything that reads/writes the bound Google Sheet: the project reference data,
 * the invoice log, and the error log.
 */

/** Reads the "Project Reference" tab into an array of plain objects. */
function getReferenceData_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEET_REFERENCE_TAB);
  if (!sheet) {
    throw new Error(`Missing "${CONFIG.SHEET_REFERENCE_TAB}" tab. Run setup() first, then import project_reference.csv into it and add Drive Folder IDs.`);
  }
  const values = sheet.getDataRange().getValues();
  const header = values.shift();
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

  return values
    .filter(row => row[idx.projectNumber] !== '')
    .map(row => ({
      projectNumber: String(row[idx.projectNumber]).trim(),
      projectName: String(row[idx.projectName]).trim(),
      subprojectNumber: String(row[idx.subprojectNumber] || '').trim(),
      subprojectName: String(row[idx.subprojectName] || '').trim(),
      driveFolderId: String(row[idx.driveFolderId] || '').trim()
    }));
}

/**
 * Rows from getReferenceData_() with CONFIG.EXCLUDE_PROJECT_NUMBERS (e.g. "00 PROJECT TEMPLATE")
 * removed. Use this — not the raw reference rows — everywhere a project could actually be chosen
 * or matched against (the Gemini schema, findReferenceMatch_/validateMatch_), so a placeholder
 * template row can never become a filing destination even if something upstream returns its number.
 */
function getMatchableReferenceRows_(referenceRows) {
  const excluded = (CONFIG.EXCLUDE_PROJECT_NUMBERS || []).map(normalizeNumberKey_);
  return referenceRows.filter(r => excluded.indexOf(normalizeNumberKey_(r.projectNumber)) === -1);
}

/**
 * Reads the optional "Project Aliases" tab: known alternate names/addresses that map straight to
 * a project (e.g. a street address invoices use instead of the project's marketing name), for
 * cases Gemini can't reliably infer from the Project Reference sheet alone. Returns [] if the tab
 * doesn't exist — this feature is optional, not required for the automation to run.
 */
function getAliasData_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEET_ALIASES_TAB);
  if (!sheet) return [];
  const values = sheet.getDataRange().getValues();
  const header = values.shift() || [];
  const idx = {
    alias: header.indexOf('Alias'),
    projectNumber: header.indexOf('Project Number'),
    subprojectNumber: header.indexOf('Subproject Number')
  };
  if (idx.alias === -1 || idx.projectNumber === -1) return [];

  return values
    .filter(row => row[idx.alias] !== '' && row[idx.projectNumber] !== '')
    .map(row => ({
      alias: String(row[idx.alias]).trim(),
      projectNumber: String(row[idx.projectNumber]).trim(),
      subprojectNumber: idx.subprojectNumber === -1 ? '' : String(row[idx.subprojectNumber] || '').trim()
    }));
}

/**
 * Appends one row to the Invoice Log tab. `data` keys should match CONFIG.LOG_COLUMNS
 * (case-insensitive, order-independent). Auto-fills two columns callers don't need to set
 * themselves: 'Row ID' (a UUID — the stable key the dashboard's manual-edit feature uses to find
 * this exact row later, since row *position* shifts as the sheet grows) and 'Drive File ID'
 * (parsed from the Drive Link, so the edit feature can move the actual file without re-deriving
 * its ID from the URL every time).
 */
function logInvoiceRow_(data) {
  const sheet = getOrCreateSheet_(CONFIG.SHEET_LOG_TAB, CONFIG.LOG_COLUMNS);
  ensureSheetHasColumns_(sheet, CONFIG.LOG_COLUMNS);
  const filled = Object.assign({}, data);
  if (!filled['Row ID']) filled['Row ID'] = Utilities.getUuid();
  if (!filled['Drive File ID']) filled['Drive File ID'] = driveFileIdFromUrl_(filled['Drive Link']);
  sheet.appendRow(buildRowByHeader_(sheet, filled));
}

/**
 * Builds a row array by looking up each field's ACTUAL physical column position from the sheet's
 * real header row — never by CONFIG.LOG_COLUMNS' declared array order. ensureSheetHasColumns_ only
 * ever appends a brand-new column at the very END of the physical sheet, never inserting it to
 * match wherever it happens to sit in the LOG_COLUMNS array. Writing positionally (mapping the
 * array straight into appendRow) silently shifts every value after an inserted column into the
 * wrong cell the moment LOG_COLUMNS is edited to insert something anywhere but the end — this is
 * exactly what happened when 'Date Received' was added as the 2nd element (see
 * repairShiftedInvoiceLogRows for the fix to already-corrupted rows). Header-based lookup is safe
 * regardless of array order or when each column was physically appended.
 */
function buildRowByHeader_(sheet, filled) {
  const header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const row = new Array(header.length).fill('');
  header.forEach((colName, i) => {
    if (filled[colName] !== undefined) row[i] = filled[colName];
  });
  return row;
}

/** Extracts the file ID from a standard Drive file URL ("...file/d/<ID>/view"), or '' if it doesn't match. */
function driveFileIdFromUrl_(url) {
  const m = /\/file\/d\/([^/]+)/.exec(String(url || ''));
  return m ? m[1] : '';
}

/**
 * One-time migration: fills in 'Row ID' and 'Drive File ID' for any Invoice Log rows logged before
 * those columns existed, so the dashboard's manual-edit feature (which looks up rows by Row ID)
 * works on old invoices too, not just ones processed from now on. Safe to re-run — only touches
 * blank cells. Run once from the function dropdown after deploying this update.
 */
function backfillLogRowIds() {
  const sheet = getOrCreateSheet_(CONFIG.SHEET_LOG_TAB, CONFIG.LOG_COLUMNS);
  ensureSheetHasColumns_(sheet, CONFIG.LOG_COLUMNS);

  const values = sheet.getDataRange().getValues();
  const header = values[0];
  const idx = {
    rowId: header.indexOf('Row ID'),
    driveFileId: header.indexOf('Drive File ID'),
    driveLink: header.indexOf('Drive Link')
  };

  let filled = 0;
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    if (row.every(cell => cell === '')) continue; // skip fully blank rows
    let touched = false;
    if (!row[idx.rowId]) {
      sheet.getRange(i + 1, idx.rowId + 1).setValue(Utilities.getUuid());
      touched = true;
    }
    if (!row[idx.driveFileId] && row[idx.driveLink]) {
      const fileId = driveFileIdFromUrl_(row[idx.driveLink]);
      if (fileId) {
        sheet.getRange(i + 1, idx.driveFileId + 1).setValue(fileId);
        touched = true;
      }
    }
    if (touched) filled++;
  }

  Logger.log(`Backfilled Row ID/Drive File ID on ${filled} existing Invoice Log row(s).`);
}

/**
 * One-time repair for rows written by the buggy positional logInvoiceRow_ (fixed above — see
 * buildRowByHeader_) between when 'Date Received' was added as the 2nd element of
 * CONFIG.LOG_COLUMNS and when that fix went live. Every value from 'Vendor' onward silently landed
 * one column off from its header for that window — e.g. the "Vendor" cell actually held the Due
 * Date value, "Project Number" held the real vendor name, and so on all the way down the row.
 *
 * Detection: a correctly-written row's "Status" cell is always exactly one of the known status
 * values. A shifted row's "Status" cell instead holds whatever 'Currency' would have been (a code
 * like "CAD") — essentially never a false positive, so this is safe to run without manually
 * flagging which rows are affected.
 *
 * Repair: reinterpret the row's physical values positionally as CONFIG.LOG_COLUMNS order (exactly
 * how the buggy code wrote them), then rewrite them into their correct column via the same
 * header-based lookup the fixed logInvoiceRow_ now uses. Only commits the fix if it actually
 * produces a valid Status afterward — refuses to touch a row that doesn't match the expected shift
 * pattern rather than risk corrupting it further. Never deletes or reprocesses anything.
 */
function repairShiftedInvoiceLogRows() {
  const sheet = getOrCreateSheet_(CONFIG.SHEET_LOG_TAB, CONFIG.LOG_COLUMNS);
  const VALID_STATUSES = ['Filed', 'Needs Review', 'Not an Invoice', 'Past Due'];

  const range = sheet.getDataRange();
  const values = range.getValues();
  const header = values[0];
  const statusIdx = header.indexOf('Status');
  if (statusIdx === -1) throw new Error('Missing "Status" column — nothing to repair against.');

  let checked = 0, repaired = 0, unrepairable = 0;
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    if (row.every(cell => cell === '')) continue;
    checked++;

    const currentStatus = String(row[statusIdx] || '').trim();
    if (VALID_STATUSES.indexOf(currentStatus) !== -1) continue; // already correct, leave alone

    const recovered = {};
    CONFIG.LOG_COLUMNS.forEach((fieldName, idx) => {
      if (idx < row.length) recovered[fieldName] = row[idx];
    });
    const correctedRow = buildRowByHeader_(sheet, recovered);

    const newStatus = String(correctedRow[statusIdx] || '').trim();
    if (VALID_STATUSES.indexOf(newStatus) === -1) {
      unrepairable++;
      continue; // doesn't match the expected shift pattern — leave untouched rather than guess
    }

    sheet.getRange(i + 1, 1, 1, correctedRow.length).setValues([correctedRow]);
    repaired++;
  }

  Logger.log(`Checked ${checked} row(s). Repaired ${repaired} shifted row(s). ` +
    `${unrepairable} row(s) had an invalid Status but didn't match the expected shift pattern — left untouched, review manually.`);
}

/**
 * One-time migration: fills in 'Date Received' for existing Invoice Log rows logged before that
 * column existed, by re-fetching each row's thread from Gmail (via the thread ID embedded in its
 * Gmail Link) and using the thread's first message date as an approximation. New rows going forward
 * log the exact originating message's date directly (see Main.gs/processOneInvoice_) — this backfill
 * is necessarily approximate for a thread where different attachments came from different messages,
 * since that detail isn't recoverable from the sheet alone. Only touches blank cells; safe to re-run.
 */
function backfillDateReceived() {
  const sheet = getOrCreateSheet_(CONFIG.SHEET_LOG_TAB, CONFIG.LOG_COLUMNS);
  ensureSheetHasColumns_(sheet, CONFIG.LOG_COLUMNS);

  const values = sheet.getDataRange().getValues();
  const header = values[0];
  const idx = {
    dateReceived: header.indexOf('Date Received'),
    gmailLink: header.indexOf('Gmail Link')
  };

  let filled = 0, skippedNoLink = 0, skippedNotFound = 0;
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    if (row.every(cell => cell === '')) continue; // skip fully blank rows
    if (row[idx.dateReceived]) continue; // already has a value

    const link = String(row[idx.gmailLink] || '');
    const m = /#all\/([^/?&]+)/.exec(link);
    if (!m) { skippedNoLink++; continue; }

    try {
      const thread = GmailApp.getThreadById(m[1]);
      const messages = thread ? thread.getMessages() : [];
      if (!messages.length) { skippedNotFound++; continue; }
      sheet.getRange(i + 1, idx.dateReceived + 1).setValue(messages[0].getDate());
      filled++;
    } catch (err) {
      skippedNotFound++;
    }
  }

  Logger.log(`Backfilled Date Received on ${filled} row(s). ${skippedNoLink} skipped (no usable Gmail Link), ${skippedNotFound} skipped (thread not found/inaccessible).`);
}

/**
 * A case/punctuation/legal-suffix-insensitive key for a vendor name, used to decide whether two
 * spellings are the SAME vendor. "Copp's Buildall", "COPPS BUILDALL", "Copps Buildall Ltd." all
 * collapse to "COPPSBUILDALL". Crucially, distinguishing words are kept, so "J-AAR Civil" ->
 * "JAARCIVIL" and "J-AAR Structure" -> "JAARSTRUCTURE" stay DIFFERENT — the exact separation the
 * user asked to preserve. Returns '' for an effectively empty name.
 */
function vendorNormalizedKey_(name) {
  let s = String(name == null ? '' : name).toUpperCase();
  // Drop trailing legal-entity suffixes as whole words so "... LTD"/"... INC" match the bare name.
  s = s.replace(/\b(LTD|INC|LIMITED|INCORPORATED|CORP|CORPORATION|LLC|LLP|LP|ULC|CO|COMPANY)\b/g, ' ');
  return s.replace(/[^A-Z0-9]/g, ''); // keep only letters/digits — kills spaces, hyphens, apostrophes, dots
}

/**
 * Resolves a raw extracted vendor name to ONE canonical spelling, maintaining the "Vendor
 * Directory" tab as it goes. Same normalized key -> reuse the existing canonical name (and record
 * the new variant + bump the count); new key -> the raw name becomes the canonical entry. Keeps
 * logged vendor names and filenames from drifting across spellings of the same company, while
 * genuinely different vendors/divisions (different key) get their own row. Real-run only — callers
 * in Test.gs deliberately don't invoke this, so previews never write to the directory.
 *
 * @param {string} rawName - Gemini's extracted vendor_name
 * @return {string} the canonical display name to use for logging and filing
 */
function canonicalizeVendorName_(rawName) {
  const raw = String(rawName == null ? '' : rawName).replace(/\s+/g, ' ').trim();
  if (!raw) return 'UnknownVendor';
  const key = vendorNormalizedKey_(raw);
  if (!key) return raw; // nothing normalizable (e.g. all punctuation) — don't pollute the directory

  const sheet = getOrCreateSheet_(CONFIG.SHEET_VENDOR_DIRECTORY_TAB, CONFIG.VENDOR_DIRECTORY_COLUMNS);
  ensureSheetHasColumns_(sheet, CONFIG.VENDOR_DIRECTORY_COLUMNS);
  const values = sheet.getDataRange().getValues();
  const header = values[0];
  const idx = {
    canonical: header.indexOf('Canonical Name'),
    key: header.indexOf('Normalized Key'),
    times: header.indexOf('Times Seen'),
    variants: header.indexOf('Variants Seen')
  };

  for (let i = 1; i < values.length; i++) {
    if (String(values[i][idx.key]) === key) {
      const canonical = String(values[i][idx.canonical] || '').trim() || raw;
      if (idx.times > -1) sheet.getRange(i + 1, idx.times + 1).setValue((Number(values[i][idx.times]) || 0) + 1);
      // Record this spelling as a seen variant if it differs from the canonical one (audit trail;
      // also makes it obvious if two spellings SHOULD have been separate vendors but got merged).
      if (idx.variants > -1 && raw !== canonical) {
        const seen = String(values[i][idx.variants] || '');
        const list = seen ? seen.split(' | ') : [];
        if (list.indexOf(raw) === -1) {
          list.push(raw);
          sheet.getRange(i + 1, idx.variants + 1).setValue(list.join(' | '));
        }
      }
      return canonical;
    }
  }

  // First time we've seen this vendor — its current spelling becomes the canonical one.
  sheet.appendRow(buildRowByHeader_(sheet, {
    'Canonical Name': raw, 'Normalized Key': key, 'First Seen': new Date(), 'Times Seen': 1, 'Variants Seen': ''
  }));
  return raw;
}

/**
 * Reads the Override Log into a per-vendor correction summary used by Main.gs/applyVendorMemory_.
 * Keyed by vendorNormalizedKey_ (so spelling variants of one vendor pool together, but J-AAR Civil
 * vs Structure stay separate). For each vendor, tallies which project its invoices were corrected
 * TO, and marks a "dominant" project only when one project is the strict plurality AND meets
 * CONFIG.VENDOR_MEMORY_MIN_CORRECTIONS — so a vendor split evenly across projects yields no
 * dominant (memory stays silent rather than guessing). Returns {} if disabled or nothing logged.
 *
 * @return {Object} normalizedVendorKey -> { dominantProject: string|null, dominantCount: number }
 */
function buildVendorMemory_() {
  const memory = {};
  if (CONFIG.VENDOR_MEMORY_MIN_CORRECTIONS == null) return memory;
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEET_OVERRIDE_LOG_TAB);
  if (!sheet) return memory;
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return memory;
  const header = values[0];
  const vIdx = header.indexOf('Vendor');
  const pIdx = header.indexOf('To Project');
  if (vIdx === -1 || pIdx === -1) return memory;

  const tally = {}; // vendorKey -> { normProj -> { count, raw } }
  for (let i = 1; i < values.length; i++) {
    const vendor = String(values[i][vIdx] == null ? '' : values[i][vIdx]).trim();
    const rawProj = String(values[i][pIdx] == null ? '' : values[i][pIdx]).trim();
    if (!vendor || !rawProj) continue; // only rows that actually set a project count as project corrections
    const vKey = vendorNormalizedKey_(vendor);
    if (!vKey) continue;
    const pKey = normalizeNumberKey_(rawProj);
    if (!tally[vKey]) tally[vKey] = {};
    if (!tally[vKey][pKey]) tally[vKey][pKey] = { count: 0, raw: rawProj };
    tally[vKey][pKey].count++;
    tally[vKey][pKey].raw = rawProj; // keep a valid reference-style project number to match on later
  }

  Object.keys(tally).forEach(vKey => {
    const projs = tally[vKey];
    let bestRaw = null, bestN = 0, tie = false;
    Object.keys(projs).forEach(pKey => {
      const n = projs[pKey].count;
      if (n > bestN) { bestRaw = projs[pKey].raw; bestN = n; tie = false; }
      else if (n === bestN) { tie = true; }
    });
    memory[vKey] = {
      dominantProject: (!tie && bestN >= CONFIG.VENDOR_MEMORY_MIN_CORRECTIONS) ? bestRaw : null,
      dominantCount: bestN
    };
  });
  return memory;
}

/**
 * A stable identity key for an invoice, used to detect duplicates (the same bill filed more than
 * once). Prefers canonical vendor + invoice number — the natural unique key for a bill. When there's
 * no invoice number, falls back to vendor + amount + invoice date so a numberless statement/bill
 * still dedupes sensibly without colliding across genuinely different documents. Returns '' when
 * there's not even a vendor to key on (then the caller shouldn't dedupe — better to keep it than
 * risk dropping a real invoice).
 */
function invoiceIdentityKey_(vendorName, invoiceNumber, amount, invoiceDate) {
  const vKey = vendorNormalizedKey_(vendorName);
  if (!vKey) return '';
  const inv = String(invoiceNumber == null ? '' : invoiceNumber).replace(/\s+/g, '').toUpperCase();
  if (inv) return vKey + '|#' + inv;
  const amt = Number(amount) || 0;
  const date = String(invoiceDate == null ? '' : invoiceDate).trim();
  return vKey + '|$' + amt + '|' + date;
}

/**
 * Builds a map of identity key -> { noticed, driveLink, driveFileId } for every invoice already in
 * the Invoice Log, so a run can tell whether an invoice it just extracted has been filed before
 * (across earlier runs too, not just within this one) AND point a duplicate notice at where the
 * original was filed. `noticed` is true once a "Duplicate" marker row already exists for that key,
 * so re-receipts don't stack endless notices. `driveLink`/`driveFileId` come from the original
 * (non-Duplicate) row. Read once per run (see Main.gs/processInvoicesInner_).
 */
function buildInvoiceKeySet_() {
  const map = {};
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEET_LOG_TAB);
  if (!sheet) return map;
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return map;
  const header = values[0];
  const vIdx = header.indexOf('Vendor');
  const iIdx = header.indexOf('Invoice Number');
  const aIdx = header.indexOf('Amount');
  const dIdx = header.indexOf('Invoice Date');
  const sIdx = header.indexOf('Status');
  const lIdx = header.indexOf('Drive Link');
  const fIdx = header.indexOf('Drive File ID');
  if (vIdx === -1) return map;
  for (let r = 1; r < values.length; r++) {
    const key = invoiceIdentityKey_(
      values[r][vIdx], iIdx > -1 ? values[r][iIdx] : '',
      aIdx > -1 ? values[r][aIdx] : '', dIdx > -1 ? values[r][dIdx] : '');
    if (!key) continue;
    if (!map[key]) map[key] = { noticed: false, driveLink: '', driveFileId: '' };
    const status = sIdx > -1 ? String(values[r][sIdx] || '').trim() : '';
    if (status === 'Duplicate') {
      map[key].noticed = true; // a "received again" marker already exists — don't add another
    } else if (!map[key].driveLink) {
      map[key].driveLink = lIdx > -1 ? String(values[r][lIdx] || '') : '';
      map[key].driveFileId = fIdx > -1 ? String(values[r][fIdx] || '') : '';
    }
  }
  return map;
}

/**
 * One-time cleanup: removes duplicate rows from the Invoice Log — same invoice identity
 * (invoiceIdentityKey_) logged more than once — keeping the EARLIEST row (by sheet order) and
 * trashing the redundant later copies' Drive files if they're a distinct file from the kept one.
 * Trash is recoverable, and only exact-identity duplicates are touched. Safe to re-run.
 */
function dedupeInvoiceLog() {
  const sheet = getOrCreateSheet_(CONFIG.SHEET_LOG_TAB, CONFIG.LOG_COLUMNS);
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) { Logger.log('Invoice Log has no data rows — nothing to dedupe.'); return; }
  const header = values[0];
  const idx = {};
  ['Vendor', 'Invoice Number', 'Amount', 'Invoice Date', 'Drive File ID', 'Status'].forEach(c => { idx[c] = header.indexOf(c); });

  const seen = {};            // identity key -> kept row's Drive File ID
  const keptRows = [header];
  const trashFileIds = [];    // distinct duplicate copies to trash
  let removed = 0;

  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    if (row.every(c => c === '')) continue;
    // Leave intentional "Duplicate" marker rows alone — they're informational, not accidental dupes.
    if (idx['Status'] > -1 && String(row[idx['Status']] || '').trim() === 'Duplicate') { keptRows.push(row); continue; }
    const key = invoiceIdentityKey_(row[idx['Vendor']], idx['Invoice Number'] > -1 ? row[idx['Invoice Number']] : '',
      idx['Amount'] > -1 ? row[idx['Amount']] : '', idx['Invoice Date'] > -1 ? row[idx['Invoice Date']] : '');
    if (key && seen.hasOwnProperty(key)) {
      removed++;
      const dupFileId = idx['Drive File ID'] > -1 ? String(row[idx['Drive File ID']] || '').trim() : '';
      if (dupFileId && dupFileId !== seen[key]) trashFileIds.push(dupFileId); // a separate redundant copy
      continue; // drop this duplicate row
    }
    if (key) seen[key] = idx['Drive File ID'] > -1 ? String(row[idx['Drive File ID']] || '').trim() : '';
    keptRows.push(row);
  }

  if (removed === 0) { Logger.log('No duplicate invoice rows found.'); return; }

  // Rewrite the sheet with duplicates removed.
  sheet.getRange(2, 1, sheet.getLastRow() - 1, header.length).clearContent();
  if (keptRows.length > 1) sheet.getRange(2, 1, keptRows.length - 1, header.length).setValues(keptRows.slice(1));

  // Trash the redundant Drive copies (recoverable). Best-effort — a missing/inaccessible file
  // shouldn't stop the rest.
  let trashed = 0;
  trashFileIds.forEach(fid => {
    try { DriveApp.getFileById(fid).setTrashed(true); trashed++; } catch (e) { /* already gone / no access */ }
  });

  Logger.log(`Removed ${removed} duplicate Invoice Log row(s); trashed ${trashed} redundant Drive file copy/copies (recoverable from Trash).`);
}

/** Appends one row to the "Feedback" tab. Called from the dashboard — open to any viewer, not gated. */
function logFeedback_(message, pageContext) {
  const sheet = getOrCreateSheet_(CONFIG.SHEET_FEEDBACK_TAB, CONFIG.FEEDBACK_COLUMNS);
  sheet.appendRow([new Date(), message, pageContext || '']);
}

/**
 * Records one manual correction to the "Override Log" tab — the automation's original values vs.
 * what a human changed them to. This is the correction dataset the system "remembers": patterns
 * here (e.g. a vendor repeatedly re-assigned to the same project) are what any future auto-learning
 * would act on, and it's an immediate audit trail regardless. Header-keyed write so column order
 * can evolve safely (see buildRowByHeader_).
 */
function logOverride_(o) {
  const sheet = getOrCreateSheet_(CONFIG.SHEET_OVERRIDE_LOG_TAB, CONFIG.OVERRIDE_LOG_COLUMNS);
  ensureSheetHasColumns_(sheet, CONFIG.OVERRIDE_LOG_COLUMNS);
  sheet.appendRow(buildRowByHeader_(sheet, {
    'Timestamp': new Date(),
    'Row ID': o.rowId || '',
    'Vendor': o.vendor || '',
    'Invoice Number': o.invoiceNumber || '',
    'Amount': o.amount || '',
    'From Project': o.fromProject || '',
    'From Subproject': o.fromSubproject || '',
    'From Status': o.fromStatus || '',
    'Original Confidence': o.originalConfidence || '',
    'To Project': o.toProject || '',
    'To Subproject': o.toSubproject || '',
    'To Status': o.toStatus || ''
  }));
}

/**
 * Adds any header names in `requiredHeaders` that aren't already present in `sheet`'s row 1,
 * appending them as new columns at the end. Lets CONFIG.LOG_COLUMNS grow over time (e.g. the
 * "Match Note" column) without anyone needing to manually edit an already-existing sheet.
 */
function ensureSheetHasColumns_(sheet, requiredHeaders) {
  const lastCol = Math.max(sheet.getLastColumn(), 1);
  const existing = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(h => String(h).trim());
  const missing = requiredHeaders.filter(h => existing.indexOf(h) === -1);
  if (missing.length) {
    sheet.getRange(1, existing.length + 1, 1, missing.length).setValues([missing]);
  }
}

/** Appends one row to the Errors tab. */
function logError_(context, errorMessage, gmailLink) {
  const sheet = getOrCreateSheet_(CONFIG.SHEET_ERRORS_TAB, ['Timestamp', 'Context', 'Error', 'Gmail Link']);
  sheet.appendRow([new Date(), context, errorMessage, gmailLink || '']);
}

/** Gets a tab by name, creating it with a header row if it doesn't exist yet. */
function getOrCreateSheet_(name, header) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(header);
    sheet.setFrozenRows(1);
  }
  return sheet;
}
