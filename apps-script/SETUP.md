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
5. **After any future change** to `DashboardServer.gs` or `Dashboard.html`: Deploy > **Manage deployments** > pencil/edit icon on the existing deployment > Version: **New version** > Deploy. The shared URL stays the same; this just pushes the update live. (A brand-new deployment would give employees a different URL to re-bookmark — avoid that unless you actually want to retire the old one.)
6. The dashboard logo is embedded directly in `LogoAsset.gs` as a base64 string — not read from Drive, which proved unreliable across several attempts (paste truncation, flaky thumbnails, cross-account permissions). To replace it: downsize the image first (a few hundred pixels tall is plenty for a 56px-tall header image), base64-encode it, and swap the string in `LogoAsset.gs`.

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

**One thing `clasp push` does not do:** the dashboard web app serves the code from its *deployed version*, not the latest saved code. After a push that changes `DashboardServer.gs`/`Dashboard.html`, bump the version once: **Deploy > Manage deployments > edit (pencil) > Version: New version > Deploy** (the URL stays the same). This can also be automated — see the commented-out step at the bottom of the workflow file. Tip while iterating: the **Test deployment** URL (`/dev` instead of `/exec`, under Deploy > Test deployments) always serves the latest saved code with no version bumping, so you can preview changes there before publishing.

## Notes

- Nothing here needs Claude or any external server running — once deployed, it's entirely self-contained inside Google Workspace, per the plan.
- If you add a new project or subproject to the Drive structure later, just add a row to the `Project Reference` tab — no code changes or redeploy needed.
