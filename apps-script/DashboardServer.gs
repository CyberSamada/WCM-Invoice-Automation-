/**
 * DashboardServer.gs
 * (Named "DashboardServer" because the Apps Script editor does not allow a script file and an
 * HTML file to share the name "Dashboard". The file name has no effect on behavior — only the
 * HTML file's name is referenced in code, via createTemplateFromFile('Dashboard').)
 * Serves a read-only web dashboard summarizing the Invoice Log — no Google Sheet access and no
 * Apps Script editor access needed to view it. Runs "Execute as: Me" when deployed as a Web App
 * (see SETUP.md), so anyone with the URL sees a live rendering of the data with zero ability to
 * edit the underlying Sheet or break any formulas — they only ever see HTML.
 *
 * All invoice records are embedded on the page as JSON and filtered/rendered client-side
 * (Dashboard.html) — filtering by status/project/vendor/timeframe/amount is instant, no reload.
 * "By Project" totals stay unfiltered as a stable at-a-glance reference.
 *
 * Deploy once: Deploy > New deployment > type "Web app" > Execute as "Me" > Who has access
 * "Anyone within [your domain]" (or "Anyone with the link" if you want it reachable outside the
 * org — not recommended, since invoice amounts/vendors are visible). Share the resulting URL.
 * After any change to this file or Dashboard.html, re-deploy (Manage deployments > Edit > New
 * version) for the change to show up at the shared URL.
 */

function doGet(e) {
  const data = buildDashboardData_();
  const template = HtmlService.createTemplateFromFile('Dashboard');
  template.data = data;
  return template.evaluate()
    .setTitle('WCM Invoice Automation Dashboard')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

function buildDashboardData_() {
  const timezone = Session.getScriptTimeZone();
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  const logSheet = ss.getSheetByName(CONFIG.SHEET_LOG_TAB);
  const rawRows = logSheet ? logSheet.getDataRange().getValues() : [];
  const header = rawRows.shift() || [];
  const idx = {};
  CONFIG.LOG_COLUMNS.forEach(col => { idx[col] = header.indexOf(col); });

  const records = rawRows
    .filter(r => r[idx['Date Processed']])
    .map(r => {
      const status = r[idx['Status']] || '';
      const amount = Number(r[idx['Amount']]) || 0;
      const currency = r[idx['Currency']] || 'CAD';
      const dateValue = r[idx['Date Processed']];
      const dateObj = (dateValue instanceof Date) ? dateValue : new Date(dateValue);
      // Blank for rows logged before this column existed — formatDateForDashboard_ returns '' for
      // any falsy value, so this degrades gracefully rather than showing "Invalid Date".
      const receivedValue = idx['Date Received'] > -1 ? r[idx['Date Received']] : '';
      return {
        dateProcessedRaw: isNaN(dateObj.getTime()) ? 0 : dateObj.getTime(), // epoch ms — used for client-side filtering
        dateProcessedFormatted: formatDateForDashboard_(dateValue, timezone),
        dateReceivedFormatted: formatDateForDashboard_(receivedValue, timezone),
        vendor: r[idx['Vendor']] || '(unknown vendor)',
        projectNumber: String(r[idx['Project Number']] == null ? '' : r[idx['Project Number']]).trim(),
        projectName: r[idx['Project Name']] || '',
        subprojectNumber: String(r[idx['Subproject Number']] == null ? '' : r[idx['Subproject Number']]).trim(),
        subprojectName: r[idx['Subproject Name']] || '',
        amount: amount,
        currency: currency,
        status: status,
        statusClass: statusToClass_(status),
        confidenceFormatted: formatConfidenceForDashboard_(r[idx['Confidence']]),
        driveLink: r[idx['Drive Link']] || '',
        gmailLink: r[idx['Gmail Link']] || '',
        matchNote: (idx['Match Note'] > -1 && r[idx['Match Note']]) || '',
        reviewNote: (idx['Review Note'] > -1 && r[idx['Review Note']]) || '',
        rowId: (idx['Row ID'] > -1 && r[idx['Row ID']]) || ''
      };
    });

  const counts = {};
  let totalFiledAmount = 0;
  let totalNeedsReviewAmount = 0;
  let totalPastDueAmount = 0;
  records.forEach(r => {
    counts[r.status] = (counts[r.status] || 0) + 1;
    if (r.status === 'Filed') totalFiledAmount += r.amount;
    if (r.status === 'Needs Review') totalNeedsReviewAmount += r.amount;
    if (r.status === 'Past Due') totalPastDueAmount += r.amount;
  });

  // "Today" / "this week" (rolling 7 days) / "this month" (calendar month so far) — all relative
  // to the script's timezone, so it lines up with when the trigger actually ran.
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfWeek = startOfToday - 6 * 24 * 60 * 60 * 1000;
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  let countToday = 0, countThisWeek = 0, countThisMonth = 0;
  records.forEach(r => {
    if (r.dateProcessedRaw >= startOfToday) countToday++;
    if (r.dateProcessedRaw >= startOfWeek) countThisWeek++;
    if (r.dateProcessedRaw >= startOfMonth) countThisMonth++;
  });

  // Rows logged before the subproject-fallback fix (see findReferenceMatch_) have a Project Number
  // but blank names. Backfill project AND subproject names from the Project Reference tab (and from
  // other log rows), so the same project never shows up twice — once as "6 - FOREST EDGE CMNS." and
  // once as "6 -". Lookups use normalizeNumberKey_ because the reference sheet zero-pads project
  // numbers ("05") while logged rows may carry them unpadded ("5") — those must count as the same.
  const projectNames = {};
  const subprojectNames = {};
  try {
    getReferenceData_().forEach(r => {
      const p = normalizeNumberKey_(r.projectNumber);
      if (r.projectName && !projectNames[p]) projectNames[p] = r.projectName;
      const s = normalizeNumberKey_(r.subprojectNumber);
      if (s && r.subprojectName && !subprojectNames[`${p}|${s}`]) subprojectNames[`${p}|${s}`] = r.subprojectName;
    });
  } catch (e) { /* Reference tab missing — fall back to names already present in the log */ }
  records.forEach(r => {
    const p = normalizeNumberKey_(r.projectNumber);
    if (r.projectName && !projectNames[p]) projectNames[p] = r.projectName;
    const s = normalizeNumberKey_(r.subprojectNumber);
    if (s && r.subprojectName && !subprojectNames[`${p}|${s}`]) subprojectNames[`${p}|${s}`] = r.subprojectName;
  });
  records.forEach(r => {
    const p = normalizeNumberKey_(r.projectNumber);
    if (p && !r.projectName) r.projectName = projectNames[p] || '';
    const s = normalizeNumberKey_(r.subprojectNumber);
    if (s && !r.subprojectName) r.subprojectName = subprojectNames[`${p}|${s}`] || '';
  });

  // "By Project" — nested rollup mirroring the Project Reference structure: one row per project,
  // with its subprojects broken out underneath. Invoices with no (or unlisted) subproject are
  // grouped under a "General / no subproject" line when the project has other subproject activity.
  const byProjectMap = {};
  records.forEach(r => {
    const p = normalizeNumberKey_(r.projectNumber);
    const key = p || '(no project match)';
    if (!byProjectMap[key]) byProjectMap[key] = { number: p, name: '', count: 0, amount: 0, subs: {} };
    const g = byProjectMap[key];
    g.count++;
    g.amount += r.amount;
    if (r.projectName && !g.name) g.name = r.projectName;
    const s = normalizeNumberKey_(r.subprojectNumber);
    if (!g.subs[s]) g.subs[s] = { number: s, name: '', count: 0, amount: 0 };
    g.subs[s].count++;
    g.subs[s].amount += r.amount;
    if (r.subprojectName && !g.subs[s].name) g.subs[s].name = r.subprojectName;
  });
  const byProject = Object.keys(byProjectMap)
    .map(key => {
      const g = byProjectMap[key];
      const subKeys = Object.keys(g.subs);
      // Don't render a lone "General" line that would just repeat the project totals.
      const showSubs = subKeys.some(s => s !== '');
      const subprojects = !showSubs ? [] : subKeys
        .sort((a, b) => {
          if (a === '') return 1; // "General / no subproject" bucket sorts last
          if (b === '') return -1;
          return compareNumberKeys_(a, b);
        })
        .map(s => {
          const sub = g.subs[s];
          return {
            label: !sub.number ? 'General / no subproject'
              : sub.name ? `${sub.number} - ${sub.name}` : sub.number,
            count: sub.count,
            amountFormatted: formatCurrencyForDashboard_(sub.amount, 'CAD')
          };
        });
      return {
        project: !g.number ? '(no project match)'
          : g.name ? `${g.number} - ${g.name}` : g.number,
        count: g.count,
        amountFormatted: formatCurrencyForDashboard_(g.amount, 'CAD'),
        subprojects: subprojects
      };
    })
    .sort((a, b) => b.count - a.count);

  // Error timestamps (epoch ms), not just a count — lets the dashboard's top Time Frame selector
  // filter the Errors card the same way it filters the invoice-based cards, instead of Errors being
  // stuck showing an all-time total no matter what frame is selected.
  const errSheet = ss.getSheetByName(CONFIG.SHEET_ERRORS_TAB);
  let errorTimestamps = [];
  if (errSheet && errSheet.getLastRow() > 1) {
    const errHeader = errSheet.getRange(1, 1, 1, errSheet.getLastColumn()).getValues()[0];
    const tsCol = errHeader.indexOf('Timestamp');
    const errValues = errSheet.getRange(2, 1, errSheet.getLastRow() - 1, errSheet.getLastColumn()).getValues();
    errorTimestamps = errValues.map(row => {
      const v = tsCol > -1 ? row[tsCol] : null;
      const d = (v instanceof Date) ? v : new Date(v);
      return isNaN(d.getTime()) ? 0 : d.getTime();
    });
  }
  const errorCount = errorTimestamps.length;
  const errorTimestampsJson = JSON.stringify(errorTimestamps);

  // Embedded as JSON for client-side filtering (Dashboard.html) — "</" defused so it can't
  // prematurely close the <script> tag it gets embedded in.
  const recordsJson = JSON.stringify(records).replace(/<\//g, '<\\/');

  // Embedded as JSON for the Start/Pause controls ("</" defused like recordsJson above).
  // Defensive: the controls are a convenience, never a reason for the whole dashboard to fail
  // to render — fall back to a read-only status if anything here throws.
  let automationStatus;
  try {
    automationStatus = getAutomationStatus();
  } catch (e) {
    automationStatus = { paused: isAutomationPaused_(), hasTrigger: false, canControl: false };
  }
  const automationJson = JSON.stringify(automationStatus).replace(/<\//g, '<\\/');

  let brandingStatus;
  try {
    brandingStatus = getBrandingStatus_();
  } catch (e) {
    brandingStatus = { hasCustomLogo: false, canControl: false };
  }
  const brandingJson = JSON.stringify(brandingStatus).replace(/<\//g, '<\\/');

  // Project/subproject options for the dashboard's manual-override edit dropdowns — deliberately
  // the FULL reference list (not just projects that already have logged invoices), so a row can be
  // reassigned to any real project. Defensive: a broken/missing Reference tab must never block the
  // rest of the dashboard from rendering.
  let referenceOptions = [];
  try {
    referenceOptions = getMatchableReferenceRows_(getReferenceData_()).map(r => ({
      projectNumber: r.projectNumber, projectName: r.projectName,
      subprojectNumber: r.subprojectNumber, subprojectName: r.subprojectName
    }));
  } catch (e) { /* Reference tab missing — edit dropdowns just come up empty */ }
  const referenceOptionsJson = JSON.stringify(referenceOptions).replace(/<\//g, '<\\/');

  return {
    logoDataUri: getLogoDataUri_(),
    automationJson: automationJson,
    brandingJson: brandingJson,
    referenceOptionsJson: referenceOptionsJson,
    generatedAtFormatted: formatDateForDashboard_(new Date(), timezone),
    totalProcessed: records.length,
    counts: counts,
    countToday: countToday,
    countThisWeek: countThisWeek,
    countThisMonth: countThisMonth,
    totalFiledAmountFormatted: formatCurrencyForDashboard_(totalFiledAmount, 'CAD'),
    totalNeedsReviewAmountFormatted: formatCurrencyForDashboard_(totalNeedsReviewAmount, 'CAD'),
    totalPastDueAmountFormatted: formatCurrencyForDashboard_(totalPastDueAmount, 'CAD'),
    byProject: byProject,
    errorCount: errorCount,
    errorTimestampsJson: errorTimestampsJson,
    recordsJson: recordsJson
  };
}

/**
 * Automation Start/Pause — the dashboard header shows the current state to everyone, and shows
 * Start/Pause buttons only to the script owner (plus any CONFIG.DASHBOARD_CONTROL_EMAILS).
 *
 * Pausing does NOT delete the 15-minute trigger — it sets a Script Property that makes
 * processInvoices() return immediately (see Main.gs), so resuming is instant and nothing about
 * the trigger setup can be lost. Pressing Start also creates the trigger if it doesn't exist yet.
 */

/** True while the dashboard Pause button is engaged. Checked at the top of processInvoices(). */
function isAutomationPaused_() {
  return PropertiesService.getScriptProperties().getProperty(CONFIG.PAUSED_PROPERTY) === 'true';
}

/**
 * Whether the person viewing the dashboard may press Start/Pause.
 *
 * By default (CONFIG.RESTRICT_DASHBOARD_CONTROLS = false) this is true for anyone who can open
 * the dashboard at all — access to the dashboard itself is already gated by the Web App
 * deployment's "Who has access" setting (SETUP.md section 7), so a second identity check here
 * was redundant and, in practice, unreliable: Session.getActiveUser()/getEffectiveUser() only
 * return an email when the Workspace domain shares viewer identity with the script, so the
 * button was silently disappearing for legitimate owners on deployments where it doesn't.
 *
 * Set RESTRICT_DASHBOARD_CONTROLS to true to additionally require the viewer's email match the
 * script owner or appear in DASHBOARD_CONTROL_EMAILS — wrapped in try/catch since that identity
 * lookup needs the userinfo.email scope and must never be the reason the whole page fails to render.
 */
function canControlAutomation_() {
  if (!CONFIG.RESTRICT_DASHBOARD_CONTROLS) return true;
  try {
    const viewer = (Session.getActiveUser().getEmail() || '').toLowerCase();
    if (!viewer) return false;
    if (viewer === (Session.getEffectiveUser().getEmail() || '').toLowerCase()) return true;
    return (CONFIG.DASHBOARD_CONTROL_EMAILS || []).some(e => e.toLowerCase() === viewer);
  } catch (e) {
    return false;
  }
}

/** Called from Dashboard.html via google.script.run, and embedded in the page on load. */
function getAutomationStatus() {
  const hasTrigger = ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === 'processInvoices');
  return {
    paused: isAutomationPaused_(),
    hasTrigger: hasTrigger,
    canControl: canControlAutomation_()
  };
}

/** Called from Dashboard.html via google.script.run when Start/Pause is pressed. */
function setAutomationPaused(paused) {
  if (!canControlAutomation_()) {
    throw new Error('You are not allowed to start or pause the automation. Ask the automation owner to add your email to DASHBOARD_CONTROL_EMAILS in Config.gs.');
  }
  PropertiesService.getScriptProperties().setProperty(CONFIG.PAUSED_PROPERTY, paused ? 'true' : 'false');
  // Starting when no trigger has ever been created (fresh setup) — create it now so Start
  // genuinely means "the automation is running", not "it would run if a trigger existed".
  if (!paused && !ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === 'processInvoices')) {
    createTimeTrigger();
  }
  return getAutomationStatus();
}

/**
 * Manual override — lets the dashboard owner correct a logged invoice's project/subproject/status
 * after the fact (e.g. Gemini got it wrong, or a "Needs Review" item was checked and is actually
 * fine), so the log reflects the true outcome instead of staying stuck at whatever the automatic
 * pass decided. Called from Dashboard.html via google.script.run.
 *
 * Finds the row by its 'Row ID' (a UUID set once at logging time — see SheetService.gs/
 * logInvoiceRow_), never by row position, since the sheet can grow/reorder between page loads.
 * If the project/subproject or status actually changes, the already-filed Drive file is MOVED to
 * wherever it now belongs (via the same resolveInvoiceDestinationFolderId_ automatic filing uses —
 * see DriveService.gs — so this can never disagree with what a fresh automatic run would do).
 *
 * @param {string} rowId
 * @param {{projectNumber:?string, subprojectNumber:?string, status:?string}} updates - any
 *   subset; omitted (null/undefined) fields are left unchanged. subprojectNumber '' means "no
 *   subproject" explicitly.
 */
function updateInvoiceRow(rowId, updates) {
  if (!canControlAutomation_()) {
    throw new Error('You are not allowed to edit invoice records.');
  }
  if (!rowId) throw new Error('Missing row ID.');
  updates = updates || {};

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEET_LOG_TAB);
  if (!sheet) throw new Error(`"${CONFIG.SHEET_LOG_TAB}" tab not found.`);
  ensureSheetHasColumns_(sheet, CONFIG.LOG_COLUMNS);

  const values = sheet.getDataRange().getValues();
  const header = values[0];
  const idx = {};
  CONFIG.LOG_COLUMNS.forEach(col => { idx[col] = header.indexOf(col); });
  if (idx['Row ID'] === -1) throw new Error("This sheet doesn't have a Row ID column yet — reprocess an invoice first so it's created, then try again.");

  let rowNum = -1;
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][idx['Row ID']]) === String(rowId)) { rowNum = i + 1; break; }
  }
  if (rowNum === -1) throw new Error('Could not find that invoice row — the sheet may have changed since the page loaded. Reload and try again.');
  const row = values[rowNum - 1];

  const currentProjectNumber = String(row[idx['Project Number']] || '').trim();
  const currentSubprojectNumber = String(row[idx['Subproject Number']] || '').trim();
  const currentStatus = String(row[idx['Status']] || '').trim();

  const newProjectNumber = updates.projectNumber != null ? String(updates.projectNumber).trim() : currentProjectNumber;
  const newSubprojectNumber = updates.subprojectNumber != null ? String(updates.subprojectNumber).trim() : currentSubprojectNumber;
  const newStatus = updates.status != null ? String(updates.status).trim() : currentStatus;

  const ALLOWED_STATUSES = ['Filed', 'Needs Review', 'Not an Invoice', 'Past Due'];
  if (updates.status != null && ALLOWED_STATUSES.indexOf(newStatus) === -1) {
    throw new Error(`Status must be one of: ${ALLOWED_STATUSES.join(', ')}.`);
  }

  let matchedRef = null;
  if (newProjectNumber) {
    matchedRef = findReferenceMatch_(getReferenceData_(), newProjectNumber, newSubprojectNumber);
    if (!matchedRef) {
      throw new Error(`Project "${newProjectNumber}" (with that subproject) wasn't found in the Project Reference sheet.`);
    }
  }

  const projectChanged = newProjectNumber !== currentProjectNumber || newSubprojectNumber !== currentSubprojectNumber;
  const statusChanged = newStatus !== currentStatus;
  let newDriveLink = row[idx['Drive Link']];

  if (projectChanged || statusChanged) {
    const driveFileId = idx['Drive File ID'] > -1 ? String(row[idx['Drive File ID']] || '').trim() : '';
    if (driveFileId) {
      try {
        const destFolderId = resolveInvoiceDestinationFolderId_(matchedRef, newStatus, row[idx['Invoice Date']]);
        const file = DriveApp.getFileById(driveFileId);
        file.moveTo(DriveApp.getFolderById(destFolderId));
        newDriveLink = file.getUrl();
      } catch (err) {
        throw new Error(`Saved the field changes, but couldn't move the file in Drive: ${err.message}`);
      }
    }
  }

  const stamp = Utilities.formatDate(new Date(), CONFIG_TIMEZONE_(), 'yyyy-MM-dd HH:mm');
  const changeParts = [];
  if (projectChanged) changeParts.push(`project set to ${newProjectNumber}${newSubprojectNumber ? '/' + newSubprojectNumber : ''}`);
  if (statusChanged) changeParts.push(`status set to ${newStatus}`);
  const overrideNote = `Manually updated ${stamp} — ${changeParts.join('; ') || 'no change'}.`;

  const setCell = (col, value) => { if (idx[col] > -1) sheet.getRange(rowNum, idx[col] + 1).setValue(value); };
  setCell('Project Number', newProjectNumber);
  setCell('Project Name', matchedRef ? matchedRef.projectName : '');
  setCell('Subproject Number', matchedRef ? matchedRef.subprojectNumber : '');
  setCell('Subproject Name', matchedRef ? matchedRef.subprojectName : '');
  setCell('Status', newStatus);
  setCell('Drive Link', newDriveLink);
  if (idx['Review Note'] > -1) {
    const existingNote = String(row[idx['Review Note']] || '');
    setCell('Review Note', existingNote ? existingNote + ' ' + overrideNote : overrideNote);
  }

  return {
    rowId: rowId,
    projectNumber: newProjectNumber,
    projectName: matchedRef ? matchedRef.projectName : '',
    subprojectNumber: matchedRef ? matchedRef.subprojectNumber : '',
    subprojectName: matchedRef ? matchedRef.subprojectName : '',
    status: newStatus,
    statusClass: statusToClass_(newStatus),
    driveLink: newDriveLink,
    reviewNote: idx['Review Note'] > -1 ? String(sheet.getRange(rowNum, idx['Review Note'] + 1).getValue() || '') : ''
  };
}

/**
 * Bulk manual override — applies the same subset of changes to several rows at once (the
 * dashboard's multi-select edit). Reuses updateInvoiceRow per row so bulk and single edits can
 * never behave differently; a failure on one row doesn't abort the rest, it's reported per-row.
 * Called from Dashboard.html via google.script.run.
 *
 * @param {string[]} rowIds
 * @param {{projectNumber:?string, subprojectNumber:?string, status:?string}} updates - only the
 *   fields being changed; omitted (null/undefined) fields are left as each row currently has them.
 * @return {{updated: Object[], errors: {rowId: string, message: string}[]}}
 */
function updateInvoiceRows(rowIds, updates) {
  if (!canControlAutomation_()) {
    throw new Error('You are not allowed to edit invoice records.');
  }
  if (!rowIds || !rowIds.length) throw new Error('No rows selected.');
  if (rowIds.length > 100) throw new Error('Too many rows at once — select 100 or fewer.');

  const updated = [];
  const errors = [];
  rowIds.forEach(rowId => {
    try {
      updated.push(updateInvoiceRow(rowId, updates));
    } catch (err) {
      errors.push({ rowId: rowId, message: err.message });
    }
  });
  return { updated: updated, errors: errors };
}

/**
 * Where a filed invoice PDF actually lives in Drive, as a human-readable folder path (walked up
 * from the file to the Invoice Archive root) — for the dashboard's preview modal, so someone can
 * see the filing location without leaving the page. Read-only, so open to any dashboard viewer,
 * same as the rest of the page's data. Called lazily from Dashboard.html when a preview opens.
 *
 * @param {string} fileId
 * @return {{fileName: string, folderPath: string}}
 */
function getInvoiceFileInfo(fileId) {
  const id = String(fileId || '').trim();
  if (!/^[A-Za-z0-9_-]{10,}$/.test(id)) throw new Error('Invalid file ID.');

  const file = DriveApp.getFileById(id);
  const segments = [];
  let parents = file.getParents();
  // Drive files can technically have multiple parents; the archive only ever files into one, so
  // follow the first chain. Cap the walk defensively — a cycle isn't possible in Drive, but a
  // deeply shared path shouldn't loop forever either.
  let folder = parents.hasNext() ? parents.next() : null;
  let hops = 0;
  while (folder && hops < 15) {
    segments.unshift(folder.getName());
    const up = folder.getParents();
    folder = up.hasNext() ? up.next() : null;
    hops++;
  }
  return { fileName: file.getName(), folderPath: segments.join(' / ') };
}

/** Called from Dashboard.html via google.script.run. Open to any viewer — feedback isn't gated. */
function submitFeedback(message, pageContext) {
  const text = String(message || '').trim();
  if (!text) throw new Error('Feedback message is empty.');
  if (text.length > 2000) throw new Error('That message is too long — please keep it to a couple of sentences.');
  logFeedback_(text, pageContext || '');
  return { ok: true };
}

/**
 * Self-service logo — a "Change logo" control in the dashboard header lets the owner replace the
 * logo without touching code, after three earlier Drive-dependent approaches each broke a
 * different way (see LogoAsset.gs for the history). The uploaded image is stored directly in
 * Script Properties — chunked, since each property is capped at 9KB — so there is no Drive file,
 * no external fetch, and nothing that depends on which Google account did the uploading. Until a
 * custom logo is uploaded, getLogoDataUri_ falls back to the built-in WCM_LOGO_BASE64 constant in
 * LogoAsset.gs — "keeps it there unless changed manually," as requested.
 */
const CUSTOM_LOGO_META_PROPERTY = 'CUSTOM_LOGO_META'; // JSON: { mimeType, chunkCount }
const CUSTOM_LOGO_CHUNK_PREFIX = 'CUSTOM_LOGO_CHUNK_';
const CUSTOM_LOGO_CHUNK_SIZE = 8000; // chars/property — Script Properties cap each value at 9KB (9216 chars)
const CUSTOM_LOGO_MAX_BASE64_LENGTH = 200000; // ~150KB raw; well under the 500KB total Script Properties budget

/** Returns the active logo (custom upload if one exists, else the built-in default) as a data: URI. */
function getLogoDataUri_() {
  const custom = getCustomLogoDataUri_();
  if (custom) return custom;
  return WCM_LOGO_BASE64 ? `data:image/png;base64,${WCM_LOGO_BASE64}` : '';
}

/** Reassembles a previously uploaded custom logo from its Script Property chunks, or '' if none. */
function getCustomLogoDataUri_() {
  try {
    const props = PropertiesService.getScriptProperties();
    const metaRaw = props.getProperty(CUSTOM_LOGO_META_PROPERTY);
    if (!metaRaw) return '';
    const meta = JSON.parse(metaRaw);
    let base64 = '';
    for (let i = 0; i < meta.chunkCount; i++) {
      base64 += props.getProperty(CUSTOM_LOGO_CHUNK_PREFIX + i) || '';
    }
    return base64 ? `data:${meta.mimeType};base64,${base64}` : '';
  } catch (e) {
    return '';
  }
}

/** Called from Dashboard.html via google.script.run, and embedded in the page on load. */
function getBrandingStatus_() {
  return {
    hasCustomLogo: getCustomLogoDataUri_() !== '',
    canControl: canControlAutomation_()
  };
}

/**
 * Called from Dashboard.html via google.script.run when a new logo file is chosen. The client
 * already downscales/re-encodes the image to a small PNG via <canvas> before calling this (see
 * resizeImageForLogo in Dashboard.html), but the type/size are re-validated here server-side too,
 * since client-side checks can always be bypassed.
 */
function uploadLogo(base64Data) {
  if (!canControlAutomation_()) {
    throw new Error('You are not allowed to change the dashboard logo.');
  }
  if (!base64Data || base64Data.length > CUSTOM_LOGO_MAX_BASE64_LENGTH) {
    throw new Error('That image is too large. Try a smaller image — a simple logo a few hundred pixels tall is plenty.');
  }

  const bytes = Utilities.base64Decode(base64Data);
  const PNG_SIGNATURE = [-119, 80, 78, 71, 13, 10, 26, 10];
  const isPng = bytes.length > PNG_SIGNATURE.length && PNG_SIGNATURE.every((b, i) => bytes[i] === b);
  const isJpeg = bytes.length > 3 && bytes[0] === -1 && bytes[1] === -40 && bytes[2] === -1;
  if (!isPng && !isJpeg) {
    throw new Error("That doesn't look like a valid image file.");
  }
  const mimeType = isPng ? 'image/png' : 'image/jpeg';

  clearCustomLogoChunks_();
  const props = PropertiesService.getScriptProperties();
  const chunkCount = Math.ceil(base64Data.length / CUSTOM_LOGO_CHUNK_SIZE);
  for (let i = 0; i < chunkCount; i++) {
    props.setProperty(CUSTOM_LOGO_CHUNK_PREFIX + i, base64Data.slice(i * CUSTOM_LOGO_CHUNK_SIZE, (i + 1) * CUSTOM_LOGO_CHUNK_SIZE));
  }
  props.setProperty(CUSTOM_LOGO_META_PROPERTY, JSON.stringify({ mimeType: mimeType, chunkCount: chunkCount }));

  return getLogoDataUri_();
}

/** Called from Dashboard.html via google.script.run to remove the custom logo and revert to the built-in one. */
function resetLogo() {
  if (!canControlAutomation_()) {
    throw new Error('You are not allowed to change the dashboard logo.');
  }
  clearCustomLogoChunks_();
  return getLogoDataUri_();
}

function clearCustomLogoChunks_() {
  const props = PropertiesService.getScriptProperties();
  const metaRaw = props.getProperty(CUSTOM_LOGO_META_PROPERTY);
  if (metaRaw) {
    try {
      const meta = JSON.parse(metaRaw);
      for (let i = 0; i < meta.chunkCount; i++) props.deleteProperty(CUSTOM_LOGO_CHUNK_PREFIX + i);
    } catch (e) { /* malformed meta — fall through and delete it below anyway */ }
  }
  props.deleteProperty(CUSTOM_LOGO_META_PROPERTY);
}

/**
 * Canonical form of a project/subproject number for grouping and lookups: trims, and strips
 * leading zeros from the integer part ("05" → "5", "06.10" → "6.10") so zero-padded reference
 * numbers and unpadded logged numbers count as the same project. Non-numeric values (e.g. "46++")
 * pass through unchanged.
 */
function normalizeNumberKey_(value) {
  const s = String(value == null ? '' : value).trim();
  return s.replace(/^0+(?=\d)/, '');
}

/** Numeric-aware compare for dotted numbers, so "43.2" sorts before "43.10". */
function compareNumberKeys_(a, b) {
  const as = String(a).split('.');
  const bs = String(b).split('.');
  const len = Math.max(as.length, bs.length);
  for (let i = 0; i < len; i++) {
    const an = Number(as[i] || 0);
    const bn = Number(bs[i] || 0);
    if (isNaN(an) || isNaN(bn)) {
      const cmp = String(as[i] || '').localeCompare(String(bs[i] || ''));
      if (cmp !== 0) return cmp;
    } else if (an !== bn) {
      return an - bn;
    }
  }
  return 0;
}

function statusToClass_(status) {
  if (status === 'Filed') return 'filed';
  if (status === 'Needs Review') return 'review';
  if (status === 'Not an Invoice') return 'notinvoice';
  if (status === 'Past Due') return 'pastdue';
  return 'other';
}

function formatDateForDashboard_(value, timezone) {
  if (!value) return '';
  const d = (value instanceof Date) ? value : new Date(value);
  if (isNaN(d.getTime())) return String(value);
  return Utilities.formatDate(d, timezone, 'MMM d, yyyy h:mm a');
}

function formatCurrencyForDashboard_(amount, currency) {
  const num = Number(amount) || 0;
  const formatted = num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${currency || 'CAD'} $${formatted}`;
}

function formatConfidenceForDashboard_(value) {
  const num = Number(value);
  if (isNaN(num)) return '';
  return Math.round(num * 100) + '%';
}
