# Deploying the invoice automation

## 1. Create the Apps Script project

1. Go to [script.google.com](https://script.google.com), signed in as **wcmmail@westdellcorp.com** (or whichever account has access to the `+-billing` label — see the open question in the plan doc about direct vs. delegated access).
2. Create a new project, or better: create a new Google Sheet first (this becomes the log spreadsheet), then Extensions > Apps Script from inside it, so the script is bound to that Sheet.
3. Delete the default `Code.gs` boilerplate. Create each file in this folder (`Config.gs`, `Main.gs`, `GmailService.gs`, `GeminiService.gs`, `DriveService.gs`, `SheetService.gs`, `Setup.gs`, `Test.gs`) as a matching `.gs` file in the Apps Script editor, and paste in the contents. For `appsscript.json`, use the editor's "Show manifest file" option (Project Settings > check "Show appsscript.json") and replace its contents.

## 2. Set the Gemini API key

1. Generate a key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey), signed in as the same account.
2. In the Apps Script editor: Project Settings (gear icon) > Script Properties > Add script property.
3. Name: `GEMINI_API_KEY`. Value: the key you generated.

## 3. Set up the reference data

1. Import [`project_reference.csv`](../project_reference.csv) into a new tab.
2. Run the `setup()` function once (select it in the function dropdown, click Run) — this creates the `Project Reference`, `Invoice Log`, and `Errors` tabs if they don't already exist, with the right headers.
3. Rename/merge your imported CSV data into the `Project Reference` tab so its columns match: `Project Number | Project Name | Subproject Number | Subproject Name | Drive Folder ID`.
4. Fill in the **Drive Folder ID** column for every row. This is the string in a Drive folder's URL: `https://drive.google.com/drive/folders/`**`THIS_PART`**. For projects with no numbered subprojects, use the project-level folder ID for every row with that project number.

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

## Notes

- Nothing here needs Claude or any external server running — once deployed, it's entirely self-contained inside Google Workspace, per the plan.
- If you add a new project or subproject to the Drive structure later, just add a row to the `Project Reference` tab — no code changes or redeploy needed.
