/**
 * ProcoreClient.gs
 * Low-level Procore REST client: mint/cache a client-credentials token and make one HTTP call with
 * the right retry behavior. No SpreadsheetApp, no UI — everything here is a pure function of its
 * arguments plus Script Properties/CacheService/LockService, so it is unit-testable with a mocked
 * UrlFetchApp (see the CLAUDE.md testing section for the extract-and-eval harness).
 *
 * The workflow (which rows to send, what a Procore record looks like, crosswalk lookups) lives in
 * ProcoreSend.gs, a structural analogue of NexusSync.gs. This file only knows how to talk to Procore.
 *
 * Everything below was checked against a real Procore company by CyberSamada/Procore_Claude_Intergration
 * before this shipped — see HANDOFF.md for the full finding-by-finding writeup and issue #9 there for
 * the exchange. The two behaviors that matter most and are easy to get backwards:
 *
 *   - 401 means the app isn't installed on the company (or has no Data Connector component) — drop
 *     the cached token and retry once.
 *   - 403 means authentication is fine but the service account has no access to that project or tool
 *     (most often: the project isn't on the app's permitted-projects list yet, or the account lacks
 *     company-level Directory: Admin) — NEVER drop the token on a 403; it is valid, and re-minting it
 *     changes nothing.
 */

/** 'sandbox' (default) or 'production'. Anything unset or unrecognized resolves to sandbox — a
 *  missing or fat-fingered Script Property must never point at the live company. */
function procoreEnv_() {
  const raw = (PropertiesService.getScriptProperties().getProperty(CONFIG.PROCORE_ENV_PROPERTY) || '').trim().toLowerCase();
  return raw === 'production' ? 'production' : 'sandbox';
}

function procoreIsProduction_() {
  return procoreEnv_() === 'production';
}

function procoreApiBaseUrl_() {
  return procoreIsProduction_() ? CONFIG.PROCORE_PRODUCTION_API_URL : CONFIG.PROCORE_SANDBOX_API_URL;
}

function procoreLoginBaseUrl_() {
  return procoreIsProduction_() ? CONFIG.PROCORE_PRODUCTION_LOGIN_URL : CONFIG.PROCORE_SANDBOX_LOGIN_URL;
}

/**
 * Every host worth trying for a token exchange, API host first. Which host actually accepts a
 * client_credentials grant is not documented reliably enough to pin — the Procore integration repo's
 * own note records that pinning to the login host (on the strength of a quick-start guide covering a
 * different grant type) turned a working setup into a silent 401. Trying both costs one extra request
 * in the failure case and removes a whole class of "which host does Procore want today" mistake.
 */
function procoreTokenUrls_() {
  return [
    `${procoreApiBaseUrl_()}/oauth/token`,
    `${procoreLoginBaseUrl_()}/oauth/token`
  ];
}

function procoreCredentials_() {
  const props = PropertiesService.getScriptProperties();
  const clientId = props.getProperty(CONFIG.PROCORE_CLIENT_ID_PROPERTY);
  const clientSecret = props.getProperty(CONFIG.PROCORE_CLIENT_SECRET_PROPERTY);
  const companyId = props.getProperty(CONFIG.PROCORE_COMPANY_ID_PROPERTY);
  if (!clientId || !clientSecret || !companyId) {
    throw new Error(
      `Procore is not configured. Set the Script Properties "${CONFIG.PROCORE_CLIENT_ID_PROPERTY}", ` +
      `"${CONFIG.PROCORE_CLIENT_SECRET_PROPERTY}" and "${CONFIG.PROCORE_COMPANY_ID_PROPERTY}" under ` +
      `Project Settings > Script Properties, then run setupProcore().`
    );
  }
  return { clientId, clientSecret, companyId };
}

const PROCORE_TOKEN_CACHE_KEY_ = 'PROCORE_ACCESS_TOKEN';
// Refresh a little before Procore's own expiry rather than racing it. Procore's client defaults to
// 3600s (1hr) when a token response omits expires_in; do not assume any particular value here — read
// whatever the token response actually says (see mintProcoreToken_).
const PROCORE_TOKEN_REFRESH_MARGIN_SECONDS_ = 120;

/**
 * Requests a fresh token via client_credentials, trying both token hosts. Does NOT read or write the
 * cache — callers go through getProcoreAccessToken_(), which handles caching and locking.
 * @return {{token: string, expiresInSeconds: number}}
 */
function mintProcoreToken_() {
  const creds = procoreCredentials_();
  const payload = {
    grant_type: 'client_credentials',
    client_id: creds.clientId,
    client_secret: creds.clientSecret
  };
  const options = {
    method: 'post',
    contentType: 'application/x-www-form-urlencoded',
    payload: payload,
    muteHttpExceptions: true
  };

  let lastResponse = null;
  const urls = procoreTokenUrls_();
  for (let i = 0; i < urls.length; i++) {
    const response = UrlFetchApp.fetch(urls[i], options);
    lastResponse = response;
    if (response.getResponseCode() === 200) {
      const body = JSON.parse(response.getContentText());
      if (!body.access_token) {
        throw new Error(`Procore token endpoint (${urls[i]}) returned 200 with no access_token.`);
      }
      return {
        token: body.access_token,
        expiresInSeconds: Number(body.expires_in) || 3600 // Procore's own default when the field is absent
      };
    }
  }
  throw new Error(
    `Procore token request failed on every host tried (${urls.join(', ')}): ` +
    `${lastResponse.getResponseCode()} ${lastResponse.getContentText().slice(0, 300)}`
  );
}

/**
 * Returns a valid access token, minting a fresh one if the cache is empty or stale. Mint happens
 * under a LockService lock so a burst of concurrent google.script.run calls shares one token instead
 * of each minting its own; the cache is re-checked after acquiring the lock in case another execution
 * already refreshed it while this one was waiting.
 *
 * Uses a document lock distinct in purpose from the send-apply resumable loop's lock (ProcoreSend.gs)
 * — token minting is short and must never be blocked behind a multi-minute apply run holding a lock
 * for an unrelated reason.
 */
function getProcoreAccessToken_() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get(PROCORE_TOKEN_CACHE_KEY_);
  if (cached) return cached;

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const recheck = cache.get(PROCORE_TOKEN_CACHE_KEY_);
    if (recheck) return recheck;

    const minted = mintProcoreToken_();
    const ttl = Math.max(60, minted.expiresInSeconds - PROCORE_TOKEN_REFRESH_MARGIN_SECONDS_);
    cache.put(PROCORE_TOKEN_CACHE_KEY_, minted.token, Math.min(ttl, 21600)); // CacheService caps at 6h
    return minted.token;
  } finally {
    lock.releaseLock();
  }
}

function procoreDropCachedToken_() {
  CacheService.getScriptCache().remove(PROCORE_TOKEN_CACHE_KEY_);
}

/** version_for(resource) — 1.0 unless CONFIG.PROCORE_RESOURCE_VERSIONS names a specific one. */
function procoreResourceVersion_(resource) {
  return (CONFIG.PROCORE_RESOURCE_VERSIONS && CONFIG.PROCORE_RESOURCE_VERSIONS[resource]) || '1.0';
}

/** Builds a full /rest/v{version}/{path} URL. `path` should not include a leading "rest/..." segment. */
function procoreUrl_(resource, path) {
  const version = procoreResourceVersion_(resource);
  return `${procoreApiBaseUrl_()}/rest/v${version}/${String(path).replace(/^\/+/, '')}`;
}

/**
 * Makes one Procore API call with the retry/error semantics established against a real company (see
 * file header). `resource` picks the API version (procoreResourceVersion_) and has no other effect.
 *
 * @param {string} method - 'get', 'post', 'patch', etc.
 * @param {string} resource - e.g. 'requisitions', 'work_order_contracts' — used only for versioning.
 * @param {string} path - appended after /rest/v{version}/, e.g. 'requisitions?project_id=123'.
 * @param {Object} [options] - { payload, contentType, maxRetries }. Do not set contentType when
 *   payload contains a Blob (multipart) — see ProcoreSend.gs for why that specific combination breaks.
 * @return {GoogleAppsScript.URL_Fetch.HTTPResponse}
 */
function procoreFetch_(method, resource, path, options) {
  options = options || {};
  const maxRetries = options.maxRetries != null ? options.maxRetries : 4;
  const url = procoreUrl_(resource, path);

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const token = getProcoreAccessToken_();
    const creds = procoreCredentials_();
    const fetchOptions = {
      method: method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Procore-Company-Id': String(creds.companyId)
      },
      muteHttpExceptions: true
    };
    if (options.payload !== undefined) fetchOptions.payload = options.payload;
    // Deliberately omit contentType when the caller didn't set one — UrlFetchApp only encodes a
    // payload containing a Blob as multipart/form-data when contentType is left unset. Setting it
    // (the habit carried over from the Gemini JSON calls) silently breaks the multipart boundary.
    if (options.contentType !== undefined) fetchOptions.contentType = options.contentType;

    const response = UrlFetchApp.fetch(url, fetchOptions);
    const code = response.getResponseCode();

    if (code === 200 || code === 201 || code === 204) return response;

    if (code === 429 || code >= 500) {
      const retryAfterHeader = response.getHeaders()['Retry-After'] || response.getHeaders()['retry-after'];
      const waitMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : 2000 * Math.pow(2, attempt);
      if (attempt < maxRetries) {
        Logger.log(`Procore ${method.toUpperCase()} ${path} returned ${code}, retrying in ${Math.round(waitMs / 1000)}s (attempt ${attempt + 1}/${maxRetries})...`);
        Utilities.sleep(waitMs);
        continue;
      }
      return response; // out of retries — let the caller see the last response and decide
    }

    if (code === 401) {
      // App not installed on the company, or no Data Connector component — the token itself is the
      // problem. Drop it and retry exactly once with a freshly minted one.
      procoreDropCachedToken_();
      if (attempt === 0) continue;
      throw new Error(
        `Procore rejected the request twice with 401 (${method.toUpperCase()} ${path}). The Client ` +
        `ID/Secret are being accepted (a token was issued) but access is still refused — this usually ` +
        `means the app version is not installed on the company, or it has no Data Connector component. ` +
        `Check Company Admin > App Management.`
      );
    }

    if (code === 403) {
      // Authenticated fine; the service account just has no access to this. Never drop the token —
      // re-minting changes nothing and burns a request. The first cause in practice is the
      // permitted-projects list, which fails silently on reads too.
      throw new Error(
        `Procore returned 403 (${method.toUpperCase()} ${path}) — authenticated, but not permitted. ` +
        `Most likely: this project is not on the app's permitted-projects list (Company Admin > App ` +
        `Management > the app > Permissions), or the service account lacks company-level Directory: ` +
        `Admin for a company-scoped call. Not a credentials problem — do not retry with a new token.`
      );
    }

    // 400/404/422/etc — a real request problem, not transient. Retrying burns budget for nothing.
    throw new Error(`Procore ${method.toUpperCase()} ${path} failed (${code}): ${response.getContentText().slice(0, 400)}`);
  }
}

/**
 * Whether the three required Procore Script Properties are present — no network call, so safe to
 * call on every dashboard page load (see getAutomationStatus, DashboardServer.gs). Does NOT mean
 * the credentials actually work; only testProcoreConnection() (Setup.gs) proves that.
 */
function procoreConfigured_() {
  const props = PropertiesService.getScriptProperties();
  return !!(
    props.getProperty(CONFIG.PROCORE_CLIENT_ID_PROPERTY) &&
    props.getProperty(CONFIG.PROCORE_CLIENT_SECRET_PROPERTY) &&
    props.getProperty(CONFIG.PROCORE_COMPANY_ID_PROPERTY)
  );
}

/**
 * All companies in a project's Procore vendor directory — GET projects/{id}/vendors, walked with
 * offset pagination (Procore's own scheme: page/per_page). Capped at 500 records; a project with
 * more than that is not something this smoke test needs to handle.
 * @return {Array<{id: number, name: string}>}
 */
function procoreListProjectVendors_(projectId) {
  const out = [];
  const perPage = 100;
  for (let page = 1; out.length < 500; page++) {
    const response = procoreFetch_('get', 'vendors', `projects/${projectId}/vendors?page=${page}&per_page=${perPage}`);
    const batch = JSON.parse(response.getContentText());
    if (!Array.isArray(batch) || !batch.length) break;
    batch.forEach(c => out.push({ id: c.id, name: c.name }));
    if (batch.length < perPage) break; // short page — that was the last one
  }
  return out;
}

/**
 * Finds the ONE company in a Procore project's directory whose name matches `vendorName`, using the
 * same normalized-key matching WCM's own Vendor Directory already relies on
 * (vendorNormalizedKey_, SheetService.gs) — collapses case/punctuation/legal-suffix so "BBM Ltd" and
 * "BBM LTD." match, while genuinely different companies stay apart.
 *
 * Deliberately does NOT guess on an ambiguous result. Two companies sharing a normalized name (real
 * data in this very sandbox — "BBM Ltd" exists twice, ids 3739183/3739184) is reported back as
 * unresolved rather than silently picking one, the same rule NexusSync.gs already applies to
 * money-adjacent matching: no single signal auto-applies when it can't tell two candidates apart.
 *
 * @return {{matched: true, vendorId: number, vendorName: string}
 *          | {matched: false, reason: string}}
 */
function procoreFindVendorByName_(projectId, vendorName) {
  const wantKey = vendorNormalizedKey_(vendorName);
  if (!wantKey) {
    return { matched: false, reason: 'This invoice has no vendor name to match against Procore.' };
  }

  const companies = procoreListProjectVendors_(projectId);
  const hits = companies.filter(c => vendorNormalizedKey_(c.name) === wantKey);

  if (hits.length === 0) {
    return {
      matched: false,
      reason: `"${vendorName}" is not in Procore project ${projectId}'s vendor directory. Add them there first (Directory > Companies), or check the spelling matches.`
    };
  }
  if (hits.length > 1) {
    const list = hits.map(h => `${h.name} (id ${h.id})`).join(', ');
    return {
      matched: false,
      reason: `${hits.length} companies in Procore project ${projectId} match "${vendorName}": ${list}. Ambiguous — resolve the duplicate in Procore's directory first, then try again.`
    };
  }
  return { matched: true, vendorId: hits[0].id, vendorName: hits[0].name };
}

const PROCORE_MAX_UPLOAD_BYTES_ = 20 * 1024 * 1024; // our cap; Procore's own storage service allows 100MB

/**
 * Puts a file into Procore's storage and returns its upload UUID, for attaching to a record
 * afterward (e.g. { prostore_file_ids: [uuid] } on a direct cost or requisition).
 *
 * Two steps, checked against the Procore integration repo's working implementation:
 *   1. POST projects/{id}/uploads asking Procore how to upload — it hands back a UUID, a URL, and
 *      a set of form fields.
 *   2. POST the file to THAT URL, with THOSE fields — carrying NO Procore Authorization header and
 *      NO Procore-Company-Id. The URL and fields arrive in a response body; sending our bearer
 *      token to whatever host that response named would hand a live Procore credential to it. This
 *      goes out on a fresh, header-less request, and only over HTTPS.
 *
 * @param {number} projectId
 * @param {GoogleAppsScript.Base.Blob} blob
 * @return {string} the upload UUID
 */
function procoreUploadFile_(projectId, blob) {
  const bytes = blob.getBytes();
  if (bytes.length > PROCORE_MAX_UPLOAD_BYTES_) {
    throw new Error(`"${blob.getName()}" is ${(bytes.length / 1048576).toFixed(1)} MB; the cap is ${PROCORE_MAX_UPLOAD_BYTES_ / 1048576} MB.`);
  }
  if (!bytes.length) throw new Error(`"${blob.getName()}" is empty.`);

  const instructionsResponse = procoreFetch_('post', 'uploads', `projects/${projectId}/uploads`, {
    payload: JSON.stringify({
      response_filename: blob.getName(),
      response_content_type: blob.getContentType() || 'application/pdf',
      size: bytes.length
    }),
    contentType: 'application/json'
  });
  const instructions = JSON.parse(instructionsResponse.getContentText());
  const uuid = instructions.uuid;
  const url = String(instructions.url || '');
  const fields = instructions.fields || {};
  if (!uuid || !url) {
    throw new Error(`Procore's upload instructions were incomplete: ${JSON.stringify(Object.keys(instructions))}`);
  }
  if (!/^https:\/\//i.test(url)) {
    // Plain HTTP would put the file and the storage fields on the wire in clear.
    throw new Error(`Procore returned a non-HTTPS upload URL (${url.slice(0, 40)}...); refusing to send a file to it.`);
  }

  const payload = {};
  Object.keys(fields).forEach(k => { payload[k] = String(fields[k]); });
  payload.file = blob;

  // No Authorization, no Procore-Company-Id, no other header of ours — see the note above.
  // Also deliberately no contentType: UrlFetchApp only encodes a payload containing a Blob as
  // multipart/form-data when contentType is left unset; setting it (the habit from JSON calls
  // elsewhere) silently breaks the multipart boundary.
  const uploadResponse = UrlFetchApp.fetch(url, {
    method: 'post',
    payload: payload,
    muteHttpExceptions: true
  });
  if (uploadResponse.getResponseCode() >= 400) {
    throw new Error(`Procore's storage service rejected the file (${uploadResponse.getResponseCode()}): ${uploadResponse.getContentText().slice(0, 300)}`);
  }

  return uuid;
}

/**
 * Raw list of one commitment resource on a project — GET {resource}?project_id=..., walked with
 * page/per_page like procoreListProjectVendors_. `resource` is 'work_order_contracts' (subcontracts)
 * or 'purchase_order_contracts' (purchase orders) — Procore keeps these as two separate resources
 * with no merged endpoint (see HANDOFF.md finding 1). Each record's `vendor.id` is the PROJECT-scoped
 * vendor id (the same id procoreListProjectVendors_/procoreFindVendorByName_ use), not the
 * company-directory id create_company-equivalent calls return — confirmed 2026-08-20 against the
 * sandbox: adding a company to a project mints a new id distinct from its company-directory id, and
 * `work_order_contracts[].vendor.id` comes back as that project-scoped one.
 * @return {Array<{id:number, title:string, number:string, status:string, kind:string, vendorId:number, vendorName:string}>}
 */
function procoreListCommitmentResource_(projectId, resource, kindLabel) {
  const out = [];
  const perPage = 100;
  for (let page = 1; out.length < 500; page++) {
    const response = procoreFetch_('get', resource, `${resource}?project_id=${projectId}&page=${page}&per_page=${perPage}`);
    const batch = JSON.parse(response.getContentText());
    if (!Array.isArray(batch) || !batch.length) break;
    batch.forEach(c => out.push({
      id: c.id,
      title: c.title,
      number: c.number,
      status: c.status,
      kind: kindLabel,
      vendorId: c.vendor ? c.vendor.id : null,
      vendorName: c.vendor ? c.vendor.company : ''
    }));
    if (batch.length < perPage) break; // short page — that was the last one
  }
  return out;
}

/**
 * All commitments on a project, subcontracts and/or purchase orders, flattened into one shape.
 * @param {number} projectId
 * @param {string} [kind] - 'all' (default), 'subcontracts', or 'purchase_orders'.
 * @return {Array<{id:number, title:string, number:string, status:string, kind:string, vendorId:number, vendorName:string}>}
 */
function procoreListProjectCommitments_(projectId, kind) {
  kind = kind || 'all';
  let out = [];
  if (kind === 'all' || kind === 'subcontracts') {
    out = out.concat(procoreListCommitmentResource_(projectId, 'work_order_contracts', 'subcontract'));
  }
  if (kind === 'all' || kind === 'purchase_orders') {
    out = out.concat(procoreListCommitmentResource_(projectId, 'purchase_order_contracts', 'purchase_order'));
  }
  return out;
}

/**
 * Finds the ONE commitment on a Procore project whose vendor matches `vendorName`, for filing an
 * invoice against (see HANDOFF.md §8/§9 — this is the matcher that work built towards). Same
 * normalized-key matching as procoreFindVendorByName_ (vendorNormalizedKey_, SheetService.gs), and
 * the same "never guess" discipline it and NexusSync.gs both apply: no commitment, or more than one
 * commitment whose vendor normalizes to the same key, is reported back as unresolved rather than
 * picked silently — an invoice billed against the wrong commitment is a real-money mistake.
 *
 * Deliberately does NOT filter by commitment status. Draft is the only status reachable through the
 * API (see create_commitment_draft's own note) and is a legitimate match; whether a draft commitment
 * can actually accept a requisition is Procore's own business rule to enforce on the write, not
 * this function's to pre-judge.
 *
 * @param {number} projectId
 * @param {string} vendorName
 * @param {string} [kind] - 'all' (default), 'subcontracts', or 'purchase_orders'. Only subcontracts
 *   have been exercised against real sandbox data as of 2026-08-20 (§8: DGM Services Limited, Copp's
 *   Buildall, OUTER CONSTRUCTION, project 362778) — purchase orders are implemented per finding 1 but
 *   unproven against a live purchase_order_contracts record.
 * @return {{matched: true, commitmentId: number, commitmentTitle: string, commitmentNumber: string,
 *           commitmentKind: string, vendorName: string}
 *          | {matched: false, reason: string}}
 */
function procoreFindCommitmentForInvoice_(projectId, vendorName, kind) {
  const wantKey = vendorNormalizedKey_(vendorName);
  if (!wantKey) {
    return { matched: false, reason: 'This invoice has no vendor name to match against Procore.' };
  }

  const commitments = procoreListProjectCommitments_(projectId, kind || 'all');
  const hits = commitments.filter(c => vendorNormalizedKey_(c.vendorName) === wantKey);

  if (hits.length === 0) {
    return {
      matched: false,
      reason: `No commitment for "${vendorName}" on Procore project ${projectId}. Create a subcontract or purchase order with this vendor first, or check the spelling matches.`
    };
  }
  if (hits.length > 1) {
    const list = hits.map(h => `${h.title} (${h.kind} ${h.number}, id ${h.id})`).join(', ');
    return {
      matched: false,
      reason: `${hits.length} commitments on Procore project ${projectId} match vendor "${vendorName}": ${list}. Ambiguous — resolve which commitment this invoice bills against before sending.`
    };
  }
  return {
    matched: true,
    commitmentId: hits[0].id,
    commitmentTitle: hits[0].title,
    commitmentNumber: hits[0].number,
    commitmentKind: hits[0].kind,
    vendorName: hits[0].vendorName
  };
}
