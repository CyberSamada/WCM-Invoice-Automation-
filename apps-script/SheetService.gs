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
 * The knowledge-seed guard flag. The "Project Aliases" and "AI Notes" tabs are the single runtime
 * home for aliases and extraction notes; the code seeds (AliasSeed.gs/SEED_ALIASES,
 * ExtractionNotes.gs/SEED_EXTRACTION_NOTES) are shipped DEFAULTS that are copied into those tabs
 * exactly once, then never consulted again. This Script Property records that the one-time copy has
 * happened, so a later hand-deletion of a seeded row sticks (it's never re-added).
 */
const KNOWLEDGE_SEEDED_PROPERTY = 'KNOWLEDGE_SEEDED';

/**
 * One-time migration of the code seeds into their sheet tabs, so the tabs become the sole editable
 * home with no manual import and no deploy-order gap (a fresh deploy still lands the shipped
 * defaults). Guarded by KNOWLEDGE_SEEDED_PROPERTY: does real work only on the first call ever, then
 * flips the flag and is a no-op forever after. Idempotent even within that first call — only seed
 * rows MISSING from a tab are appended (dedupe: aliases by alias+project, notes case-insensitively),
 * so it never doubles an alias a person already added. Best-effort: any failure is swallowed and the
 * flag left unset so a later call can retry — a seeding hiccup must never block extraction or the
 * dashboard.
 *
 * Force a re-run (e.g. to restore a default someone deleted) with reseedKnowledge() in Setup.gs,
 * which clears the flag first.
 */
function ensureKnowledgeSeeded_() {
  try {
    const props = PropertiesService.getScriptProperties();
    if (props.getProperty(KNOWLEDGE_SEEDED_PROPERTY) === 'true') return;

    // Aliases -> "Project Aliases" tab.
    if (typeof SEED_ALIASES !== 'undefined' && SEED_ALIASES.length) {
      const sheet = getOrCreateSheet_(CONFIG.SHEET_ALIASES_TAB, CONFIG.ALIAS_COLUMNS);
      ensureSheetHasColumns_(sheet, CONFIG.ALIAS_COLUMNS);
      const values = sheet.getDataRange().getValues();
      const header = values.shift() || [];
      const ai = header.indexOf('Alias');
      const pi = header.indexOf('Project Number');
      const existing = {};
      if (ai > -1 && pi > -1) {
        values.forEach(row => {
          const k = String(row[ai] || '').trim().toLowerCase() + '|' + String(row[pi] || '').trim();
          if (k !== '|') existing[k] = true;
        });
      }
      SEED_ALIASES.forEach(a => {
        const alias = String(a[0] || '').trim();
        const proj = String(a[1] || '').trim();
        if (!alias || !proj) return;
        if (existing[alias.toLowerCase() + '|' + proj]) return;
        sheet.appendRow(buildRowByHeader_(sheet, {
          'Alias': alias, 'Project Number': proj, 'Subproject Number': String(a[2] || '').trim(), 'Base': 'TRUE'
        }));
      });
    }

    // Extraction notes -> "AI Notes" tab.
    if (typeof SEED_EXTRACTION_NOTES !== 'undefined' && SEED_EXTRACTION_NOTES.length) {
      const notesSheet = getOrCreateSheet_(CONFIG.SHEET_AI_NOTES_TAB, CONFIG.AI_NOTES_COLUMNS);
      ensureSheetHasColumns_(notesSheet, CONFIG.AI_NOTES_COLUMNS);
      const nValues = notesSheet.getDataRange().getValues();
      const nHeader = nValues.shift() || [];
      const ni = nHeader.indexOf('Note');
      const existingNotes = {};
      if (ni > -1) nValues.forEach(row => {
        const t = String(row[ni] || '').trim().toLowerCase();
        if (t) existingNotes[t] = true;
      });
      SEED_EXTRACTION_NOTES.forEach(note => {
        const t = String(note || '').trim();
        if (!t) return;
        if (existingNotes[t.toLowerCase()]) return;
        notesSheet.appendRow(buildRowByHeader_(notesSheet, { 'Note': t }));
      });
    }

    props.setProperty(KNOWLEDGE_SEEDED_PROPERTY, 'true');
  } catch (e) { /* leave the flag unset so a later call retries — never block the caller */ }
}

/** True for a "Base" cell that means canon — a boolean checkbox TRUE or the text "TRUE"/"yes"/"1". */
function isBaseFlag_(value) {
  if (value === true) return true;
  const s = String(value == null ? '' : value).trim().toLowerCase();
  return s === 'true' || s === 'yes' || s === '1';
}

/** Guard flag for the one-time base-alias backfill (see ensureBaseAliases_). */
const BASE_ALIASES_ENSURED_PROPERTY = 'BASE_ALIASES_ENSURED';

/**
 * One-time backfill that establishes the CANON ("Base") alias set in the "Project Aliases" tab: for
 * every shipped SEED_ALIASES entry, make sure a matching (alias+project) row exists and its "Base"
 * cell is TRUE. This is what makes the shipped address→project defaults un-deletable in Manage hints
 * (removeProjectAlias refuses a Base row) while still editable. Runs ONCE (guarded), because after
 * the flag is stamped base-ness lives on the row's Base cell — so a coordinator who EDITS a base
 * hint's text keeps it canon, and we never re-derive membership from the seed text again (which would
 * duplicate an edited row). Needed as a separate pass from ensureKnowledgeSeeded_ because the tab was
 * seeded before the Base column existed. Best-effort; a hiccup leaves the flag unset to retry.
 */
function ensureBaseAliases_() {
  try {
    const props = PropertiesService.getScriptProperties();
    if (props.getProperty(BASE_ALIASES_ENSURED_PROPERTY) === 'true') return;
    if (typeof SEED_ALIASES === 'undefined' || !SEED_ALIASES.length) { props.setProperty(BASE_ALIASES_ENSURED_PROPERTY, 'true'); return; }

    const sheet = getOrCreateSheet_(CONFIG.SHEET_ALIASES_TAB, CONFIG.ALIAS_COLUMNS);
    ensureSheetHasColumns_(sheet, CONFIG.ALIAS_COLUMNS);
    const values = sheet.getDataRange().getValues();
    const header = values[0] || [];
    const ai = header.indexOf('Alias');
    const pi = header.indexOf('Project Number');
    const bi = header.indexOf('Base');
    if (ai === -1 || pi === -1 || bi === -1) return; // columns not ready — retry next call

    // Index existing rows by normalized alias+project.
    const rowByKey = {};
    for (let r = 1; r < values.length; r++) {
      const k = String(values[r][ai] || '').trim().toLowerCase() + '|' + normalizeNumberKey_(values[r][pi]);
      if (k !== '|') rowByKey[k] = r + 1; // 1-based sheet row
    }

    SEED_ALIASES.forEach(a => {
      const alias = String(a[0] || '').trim();
      const proj = String(a[1] || '').trim();
      if (!alias || !proj) return;
      const key = alias.toLowerCase() + '|' + normalizeNumberKey_(proj);
      const rowNum = rowByKey[key];
      if (rowNum) {
        sheet.getRange(rowNum, bi + 1).setValue('TRUE'); // flag the existing seeded row as canon
      } else {
        // A canon default someone removed before it was protected — restore it, flagged.
        sheet.appendRow(buildRowByHeader_(sheet, {
          'Alias': alias, 'Project Number': proj, 'Subproject Number': String(a[2] || '').trim(), 'Base': 'TRUE'
        }));
      }
    });

    props.setProperty(BASE_ALIASES_ENSURED_PROPERTY, 'true');
  } catch (e) { /* additive — never block the caller; leave flag unset to retry */ }
}

/**
 * Known alternate names/addresses that map straight to a project (e.g. a street address invoices use
 * instead of the project's marketing name), for cases Gemini can't reliably infer from the Project
 * Reference sheet alone. The "Project Aliases" tab is now the SOLE source — the code seed
 * (AliasSeed.gs/SEED_ALIASES) is migrated into that tab once by ensureKnowledgeSeeded_ (called here),
 * after which the tab is the single editable home (dashboard "Manage hints" writes to it). Deduped by
 * alias (case-insensitive) + project number.
 */
function getAliasData_() {
  ensureKnowledgeSeeded_();
  ensureBaseAliases_();
  const out = [];
  const seen = {};
  const add = (alias, projectNumber, subprojectNumber, base) => {
    const a = String(alias == null ? '' : alias).trim();
    const p = String(projectNumber == null ? '' : projectNumber).trim();
    if (!a || !p) return;
    const key = a.toLowerCase() + '|' + p;
    if (seen[key]) return;
    seen[key] = true;
    out.push({ alias: a, projectNumber: p, subprojectNumber: String(subprojectNumber == null ? '' : subprojectNumber).trim(), base: !!base });
  };

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEET_ALIASES_TAB);
  if (sheet) {
    const values = sheet.getDataRange().getValues();
    const header = values.shift() || [];
    const ai = header.indexOf('Alias');
    const pi = header.indexOf('Project Number');
    const si = header.indexOf('Subproject Number');
    const bi = header.indexOf('Base');
    if (ai > -1 && pi > -1) {
      values.forEach(row => add(row[ai], row[pi], si === -1 ? '' : row[si], bi === -1 ? false : isBaseFlag_(row[bi])));
    }
  }

  return out;
}

/**
 * Appends one alias row to the "Project Aliases" tab (header-keyed, so column order can evolve), if
 * an identical alias+project isn't already present. Returns true if a row was added, false if it was
 * a duplicate. Used by the dashboard's "Manage hints" manager and the learn-while-fixing field.
 */
function appendAliasRow_(alias, projectNumber, subprojectNumber) {
  const a = String(alias == null ? '' : alias).trim();
  const p = String(projectNumber == null ? '' : projectNumber).trim();
  if (!a || !p) return false;
  const sheet = getOrCreateSheet_(CONFIG.SHEET_ALIASES_TAB, CONFIG.ALIAS_COLUMNS);
  ensureSheetHasColumns_(sheet, CONFIG.ALIAS_COLUMNS);
  const values = sheet.getDataRange().getValues();
  const header = values.shift() || [];
  const ai = header.indexOf('Alias');
  const pi = header.indexOf('Project Number');
  if (ai > -1 && pi > -1) {
    const dup = values.some(row =>
      String(row[ai] || '').trim().toLowerCase() === a.toLowerCase() &&
      String(row[pi] || '').trim() === p);
    if (dup) return false;
  }
  sheet.appendRow(buildRowByHeader_(sheet, {
    'Alias': a, 'Project Number': p, 'Subproject Number': String(subprojectNumber == null ? '' : subprojectNumber).trim(), 'Base': ''
  }));
  return true;
}

/** True if the "Project Aliases" row for this alias+project is flagged Base (canon). */
function aliasRowIsBase_(alias, projectNumber) {
  const a = String(alias == null ? '' : alias).trim().toLowerCase();
  const p = normalizeNumberKey_(projectNumber);
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEET_ALIASES_TAB);
  if (!sheet) return false;
  const values = sheet.getDataRange().getValues();
  const header = values[0] || [];
  const ai = header.indexOf('Alias');
  const pi = header.indexOf('Project Number');
  const bi = header.indexOf('Base');
  if (ai === -1 || pi === -1 || bi === -1) return false;
  for (let r = 1; r < values.length; r++) {
    if (String(values[r][ai] || '').trim().toLowerCase() === a &&
        normalizeNumberKey_(values[r][pi]) === p) {
      return isBaseFlag_(values[r][bi]);
    }
  }
  return false;
}

/**
 * Edits an existing "Project Aliases" row IN PLACE: finds the row by its current alias+project and
 * rewrites its Alias and Subproject Number (the Base flag is preserved). Returns true if a row was
 * updated. Used by Manage hints to refine a hint — including a canon (Base) one — without deleting it.
 */
function updateAliasRow_(oldAlias, projectNumber, newAlias, newSubprojectNumber) {
  const oa = String(oldAlias == null ? '' : oldAlias).trim().toLowerCase();
  const p = normalizeNumberKey_(projectNumber);
  const na = String(newAlias == null ? '' : newAlias).trim();
  if (!oa || !p || !na) return false;
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEET_ALIASES_TAB);
  if (!sheet) return false;
  const values = sheet.getDataRange().getValues();
  const header = values[0] || [];
  const ai = header.indexOf('Alias');
  const pi = header.indexOf('Project Number');
  const si = header.indexOf('Subproject Number');
  if (ai === -1 || pi === -1) return false;
  for (let r = 1; r < values.length; r++) {
    if (String(values[r][ai] || '').trim().toLowerCase() === oa &&
        normalizeNumberKey_(values[r][pi]) === p) {
      sheet.getRange(r + 1, ai + 1).setValue(na);
      if (si > -1) sheet.getRange(r + 1, si + 1).setValue(String(newSubprojectNumber == null ? '' : newSubprojectNumber).trim());
      return true;
    }
  }
  return false;
}

/**
 * Deletes every "Project Aliases" row matching alias (case-insensitive) + project number. Returns
 * the number of rows removed. Deletes from the bottom up so earlier row indices stay valid. Used by
 * the dashboard's "Manage hints" manager. Canon (Base) rows are protected at the server layer
 * (removeProjectAlias refuses them) — this low-level helper does not itself check the flag.
 */
function deleteAliasRow_(alias, projectNumber) {
  const a = String(alias == null ? '' : alias).trim().toLowerCase();
  const p = String(projectNumber == null ? '' : projectNumber).trim();
  if (!a || !p) return 0;
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEET_ALIASES_TAB);
  if (!sheet) return 0;
  const values = sheet.getDataRange().getValues();
  const header = values[0] || [];
  const ai = header.indexOf('Alias');
  const pi = header.indexOf('Project Number');
  if (ai === -1 || pi === -1) return 0;
  let removed = 0;
  for (let r = values.length - 1; r >= 1; r--) {
    if (String(values[r][ai] || '').trim().toLowerCase() === a &&
        String(values[r][pi] || '').trim() === p) {
      sheet.deleteRow(r + 1);
      removed++;
    }
  }
  return removed;
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
 * exactly what happened when 'Date Received' was added as the 2nd element (a one-time repair fixed
 * the already-corrupted rows at the time). Header-based lookup is safe regardless of array order or
 * when each column was physically appended.
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
  const pnIdx = header.indexOf('Project Number');
  const pmIdx = header.indexOf('Project Name');
  const snIdx = header.indexOf('Subproject Number');
  const smIdx = header.indexOf('Subproject Name');
  if (vIdx === -1) return map;
  const cell = (row, i) => (i > -1 ? String(values[row][i] == null ? '' : values[row][i]) : '');
  for (let r = 1; r < values.length; r++) {
    const key = invoiceIdentityKey_(
      values[r][vIdx], iIdx > -1 ? values[r][iIdx] : '',
      aIdx > -1 ? values[r][aIdx] : '', dIdx > -1 ? values[r][dIdx] : '');
    if (!key) continue;
    if (!map[key]) map[key] = { noticed: false, driveLink: '', driveFileId: '', projectNumber: '', projectName: '', subprojectNumber: '', subprojectName: '' };
    const status = sIdx > -1 ? String(values[r][sIdx] || '').trim() : '';
    if (status === 'Duplicate') {
      map[key].noticed = true; // a "received again" marker already exists — don't add another
    } else if (!map[key].driveLink) {
      // Capture the ORIGINAL row's filing so a duplicate notice inherits the same project/subproject
      // and points at the same Drive file.
      map[key].driveLink = cell(r, lIdx);
      map[key].driveFileId = cell(r, fIdx);
      map[key].projectNumber = cell(r, pnIdx);
      map[key].projectName = cell(r, pmIdx);
      map[key].subprojectNumber = cell(r, snIdx);
      map[key].subprojectName = cell(r, smIdx);
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

/**
 * Rolling auto-archive: moves Invoice Log rows older than CONFIG.ARCHIVE_AFTER_MONTHS (by Date
 * Processed) into the "Invoice Log Archive" tab, so the active log the dashboard and every run read
 * in full stays small and fast indefinitely — no yearly manual reset. Nothing is deleted; rows are
 * relocated within the same spreadsheet. Meant for a monthly trigger (createArchiveTrigger in
 * Setup.gs), and safe to run manually any time.
 *
 * Takes the same script lock as processInvoices so it can't interleave with a run that's appending
 * new rows (which would risk dropping them during the rewrite). Undated rows are kept (never
 * archived on ambiguous data).
 */
function archiveOldInvoiceLogRows() {
  if (CONFIG.ARCHIVE_AFTER_MONTHS == null) { Logger.log('Archiving disabled (CONFIG.ARCHIVE_AFTER_MONTHS = null).'); return; }
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) { Logger.log('Archive: another run holds the script lock — skipping this time.'); return; }
  try { archiveOldInvoiceLogRowsInner_(); } finally { lock.releaseLock(); }
}

function archiveOldInvoiceLogRowsInner_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEET_LOG_TAB);
  if (!sheet) return;
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) { Logger.log('Invoice Log has no data rows — nothing to archive.'); return; }
  const header = values[0];
  const dpIdx = header.indexOf('Date Processed');
  if (dpIdx === -1) { Logger.log('Invoice Log has no "Date Processed" column — cannot archive by age.'); return; }

  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - CONFIG.ARCHIVE_AFTER_MONTHS);

  const keep = [];
  const toArchive = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    if (row.every(c => c === '')) continue;
    const v = row[dpIdx];
    const d = (v instanceof Date) ? v : new Date(v);
    if (!isNaN(d.getTime()) && d < cutoff) toArchive.push(row);
    else keep.push(row); // recent, or undated — keep in the active log
  }

  if (!toArchive.length) {
    Logger.log(`No Invoice Log rows older than ${CONFIG.ARCHIVE_AFTER_MONTHS} months — nothing to archive.`);
    return;
  }

  // Append to the archive tab, mapping by header name so it works even if the archive tab's column
  // order ever differs from the active log's.
  const archive = getOrCreateSheet_(CONFIG.SHEET_LOG_ARCHIVE_TAB, CONFIG.LOG_COLUMNS);
  ensureSheetHasColumns_(archive, CONFIG.LOG_COLUMNS);
  const archiveHeader = archive.getRange(1, 1, 1, archive.getLastColumn()).getValues()[0];
  const mapped = toArchive.map(row => archiveHeader.map(col => {
    const srcIdx = header.indexOf(col);
    return srcIdx > -1 ? row[srcIdx] : '';
  }));
  archive.getRange(archive.getLastRow() + 1, 1, mapped.length, archiveHeader.length).setValues(mapped);

  // Rewrite the active log with only the kept rows.
  sheet.getRange(2, 1, sheet.getLastRow() - 1, header.length).clearContent();
  if (keep.length) sheet.getRange(2, 1, keep.length, header.length).setValues(keep);

  Logger.log(`Archived ${toArchive.length} row(s) older than ${CONFIG.ARCHIVE_AFTER_MONTHS} months to "${CONFIG.SHEET_LOG_ARCHIVE_TAB}". ${keep.length} row(s) remain active.`);
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
