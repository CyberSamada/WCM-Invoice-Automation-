# Deploying the invoice automation

## 1. Create the Apps Script project

1. Go to [script.google.com](https://script.google.com), signed in as **wcmmail@westdellcorp.com** (or whichever account has access to the `+-billing` label — see the open question in the plan doc about direct vs. delegated access).
2. Create a new project, or better: create a new Google Sheet first (this becomes the log spreadsheet), then Extensions > Apps Script from inside it, so the script is bound to that Sheet.
3. Delete the default `Code.gs` boilerplate. Create each file in this folder (`Config.gs`, `Main.gs`, `GmailService.gs`, `GeminiService.gs`, `DriveService.gs`, `SheetService.gs`, `Setup.gs`, `Test.gs`, `DriveSetup.gs`, `DashboardServer.gs`, `Dashboard.html`) as a matching file in the Apps Script editor, and paste in the contents. For `appsscript.json`, use the editor's "Show manifest file" option (Project Settings > check "Show appsscript.json") and replace its contents. `Dashboard.html` should be created as an **HTML** file, not a `.gs` file — use the "+" next to Files and choose "HTML". (The dashboard server code lives in `DashboardServer.gs` rather than `Dashboard.gs` because the editor won't allow a script file and an HTML file to both be named "Dashboard".)

## 2. Set the Gemini API key

1. Generate a key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey), signed in as the same account.
2. In the Apps Script editor: Project Settings (gear icon) > Script Properties > Add script property.
3. Name: `GEMINI_API_KEY`. Value: the key you generated.

## 3. Set up the reference data

1. Import [`project_reference.csv`](../project_reference.csv) into a new tab.
2. Run the `setup()` function once (select it in the function dropdown, click Run) — this creates the `Project Reference`, `Invoice Log`, and `Errors` tabs if they don't already exist, with the right headers.
3. Rename/merge your imported CSV data into the `Project Reference` tab so its columns match: `Project Number | Project Name | Subproject Number | Subproject Name | Drive Folder ID`.
4. Run `createInvoiceArchiveFolders()` (in `DriveSetup.gs`) once. It creates one subfolder per project under the Invoice Archive parent folder (`INVOICE_ARCHIVE_PARENT_FOLDER_ID` — currently the "Outputs" folder), and automatically fills in the **Drive Folder ID** column for every row. Safe to re-run — it reuses folders that already exist by name instead of duplicating them. No manual folder creation or ID copy-pasting needed.
5. `setup()` also creates a `Project Aliases` tab (columns: `Alias | Project Number | Subproject Number`). This is for invoices that reference a project by a name or street address that doesn't appear anywhere in `Project Reference` — Gemini gets this list alongside the reference data and uses it as a direct lookup. It's seeded with one real example (`1105 Wellington - Old Bay` → project `54`, White Oaks Mall); add a row any time you notice Gemini flagging an invoice it couldn't place (see step 6 below) but you recognize the address. This tab is entirely optional — leave it empty (or delete extra rows) if you don't need it.
6. Project number `00` (`PROJECT TEMPLATE`) is a placeholder row in `Project Reference`, not a real project — it's automatically excluded from anything Gemini or the matching logic can select (`CONFIG.EXCLUDE_PROJECT_NUMBERS` in `Config.gs`). If you add other non-project placeholder rows later, add their project numbers to that list too.

## 4. Authorize and test

1. Run `processInvoices` once manually from the editor. The first run will prompt you to authorize the scopes listed in `appsscript.json` (Gmail modify, Drive, Sheets, external requests) — review and accept.
2. Check the `Invoice Log` tab for a new row, and check `Errors` if something went wrong.
3. **Recommended:** for the first batch of real invoices, manually check every "Filed" row against the actual Drive folder before trusting it fully — this is the "dry run" period from the plan doc's rollout section.

### Safer alternative: `testRun()` instead of `processInvoices()`

Before letting the real function loose on a backlog of real invoices, `testRun()` (in `Test.gs`) validates the whole pipeline — real Gmail access, real Gemini extraction/matching — **without** ever touching a real project folder or the real `Invoice Log`:

1. Create one Drive folder anywhere convenient, named something like "Invoice Automation — Test Output". Copy its ID from the URL.
2. Paste that ID into `CONFIG.TEST_FOLDER_ID` in `Config.gs`.
3. Run `testRun` from the function dropdown. It processes up to `CONFIG.TEST_MAX_THREADS` (default 5) real emails, files copies (prefixed `TEST_`) into that one test folder regardless of what they matched to, and logs results — including a **"Would File To"** link showing the real folder it would have used — to a new `Test Log` tab.
4. Tested threads get an `AI-Test-Reviewed` label (not `Invoice-Processed`), so they're untouched from `processInvoices()`'s perspective and will still be picked up for real later. Read/unread status is restored automatically. Nothing needs to be manually undone.
5. Run it again anytime — it always picks fresh, not-yet-tested threads.

### How confidence scores decide auto-file vs. "Needs Review"

Gemini reports a **confidence** score (0–1) alongside its project/subproject match, and that score — not just whether it found *a* match — is what decides whether an invoice gets auto-filed or routed to a human. `CONFIG.CONFIDENCE_THRESHOLD` in `Config.gs` (default **0.75**) is the cutoff: at or above it, an invoice is filed straight into the matched project's folder; below it, "Filed" never happens automatically — it lands in "Needs Review" (or that project's "Statements & Others" subfolder) instead, however plausible the guess looked.

The score isn't a vague "how sure are you" — the prompt gives Gemini an explicit rubric tied to what kind of evidence it actually found on the invoice, seen below. This matters because an LLM asked generically "how confident are you" tends to answer "pretty confident" almost regardless of the evidence; grounding the score in evidence type keeps it meaningful and keeps it consistent invoice to invoice:

| Score range | What it means | Auto-files? |
|---|---|---|
| 0.90 – 1.00 | The invoice states the project name/number, or a listed alias, explicitly. | Yes |
| 0.75 – 0.89 | A specific address or tenant name clearly matches exactly one listed project — no other listed project is also a plausible fit. | Yes |
| 0.50 – 0.74 | Some supporting detail exists, but there's real ambiguity (could plausibly match more than one project, or the detail is only partial). | No — Needs Review |
| Below 0.50 | Little concrete evidence ties the invoice to the chosen project. Gemini is instructed to prefer `project_number = "UNKNOWN"` over guessing this low. | No — Needs Review |
| 0 (exact) | `project_number` is `"UNKNOWN"` — no project could be confidently identified at all. | No — Needs Review / `_Unmatched` |

Whenever Gemini can't confidently place an invoice, it still writes a **Match Note** (a new column in the `Invoice Log` tab, and shown as a tooltip on the status badge on the dashboard) explaining what it found and its best guess — e.g. *"invoice is for '1105 Wellington - Old Bay'; not on the list, but tenant/address details suggest it may belong to project 54 WHITE OAKS MALL — needs human confirmation."* That's how you catch cases worth adding to the `Project Aliases` tab (see step 5 above) so the same invoice matches automatically next time.

If you tune `CONFIDENCE_THRESHOLD`, keep it inside the 0.75–0.89 band shown above (or edit the rubric text in `GeminiService.gs`'s prompt to match) so the cutoff still lines up with a tier boundary in the rubric rather than splitting one — otherwise the threshold and the instructions Gemini is actually following fall out of sync.

## 5. Turn on the recurring trigger

Either:
- Run `createTimeTrigger()` once from the editor (creates a 15-minute trigger), or
- Triggers (clock icon in the left sidebar) > Add Trigger > function `processInvoices`, event source "Time-driven", type "Minutes timer", every 15 minutes.

## 6. Optional: a "Needs Review" view

Rather than a script-maintained second tab, add a new sheet tab with this formula, which stays live automatically:

```
=QUERY('Invoice Log'!A:N, "select * where K = 'Needs Review'", 1)
```

(Adjust the column letter for "Status" if you change `CONFIG.LOG_COLUMNS`.)

## 7. Optional: employee dashboard (no Sheet or Apps Script access needed)

`DashboardServer.gs` + `Dashboard.html` serve a read-only web page — status counts, a "Needs Review" list, recent activity, totals by project and subproject — built entirely from live Sheet data, with no ability for a viewer to edit anything. Good for sharing with employees who shouldn't have Sheet or Apps Script editor access. The Project filter is nested (a project, or drilled down to one specific subproject), and any row Gemini flagged with a note (see step 6 above) shows it as a tooltip on the status badge.

The header also has **Start / Pause** buttons for the automation. Pause sets a flag that makes `processInvoices()` return immediately on its next scheduled run (the 15-minute trigger itself is untouched, so nothing needs to be recreated to resume) — Start clears it and creates the trigger if one doesn't exist yet. By default anyone who can open the dashboard can use these buttons, since access to the dashboard itself is already controlled by the "Who has access" setting below. To restrict Start/Pause further (e.g. only you and a controller), set `CONFIG.RESTRICT_DASHBOARD_CONTROLS = true` in `Config.gs` and list allowed emails in `DASHBOARD_CONTROL_EMAILS`.

1. In the Apps Script editor: **Deploy** (top right) > **New deployment**.
2. Click the gear icon next to "Select type" > **Web app**.
3. Description: anything (e.g. "Invoice dashboard v1"). **Execute as:** `Me`. **Who has access:** `Anyone within [your Google Workspace domain]` — this keeps it viewable only by signed-in company accounts. Avoid "Anyone with the link" since invoice amounts/vendors would then be reachable by anyone who has the URL, not just your org.
4. Click **Deploy**, authorize if prompted, then copy the **Web app URL** it gives you — that's what you share with employees (bookmark-able, no login prompts beyond their normal Google sign-in).
5. **After any future change** to `DashboardServer.gs` or `Dashboard.html`: this now happens **automatically** on merge to `main` if you've set the `WEBAPP_DEPLOYMENT_ID` secret (see section 8) — the Action bumps this same deployment to a new version, keeping the exact URL. If you haven't set that secret, bump it manually instead: Deploy > **Manage deployments** > pencil/edit icon on the existing deployment > confirm **Web app** / **Execute as: Me** / the access setting are still correct > Version: **New version** > Deploy. Either way the shared URL stays the same; a brand-new deployment would give employees a different URL to re-bookmark, so never do that unless you're retiring the old one.
6. **Changing the logo**: click **Change logo** in the dashboard header (visible next to the logo when `CONFIG.RESTRICT_DASHBOARD_CONTROLS` allows you to control the page — see the Start/Pause note above), pick an image file, done. It's resized in the browser and stored inside the Apps Script project itself (Script Properties) — no Drive file, no external fetch, no code edit, and no redeploy needed; it applies immediately. Click **Reset to default** to go back to the built-in WCM logo at any time. (Drive was tried first for this and proved unreliable across several attempts — paste truncation, flaky thumbnails, cross-account permissions — which is why logo storage doesn't touch Drive at all now. The built-in fallback logo lives in `LogoAsset.gs` as a base64 string, only relevant if you want to change what "Reset to default" resets *to*.)

## 8. Keeping Apps Script in sync with this repo (no more copy-pasting)

Google's official CLI, [`clasp`](https://github.com/google/clasp), pushes this folder straight into the Apps Script project — the same as pasting every file by hand, in one command.

**One-time setup (on any machine with Node.js):**

1. `npm install -g @google/clasp`
2. `clasp login` (opens a browser to authorize your Google account)
3. In the Apps Script editor: **Project Settings** (gear icon) > copy the **Script ID**, and paste it into `apps-script/.clasp.json` in this repo (replacing `PASTE_YOUR_SCRIPT_ID_HERE`).

**Then, whenever the repo changes:**

```
cd apps-script
clasp push
```

That overwrites every file in the Apps Script project with this folder's contents (`.gs`, `.html`, and `appsscript.json`). No editor visits needed.

**Fully automatic (GitHub Action):** `.github/workflows/deploy-apps-script.yml` runs `clasp push` on every push to `main` that touches `apps-script/`. To enable it, after doing `clasp login` locally, copy the contents of the `~/.clasprc.json` file it created, and add it as a repository secret named `CLASPRC_JSON` (GitHub repo > Settings > Secrets and variables > Actions > New repository secret).

**Auto-redeploying the dashboard web app (optional but recommended):** a plain `clasp push` updates the saved code but *not* the deployed version the shared `/exec` URL serves — so without more, dashboard changes need a manual "New version" (step 5). To automate that too, set one more repository secret, `WEBAPP_DEPLOYMENT_ID`, to the live web app's deployment ID — find it under **Deploy > Manage deployments** (the long `AKfyc…` id beneath your Web app), or run `clasp deployments` and copy the web-app one. With that set, the Action runs `clasp deploy -i <that id>` after the push, which redeploys **the same deployment** (same ID, same `/exec` URL) to a new version named `Invoice_Dashboard_v<run#>` — the CLI equivalent of the manual "New version". It never creates a new deployment, so the shared link can't change; if the secret is unset the step is skipped and you republish by hand.

This only works safely because the web app's entry point is declared in `appsscript.json` (`"webapp": { "executeAs": "USER_DEPLOYING", "access": "DOMAIN" }` = Execute as Me / Anyone within your domain). An earlier attempt at `clasp deploy` automation *without* that manifest config was a trap: `deployments.update` had nothing to preserve and silently downgraded the deployment to library-only, breaking the live URL. Keep that `webapp` block in the manifest in sync with the deployment's real "Execute as" / "Who has access" settings — if you change them in the UI, change them here too, or the next auto-redeploy will revert them. Tip while iterating locally: the **Test deployment** URL (`/dev` instead of `/exec`, under Deploy > Test deployments) always serves the latest saved code with no version bumping.

## Notes

- Nothing here needs Claude or any external server running — once deployed, it's entirely self-contained inside Google Workspace, per the plan.
- If you add a new project or subproject to the Drive structure later, just add a row to the `Project Reference` tab — no code changes or redeploy needed.
