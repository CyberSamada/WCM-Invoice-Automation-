/**
 * Dashboard.gs
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
      return {
        dateProcessedRaw: isNaN(dateObj.getTime()) ? 0 : dateObj.getTime(), // epoch ms — used for client-side filtering
        dateProcessedFormatted: formatDateForDashboard_(dateValue, timezone),
        vendor: r[idx['Vendor']] || '(unknown vendor)',
        projectNumber: r[idx['Project Number']] || '',
        projectName: r[idx['Project Name']] || '',
        amount: amount,
        currency: currency,
        status: status,
        statusClass: statusToClass_(status),
        confidenceFormatted: formatConfidenceForDashboard_(r[idx['Confidence']]),
        driveLink: r[idx['Drive Link']] || '',
        gmailLink: r[idx['Gmail Link']] || ''
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
  // but a blank Project Name. Backfill names from the Project Reference tab (and from other log
  // rows) so the same project never shows up twice — once as "6 - FOREST EDGE CMNS." and once as "6 -".
  const nameByNumber = {};
  try {
    getReferenceData_().forEach(r => {
      if (r.projectName && !nameByNumber[r.projectNumber]) nameByNumber[r.projectNumber] = r.projectName;
    });
  } catch (e) { /* Reference tab missing — fall back to names already present in the log */ }
  records.forEach(r => {
    if (r.projectName && !nameByNumber[r.projectNumber]) nameByNumber[r.projectNumber] = r.projectName;
  });
  records.forEach(r => {
    if (r.projectNumber && !r.projectName) r.projectName = nameByNumber[r.projectNumber] || '';
  });

  const byProjectMap = {};
  records.forEach(r => {
    const key = !r.projectNumber ? '(no project match)'
      : r.projectName ? `${r.projectNumber} - ${r.projectName}`
      : String(r.projectNumber);
    if (!byProjectMap[key]) byProjectMap[key] = { count: 0, amount: 0 };
    byProjectMap[key].count++;
    byProjectMap[key].amount += r.amount;
  });
  const byProject = Object.keys(byProjectMap)
    .map(key => ({
      project: key,
      count: byProjectMap[key].count,
      amountFormatted: formatCurrencyForDashboard_(byProjectMap[key].amount, 'CAD')
    }))
    .sort((a, b) => b.count - a.count);

  const errSheet = ss.getSheetByName(CONFIG.SHEET_ERRORS_TAB);
  const errorCount = errSheet ? Math.max(errSheet.getLastRow() - 1, 0) : 0;

  // Embedded as JSON for client-side filtering (Dashboard.html) — "</" defused so it can't
  // prematurely close the <script> tag it gets embedded in.
  const recordsJson = JSON.stringify(records).replace(/<\//g, '<\\/');

  // Embedded as JSON for the Start/Pause controls ("</" defused like recordsJson above).
  const automationJson = JSON.stringify(getAutomationStatus()).replace(/<\//g, '<\\/');

  return {
    logoDataUri: getLogoDataUri_(),
    automationJson: automationJson,
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
 * Whether the person viewing the dashboard may press Start/Pause. The web app runs as the owner
 * ("Execute as: Me"), so this checks the *viewer's* identity via Session.getActiveUser() — which
 * is populated for same-domain viewers. Outside-domain viewers (blank email) are read-only.
 */
function canControlAutomation_() {
  const viewer = (Session.getActiveUser().getEmail() || '').toLowerCase();
  if (!viewer) return false;
  if (viewer === Session.getEffectiveUser().getEmail().toLowerCase()) return true;
  return (CONFIG.DASHBOARD_CONTROL_EMAILS || []).some(e => e.toLowerCase() === viewer);
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
    throw new Error('Only the automation owner can start or pause it. Ask them to add your email to DASHBOARD_CONTROL_EMAILS in Config.gs.');
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
 * Returns the WCM logo as a data: URI for the dashboard header, reading it from Drive at render
 * time so the logo bytes never live inside Dashboard.html (a 400KB base64 blob pasted into the
 * editor is easy to truncate by accident — a truncated PNG still reports its dimensions but
 * renders blank).
 *
 * The source file is a 6584px original, so we prefer Drive's pre-scaled ~200px thumbnail and only
 * fall back to inlining the full-size file if the thumbnail isn't available. Cached for 6 hours.
 * Any failure returns '' and the header falls back to the text wordmark instead.
 */
function getLogoDataUri_() {
  if (!CONFIG.DASHBOARD_LOGO_FILE_ID) return '';
  const cache = CacheService.getScriptCache();
  const cached = cache.get('dashboardLogoDataUri');
  if (cached) return cached;
  try {
    let uri = '';
    try {
      const meta = JSON.parse(UrlFetchApp.fetch(
        `https://www.googleapis.com/drive/v3/files/${CONFIG.DASHBOARD_LOGO_FILE_ID}?fields=thumbnailLink`,
        { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true }
      ).getContentText());
      if (meta.thumbnailLink) {
        // thumbnailLink ends in a size directive like "=s220" — ask for 200px tall instead.
        const resp = UrlFetchApp.fetch(meta.thumbnailLink.replace(/=s\d+[^&]*$/, '=s200'), { muteHttpExceptions: true });
        if (resp.getResponseCode() === 200) {
          const blob = resp.getBlob();
          uri = `data:${blob.getContentType()};base64,${Utilities.base64Encode(blob.getBytes())}`;
        }
      }
    } catch (e) { /* thumbnail unavailable — inline the full-size file below */ }
    if (!uri) {
      const blob = DriveApp.getFileById(CONFIG.DASHBOARD_LOGO_FILE_ID).getBlob();
      uri = `data:${blob.getContentType()};base64,${Utilities.base64Encode(blob.getBytes())}`;
    }
    if (uri.length < 95000) cache.put('dashboardLogoDataUri', uri, 21600); // CacheService caps values at 100KB
    return uri;
  } catch (e) {
    return '';
  }
}

function statusToClass_(status) {
  if (status === 'Filed') return 'filed';
  if (status === 'Needs Review') return 'review';
  if (status === 'Not an Invoice') return 'notinvoice';
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
