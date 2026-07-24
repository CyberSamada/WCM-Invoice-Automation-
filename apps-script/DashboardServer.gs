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
      const receivedObj = receivedValue ? ((receivedValue instanceof Date) ? receivedValue : new Date(receivedValue)) : null;
      // Invoice Date is a date-only value (usually the "YYYY-MM-DD" string Gemini returns), so parse
      // it without a timezone shift and format date-only — see parseInvoiceDateLocal_.
      const invoiceDateValue = idx['Invoice Date'] > -1 ? r[idx['Invoice Date']] : '';
      const invoiceDateObj = parseInvoiceDateLocal_(invoiceDateValue);
      return {
        dateProcessedRaw: isNaN(dateObj.getTime()) ? 0 : dateObj.getTime(), // epoch ms — used for client-side filtering
        dateReceivedRaw: (receivedObj && !isNaN(receivedObj.getTime())) ? receivedObj.getTime() : 0, // 0 = no received date (won't match a bounded window)
        invoiceDateRaw: invoiceDateObj ? invoiceDateObj.getTime() : 0, // 0 = no/unparseable invoice date
        dateProcessedFormatted: formatDateForDashboard_(dateValue, timezone),
        dateReceivedFormatted: formatDateForDashboard_(receivedValue, timezone),
        invoiceDateFormatted: invoiceDateObj ? Utilities.formatDate(invoiceDateObj, timezone, 'MMM d, yyyy') : (invoiceDateValue ? String(invoiceDateValue) : ''),
        vendor: r[idx['Vendor']] || '(unknown vendor)',
        invoiceNumber: (idx['Invoice Number'] > -1 && r[idx['Invoice Number']]) ? String(r[idx['Invoice Number']]) : '',
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
  records.forEach(r => {
    counts[r.status] = (counts[r.status] || 0) + 1;
    if (r.status === 'Filed') totalFiledAmount += r.amount;
    if (r.status === 'Needs Review') totalNeedsReviewAmount += r.amount;
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
 * @param {{projectNumber:?string, subprojectNumber:?string, status:?string, invoiceNumber:?string,
 *   amount:?string, currency:?string, learnAlias:?string}} updates - any subset; omitted
 *   (null/undefined) fields are left unchanged. subprojectNumber '' means "no subproject" explicitly.
 *   learnAlias (optional) is a name/address to remember as an alias for the row's corrected project
 *   — the learn-while-fixing hint; saved best-effort, never fails the edit.
 */
function updateInvoiceRow(rowId, updates, cachedReferenceRows) {
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
  const currentInvoiceNumber = idx['Invoice Number'] > -1 ? String(row[idx['Invoice Number']] || '').trim() : '';
  const currentAmount = idx['Amount'] > -1 ? row[idx['Amount']] : '';
  const currentCurrency = idx['Currency'] > -1 ? String(row[idx['Currency']] || '').trim() : '';

  const newProjectNumber = updates.projectNumber != null ? String(updates.projectNumber).trim() : currentProjectNumber;
  const newSubprojectNumber = updates.subprojectNumber != null ? String(updates.subprojectNumber).trim() : currentSubprojectNumber;
  const newStatus = updates.status != null ? String(updates.status).trim() : currentStatus;
  const newInvoiceNumber = updates.invoiceNumber != null ? String(updates.invoiceNumber).trim() : currentInvoiceNumber;
  const newCurrency = updates.currency != null ? normalizeCurrency_(updates.currency) : currentCurrency;
  let newAmount = currentAmount;
  if (updates.amount != null) {
    const raw = String(updates.amount).trim();
    if (raw === '') { newAmount = ''; }
    else {
      const parsedAmount = Number(raw.replace(/[^0-9.\-]/g, ''));
      if (isNaN(parsedAmount)) throw new Error('Amount must be a number.');
      newAmount = parsedAmount;
    }
  }

  // 'Past Due' is intentionally NOT settable anymore — the Past Due lane was dropped in favor of
  // filing everything by month, and the legacy Past Due rows were already migrated to Filed/Needs Review.
  const ALLOWED_STATUSES = ['Filed', 'Captured', 'Paid', 'Needs Review', 'Not an Invoice', 'Duplicate'];
  if (updates.status != null && ALLOWED_STATUSES.indexOf(newStatus) === -1) {
    throw new Error(`Status must be one of: ${ALLOWED_STATUSES.join(', ')}.`);
  }

  let matchedRef = null;
  if (newProjectNumber) {
    matchedRef = findReferenceMatch_(cachedReferenceRows || getReferenceData_(), newProjectNumber, newSubprojectNumber);
    if (!matchedRef) {
      throw new Error(`Project "${newProjectNumber}" (with that subproject) wasn't found in the Project Reference sheet.`);
    }
  }

  const projectChanged = newProjectNumber !== currentProjectNumber || newSubprojectNumber !== currentSubprojectNumber;
  const statusChanged = newStatus !== currentStatus;
  const invoiceNumberChanged = newInvoiceNumber !== currentInvoiceNumber;
  const amountChanged = String(newAmount) !== String(currentAmount);
  const currencyChanged = newCurrency !== currentCurrency;
  let newDriveLink = row[idx['Drive Link']];

  // A "Duplicate" row is a bookkeeping notice, not a filed copy — its Drive File ID points at the
  // ORIGINAL invoice's file (shared, not its own). So for a Duplicate row never move OR rename the
  // Drive file: that would disturb the original invoice where it's correctly filed.
  const shouldMoveFile = (projectChanged || statusChanged) && newStatus !== 'Duplicate';
  // The filename embeds the invoice number ("YYMMDD - InvoiceNumber - Vendor"), so a corrected number
  // should rename the file too, keeping the filename honest.
  const shouldRenameFile = invoiceNumberChanged && newStatus !== 'Duplicate';
  if (shouldMoveFile || shouldRenameFile) {
    const driveFileId = idx['Drive File ID'] > -1 ? String(row[idx['Drive File ID']] || '').trim() : '';
    if (driveFileId) {
      try {
        const file = DriveApp.getFileById(driveFileId);
        if (shouldMoveFile) {
          // Month folder is keyed on the row's PROCESSED date — the same date its filename carries —
          // so filename and folder always agree, matching how the automation files (see Main.gs).
          const destFolderId = resolveInvoiceDestinationFolderId_(matchedRef, newStatus, row[idx['Date Processed']]);
          file.moveTo(DriveApp.getFolderById(destFolderId));
          newDriveLink = file.getUrl();
        }
        if (shouldRenameFile) {
          file.setName(buildRenamedInvoiceFileName_(row[idx['Date Processed']], newInvoiceNumber, row[idx['Vendor']]));
        }
      } catch (err) {
        throw new Error(`Saved the field changes, but couldn't update the file in Drive: ${err.message}`);
      }
    }
  }

  const stamp = Utilities.formatDate(new Date(), CONFIG_TIMEZONE_(), 'yyyy-MM-dd HH:mm');
  const changeParts = [];
  if (projectChanged) changeParts.push(`project set to ${newProjectNumber}${newSubprojectNumber ? '/' + newSubprojectNumber : ''}`);
  if (statusChanged) changeParts.push(`status set to ${newStatus}`);
  if (invoiceNumberChanged) changeParts.push(`invoice # set to ${newInvoiceNumber || '(blank)'}`);
  if (amountChanged) changeParts.push(`amount set to ${newAmount === '' ? '(blank)' : newAmount}`);
  if (currencyChanged) changeParts.push(`currency set to ${newCurrency || '(blank)'}`);
  const overrideNote = `Manually updated ${stamp} — ${changeParts.join('; ') || 'no change'}.`;

  const setCell = (col, value) => { if (idx[col] > -1) sheet.getRange(rowNum, idx[col] + 1).setValue(value); };
  setCell('Project Number', newProjectNumber);
  setCell('Project Name', matchedRef ? matchedRef.projectName : '');
  setCell('Subproject Number', matchedRef ? matchedRef.subprojectNumber : '');
  setCell('Subproject Name', matchedRef ? matchedRef.subprojectName : '');
  setCell('Status', newStatus);
  setCell('Invoice Number', newInvoiceNumber);
  setCell('Amount', newAmount);
  setCell('Currency', newCurrency);
  setCell('Drive Link', newDriveLink);
  if (idx['Review Note'] > -1) {
    const existingNote = String(row[idx['Review Note']] || '');
    setCell('Review Note', existingNote ? existingNote + '\n' + overrideNote : overrideNote);
  }

  // Record the correction (what the automation had vs. what the human set it to) for the Override
  // Log — the learning/audit trail. Only when something actually changed. Never let a logging
  // hiccup fail the edit the user just made.
  if (projectChanged || statusChanged || invoiceNumberChanged || amountChanged || currencyChanged) {
    try {
      logOverride_({
        rowId: rowId,
        vendor: row[idx['Vendor']],
        invoiceNumber: newInvoiceNumber,
        amount: newAmount,
        fromProject: currentProjectNumber,
        fromSubproject: currentSubprojectNumber,
        fromStatus: currentStatus,
        originalConfidence: idx['Confidence'] > -1 ? row[idx['Confidence']] : '',
        toProject: newProjectNumber,
        toSubproject: matchedRef ? matchedRef.subprojectNumber : '',
        toStatus: newStatus
      });
    } catch (e) { /* audit logging is best-effort — the edit itself already succeeded */ }
  }

  // Learn-while-fixing: if the user typed what on this invoice identifies the project, save it as an
  // alias mapped to the row's (corrected) project — so the NEXT invoice that mentions the same
  // address/phrase matches on its own. Best-effort: a bad/duplicate hint never fails the edit.
  let learnedAlias = false;
  const learnAlias = updates.learnAlias != null ? String(updates.learnAlias).trim() : '';
  if (learnAlias && newProjectNumber) {
    try {
      const res = saveProjectAliasInternal_(learnAlias, newProjectNumber, newSubprojectNumber, cachedReferenceRows);
      learnedAlias = !!res.added;
    } catch (e) { /* the correction itself already succeeded — a hint that can't be saved is non-fatal */ }
  }

  return {
    rowId: rowId,
    projectNumber: newProjectNumber,
    projectName: matchedRef ? matchedRef.projectName : '',
    subprojectNumber: matchedRef ? matchedRef.subprojectNumber : '',
    subprojectName: matchedRef ? matchedRef.subprojectName : '',
    status: newStatus,
    statusClass: statusToClass_(newStatus),
    invoiceNumber: newInvoiceNumber,
    amount: newAmount,
    currency: newCurrency,
    driveLink: newDriveLink,
    learnedAlias: learnedAlias,
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

  // Read the Project Reference once for the whole batch instead of once per row (each updateInvoiceRow
  // would otherwise re-read it), so bulk edits do noticeably less sheet I/O. The Drive file move per
  // row is the real cost and can't be batched in Apps Script — hence the client-side progress bar.
  const referenceRows = getReferenceData_();
  const updated = [];
  const errors = [];
  rowIds.forEach(rowId => {
    try {
      updated.push(updateInvoiceRow(rowId, updates, referenceRows));
    } catch (err) {
      errors.push({ rowId: rowId, message: err.message });
    }
  });
  return { updated: updated, errors: errors };
}

/**
 * Duplicate merge — called from the dashboard's preview panel. The row being viewed (dupRowId, the
 * extra copy) is merged INTO a chosen canon row (canonRowId, the one to keep):
 *   - the dup row's Status becomes "Duplicate" and its file link/ID are repointed at the CANON's PDF
 *   - the dup's own now-redundant PDF is moved to Trash (recoverable ~30 days; skipped when both rows
 *     already share one file)
 *   - the canon row is left completely untouched — a merge never blesses or demotes the keeper
 *   - the merge is stamped on the dup row's Review Note and recorded in the Override Log
 * Guardrails: no self-merge, and the canon can't itself be a "Duplicate" row (no duplicate chains).
 *
 * @param {string} dupRowId - Row ID of the copy being demoted (the row the user has open)
 * @param {string} canonRowId - Row ID of the invoice to keep
 * @return {Object} the dup row's updated fields, for the dashboard to refresh in place
 */
function mergeInvoiceAsDuplicate(dupRowId, canonRowId) {
  if (!canControlAutomation_()) {
    throw new Error('You are not allowed to edit invoice records.');
  }
  if (!dupRowId || !canonRowId) throw new Error('Missing row ID.');
  if (String(dupRowId) === String(canonRowId)) throw new Error('Pick a different invoice — a row cannot be merged into itself.');

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEET_LOG_TAB);
  if (!sheet) throw new Error(`"${CONFIG.SHEET_LOG_TAB}" tab not found.`);
  ensureSheetHasColumns_(sheet, CONFIG.LOG_COLUMNS);

  const values = sheet.getDataRange().getValues();
  const header = values[0];
  const idx = {};
  CONFIG.LOG_COLUMNS.forEach(col => { idx[col] = header.indexOf(col); });

  let dupRowNum = -1, canonRowNum = -1;
  for (let i = 1; i < values.length; i++) {
    const id = String(values[i][idx['Row ID']]);
    if (id === String(dupRowId)) dupRowNum = i + 1;
    if (id === String(canonRowId)) canonRowNum = i + 1;
  }
  if (dupRowNum === -1 || canonRowNum === -1) {
    throw new Error('Could not find one of the invoice rows — the sheet may have changed since the page loaded. Reload and try again.');
  }
  const dupRow = values[dupRowNum - 1];
  const canonRow = values[canonRowNum - 1];

  if (String(canonRow[idx['Status']] || '').trim() === 'Duplicate') {
    throw new Error('That invoice is itself marked Duplicate — pick the original it points to instead.');
  }
  const canonLink = String(canonRow[idx['Drive Link']] || '').trim();
  const canonFileId = (idx['Drive File ID'] > -1 ? String(canonRow[idx['Drive File ID']] || '').trim() : '') || driveFileIdFromUrl_(canonLink);
  if (!canonLink && !canonFileId) {
    throw new Error('The selected invoice has no filed PDF to point at — pick a row with a file.');
  }

  // Trash the dup's own PDF, but only when it's genuinely a separate file from the canon's.
  const dupFileId = idx['Drive File ID'] > -1 ? String(dupRow[idx['Drive File ID']] || '').trim() : '';
  let trashNote = '';
  if (dupFileId && dupFileId !== canonFileId) {
    try {
      DriveApp.getFileById(dupFileId).setTrashed(true);
    } catch (err) {
      trashNote = ` (The extra file could not be moved to Trash: ${err.message} — remove it by hand if it still exists.)`;
    }
  }

  const stamp = Utilities.formatDate(new Date(), CONFIG_TIMEZONE_(), 'yyyy-MM-dd HH:mm');
  const canonLabel = [String(canonRow[idx['Vendor']] || '').trim(),
    idx['Invoice Number'] > -1 && canonRow[idx['Invoice Number']] ? 'Inv# ' + canonRow[idx['Invoice Number']] : '']
    .filter(p => p).join(' ');
  const mergeNote = `Merged as duplicate of ${canonLabel || 'the selected invoice'} ${stamp} — the file link now points at the kept copy.${trashNote}`;

  const setCell = (col, value) => { if (idx[col] > -1) sheet.getRange(dupRowNum, idx[col] + 1).setValue(value); };
  setCell('Status', 'Duplicate');
  setCell('Drive Link', canonLink);
  setCell('Drive File ID', canonFileId);
  const existingNote = idx['Review Note'] > -1 ? String(dupRow[idx['Review Note']] || '') : '';
  setCell('Review Note', existingNote ? existingNote + '\n' + mergeNote : mergeNote);

  try {
    logOverride_({
      rowId: dupRowId,
      vendor: dupRow[idx['Vendor']],
      invoiceNumber: idx['Invoice Number'] > -1 ? dupRow[idx['Invoice Number']] : '',
      amount: dupRow[idx['Amount']],
      fromProject: String(dupRow[idx['Project Number']] || '').trim(),
      fromSubproject: String(dupRow[idx['Subproject Number']] || '').trim(),
      fromStatus: String(dupRow[idx['Status']] || '').trim(),
      originalConfidence: idx['Confidence'] > -1 ? dupRow[idx['Confidence']] : '',
      toProject: String(dupRow[idx['Project Number']] || '').trim(),
      toSubproject: String(dupRow[idx['Subproject Number']] || '').trim(),
      toStatus: 'Duplicate'
    });
  } catch (e) { /* audit logging is best-effort — the merge itself already succeeded */ }

  return {
    rowId: dupRowId,
    status: 'Duplicate',
    statusClass: statusToClass_('Duplicate'),
    driveLink: canonLink,
    reviewNote: existingNote ? existingNote + '\n' + mergeNote : mergeNote
  };
}

/**
 * "Manage hints" — the dashboard's alias manager. Aliases (alternate name/address -> project) are
 * the one piece of matching knowledge coordinators routinely tune, and this lets them do it from the
 * dashboard link they already have: the server reads/writes the "Project Aliases" tab AS THE OWNER
 * (the web app runs "Execute as: Me"), so no viewer needs any spreadsheet access. Writes are gated by
 * canControlAutomation_ exactly like the other edit endpoints; the read is open like the rest of the
 * page data.
 */

/** The current alias list, each tagged with a human-readable project label + its Base (canon) flag. */
function getProjectAliases() {
  const aliases = getAliasData_(); // [{alias, projectNumber, subprojectNumber, base}]
  const labels = {};
  try {
    getReferenceData_().forEach(r => {
      const p = normalizeNumberKey_(r.projectNumber);
      if (r.projectName && !labels[p]) labels[p] = r.projectName;
    });
  } catch (e) { /* Reference tab missing — labels just come up blank */ }
  return {
    canControl: canControlAutomation_(),
    aliases: aliases.map(a => ({
      alias: a.alias,
      projectNumber: a.projectNumber,
      subprojectNumber: a.subprojectNumber,
      base: !!a.base,
      projectLabel: labels[normalizeNumberKey_(a.projectNumber)] || ''
    }))
  };
}

/**
 * Validates and saves one alias to the "Project Aliases" tab. Shared by the Manage-hints "Add"
 * button and the learn-while-fixing field (see updateInvoiceRow). Confirms the project/subproject
 * exists in the Project Reference, then appends (skipping an exact alias+project duplicate).
 * Returns { added: boolean } — added:false means it was already there.
 */
function saveProjectAliasInternal_(alias, projectNumber, subprojectNumber, cachedReferenceRows) {
  const a = String(alias == null ? '' : alias).trim();
  const p = String(projectNumber == null ? '' : projectNumber).trim();
  if (!a) throw new Error('Enter the name or address that identifies the project.');
  if (!p) throw new Error('Pick the project this hint points to.');
  const matched = findReferenceMatch_(cachedReferenceRows || getReferenceData_(), p, subprojectNumber);
  if (!matched) throw new Error(`Project "${p}"${subprojectNumber ? ' / subproject ' + subprojectNumber : ''} wasn't found in the Project Reference sheet.`);
  const added = appendAliasRow_(a, matched.projectNumber || p, matched.subprojectNumber || '');
  return { added: added };
}

/** Manage-hints "Add" — validates + saves an alias, then returns the refreshed list. Gated. */
function addProjectAlias(alias, projectNumber, subprojectNumber) {
  if (!canControlAutomation_()) throw new Error('You are not allowed to edit matching hints.');
  const result = saveProjectAliasInternal_(alias, projectNumber, subprojectNumber);
  const list = getProjectAliases();
  list.added = result.added;
  return list;
}

/** Manage-hints "✕ remove" — deletes the matching alias in its scope (project + subproject), then
 * returns the refreshed list. Gated. Refuses a canon (Base) hint: those are the shipped
 * address→project defaults and stay un-deletable so the essential mappings can't be broken — edit
 * one instead. */
function removeProjectAlias(alias, projectNumber, subprojectNumber) {
  if (!canControlAutomation_()) throw new Error('You are not allowed to edit matching hints.');
  if (!String(alias || '').trim() || !String(projectNumber || '').trim()) throw new Error('Missing alias to remove.');
  if (aliasRowIsBase_(alias, projectNumber, subprojectNumber)) {
    throw new Error('This is a base hint and can’t be removed — edit it instead if it needs to change.');
  }
  deleteAliasRow_(alias, projectNumber, subprojectNumber);
  return getProjectAliases();
}

/**
 * Manage-hints inline edit — rewrites an existing hint's TEXT in place within its scope (project +
 * subproject), keeping its scope and canon (Base) status. Enforces the rules the UI relies on: the
 * new alias can't be blank (so a base hint can't be emptied out to effectively delete it), the
 * project/subproject scope must be real, and the edited alias can't collide with a DIFFERENT existing
 * hint in the same scope. Gated.
 */
function updateProjectAlias(oldAlias, projectNumber, subprojectNumber, newAlias) {
  if (!canControlAutomation_()) throw new Error('You are not allowed to edit matching hints.');
  const oa = String(oldAlias == null ? '' : oldAlias).trim();
  const p = String(projectNumber == null ? '' : projectNumber).trim();
  const sub = String(subprojectNumber == null ? '' : subprojectNumber).trim();
  const na = String(newAlias == null ? '' : newAlias).trim();
  if (!oa || !p) throw new Error('Missing the hint to edit.');
  if (!na) throw new Error('A hint can’t be blank — type the name or address, or leave it unchanged.');
  const matched = findReferenceMatch_(getReferenceData_(), p, sub);
  if (!matched) throw new Error(`Project "${p}"${sub ? ' / subproject ' + sub : ''} wasn't found in the Project Reference sheet.`);
  // Guard against renaming onto a different existing hint in the SAME scope (project + subproject).
  if (na.toLowerCase() !== oa.toLowerCase()) {
    const clash = getAliasData_().some(x =>
      normalizeNumberKey_(x.projectNumber) === normalizeNumberKey_(p) &&
      normalizeNumberKey_(x.subprojectNumber) === normalizeNumberKey_(sub) &&
      x.alias.toLowerCase() === na.toLowerCase());
    if (clash) throw new Error('That scope already has a hint with this name.');
  }
  const ok = updateAliasRow_(oa, p, sub, na);
  if (!ok) throw new Error('Could not find that hint to edit — reload and try again.');
  return getProjectAliases();
}

// Cap for the text-select preview (PDF bytes returned to the browser for PDF.js). Typical invoices
// are well under this; larger ones stay on the fast Drive viewer.
const PDF_SELECT_MAX_BYTES = 25 * 1024 * 1024;

/**
 * Returns a filed invoice PDF's raw bytes as base64, for the dashboard's "Select text" preview mode
 * (client-side PDF.js renders it with a selectable text layer). Read-only — runs as the owner, so a
 * viewer without Drive access can still use it, same as Preview. Called lazily only when the user
 * turns on text-select mode.
 *
 * @param {string} fileId
 * @return {{base64: string, mimeType: string}}
 */
function getInvoicePdfData(fileId) {
  const id = String(fileId || '').trim();
  if (!/^[A-Za-z0-9_-]{10,}$/.test(id)) throw new Error('Invalid file ID.');
  const blob = DriveApp.getFileById(id).getBlob();
  const bytes = blob.getBytes();
  if (bytes.length > PDF_SELECT_MAX_BYTES) {
    throw new Error('This PDF is too large to open in text-select mode — use the normal viewer or Open in Drive.');
  }
  return { base64: Utilities.base64Encode(bytes), mimeType: blob.getContentType() || 'application/pdf' };
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

// Batch download caps — keep the base64 response within what google.script.run can return to the
// browser in one call. PDFs barely compress, so the byte cap is effectively the sum of file sizes.
const DOWNLOAD_MAX_FILES = 100;
const DOWNLOAD_MAX_TOTAL_BYTES = 30 * 1024 * 1024; // ~30 MB of source PDFs

/**
 * Batch download — zips the filed PDFs for the selected invoice rows and returns the zip as base64
 * for the browser to save under a user-chosen name. Runs as the owner (like the rest of the
 * dashboard), so a viewer who can't reach the Drive archive directly can still export. Read-only
 * (never moves/renames the source files), so it's open to any dashboard viewer, same as Preview.
 *
 * De-dupes by Drive file ID, so a "Duplicate" row (which points at the canon invoice's file) never
 * zips the same bill twice. Files that can't be read are skipped and counted. Guarded by
 * DOWNLOAD_MAX_FILES / DOWNLOAD_MAX_TOTAL_BYTES so the response stays transferable.
 *
 * @param {string[]} rowIds - Row IDs of the invoices to include
 * @param {string} zipName - user-entered name for the zip (sanitized here; ".zip" ensured)
 * @return {{base64:string, fileName:string, fileCount:number, skipped:number}}
 */
function downloadInvoicesZip(rowIds, zipName) {
  if (!rowIds || !rowIds.length) throw new Error('No invoices selected to download.');
  if (rowIds.length > DOWNLOAD_MAX_FILES) {
    throw new Error(`Too many at once — select ${DOWNLOAD_MAX_FILES} or fewer to download as one zip.`);
  }

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEET_LOG_TAB);
  if (!sheet) throw new Error(`"${CONFIG.SHEET_LOG_TAB}" tab not found.`);
  const values = sheet.getDataRange().getValues();
  const header = values[0] || [];
  const idIdx = header.indexOf('Row ID');
  const fileIdx = header.indexOf('Drive File ID');
  const linkIdx = header.indexOf('Drive Link');
  if (idIdx === -1) throw new Error("This sheet has no Row ID column yet — reprocess an invoice first.");

  const wanted = {};
  rowIds.forEach(id => { wanted[String(id)] = true; });
  const fileIds = [];
  const seenFile = {};
  for (let r = 1; r < values.length; r++) {
    const id = String(values[r][idIdx]);
    if (!wanted[id]) continue;
    let fid = fileIdx > -1 ? String(values[r][fileIdx] || '').trim() : '';
    if (!fid && linkIdx > -1) fid = driveFileIdFromUrl_(values[r][linkIdx]);
    if (fid && !seenFile[fid]) { seenFile[fid] = true; fileIds.push(fid); }
  }
  if (!fileIds.length) throw new Error('None of the selected invoices have a downloadable file.');

  const blobs = [];
  const nameCounts = {}; // lower-cased filename -> times used, so duplicate names get " (2)" etc.
  let total = 0, skipped = 0;
  for (let i = 0; i < fileIds.length; i++) {
    let file;
    try { file = DriveApp.getFileById(fileIds[i]); }
    catch (e) { skipped++; continue; } // missing / no access — skip, keep going
    const blob = file.getBlob();
    total += blob.getBytes().length;
    if (total > DOWNLOAD_MAX_TOTAL_BYTES) {
      throw new Error('That selection is too large to zip in one download (over 30 MB). Select fewer invoices and try again.');
    }
    const original = file.getName() || (fileIds[i] + '.pdf');
    const key = original.toLowerCase();
    let name = original;
    if (nameCounts[key]) {
      const dot = original.lastIndexOf('.');
      const base = dot > 0 ? original.slice(0, dot) : original;
      const ext = dot > 0 ? original.slice(dot) : '';
      name = `${base} (${nameCounts[key] + 1})${ext}`;
    }
    nameCounts[key] = (nameCounts[key] || 0) + 1;
    blob.setName(name);
    blobs.push(blob);
  }
  if (!blobs.length) throw new Error('Could not read any of the selected files (they may have been moved or deleted).');

  // Exactly one file (after de-dup) — return it as-is, not zipped, so a single download opens the
  // PDF directly under its own name.
  if (blobs.length === 1) {
    const only = blobs[0];
    return {
      single: true,
      base64: Utilities.base64Encode(only.getBytes()),
      fileName: only.getName(),
      mimeType: only.getContentType() || 'application/pdf',
      fileCount: 1,
      skipped: skipped
    };
  }

  const safeName = sanitizeZipName_(zipName);
  const zipBlob = Utilities.zip(blobs, safeName);
  return {
    single: false,
    base64: Utilities.base64Encode(zipBlob.getBytes()),
    fileName: safeName,
    mimeType: 'application/zip',
    fileCount: blobs.length,
    skipped: skipped
  };
}

/** Cleans a user-entered zip name: strips path/illegal characters, caps length, ensures ".zip". */
function sanitizeZipName_(name) {
  let n = String(name == null ? '' : name).trim();
  n = n.replace(/\.zip$/i, '');                 // drop a trailing .zip so we can re-add exactly one
  n = n.replace(/[\/\\:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim(); // strip illegal filename chars only
  if (!n) n = 'WCM-Invoices';
  if (n.length > 120) n = n.slice(0, 120).trim();
  return n + '.zip';
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
  if (status === 'Captured') return 'captured';
  if (status === 'Paid') return 'paid';
  if (status === 'Needs Review') return 'review';
  if (status === 'Not an Invoice') return 'notinvoice';
  if (status === 'Past Due') return 'pastdue';
  if (status === 'Duplicate') return 'duplicate';
  return 'other';
}

function formatDateForDashboard_(value, timezone) {
  if (!value) return '';
  const d = (value instanceof Date) ? value : new Date(value);
  if (isNaN(d.getTime())) return String(value);
  return Utilities.formatDate(d, timezone, 'MMM d, yyyy h:mm a');
}

/**
 * Parses an Invoice Date value to a local-midnight Date without a timezone shift. Invoice Date is a
 * date-only field — usually the "YYYY-MM-DD" string Gemini returns — so `new Date("2026-07-15")`
 * (parsed as UTC) would land on the wrong calendar day in a west-of-UTC timezone. Reads the Y/M/D
 * parts directly instead. Returns null for blank/unparseable values, or the Date if already a Date.
 */
function parseInvoiceDateLocal_(value) {
  if (!value) return null;
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value).trim());
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const d = new Date(String(value));
  return isNaN(d.getTime()) ? null : d;
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
