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
(that would duplicate an edited row).

**Alias identity is scoped by subproject** — a project and each of its subprojects have INDEPENDENT
hint sets (the same alias text may exist at project level AND under a subproject). Every alias helper
matches on project **+ subproject** via `aliasScopeMatches_` (leading-zero safe): `getAliasData_`
dedup key, `appendAliasRow_`, `updateAliasRow_` (edits alias TEXT only, scope fixed), `deleteAliasRow_`,
`aliasRowIsBase_`. Server endpoints carry the scope: `addProjectAlias(alias, project, sub)`,
`removeProjectAlias(alias, project, sub)`, `updateProjectAlias(oldAlias, project, sub, newAlias)`.
Manage hints picks the scope from a **project/subproject tree on the left** (each node shows its hint
count); the list, add, edit, and remove act on the selected scope. **Hints read as a HIERARCHY in the
UI**: selecting a subproject also lists the parent project's hints tagged "From project" (read-only
there — edited at the project). That is presentation of behavior the extractor ALREADY had, not a new
matching rule: the Gemini prompt tells it a project-level alias means "apply the project and choose the
subproject separately", while a subproject alias must be used exactly and never downgraded to NONE. So
storage stays scoped per-row (`aliasScopeMatches_` is unchanged); only the display inherits.
The learn-while-fixing field saves the alias at the corrected invoice's project+subproject scope. In
the Gemini prompt (GeminiService.gs), each alias renders as `"text" => Project P, Subproject S` (or
`(project level — no specific subproject)`) and is described as AUTHORITATIVE.

## What must never go in this repo

**This repo is readable by anyone who can see it** (as of this writing, publicly). So:

- **No staff names or email addresses.** The project → site-coordinator mapping used to live in
  `site_coordinators_PRIVATE.md`; it was removed and `.gitignore` now blocks `site_coordinators*.md`
  so a local copy can't be committed again. The real list lives in Drive. When "notify the coordinator"
  finally gets built, the addresses belong in a **sheet tab or Script Property**, the same place
  aliases and the API key already live — never in the code.
- **No credentials, ever.** The Gemini key is a Script Property; `clasp`'s OAuth token
  (`.clasprc.json`) and the web-app deployment ID are GitHub Actions secrets (`CLASPRC_JSON`,
  `WEBAPP_DEPLOYMENT_ID`). `.gitignore` covers the usual credential filenames.
- **Google IDs that ARE still committed**, knowingly: the Apps Script `scriptId`
  (`apps-script/.clasp.json`, needed by the deploy workflow), `INVOICE_ARCHIVE_PARENT_FOLDER_ID`
  (DriveSetup.gs) and `CONFIG.TEST_FOLDER_ID`. None is a credential — Drive and Apps Script still
  enforce permissions — but a Drive folder ID **is** the link if that folder is ever shared "anyone
  with the link", so those two folders must stay restricted. Moving them into Script Properties is
  possible but is a coordinated config change: unset properties would stop filing on the next
  trigger, so don't do it casually.
- **Removing a file does not remove it from history.** Anything already pushed stays readable in
  earlier commits, forks and caches. The only real fix for a past leak is to make the repo private
  and/or rotate the exposed thing.

## Deploy model — read this before debugging "it's not working"

- Merging to `main` auto-runs `.github/workflows/deploy-apps-script.yml` → `clasp push -f` to the
  script ID in `apps-script/.clasp.json`. **Backend changes** (Gmail/Drive/Sheets processing, editor
  functions) are live on the next trigger run — no manual step.
- **The dashboard is different.** The web app (`Dashboard.html` + everything called via
  `google.script.run`) executes a **pinned deployment version**, NOT HEAD. The workflow now
  auto-redeploys it: after `clasp push -f` it runs `clasp deploy -i <WEBAPP_DEPLOYMENT_ID>` (a repo
  secret) to bump THAT SAME deployment to a new version, keeping the exact deployment ID and `/exec`
  URL. This only works because `appsscript.json` now carries the web-app entry point
  (`"webapp": { executeAs: USER_DEPLOYING, access: DOMAIN }`) — without it, `clasp deploy` strips the
  deployment to library-only and kills the `/exec` URL (the reason this was manual before). If the
  `WEBAPP_DEPLOYMENT_ID` secret is unset the redeploy step is SKIPPED (code still pushes) and you
  republish by hand: Deploy → Manage deployments → ✏️ → New version → Deploy. So if a dashboard
  change behaves like old code, check the Action's redeploy step (and that the secret is set) before
  suspecting a code bug.
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
- **Sheets also coerces ID-like strings into DATES on write** — invoice `"3050-4"` is read as
  `YYYY-M` → April 3050 → the cell reads back `Mon Apr 01 3050…`. Any column holding IDs/codes must be
  forced to plain-text format (`setNumberFormat('@')`). `CONFIG.LOG_TEXT_COLUMNS` (Invoice Number,
  Project/Subproject Number, Row ID, Drive File ID) is set to `@` whole-column by
  `SheetService.gs/ensureLogTextFormats_` (self-heals once via `ensureLogTextFormatsOnce_` from
  `logInvoiceRow_` + `buildDashboardData_`; manual `ensureLogColumnFormats()` in Setup.gs), and
  `updateInvoiceRow` writes those cells via a text-forcing `setTextCell`. NEVER put a real date column
  (Invoice/Due/Processed/Received) or Amount in that list. An already-coerced cell keeps its bad value
  (original text lost) — re-enter from the dashboard; the format only prevents recurrence.
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
  file — it belongs to the canon invoice. The guard in `updateInvoiceRow` checks the status the row
  **IS** as well as the one it's becoming (`touchesSharedFile`): checking only `newStatus` left a
  hole where flipping a Duplicate row to Filed/Paid moved the CANON's file out of its folder —
  easy to trigger from a bulk edit over a filtered set that happens to contain duplicates.
- **Selection is scoped to the current filter.** `applyFilters` calls `pruneSelectionToFiltered`,
  so a row that leaves the filtered set (filter changed, or an edit moved it out) is deselected.
  Without it the bulk bar counted invisible rows and Edit selected / Download acted on them.
  Pruning is against the whole FILTERED set, not the page, so selecting across pages still works;
  the bulk bar says "(N on other pages)" when the selection reaches beyond the current page.
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
- **A stray NUL/control byte can get injected into a regex char class while editing** (happened this
  session inside `[\/\\:*?"<>|]` in `sanitizeZipName_`). Tell-tale: `grep` reports `binary file
  matches` and `node --check` may still PASS while the class is silently wrong (e.g. a control-char
  range that eats hyphens). Fix by writing a Node fixer **to a file** — an inline `node -e '…'` that
  contains control chars is rejected by the Bash tool ("command contains control characters") — that
  strips bytes `<32` except tab/newline/CR and rewrites the offending line, then re-`node --check`
  and confirm `readFileSync(f).indexOf(0) === -1`.

## Batch download (dashboard)

`downloadInvoicesZip(rowIds, zipName)` (DashboardServer.gs) returns the selected rows' filed PDFs as
**base64** for the browser to save (client `base64ToBlob`+`triggerDownload` → an `<a download>`), so a
viewer with no Drive access can still export (it runs as the owner, like Preview — read-only, not
gated). De-dupes by Drive file ID (a `Duplicate` row shares the canon's file — never downloaded
twice); skips unreadable files and counts them; capped by `DOWNLOAD_MAX_FILES` (100) /
`DOWNLOAD_MAX_TOTAL_BYTES` (30 MB). The zip modal has a **Mark as Captured** tick-box (off by default, reset on open) — downloading a
batch is normally the act of capturing it. It fires only AFTER `triggerDownload` succeeds, and calls
`markInvoicesCaptured(rowIds)` (DashboardServer.gs) which decides eligibility SERVER-SIDE: only `Filed`
and `Needs Review` move to `Captured`, so a `Duplicate` (canon's file), `Not an Invoice`, or an already
Captured/Paid/Canceled row can't be touched and a lifecycle status is never walked backwards.
**After de-dup, one file returns AS-IS** (`single:true`, its own
name + mimeType, no zip); **two+ zip** under `sanitizeZipName_(zipName)` (strips only illegal chars —
keeps hyphens — caps length, ensures one `.zip`). UI: a **Download** button in the multi-select bulk
bar — one selected downloads directly, multiple open the name-the-zip modal.

## Nexus status sync (dashboard) — `NexusSync.gs`

Coordinators upload the latest **Nexus export CSV** and the dashboard MIRRORS payment/lifecycle status
onto the log — the "don't hand-maintain AP status" decision made concrete. All of it lives in
**`NexusSync.gs`** (endpoints gated by `canControlAutomation_`, called from Dashboard.html).

**Status map** (`mapNexusStatus_`): `PAID`→Paid; `POSTED`/`PENDING APPROVAL`/`IN PROGRESS`/`HOLD`→
Captured; `REJECTED`/`VOID`→Canceled; anything else → `null` = ignored, never guessed. One invoice
number can appear on several Nexus rows with conflicting statuses (~20 in the real export) —
`nexusTargetRank_` resolves by FINALITY: Paid(3) > Canceled(2) > Captured(1).

**WHY IT'S A SCORED MATCHER, NOT A LOOKUP.** Nexus stores the *processed* invoice number, so it's often
a decorated form of the printed one: property prefix (`243-269744`), company prefix (`WCM16788`),
suffix (`0554694-IN`). Amounts differ by a **~10% holdback (Nexus is the LOWER side)**, and vendor
names don't agree. **Measured on the real 21k export, every naive fuzzy key is dangerous**: keying on
the longest digit run makes `23` (from `Mar23`) match **758 different invoices**; 5,459 numbers have a
digit run of only 2 chars; even an exact punctuation-stripped number is non-unique for 545 keys; and
vendor+amount is non-unique 11% of the time. A wrong match marks the WRONG invoice Paid, so:

- **Signals**, weighted in `NEXUS_SCORE_` so no single one can auto-apply alone: number (exact /
  containment ≥6 or ≥5 chars / shared digit run ≥6 or 5 — **runs under 5 digits score ZERO**, that's the
  `23` trap), amount (exact / 0.9 holdback ratio / loose / **`amtMismatch` is NEGATIVE** — a
  contradicting amount is evidence against), vendor (learned crosswalk > name match > overlap >
  mismatch penalty), date proximity (weak corroboration only).
- **`NEXUS_AUTO_MIN` = 76 means "two strong corroborating signals"** (e.g. containment-6 + exact
  amount, or containment-5 + holdback + vendor). Auto ALSO requires the runner-up be
  `NEXUS_AUTO_MARGIN`(15) behind, so a near-tie is never machine-resolved. An exact **mutually-unique**
  number auto-applies on its own, but only if it still clears `NEXUS_QUEUE_MIN` — so exact-number-plus-
  contradicting-amount drops to the queue instead.
- **Everything else ≥ `NEXUS_QUEUE_MIN`(42) goes to a human confirmation queue**, shown with its
  evidence ("Nexus # contains our # (60392); amount is ours less 10% holdback; vendor matches"). An
  exact-number hit sets `forceQueue` so it's ALWAYS shown even if a mismatch drags it under the floor —
  silently dropping a real decision is worse than either applying or queueing it.
- **Assignment is greedy by score and one-to-one** — strongest matches claim their row first, so two
  Nexus invoices can't both claim one log row.
- **SELF-IMPROVING (the actual answer to the mismatch problem).** Every auto-apply and every human
  confirmation writes crosswalk rows: `Nexus Invoice Map` (Nexus number → our Row ID) and
  `Nexus Vendor Map` (**Nexus Vendor ID** → our vendor). Next upload those are exact hits, so each
  oddity is a one-time cost. Vendor ID is the sleeper win — a stable code that already collapses
  spelling variants (`London Hydro` and `London Hydro Inc.` are both `LONHYD`), which is why mapping it
  beats comparing names. `rejectNexusMatch` stores Row ID `NONE` so a rejected suggestion stops
  reappearing. Both tabs' ID columns are forced to `@` text (`ensureNexusMapTextFormats_`) — same
  date-coercion trap as the log.
- **Eligibility**: `NEXUS_ELIGIBLE_STATUSES_` = Filed/Captured/Paid/Canceled/Needs Review. `Duplicate`
  (its file belongs to the canon) and `Not an Invoice` are NEVER touched — enforced at index time, so
  they're not even candidates.
- **Report + audit trail.** Preview returns `planned` — EVERY automatic change (not a sample) — which
  the dashboard renders as a scrollable table (invoice #, vendor, amount, from → to, Nexus #, why) with
  a **Download report (CSV)** button (client-side, BOM'd for Excel). Every applied change and every
  rejection is also appended to the **`Nexus Sync Log`** tab via `logNexusSyncRows_`: timestamp, decided
  by (Automatic / Confirmed by <email> / Rejected by <email>), both sides' number/vendor/amount, from →
  to status, score, and the evidence string. `updateInvoiceRow` already writes a generic Override Log
  row, but only this says WHICH Nexus invoice drove it and why — that's the "why is this Paid?" answer
  months later. Written as ONE `setValues` (an apply run can be hundreds of rows; per-row `appendRow`
  would eat the time budget), header-keyed, and best-effort so a failed log write never makes a
  succeeded apply look failed.
- **Preview-then-apply**; apply is **resumable** (`startIndex` → `{done, nextIndex}`, 2.5-min budget,
  `LockService` lock so it can't race `processInvoices`). Every change routes through
  **`updateInvoiceRow`**, so the file move, Review Note stamp and Override Log entry match a manual
  edit — no second write path. Idempotent: re-uploading the same file is a no-op.
- **Candidate generation is indexed, never all-pairs** (`buildNexusLogIndex_`): by normalized number,
  by each digit run ≥5, and by vendor+amount *and* vendor+amount×0.9 (so a holdback figure is still a
  hash lookup). A key hitting more than `NEXUS_MAX_CANDIDATES_PER_KEY`(8) rows is treated as
  non-discriminating and skipped. Measured: 20,509 Nexus entries × 1,200 log rows in **~200ms**.
- Nexus dates are **DAY-FIRST** (`16/03/2023`) — `nexusParseDate_` handles it; plain `new Date()` would
  silently misread them.

## Theming / dark mode (dashboard)

Colors are driven by CSS tokens in `:root` (`--surface`, `--surface-alt`, `--surface-hover`, `--text`,
`--text-muted`, `--input-border`, plus existing `--bg`/`--border`) with LIGHT values matching the
original look; `:root[data-theme="dark"]` redefines those tokens (+ a few accent tweaks for card
values / stat strip / hint buttons). The rules were tokenized by a scoped transform (only inside
`<style>`) that swapped the recurring hardcoded surface/text/border hexes for `var(--…)` — so adding a
color to a rule should use a token, not a raw hex, or it won't theme. `data-theme` is set on
`document.documentElement` by a tiny inline script in `<head>` BEFORE paint (no flash), and again by
`initSettings()`. Preference (`light`/`dark`/`system`) is per-viewer in `localStorage['wcm_theme']`
(NOT a Script Property — that'd be shared); `system` follows `prefers-color-scheme` live. The **⚙
Settings** menu in the header holds the theme radios **and the logo controls**. Note: the brand logo
can be low-contrast on the dark header depending on the uploaded image — no auto-fix.

**Logo controls live in the Settings menu, not under the logo** — the header shows the brand mark on
its own. `#logoControls` (with `changeLogoBtn` / `resetLogoBtn` / `logoStatus` / the hidden file input)
was MOVED into `#settingsPanel`; the IDs and handlers are unchanged, so `renderBranding()` still
shows/hides the whole block for viewers who can control it. This works because the settings menu only
closes on a click OUTSIDE `.settings-menu` — a click on "Change logo" keeps the panel open while the
file dialog runs. `.logo-controls` no longer sets `display` in CSS (only `flex-direction: column`);
the inline `display:none` + `renderBranding` supply it.

## Dashboard look, table density, and loading (Dashboard.html)

The page is titled **"Invoice Desk"** (`.page-title-main`) with a static subtitle; the old
`Live data — generated <timestamp>` line under it is gone, so the **footer note is the only
freshness stamp left** — don't delete it without relocating that information.

**The invoice table is `table-layout: fixed`** (`#invoiceTable`), and that is load-bearing, not
decoration. Under auto layout the browser re-negotiated all 13 columns against the longest string
on the page, so `Jul 31, 2026 1:39 PM` wrapped to three lines, a project name to three or four, and
no two rows were the same height — the actual reason the table was hard to read. Column widths live
in the polish block keyed off the **`<th>` classes** (`date-col`, `vendor-col`, `invnum-col`,
`proj-col`, `sub-col`, `amount-col`, `status-col`, `note-col`, `links-col`, `edit-col`); a fixed
table takes its grid from the FIRST row, so widths must go on the `th`, never the `td`. Measured
uniform 52px rows with no horizontal overflow from 900px to 1920px. Cell renderers `dateCell` /
`projectCell` / `amountCell` (near `projectKey`) cap each cell at two lines: date over muted time,
project NUMBER as a chip over a one-line clipped name, right-aligned money with a muted currency
code. **Nothing is hidden** — every clipped cell carries the full text in a `title`. `projectKey` /
`subprojectKey` / `formatMoney` are deliberately untouched (grouping, the filter tree and the modals
still use them), and a header label must never be clipped, hence
`#invoiceTable thead th { white-space: normal }`.

The header is **sticky**, which is why `table { overflow: hidden }` had to go (it makes
`position: sticky` a no-op); the rounded corners are now on the corner CELLS instead. If you re-add
`overflow` to a table, the sticky header silently stops working.

**Loading.** The pdf.js CDN tag is `async` **on purpose**: as a plain `<script src>` it blocked HTML
parsing, DOMContentLoaded and the first table render until cdnjs answered — measured 13.2s to a
usable table with cdnjs unreachable, vs 0.6s once async. Nothing on first paint needs it (the
preview already falls back to the Drive viewer when `pdfjsLib` is undefined). The first
`applyFilters()` is deferred by **two** `requestAnimationFrame`s so the header, cards, filters and
the table's spinner paint before the ~100ms/550-row row build; `#topProgress` (in the markup, not
added by JS, so it animates from the first paint) and the `.loading-cell` spinner are cleared by
`bootFinished()`.

**Searchable selects say what is selected.** An unfocused `<select size=N>` greys its highlight out,
so once focus moved to the search box above it nothing looked picked. Two fixes:
`select[size] option:checked` forces the swatch via a `linear-gradient` (the only way to colour an
`<option>`), and `initSelectSearchLabels()` rewrites each search box's **placeholder** to
`Selected: <option>` (placeholder, not value — it vanishes the moment someone types). Pairs are
listed in `SELECT_SEARCH_PAIRS`; the label is refreshed on the select's `change` and by a
`MutationObserver` on the owning `.modal-overlay`'s `style`, which is how it is correct when a panel
OPENS with something pre-selected without editing every `open*Modal()`. `filterProjectSearch` and
`hintsProjectSearch` are NOT pairs — they filter trees, not a `<select>`.

**Presentation-only polish block.** An earlier block in `<style>` (elevation tokens `--shadow-1/2/pop`
+ `--ring`, card hover lift, focus-visible rings, transitions, slim scrollbars, and dark-mode patches
for fills that were hardcoded light — bulk bar, note dots, progress track, preview note). Rule for
adding to it: **nothing may change layout.** Use `transform`, `box-shadow` (including `inset` for a
hairline edge) and colors — never width/height/padding/border. A real `1px` border on `.modal-box`
added 2px to every modal's height, which is why that edge is an inset shadow. Verified with a
before/after geometry probe (Playwright, both themes): every element keeps its x, width and height.

## Text-select preview (dashboard)

The PDF preview renders through **PDF.js** (`pdf.min.js` 3.11.174 from cdnjs) with a real text layer, so
invoice values can be highlighted and copied. **There is deliberately no toggle** — it is selectable by
default, and `renderPreviewDocument()` falls back to the Drive `/preview` iframe **automatically and
silently** in every case where our renderer can't help: the CDN lib didn't load (offline/CSP), the file
is over `PDF_SELECT_MAX_BYTES` (25 MB), the fetch failed, or **page 1 has no text items at all** (a
scanned image — selection would add nothing and Drive's viewer has better zoom/page controls). The
`previewFrame.src` is always set before rendering, so that fallback is instant.

**Zoom/pan is Acrobat-style with NO mode button** (a toggle was rejected as redundant): the pane's default
cursor is `grab`, but `.textLayer > span` keeps `cursor: text`, and `pointerIsOnText_` checks whether
mousedown landed on a text span — blank space drags to pan, text drags to select. Holding SPACE sets
`.spacepan` (pointer-events off on the text layer) for a temporary hand tool; middle-button always pans.
Zoom RE-RENDERS pages (`setPreviewZoom` → `renderPdfPage` at `previewFitWidth * PREVIEW_ZOOM`) rather than
CSS-scaling, so the text layer stays aligned with the canvas. It renders into a **DETACHED node** and swaps
it in via `afterFirstPage` once page 1 is drawn (nodes MOVED, not `innerHTML`-copied — copying loses canvas
bitmaps), because clearing the live pane first left it blank for a beat on every click = the "flash". Scroll
is restored proportionally so the same part of the page stays in view. `renderPdfPage` measures the fit width
from the LIVE pane, never from its `container` argument — a detached node has `clientWidth` 0 and would
silently fall back to the 700px default and draw at the wrong size. `stepPreviewZoom` is defined as "nearest
step above/below the current value", not index ±1 — the latter skipped a step from an off-step zoom.

Bytes come from `getInvoicePdfData(fileId)` (DashboardServer.gs — base64, owner-run/read-only). Client:
`renderSelectablePdf`/`renderPdfPage` build one canvas + a `.textLayer` per page; `previewPdfToken`
cancels stale renders on fast Next/close. `pdfjsLib` is loaded via a plain `<script src>` OUTSIDE the
main `<script>` block — the node syntax-check extractor matches `  <script>` (indented, no attrs), so it
skips the CDN tag.

## Review Note sequencing (dashboard)

Review Note accumulates events: the initial reason, then each `Manually updated <stamp> — …` edit and
`Merged as duplicate …` — appended with **`\n`** now (was a space, which jammed them into one blob).
The client `noteLinesFrom(reviewNote, matchNote)` renders them as a chronological one-line-per-event
sequence in the ⓘ popover (`.note-line`) and the preview note; it splits on `\n` AND, for older
space-joined notes still in the sheet, on the `Manually updated <date>` / `Merged as duplicate`
markers — so no data migration is needed. The match note is shown last as `AI read: …`. The ⓘ button
carries `data-review`/`data-match` (not a pre-joined `data-note`) so the popover can format them.
In the **preview panel** the note is COLLAPSED by default (`renderPreviewNote` builds a native
`<details>`): the history grows unbounded and was pushing the edit fields off screen. The summary
line carries the entry count plus the newest event clipped to one line, so "what happened last?"
needs no expanding — 34px collapsed vs ~171px open on a 4-entry note.

## Docs to keep in sync when behavior changes

- `README.md` — construction-audience main page (plain outcomes, no back-end mechanics; folder tree
  + step-by-step section must match reality).
- `EMPLOYEE_GUIDE.md` — end-user how-to (statuses, folder tree, dashboard actions).
- `apps-script/SETUP.md` — deploy/config internals.
- `property_addresses.md` + `AliasSeed.gs` — canonical addresses. `AliasSeed.gs`/`SEED_EXTRACTION_NOTES`
  are shipped DEFAULTS seeded into the **Project Aliases**/**AI Notes** tabs once (see the knowledge
  rule up top); the live home is the tabs, edited via the dashboard's **Manage hints** panel.
  `property_addresses.md` + `project_aliases_seed.csv` are human-readable mirrors of the defaults.
- `tools/build-gem-pack.js` + `tools/GEM_SETUP.md` — bundles the repo into two upload files for an
  AI Studio **Gem** that answers questions about the system. The pack is a SNAPSHOT (a Gem has no
  link back here), so it carries a generated-on date and has to be rebuilt and re-uploaded after a
  batch of changes. `gem-pack/` is gitignored. If the docs list or a `.gs` filename changes, update
  the `DOCS` / `SOURCE` arrays in the builder.
- `apps-script/ExtractionNotes.gs` — standing domain notes injected into every Gemini extraction
  prompt (merged with the optional "AI Notes" sheet tab, which lets the team add hints without a
  deploy). This is the extractor's CLAUDE.md.

## Known future roadmap (user-stated)

- Nexus integration: **CSV-upload sync is DONE** (see "Nexus status sync" above — coordinator uploads
  the export, statuses mirror in). Still open: getting that export **without a human upload** (API or a
  scheduled report email), which would let this run on a trigger instead of on demand.
- Month-close archive: a month "closes" when its invoices are Captured/Paid/Canceled and reviews
  resolved. `Canceled` is a terminal lifecycle status (invoice rejected outright, never paid) added
  alongside `Paid` — it files at the month root like a real invoice (no folder of its own) and exists
  to close such invoices out (otherwise they sit as `Captured` forever) and to feed this archive
  hint. The archive TRIGGER itself is still TBD.
