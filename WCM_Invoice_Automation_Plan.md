# WCM Billing Automation — Invoice Filing Workflow (Plan)

**Status:** Live and deployed — see [`apps-script/`](./apps-script/) and [`apps-script/SETUP.md`](./apps-script/SETUP.md). `wcmmail@westdellcorp.com` access and the Gemini API key are both confirmed and in place; `testRun()` has succeeded against real invoice emails. Still open: most Drive folder IDs in `project_reference.csv` / the live `Project Reference` tab are unfilled, so auto-filing is only active for projects that have one.
**Owner:** Ahmed
**Last updated:** 2026-07-09

## 1. Goal

Automatically process invoices arriving at `billing@wcmcon.com`: read the email, extract data from the PDF attachment, determine which project/subproject it belongs to, file the PDF into the correct Google Drive folder, and log the transaction in a Google Sheet. Everything runs natively inside Google Workspace (Apps Script + Gemini API + Drive + Sheets) — no external server, and no continuous involvement from Claude once deployed.

## 2. Stack

| Component | Tool | Purpose |
|---|---|---|
| Automation engine | Google Apps Script | Orchestrates the whole workflow, runs on a time-driven trigger |
| Email source | Gmail (`wcmmail@westdellcorp.com`, alias `billing@wcmcon.com`) | Source of invoice emails + PDF attachments |
| Extraction & matching | Gemini API (model: `gemini-3.1-flash-lite`, configurable in `Config.gs`), called from Apps Script via `UrlFetchApp` | Reads PDF content natively, extracts invoice fields, classifies whether it's actually an invoice, matches to a project/subproject |
| Reference data | `project_reference.csv` (this repo) → will live in a Google Sheet/Doc Gemini's prompt can pull from | Ground truth Gemini uses to pick the right project/subproject |
| Filing destination | Google Drive — dedicated **Invoice Archive** folder, one subfolder per project (separate from the project's main working folder) | Where filed PDFs land for a coordinator/PM to review and act on |
| Logging | Google Sheet | One row per processed invoice |
| Optional reporting | Looker Studio | Dashboard on top of the log sheet (open balances, upcoming due dates, spend by project) |
| Key management | Google AI Studio ([aistudio.google.com/apikey](https://aistudio.google.com/apikey)) | Where the Gemini API key is generated (Workspace accounts get access by default) |

## 3. Workflow steps

1. **Trigger** — a time-driven Apps Script trigger runs every 15–30 minutes (configurable) and checks for new, unprocessed messages. `billing@wcmcon.com` is an alias that routes into `wcmmail@westdellcorp.com`, where matching mail lands under the Gmail label `+-billing`. The Apps Script project is created under (or bound to) `wcmmail@westdellcorp.com`, and the Gmail search query is scoped to `label:"+-billing"` combined with an "unprocessed" label to avoid re-scanning old mail.
2. **Read email + attachment** — for each matching thread, pull the PDF attachment(s) as a blob.
3. **Extract with Gemini** — send the PDF as inline base64 data, in the same request as the text prompt, to the Gemini `generateContent` endpoint, using Gemini's **structured output mode** (a JSON Schema passed via `generationConfig.responseSchema` — note: *not* the nested `responseFormat.text.{mimeType,schema}` shape, which the live v1beta REST API rejects despite appearing in some references) rather than just asking for JSON in the prompt text — this guarantees syntactically valid JSON back, every time. The prompt includes the current projects/subprojects reference list (`project_reference.csv`). Schema fields:
   - `is_invoice` — boolean; true only for a genuine invoice/bill requesting payment, false for statements, payment-info updates, receipts, or other non-invoice mail. Documents that fail this check are logged as "Not an Invoice" and never auto-filed.
   - vendor / company name
   - invoice number
   - invoice date
   - due date
   - amount + currency
   - best-match project number — constrained to an `enum` of the actual project numbers in `project_reference.csv`, so Gemini can't return a project number that doesn't exist
   - best-match subproject number — same `enum` approach, scoped to valid subprojects
   - a confidence score for the match
4. **Confidence check** — two layers, not just Gemini's self-reported score (LLM-reported confidence is a useful signal but isn't a calibrated probability, so it shouldn't be trusted alone):
   - **Rule-based check:** does the returned project/subproject number actually exist in `project_reference.csv`? (The `enum` constraint above should already guarantee this, but re-validate in Apps Script code too, since it's cheap insurance.)
   - **Confidence check:** high self-reported confidence + passes rule-based check → proceed to auto-file.
   - Low confidence, failed rule-based check, or no match → skip auto-filing, flag the row in the log sheet as "Needs Review" with the email link, so nothing silently gets filed to the wrong project.
5. **File to Drive** — save the PDF into that project's subfolder inside the **Invoice Archive** (a separate top-level folder, not the project's main working folder — see Section 5), using its Drive folder ID (not a name-based search), with a consistent naming convention, e.g. `YYYY-MM-DD_Vendor_InvoiceNumber.pdf`. Folder IDs live in the `Drive Folder ID` column of the reference data — see Section 6.
6. **Log the row** — append to the log sheet: date processed, invoice date, due date, vendor/company, project, subproject, amount, currency, Drive file link, Gmail thread link, status (Filed / Needs Review), confidence score.
7. **Mark as processed** — label the Gmail thread (e.g. `Invoice-Processed`) so it's never reprocessed.
8. **Error handling** — if Gemini extraction fails, the PDF can't be parsed, or Drive filing errors out, log it to an "Errors" tab and optionally send a notification email so nothing gets silently dropped.
9. **Human step (outside this automation)** — the project coordinator/PM checks their project's Invoice Archive subfolder, does final confirmation before sending to payment, and the approved invoice then becomes part of that project's progress application. This automation's scope ends at "filed + logged, ready for review" — it doesn't touch payment approval or progress application assembly.

## 4. Google Sheet structure (log)

One tab `Invoice Log` with columns: `Date Processed | Invoice Date | Due Date | Vendor | Project | Subproject | Amount | Currency | Status | Confidence | Drive Link | Gmail Link`.
A second tab `Needs Review` (or a filtered view) surfaces anything Gemini couldn't confidently match.
A third tab `Errors` captures processing failures.

## 5. Drive structure (confirmed)

Projects live under the `+ Properties - Const` shared drive, one folder per project, named `<project number> - <PROJECT NAME>` (e.g. `02 - HYDE PARK SQUARE`). Subprojects are one level below, named `<subproject number> <name>` (e.g. `2.1 North Expansions`). Full current list: see [`project_reference.csv`](./project_reference.csv) — 26 projects total.

Not every project has numbered subprojects — 7 of them (00 Template, 46+ Gateway Village, 46+++ Ambassador Plaza, 47 Glenns, 48 Arnprior, 55 Clarke, 59 Elgin, 60 Wyandotte) only have generic phase folders (Design Development / Construction Stage / Coordinations) or admin folders. Invoices matched to these should file at the project level with no subproject.

**Known data quirk:** project 05 (Oxford Westdel Centre) has two folders both labeled `5.1` — worth flagging to whoever maintains the Drive structure. This also reinforces why filing should key off explicit folder IDs rather than name matching (see below) — folder names alone aren't reliably unique.

### Invoice Archive (2026-07-09 decision)

Filed invoices do **not** go into each project's main working folder, and do not go into the project's existing "Progress Application" folder either. They go into a **separate, dedicated Invoice Archive** — one top-level folder, with one subfolder per project (matching the same project numbering as the main structure).

Why: mail through `billing@wcmcon.com` isn't limited to formal progress-billing documents — real examples so far include general subcontractor invoices (Viking Masonry, CANAM, C25 Excavating) and straightforward supply invoices (ULINE). Filing all of those into a project's "Progress Application" folder would miscategorize anything that isn't an actual progress application. A dedicated archive avoids that mismatch while still giving each project a predictable, single place for its invoices.

Workflow once a PDF lands there: the project coordinator/PM checks their subfolder, gives final human confirmation before sending to payment, and the approved invoice then gets folded into that project's progress application as part of the existing (manual, outside this automation) payment process.

**Setup:** the Invoice Archive parent folder is the existing "Outputs" folder in Drive (ID `17X2BqaT4GxhrqAUjAWbV-d_QnkpCAHfb`). Per-project subfolders and their `Drive Folder ID` entries are created automatically, not by hand — `apps-script/DriveSetup.gs`'s `createInvoiceArchiveFolders()` reads the unique project numbers/names straight from the live "Project Reference" tab, creates one subfolder per project under that parent (skipping any that already exist, so it's safe to re-run), and writes each folder's ID into the `Drive Folder ID` column for every row belonging to that project. One-time run from the Apps Script editor; see Section 6 and Task #7.

**Filing approach:** the script files directly via `DriveApp.getFolderById()` using the folder ID from the reference data — no name-based search, so it's immune to naming quirks like the `5.1` duplicate above.

## 6. Prerequisites before building

- [x] **Drive folder structure** — confirmed, see Section 5 and `project_reference.csv`.
- [x] **Projects/subprojects reference list** — extracted and saved as `project_reference.csv`. Still need to decide: does Gemini's prompt read this CSV via a Google Sheet copy, or does Apps Script embed it directly in the prompt text? (Recommend a Sheet copy so it's easy to update as new projects are added, without redeploying code.)
- [ ] **Invoice Archive folder structure** — run `createInvoiceArchiveFolders()` (`apps-script/DriveSetup.gs`) once to create the 26 per-project subfolders under the "Outputs" parent folder and populate the `Drive Folder ID` column automatically. Not yet run.
- [x] **Correct Google account/Drive connected** — confirmed; script is bound to `wcmmail@westdellcorp.com`.
- [x] **Gemini API key** — generated and stored in Script Properties (`GEMINI_API_KEY`), never in code.
- [x] **Gmail access** — confirmed direct access to `wcmmail@westdellcorp.com` / the `+-billing` label.
- [x] **Drive scope** — write access to `+ Properties - Const` confirmed via successful `testRun()` filing to a test folder.
- [ ] **Dollar-threshold rule (optional)** — `CONFIG.DOLLAR_THRESHOLD_FOR_REVIEW` exists and is currently `null` (disabled). Set a value if desired.

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
- **Google Workspace Studio (Flows) evaluated and rejected as the primary engine (2026-07-08/09):** tested extensively as a no-code alternative to Apps Script. Confirmed, via live testing and official docs, that Studio's "Add email attachments to Drive" step only supports a static, UI-picked destination folder — no dynamic variable can be bound to it — which makes per-invoice Drive routing (the core requirement of this whole project) impossible in Studio. Also confirmed Studio's "Send a webhook" step (which could have bridged to Apps Script) is in limited preview and unavailable on this account. Apps Script has no such restriction and became the sole production path.
- **`WCM Invoice Log_Private` is the definitive, permanent production Sheet** — not a "_Final" or other copy that might exist. Ahmed's explicit call; don't suggest migrating off it.
- **Explicit `is_invoice` classification added** to the Gemini schema, rather than relying on confidence score alone — a real-world test run showed a vendor "invoice" that was actually a payment-info update email, which the confidence score alone didn't reliably catch.
- **Rate-limit handling added:** free-tier Gemini keys cap at 5 requests/minute. Fixed with (a) retry-with-backoff on HTTP 429/503 (`fetchWithRetry_` in `GeminiService.gs`), and (b) proactive `Utilities.sleep()` pacing between calls in both `Main.gs` and `Test.gs`. Considered and rejected rotating multiple free API keys to dodge the limit — likely a Terms of Service violation and more fragile than just pacing calls or enabling billing if volume grows.
- **Model swapped from `gemini-3.5-flash` to `gemini-3.1-flash-lite`** — the former experienced persistent free-tier congestion (503 "high demand") as the newest/most popular model; the latter resolved it.
- **Filed invoices go into a dedicated Invoice Archive, not a project's main working folder or its "Progress Application" folder** — see Section 5 for full reasoning. Coordinators/PMs pull invoices from their project's Archive subfolder, give final human confirmation before payment, then the approved invoice becomes part of that project's progress application (manual, outside this automation's scope).
- **Invoice Archive subfolders + Drive Folder IDs are created/populated by script (`createInvoiceArchiveFolders()` in `apps-script/DriveSetup.gs`), not by hand** — Ahmed's explicit preference, to avoid manually creating 26 folders and copy-pasting IDs. The parent is the existing "Outputs" folder (`17X2BqaT4GxhrqAUjAWbV-d_QnkpCAHfb`).
- **Nothing is ever left unfiled (2026-07-09):** anything that isn't a confident, auto-fileable invoice — statements, low-confidence matches, over-dollar-threshold invoices, non-invoices — now gets filed into a `Statements & Others` subfolder inside that project's Invoice Archive folder, rather than staying unfiled with only a Gmail Link. If there's no project match at all, it goes into a top-level `_Unmatched` subfolder instead. `getOrCreateNamedSubfolder_()` (`DriveService.gs`) is the shared helper; `Test.gs`'s `testRun()` mirrors the exact same logic so a test run is a true preview of real filing behavior.
- **Trashed Drive folders are treated as missing, not valid:** `DriveApp.getFolderById()` resolves a trashed folder without throwing, which would otherwise let a deleted Invoice Archive folder keep silently absorbing files (invisible in Trash) or `createInvoiceArchiveFolders()` treat it as "already provisioned." Both `fileInvoiceToDrive_()` and `createInvoiceArchiveFolders()` now explicitly check `folder.isTrashed()` and fail loudly / recreate rather than silently reuse.

## 8b. Site coordinators

[`site_coordinators_PRIVATE.md`](./site_coordinators_PRIVATE.md) maps some projects/subprojects to a site coordinator name + email. It's committed to this repo but intentionally not linked from the README — kept low-profile rather than front-and-center since it contains staff contact info, though the repo itself is public. Not wired into the automated workflow yet.

## 9a. Feasibility check (2026-07-06)

Before moving to implementation, verified the plan against Google's current documentation rather than assuming:

**Will Gemini actually work for this?** Yes — confirmed against Gemini's own docs. Gemini's structured output feature explicitly lists "data extraction" (pulling names/dates from documents) and "structured classification" as primary use cases, and Google's own Gemini cookbook has a worked example for this *exact* scenario: [`Pdf_structured_outputs_on_invoices_and_forms.ipynb`](https://github.com/google-gemini/cookbook/blob/main/examples/Pdf_structured_outputs_on_invoices_and_forms.ipynb) — structured extraction from invoice/form PDFs. This isn't a stretch use case for the model; it's a documented, first-party pattern. Structured output (JSON Schema mode) is supported on Gemini 2.5 and 3.x Flash/Pro models, which covers whatever model is current when this gets built.

**Is Apps Script + `UrlFetchApp` capable of this, quota-wise?** Yes, comfortably, for this volume. Apps Script's documented quotas (for Workspace accounts): 30 minutes of runtime per trigger execution, response/payload sizes up to 50MB for `UrlFetchApp`, tens of thousands of `UrlFetchApp` calls per day. A construction company's invoice volume (realistically dozens per day, not thousands) is far below any of these ceilings. Worth a final glance at [the live quotas page](https://developers.google.com/apps-script/guides/services/quotas) before build, since Google can adjust numbers, but there's no realistic scenario at this volume where quotas become a constraint.

**Is this the best route, vs. alternatives?**
- **Zapier/Make/other third-party automation platforms** — ruled out per Ahmed's explicit requirement that everything run natively in Google Workspace, not through a third-party automation layer.
- **Google Cloud Functions + Gmail push notifications (Pub/Sub)** — would give near-instant processing instead of a 15–30 min polling delay, but adds a GCP project, Pub/Sub topic, IAM setup, and billing to maintain — real infrastructure overhead for a workflow where "processed within half an hour of arrival" is entirely sufficient. Not worth the added complexity here.
- **Document AI Invoice Parser** (Google Cloud's purpose-built invoice OCR model) — genuinely more specialized at raw field extraction, but it only solves half the problem: it doesn't do the project/subproject matching against WCM's internal reference list, which is arguably the *harder* part of this workflow and needs Gemini-style reasoning either way. Adding Document AI on top would mean two API integrations, two billing surfaces, and more moving parts for no clear accuracy win on the part that actually differentiates this task. Gemini alone, doing extraction and matching in one call, is simpler and sufficient.

**Conclusion:** Apps Script + Gemini `generateContent` (structured output mode) + Drive + Sheets remains the right architecture — it's the simplest stack that satisfies "runs natively in Google Workspace," handles both extraction and project-matching in one model call, and comfortably fits within documented quotas for this volume of invoices.

## 9. Open questions

- Where should the live reference list (used by Gemini's prompt) actually live — a Google Sheet copy of `project_reference.csv`, kept in sync manually or via a small script? Or should Apps Script just read the CSV logic directly?
- Is `wcmmail@westdellcorp.com` mailbox access direct or delegated?
- Any invoices that should never be auto-filed regardless of confidence (e.g. above a dollar threshold)?
- Should new projects/subprojects added to Drive in the future require a manual reference-list update, or should the script periodically re-scan the Drive structure itself?
