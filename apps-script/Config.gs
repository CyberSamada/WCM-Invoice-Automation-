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

  // Gemini
  GEMINI_MODEL: 'gemini-3.5-flash',
  GEMINI_API_KEY_PROPERTY: 'GEMINI_API_KEY', // Script Properties key name — set this via setup() or manually

  // Decision thresholds
  CONFIDENCE_THRESHOLD: 0.75,   // below this, route to "Needs Review" instead of auto-filing
  DOLLAR_THRESHOLD_FOR_REVIEW: null, // e.g. 5000 to force manual review above $5,000 regardless of confidence. null = disabled.

  // Spreadsheet tab names (all live in the Sheet this script is bound to)
  SHEET_LOG_TAB: 'Invoice Log',
  SHEET_ERRORS_TAB: 'Errors',
  SHEET_REFERENCE_TAB: 'Project Reference', // import project_reference.csv here, then add a "Drive Folder ID" column

  // Invoice Log columns, in order — keep this in sync with the actual sheet header row
  LOG_COLUMNS: [
    'Date Processed', 'Invoice Date', 'Due Date', 'Vendor', 'Project Number', 'Project Name',
    'Subproject Number', 'Subproject Name', 'Amount', 'Currency', 'Status', 'Confidence',
    'Drive Link', 'Gmail Link'
  ],

  // Project Reference columns expected in the sheet (matches project_reference.csv + one extra column)
  REFERENCE_COLUMNS: [
    'Project Number', 'Project Name', 'Subproject Number', 'Subproject Name', 'Drive Folder ID'
  ]
};
