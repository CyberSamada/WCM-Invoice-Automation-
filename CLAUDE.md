# CLAUDE.md — working on this repo

Google Apps Script invoice automation (Gmail → Gemini extraction → Drive filing → Sheets log +
HTML dashboard). **This repo is the source of truth**; the live Apps Script project is a mirror.

## Standing rule: keep the knowledge files current

When a change alters behavior, conventions, or structure — or debugging uncovers a new gotcha —
**update this file in the same PR as the change.** Don't leave lessons in chat. The same applies to
the extractor's knowledge: when a misread teaches a durable lesson about how WCM's invoices look,
add it to `apps-script/ExtractionNotes.gs` (SEED_EXTRACTION_NOTES) in the same PR as the fix.
Addresses go in `AliasSeed.gs` + `property_addresses.md`.

**Knowledge lives in the sheet tabs now — the code seeds are just shipped defaults.** Aliases
(address/alt-name → project) and extraction notes have ONE runtime home each: the **Project
Aliases** and **AI Notes** sheet tabs. `SEED_ALIASES` (AliasSeed.gs) and `SEED_EXTRACTION_NOTES`
(ExtractionNotes.gs) are copied into those tabs exactly once by
`SheetService.gs/ensureKnowledgeSeeded_` (guarded by the `KNOWLEDGE_SEEDED` Script Property), then
never read directly again — `getAliasData_`/`getExtractionNotes_` read only the tabs. So a
hand-deleted row stays deleted (the seed won't re-add it), and coordinators tune aliases themselves
from the dashboard's **Manage hints** panel (`getProjectAliases`/`addProjectAlias`/`removeProjectAlias`/
`updateProjectAlias` in DashboardServer.gs write to the tab AS THE OWNER — no spreadsheet access
needed) or by typing the identifying address in the **learn-while-fixing** field on the edit/preview
panels (`updates.learnAlias` → `saveProjectAliasInternal_`). Editing a seed array only changes what a
BRAND-NEW install starts with; to restore a default someone deleted, run `reseedKnowledge()` (Setup.gs).

**Base (canon) aliases** — the "Project Aliases" tab has a **Base** column. Rows from `SEED_ALIASES`
are marked `Base=TRUE` (once, by `ensureBaseAliases_`, guarded by `BASE_ALIASES_ENSURED` — a separate
pass from `ensureKnowledgeSeeded_` because the tab was seeded before the column existed). Base rows
show in Manage hints but can't be **removed** (`removeProjectAlias` refuses them) or **blanked**
(`updateProjectAlias` rejects an empty alias) — only edited. Base-ness lives on the row's Base cell,
so an edited base hint keeps it; membership is NOT re-derived from seed text after the one-time pass
(that would duplicate an edited row). Manage hints supports **subproject** on add and inline **edit**.

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
- **`-X ours` is not "keep my tree verbatim" — it only wins on CONFLICTING hunks.** A change the
  stale remote branch still has but you deleted (a block you removed elsewhere in the file) is a
  *non-conflicting* addition from the merge base's view, so git silently re-adds it. That's exactly
  how a dead `notesSheet` block came back into Setup.gs this session. So the "`git diff <your-commit>
  HEAD` is empty" check is load-bearing, not a formality: if it's non-empty, the merge re-introduced
  stale content — strip it in a follow-up commit until the diff is empty, THEN push.

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
- **Only `var`/`function` declarations leak out of `eval()`; `const`/`let` do not** (they're
  block-scoped to the eval). So a function-under-test that references a file-level `const` (e.g.
  `KNOWLEDGE_SEEDED_PROPERTY`, `CONFIG`) will throw "X is not defined" if you `eval` the const from
  the source — define those in the test scope as `var` (or a plain assignment) instead. A silent
  try/catch in the function-under-test will swallow that ReferenceError and make every assertion fail
  at once; if a whole test file "does nothing," temporarily replace the catch body with a log to see
  the real error.
- Mock `SpreadsheetApp`/`DriveApp`/`Utilities`/`CONFIG` per test; make fake folder IDs be their
  own "parent/name" paths so assertions read like expected paths.
- `Dashboard.html` contains em-dashes/arrows that defeat exact-match string edits — for edits there,
  prefer short unique anchors or a Node replace script, and re-verify with grep afterwards.

## Docs to keep in sync when behavior changes

- `README.md` — construction-audience main page (plain outcomes, no back-end mechanics; folder tree
  + step-by-step section must match reality).
- `EMPLOYEE_GUIDE.md` — end-user how-to (statuses, folder tree, dashboard actions).
- `apps-script/SETUP.md` — deploy/config internals.
- `property_addresses.md` + `AliasSeed.gs` — canonical addresses. `AliasSeed.gs`/`SEED_EXTRACTION_NOTES`
  are shipped DEFAULTS seeded into the **Project Aliases**/**AI Notes** tabs once (see the knowledge
  rule up top); the live home is the tabs, edited via the dashboard's **Manage hints** panel.
  `property_addresses.md` + `project_aliases_seed.csv` are human-readable mirrors of the defaults.
- `apps-script/ExtractionNotes.gs` — standing domain notes injected into every Gemini extraction
  prompt (merged with the optional "AI Notes" sheet tab, which lets the team add hints without a
  deploy). This is the extractor's CLAUDE.md.

## Known future roadmap (user-stated)

- Nexus integration: auto-mark invoices **Paid** (access path TBD: report email vs CSV vs API).
- Month-close archive: a month "closes" when its invoices are Captured/Paid and reviews resolved.
