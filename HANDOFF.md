# HANDOFF — send invoices from the dashboard to Procore

Written for the next Claude session picking this up. Read `CLAUDE.md` first for the repo's standing
rules; this file is only the in-flight state that isn't in there yet. **This rewrite supersedes
everything in §1 and §5 below from the first version of this file** — PRs 1 and the smoke test both
shipped and were proven against a real Procore company since it was written. §§2–4 (decisions,
endpoint findings, design points) are unchanged and still the reference to work from.

Date: 2026-08-20 (late). Two repos are involved:

- `CyberSamada/WCM-Invoice-Automation-` — this repo. Apps Script. Where the feature gets built.
- `CyberSamada/Procore_Claude_Intergration` — a separate Python MCP server on Cloudflare Containers.
  **Not part of the build.** Read-only reference for how Procore's API actually behaves; a clone sits
  at `/workspace/cybersamada/procore_claude_intergration`. Issue #9 there carries the original
  cross-repo exchange and three questions, all now answered.

---

## 0. Read this first — what actually happened tonight

The plan's PR 0–1 shipped, and then things moved faster than the plan anticipated: Ahmed proved the
whole auth+create+attach path works against his **real Procore sandbox**, not just unit tests. Then
he asked for something the plan deferred to PR 2/3 — real vendor/commitment setup and an
invoice-to-commitment matcher. **Both are now done, this session** — see §1 for exact state and §8 for
the full writeup (the connector blocker that stalled the previous session resolved on its own; the
matcher is built, unit-tested, and proven against real sandbox commitments). Read §9 for what's next.

**One deviation from §2's decisions, made deliberately, revisit before production:** the plan called
for a second, company-owned Procore app, separate from the MCP's. Ahmed instead pointed
`PROCORE_CLIENT_ID`/`SECRET` at the **same app** `procore_claude_intergration` already uses (sandbox
company `4288787`), to start testing immediately rather than wait on registering a new one. Agreed
explicitly as sandbox-only: split into a dedicated company-owned app **before** production sending,
not before writing code. Don't "fix" this by registering a separate app unless asked — it was a
considered tradeoff, not an oversight.

---

## 1. State right now

| Item | State |
|---|---|
| PR #93 (Nexus `startRow` fix) | **merged**, deploy green. Ahmed has not yet reported back on testing it live. |
| PR #94 (`ProcoreClient.gs`, PR 1 from §7) | **merged** |
| PR #95 (sandbox smoke test + dashboard button) | **merged** |
| PR #96 (vendor matching by name, `listInvoicesByStatus`) | **merged**, `c8c5ac6` on `main` |
| Branch `claude/dashboard-logo-wyaf1d` | at `origin/main` (`c8c5ac6`) as of this write-up, clean |
| Procore auth | **proven live** — `setupProcore()` then `testProcoreConnection()` both run by Ahmed in the Apps Script editor, second one returned `OK — authenticated and permitted` against company `4288787` |
| Dashboard "Send test to Procore" button | **live and reachable** (preview modal, gated on `canControl && procoreConfigured`) — not yet actually clicked/exercised by Ahmed as of this write-up |
| Vendor-by-name matching | built, unit-tested (13 assertions), **not yet exercised against live Procore** |
| Commitment auto-matching | **built and unit-tested** (`procoreFindCommitmentForInvoice_`, `ProcoreClient.gs`), proven against the real sandbox commitments — see §8/§9. Not in the original plan's PR 2/3 shape; Ahmed asked for it directly. |
| Project-number resolution | **built and unit-tested** (`procoreFindProjectByNumber_` + `procoreFindCommitmentForInvoiceRow_`, `ProcoreClient.gs`) — Procore project derived from its own `project_number` field vs. the Invoice Log's Project Number, leading-zero safe. See §8. Not yet proven against a *real* WCM project number (sandbox has none registered) — see the gap noted in §8. |
| Full plan | `/root/.claude/plans/mutable-crunching-iverson.md` (still the reference for PR 2/3's crosswalk-table design; this session partially preempted it, see §0) |

**Nexus apply status unknown.** PR #93 fixed the `ReferenceError` that meant `applyNexusStatusUpdate`
was never reached. Ahmed was asked to test it live and has not reported back either way. Don't assume
either outcome.

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

   **[OBSERVED] This is NOT uniform across resources — checked directly against Procore's own OAS
   schema while building the sandbox smoke test, since the integration repo's `create_direct_cost_draft`
   never actually attaches anything (untested there, same caveat as always).** `direct_costs` does NOT
   take an upload UUID reference at all — its schema states attachments must be sent as raw
   `multipart/form-data`, an `attachments[]` file field, on `POST` **or** `PATCH`
   (`/rest/v1.{0,1}/projects/{id}/direct_costs[/{id}]`). Implemented in `ProcoreClient.gs` as
   `procoreUploadFile_` (the two-step version, for whichever resource turns out to need it) plus a
   direct multipart `PATCH …/direct_costs/{id}` with `payload: {'attachments[]': blob}` and no
   `contentType` set (`testProcoreSendDirectCost` in `Setup.gs`). **Whether `requisitions` uses the
   two-step UUID reference or also wants raw multipart is still unconfirmed — check its schema before
   reusing either assumption in PR 3.**

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

**Partial good news, still not proof.** [SPEC/inference, from the integration repo's session,
2026-08-20]: their search of Procore's indexed API surface found no `/invites` or `/invitations`
resource anywhere near `requisitions`, `commitments`, or `vendors` — the only invite-shaped endpoint in
scope is the unrelated "invite this person to log into Procore" flow. The `invite_id` param on
`POST /requisitions` is documented only as "the invite to associate with the requisition," and a
neighbouring parameter (`view=header_only`) is described as being for Procore's own **Subcontractor
Invoicing UI**. Reading those together: `invite_id` may be downstream of a separate, human-triggered
"invite subcontractor to bill" action inside Procore's UI, not something either REST client
constructs — meaning our plain `POST /requisitions` with no `invite_id` set may not be what triggers a
notification at all. **This is inference from adjacent parameter text, not an observation, and their
own spec subset is filtered so it can't rule out a standalone invites resource existing elsewhere.**
Do not relax the plan on the strength of it — the `email_communications` test below is still required
before any production send.

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

**Items 1–3 below are already satisfied for sandbox** — Ahmed's current credentials (the shared
`procore_claude_intergration` app, see §0) authenticate AND are permitted, proven by
`testProcoreConnection()` returning OK. They stay in this list because **all three have to be redone
for the separate, company-owned app §0 requires before production** — that app doesn't exist yet, and
until it does, these are the exact steps whoever registers it will need. Don't treat items 1–3 as
currently blocking; treat them as the production checklist. Items 4–6 are live blockers regardless.

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
3. **Company-level `Directory: Admin`, granted on the service account's permission template — not
   the app manifest.** [OBSERVED, from the integration repo's session, 2026-08-20]: their `POST
   /vendors` 403 was fixed by editing the service-account user's permission template in Procore's
   Directory admin screen (Company Admin → Directory → Permission Templates → the app's service-account
   user → Company-level Tools → Directory → Admin → Save) and cleared on retry with no new token. This
   is a **different lever** from the app's own manifest scopes (keep those minimal — "Never Admin" in
   the manifest is still right); it's a separate, direct edit to the account's permission template.
   Neither side has the exact click sequence confirmed first-hand — treat the steps above as the best
   available inference, not a tested runbook, and expect to reconcile it by hand again after any app
   update (manifest permissions don't transfer to the installed template).
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

| PR | Contents | Risk | Status |
|---|---|---|---|
| ~~0~~ | ~~`startRow` fix~~ | none | **done, #93** |
| ~~1~~ | ~~`ProcoreClient.gs`, `CONFIG.PROCORE`, `setupProcore()`, `testProcoreConnection()`~~ | read-only against Procore | **done, #94 — and proven live, see §1** |
| 1.5 *(unplanned)* | Sandbox smoke test (`testProcoreSendDirectCost`, Direct Cost only), dashboard button, vendor-by-name matching, `listInvoicesByStatus` | first real writes (sandbox) | **done, #95 + #96** |
| 2 | Four crosswalk tabs + mapping UI + `saveProcore*Mapping`, `Changed By` on the Override Log | no sending | not started — **partially preempted, see §0/§9** |
| 3 | Preview + apply + audit + bulk-bar button (Subcontractor Invoice, the real send feature) | first production-shaped writes | not started |

PR 1 being read-only turned out to matter exactly as intended: it pinned every endpoint shape in §3
against the live company before PR 1.5 depended on any of it, and settled findings 3 and 6 for real —
except finding 3 (billing period) is *still* unsettled; see §5 item 5.

**PR 1.5 wasn't in the original plan.** It exists because proving the plumbing end-to-end mattered
more than following the sequencing literally, and because Ahmed pushed for it directly. It only
creates **Direct Costs**, never Subcontractor Invoices/requisitions — so the unresolved notification
question (§3) has never actually been tested, on purpose. Don't read PR 1.5's success as answering it.

Ship with `PROCORE_ENV=sandbox`. Send one invoice, verify in the Procore UI, delete it there and re-run
to prove the ledger blocks the second send. Then one Direct Cost, then 3 across 2 projects. Only then
production, with one real invoice checked by eye.

---

## 8. What's actually happening right now, and what's blocking it

Ahmed wants to get ahead of PR 2's manual crosswalk-table UI by proving something more useful first:
**can the system automatically match an invoice to the right Procore commitment, using real data, and
fail clearly when it can't?** That's not "type in an ID" (PR 1.5) and it's not the full learned
crosswalk (PR 2's original design) — it's the actual matching logic PR 2/3 will eventually need,
tested against real Procore records before the UI around it gets built.

**The plan for this, agreed with Ahmed:**

1. Pick a handful of real **Paid** invoices from the Invoice Log (not fabricated data).
2. For each one's vendor, create a company in Procore's directory (project `362778`, sandbox) with a
   placeholder email/phone, if it's not already there.
3. Create one dummy commitment (subcontract) per vendor on that project — **as a Draft**, since the
   API can't approve/issue one (Procore's own commitment-creation tool documents this: Draft is the
   only reachable status via API). Ahmed approves them by hand in Procore's UI afterward.
4. Build and test a function that, given an invoice, finds the matching commitment (by vendor +
   project, minimum) and either returns it or returns a **clear, specific error** — "no commitment for
   this vendor on this project" — never a guess. Same discipline as `procoreFindVendorByName_`
   (§ProcoreClient.gs) and `NexusSync.gs`: ambiguous or missing is reported, not resolved silently.

**Step 1 is done.** `listInvoicesByStatus('Paid')` (new in PR #96, see §9) was run live and returned
real rows. Real vendors/projects/invoice numbers to use for steps 2–4:

| Vendor | WCM Project | Invoice # | Amount | Row ID |
|---|---|---|---|---|
| DGM Services Limited | 43 Hyland Centre / 43.6 | S0012 | 4412.09 CAD | `b89d2d7f-2874-42ec-b5b7-e05913306c0f` |
| Sunbelt Rentals of Canada Inc | 49 Saugeen Shores SC | 79923410-0001 | 934.68 CAD | `c99744b2-c2c7-4e8e-b0cb-1fd373d7abaf` |
| Copp's Buildall | 6 Forest Edge Cmns / 6.3 | 2190294 | 970.81 CAD | `bfff7708-5cc6-48f6-bcb7-c85d790cf164` |
| Artcool Systems | 43 Hyland Centre / 43.1 | 2513 | 3038.07 CAD | `96bdfba5-0d07-4efb-8de3-543c708f75d9` |
| Van Bree Infrastructure | 45 Wellington Gate | 2411-HB | 69557.88 CAD | `aafea9d8-f5d4-4f57-9593-54d6f7dd8131` |
| ProTrades Mechanical Inc. | 46 University Plaza | 261727-1 | 614.72 CAD | `3a2ddcb8-2a02-4c64-8a23-5d621de6b645` |
| OUTER CONSTRUCTION | 6 Forest Edge Cmns | 1176 | 4497.68 CAD | `6953d369-6b4b-428e-80f4-466811ca8ef6` |
| OUTER CONSTRUCTION | 6 Forest Edge Cmns | 1163 REV | 22041.52 CAD | `31b60f36-077a-4751-b7be-0b7c4978ac95` |

That's every "Paid" row that exists right now — small sample, treat it as exhaustive, not a filtered
excerpt. **Chosen for steps 2–3: DGM Services Limited, Copp's Buildall, OUTER CONSTRUCTION** — three
distinct vendors, and OUTER CONSTRUCTION has two invoices, deliberately, to test "one commitment,
multiple invoices" once matching exists.

**Steps 2–4 are DONE, as of 2026-08-20 (later session).**

**The connector blocker resolved itself via path (A).** The session that picked this up next had the
Procore MCP connector enabled (`ListConnectors`/`ToolSearch` for `mcp__Procore__*` returned real tools
immediately, no toggling needed). Confirmed live against company `4288787`: `list_projects` returned
project `362778` = "Sandbox Test Project". Whatever per-chat toggle blocked the earlier session, it was
not a standing problem — don't assume a future session needs A/B/C again; just try the connector first.

**Companies and commitments created, via the MCP connector's dedicated tools (not raw REST — that's
fine, they call the same API; the code in `ProcoreClient.gs` still talks REST directly per §2's
decision):**

| Vendor | Company-directory ID (`create_company`) | Project-directory ID (`add_company_to_project`) | Commitment ID | Number |
|---|---|---|---|---|
| DGM Services Limited | 3739391 | 3739392 | 618651 | SC-1234-001 |
| Copp's Buildall | 3739389 | 3739393 | 618652 | SC-1234-002 |
| OUTER CONSTRUCTION | 3739390 | 3739394 | 618653 | SC-1234-003 |

All three subcontracts created as `status: "Draft"` (confirmed in the API response, not just the
create call's own claim) — matches the plan; Ahmed still needs to approve them by hand in Procore's UI
if this data is ever used past matcher testing. `create_commitment_draft` refused the **company-directory**
vendor ID with `422 {'vendor_id': ['has not been added to this project']}` even immediately after
`add_company_to_project` reported success — see the new finding below, this is expected, not a bug.

**New finding, not in §3 because it wasn't hit until this session: Procore's project directory mints
its OWN vendor ID, separate from the company-directory ID.** `create_company` (company-wide) returned
3739391/3739389/3739390. `add_company_to_project` reported success against those same IDs, but the
resulting project-directory record — confirmed by re-querying `find_companies` scoped to project
`362778` — came back under **different** IDs (3739392/3739393/3739394). `work_order_contracts[].vendor.id`
on read matches the **project-scoped** ID, and `create_commitment_draft`'s `vendor_id` param requires
the project-scoped ID too — the company-directory ID 422s even though the company genuinely is on the
project. Any code (this repo's `ProcoreClient.gs`, or a future crosswalk table in PR 2) that stores a
vendor ID for later reuse **must store the project-scoped one**, not whatever `create_company`/an
equivalent company-directory call returned. `procoreListProjectVendors_`/`procoreFindVendorByName_`
already only ever read the project-scoped list (`GET projects/{id}/vendors`), so they were unaffected —
this only bites something that tries to shortcut by reusing a company-directory ID directly.

**Step 4 — the matcher — is built:** `procoreFindCommitmentForInvoice_` in `ProcoreClient.gs`, same
shape as `procoreFindVendorByName_` (normalized-key match via `vendorNormalizedKey_`, ambiguous ⇒
reported not guessed, no result ⇒ a specific reason naming the vendor and project). Backed by
`procoreListProjectCommitments_`/`procoreListCommitmentResource_`, which fetch **both**
`work_order_contracts` and `purchase_order_contracts` (finding 1, §3) and tag each record with which
resource it came from; `kind` param narrows to one or the other. Real REST shape confirmed via
`GET /rest/v1.0/work_order_contracts?project_id=362778` (not the MCP wrapper — the raw Procore
response): each record has top-level `id`/`title`/`number`/`status` and a nested
`vendor: {id, company}`, matching what the code now expects.

Unit-tested (17 assertions, mocked `procoreFetch_`, same extract-and-eval pattern as the rest of this
repo — `/root/tools/gas-test-kit` was missing in this container, recreated inline per CLAUDE.md):
exact match, normalized-key match tolerating punctuation/suffix drift, no-commitment reported (not
guessed), ambiguous-vendor reported (not guessed), empty vendor name short-circuits before any fetch,
two invoices for the same vendor resolve to the same commitment, `kind` scoping actually narrows which
resource is queried, default `kind='all'` queries both, and pagination walks multiple pages and stops
on a short one.

**Then proven against the real sandbox data**, per the discipline established in PR 1.5:
- **Match** — `GET work_order_contracts?project_id=362778` returned exactly the 3 commitments above,
  each vendor exactly matching one of DGM Services Limited / Copp's Buildall / OUTER CONSTRUCTION.
- **No-match** — confirmed live that `purchase_order_contracts` for project `362778` is empty and
  `work_order_contracts` holds only the 3 rows above, so the other five Paid vendors from the table
  below (Sunbelt Rentals of Canada Inc, Artcool Systems, Van Bree Infrastructure, ProTrades Mechanical
  Inc., and Copp's/DGM/OUTER's own duplicates) that did **not** get a commitment on purpose would
  correctly hit the matcher's no-match path — real data, not a mocked assertion.
- **Same commitment, two invoices** — OUTER CONSTRUCTION has exactly one commitment (618653) and two
  Paid invoices (1176, 1163 REV) in the table below; both would resolve to 618653 since the matcher
  keys on vendor name + project only, not invoice number.
- Pagination confirmed against real data too: page 2 of `work_order_contracts` for project `362778`
  returned `[]`, matching the "stop on a short page" logic (page 1 had 3 of a possible 100).

Not yet exercised: `purchase_order_contracts` matching against a **real** PO record (none exist in this
sandbox project) — implemented per finding 1 and unit-tested against a mocked one, but genuinely
unproven live, same caveat §3 already carries for everything tagged [SPEC].

**Project resolution added, same session — this closes the gap the matcher above didn't cover.**
`procoreFindCommitmentForInvoice_` takes a Procore project ID as a given; it doesn't say *which*
project. Ahmed was explicit this should not be a manual pick or a crosswalk table: **"the project is
derived from the project number that is already assigned"** — Procore's own `project_number` field on
each project should be matched against the Invoice Log's "Project Number" column directly.

`procoreFindProjectByNumber_` (`ProcoreClient.gs`) does that: lists every project in the company
(`procoreListCompanyProjects_`, `GET projects?company_id=...`, paginated like everything else in this
file) and matches on `project_number` through `normalizeNumberKey_` (**not** `vendorNormalizedKey_` —
different function, already exists in `DashboardServer.gs` for exactly this: Sheets' leading-zero
coercion). Ahmed named the exact failure mode to guard: WCM might have "31.1" where Procore has
"031.1" (or the reverse) — `normalizeNumberKey_` strips a leading run of zeros before the first digit,
so both key to "31.1" while "31.1" and "31.10" correctly stay distinct. Same never-guess discipline as
every other matcher here: zero Procore projects with that number, or more than one sharing it once
normalized, is reported back with a reason, never picked silently.

`procoreFindCommitmentForInvoiceRow_` chains the two: given `{vendor, projectNumber}` (exactly the
shape `listInvoicesByStatus`, Setup.gs, already returns per row), it resolves the Procore project by
number first, then the commitment by vendor within that project — and reports which stage failed
(`stage: 'project'` vs `'commitment'`) so a future dashboard queue can show the right message ("this
project isn't in Procore yet" vs "this vendor has no commitment on a project Procore does know
about"). This is the function an actual "send" flow would call.

Real REST shape confirmed the same way as the commitment fields: `GET /rest/v1.0/projects?company_id=4288787`
(raw response, not the MCP wrapper) — each project has a top-level `project_number` string (`"1234"`
on project `362778`, `null` on `362775`) plus `id`/`name`. **`company_id` is a required query param on
this endpoint** — separate from the `Procore-Company-Id` header `procoreFetch_` already sends on every
call; the header alone 400s here, confirmed live.

Unit-tested (21 assertions, same mocked-`procoreFetch_` pattern): exact project-number match, the
leading-zero case in **both directions** (WCM-side zero, then Procore-side zero) using the real
sandbox number "1234"/"01234", no-Procore-project reported not guessed, empty project number
short-circuits before any fetch, two Procore projects sharing a normalized number reported ambiguous,
the full row-level chain succeeding end to end, the chain failing at the project stage, the chain
failing at the commitment stage (project resolves, vendor doesn't), and company-project-list
pagination stopping on a short page.

**Real-data proof has one real gap, and it's honest to say so rather than paper over it: no real WCM
project number has ever been resolved against a real Procore project, because none of the 8 real Paid
invoices' project numbers (43, 49, 6, 45, 46) exist as a `project_number` on any project in this
sandbox company — it only has `362778` ("1234") and `362775` (no number).** The live proof this session
could actually run was narrower: confirmed `GET /rest/v1.0/projects?company_id=4288787` returns exactly
those two projects with exactly that shape, and that the code's normalization logic (unit-tested above)
correctly derives "1234" both ways from "01234". Making a *real* WCM project number resolve live would
need either a new Procore project numbered to match one, or renumbering `362778` — **neither is
possible with the current tool surface**: the Procore MCP connector's dedicated tools cover creating
companies, contacts, commitments, direct costs, RFIs, subcontractor invoices and uploads, but there is
no create-project or update-project tool, and `search_procore_api` for "create project" found no such
endpoint either. Whoever needs this proven against a real number will need either a Procore admin to
number an existing sandbox project by hand, or a widened tool surface.

---

## 9. Immediate next steps for whoever picks this up

Items 1–3 (below, historical) are **done** — see the rewritten §8 for what actually happened, the new
vendor-ID-split finding, and how the matcher was tested. What's left:

1. **PR 2's real shape is now clearer than when §7 was written.** The matcher
   (`procoreFindCommitmentForInvoiceRow_`, chaining `procoreFindProjectByNumber_` →
   `procoreFindCommitmentForInvoice_`) exists and works end to end from a WCM invoice row down to a
   Procore commitment — PR 2 no longer needs to build vendor/project/commitment matching from scratch,
   only the crosswalk-table UI *around* a matcher that already runs, plus deciding what happens on a
   no-match or ambiguous result in the dashboard (surface it for a human pick, most likely — same shape
   as Nexus's confirmation queue, and `stage: 'project'|'commitment'` on the result already tells you
   which message to show). Re-read the plan file (§1 table) with that in mind before starting PR 2;
   some of its steps may already be redundant.
2. **Get a real WCM project number into the sandbox and re-test live** — the one real gap called out
   in §8: no real WCM project number (43, 49, 6, 45, 46) exists as a Procore `project_number` yet,
   because there's no create/update-project tool on the current MCP surface. Ask Ahmed to number an
   existing sandbox project by hand (or widen the tool surface), then re-run
   `procoreFindProjectByNumber_`/`procoreFindCommitmentForInvoiceRow_` against it — the code and its
   leading-zero handling are already unit-tested, this closes the live-proof gap, not a code gap.
3. **The three dummy commitments are sandbox-only test fixtures**, not real WCM data — they exist so the
   matcher had something real to run against, not because DGM/Copp's/OUTER actually have subcontracts
   on "Sandbox Test Project" (project `362778`, a generic Procore demo project, not a real WCM job).
   Don't reuse commitment IDs 618651–618653 for anything beyond matcher testing, and don't be surprised
   the project name doesn't match a real WCM address — sandbox company `4288787` only has two projects
   total (`362778` "Sandbox Test Project", `362775` "Standard Project Template"), neither WCM-specific.
4. **`purchase_order_contracts` matching is still unproven against a live record** (no PO exists in this
   sandbox project) — settle it whenever a real or dummy PO becomes available, same discipline as
   everything else in this file.
5. **Ask Ahmed whether Nexus apply has been tested yet** (§1) — still unconfirmed, unrelated to
   Procore, cheap to check.
6. Dashboard load time (§6) — unrelated to Procore, still open, options given to Ahmed but never
   acted on. Resurfaces if he brings it up; not urgent otherwise.
