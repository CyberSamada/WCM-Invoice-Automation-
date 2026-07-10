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
      return {
        dateProcessedRaw: isNaN(dateObj.getTime()) ? 0 : dateObj.getTime(), // epoch ms — used for client-side filtering
        dateProcessedFormatted: formatDateForDashboard_(dateValue, timezone),
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
        matchNote: (idx['Match Note'] > -1 && r[idx['Match Note']]) || ''
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

  const errSheet = ss.getSheetByName(CONFIG.SHEET_ERRORS_TAB);
  const errorCount = errSheet ? Math.max(errSheet.getLastRow() - 1, 0) : 0;

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
 * Returns the WCM logo as a data: URI for the dashboard header, from the constant embedded in
 * LogoAsset.gs — see that file for why this replaced reading the logo from Drive at render time
 * (three different Drive-dependent approaches each broke a different way; embedding removes the
 * dependency on Drive access entirely).
 */
function getLogoDataUri_() {
  return WCM_LOGO_BASE64 ? `data:image/png;base64,${WCM_LOGO_BASE64}` : '';
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
