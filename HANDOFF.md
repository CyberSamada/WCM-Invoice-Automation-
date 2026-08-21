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
| Commitment picker + real send | **built and unit-tested** (43 assertions) — "Match to Procore commitment…" + "Send to Procore" buttons (`Dashboard.html`), `ProcoreSend.gs`: crosswalk persistence (`Procore Commitment Map` tab), pick confirmation, and the actual `sendInvoiceToProcore` (creates a real Subcontractor Invoice, attaches the PDF, logs to `Procore Send Log`, flips Status). See §8. **The live create call is genuinely unverified** — blocked by this session's permission classifier; needs explicit permission or a manual run before trusting it beyond code review. |
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

> **Superseded, 2026-08-21.** The `[SPEC]`/`[OBSERVED]` tags below are a
> hand-made snapshot taken 2026-08-20. One day later the Procore MCP verified
> **32 of its 62 tools** against live Procore and recorded six new API rules.
> So these tags now understate what is proven and miss every new trap.
>
> The current version of this knowledge is **`canon/procore-facts.json`**,
> imported with `python3 canon.py pull`. Read that first. Keep this section
> for the reasoning it records, not for its epistemic tags, and **do not add
> new Procore findings here** — they belong at the owner. See `canon/README.md`.

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
create call's own claim) — matches the plan; Ahmed is now approving them by hand in Procore's UI.
`create_commitment_draft` refused the **company-directory** vendor ID with `422 {'vendor_id': ['has
not been added to this project']}` even immediately after `add_company_to_project` reported success —
see the new finding below, this is expected, not a bug.

**A fourth commitment, deliberately, to test the ambiguous-vendor path for real.** Ahmed asked for a
second commitment on one of the three vendors specifically so the "more than one commitment for this
vendor" case — already unit-tested with mocked data — has a real fixture behind it too. Created
commitment `618665` ("DGM Services Limited — second matcher test subcontract", `SC-1234-004`, Draft)
against vendor `3739392` — the same project-scoped vendor ID as `618651`. Re-queried
`GET work_order_contracts?project_id=362778` afterward and confirmed live: DGM Services Limited now
has **two** rows (`618651` SC-1234-001, `618665` SC-1234-004), both status Draft, both
`vendor.id: 3739392`. Calling `procoreFindCommitmentForInvoice_(362778, 'DGM Services Limited')` today
correctly hits the ambiguous branch and refuses to pick, listing both.

**What "ambiguous" does today vs. what's still open:** the matcher's current behavior is to refuse
with a reason (`{matched: false, reason: "...Ambiguous..."}`) — there is no dashboard UI yet that shows
the two candidates and lets a human pick one. Ahmed described that UI ("if multiple commitments, let
the user pick; if only one, assign directly") but the request was interrupted/disregarded before
scoping it — it's real PR 2/3 work, not done. The fixture above exists so whoever builds that picker
has a real ambiguous case to develop against, not just a mock.

**Update, same session — the picker got built.** Ahmed asked directly ("build it now") right after the
fixture above went in, so it's no longer "still open":

- `procoreFindCommitmentForInvoice_`'s ambiguous branch (`ProcoreClient.gs`) now also returns a
  `candidates` array (`commitmentId`/`commitmentTitle`/`commitmentNumber`/`commitmentKind`/`vendorName`
  per row) alongside the existing `reason` sentence — additive only, every prior caller/test that reads
  `matched`/`reason` is unaffected. `procoreFindCommitmentForInvoiceRow_` forwards it when the failure
  is at the commitment stage; it's `undefined` (not an empty array) on every other failure, so a caller
  can tell "ambiguous, here's the list" apart from "no match at all" with one truthy check.
- **New file, `ProcoreSend.gs`** — the workflow layer `ProcoreClient.gs`'s own header comment has
  referenced since before this file existed ("a structural analogue of NexusSync.gs"). Holds
  `procoreLoadInvoiceRowForMatch_` (Row ID → vendor/project number, header-keyed like every other sheet
  read here) and the dashboard entry point `matchInvoiceToProcoreCommitment(rowId)` — gated the same as
  the Procore smoke test (`canControlAutomation_` + `procoreConfigured_`), and just as READ-ONLY: it
  resolves the match and returns it, it does not write to the Invoice Log or create anything in Procore.
  That's still PR 3.
- **Dashboard UI** (`Dashboard.html`, preview panel, right under "Send test to Procore…", same
  `canControl && procoreConfigured` gate): a "Match to Procore commitment…" button. One commitment
  candidate → shows it directly ("Matched to ... on ..."). More than one → renders a pick-one list of
  buttons, one per candidate; clicking one shows "Selected: ..." with an explicit note that the real
  send feature doesn't exist yet, so picking only confirms the choice on screen — it is not wired to
  write anything anywhere, on purpose, matching this file's "matching only" scope for now. Zero
  candidates, or the project itself not resolving → the matcher's own reason string, verbatim.
- Unit-tested (20 more assertions, same mocked-`procoreFetch_` + mocked-`SpreadsheetApp` pattern) using
  the REAL current sandbox state as the fixture: DGM Services Limited's two live commitments (618651,
  618665) come back as two candidates from `procoreFindCommitmentForInvoice_` and propagate through
  `procoreFindCommitmentForInvoiceRow_` and the `matchInvoiceToProcoreCommitment` endpoint intact, while
  Copp's Buildall (still exactly one commitment) auto-matches through the same endpoint end to end, and
  the permission gate throws before ever touching the mocked sheet when `canControlAutomation_` is
  false. Not yet exercised by an actual click in a live dashboard — same caveat as the original Procore
  smoke test button had before Ahmed clicked it.

**Update, same session, immediately after — Ahmed: "dont half ass it i want the shit built."** The
picker above only confirmed a pick on screen; nothing persisted and nothing actually sent. That's now
built too — real persistence and a real send, not another smoke test:

- **Two new tabs**, same crosswalk/audit-log shape as the Nexus tabs (`Config.gs`):
  - `Procore Commitment Map` (`PROCORE_COMMITMENT_MAP_COLUMNS`) — the learned crosswalk. Keyed on
    normalized Vendor + normalized Project Number (`procoreCommitmentMapKey_`, `ProcoreSend.gs`, same
    `vendorNormalizedKey_`/`normalizeNumberKey_` the live matchers use, so a cache hit and a fresh live
    match always agree). One row per confirmed vendor+project → commitment pairing, appended (never
    edited in place) by `procoreSaveCommitmentMatch_`.
  - `Procore Send Log` (`PROCORE_SEND_LOG_COLUMNS`) — one row per actual send: who, when, which
    requisition id, whether the PDF attached, which environment (sandbox/production). The "why is this
    In Procore" answer months later, same role `Nexus Sync Log` plays for Nexus.
- **`matchInvoiceToProcoreCommitment` now checks the crosswalk FIRST** — a previously confirmed
  vendor+project resolves instantly with zero Procore calls (`fromCache: true` in the response). On a
  fresh, unambiguous match (exactly one candidate) it now **saves immediately** — "if only 1, assign
  directly" means exactly that, nothing left to confirm. An ambiguous result is still left unsaved.
- **New endpoint, `confirmProcoreCommitmentPick(rowId, candidate, projectId, projectName)`** — saves a
  human's pick from the ambiguous list exactly as permanently as an auto-match. `procoreFindCommitmentForInvoiceRow_`
  was extended to expose `projectId`/`projectName` even on a commitment-stage failure, specifically so
  the dashboard can pass them back here without a second project lookup.
- **New endpoint, `sendInvoiceToProcore(rowId)` — the actual send.** Requires a confirmed crosswalk
  entry to already exist (it does not match on the fly — a send can never silently invent which
  commitment to use). In order: `procoreCreateSubcontractorInvoice_` (`POST requisitions`, finding 2's
  documented body shape) → **write the Procore Send Log row immediately** (HANDOFF §4's design point:
  create → log → attach → status, never batched, so a mid-run failure still leaves a findable record
  of what was created) → attach the PDF via the two-step upload (`procoreUploadFile_`) +
  `procoreAttachFileToRequisition_` (new — `PATCH requisitions/{id}` with `{requisition:
  {prostore_file_ids: [uuid]}}`) → flip the log row's own `Attached` cell to Yes in place (not a second
  row) → `updateInvoiceRow(rowId, {status: STORED_PROCESSED_STATUS})`, the single write path, never a
  literal `'Captured'` typed here. An attach failure does **not** roll back the create or the status
  flip — the created record is real and findable via the log; the message says exactly what didn't
  attach, matching `testProcoreSendDirectCost`'s same create-then-attach split. Refuses `Duplicate` and
  `Not an Invoice` rows before ever calling Procore.
- **Dashboard UI**: the picker's "Selected: ..." text-only confirmation is gone. Picking a candidate
  now calls `confirmProcoreCommitmentPick` for real (shows "Confirming…" then "✓ Confirmed: ... —
  Remembered for future invoices"); either an auto-match or a confirmed pick now reveals a **"Send to
  Procore"** button, which calls `sendInvoiceToProcore` and shows Procore's own success/error message.
- Unit-tested (43 assertions, `ProcoreSend.gs`'s full pipeline against an in-memory multi-sheet
  spreadsheet mock — not just a single-sheet mock, since this now reads/writes three different tabs in
  one flow): cache-first matching, auto-save-on-single-candidate, ambiguous-stays-unsaved,
  confirm-a-pick persists it, a send with no confirmed match refuses with a clear message, the full
  happy path (create → log → attach → status flip, exactly one send-log row with `Attached` flipped in
  place, not two), a create-succeeds-attach-fails path (status still flips, log correctly shows
  `Attached: No`), Duplicate/Not-an-Invoice refusal before any Procore call, and the permission gate on
  all three entry points. **Two real bugs were caught by writing these tests**, not found by inspection:
  a broken `procoreLogSendRow_(Object.assign({}, arguments[0], {}))` call that would have silently
  appended a second, garbage send-log row on every successful attach (now `procoreMarkSendRowAttached_`
  flips one cell in place instead), and nothing else — the rest of the design held up first try.

**What's genuinely NOT verified, and why — read this before trusting a live send.** The create call
itself (`create_subcontractor_invoice_draft` via the Procore MCP connector, tried directly against the
sandbox to observe the real request/response shape and to finally settle finding 3/the notification
question) was **blocked by this session's own permission classifier** — a different, stricter gate than
the one that allowed company/commitment creation earlier in this same session; the tool call returned
"Permission for this action was denied by the Claude Code auto mode classifier," and per this
environment's own instructions that denial was not retried or worked around. So:
- `procoreCreateSubcontractorInvoice_`'s body shape follows finding 2 exactly, `procoreAttachFileToRequisition_`'s
  `prostore_file_ids` field follows `procoreUploadFile_`'s own pre-existing doc comment — both are the
  best-documented guess, **neither has executed against a live Procore response**.
  `procoreCreateSubcontractorInvoice_` defensively sends `project_id` in both the query string and the
  JSON body since which one Procore actually reads was exactly what the blocked call would have shown.
- **The notification question (§3) is STILL open.** Nothing in this session proved or disproved whether
  creating a requisition emails a subcontractor — the one test that would have (create in sandbox
  against a dummy vendor with a placeholder email, then check `email_communications` for that topic)
  is the same blocked action.
- **Ask Ahmed to grant this specific permission (or run one live send himself) before relying on this
  for anything beyond code review.** If the first live `sendInvoiceToProcore` 4xxs, treat the response
  body as the authoritative correction to finding 2/4's documented shape, not a bug in this code — that
  is exactly the scenario every comment above already anticipates.

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

**Update, same session, right after — Ahmed hit the OLD "Send test to Procore" panel live** (it's on
`main`, this PR wasn't merged yet) and flagged three things: it still asks for a manual Procore project
ID, the Send button needs scrolling to reach, and there's too much explanatory text in the way. All
three are inherent to that panel's own design (a deliberate manual-entry smoke test, see its own PR 1.5
doc comment) and are now moot rather than fixed in place: **the old panel is removed.**
`testProcoreSendDirectCost` (Setup.gs) still exists and still runs from the editor for diagnostics —
its doc comment now says so explicitly — but its dashboard button, form, and JS wiring are gone from
`Dashboard.html`. The real matcher+send panel (`procoreMatchBlock`) is now the ONLY Procore UI in the
preview modal, and was trimmed at the same time: the descriptive paragraphs above the Matching state
and above the Send button both moved into HTML comments (developer-only context) instead of
user-visible text, so there's meaningfully less to scroll past to reach the Send button. **This still
does not put the new panel in front of a coordinator** — none of it is on `main` yet, only in this PR's
branch. Ahmed was testing against the deployed (old) dashboard because that's the only thing actually
live; merging this PR and letting the deploy workflow run is what makes any of this visible at all.

---

## 9. Immediate next steps for whoever picks this up

Items 1–3 (below, historical) are **done** — see the rewritten §8 for what actually happened, the new
vendor-ID-split finding, and how the matcher was tested. What's left:

1. **Get explicit permission for (or manually run) the one blocked action, then run a real
   `sendInvoiceToProcore` end to end.** This is now the single highest-value next step — everything
   else in the pipeline (match, cache, pick, confirm, create, attach, log, status flip) is built and
   unit-tested; only the live create call itself is unproven, and only because this session's own
   permission classifier refused it (see §8's last update). Whoever picks this up: ask Ahmed to grant
   it, or run `sendInvoiceToProcore` for one of the three matched sandbox vendors (Copp's Buildall is
   the clean single-commitment case to start with) directly from the dashboard, and treat any 4xx
   response body as ground truth for correcting `procoreCreateSubcontractorInvoice_`/
   `procoreAttachFileToRequisition_`'s documented-but-unverified shapes. **This is also the test that
   finally settles the notification question (§3)** — check `email_communications` for the created
   requisition's topic afterward, exactly as the integration repo's session proposed.
   **Update, §11: this ran, live, for real, from the dashboard.** Got a real, informative `400` — the
   project needs an open billing period — not the notification-question answer yet, since no requisition
   was actually created. Ahmed is opening a billing period himself; re-run once that's done. The
   notification question is still open.
2. **PR 2's real shape is now fully built, not just clearer.** The matcher
   (`procoreFindCommitmentForInvoiceRow_`, chaining `procoreFindProjectByNumber_` →
   `procoreFindCommitmentForInvoice_`), the "human picks when ambiguous" UI, AND the crosswalk
   persistence (`Procore Commitment Map` tab, `confirmProcoreCommitmentPick`) all exist and are wired
   together — PR 2 no longer needs to build vendor/project/commitment matching OR the "remember it"
   table from scratch. What PR 2's plan still adds on top: a dedicated management UI for the crosswalk
   (view/edit/delete a saved pairing, the way "Manage hints" does for aliases) — today the only way to
   change a saved pairing is editing the `Procore Commitment Map` tab by hand. Re-read the plan file
   (§1 table) with that in mind before starting PR 2; several of its steps are already redundant.
3. **Get a real WCM project number into the sandbox and re-test live** — the one real gap called out
   in §8: no real WCM project number (43, 49, 6, 45, 46) exists as a Procore `project_number` yet,
   because there's no create/update-project tool on the current MCP surface. Ask Ahmed to number an
   existing sandbox project by hand (or widen the tool surface), then re-run
   `procoreFindProjectByNumber_`/`procoreFindCommitmentForInvoiceRow_` against it — the code and its
   leading-zero handling are already unit-tested, this closes the live-proof gap, not a code gap.
4. **The three dummy commitments (four, counting DGM's second) are sandbox-only test fixtures**, not
   real WCM data — they exist so the matcher had something real to run against, not because
   DGM/Copp's/OUTER actually have subcontracts on "Sandbox Test Project" (project `362778`, a generic
   Procore demo project, not a real WCM job). Don't reuse commitment IDs 618651–618653/618665 for
   anything beyond matcher testing, and don't be surprised the project name doesn't match a real WCM
   address — sandbox company `4288787` only has two projects total (`362778` "Sandbox Test Project",
   `362775` "Standard Project Template"), neither WCM-specific.
5. **`purchase_order_contracts` matching is still unproven against a live record** (no PO exists in this
   sandbox project) — settle it whenever a real or dummy PO becomes available, same discipline as
   everything else in this file.
6. **Ask Ahmed whether Nexus apply has been tested yet** (§1) — still unconfirmed, unrelated to
   Procore, cheap to check.
7. Dashboard load time (§6) — unrelated to Procore, still open, options given to Ahmed but never
   acted on. Resurfaces if he brings it up; not urgent otherwise.

---

## 10. Follow-up, same day, after PR #98 merged — UX cleanup, idempotency, and bulk send

PR #98 merged and deployed. Ahmed then actually used the live dashboard against a real Paid invoice
(OUTER CONSTRUCTION, invoice 1163 REV, WCM project "06 - FOREST EDGE CMNS. - 952 SOUTHDALE", no
subproject set) — **this is the first real evidence the matcher runs live, end to end, from the
dashboard, not just from a script.** It correctly reached `procoreFindProjectByNumber_` and reported
*"No Procore project with project number "6" (checked 2 project(s) in the company)"* — exactly the gap
§9 item 3 already documented (sandbox only has two generic projects, neither numbered like a real WCM
project). Good news wrapped in an expected failure: the plumbing works: the button, the server call,
the project lookup, the error surfaced back to the UI, all real. **§9 item 3 is now confirmed, not just
theorized — get a real WCM project number into the sandbox to actually finish proving the chain.**

He also asked for three concrete changes, done in this follow-up (same PR-restart, since #98 was
already merged — see the note at the top of this file about restarting from `origin/main` after a
merge):

1. **Renamed the entry-point button** from "Match to Procore commitment…" to **"Send to Procore…"**
   (`Dashboard.html`, `#procoreMatchBtn`) — Ahmed read "Match" as a separate, confusing step from
   "Send". No behavior change: it still runs `matchInvoiceToProcoreCommitment` first and only shows the
   Send button once a commitment is confirmed (auto or picked) — matching is a real prerequisite, not
   busywork, so it stays a two-click flow (open the panel, then Send), just under one label that says
   what it's actually for.

2. **Idempotency guard, because bulk send made a latent gap into a real risk.**
   `sendInvoiceToProcore` had no check for "was this row already sent" — nothing stopped a double-click,
   or the same row appearing in two bulk selections, from creating a SECOND Subcontractor Invoice in
   Procore for one WCM invoice. Low-probability for a single-invoice button, much less so once bulk
   send existed. `procoreFindExistingSend_` (`ProcoreSend.gs`) checks the Procore Send Log for a prior
   entry for this Row ID **in the current environment** (`procoreEnv_()` — scoped so a sandbox test send
   never blocks a later real production send of the same row, or vice versa) and, if found, returns
   `{ok: true, alreadySent: true, requisitionId: <the original one>, ...}` instead of creating a
   duplicate. `sendInvoiceToProcore`'s own return now includes `row` (the direct return value of
   `updateInvoiceRow`) so a caller can patch its local state from real data — see point 3's note on the
   stored-vs-displayed trap.

3. **Bulk "Send to Procore"**, in the multi-select bulk bar (`#bulkProcoreSendBtn`, next to Download) —
   Ahmed: *"add the function in multi select. So i can select from a filtered list and send all to
   procore."* `sendInvoicesToProcoreBulk(rowIds)` (`ProcoreSend.gs`):
   - Per row: skip the same statuses `sendInvoiceToProcore` itself refuses (Duplicate, Not an Invoice)
     — reported as `skipped`, not an error, since a filtered multi-select naturally contains ineligible
     rows sometimes. Otherwise run `matchInvoiceToProcoreCommitment` (cached instantly for a
     vendor+project pair confirmed before); an ambiguous or unmatched vendor is reported under
     `needsMatch` and **never auto-picked** — same "let user pick" rule as the single-invoice flow, it
     just means resolving it happens from that invoice's own preview panel afterward, not that the
     whole batch blocks on it. Everything else actually sends, landing in `sent` (or `alreadySent` via
     the guard above).
   - **Capped at `PROCORE_SEND_BULK_MAX_` = 25**, refused outright (not silently truncated) above that —
     each row is a handful of real Procore HTTP calls (list/create/upload/attach), not a cheap file
     copy like `downloadInvoicesZip`'s per-file base64 read, so the cap is much lower than
     `DOWNLOAD_MAX_FILES` (100) on purpose. **Not load-tested against real Procore latency** — the
     number is a reasoned guess (25 rows × ~4 calls ≈ 100 calls should fit Apps Script's ~6-minute
     execution limit with normal retry behavior), not a measurement. If it turns out too high in
     practice, lower it; if consistently too low, that's when a resumable multi-call design (like the
     Nexus apply loop) actually earns its complexity — don't build that ahead of evidence it's needed.
   - **Time-budgeted** (`PROCORE_SEND_BULK_TIME_BUDGET_MS_` = 4.5 min): stops starting new rows once
     elapsed time passes the budget and reports the untried ones in `remaining`, rather than risking
     Apps Script's own kill cutting a send off mid-create. No silent drops — `remaining` names exactly
     which Row IDs weren't attempted, same "no silent caps" principle as `downloadInvoicesZip`'s skip
     count.
   - Dashboard renders per-bucket results (Sent / Already sent / Needs a manual pick / Skipped / Failed
     / Not attempted) in a scrollable list, `#procoreBulkModalOverlay`. **Patches `ALL_RECORDS` from
     each sent row's real `row` object** (from `sendInvoiceToProcore`'s return, itself
     `updateInvoiceRow`'s return), the same pattern `markDownloadedCaptured` already uses — deliberately
     NOT a hardcoded `'In Procore'` string, because that's exactly the stored-vs-displayed mixup
     CLAUDE.md already calls out as the bug to watch for with this status.

Unit-tested (test harness extended, not rewritten — same extract-and-eval pattern, mocked
`procoreFetch_`/`SpreadsheetApp`): the idempotency guard (send twice, exactly one requisition POST and
one send-log row across both calls), bulk routing (mixed eligible/ambiguous/Duplicate/unmatched
selection lands in the right buckets), re-running a bulk batch reports `alreadySent` instead of
re-sending, the batch-size cap refuses outright with nothing attempted, and the time budget reports
every unattempted row in `remaining` rather than dropping them silently. All existing matcher/send tests
(72 assertions total in the extended file) still pass unchanged — this was additive, not a rewrite of
the matching logic itself.

**Ahmed's fourth point, resolved — §9 item 3 is DONE, a real WCM project number now exists in the
sandbox.** His cut-off message turned out to mean: DGM Services Limited, Copp's Buildall, and OUTER
CONSTRUCTION's test invoices (the same three from §8) all genuinely belong to WCM project **"6.4"**, not
the mix of "43 Hyland Centre"/"6 Forest Edge Cmns" this file recorded in §8 — that earlier record was
wrong; trust this correction over it. There is still no create/update-project tool on the Procore MCP
surface (checked again this session — the 44 available tools cover companies, contacts, commitments,
direct costs, RFIs and uploads, but nothing for projects), so Ahmed made the change by hand in Procore's
UI: project `362778`'s `project_number` is now **`"06.4"`** (his own leading-zero convention, matching
the commitment-number scheme below), confirmed live via `list_projects` immediately after.

**A real gotcha surfaced, and the actual root cause turned out to be a genuine design gap, not a
one-off data mixup.** `normalizeNumberKey_` only strips a LEADING run of zeros — it never merges `"6"`
and `"6.4"` into one key. The first live test (§10 above) hit `project number "6"` in its error. Ahmed
then confirmed the real structure from the dashboard's own Project/Subproject dropdowns on that
invoice: WCM Project Number is **`"06"`** (bare — Forest Edge Commons, the whole property) and
Subproject Number is **`"6.4"`** (already the full dotted form, not a bare child digit — a specific
building/phase, "CRU3 PH2"). Procore's project was renamed to `"06.4"`, i.e. numbered at the
**subproject** grain — but `procoreFindProjectByNumber_` only ever compared against bare Project
Number (`"06"` → `"6"`), so it would have kept failing (`"6"` ≠ `"6.4"`) no matter how carefully the
Procore side was set, until the code itself changed.

**Fixed, not just documented.** `procoreProjectMatchKey_` (`ProcoreSend.gs`) now resolves the identifier
actually used for Procore project matching as: Subproject Number when the invoice has one, else the
bare Project Number. Safe as a preference (not a separate new matching mode) specifically because this
system's Subproject Number is always the full dotted form already — a subproject value is strictly MORE
specific than the bare project number, never a different, unrelated one. Threaded through all three
entry points (`matchInvoiceToProcoreCommitment`, `confirmProcoreCommitmentPick`,
`sendInvoiceToProcore`) and the crosswalk key itself (`procoreCommitmentMapKey_`'s "Project Number"
input), so a match, a human's pick, a cache hit, and a send all resolve at the exact same grain — a
send can never miss the cache the match that confirmed it just wrote. Unit-tested (3 new cases, 83
assertions total in the extended harness): OUTER CONSTRUCTION's real shape (Project `"06"` + Subproject
`"6.4"` → resolves to the project numbered `"06.4"`, not the one numbered `"1234"`), the fallback case
(no subproject set → bare Project Number, unchanged from before), and that `sendInvoiceToProcore`'s
crosswalk lookup uses the identical key a prior `matchInvoiceToProcoreCommitment` call just saved.

**Lesson for whoever hits a "still doesn't match" report on a project+subproject pairing in the
future:** check the LIVE error message's exact quoted project number against the sheet — a Project
dropdown reading "06 - Forest Edge Cmns" and a Subproject dropdown reading "6.4 - ..." are two SEPARATE
cells, and which one the matcher actually reads depends on `procoreProjectMatchKey_`'s stated
preference, not on what looks most "correct" from the dropdowns alone.

**Still open:** the commitment RENUMBERING half of Ahmed's original ask (`SC-1234-00#` → `SC-06.4-00#`
for all four: 618651, 618652, 618653, 618665) was never confirmed done — only the project number update
was. Same tool gap applies (no edit-commitment tool); it's a manual Procore UI edit, cosmetic only (the
matcher never reads a commitment's `number` field, only `vendor`/`id`/`title`/`kind` — see
`procoreListCommitmentResource_`, `ProcoreClient.gs`), so it doesn't block testing `sendInvoiceToProcore`
for real, just tidiness.

---

## 11. The live requisition test finally ran — real 4xx, real information, plus Direct Cost as a
## first-class send path

Ahmed selected 3 real Paid invoices (OUTER CONSTRUCTION ×2, CROSSROADS C & I ×1) and ran the bulk send
for real, live, from the deployed dashboard. Results:

- **CROSSROADS C & I** — `needsMatch`: no commitment existed for this vendor at all. Expected, not a bug.
- **OUTER CONSTRUCTION ×2** — both got a real `400` from `POST requisitions?project_id=362778`:
  `{"errors":"The project must have an open billing period (or admin can specify a period_id) to create
  an invoice"}`. **This is new, load-bearing information** — Procore's Subcontractor Invoice create
  needs an open billing period on the project (or an explicit `period_id`), something no amount of
  reading the OAS schema surfaced ahead of a live call. Ahmed is opening a billing period on the sandbox
  project himself; no code change was made for this specific gap. Whoever next runs a live
  `kind: 'invoice'` send should expect this to now succeed, or to fail differently if the period still
  isn't open — either way it's informative, per this file's own standing advice for the first live call.

**Ahmed's response to hitting both gaps at once: build a Direct Cost option as a genuine alternative to
a Subcontractor Invoice, chosen per invoice, not a fallback baked into the invoice path.** His exact
ask: *"give a window showing what is selected, and a selector next to it to specify each as invoice or
as direct cost. I selected 3, 2 goes into invoice, 1 should go into direct cost."* Direct Cost doesn't
need a commitment OR a billing period — it's the create call already proven working back in PR 1.5
(`testProcoreSendDirectCost`), which is exactly why it's a real answer to both gaps at once, not a
workaround for one.

**Built:**
- `procoreCreateDirectCost_` / `procoreAttachFileToDirectCost_` (`ProcoreClient.gs`) — the PR 1.5 smoke
  test's exact proven call, extracted into the client so the real send flow can use it as a first-class
  path instead of a one-off diagnostic.
- `sendInvoiceToProcore(rowId, kind)` (`ProcoreSend.gs`) now takes a `kind` — `'invoice'` (default,
  unchanged behavior: requires a confirmed commitment match already in the crosswalk) or
  `'direct_cost'` (resolves project + vendor live on every call, no commitment or prior matching step
  needed — nothing to cache since there's no "pick one" ambiguity to persist the way a commitment has).
  The idempotency guard (`procoreFindExistingSend_`) blocks a resend REGARDLESS of which kind either
  send used — sending the same invoice as both an Invoice and a Direct Cost would still double-count it
  in Procore, so "already sent" is kind-agnostic on purpose.
- `sendInvoicesToProcoreBulk(items)` — signature changed from a bare Row ID array to
  `[{rowId, kind}, ...]`; each item carries its own kind, per Ahmed's own framing ("2 goes into invoice,
  1 goes into direct cost" — a per-invoice choice, never a single choice for the whole batch). A
  `kind: 'invoice'` item still goes through the existing match-then-send flow (ambiguous → `needsMatch`,
  never auto-picked); a `kind: 'direct_cost'` item skips matching entirely — a vendor-match failure
  there lands in `errors`, since there's no picker UI for that case in bulk.
- **Procore Send Log gained two columns** (`Config.gs`): `Record Type` (`'Subcontractor Invoice'` or
  `'Direct Cost'`) and a renamed `Procore Record ID` (was `Requisition ID` — renamed the same day, before
  this sheet had ever held a real data row, so nothing needed migrating; it now holds a requisition id
  for one Record Type and a direct cost id for the other without the column name assuming which).
- **Dashboard** (`Dashboard.html`): the bulk "Send to Procore" flow is now a REVIEW step first — one row
  per selected invoice (vendor, invoice #, amount) with its OWN Subcontractor Invoice / Direct Cost
  `<select>`, defaulting to Subcontractor Invoice. Confirming reads each row's choice
  (`procoreBulkReviewItems()`) and sends accordingly. The single-invoice "Send to Procore…" panel is
  UNCHANGED — still `kind: 'invoice'` only; nobody asked for a per-invoice type choice there and the
  bulk review window is where Ahmed actually wanted it.

Unit-tested (27 new assertions, 101 total in the extended harness): a Direct Cost send with no
commitment succeeding end to end (create, attach, log with the right Record Type, status flip), a
Direct Cost send refusing cleanly when the vendor genuinely isn't in Procore, the idempotency guard
blocking a resend across DIFFERENT kinds (send as invoice, then try again as direct_cost — blocked, no
second Procore call), and bulk send routing two different rows to two different kinds correctly in one
call, each logged with its own Record Type.

**Also done, same session, directly in Procore (Ahmed asked for this too):**
- **New company: CROSSROADS C & I** (company id `3739564`, project-scoped vendor id `3739565`) — the
  vendor from the third test invoice, which had no company/commitment/anything until now.
- **New commitment**: `618715` (`SC-1234-005`, Draft) for CROSSROADS C & I — same "matcher test
  subcontract" pattern as the other four, gives it something to resolve against for a `kind: 'invoice'`
  test later (a `kind: 'direct_cost'` send doesn't need this at all, which is exactly why one was sent
  that way live already).
- **One contact per company, added to the project as External Contractor**: Dana Morrison (DGM),
  Cody Popp (Copp's), Owen Turner (OUTER), Casey Ingram (CROSSROADS) — contact ids
  466483–466486. All under `@example.com` (IANA-reserved documentation domain, no real inbox) —
  `create_contact`'s own tool description warns Procore may auto-email an invitation with no way to
  suppress it, so a domain guaranteed to have no real recipient is the only safe choice for dummy
  contacts. `role: 'subcontractor'` was used for "external contractor" — the MCP tool's own description
  lists "contractor" as a synonym for that category, so this needed no guessing. Two of the four
  `add_contact_to_project` calls hit transient network errors (502, connection timeout) on the first
  attempt; both succeeded on retry — not a capability gap, just flaky infrastructure that day.
- **Confirmed gap, not fixed: Ahmed also asked for dummy Commitment SOV (SCHEDULE OF VALUES) line
  items, so the commitments have an actual dollar value** (all four sit at `grand_total: "0.0"` right
  now). Checked thoroughly: Procore's REST API DOES have a documented line-item resource
  (`work_order_contracts/{id}/line_items` exists per `search_procore_api`), but there is no tool on this
  MCP surface that can create or edit one — same shape as the missing project-rename/commitment-rename
  gaps already documented above. `procore_get` is explicitly read-only and cannot be used to work around
  this. **Needs either a Procore admin adding line items by hand (Commitments → contract → Schedule of
  Values → add line item) or a widened tool surface** — not something to attempt via workarounds.

---

## 12. Live sends unblocked; a confirmed attachment bug; the "Sending…" freeze fixed with a decoupled
## status confirmation

Standing instruction from this point on, confirmed explicitly by Ahmed: **this Claude session never
builds or patches the Procore MCP connector's own tools.** When a capability gap needs MCP-side work
(a new tool, a fix to an existing one), the move is to draft a handoff prompt for Ahmed to relay to
that other session — not to attempt it here. Several items below followed that pattern.

**§11's open items got resolved, mostly outside this repo:**
- The **open-billing-period** blocker (§11) — Ahmed opened one on the sandbox project himself.
- The **SOV-must-be-approved** blocker (discovered live, not previously documented) — the other
  session shipped `set_subcontractor_sov_status` in response to a drafted handoff; Ahmed approved all
  five commitments.
- **Dummy SOV line items** (§11's last item, "confirmed gap, not fixed") — now fixed: the other
  session shipped `add_commitment_line_item`/`find_cost_codes`, used here to add a line item per
  commitment matching each real invoice's dollar amount, resolved via `procoreProjectMatchKey_`'s same
  Subproject-Number-first rule everything else here uses. (One cosmetic side-effect: every commitment's
  `grand_total` briefly read 2x expected — traced to the OTHER session adding its own verification line
  item while testing/deploying `set_subcontractor_sov_status`; harmless, not a bug in this repo's work.)
- **CROSSROADS C & I duplicate vendor** — two company-directory records existed for the same vendor,
  which is exactly the ambiguity `procoreFindVendorByName_` is supposed to refuse rather than guess.
  Ahmed fixed it by hand in Procore's UI (Directory → Companies).

**Confirmed, live, real bug — FIXED AND NOW VERIFIED LIVE (2026-08-21):
`procoreAttachFileToRequisition_` did not actually attach the PDF.** The `PATCH requisitions/{id}?project_id={id}`
call with `{"requisition":{"prostore_file_ids":[uuid]}}` returned success, and `sendInvoiceToProcore`
recorded `attached: true` — but a live check (`GET requisitions/181185`) came back `"attachments": []`.
The doc comment on that function had said "genuinely unconfirmed against a live requisition" since it
was written; that live check was the confirmation, and it was negative. No generic write tool existed on
the Procore MCP surface at the time to experimentally probe the correct request shape (only
`procore_get`/`search_procore_api`, both read-only), so per the standing instruction above, a handoff was
drafted for the other session to fix rather than attempted here.

**The other session relayed a schema read back**: `prostore_file_ids` takes integers (existing Prostore
File IDs), not the upload UUID `procoreUploadFile_`'s two-step upload actually produces — explaining the
silent no-op exactly. The correct field is `upload_ids` (an array of upload UUID strings, the same UUIDs
already in hand). One part of that relay didn't hold up when checked against this repo's own code,
though: it said the old field "only exists on v1.0, which has no UUID field at all," implying the PATCH
was hitting v1.0 — but `CONFIG.PROCORE_RESOURCE_VERSIONS` already routes `requisitions` to `/rest/v1.1/...`
and always has; `search_procore_api` also confirms `/rest/v1.1/requisitions/{id}` has a `patch` verb.
The version was never the problem, only the field name was — worth flagging since the rest of the relay
was accurate. **Fixed** (`ProcoreClient.gs`): the payload is now `{requisition: {upload_ids: [uuid]}}`.
Unit-tested (new assertion in the extended harness) that the outgoing PATCH body carries `upload_ids`,
not `prostore_file_ids`.

**VERIFIED LIVE, same day.** Ahmed sent real invoices through after the fix deployed; `GET
requisitions/181205` and `181206` (project 362778) both come back with a populated `attachments` array —
and the attached filenames (`260721 - 1163 REV - OUTER CONSTRUCTION.pdf`,
`260721 - 1176 - OUTER CONSTRUCTION.pdf`) are this system's own `YYMMDD - Inv# - Vendor.pdf` naming
format, so they are unambiguously our uploads and not something attached by hand in the UI. `upload_ids`
is therefore the correct field, confirmed end to end: two-step upload → UUID → PATCH → real attachment.
The earlier "don't trust `attached: true`" warning is retired; it is now backed by evidence. Direct Cost attachment
(`procoreAttachFileToDirectCost_`, raw multipart) is a separate code path and was never implicated by
this finding.

### The idempotency guard now confirms live against Procore, not just our own log

Ahmed, testing again: deleted the test requisitions/direct costs directly in Procore to re-run a send,
and got refused with "already sent" anyway. His diagnosis was exactly right: *"I think it looks at a
log and decides if the invoice is there or not, which is weak."* `procoreFindExistingSend_` only ever
proved the **Procore Send Log** tab said a row was sent — it had no way to notice the record got deleted
in Procore afterward, so a legitimate resend (very much a real scenario during sandbox testing, and
plausible in production too if someone deletes a bad record in Procore directly) was blocked forever.

**Fixed, not just documented — but deliberately NOT the vendor+amount+project search Ahmed proposed.**
That would trade one weak check for another: NexusSync.gs's own hard-won findings in this same file
document that vendor+amount matching without an id is genuinely non-unique in real data (11% of the
time in the real 21k-row export). We already have the exact Procore record id our own prior send
created, sitting right there in the log — confirming BY ID is simpler and actually authoritative, no
fuzzy matching required. New: `procoreRequisitionExists_`/`procoreDirectCostExists_` (`ProcoreClient.gs`)
— a single-item `GET` by id, dispatched from a new `procoreConfirmExistingSendStillExists_`
(`ProcoreSend.gs`) based on the logged Record Type. `sendInvoiceToProcore`'s existing-send check now
reads: found in the log AND still confirmed present in Procore → `alreadySent` as before; found in the
log but Procore 404s → fall through and create a fresh record (the stale log row stays as history, the
new send appends its own row, so the trail shows both). Fails SAFE toward "still exists" — blocking a
resend — on anything inconclusive: a missing Project ID on an older log row, an unrecognized Record
Type, or any Procore response other than a clean 200 or a clean 404 (a 403, a 401, an exhausted-retry
5xx) is never silently read as "gone," because guessing wrong there risks a silently duplicated
financial record, which is worse than blocking a resend for a moment.

Unit-tested (extended harness, 120 assertions total): a row whose logged requisition Procore has since
404'd is allowed to resend and creates a genuinely new record (exactly one live existence-check GET
made, exactly on the resend); the same guard still correctly blocks a resend when Procore genuinely
still has the record (no duplicate POST); the same fix proven on the Direct Cost side too; and
`procoreConfirmExistingSendStillExists_` fails safe to "still exists" when the logged row is missing a
Project ID, a Requisition ID, or carries an unrecognized Record Type.

**Three incidental findings from reading those two live requisitions, worth knowing before the next
round of Procore work:**
- **Retainage is still 0.00 on both** (`completed_work_retainage_percent`/`amount`) — as expected, since
  nothing fills it yet; this is the open MCP-side work below, not a regression.
- **Requisition 181206 DOES carry real billing figures** — `percent_complete: 7.50%`,
  `total_completed_and_stored_to_date: 3980.25` against `original_contract_sum: 53078.40`. Filled by a
  person or the MCP session, not by this repo. Useful as a worked example of the arithmetic the Path 1
  tool has to reproduce, on real data.
- **Procore chains requisitions on a commitment via `previous_requisition_id`** (181206 points back at
  181205). That is the cumulative-billing mechanism the domain-reasoning section above describes, visible
  in the API: it is why "sum every prior requisition on this commitment" is a real lookup the MCP side can
  perform, and why one SOV line billed repeatedly stays unambiguous.
- **The sandbox project's currency is USD** (`currency_configuration.currency_iso_code`) while WCM's
  invoices are CAD. Harmless in a generic Procore demo project, but worth checking on the first REAL
  production project: this repo sends bare amounts with no currency field, so a project configured in the
  wrong currency would silently reinterpret every figure. Not a bug found, a trap to check for.

**Billing % fields, revisited 2026-08-21 — confirmed this repo genuinely cannot fill them, an MCP-side
handoff was drafted.** A real created Subcontractor Invoice's billing fields (Work Completed This Period
%, Total Completed & Stored to Date %, Work Retainage This Period %, Retainage Released %, Total
Materials Retainage %) still come back empty. Root cause, confirmed by reading our own create call:
`procoreCreateSubcontractorInvoice_` (`ProcoreClient.gs`) sends `{project_id, commitment_id, requisition:
{status, invoice_number, billing_date}}` — no dollar amount, no line item, nothing for Procore to base a
percentage on. Procore auto-generates the requisition's detail lines from the commitment's SOV and
leaves every $/% field at zero.

Ahmed asked whether Gemini (our own PDF extraction) or the Procore MCP side should be the one to decide
these. **It has to be the MCP side — not a preference, a hard constraint**: the percentage math needs
(a) the SOV line item's total scheduled value and (b) the SUM already billed on every PRIOR requisition
against that same commitment. Neither exists anywhere in the invoice PDF or in this repo's own data —
both live only in Procore. Gemini's only possible contribution is "amount billed this period," which
this repo already extracts and already has (the Amount column) — there's nothing further for it to read
off the PDF that would help, which matches what Ahmed already suspected ("the invoice format is not
suitable to read as percentage").

A concrete handoff was drafted (delivered to Ahmed to relay, per the standing "draft a handoff, don't
build for the MCP" rule) pointing at endpoints `search_procore_api` confirms exist for exactly this:
`PATCH requisitions/{requisition_id}/contract_detail_items/{id}` (one line) or
`PATCH requisitions/{requisition_id}/bulk_item_update` (all lines at once) — neither currently has a
dedicated MCP tool. Retainage rate (10%, per Ahmed) should be a parameter the tool takes, not something
hardcoded on either side. **Open question the handoff explicitly does NOT resolve — flagged back to
Ahmed instead of guessed at**: when a commitment has more than one SOV line item, which line does a
single lump invoice amount apply to? The current sandbox's dummy SOV setup (one line per commitment,
sized to match) sidesteps this; a real commitment with multiple cost-code lines would need either an
"always one line" rule or a way for the invoice to specify which cost code, and nobody has decided that
yet. Still open — this file's job is to remember that it's open, not to pick an answer nobody asked for.

### WHY the invoice-to-SOV paths are what they are — the domain reasoning, written down

**Read this before changing how an invoice maps to a commitment's SOV lines.** The three-path split
below (and in the MCP handoff) is not an arbitrary engineering compromise — it follows how construction
billing actually works. It was worked out with Ahmed in conversation and would otherwise be lost; the
next person to touch this will otherwise "simplify" it back into a guess.

**1. The Commitment SOV is the contract document. The subcontractor's invoice is a claim against it.**
When a subcontract is negotiated, the SOV attached to it (in Procore: the commitment's line items) is an
exhibit of the signed agreement. Once approved — which is the gate that made a live send fail earlier in
§12 — that structure is what the sub is contractually obligated to bill against. **Line items always
reconcile to the GC's approved commitment SOV, never to the sub's own self-reported numbers directly.**

**2. There is no second "Subcontractor SOV" object, in Procore or here.** What people colloquially call
the sub's SOV is their pay application (AIA G702/G703, or whatever format they use) — supporting
*evidence* for the percentage they're claiming, not a competing system of record. Procore tracks exactly
one authoritative SOV per commitment. This is why `is_sov_formatted`/`line_items` (GeminiService.gs)
capture what the sub *claims*, and why matching those claims to real SOV lines is a separate,
fallible step rather than a direct write.

**3. When the sub's invoice doesn't cleanly map to the GC's SOV, that is a human reconciliation step,
not a computation.** Different line descriptions, different granularity, a change order not yet
processed — a PM or cost engineer maps the claimed dollars to the correct approved line. If the sub is
billing scope that isn't on the approved SOV at all, that's a real flag (a change order is needed, or
the invoice gets held), not something to force a match on. **This is the reason Path 2 returns
unresolved instead of guessing, and Path 3 defers to manual entry entirely.** Procore's own
`create_subcontractor_invoice_draft` leaving these fields human-filled reflects the same judgment — it
is not a tooling gap to route around.

**4. One SOV line absorbing many invoices over time is the NORMAL case, not an edge case.** "Total
Completed & Stored to Date" is precisely the running sum of "Work Completed This Period" across every
prior requisition on that line, plus the current one. A $2,400 line billed $800 × 3 works identically to
a $500k structural line billed monthly for a year. **So a single-line commitment stays unambiguous no
matter how many invoices arrive against it** — which is what makes Path 1 safe to automate outright, and
answers the "which line does this belong to?" question §12 originally flagged as open, for that case.

**5. Small/simple invoices are not supposed to go through this machinery at all.** Procore's design
intent — matching Ahmed's own description of WCM's real inbox (small trades, no time to confirm SOVs) —
splits three ways, and picking the right lane matters more than better parsing:
- **Direct Costs** for PO-based/one-off work: no commitment, no SOV, no billing period, no retainage
  machinery. This repo already treats Direct Cost as a first-class send path; that decision matches
  Procore's intent rather than working around it.
- **A single-line SOV** when a small trade does get a formal commitment. Procore never required a
  detailed cost-code breakdown; a $2,400 PO can be one $2,400 line. Percent-complete on a one-visit job
  is degenerate anyway (0% or 100%), so multi-line granularity there is overhead with no information gain.
- **Multi-line SOV + progress billing** only for trades genuinely billing progressively over months.

**6. Retainage is a progress-billing convention, not a universal rule.** 10% is standard on prime
contracts and major progress-billed subcontracts; most firms do NOT hold retainage on small PO-based
service invoices, because the accounting overhead exceeds the value at that size. **This is why nothing
in this repo ever assumes a rate** — `stated_retainage_percent` captures only what the invoice printed,
and the MCP handoff insists the rate be a parameter passed per call. Whether WCM wants a blanket 10% or
a threshold is a policy call for Ahmed, still unanswered; the code must not pre-empt it by defaulting.

**The through-line, and it is the same principle this codebase already applies everywhere else** (the
commitment matcher's "never auto-pick an ambiguous vendor", NexusSync's scored-not-guessed matching, the
bulk-send `needsMatch` queue): **don't try to make every invoice machine-parseable to full precision.**
Let the unambiguous majority auto-process, and route genuine ambiguity to a fast human decision rather
than a computed guess. The fix for messy small-trade invoices is classifying them into the right lane
(Direct Cost / single-line), not parsing them harder.

### The division of labor, settled: Invoice Desk parses, Procore MCP computes and writes

Ahmed pushed for a clearer split before more got built: *"Invoice desk should start parsing Retainage,
line items, line item amount, SC, PO, or Change event / order number. And MCP builds the tools?"* — yes,
exactly that split, and it resolved a design question from the earlier back-and-forth too (whether an
AIA-formatted pay application changes what Gemini can usefully extract — it does; that invoice format
already carries the sub's own claimed percentages and line breakdown, unlike a simple lump-sum bill).

**Built here (Invoice Desk), this session — pure extraction, no computation:**
- `GeminiService.gs`: six new extracted fields, all optional, all `nullable: true` where a single
  value, empty/false where absent — the schema and prompt both say explicitly to leave them
  unset/false/empty rather than infer or default, same discipline as every other extracted field
  (project_number "UNKNOWN" over a forced guess, etc.):
  - `commitment_number` / `po_number` / `change_order_number` — captured only when the invoice
    itself prints one (e.g. "SC-1234-002", "PO# 88213", "CO #3").
  - `is_sov_formatted` — true only for a genuine AIA-style Schedule of Values / continuation sheet
    (Item No / Scheduled Value / % Complete / Retainage columns); false (the common case, especially
    for small trades) for an ordinary lump-sum invoice.
  - `stated_retainage_percent` / `stated_retainage_amount` — only what the invoice itself states
    (e.g. "Less Retainage 10%"); never a default rate assumed on Invoice Desk's side, including the
    "always 10%" Ahmed mentioned — that number belongs on the Procore side as a parameter the MCP
    tool is TOLD, not something either side hardcodes.
  - `line_items` — one entry per row of the invoice's own Schedule of Values (description, amount
    this period, % this period / to date), ONLY when `is_sov_formatted` is true. Empty array, not an
    invented single-line breakdown, for every ordinary invoice.
- New Invoice Log columns (`Config.gs` `LOG_COLUMNS`, auto-added to the live sheet the same way every
  prior column addition has been — no manual sheet edit): `Commitment Number`, `PO Number`,
  `Change Order Number`, `SOV Formatted`, `Stated Retainage %`, `Stated Retainage Amount`,
  `Line Items (JSON)` (the line-item array, serialized — Sheets has no native nested-array cell type;
  parse defensively on read, a human could hand-edit the cell). The three number-shaped ones
  (Commitment/PO/Change Order Number) are added to `LOG_TEXT_COLUMNS` — the same "06" → 6 /
  "3050-4" → date coercion trap CLAUDE.md documents for every other ID-like column applies here too.
  **Not yet surfaced in the dashboard table or preview panel** — deliberately out of scope this round
  (the table's column widths are hand-tuned to its existing 13 columns, see CLAUDE.md); the data is
  captured and queryable in the sheet, wiring it into the UI is a separate, smaller follow-up.
- **`commitment_number` is already put to use, not just stored**: `procoreFindCommitmentForInvoiceRow_`
  (`ProcoreClient.gs`) now tries a new `procoreFindCommitmentByNumber_` FIRST when the invoice stated
  one, before falling back to vendor matching. This resolves a case vendor-only matching structurally
  cannot: DGM Services Limited has two commitments on the sandbox project (an ambiguous case,
  §8/HANDOFF's original matcher tests) — a DGM invoice that states "SC-1234-004" now resolves to that
  SPECIFIC commitment with no picker involved, where vendor-only matching would (correctly) still ask a
  human. A number that matches nothing on the project falls through to vendor matching unchanged; a
  number matching MORE than one commitment (shouldn't normally happen — a data problem, not a code one)
  is surfaced as ambiguous rather than silently falling back to a different strategy that might resolve
  differently and mask it. `matchInvoiceToProcoreCommitment`'s return now carries `matchMethod`
  (`'commitment_number'` or `'vendor'`) for whichever path actually resolved it.
- PO Number and Change Order Number are captured but NOT yet wired into matching or the Direct Cost
  path — Direct Cost sends resolve vendor directly today with no commitment lookup at all, so there's
  nothing for a PO number to plug into yet. Left for whenever that need is concrete, not built ahead of it.

Unit-tested (extended harness, 129 assertions total): a stated Commitment Number resolves DGM's
otherwise-ambiguous two-commitment case to the exact one named (and the crosswalk cache remembers the
number-resolved commitment same as any other match); a Commitment Number matching nothing on the
project falls through to vendor matching unchanged (DGM is still reported ambiguous, same as before this
feature existed); and no Commitment Number at all behaves identically to every pre-existing test —
proof this is additive, not a change to the matcher's existing behavior.

**Handoff to the Procore MCP side, tightened to match exactly what's now shipping** (superseding the
earlier, more speculative draft — the field names/shapes below are real, not proposed):

> WCM's Invoice Desk now extracts, per invoice, whenever the document itself states them (never
> inferred): `commitment_number`, `po_number`, `change_order_number`, `is_sov_formatted` (bool),
> `stated_retainage_percent`/`stated_retainage_amount`, and — only when `is_sov_formatted` is true — a
> `line_items` array of `{description, amount_this_period, percent_this_period, percent_complete_to_date}`.
> `commitment_number` already strengthens our own commitment matching (resolves ambiguous-vendor cases
> a stated SC# disambiguates). The rest is captured and sitting in the Invoice Log, unused past that,
> waiting on a Procore-side capability to consume it.
>
> What we need built, in two paths — please don't try to cover both with one function. The paths are
> shaped by how construction billing actually works, not by engineering convenience; the reasoning is
> written up in full under "WHY the invoice-to-SOV paths are what they are" above, and the short version
> is: line items reconcile to the GC's APPROVED commitment SOV (the contract exhibit), never to the
> sub's own claimed numbers directly; a claim that doesn't map cleanly onto an approved line is a human
> reconciliation step, not a computation; and one SOV line absorbing many invoices over time is the
> normal case, which is what makes Path 1 unambiguous however many invoices arrive.
>
> **Path 1 — single-line commitment (expected to be the common case for WCM's small-trade volume).**
> Given a commitment id + an amount for this period + a retainage rate (a parameter you're told,
> never a default you assume — including 10%, don't hardcode it): fill Work Completed This Period %/$
> against that one SOV line, Total Completed & Stored to Date %/$ as that plus every PRIOR
> requisition's billed amount on the commitment (pull it from Procore's own history — don't trust
> anything we tell you about prior periods), and retainage this period = amount × rate. Fully
> automatic, no human review needed — there's only one place the money can go.
>
> **Path 2 — multi-line commitment, with our `line_items` breakdown available** (i.e. `is_sov_formatted`
> was true). Match each extracted line to the corresponding commitment SOV line by cost code/description.
> If a line doesn't map cleanly, don't guess — return it as unresolved, the same "never auto-pick an
> ambiguous match" rule our own commitment matcher already follows. A wrong line assignment on a real
> financial document is worse than asking.
>
> **Path 3 — multi-line commitment, `is_sov_formatted` false (a lump-sum invoice against a detailed
> SOV).** No safe automatic answer exists. Don't apply the amount to "the first line" or any other
> guess — this needs manual entry, same as today.
>
> Endpoints that already exist for the actual write (`search_procore_api` confirmed these, no dedicated
> tool wraps either yet): `PATCH requisitions/{requisition_id}/contract_detail_items/{id}` (one line) or
> `PATCH requisitions/{requisition_id}/bulk_item_update` (all lines at once).
>
> Start with Path 1 — it's fully specified, has no open design questions, and is probably most of
> WCM's actual invoice volume. Paths 2/3 can wait; nothing on our side depends on them yet.

### Every send attempt is now logged, not just the successful ones

Ahmed asked to confirm whether the Send to Procore dialogues log what they do. Checking honestly turned
up a real gap: **`procoreLogSendRow_` was only ever called after a SUCCESSFUL create.** A failed or
refused send existed only in the dashboard panel that reported it — close the panel and there was no
record the attempt had ever happened. Successes had a durable trail; failures did not, which is exactly
backwards, since failures are what someone has to come back to.

**Fixed**: the Procore Send Log gained an **`Outcome`** column (`Sent` / `Failed` / `Needs Match` /
`Skipped`) and a **`Detail`** column carrying the reason, and `sendProcoreInvoiceItem` now writes a row
for every outcome, not just the happy path (via `procoreLogSendAttempt_`, best-effort so a sheet hiccup
can never replace a real error message with a logging one).

**The trap this creates, and the guard against it — do not undo this.** `procoreFindExistingSend_` (the
idempotency guard) scans this same tab for a prior send of the row. Once failures live in that tab, a
naive scan reads a FAILED attempt as "already sent" and blocks that invoice's retry **permanently** —
one Procore outage would strand an invoice forever. So the guard now skips any row whose Outcome isn't
a success, via `procoreSendLogRowIsSuccess_`. That helper treats a **blank Outcome as SENT** on purpose:
rows written before the column existed are all successes, because failures weren't logged then. Both
directions of getting this wrong are real-money bugs — reading a failure as sent blocks a legitimate
retry; reading an old success as a failure invites a duplicate Procore record. There is a dedicated test
for the whole loop (fail a create, confirm the failure is logged, confirm the retry actually sends,
confirm a real send still blocks the next attempt).

**Errors are humanized on the way out** (`procoreHumanizeSendError_`). `procoreFetch_` throws messages
shaped like `Procore POST requisitions?project_id=362778 failed (400): {"errors":"The project must have
an open billing period ..."}` — accurate, but it leads with an HTTP verb and a URL and buries the one
sentence saying what to do. The two causes that actually bit during this build (no open billing period,
unapproved SOV) plus 401/403 now get a plain-language lead sentence, **with the original text still
appended** so nothing is lost and the Detail column stays diagnosable. An unrecognized error passes
through verbatim rather than being paraphrased into something vaguer.

**Dialogue polish, same pass:**
- The bulk results now open with a **one-line tally** ("3 sent · 1 needs a manual pick · 1 failed"),
  green when clean, amber when something needs a person — so a batch is readable without parsing every
  row.
- The **"Mark as In Procore?" prompt is a tinted, bordered block** rather than a dashed rule, and calls
  `scrollIntoView` when shown. A long results list can push it below the fold of the panel's own
  scroll container, and an unanswered question nobody can see is precisely the complaint that got the
  Send button moved in the first place.
- A batch with failures ends with **what to do next** rather than just a red list: fix the cause and
  re-select them, re-sending is safe because a real send is remembered, and every attempt is in the
  Procore Send Log tab.
- **"Close" becomes "Done"** once the work is finished (it reads as "cancel" while a send is pending).
- **The single-invoice preview panel now routes through `sendProcoreInvoiceItem` too**, the same server
  entry point the bulk flow uses, instead of calling `sendInvoiceToProcore` directly. That is what makes
  its failures logged and its errors humanized identically — one send path, one trail. The commitment
  match it runs first is a crosswalk cache hit there (the panel only shows Send once a match is
  confirmed), so it costs nothing.

**What is logged where, in full** — the answer to Ahmed's question:
| Event | Where it lands |
| --- | --- |
| Send succeeded | Procore Send Log, `Outcome: Sent` (+ `Attached` Yes/No) |
| Send failed | Procore Send Log, `Outcome: Failed`, reason in `Detail` |
| Refused, needs a manual commitment pick | Procore Send Log, `Outcome: Needs Match` |
| Skipped (Duplicate / Not an Invoice) | Procore Send Log, `Outcome: Skipped` |
| "Mark as In Procore" confirmed | Invoice Log Status + an Override Log row (via `updateInvoiceRow`) |
| "Not yet" (mark declined) | Nothing — no change was made, so there is nothing to record |

### The UX rework: no more frozen "Sending…", a movable side panel, and a decoupled status confirmation

Ahmed, using the dashboard for real: *"sending to procore takes a bit too long and the page is frozen to
the Sending... notification"*, then *"maybe a UI change, when sent, the panel moves to the side, and the
user can still scroll around. After send, give a yes no option, mark invoices successfully sent as in
Procore?"* Three changes, all in `ProcoreSend.gs` + `Dashboard.html`:

1. **`sendInvoicesToProcoreBulk` is retired, replaced by `sendProcoreInvoiceItem(rowId, kind)` — one
   call per invoice instead of one call for the whole batch.** The old function did all the matching and
   sending for every selected row inside a single `google.script.run` round trip, which is exactly why
   the page looked frozen: `google.script.run` has no way to report progress mid-call, so nothing could
   update until the entire batch finished. `sendProcoreInvoiceItem` does the same per-row work (match via
   `matchInvoiceToProcoreCommitment` for `kind: 'invoice'`, skip matching for `kind: 'direct_cost'`, then
   `sendInvoiceToProcore`) but for exactly one row, and never throws for an expected outcome — everything
   folds into a discriminated `outcome` (`'sent' | 'alreadySent' | 'needsMatch' | 'skipped' | 'error'`) so
   the client has one shape to classify. `doProcoreBulkSend` (`Dashboard.html`) now drives a small
   client-side loop, calling `sendProcoreInvoiceItem` once per reviewed item and updating a status line
   ("Sending 3 of 12… (vendor — Inv# ...)") between calls — the UI genuinely updates between invoices
   because each round trip is short, not because of any new polling mechanism. `PROCORE_SEND_BULK_MAX_`
   (25) moved conceptually to a client-side sanity check before the loop starts (mirrored as
   `PROCORE_BULK_SEND_MAX` in `Dashboard.html`) — there's no longer a single long-running server call to
   protect from Apps Script's ~6-minute execution limit, so the old time-budget/`remaining` mechanics
   (`PROCORE_SEND_BULK_TIME_BUDGET_MS_`) were removed as dead weight, not replaced.

2. **The bulk review window is a side panel, not a blocking modal.** New `.side-panel-overlay`/
   `.side-panel` CSS classes (docked right, `pointer-events: none` on the backdrop so clicks pass through
   to the page everywhere except the panel itself, a slide-in transform driven by an `.active` class
   toggled alongside the existing `display` toggle). `#procoreBulkModalOverlay` now uses these instead of
   `.modal-overlay`/`.modal-box`. A coordinator can keep filtering, scrolling, and opening other invoices
   in the table while a batch send runs.

3. **Sending to Procore and marking the WCM log "In Procore" are now two separate confirmations, not
   one bundled action.** `sendInvoiceToProcore` no longer calls `updateInvoiceRow` itself — it only
   creates the Procore record, attaches the PDF, and logs it; the return value no longer carries a `row`
   field. A new function, **`markProcoreSentInvoices(rowIds)`** (`ProcoreSend.gs`), is the second step:
   given a batch of Row IDs, it flips each one's Status to `STORED_PROCESSED_STATUS` via `updateInvoiceRow`
   — the single write path, same as everywhere else in this codebase — collecting per-row errors instead
   of failing the whole batch on one bad row. **Deliberately not a call to `markInvoicesProcessed`**
   (`DashboardServer.gs`, the download-zip "mark as captured" checkbox's endpoint): that one gates on
   `CAPTURABLE = {'Filed':1,'Needs Review':1}`, which would wrongly refuse a row already `Paid` (Nexus
   sync got there first, or this is a re-send of a corrected Procore record) — a row legitimately sent to
   Procore must still be markable "In Procore" regardless of its prior status. Both the single-invoice
   flow (`procoreMatchBlock` in the preview panel) and the bulk flow now show a "Mark N invoice(s) as In
   Procore in the log?" Yes/No prompt right after a real (non-`alreadySent`) send completes — shared
   client-side logic (`showProcoreMarkSentPrompt`/`doMarkProcoreSent`/`dismissProcoreMarkSent`,
   parameterized by a `scope` of `'single'` or `'bulk'` since the two flows have separate DOM elements)
   rather than two copies. The reasoning for splitting the confirmation, not just a UI nicety: a send
   whose PDF attach failed (see the confirmed attachment bug above) or whose result a coordinator wants to
   double-check in Procore first should not be silently marked done just because the create call
   succeeded.

Unit-tested (extended harness, 102 assertions total, same extract-and-eval pattern): `sendInvoiceToProcore`
no longer touches `updateInvoiceRow` under any outcome (sent, attach-failed, alreadySent);
`sendProcoreInvoiceItem` routes an unambiguous vendor to `sent`, an ambiguous or unknown vendor to
`needsMatch`, a `Duplicate` row to `skipped`, a re-sent row to `alreadySent`, and a row with no Vendor to
`error` (never a thrown exception); `markProcoreSentInvoices` flips Status for every good row in a batch
while isolating one bad row as an error rather than failing the whole call, and does so regardless of
prior status (Paid included) unlike `markInvoicesProcessed`'s narrower gate; the permission gate is
enforced on both new entry points the same as the existing three. The retired `sendInvoicesToProcoreBulk`
tests were replaced with equivalent per-item coverage rather than deleted outright — same routing
guarantees, proven at the new call shape.
