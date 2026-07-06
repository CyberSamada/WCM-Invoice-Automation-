# WCM Billing Automation

Automated invoice filing workflow for WCM: reads invoices from Gmail, extracts data with Gemini, files the PDF to the right Google Drive project folder, and logs it in a Google Sheet. Runs entirely inside Google Workspace (Apps Script + Gemini API) — no external server.

This repo exists so any future working session (with Claude or otherwise) can pick up context without re-deriving it from scratch.

## Contents

- [`WCM_Invoice_Automation_Plan.md`](./WCM_Invoice_Automation_Plan.md) — full plan: architecture, workflow steps, prerequisites, decisions log, feasibility validation, open questions. **Start here.**
- [`project_reference.csv`](./project_reference.csv) — the full list of WCM construction projects and subprojects (26 projects, from the `+ Properties - Const` shared drive), used as the ground truth for Gemini's project matching.
- [`apps-script/`](./apps-script/) — the actual Apps Script code (Gmail, Gemini, Drive, Sheets services) and [`SETUP.md`](./apps-script/SETUP.md) with deployment steps.

## Status

Plan validated, code written, not yet deployed. Still blocking deployment: confirming `wcmmail@westdellcorp.com` access (direct vs. delegated), generating the Gemini API key, and getting Drive folder IDs into `project_reference.csv` before it's imported into the live sheet. See `apps-script/SETUP.md` for the exact deployment steps once those are sorted.

## Quick context for a new session

- `billing@wcmcon.com` is an alias into `wcmmail@westdellcorp.com`; matching mail lands under the Gmail label `+-billing`. Any Gmail-side work targets the real mailbox + label, not the alias.
- The automation must run natively in Google Workspace (Apps Script triggers, not an externally-hosted script) — this was an explicit requirement, not a default.
- Gemini access is via a Google AI Studio API key (not Vertex AI) — Workspace accounts get AI Studio by default.
