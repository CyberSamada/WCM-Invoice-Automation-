# WCM Billing Automation

Automated invoice filing workflow for WCM: reads invoices from Gmail, extracts data with Gemini, files the PDF to the right Google Drive project folder, and logs it in a Google Sheet. Runs entirely inside Google Workspace (Apps Script + Gemini API) — no external server, no third-party automation platform.

This repo exists so any future working session (with Claude or otherwise) can pick up context without re-deriving it from scratch, and so WCM employees can understand what the automation does with their invoice emails.

## What this does (plain-language summary)

When an invoice arrives at **billing@wcmcon.com**:

1. The system reads the email and its PDF attachment.
2. An AI (Gemini) reads the PDF, checks it's actually an invoice (not a statement, receipt, or "update your payment info" email), and pulls out the vendor, invoice number, dates, and amount.
3. It matches the invoice to the correct WCM project/subproject by comparing it against the official project list.
4. If it's confident in the match, it automatically saves a copy of the PDF into that project's subfolder in a dedicated **Invoice Archive** in Google Drive (separate from the project's main working folder), and logs the details in a Google Sheet (**WCM Invoice Log_Private**).
5. If it's *not* confident, or the document isn't actually an invoice, it skips auto-filing and flags the row for a human to review — nothing gets silently misfiled.

The project coordinator/PM checks their project's Invoice Archive subfolder, gives final human confirmation before sending to payment, and the approved invoice then becomes part of that project's progress application — that step is manual and stays outside this automation.

No email is deleted or altered. The system only reads and copies; the original email and any manual process around it are untouched.

## Contents

- [`WCM_Invoice_Automation_Plan.md`](./WCM_Invoice_Automation_Plan.md) — full plan: architecture, workflow steps, decisions log, feasibility validation, open questions. **Start here for technical detail.**
- [`project_reference.csv`](./project_reference.csv) — the full list of WCM construction projects and subprojects (26 projects, from the `+ Properties - Const` shared drive), used as the ground truth for Gemini's project matching.
- [`apps-script/`](./apps-script/) — the actual Apps Script code (Gmail, Gemini, Drive, Sheets services) and [`SETUP.md`](./apps-script/SETUP.md) with deployment steps.
- [`site_coordinators_PRIVATE.md`](./site_coordinators_PRIVATE.md) — project → coordinator/PM contact list (partial, 5 of 26 projects). Not yet wired into the automation.

## Status (as of 2026-07-09)

**Live and running.** Deployed as an Apps Script project bound to the **WCM Invoice Log_Private** Google Sheet, under `wcmmail@westdellcorp.com`. A 15-minute time trigger runs `processInvoices()` automatically. `testRun()` (safe, non-destructive — never touches real project folders) has been validated against real invoice emails with correct project matches at 0.8–1.0 confidence.

Two things still need attention before this is fully hands-off:

- **The Invoice Archive folder structure doesn't exist yet** (dedicated top-level folder + one subfolder per project — see the Plan doc, Section 5) and needs to be created before Drive Folder IDs can be collected. Everything routes to "Needs Review" until this is done.
- **Confirm the latest code is pasted into the live Apps Script project** (`is_invoice` detection, rate-limit retry logic, current model) — the code in this repo is the source of truth; the live editor needs to match it after any update here.

A no-code alternative (Google Workspace Studio / Flows) was evaluated and **ruled out** — it can't dynamically route a file to a different Drive folder per invoice, which is the core requirement here. See the Plan doc's Decisions log for details.

## Quick context for a new session

- `billing@wcmcon.com` is an alias into `wcmmail@westdellcorp.com`; matching mail lands under the Gmail label `+-billing`. Any Gmail-side work targets the real mailbox + label, not the alias.
- The automation must run natively in Google Workspace (Apps Script triggers, not an externally-hosted script or third-party platform like Zapier/Make) — this was an explicit requirement, not a default.
- Gemini access is via a Google AI Studio API key (not Vertex AI) — Workspace accounts get AI Studio by default. The key lives only in Apps Script's Script Properties, never in code or this repo.
- **WCM Invoice Log_Private** is the definitive, permanent production Google Sheet — not a "_Final" or other copy. Don't suggest migrating off it.
- Gemini's structured-output schema (in `apps-script/GeminiService.gs`) uses `generationConfig.responseSchema`, not the nested `responseFormat.text.{...}` shape — the latter is rejected by the live API despite appearing in some docs/examples.
- Current model: `gemini-3.1-flash-lite` (swapped from `gemini-3.5-flash` due to free-tier congestion — see `apps-script/Config.gs` comment). Free-tier cap is 5 requests/minute; the code paces calls and retries on 429/503.
- Sandbox git note: commands here can't write to this mounted repo folder directly (permission-restricted) — git commands need to be run locally by the user (PowerShell).
