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

  const byProjectMap = {};
  records.forEach(r => {
    const key = r.projectNumber ? `${r.projectNumber} - ${r.projectName}` : '(no project match)';
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

  return {
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
