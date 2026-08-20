# HANDOFF — send invoices from the dashboard to Procore

Written for the next Claude session picking this up. Read `CLAUDE.md` first for the repo's standing
rules; this file is only the in-flight state that isn't in there yet.

Date: 2026-08-20. Two repos are involved:

- `CyberSamada/WCM-Invoice-Automation-` — this repo. Apps Script. Where the feature gets built.
- `CyberSamada/Procore_Claude_Intergration` — a separate Python MCP server on Cloudflare Containers.
  **Not part of the build.** Read-only reference for how Procore's API actually behaves; a clone sits
  at `/workspace/cybersamada/procore_claude_intergration`. Issue #9 there carries this summary and
  three open questions.

---

## 1. State right now

| Item | State |
|---|---|
| PR #93 (Nexus `startRow` fix) | **merged**, `447364a` on `main`, deploy run #96 green |
| Branch `claude/dashboard-logo-wyaf1d` | realigned to `main`, pushed, tree identical to `main` |
| Procore feature | **not started** — blocked, see §5 |
| Full plan | `/root/.claude/plans/mutable-crunching-iverson.md` (approved, but predates §3 corrections) |

**Nexus apply has never been exercised in production.** PR #93 fixed a `ReferenceError` that meant
`applyNexusStatusUpdate` was never reached. Preview always worked; apply never ran. Ahmed has been
asked to test it. If he reports it still hangs, that is new behaviour, not the old bug.

---

## 2. What the feature is

Coordinators tick invoices in the dashboard and press send; Procore gets them. Today they download a
zip and re-key by hand. The `Captured` status (displayed **"In Procore"**) already means "this left
the dashboard and went into Procore" — the dashboard knows when the handoff happens, it just can't
perform it.

Decisions already taken with Ahmed, do not relitigate:

- **Apps Script calls Procore's REST API directly. No new hosting.** The MCP server runs on his
  *personal* Cloudflare account and he does not want company work billed there. Apps Script runs
  inside the Workspace the company already pays for.
- **A second, company-owned Procore Developer Portal app**, separate from the MCP's.
- **Auth = service account (client-credentials / DMSA)**, not the user-login flow. Procore refresh
  tokens are single-use, so a 15-minute trigger and a dashboard user would invalidate each other.
- **Record type is per-row.** Subcontractor Invoice default, Direct Cost secondary.
- **Phase 1 = header + PDF only.** Line items and cost codes are a later phase.
- `appsscript.json:13` already carries `script.external_request`, so no manifest change — which
  matters, because changing the manifest forces every viewer to re-authorize.

---

## 3. Endpoint findings — and what their epistemic status actually is

Read out of `procore_claude_intergration`. **Correction, 2026-08-20:** that repo's own session has
since told us it had **never run against a real Procore company** until the night of 2026-08-19 — it
was verified against the OpenAPI document and a test suite. So most of what follows is *spec-derived,
carrying the same uncertainty as our own plan*, not field observation. Treat each finding by the tag
on it:

- **[OBSERVED]** — seen against sandbox company 4288787 / project 362778 on 2026-08-19.
- **[SPEC]** — read off the OpenAPI document or their code. Not executed. May be wrong.

`create_subcontractor_invoice_draft` in particular **has never been executed.** Do not treat their
requisition code as field-tested.

Line references are to that repo and will drift if it changes.

### Corrections

1. **[SPEC] Commitments are two resources, not one.** No single `commitments` endpoint. Query both
   `work_order_contracts` (subcontracts) and `purchase_order_contracts` (POs) and merge.
   `tools/contracts.py:127-128`. Doubles the per-project fetch in the preview step.

2. **[SPEC] A subcontractor invoice is a `requisition`.** Not `subcontractor_invoices`.
   `tools/contracts.py:662-670`. Body shape:
   ```
   POST requisitions
   {"project_id": <int>, "commitment_id": <int>,
    "requisition": {"status": "draft", "invoice_number": <str>, "billing_date": "YYYY-MM-DD"}}
   ```

3. **[SPEC] `period_id` is optional per the schema — but do NOT drop the period fetch.**
   **This entry previously claimed their code "sends `billing_date` only and Procore accepts it".
   That was wrong and is retracted** — nothing had been executed, so there was no observation behind
   it. What is actually known: `POST /rest/v1.1/requisitions` requires `["project_id",
   "commitment_id"]`, and inside the `requisition` object `required: []` — both `period_id` and
   `billing_date` are optional. Same on v1.0.

   **Weak counter-signal, and it matters:** on 2026-08-19 Procore rejected `rfi_manager_id` with a 400
   naming the field, and that field appears in no required list anywhere in the OAS. So the OAS
   required-lists are not trustworthy as a completeness guarantee. **Keep the per-project billing-period
   fetch as a fallback** rather than deleting it on the strength of the schema.

   Also flagged: `POST /rest/v1.1/requisitions` accepts a query parameter `invite_id`. Semantics
   unknown — and "invite" is a hazard word for a system that must not notify anyone. Do not set it,
   and find out what it does before going near production.

4. **[SPEC] Attachments use a two-step signed upload**, not direct multipart. `client.py:422-500`:
   - `POST projects/{id}/uploads` with `{response_filename, response_content_type, size}` →
     `{uuid, url, fields}`
   - POST the file to that `url` with `fields` + the file, **carrying no `Authorization` and no
     `Procore-Company-Id`**. The URL arrives in a response body; sending credentials would hand a live
     Procore token to whatever host that response named. Their client uses a separate connection and
     refuses any non-HTTPS URL. Copy both.
   - Reference the returned `upload_uuid` on the record.
   - Their cap is 100 MB (`client.py:420`), well above our 20 MB working cap.

5. **[OBSERVED] 401 and 403 both occur and mean DIFFERENT things. Handle them separately.**
   **This entry previously said a permissions gap shows as 401 "not 403". That was wrong and is
   corrected here** — the earlier reading came from a code comment; the following came from real
   requests on 2026-08-19.

   - **401 = the app is not installed / has no Data Connector component.** `client.py:272-284`.
     Dropping the cached token and retrying once is the right response.
   - **403 = authenticated fine, but no access to that tool or that project.**
     **NEVER drop the token on a 403** — the token is valid and re-minting it changes nothing.

   Observed on sandbox company 4288787, project 362778: `GET /projects` 200 and
   `GET companies/{id}/users` 200, while `GET projects/{id}/rfis`, `manpower_logs`,
   `permission_templates`, `POST notes_logs` and `POST /vendors` all returned **403**.

   **The cause you will hit first is the permitted-projects list.** A service account operates only in
   projects explicitly added to it (Company Admin → App Management → the app → Permissions). Until a
   project is on that list, *every* project-level call 403s **including reads**, and nothing in the
   error names a project list. Adding the project flipped all project reads to 200 immediately **on
   the same cached token** — permissions are evaluated per request, not baked in at issuance, so there
   is no token to invalidate and no cache to clear.

   Writes stayed 403 after that until the permission template was dealt with separately. Second cause,
   from Procore's own documentation: **manifest permissions do not transfer to the installed permission
   template when an app is updated** — reconcile by hand after any app update.

6. **[SPEC] API version is per resource.** Paths are `/rest/v{version}/{path}`; a single global pin is wrong.
   Default 1.0, `budget_line_items` is 2.0. `client.py:213-223`, `config.py:44-58`. Needs a
   per-resource override map, not a hardcoded prefix.

   Related, `config.py:60-99`: which host answers `/oauth/token` is genuinely ambiguous. Their note
   records that client-credentials was observed working on the **API** host, and that switching to the
   login host on the strength of a quick-start turned a working setup into a 401 with nothing saying
   the host had changed. They try both. Do the same.

   Hosts: sandbox `https://sandbox.procore.com` / `https://login-sandbox.procore.com`;
   production `https://api.procore.com` / `https://login.procore.com`.
   All requests carry a `Procore-Company-Id` header (`client.py:250`).

### Confirmed, no change needed

- Sandbox-by-default (`config.py:34-41`) — same reasoning as ours, arrived at independently.
- Client-credentials auth, `expires_in` honoured with a 120s refresh margin (`client.py:129-160`).
- Records created with draft status.
- Duplicate pre-check: list existing, match on commitment + invoice number
  (`tools/contracts.py:637-652`).
- Retry shape: 429 with backoff, 5xx with backoff, 401 retried exactly once — but see finding 5:
  403 needs its own arm and must not drop the token.
- Findings 1, 2, 4 and 6 were confirmed as correctly read by that repo's own session.
- **Copy their upload test, not just the upload behaviour.** The no-credentials rule on the storage
  POST is enforced by a test that parses the function's AST and fails if `Authorization` or
  `Procore-Company-Id` appears anywhere in it. A behavioural test would not catch a later edit
  re-adding a header.

### Unresolved — decide before any production send

**It is not known whether creating a requisition notifies the subcontractor.**
`tools/contracts.py:589-591` flags this explicitly and leaves it unmeasured. This matters far more for
a bulk dashboard action than for an interactive tool: ticking twelve invoices could email twelve
vendors about draft records with no line items. Settle it in sandbox against a commitment whose vendor
contact is internal, **before** production. Ahmed has been told; he has not answered.

**There is a test that needs no inbox access,** proposed by that repo's session: `email_communications`
is keyed by `topic_type` / `topic_id`. Create the draft, then query it for that topic. A hit is proof
that mail was generated. A miss is weaker evidence, but meaningful alongside two facts — there is no
`notify` or `send` parameter anywhere in the requisition POST body, and `submitted_at` is a distinct
field from creation. (Sandbox vendors use `implementation+sub@procore.com`, Procore's own inbox, so
reading the mailbox is not an option either way.) They will run it once a commitment exists on
sandbox; **whoever gets credentials first should run it and save the other the trip.**

### Also learned

`tools/contracts.py:585-592` — they deliberately refuse to write line items, because the lines bill
against the commitment's schedule of values and getting them wrong produces an invoice with wrong
numbers. This vindicates header-only Phase 1 and raises the bar on the line-item phase: the target is
not "parse the invoice", it is "map each line onto that commitment's schedule of values".

`config.py:106-140` — their write gate is `off` / `create` (`draft` is a retained alias for `create`),
with deliberately **no** value meaning
send/submit/approve, failing closed on anything unrecognised. Worth adopting: our plan already fails
safe on sandbox-vs-production; extending the same shape to what the integration may *do* costs nothing.

---

## 4. Design points the plan settles

Full detail in the plan file; the load-bearing ones:

- **`PROCORE_ENV` defaults to `sandbox`.** A missing or fat-fingered property must never resolve to the
  live company — same fail-safe reasoning `CLAUDE.md` applies to folder IDs.
- **Token in `CacheService.getScriptCache()`, not Script Properties.** A live bearer token should not be
  persistent; script cache is shared across concurrent executions so a burst of `google.script.run`
  calls shares one token. Mint under a `LockService` lock — a *different* lock instance from the apply
  run, or it deadlocks — and re-check the cache after acquiring.
- **Commitment is a learned crosswalk keyed on WCM project + WCM vendor**, not a dialog dropdown. One
  pick per vendor-project pair, ever, instead of N picks per batch forever. Makes PO-number matching a
  later enhancement rather than a redesign.
- **Vendor mapping is only required for Direct Cost.** A subcontractor invoice is created against a
  commitment, which already carries the vendor. Say so in the UI.
- **Per-row create order: create → write the ledger row immediately → attach the PDF → set status.**
  Do **not** batch successful creates the way `logNexusSyncRows_` batches. The send log is the
  idempotency ledger; a mid-run kill with entries still in memory loses the record of what was created
  and the resumed run double-creates in the company's production books. A status flip is recoverable;
  a duplicate commitment invoice is not. Batch only failure rows.
- **Write-back is Status only**, through `updateInvoiceRow` (the single write path), using
  `STORED_PROCESSED_STATUS` — never the literal `'Captured'`, never `'In Procore'`.
- **Refuse `Duplicate` and `Not an Invoice` at index time.** A Duplicate row's file belongs to the canon
  invoice.
- **The send log, not status, is the dedupe key** — a row can be `Captured` from the download tick-box
  without ever having been sent.
- **Apps Script multipart gotcha:** a `payload` containing a Blob is encoded as `multipart/form-data`
  **only if you do not set `contentType`**. Setting it (the habit from the Gemini call) destroys the
  boundary and Procore rejects the body.

### Who sent it — audit

Asked directly by Ahmed. Reuse `currentViewerEmail_()` (`NexusSync.gs:773`); do not write a second one.

- `Procore Send Log` tab gets a `Sent By` column — the primary record.
- **`Override Log` has no `Changed By` column** (`Config.gs:169`, confirmed against the live sheet), so
  every manual correction to date is anonymous. Add `'Changed By'` to `OVERRIDE_LOG_COLUMNS` and set it
  in `logOverride_` (`SheetService.gs:733`). `ensureSheetHasColumns_` adds it to the existing tab on
  next write and every write is header-keyed, so it is safe on live data with no migration.
- One appended Review Note line, so it shows in the ⓘ popover.
- **Procore's own audit trail will name the service account, not the coordinator.** Inherent to DMSA
  auth. Mitigate by stamping `Entered from Invoice Desk by <email> on <date>` into the record's
  description/notes on create, and by naming the service account something human. Do **not** solve this
  by giving each coordinator their own Procore login — that reintroduces the single-use refresh token
  race the service account exists to avoid.
- Identity preconditions all check out: `userinfo.email` scope present, `executeAs: USER_DEPLOYING`,
  `access: DOMAIN`, owning account on the `westdellcorp.com` Workspace domain. **Still unproven at
  runtime** — nothing has ever exercised it (the live sheet has Nexus map tabs but no `Nexus Sync Log`
  tab, so no `decidedBy` row has ever been written). Keep the `'a person'` fallback. If it resolves
  empty, add a "sending as" picker rather than blocking the send.

---

## 5. Blocked on Ahmed

Nothing else gates the work.

**Registering the app and creating the service account gets you authenticated, not operational.**
There are three more admin steps behind it, each of which fails as a 403 that names nothing useful.
All four are company-admin work, not code.

1. **Register the app + create the service account.** A company-owned app with a Data Connector
   component, **its version installed on the company** (per finding 5, skipping this is what produces
   401s), and a service account. Output: a client ID and client secret. Until these exist there is
   nothing to write code against.
2. **Add every project we will file into to the app's permitted-projects list.**
   Company Admin → App Management → the app → Permissions. Until a project is on that list, *every*
   project-level call 403s including reads. This is per project, so it is ongoing admin, not one-time
   setup — a new WCM project means a new entry here or its invoices silently stop sending.
3. **Company-level `Directory: Admin`** for anything company-scoped, and reconcile the installed
   permission template by hand after any app update (manifest permissions do not transfer).
4. **The notification question** (§3, unresolved) — or permission to settle it in sandbox.
5. **Whether the billing-period blocker is worth building**, once finding 3 is verified. Current
   guidance: **keep it**; the schema says optional but the OAS required-lists have already been shown
   unreliable.
6. **Test the Nexus Apply button** — first execution of a path that has never run.

---

## 6. Also open, unrelated to Procore

Dashboard load time. Ahmed asked for options and the answer was never delivered:

- **A — instrument `doGet`** so the fix targets what is actually slow. Do this first.
- **B — cache `getReferenceData_()`.** It is uncached and read **twice** per page load
  (`DashboardServer.gs`). Highest-confidence win.
- **C — payload diet.** Stop serializing fields the table never renders; consider server-side paging.

---

## 7. PR sequencing

| PR | Contents | Risk |
|---|---|---|
| ~~0~~ | ~~`startRow` fix~~ | **done, #93** |
| 1 | `ProcoreClient.gs`, `CONFIG.PROCORE`, `setupProcore()`, `testProcoreConnection()` | read-only against Procore |
| 2 | Four crosswalk tabs + mapping UI + `saveProcore*Mapping`, plus `Changed By` on the Override Log | no sending |
| 3 | Preview + apply + audit + bulk-bar button | first writes |

PR 1 is read-only on purpose: it pins every endpoint shape in §3 against the live company before
anything depends on it, and settles findings 3 and 6 for real.

Ship with `PROCORE_ENV=sandbox`. Send one invoice, verify in the Procore UI, delete it there and re-run
to prove the ledger blocks the second send. Then one Direct Cost, then 3 across 2 projects. Only then
production, with one real invoice checked by eye.
