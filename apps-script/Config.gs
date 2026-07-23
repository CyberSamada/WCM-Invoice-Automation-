/**
 * Config.gs
 * All the knobs you might want to tweak live here. Nothing in here is a secret —
 * the Gemini API key lives in Script Properties instead (Project Settings > Script Properties),
 * never hardcoded in source.
 */

const CONFIG = {
  // Gmail
  GMAIL_LABEL: '+-billing',              // where billing@wcmcon.com mail lands (see plan doc, Section 3)
  PROCESSED_LABEL: 'Invoice-Processed',  // applied once a thread has been handled, so it's never reprocessed

  // Volume controls — handy for initial testing with a big backlog, or just to cap Gemini usage per run.
  MAX_THREADS_PER_RUN: null, // process at most this many email threads per run (null = no separate cap; the ~2.5-min run-time budget in Main.gs governs instead). Leftover threads are picked up next run.
  LOOKBACK_DAYS: null,      // e.g. 30 to only consider mail from the last 30 days (uses Gmail's newer_than: search operator). null = no time limit, considers all mail under the label.

  // THROUGHPUT knobs. The whole pipeline is throttled by the Gemini FREE tier's 5-requests/minute
  // limit — that's what GEMINI_PACING_MS exists for. Enabling billing on the API key removes both
  // that per-minute limit AND the 500/day cap; only then should you lower the pacing.
  //   Free tier (default):   GEMINI_PACING_MS: 13000  (≈4.6 calls/min, safely under 5/min)
  //   Billing enabled:       GEMINI_PACING_MS: 1000   (or 0) — ~10x more invoices per run
  GEMINI_PACING_MS: 13000,      // pause between Gemini calls. Lower ONLY after enabling billing.
  TRIGGER_INTERVAL_MINUTES: 15, // how often processInvoices runs. Must be 1, 5, 10, 15, or 30 (Apps Script limit). 5 ≈ 3x more runs/hour. Re-run createTimeTrigger()/press Start after changing.
  // Start-date cutoff — only process mail dated on or AFTER this date ("YYYY-MM-DD", inclusive).
  // Anything older is ignored entirely (never processed, never labeled). Enforced per-MESSAGE (see
  // GmailService.gs/getPdfAttachments_), so an old invoice can't sneak in even when its thread got a
  // recent reply. Set to 2026-07-01 once the June backlog was caught up by hand — only genuinely new
  // (July-onward) invoices are processed from here on. null = no start cutoff, consider all mail.
  PROCESS_FROM_DATE: '2026-07-01',

  // Gemini
  GEMINI_MODEL: 'gemini-3.1-flash-lite', // less in-demand than gemini-3.5-flash on the free tier — swap back if quota/availability improves
  GEMINI_API_KEY_PROPERTY: 'GEMINI_API_KEY', // Script Properties key name — set this via setup() or manually

  // Decision thresholds
  CONFIDENCE_THRESHOLD: 0.75,   // below this, route to "Needs Review" instead of auto-filing
  DOLLAR_THRESHOLD_FOR_REVIEW: null, // e.g. 5000 to force manual review above $5,000 regardless of confidence. null = disabled.
  // Vendor memory: a vendor needs at least this many past manual corrections TO THE SAME project
  // (recorded in the Override Log) before that history influences a new invoice from them. The
  // influence is conservative — it only rescues an unmatched invoice or flags a contradiction, and
  // always routes to human review, never auto-files. See Main.gs/applyVendorMemory_. null = disable.
  VENDOR_MEMORY_MIN_CORRECTIONS: 2,

  // Drive filing is separated strictly BY STATUS under a base folder (the subproject's folder, or
  // "No Subprojects" under the project when none is assigned) — see DriveService.gs:
  //   Filed           -> <base>/YYYY-MM (processed month)
  //   Needs Review    -> <base>/Needs Review
  //   Not an Invoice  -> <base>/Statements & Others
  STATEMENTS_SUBFOLDER_NAME: 'Statements & Others', // ONLY "Not an Invoice" documents live here
  NEEDS_REVIEW_SUBFOLDER_NAME: 'Needs Review',      // invoices awaiting human review — never mixed with statements
  NO_SUBPROJECT_FOLDER_NAME: 'No Subprojects',      // base folder under the project when no subproject is assigned
  UNMATCHED_SUBFOLDER_NAME: '_Unmatched', // top-level fallback, used only when there's no project match at all
  // DEPRECATED: the "Past Due" lane was removed — overdue invoices now file by month like everything
  // else, and coordinators spot them via the dashboard's Due Date column/sort. Nothing writes new
  // invoices to a "Past Due" folder anymore; the one-time cleanup that emptied the legacy folders has
  // already been run. Kept only so old references don't break — safe to delete once the legacy
  // "Past Due" folders in Drive have been removed by hand.
  PASTDUE_SUBFOLDER_NAME: 'Past Due',
  FILE_BY_MONTH: true, // group auto-filed invoices into a "YYYY-MM" subfolder (by the processed date, matching the filename) under the project folder. false = file straight into the project folder.
  DUE_SOON_DAYS: 7, // flag an invoice for review when its due date is this many days (or fewer) after the email arrived — a short window crams the pay period. Invoices with no due date are not flagged. Set to null to disable this check.

  // Dashboard branding — the logo itself lives in LogoAsset.gs (WCM_LOGO_BASE64), embedded
  // directly rather than read from Drive at render time, so there's nothing to configure here.
  // See LogoAsset.gs to replace it.

  // Automation Start/Pause (dashboard header buttons — see DashboardServer.gs). While paused, the
  // 15-minute trigger still fires but processInvoices() returns immediately without doing anything.
  PAUSED_PROPERTY: 'AUTOMATION_PAUSED', // Script Property that stores the paused state
  // By default anyone who can open the dashboard can press Start/Pause — access to the dashboard
  // itself is already controlled by the Web App deployment's "Who has access" setting (see
  // SETUP.md section 7), so this is not a separate public control. Set to true to additionally
  // restrict Start/Pause to the script owner + DASHBOARD_CONTROL_EMAILS below.
  RESTRICT_DASHBOARD_CONTROLS: false,
  DASHBOARD_CONTROL_EMAILS: [],          // only consulted when RESTRICT_DASHBOARD_CONTROLS is true. e.g. ['controller@wcmcon.com']

  // WCM's own company names and billing/office address(es). On a vendor invoice these appear as the
  // "Bill To" / "Sold To" party — the RECIPIENT (WCM), NOT the project. This matters because WCM's
  // office at 1701 Richmond St IS also a project (43 - Hyland Centre): invoices for OTHER projects
  // still print "1701 Richmond" in the Bill To block, and Gemini kept mis-reading that as the
  // project. Listing them here lets the prompt tell Gemini to ignore these when identifying the
  // project and read the ship-to / job-site / project reference instead. [] = no such steering.
  OWN_BILLING_IDENTIFIERS: [
    'WCM', 'WCM Construction Management', 'WCM Ltd', 'Westdell', 'Westdell Corp', '1701 Richmond'
  ],

  // Project numbers that must never be treated as a real filing destination — e.g. "00" is a
  // template/placeholder row in Project Reference, not an actual project. Gemini is never offered
  // these as options, and even if one somehow came back it would still be rejected by
  // findReferenceMatch_ (see GeminiService.gs).
  EXCLUDE_PROJECT_NUMBERS: ['00'],

  // Spreadsheet tab names (all live in the Sheet this script is bound to)
  SHEET_LOG_TAB: 'Invoice Log',
  SHEET_LOG_ARCHIVE_TAB: 'Invoice Log Archive', // old rows roll here automatically — see SheetService.gs/archiveOldInvoiceLogRows
  // Auto-archive: Invoice Log rows older than this many months (by Date Processed) are moved to the
  // archive tab on a monthly trigger, so the active log — which the dashboard and every run read in
  // full — stays small and fast no matter how many years the system runs. Nothing is deleted; it's
  // just relocated within the same spreadsheet. null = never archive (log grows forever).
  ARCHIVE_AFTER_MONTHS: 12,
  SHEET_ERRORS_TAB: 'Errors',
  SHEET_REFERENCE_TAB: 'Project Reference', // import project_reference.csv here, then add a "Drive Folder ID" column
  SHEET_ALIASES_TAB: 'Project Aliases', // optional — known alternate names/addresses that map straight to a project (see SheetService.gs/getAliasData_)

  // Invoice Log columns, in order — keep this in sync with the actual sheet header row. New
  // columns appended here are added to an EXISTING sheet automatically (see
  // SheetService.gs/ensureSheetHasColumns_), so adding one here is enough — no manual sheet edit.
  LOG_COLUMNS: [
    'Date Processed', 'Date Received', 'Invoice Date', 'Invoice Number', 'Due Date', 'Vendor', 'Project Number', 'Project Name',
    'Subproject Number', 'Subproject Name', 'Amount', 'Currency', 'Status', 'Confidence',
    'Drive Link', 'Gmail Link', 'Match Note', 'Review Note', 'Row ID', 'Drive File ID'
  ],

  // "Feedback" tab — a free-text box on the dashboard, open to any viewer, for reporting issues or
  // suggestions without needing Sheet/Apps Script access. See DashboardServer.gs/submitFeedback.
  SHEET_FEEDBACK_TAB: 'Feedback',
  FEEDBACK_COLUMNS: ['Timestamp', 'Message', 'Page Context'],

  // "Drive Audit" tab — the tracked trail of files that drifted (were moved or deleted directly in
  // Drive instead of via the dashboard) and what the daily reconciler did about it. See Reconcile.gs.
  SHEET_DRIVE_AUDIT_TAB: 'Drive Audit',
  DRIVE_AUDIT_COLUMNS: ['Timestamp', 'Row ID', 'Vendor', 'Invoice Number', 'Detected', 'From (logged)', 'To (actual)', 'Action'],

  // "Vendor Directory" tab — one canonical spelling per vendor, so the log/filenames don't drift
  // into "Copp's Buildall" vs "COPPS BUILDALL" for the same company. Matching is by Normalized Key
  // (case/punctuation/legal-suffix-insensitive), NOT by the display name — so distinct divisions
  // like "J-AAR Civil" and "J-AAR Structure" keep separate rows (their key differs), while pure
  // spelling variants collapse. The FIRST spelling seen becomes canonical; edit the Canonical Name
  // cell to rename a vendor everywhere going forward without breaking matching. See
  // SheetService.gs/canonicalizeVendorName_.
  SHEET_VENDOR_DIRECTORY_TAB: 'Vendor Directory',
  VENDOR_DIRECTORY_COLUMNS: ['Canonical Name', 'Normalized Key', 'First Seen', 'Times Seen', 'Variants Seen'],

  // "Override Log" tab — every manual correction made on the dashboard is recorded here (what the
  // automation originally chose vs. what a human changed it to). This is the learning/audit record:
  // it makes miscategorization patterns visible ("vendor X keeps getting sent to the wrong project")
  // and is the dataset any future auto-learning would draw on. See DashboardServer.gs/logOverride_.
  SHEET_OVERRIDE_LOG_TAB: 'Override Log',
  OVERRIDE_LOG_COLUMNS: [
    'Timestamp', 'Row ID', 'Vendor', 'Invoice Number', 'Amount',
    'From Project', 'From Subproject', 'From Status', 'Original Confidence',
    'To Project', 'To Subproject', 'To Status'
  ],

  // Project Reference columns expected in the sheet (matches project_reference.csv + one extra column)
  REFERENCE_COLUMNS: [
    'Project Number', 'Project Name', 'Subproject Number', 'Subproject Name', 'Drive Folder ID'
  ],

  // Project Aliases columns — a small lookup table for known alternate names/addresses that
  // Gemini couldn't otherwise infer from the Project Reference sheet alone (e.g. a building's
  // street address rather than its marketing name). See SheetService.gs/getAliasData_.
  ALIAS_COLUMNS: ['Alias', 'Project Number', 'Subproject Number'],

  // Test mode (see Test.gs) — never touches real project folders or the real Invoice Log.
  TEST_FOLDER_ID: '1C-AH90kifz_S8M0fHvORYzlihDo0lGle', // "Test_Output_Folder" in Drive
  TEST_LABEL: 'AI-Test-Reviewed',  // applied instead of PROCESSED_LABEL, so tested threads stay available to the real run
  TEST_MAX_THREADS: 5,             // how many threads a single testRun() call processes
  TEST_LOG_TAB: 'Test Log',

  TEST_LOG_COLUMNS: [
    'Date Tested', 'Invoice Date', 'Invoice Number', 'Due Date', 'Vendor', 'Matched Project Number', 'Matched Project Name',
    'Matched Subproject Number', 'Matched Subproject Name', 'Amount', 'Currency', 'Confidence',
    'Rule Check Passed', 'Would File To', 'Test File Copy', 'Status', 'Note', 'Gmail Link'
  ]
};
