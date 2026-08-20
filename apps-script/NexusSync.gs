/**
 * NexusSync.gs
 * Mirrors invoice payment/lifecycle status from a Nexus export onto our Invoice Log, so nobody
 * hand-maintains AP status. Entry points are called from Dashboard.html via google.script.run:
 *   previewNexusStatusUpdate(csv)                  — what WOULD change; changes nothing
 *   applyNexusStatusUpdate(csv, startIndex)        — applies the CERTAIN matches, resumably
 *   confirmNexusMatch(...) / rejectNexusMatch(...) — the human decides one uncertain match
 *
 * WHY THIS IS A SCORED MATCHER AND NOT A LOOKUP
 * Nexus stores the *processed* invoice number, which often differs from what's printed on the PDF:
 * it gets a property prefix ("243-269744"), a company prefix ("WCM16788"), or a suffix ("0554694-IN").
 * Amounts can differ too — a ~10% holdback means Nexus is the LOWER figure. Vendor names don't agree
 * either. Measured against the real 21k-row export, every naive fuzzy key is dangerously ambiguous:
 * keying on the longest digit run makes "23" (from "Mar23") match 758 different invoices, and even an
 * exact punctuation-stripped number is non-unique for 545 keys. A wrong match here marks the WRONG
 * invoice Paid, so the rule is: auto-apply only near-certain, unambiguous matches, and route anything
 * merely plausible to a human confirmation queue.
 *
 * SELF-IMPROVING: every confirmation writes a crosswalk row — the Nexus number -> our Row ID, and the
 * Nexus Vendor ID -> our canonical vendor. Next upload those are exact hits, so each oddity is a
 * one-time cost instead of a recurring chore. Vendor ID is a stable code that already collapses
 * spelling variants ("London Hydro" and "London Hydro Inc." are both LONHYD), which is what makes the
 * learned vendor map worth having.
 */

/** Rows whose current status a Nexus upload may overwrite. Duplicate / Not an Invoice are excluded:
 *  a Duplicate row's file belongs to the canon invoice, and a non-invoice has no payment lifecycle. */
// 'Captured' is the legacy name for 'Processed'; both are eligible so an unmigrated row is not
// silently skipped by a sync.
var NEXUS_ELIGIBLE_STATUSES_ = { 'Filed': 1, 'Processed': 1, 'Captured': 1, 'Paid': 1, 'Canceled': 1, 'Needs Review': 1 };

/** Sentinel stored in the invoice crosswalk's Row ID when a human said "this matches nothing of ours",
 *  so a rejected suggestion stops coming back every upload. */
var NEXUS_NO_MATCH_ = 'NONE';

/**
 * Evidence weights. Tuned so that NO SINGLE signal can reach NEXUS_AUTO_MIN on its own — an auto-apply
 * always needs corroboration from at least two independent signals (number + amount, number + vendor…).
 */
var NEXUS_SCORE_ = {
  numExact: 50,      // same number once punctuation/case is stripped
  numContain6: 36,   // one number contains the other, shared part >= 6 chars (~0.6% ambiguous)
  numContain5: 27,   // ...shared part 5 chars (~2% ambiguous)
  numDigits6: 24,    // share a digit run of >= 6 digits
  numDigits5: 15,    // share a digit run of 5 digits
  amtExact: 40,      // same amount (within a cent)
  amtHoldback: 34,   // Nexus is ~90% of ours — the holdback case
  amtLoose: 12,      // Nexus lower by some other fraction
  amtMismatch: -30,  // amounts disagree in a way holdback doesn't explain — strong evidence AGAINST
  venCrosswalk: 26,  // Nexus Vendor ID already confirmed to map to this vendor
  venStrong: 16,     // vendor keys match after dropping legal suffixes (Ltd/Inc/…)
  venPartial: 7,     // one vendor name contains the other
  venMismatch: -12,  // different vendors — evidence against, but names are unreliable so it's mild
  dateNear: 8,       // Nexus date within ~45 days of our invoice date
  dateMid: 3         // ...within ~180 days
};

/**
 * Auto-apply only at/above this score, and only when the runner-up is at least NEXUS_AUTO_MARGIN
 * behind (so a near-tie is never resolved by the machine).
 *
 * 76 is deliberately "two strong corroborating signals" — e.g. a 6-char number containment (36) plus
 * an exact amount (40), or a 5-char containment (27) plus a 10% holdback (34) plus a vendor match (16).
 * No single signal can reach it alone. Measured against the real export with a synthetic log carrying
 * the actual decoration patterns, this auto-matched 97%+ of intended rows with ZERO false matches onto
 * decoy rows; a higher bar mostly just queued the routine prefix-plus-holdback case for no benefit.
 */
var NEXUS_AUTO_MIN = 76;
var NEXUS_AUTO_MARGIN = 15;
/** Below NEXUS_AUTO_MIN but at/above this, the match goes to the human queue. */
var NEXUS_QUEUE_MIN = 42;
/** A digit run that hits more rows than this isn't discriminating (e.g. a year); ignore it. */
var NEXUS_MAX_CANDIDATES_PER_KEY = 8;
/** Cap the queue sent to the browser — the rest surface on the next upload once these are cleared. */
var NEXUS_MAX_PENDING_RETURNED = 250;

// --- normalization -------------------------------------------------------------------------------

/** Case-folded, punctuation-stripped invoice number. Used for exact + containment comparison.
 *  Leading zeros and inner characters are PRESERVED — "0554694" and "554694" are different bills. */
function nexusNormNumber_(value) {
  return String(value == null ? '' : value).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Legacy/simple key: trimmed + uppercased, punctuation intact. Kept for the crosswalk's stored keys. */
function nexusInvoiceKey_(invoiceNumber) {
  return String(invoiceNumber == null ? '' : invoiceNumber).trim().toUpperCase();
}

/** Every digit run in a number that's long enough to identify a bill (>= 5 digits). */
function nexusDigitRuns_(value) {
  const runs = String(value == null ? '' : value).match(/\d{5,}/g);
  return runs || [];
}

/** Parses "CAD $1,695.00" (and plain numbers) to a Number, or null when there's nothing numeric. */
function nexusParseAmount_(value) {
  if (value === 0) return 0;
  if (!value) return null;
  const cleaned = String(value).replace(/[^0-9.\-]/g, '');
  if (!cleaned || cleaned === '-' || cleaned === '.') return null;
  const n = Number(cleaned);
  return isNaN(n) ? null : n;
}

/** Parses a Nexus date cell. The export is DAY-FIRST ("16/03/2023"), which Date() would misread. */
function nexusParseDate_(value) {
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
  const s = String(value == null ? '' : value).trim();
  if (!s) return null;
  const m = /^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/.exec(s);
  if (m) return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1])); // dd/mm/yyyy
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

/** Maps a raw Nexus status to one of ours, or null when we deliberately don't act on it. */
function mapNexusStatus_(rawStatus) {
  const s = String(rawStatus == null ? '' : rawStatus).trim().toUpperCase();
  if (s === 'PAID') return 'Paid';
  if (s === 'REJECTED' || s === 'VOID') return 'Canceled';
  if (s === 'POSTED' || s === 'PENDING APPROVAL' || s === 'IN PROGRESS' || s === 'HOLD') return STORED_PROCESSED_STATUS;
  return null;
}

/** Lifecycle finality — when one invoice shows several Nexus rows, the most final status wins. */
function nexusTargetRank_(status) {
  if (status === 'Paid') return 3;
  if (status === 'Canceled') return 2;
  if (status === 'Processed' || status === 'Captured') return 1; // 'Captured' = legacy name
  return 0;
}

// --- learned crosswalks (sheet tabs) -------------------------------------------------------------

/** Reads the Nexus Invoice Map tab: { nexusKey -> rowId } (rowId may be NEXUS_NO_MATCH_). */
function getNexusInvoiceMap_() {
  const out = {};
  try {
    const sheet = getOrCreateSheet_(CONFIG.SHEET_NEXUS_INVOICE_MAP_TAB, CONFIG.NEXUS_INVOICE_MAP_COLUMNS);
    const values = sheet.getDataRange().getValues();
    if (values.length < 2) return out;
    const header = values[0];
    const iNum = header.indexOf('Nexus Number');
    const iRow = header.indexOf('Row ID');
    if (iNum === -1 || iRow === -1) return out;
    for (let i = 1; i < values.length; i++) {
      const k = nexusInvoiceKey_(values[i][iNum]);
      if (k) out[k] = String(values[i][iRow] || '').trim();
    }
  } catch (e) { /* a missing/unreadable crosswalk just means no learned hits yet */ }
  return out;
}

/** Reads the Nexus Vendor Map tab: { nexusVendorId -> our vendor name }. */
function getNexusVendorMap_() {
  const out = {};
  try {
    const sheet = getOrCreateSheet_(CONFIG.SHEET_NEXUS_VENDOR_MAP_TAB, CONFIG.NEXUS_VENDOR_MAP_COLUMNS);
    const values = sheet.getDataRange().getValues();
    if (values.length < 2) return out;
    const header = values[0];
    const iId = header.indexOf('Nexus Vendor ID');
    const iOurs = header.indexOf('Our Vendor');
    if (iId === -1 || iOurs === -1) return out;
    for (let i = 1; i < values.length; i++) {
      const k = String(values[i][iId] || '').trim().toUpperCase();
      const v = String(values[i][iOurs] || '').trim();
      if (k && v) out[k] = v;
    }
  } catch (e) { /* no learned vendor pairings yet */ }
  return out;
}

/** Upserts one Nexus number -> Row ID pairing (rowId NEXUS_NO_MATCH_ records a rejection). */
function saveNexusInvoiceMapping_(nexusNumber, rowId, ourInvoiceNumber, vendor) {
  const key = nexusInvoiceKey_(nexusNumber);
  if (!key) return;
  const sheet = getOrCreateSheet_(CONFIG.SHEET_NEXUS_INVOICE_MAP_TAB, CONFIG.NEXUS_INVOICE_MAP_COLUMNS);
  ensureNexusMapTextFormats_(sheet, CONFIG.NEXUS_INVOICE_MAP_COLUMNS);
  const values = sheet.getDataRange().getValues();
  const header = values[0];
  const iNum = header.indexOf('Nexus Number');
  const stamp = Utilities.formatDate(new Date(), CONFIG_TIMEZONE_(), 'yyyy-MM-dd HH:mm');
  for (let i = 1; i < values.length; i++) {
    if (nexusInvoiceKey_(values[i][iNum]) === key) {
      const iRow = header.indexOf('Row ID');
      if (iRow > -1) {
        const cell = sheet.getRange(i + 1, iRow + 1);
        cell.setNumberFormat('@');
        cell.setValue(String(rowId || ''));
      }
      const iAt = header.indexOf('Confirmed At');
      if (iAt > -1) sheet.getRange(i + 1, iAt + 1).setValue(stamp);
      return;
    }
  }
  sheet.appendRow(buildRowByHeader_(sheet, {
    'Nexus Number': String(nexusNumber || ''),
    'Row ID': String(rowId || ''),
    'Our Invoice Number': String(ourInvoiceNumber || ''),
    'Vendor': String(vendor || ''),
    'Confirmed At': stamp
  }));
}

/** Upserts one Nexus Vendor ID -> our vendor pairing. */
function saveNexusVendorMapping_(nexusVendorId, nexusVendorName, ourVendor) {
  const key = String(nexusVendorId == null ? '' : nexusVendorId).trim().toUpperCase();
  const ours = String(ourVendor == null ? '' : ourVendor).trim();
  if (!key || !ours) return;
  const sheet = getOrCreateSheet_(CONFIG.SHEET_NEXUS_VENDOR_MAP_TAB, CONFIG.NEXUS_VENDOR_MAP_COLUMNS);
  const values = sheet.getDataRange().getValues();
  const header = values[0];
  const iId = header.indexOf('Nexus Vendor ID');
  const stamp = Utilities.formatDate(new Date(), CONFIG_TIMEZONE_(), 'yyyy-MM-dd HH:mm');
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][iId] || '').trim().toUpperCase() === key) {
      const iOurs = header.indexOf('Our Vendor');
      if (iOurs > -1) sheet.getRange(i + 1, iOurs + 1).setValue(ours);
      const iAt = header.indexOf('Confirmed At');
      if (iAt > -1) sheet.getRange(i + 1, iAt + 1).setValue(stamp);
      return;
    }
  }
  sheet.appendRow(buildRowByHeader_(sheet, {
    'Nexus Vendor ID': key,
    'Nexus Vendor Name': String(nexusVendorName || ''),
    'Our Vendor': ours,
    'Confirmed At': stamp
  }));
}

/**
 * Appends rows to the "Nexus Sync Log" audit tab — one per applied status change (or rejection).
 * updateInvoiceRow already writes a generic Override Log entry, but only this records WHICH Nexus
 * invoice drove the change, the evidence behind it, and whether a machine or a person decided. So
 * "why is this marked Paid?" stays answerable long after the upload.
 *
 * Written as ONE setValues call rather than appendRow per entry — an apply run can produce hundreds
 * of rows, and per-row appends would dominate the time budget.
 *
 * @param {Object[]} entries
 */
function logNexusSyncRows_(entries) {
  if (!entries || !entries.length) return;
  const sheet = getOrCreateSheet_(CONFIG.SHEET_NEXUS_SYNC_LOG_TAB, CONFIG.NEXUS_SYNC_LOG_COLUMNS);
  ensureNexusMapTextFormats_(sheet, CONFIG.NEXUS_SYNC_LOG_COLUMNS);
  const header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const stamp = Utilities.formatDate(new Date(), CONFIG_TIMEZONE_(), 'yyyy-MM-dd HH:mm');
  const rows = entries.map(e => {
    const filled = {
      'Timestamp': stamp,
      'Decided By': e.decidedBy || '',
      'Nexus Number': e.nexusNumber || '',
      'Nexus Status': e.nexusStatus || '',
      'Nexus Vendor': e.nexusVendor || '',
      'Nexus Amount': e.nexusAmount == null ? '' : e.nexusAmount,
      'Row ID': e.rowId || '',
      'Invoice Number': e.invoiceNumber || '',
      'Vendor': e.vendor || '',
      'Amount': e.amount == null ? '' : e.amount,
      'From Status': e.fromStatus || '',
      'To Status': e.toStatus || '',
      'Score': e.score == null ? '' : e.score,
      'Evidence': e.evidence || ''
    };
    return header.map(col => (filled[col] !== undefined ? filled[col] : ''));
  });
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, header.length).setValues(rows);
}

/** Forces ID-ish columns on a crosswalk tab to plain text, so Sheets can't turn "3050-4" into a date
 *  (the same coercion that once mangled invoice numbers in the log — see CLAUDE.md). */
function ensureNexusMapTextFormats_(sheet, columns) {
  try {
    const header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    ['Nexus Number', 'Row ID', 'Our Invoice Number', 'Invoice Number'].forEach(col => {
      if (columns.indexOf(col) === -1) return;
      const i = header.indexOf(col);
      if (i > -1) sheet.getRange(1, i + 1, sheet.getMaxRows(), 1).setNumberFormat('@');
    });
  } catch (e) { /* formatting is a safeguard, never worth failing a write over */ }
}

// --- parsing the export --------------------------------------------------------------------------

/**
 * Parses the uploaded CSV into de-duplicated Nexus entries (most-final status wins per invoice
 * number). Throws when the file isn't a Nexus export, so uploading the wrong file fails loudly
 * instead of silently matching nothing.
 * @return {{entries: Object[], stats: Object}}
 */
function parseNexusCsv_(csvText) {
  if (!csvText || !String(csvText).trim()) throw new Error('The uploaded file was empty.');
  const rows = Utilities.parseCsv(String(csvText));
  if (!rows.length) throw new Error('Could not read any rows from that file.');
  const header = rows[0].map(h => String(h == null ? '' : h).trim().toLowerCase());
  const cNum = header.indexOf('number');
  const cStatus = header.indexOf('status');
  if (cNum === -1 || cStatus === -1) {
    throw new Error('This doesn’t look like a Nexus export — it needs a "Number" column and a "Status" column.');
  }
  const cVendor = header.indexOf('vendor');
  const cVendorId = header.indexOf('vendor id');
  const cAmount = header.indexOf('amount');
  const cDate = header.indexOf('date');
  const cProperty = header.indexOf('property');

  const byKey = {};
  let total = 0, blank = 0, unknown = 0;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const rawNum = cNum > -1 ? String(r[cNum] == null ? '' : r[cNum]).trim() : '';
    const key = nexusInvoiceKey_(rawNum);
    if (!key) { blank++; continue; }
    total++;
    const rawStatus = cStatus > -1 ? String(r[cStatus] == null ? '' : r[cStatus]).trim() : '';
    const target = mapNexusStatus_(rawStatus);
    if (!target) { unknown++; continue; }
    const entry = {
      number: rawNum,
      key: key,
      norm: nexusNormNumber_(rawNum),
      target: target,
      rawStatus: rawStatus,
      vendor: cVendor > -1 ? String(r[cVendor] == null ? '' : r[cVendor]).trim() : '',
      vendorId: cVendorId > -1 ? String(r[cVendorId] == null ? '' : r[cVendorId]).trim().toUpperCase() : '',
      amount: cAmount > -1 ? nexusParseAmount_(r[cAmount]) : null,
      date: cDate > -1 ? nexusParseDate_(r[cDate]) : null,
      property: cProperty > -1 ? String(r[cProperty] == null ? '' : r[cProperty]).trim() : ''
    };
    const prev = byKey[key];
    if (!prev || nexusTargetRank_(target) > nexusTargetRank_(prev.target)) byKey[key] = entry;
  }
  const entries = Object.keys(byKey).map(k => byKey[k]);
  return {
    entries: entries,
    stats: { total: total, blank: blank, unknown: unknown, uniqueMatched: entries.length }
  };
}

// --- our side: index the log --------------------------------------------------------------------

/**
 * Loads eligible Invoice Log rows and builds the lookup indexes the matcher needs. Indexing (rather
 * than comparing every pair) is what keeps a 21k-row export against a large log inside Apps Script's
 * time budget.
 */
function buildNexusLogIndex_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEET_LOG_TAB);
  if (!sheet) throw new Error(`"${CONFIG.SHEET_LOG_TAB}" tab not found.`);
  const values = sheet.getDataRange().getValues();
  const header = values[0];
  const iNum = header.indexOf('Invoice Number');
  const iStatus = header.indexOf('Status');
  const iRowId = header.indexOf('Row ID');
  if (iNum === -1 || iStatus === -1 || iRowId === -1) {
    throw new Error('The Invoice Log is missing an Invoice Number, Status, or Row ID column.');
  }
  const iVendor = header.indexOf('Vendor');
  const iAmount = header.indexOf('Amount');
  const iInvDate = header.indexOf('Invoice Date');
  // Carried so the dashboard's confirmation panel can show the invoice PDF and full context
  // side by side with the Nexus row, instead of asking someone to confirm from two text lines.
  const iDriveLink = header.indexOf('Drive Link');
  const iCurrency = header.indexOf('Currency');
  const iProjNum = header.indexOf('Project Number');
  const iProjName = header.indexOf('Project Name');

  const rows = [];
  const byNorm = {}, byDigits = {}, byVendorAmount = {}, byRowId = {};
  let ineligible = 0;

  const push = (map, key, i) => { if (!key) return; (map[key] = map[key] || []).push(i); };

  for (let r = 1; r < values.length; r++) {
    const status = String(values[r][iStatus] || '').trim();
    const rowId = String(values[r][iRowId] || '').trim();
    if (!rowId) continue;
    if (!NEXUS_ELIGIBLE_STATUSES_[status]) { ineligible++; continue; }
    const rawNum = String(values[r][iNum] == null ? '' : values[r][iNum]).trim();
    const vendor = iVendor > -1 ? String(values[r][iVendor] || '').trim() : '';
    const amount = iAmount > -1 ? nexusParseAmount_(values[r][iAmount]) : null;
    const rec = {
      i: rows.length,
      rowId: rowId,
      status: status,
      number: rawNum,
      norm: nexusNormNumber_(rawNum),
      vendor: vendor,
      vendorKey: vendor ? vendorNormalizedKey_(vendor) : '',
      amount: amount,
      invoiceDate: iInvDate > -1 ? nexusParseDate_(values[r][iInvDate]) : null,
      driveLink: iDriveLink > -1 ? String(values[r][iDriveLink] || '').trim() : '',
      currency: iCurrency > -1 ? String(values[r][iCurrency] || '').trim() : '',
      projectNumber: iProjNum > -1 ? String(values[r][iProjNum] || '').trim() : '',
      projectName: iProjName > -1 ? String(values[r][iProjName] || '').trim() : ''
    };
    rows.push(rec);
    byRowId[rowId] = rec;
    push(byNorm, rec.norm, rec.i);
    nexusDigitRuns_(rawNum).forEach(run => push(byDigits, run, rec.i));
    if (rec.vendorKey && amount != null) {
      // Two amount indexes: the amount as-is, and the amount after a 10% holdback — so a Nexus
      // figure that's 90% of ours is still a direct hash lookup rather than a scan.
      push(byVendorAmount, rec.vendorKey + '|' + amount.toFixed(2), rec.i);
      push(byVendorAmount, rec.vendorKey + '|' + (amount * 0.9).toFixed(2), rec.i);
    }
  }
  return {
    rows: rows, byNorm: byNorm, byDigits: byDigits, byVendorAmount: byVendorAmount,
    byRowId: byRowId, ineligible: ineligible, logRows: Math.max(0, values.length - 1)
  };
}

// --- scoring ------------------------------------------------------------------------------------

/** Scores the invoice-number relationship between a Nexus entry and one of our rows. */
function scoreNexusNumber_(nexusNorm, ourNorm, nexusRaw, ourRaw) {
  if (!nexusNorm || !ourNorm) return { points: 0, why: '' };
  if (nexusNorm === ourNorm) return { points: NEXUS_SCORE_.numExact, why: 'invoice # matches exactly' };
  const shorter = nexusNorm.length <= ourNorm.length ? nexusNorm : ourNorm;
  const longer = nexusNorm.length <= ourNorm.length ? ourNorm : nexusNorm;
  if (shorter.length >= 5 && longer.indexOf(shorter) !== -1) {
    return shorter.length >= 6
      ? { points: NEXUS_SCORE_.numContain6, why: 'Nexus # contains our # (' + shorter + ')' }
      : { points: NEXUS_SCORE_.numContain5, why: 'Nexus # contains our # (' + shorter + ')' };
  }
  // Fall back to a shared long digit run — e.g. "243-269744" vs "INV 269744".
  const ourRuns = nexusDigitRuns_(ourRaw);
  const nexRuns = nexusDigitRuns_(nexusRaw);
  let best = null;
  ourRuns.forEach(a => nexRuns.forEach(b => {
    if (a === b && (!best || a.length > best.length)) best = a;
  }));
  if (best) {
    return best.length >= 6
      ? { points: NEXUS_SCORE_.numDigits6, why: 'share the number ' + best }
      : { points: NEXUS_SCORE_.numDigits5, why: 'share the number ' + best };
  }
  return { points: 0, why: '' };
}

/** Scores the amount relationship. Nexus is expected to be the LOWER side when a holdback applies. */
function scoreNexusAmount_(nexusAmount, ourAmount) {
  if (nexusAmount == null || ourAmount == null || !ourAmount) return { points: 0, why: '' };
  const diff = Math.abs(nexusAmount - ourAmount);
  if (diff <= 0.02) return { points: NEXUS_SCORE_.amtExact, why: 'amount matches' };
  const ratio = nexusAmount / ourAmount;
  if (ratio >= 0.895 && ratio <= 0.905) {
    return { points: NEXUS_SCORE_.amtHoldback, why: 'amount is ours less 10% holdback' };
  }
  if (ratio > 0.905 && ratio < 1) {
    return { points: NEXUS_SCORE_.amtLoose, why: 'amount is slightly under ours (partial holdback?)' };
  }
  if (ratio >= 0.75 && ratio <= 0.895) {
    return { points: NEXUS_SCORE_.amtLoose, why: 'amount is under ours by ' + Math.round((1 - ratio) * 100) + '%' };
  }
  return { points: NEXUS_SCORE_.amtMismatch, why: 'amounts disagree' };
}

/** Scores vendor agreement, preferring the learned Vendor ID crosswalk over name comparison. */
function scoreNexusVendor_(entry, ourRec, vendorMap) {
  const mapped = entry.vendorId ? vendorMap[entry.vendorId] : '';
  if (mapped && ourRec.vendorKey && vendorNormalizedKey_(mapped) === ourRec.vendorKey) {
    return { points: NEXUS_SCORE_.venCrosswalk, why: 'vendor confirmed via Nexus ID ' + entry.vendorId };
  }
  const nexKey = entry.vendor ? vendorNormalizedKey_(entry.vendor) : '';
  if (!nexKey || !ourRec.vendorKey) return { points: 0, why: '' };
  if (nexKey === ourRec.vendorKey) return { points: NEXUS_SCORE_.venStrong, why: 'vendor matches' };
  if (nexKey.indexOf(ourRec.vendorKey) !== -1 || ourRec.vendorKey.indexOf(nexKey) !== -1) {
    return { points: NEXUS_SCORE_.venPartial, why: 'vendor names overlap' };
  }
  return { points: NEXUS_SCORE_.venMismatch, why: 'vendor differs' };
}

/** Scores date proximity — weak corroboration only, never decisive. */
function scoreNexusDate_(nexusDate, ourDate) {
  if (!nexusDate || !ourDate) return { points: 0, why: '' };
  const days = Math.abs(nexusDate.getTime() - ourDate.getTime()) / 86400000;
  if (days <= 45) return { points: NEXUS_SCORE_.dateNear, why: 'dates are close' };
  if (days <= 180) return { points: NEXUS_SCORE_.dateMid, why: 'dates are in the same period' };
  return { points: 0, why: '' };
}

/** Collects the candidate log rows worth scoring for one Nexus entry (indexed lookups only). */
function collectNexusCandidates_(entry, index, vendorMap) {
  const seen = {};
  const out = [];
  const add = list => {
    if (!list || list.length > NEXUS_MAX_CANDIDATES_PER_KEY) return; // non-discriminating key
    list.forEach(i => { if (!seen[i]) { seen[i] = 1; out.push(index.rows[i]); } });
  };
  add(index.byNorm[entry.norm]);
  nexusDigitRuns_(entry.number).forEach(run => add(index.byDigits[run]));
  // Amount-based candidates need a vendor to be safe — vendor+amount alone is non-unique ~11% of
  // the time, so we only follow it when we can tie it to a vendor.
  if (entry.amount != null) {
    const keys = [];
    const mapped = entry.vendorId ? vendorMap[entry.vendorId] : '';
    if (mapped) keys.push(vendorNormalizedKey_(mapped));
    if (entry.vendor) keys.push(vendorNormalizedKey_(entry.vendor));
    keys.forEach(k => { if (k) add(index.byVendorAmount[k + '|' + entry.amount.toFixed(2)]); });
  }
  return out;
}

/**
 * The matcher. Returns auto-applicable matches, the human queue, and counts.
 *
 * Assignment is greedy by score and one-to-one: the strongest matches claim their rows first, so a
 * single log row can't be claimed by two Nexus invoices (which would otherwise let a weak match
 * overwrite a strong one's row).
 */
function matchNexusEntries_(entries, index, invoiceMap, vendorMap) {
  const scored = [];
  let learned = 0, rejectedKnown = 0, noCandidates = 0;

  entries.forEach(entry => {
    // 1) Learned crosswalk — a human already decided this one.
    const learnedRowId = invoiceMap[entry.key];
    if (learnedRowId === NEXUS_NO_MATCH_) { rejectedKnown++; return; }
    if (learnedRowId && index.byRowId[learnedRowId]) {
      scored.push({
        entry: entry, our: index.byRowId[learnedRowId], score: 1000,
        reasons: ['previously confirmed by a person'], auto: true
      });
      learned++;
      return;
    }
    // 2) Score the indexed candidates.
    const candidates = collectNexusCandidates_(entry, index, vendorMap);
    if (!candidates.length) { noCandidates++; return; }
    const results = candidates.map(our => {
      const n = scoreNexusNumber_(entry.norm, our.norm, entry.number, our.number);
      const a = scoreNexusAmount_(entry.amount, our.amount);
      const v = scoreNexusVendor_(entry, our, vendorMap);
      const d = scoreNexusDate_(entry.date, our.invoiceDate);
      const reasons = [n.why, a.why, v.why, d.why].filter(w => w);
      return { our: our, score: n.points + a.points + v.points + d.points, reasons: reasons, numPoints: n.points };
    }).filter(r => r.numPoints > 0 || r.score >= NEXUS_QUEUE_MIN);
    if (!results.length) { noCandidates++; return; }
    results.sort((x, y) => y.score - x.score);
    const top = results[0];
    const runnerUp = results.length > 1 ? results[1].score : -999;
    // An exact, mutually-unique invoice number is trustworthy on its own — no amount or vendor needed
    // (the proven original behavior). But it must still clear NEXUS_QUEUE_MIN, so a case where the
    // amount actively CONTRADICTS the match (amtMismatch) drops to the human queue instead of being
    // auto-applied on the number alone. Otherwise auto-apply needs a high score AND a clear margin
    // over the runner-up, so a near-tie is never resolved by the machine.
    const exactUnique = top.our.norm === entry.norm &&
      (index.byNorm[entry.norm] || []).length === 1 &&
      results.length === 1;
    const auto = (exactUnique && top.score >= NEXUS_QUEUE_MIN) ||
      (top.score >= NEXUS_AUTO_MIN && (top.score - runnerUp) >= NEXUS_AUTO_MARGIN);
    scored.push({
      entry: entry, our: top.our, score: top.score, reasons: top.reasons,
      auto: auto, runnerUp: runnerUp,
      // An exact invoice-number hit always deserves human eyes even if the score is dragged below the
      // queue floor by a contradicting amount — silently dropping it would hide a real decision.
      forceQueue: top.numPoints >= NEXUS_SCORE_.numExact,
      alternatives: results.slice(1, 4).map(r => ({ rowId: r.our.rowId, score: r.score }))
    });
  });

  // Greedy one-to-one assignment.
  scored.sort((a, b) => b.score - a.score);
  const usedRow = {}, usedEntry = {};
  const autoMatches = [], pending = [];
  scored.forEach(s => {
    if (usedRow[s.our.rowId] || usedEntry[s.entry.key]) return;
    if (s.auto) {
      usedRow[s.our.rowId] = 1; usedEntry[s.entry.key] = 1;
      autoMatches.push(s);
    } else if (s.score >= NEXUS_QUEUE_MIN || s.forceQueue) {
      pending.push(s);
    }
  });
  // A queued suggestion whose row was claimed by an auto match is no longer offerable.
  const pendingFiltered = pending.filter(s => !usedRow[s.our.rowId]);

  return {
    autoMatches: autoMatches, pending: pendingFiltered,
    learned: learned, rejectedKnown: rejectedKnown, noCandidates: noCandidates
  };
}

/** Shapes one match for the browser. Dates go over as yyyy-MM-dd strings — a raw Date would arrive as
 *  an opaque serialized value, and only the day matters for a human comparing the two records. */
function nexusMatchToClient_(s) {
  const fmt = d => {
    if (!d || !(d instanceof Date) || isNaN(d.getTime())) return '';
    return Utilities.formatDate(d, CONFIG_TIMEZONE_(), 'yyyy-MM-dd');
  };
  return {
    nexusNumber: s.entry.number,
    nexusStatus: s.entry.rawStatus,
    nexusVendor: s.entry.vendor,
    nexusVendorId: s.entry.vendorId,
    nexusAmount: s.entry.amount,
    nexusDate: fmt(s.entry.date),
    nexusProperty: s.entry.property,
    target: s.entry.target,
    rowId: s.our.rowId,
    ourInvoiceNumber: s.our.number,
    ourVendor: s.our.vendor,
    ourAmount: s.our.amount,
    ourDate: fmt(s.our.invoiceDate),
    ourCurrency: s.our.currency || '',
    ourProject: [s.our.projectNumber, s.our.projectName].filter(p => p).join(' - '),
    ourDriveLink: s.our.driveLink || '',
    currentStatus: s.our.status,
    score: s.score,
    reasons: s.reasons,
    alternatives: (s.alternatives || []).length
  };
}

// --- endpoints ----------------------------------------------------------------------------------

/**
 * PREVIEW — reports what an apply would do, plus the queue of uncertain matches for a human to
 * confirm. Changes nothing.
 */
function previewNexusStatusUpdate(csvText) {
  if (!canControlAutomation_()) throw new Error('You are not allowed to update invoice statuses.');
  const parsed = parseNexusCsv_(csvText);
  const index = buildNexusLogIndex_();
  const invoiceMap = getNexusInvoiceMap_();
  const vendorMap = getNexusVendorMap_();
  const matched = matchNexusEntries_(parsed.entries, index, invoiceMap, vendorMap);

  let toPaid = 0, toCaptured = 0, toCanceled = 0, alreadyCorrect = 0, willChange = 0;
  // The full list of what WOULD change — the report the coordinator reviews (and can export) before
  // applying, rather than a handful of samples.
  const planned = [];
  matched.autoMatches.forEach(s => {
    if (s.entry.target === s.our.status) { alreadyCorrect++; return; }
    willChange++;
    if (s.entry.target === 'Paid') toPaid++;
    else if (s.entry.target === 'Captured' || s.entry.target === 'Processed') toCaptured++;
    else if (s.entry.target === 'Canceled') toCanceled++;
    planned.push(nexusMatchToClient_(s));
  });

  const pending = matched.pending
    .filter(s => s.entry.target !== s.our.status)
    .slice(0, NEXUS_MAX_PENDING_RETURNED)
    .map(nexusMatchToClient_);

  return {
    changed: willChange, toPaid: toPaid, toCaptured: toCaptured, toCanceled: toCanceled,
    alreadyCorrect: alreadyCorrect,
    pending: pending,
    pendingTotal: matched.pending.filter(s => s.entry.target !== s.our.status).length,
    learnedHits: matched.learned,
    previouslyRejected: matched.rejectedKnown,
    nexusUnmatched: matched.noCandidates,
    matchedIneligible: index.ineligible,
    logRows: index.logRows,
    nexus: parsed.stats,
    planned: planned
  };
}

/**
 * APPLY (resumable) — commits only the CERTAIN matches. Recomputes the match each call (cheap
 * relative to the writes) and walks them from `startIndex`, so a resumed call can't drift from the
 * first, and re-running is a no-op for rows already at their target.
 */
function applyNexusStatusUpdate(csvText, startIndex) {
  if (!canControlAutomation_()) throw new Error('You are not allowed to update invoice statuses.');
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(2000)) throw new Error('Another update or processing run is busy right now — wait a moment and try again.');
  try {
    const parsed = parseNexusCsv_(csvText);
    const index = buildNexusLogIndex_();
    const matched = matchNexusEntries_(parsed.entries, index, getNexusInvoiceMap_(), getNexusVendorMap_());
    const todo = matched.autoMatches.filter(s => s.entry.target !== s.our.status);

    const referenceRows = getReferenceData_();
    const start = Math.max(0, Number(startIndex) || 0);
    const startTime = Date.now();
    const MAX_RUN_MS = 2.5 * 60 * 1000;

    let changed = 0, nextIndex = todo.length, done = true;
    const errors = [];
    const logEntries = []; // batched — one sheet write at the end rather than one per row
    for (let i = start; i < todo.length; i++) {
      if (Date.now() - startTime > MAX_RUN_MS) { nextIndex = i; done = false; break; }
      const s = todo[i];
      try {
        updateInvoiceRow(s.our.rowId, { status: s.entry.target }, referenceRows);
        changed++;
        logEntries.push({
          decidedBy: 'Automatic', nexusNumber: s.entry.number, nexusStatus: s.entry.rawStatus,
          nexusVendor: s.entry.vendor, nexusAmount: s.entry.amount,
          rowId: s.our.rowId, invoiceNumber: s.our.number, vendor: s.our.vendor, amount: s.our.amount,
          fromStatus: s.our.status, toStatus: s.entry.target, score: s.score,
          evidence: (s.reasons || []).join('; ')
        });
        // Lock in what this match taught us, so the same oddity is an exact hit next time.
        try {
          saveNexusInvoiceMapping_(s.entry.number, s.our.rowId, s.our.number, s.our.vendor);
          if (s.entry.vendorId && s.our.vendor) {
            saveNexusVendorMapping_(s.entry.vendorId, s.entry.vendor, s.our.vendor);
          }
        } catch (e) { /* crosswalk learning is best-effort — the status change already succeeded */ }
      } catch (e) {
        errors.push({ invoiceNumber: s.entry.number, message: e.message });
      }
    }
    // Audit trail is best-effort: the status changes above already succeeded, and losing a log write
    // must not make the caller think they failed (which would cause a re-run).
    try { logNexusSyncRows_(logEntries); } catch (e) { /* logged changes still applied */ }
    return { done: done, nextIndex: nextIndex, total: todo.length, changed: changed, errors: errors };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Confirms one uncertain match: sets our row to the Nexus status and REMEMBERS the pairing (both the
 * invoice number crosswalk and the Nexus Vendor ID -> our vendor mapping), so it's automatic next time.
 */
function confirmNexusMatch(match) {
  if (!canControlAutomation_()) throw new Error('You are not allowed to update invoice statuses.');
  if (!match || !match.rowId || !match.nexusNumber) throw new Error('Missing match details.');
  const target = String(match.target || '').trim();
  if (['Paid', 'Captured', 'Processed', 'Canceled'].indexOf(target) === -1) {
    throw new Error('Unexpected status to apply: ' + target);
  }
  const result = updateInvoiceRow(match.rowId, { status: target });
  try {
    saveNexusInvoiceMapping_(match.nexusNumber, match.rowId, result.invoiceNumber, match.ourVendor);
    if (match.nexusVendorId && match.ourVendor) {
      saveNexusVendorMapping_(match.nexusVendorId, match.nexusVendor, match.ourVendor);
    }
  } catch (e) { /* the status change already succeeded */ }
  try {
    logNexusSyncRows_([{
      decidedBy: 'Confirmed by ' + (currentViewerEmail_() || 'a person'),
      nexusNumber: match.nexusNumber, nexusStatus: match.nexusStatus, nexusVendor: match.nexusVendor,
      nexusAmount: match.nexusAmount, rowId: match.rowId, invoiceNumber: result.invoiceNumber,
      vendor: match.ourVendor, amount: match.ourAmount, fromStatus: match.currentStatus,
      toStatus: target, score: match.score, evidence: (match.reasons || []).join('; ')
    }]);
  } catch (e) { /* audit only */ }
  return { rowId: match.rowId, status: target, statusClass: statusToClass_(target) };
}

/**
 * Rejects a suggested match — records "this Nexus invoice is none of ours" so the suggestion stops
 * reappearing on every upload. Changes no invoice.
 */
function rejectNexusMatch(nexusNumber) {
  if (!canControlAutomation_()) throw new Error('You are not allowed to update invoice statuses.');
  if (!nexusNumber) throw new Error('Missing the Nexus invoice number.');
  saveNexusInvoiceMapping_(nexusNumber, NEXUS_NO_MATCH_, '', '');
  // Recorded too — "we looked at this and it isn't ours" is a decision worth being able to review.
  try {
    logNexusSyncRows_([{
      decidedBy: 'Rejected by ' + (currentViewerEmail_() || 'a person'),
      nexusNumber: nexusNumber, toStatus: '(no match — not ours)'
    }]);
  } catch (e) { /* audit only */ }
  return { rejected: String(nexusNumber) };
}

/** Best-effort viewer email for the audit trail; '' when it can't be resolved. */
function currentViewerEmail_() {
  try { return (Session.getActiveUser().getEmail() || '').trim(); } catch (e) { return ''; }
}
