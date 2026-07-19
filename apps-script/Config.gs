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
  MAX_THREADS_PER_RUN: 5,   // process at most this many email threads per run. null = no limit. Leftover threads are simply picked up next run.
  LOOKBACK_DAYS: null,      // e.g. 30 to only consider mail from the last 30 days (uses Gmail's newer_than: search operator). null = no time limit, considers all mail under the label.
  // Start-date cutoff — only process mail dated on or AFTER this date ("YYYY-MM-DD", inclusive).
  // Anything older is ignored entirely (never processed, never labeled). Set when the June 2026
  // fresh-start reset was done, so the years-deep backlog before it stays untouched — see
  // GmailService.gs/dateRangeQuerySuffix_. null = no start cutoff, consider all mail under the label.
  PROCESS_FROM_DATE: '2026-06-01',

  // Gemini
  GEMINI_MODEL: 'gemini-3.1-flash-lite', // less in-demand than gemini-3.5-flash on the free tier — swap back if quota/availability improves
  GEMINI_API_KEY_PROPERTY: 'GEMINI_API_KEY', // Script Properties key name — set this via setup() or manually

  // Decision thresholds
  CONFIDENCE_THRESHOLD: 0.75,   // below this, route to "Needs Review" instead of auto-filing
  DOLLAR_THRESHOLD_FOR_REVIEW: null, // e.g. 5000 to force manual review above $5,000 regardless of confidence. null = disabled.

  // Anything that isn't auto-filed (statements, low-confidence matches, non-invoices) still gets
  // filed here instead of staying unfiled — see Main.gs/processOneInvoice_ and DriveService.gs.
  STATEMENTS_SUBFOLDER_NAME: 'Statements & Others', // subfolder created inside each project's Invoice Archive folder
  UNMATCHED_SUBFOLDER_NAME: '_Unmatched', // top-level fallback, used only when there's no project match at all
  // Top-level subfolder (a sibling of the month folders, not nested under one) for invoices whose due
  // date has already passed as of today — kept separate from Statements & Others so genuinely overdue
  // invoices are visible in one place without digging through month folders. See isPastDue_ in Main.gs.
  PASTDUE_SUBFOLDER_NAME: 'Past Due',
  FILE_BY_MONTH: true, // group auto-filed invoices into a "YYYY-MM" subfolder (by invoice date) under the project folder. false = file straight into the project folder.
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

  // Project numbers that must never be treated as a real filing destination — e.g. "00" is a
  // template/placeholder row in Project Reference, not an actual project. Gemini is never offered
  // these as options, and even if one somehow came back it would still be rejected by
  // findReferenceMatch_ (see GeminiService.gs).
  EXCLUDE_PROJECT_NUMBERS: ['00'],

  // Spreadsheet tab names (all live in the Sheet this script is bound to)
  SHEET_LOG_TAB: 'Invoice Log',
  SHEET_ERRORS_TAB: 'Errors',
  SHEET_REFERENCE_TAB: 'Project Reference', // import project_reference.csv here, then add a "Drive Folder ID" column
  SHEET_ALIASES_TAB: 'Project Aliases', // optional — known alternate names/addresses that map straight to a project (see SheetService.gs/getAliasData_)

  // Invoice Log columns, in order — keep this in sync with the actual sheet header row. New
  // columns appended here are added to an EXISTING sheet automatically (see
  // SheetService.gs/ensureSheetHasColumns_), so adding one here is enough — no manual sheet edit.
  LOG_COLUMNS: [
    'Date Processed', 'Date Received', 'Invoice Date', 'Due Date', 'Vendor', 'Project Number', 'Project Name',
    'Subproject Number', 'Subproject Name', 'Amount', 'Currency', 'Status', 'Confidence',
    'Drive Link', 'Gmail Link', 'Match Note', 'Review Note', 'Row ID', 'Drive File ID'
  ],

  // "Feedback" tab — a free-text box on the dashboard, open to any viewer, for reporting issues or
  // suggestions without needing Sheet/Apps Script access. See DashboardServer.gs/submitFeedback.
  SHEET_FEEDBACK_TAB: 'Feedback',
  FEEDBACK_COLUMNS: ['Timestamp', 'Message', 'Page Context'],

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
    'Date Tested', 'Invoice Date', 'Due Date', 'Vendor', 'Matched Project Number', 'Matched Project Name',
    'Matched Subproject Number', 'Matched Subproject Name', 'Amount', 'Currency', 'Confidence',
    'Rule Check Passed', 'Would File To', 'Test File Copy', 'Status', 'Note', 'Gmail Link'
  ]
};
