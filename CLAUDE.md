# CLAUDE.md — working on this repo

Google Apps Script invoice automation (Gmail → Gemini extraction → Drive filing → Sheets log +
HTML dashboard). **This repo is the source of truth**; the live Apps Script project is a mirror.

## Deploy model — read this before debugging "it's not working"

- Merging to `main` auto-runs `.github/workflows/deploy-apps-script.yml` → `clasp push -f` to the
  script ID in `apps-script/.clasp.json`. **Backend changes** (Gmail/Drive/Sheets processing, editor
  functions) are live on the next trigger run — no manual step.
- **The dashboard is different.** The web app (`Dashboard.html` + everything called via
  `google.script.run`) executes a **pinned deployment version**, NOT HEAD. The user must republish:
  Deploy → Manage deployments → ✏️ → New version → Deploy. If a dashboard change or a
  `updateInvoiceRow`-style server call behaves like old code, the republish is pending — that's the
  answer, not a code bug.
- The Apps Script **editor caches files** per browser tab. After a deploy, the tab must be reloaded
  before new files/functions appear. Run always executes the latest *saved* server code regardless.
- The workflow only triggers on `apps-script/**` paths. Doc-only PRs deploy nothing.

## Git workflow (established convention here)

- One change = one PR, **squash-merged** immediately after a clean-diff check. PR bodies use
  Summary / Test plan sections.
- Work on branch `claude/dashboard-logo-wyaf1d`, restarted from `origin/main` for each change
  (`git checkout -B <branch> origin/main`). After a squash-merge the remote branch tip diverges;
  force-push is blocked — instead run
  `git merge -s recursive -X ours origin/<branch> --no-edit` (keeps your tree, adds ancestry), then
  a normal fast-forward push. Verify `git diff <your-commit> HEAD` is empty before pushing.

## Code rules (each one exists because of a real incident)

- `.gs` files share ONE global scope (V8, no imports). Trailing-underscore functions are private by
  convention and not callable from `google.script.run`.
- **Sheet writes go through header-name lookup** (`buildRowByHeader_` / `idx = header.indexOf(...)`),
  never positional arrays — a mid-list column insert once silently shifted 280 rows.
- **Sheets coerces `"06"` to the number 6.** Never strict-compare project/subproject numbers; always
  compare through `normalizeNumberKey_` (leading zeros stripped). `findReferenceMatch_` already does
  this — route matching through it.
- **One resolver decides every Drive destination**: `resolveInvoiceDestinationFolderId_`
  (DriveService.gs), shared by automatic filing (Main.gs), dashboard edits (DashboardServer.gs), and
  the refile reconciler (Refile.gs). Never compute a destination anywhere else.
- Filing structure: base = subproject folder, or `No Subprojects` under the project (project folder
  derived from a sibling subproject's *parent* when Project Reference has no project-level row —
  never the sibling folder itself). Under the base: `YYYY-MM` by **processed** month (matches the
  `YYMMDD - Inv# - Vendor.pdf` filename); invoices (Filed/Captured/Paid) at the month root,
  `Needs Review/` and `Statements & Others/` (non-invoices only) inside the month. No match at all →
  top-level `_Unmatched`.
- **`Duplicate` rows point at ANOTHER row's file.** Never move, rename, or trash a Duplicate row's
  file — it belongs to the canon invoice.
- Adding a status touches all of: `ALLOWED_STATUSES` + `statusToClass_` (DashboardServer.gs), badge
  CSS + three status dropdowns + filter checkboxes (Dashboard.html), the resolver's bucket logic
  (DriveService.gs), and the refile bucket (Refile.gs).
- Long jobs (refile, archive, reconcile) follow one pattern: `LockService.getScriptLock()`, a
  time budget under the ~6-min kill, idempotent re-runs that skip already-done work, and a final
  `Logger.log` that says "Done." or "re-run to continue".
- Gemini free tier: 5 req/min (`GEMINI_PACING_MS` paces this) and 500/day. `PROCESS_FROM_DATE` is
  enforced **per message** (GmailService.gs), not just in the Gmail search — a reply to an old
  thread must never resurrect an old invoice.

## Testing & checking (no Apps Script runtime here)

- Syntax check: copy `X.gs` → scratch `X.js`, `node --check`. For `Dashboard.html`, extract the
  `<script>` block, strip `<?!= ... ?>` scriptlets (replace with `null`), then `node --check`.
- Unit tests use the harness at `/root/tools/gas-test-kit` (`extractFunction` pulls one function
  from a `.gs` file by brace counting; `eval()` it into the test's scope). **Never put
  `'use strict'` in a test file** — strict-mode eval doesn't leak declarations. If the toolkit is
  missing (ephemeral container), recreate it or inline the same extract-and-eval pattern.
- Mock `SpreadsheetApp`/`DriveApp`/`Utilities`/`CONFIG` per test; make fake folder IDs be their
  own "parent/name" paths so assertions read like expected paths.
- `Dashboard.html` contains em-dashes/arrows that defeat exact-match string edits — for edits there,
  prefer short unique anchors or a Node replace script, and re-verify with grep afterwards.

## Docs to keep in sync when behavior changes

- `README.md` — construction-audience main page (plain outcomes, no back-end mechanics; folder tree
  + step-by-step section must match reality).
- `EMPLOYEE_GUIDE.md` — end-user how-to (statuses, folder tree, dashboard actions).
- `apps-script/SETUP.md` — deploy/config internals.
- `property_addresses.md` + `AliasSeed.gs` — canonical addresses; aliases live in code and load on
  deploy (no manual sheet import). `project_aliases_seed.csv` is the human-readable mirror.

## Known future roadmap (user-stated)

- Nexus integration: auto-mark invoices **Paid** (access path TBD: report email vs CSV vs API).
- Month-close archive: a month "closes" when its invoices are Captured/Paid and reviews resolved.
