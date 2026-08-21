/**
 * ExtractionNotes.gs
 * The Gemini-side equivalent of CLAUDE.md: standing domain knowledge injected into every extraction
 * prompt, so lessons about how WCM's invoices actually look are never re-learned per invoice.
 *
 * The "AI Notes" sheet tab (one note per row in a "Note" column) is the single runtime home — the
 * team edits notes there (or via the dashboard) with no code deploy. SEED_EXTRACTION_NOTES below is
 * the shipped DEFAULT set, copied into that tab exactly once by SheetService.gs/ensureKnowledgeSeeded_
 * and never read directly at extraction time after that. A note that stops being true is deleted in
 * the tab (a delete sticks — the seed won't re-add it). New durable lessons can be added to the seed
 * here for fresh installs AND to the live tab; see CLAUDE.md's maintenance rule.
 *
 * Keep each note short, factual, and always-true; this text is read on every extraction, so it
 * shapes every match.
 */
const SEED_EXTRACTION_NOTES = [
  'WCM / Westdell is always the CUSTOMER on these invoices, never the vendor. If "WCM Construction Management" or "Westdell" appears to be the issuer, look again — the vendor is the other party.',
  'Vendors\' own job/PO references (formats like "24-146" or "6.1-4") are NOT WCM project numbers. Match projects only against the reference list and aliases provided.',
  'The email subject or an invoice "Subject:/Re:/Project" line often names the job-site address — weigh it heavily when matching the project.',
  'Hyland Centre (project 43) has two subprojects for the same unit 2D: 43.7 "2F (2D - TBC)" is the base/vacant unit and 43.14 "2F (2D - MAC)" is the MAC tenant fit-out. Use 43.14 when the tenant MAC is named; "MAC" alone is not enough, because 43.10 is "RHC - MAC Unit (Dollarama)".',
  'Progress billings with holdback lines (e.g. "LESS 10% HOLDBACK") are normal construction invoices; the amount due is the total AFTER holdback, including taxes.',
  'Some invoices reference their own Subcontract/PO/Change Order number directly (e.g. "SC-1234-002", "PO# 88213", "CO #3") — extract these (commitment_number/po_number/change_order_number) whenever explicitly printed; a stated commitment number resolves the Procore match unambiguously even when the vendor has several commitments on one project. Most invoices are a simple lump-sum bill with just a total due, NOT a formatted AIA-style Schedule of Values (Item No / Scheduled Value / % Complete / Retainage columns) — only mark is_sov_formatted true when that continuation-sheet structure is genuinely present, and never invent a retainage rate the invoice itself doesn\'t state.'
];

let EXTRACTION_NOTES_CACHE_ = null; // per-execution cache — the sheet is read at most once per run

/**
 * All active extraction notes, read from the "AI Notes" tab (the single source — the code seed is
 * migrated into that tab once by ensureKnowledgeSeeded_, called here). Deduplicated
 * case-insensitively. Returns an array of strings; [] disables the section.
 */
function getExtractionNotes_() {
  if (EXTRACTION_NOTES_CACHE_) return EXTRACTION_NOTES_CACHE_;
  ensureKnowledgeSeeded_();
  const out = [];
  const seen = {};
  const add = (text) => {
    const t = String(text == null ? '' : text).trim();
    if (!t) return;
    const key = t.toLowerCase();
    if (seen[key]) return;
    seen[key] = true;
    out.push(t);
  };

  try {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEET_AI_NOTES_TAB);
    if (sheet) {
      const values = sheet.getDataRange().getValues();
      const header = values.shift() || [];
      const nIdx = header.indexOf('Note');
      if (nIdx > -1) values.forEach(row => add(row[nIdx]));
    }
  } catch (e) { /* notes are additive — a sheet hiccup must never block extraction */ }

  EXTRACTION_NOTES_CACHE_ = out;
  return out;
}
