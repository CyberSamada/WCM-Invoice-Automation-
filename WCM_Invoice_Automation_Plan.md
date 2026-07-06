# WCM Billing Automation — Invoice Filing Workflow (Plan)

**Status:** Draft, reference data confirmed, ready to move to implementation
**Owner:** Ahmed
**Last updated:** 2026-07-06

## 1. Goal

Automatically process invoices arriving at `billing@wcmcon.com`: read the email, extract data from the PDF attachment, determine which project/subproject it belongs to, file the PDF into the correct Google Drive folder, and log the transaction in a Google Sheet. Everything runs natively inside Google Workspace (Apps Script + Gemini API + Drive + Sheets) — no external server, and no continuous involvement from Claude once deployed.

## 2. Stack

| Component | Tool | Purpose |
|---|---|---|
| Automation engine | Google Apps Script | Orchestrates the whole workflow, runs on a time-driven trigger |
| Email source | Gmail (`wcmmail@westdellcorp.com`, alias `billing@wcmcon.com`) | Source of invoice emails + PDF attachments |
| Extraction & matching | Gemini API (model: Gemini 3.5 Flash), called from Apps Script via `UrlFetchApp` | Reads PDF content natively, extracts invoice fields, matches to a project/subproject |
| Reference data | `project_reference.csv` (this repo) → will live in a Google Sheet/Doc Gemini's prompt can pull from | Ground truth Gemini uses to pick the right project/subproject |
| Filing destination | Google Drive — `+ Properties - Const` shared drive | Per-project (and per-subproject) folders where PDFs get filed |
| Logging | Google Sheet | One row per processed invoice |
| Optional reporting | Looker Studio | Dashboard on top of the log sheet (open balances, upcoming due dates, spend by project) |
| Key management | Google AI Studio ([aistudio.google.com/apikey](https://aistudio.google.com/apikey)) | Where the Gemini API key is generated (Workspace accounts get access by default) |

## 3. Workflow steps

1. **Trigger** — a time-driven Apps Script trigger runs every 15–30 minutes (configurable) and checks for new, unprocessed messages. `billing@wcmcon.com` is an alias that routes into `wcmmail@westdellcorp.com`, where matching mail lands under the Gmail label `+-billing`. The Apps Script project is created under (or bound to) `wcmmail@westdellcorp.com`, and the Gmail search query is scoped to `label:"+-billing"` combined with an "unprocessed" label to avoid re-scanning old mail.
2. **Read email + attachment** — for each matching thread, pull the PDF attachment(s) as a blob.
3. **Extract with Gemini** — send the PDF as inline base64 data, in the same request as the text prompt, to the Gemini `generateContent` endpoint. The prompt includes the current projects/subprojects reference list (`project_reference.csv`). Ask it to return structured JSON:
   - vendor / company name
   - invoice number
   - invoice date
   - due date
   - amount + currency
   - best-match project number and subproject number
   - a confidence score for the match
4. **Confidence check** —
   - High confidence → proceed to auto-file.
   - Low confidence / no match → skip auto-filing, flag the row in the log sheet as "Needs Review" with the email link, so nothing silently gets filed to the wrong project.
5. **File to Drive** — locate the matched project/subproject subfolder under `+ Properties - Const` and save the PDF there using a consistent naming convention, e.g. `YYYY-MM-DD_Vendor_InvoiceNumber.pdf`.
6. **Log the row** — append to the log sheet: date processed, invoice date, due date, vendor/company, project, subproject, amount, currency, Drive file link, Gmail thread link, status (Filed / Needs Review), confidence score.
7. **Mark as processed** — label the Gmail thread (e.g. `Invoice-Processed`) so it's never reprocessed.
8. **Error handling** — if Gemini extraction fails, the PDF can't be parsed, or Drive filing errors out, log it to an "Errors" tab and optionally send a notification email so nothing gets silently dropped.

## 4. Google Sheet structure (log)

One tab `Invoice Log` with columns: `Date Processed | Invoice Date | Due Date | Vendor | Project | Subproject | Amount | Currency | Status | Confidence | Drive Link | Gmail Link`.
A second tab `Needs Review` (or a filtered view) surfaces anything Gemini couldn't confidently match.
A third tab `Errors` captures processing failures.

## 5. Drive structure (confirmed)

Projects live under the `+ Properties - Const` shared drive, one folder per project, named `<project number> - <PROJECT NAME>` (e.g. `02 - HYDE PARK SQUARE`). Subprojects are one level below, named `<subproject number> <name>` (e.g. `2.1 North Expansions`). Full current list: see [`project_reference.csv`](./project_reference.csv) — 26 projects total.

Not every project has numbered subprojects — 7 of them (00 Template, 46+ Gateway Village, 46+++ Ambassador Plaza, 47 Glenns, 48 Arnprior, 55 Clarke, 59 Elgin, 60 Wyandotte) only have generic phase folders (Design Development / Construction Stage / Coordinations) or admin folders. Invoices matched to these should file at the project level with no subproject.

**Known data quirk:** project 05 (Oxford Westdel Centre) has two folders both labeled `5.1` — worth flagging to whoever maintains the Drive structure, but not something the automation needs to resolve on its own (it can match on folder name/content, not just the number).

## 6. Prerequisites before building

- [x] **Drive folder structure** — confirmed, see Section 5 and `project_reference.csv`.
- [x] **Projects/subprojects reference list** — extracted and saved as `project_reference.csv`. Still need to decide: does Gemini's prompt read this CSV via a Google Sheet copy, or does Apps Script embed it directly in the prompt text? (Recommend a Sheet copy so it's easy to update as new projects are added, without redeploying code.)
- [ ] **Correct Google account/Drive connected** — needs to be confirmed sorted (was flagged mid-project; revisit before build).
- [ ] **Gemini API key** — generate one at [aistudio.google.com/apikey](https://aistudio.google.com/apikey) using the Workspace account. Store the key in the Apps Script project's Script Properties, not hardcoded in the code. New keys are auto-created as "auth keys" tied to a service account — use one of these rather than an old-style unrestricted key, since Google is phasing those out through 2026 (unrestricted standard keys stop working June 19 2026; all standard keys stop working September 2026).
- [ ] **Gmail access** — read + modify (for labeling) on `wcmmail@westdellcorp.com`, scoped to the `+-billing` label. Confirm whether there's direct access to `wcmmail@westdellcorp.com` to create/authorize the Apps Script project there, or delegated access needs to be set up first.
- [ ] **Drive scope** — write access to the `+ Properties - Const` shared drive.
- [ ] **Dollar-threshold rule (optional)** — should invoices above a certain amount always route to manual review regardless of match confidence?

## 7. Rollout plan

1. Build in "dry-run" mode: Gemini extracts + matches, everything gets logged, but no filing/moving of files happens yet. Review a batch of real invoices against the log for accuracy.
2. Once matching accuracy looks good, turn on auto-filing for high-confidence matches only; keep low-confidence ones routed to manual review.
3. Add notifications (email or Chat) for new "Needs Review" items and processing errors.
4. Optional: Looker Studio dashboard on the log sheet for a running view of amounts by project, upcoming due dates, and vendor totals.

## 8. Decisions log

- **Everything runs natively in Google Workspace** (Apps Script, not an external server or Claude-run automation) — Ahmed's explicit call, so this stays maintainable without Claude in the loop long-term.
- **Gemini via Google AI Studio API key** (not Vertex AI / service account) — simpler for an Apps Script setup; Workspace accounts get AI Studio access by default.
- **Gemini reads PDFs natively** (inline base64 in the same `generateContent` call) — no separate OCR step needed; Gemini handles up to 50MB/1000 pages this way.
- **Mailbox routing confirmed:** `billing@wcmcon.com` → alias into `wcmmail@westdellcorp.com`, label `+-billing`. Automation must target the real mailbox + label, not the alias address directly.
- **Drive structure confirmed:** `+ Properties - Const` shared drive, 26 projects, subprojects one level below where they exist (see `project_reference.csv`).

## 9. Open questions

- Where should the live reference list (used by Gemini's prompt) actually live — a Google Sheet copy of `project_reference.csv`, kept in sync manually or via a small script? Or should Apps Script just read the CSV logic directly?
- Is `wcmmail@westdellcorp.com` mailbox access direct or delegated?
- Any invoices that should never be auto-filed regardless of confidence (e.g. above a dollar threshold)?
- Should new projects/subprojects added to Drive in the future require a manual reference-list update, or should the script periodically re-scan the Drive structure itself?
