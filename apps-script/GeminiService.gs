/**
 * GeminiService.gs
 * One call to Gemini does both jobs: read the PDF and extract invoice fields,
 * AND match it to a project/subproject from the reference list.
 *
 * Uses Gemini's structured output mode (a JSON Schema passed in generationConfig.responseFormat)
 * rather than just asking for JSON in the prompt — this guarantees syntactically valid JSON back.
 * Project/subproject numbers are constrained via `enum` to whatever is actually in the
 * "Project Reference" sheet at call time, so Gemini can't invent a project that doesn't exist,
 * and the reference list can grow over time without touching this code.
 *
 * See WCM_Invoice_Automation_Plan.md, Section 9a, for why this approach (vs. Document AI, etc.)
 */

/**
 * How the confidence score is assigned (see the "confidence" schema field and the rubric baked
 * into the prompt below):
 *
 * Gemini self-reports confidence — there's no separate calibration step — but it's steered with an
 * explicit rubric rather than left to a vague "how sure are you" instruction, since an
 * uncalibrated LLM asked that generically tends to cluster answers around "pretty sure" regardless
 * of actual evidence. The rubric ties confidence to *what kind of evidence* was found:
 *
 *   0.90–1.00  Explicit: the invoice states the project name/number, or a listed alias, verbatim
 *              or near-verbatim — e.g. "Project 43 - Hyland Centre" printed on the invoice itself.
 *   0.75–0.89  Strong inference: a specific address or tenant name clearly matches exactly one
 *              listed project/subproject, with no other listed project being a plausible fit.
 *   0.50–0.74  Moderate: some supporting detail exists, but there's real ambiguity — e.g. it could
 *              plausibly match more than one listed project, or the identifying detail is partial.
 *   0.01–0.49  Weak: little concrete textual evidence ties the invoice to the specific project
 *              chosen — mostly inference or vendor history. Should be rare; "UNKNOWN" usually fits
 *              better at this point (see below).
 *   0            Mandatory when project_number is "UNKNOWN" — there is no match to be confident in.
 *
 * This scale is intentionally calibrated against CONFIG.CONFIDENCE_THRESHOLD (0.75 by default,
 * see Config.gs): only "Explicit" and "Strong inference" matches clear the bar to auto-file.
 * "Moderate" and below always land in "Needs Review" — matches with real ambiguity are meant to
 * get a human's eyes before money moves, not to slip through because the score happened to be
 * "high enough." If you tune CONFIDENCE_THRESHOLD, keep it inside the 0.75–0.89 band (or adjust
 * the rubric text below to match) so it still lines up with a tier boundary rather than splitting
 * one.
 *
 * @param {GoogleAppsScript.Base.Blob} pdfBlob
 * @param {Array<Object>} referenceRows - from getReferenceData_() (raw — may include excluded/template rows)
 * @param {Array<Object>} [aliasRows] - from getAliasData_(); optional, defaults to none
 * @param {Date} [emailDate] - when the email carrying this PDF was sent; used only to disambiguate
 *   an ambiguous numeric invoice date (see the prompt) — optional, degrades gracefully without it.
 * @return {Object} parsed extraction result, or throws on failure
 */
function extractAndMatchInvoice_(pdfBlob, referenceRows, aliasRows, emailDate) {
  const apiKey = PropertiesService.getScriptProperties().getProperty(CONFIG.GEMINI_API_KEY_PROPERTY);
  if (!apiKey) {
    throw new Error(`Script Property "${CONFIG.GEMINI_API_KEY_PROPERTY}" is not set. Generate a key at aistudio.google.com/apikey and add it under Project Settings > Script Properties.`);
  }
  aliasRows = aliasRows || [];

  // Never offer template/placeholder rows (e.g. "00 PROJECT TEMPLATE") as something an invoice
  // can be matched to — see CONFIG.EXCLUDE_PROJECT_NUMBERS.
  const matchableRows = getMatchableReferenceRows_(referenceRows);

  // "UNKNOWN" lets Gemini decline to pick a project rather than being forced into the closest
  // wrong one just because the schema requires *some* enum value — see the prompt below.
  const projectNumbers = ['UNKNOWN', ...new Set(matchableRows.map(r => r.projectNumber))];
  // Gemini's schema validation rejects an empty string as an enum value, so use the sentinel
  // "NONE" instead, then convert it back to '' after parsing the response (see below).
  const subprojectNumbers = [...new Set(matchableRows.map(r => r.subprojectNumber || 'NONE'))];

  const schema = {
    type: 'object',
    properties: {
      is_invoice: {
        type: 'boolean',
        description: 'True only if this document is a genuine invoice/bill requesting payment for goods or services (typically has an invoice number, amount due, and due date). False for anything else — payment/banking info updates, account statements, paid receipts, marketing or informational emails, etc.'
      },
      vendor_name: { type: 'string', description: 'The vendor/company name that issued the invoice.' },
      invoice_number: { type: 'string', nullable: true, description: 'The invoice number, if present.' },
      invoice_date: { type: 'string', format: 'date', description: 'Invoice date in YYYY-MM-DD format. See the date-disambiguation instructions in the prompt for ambiguous numeric dates (e.g. 09/07/2026).' },
      due_date: { type: 'string', format: 'date', nullable: true, description: 'Payment due date in YYYY-MM-DD format, if present. Same date-disambiguation rule applies.' },
      amount: { type: 'number', description: 'Total amount due on the invoice.' },
      currency: { type: 'string', description: 'ISO 4217 currency code, e.g. CAD, USD.' },
      project_number: {
        type: 'string',
        enum: projectNumbers,
        description: 'Best-match project number from the reference list, or "UNKNOWN" if none can be confidently identified.'
      },
      subproject_number: {
        type: 'string',
        enum: subprojectNumbers,
        description: 'Best-match subproject number, or "NONE" if the project has no matching numbered subproject (also "NONE" when project_number is "UNKNOWN").'
      },
      match_reasoning: {
        type: 'string',
        description: 'Always fill this in, especially when project_number is "UNKNOWN": explain what address/tenant/name you found on the invoice, and — if you have a guess even though you weren\'t confident enough to select it — name the project you suspect it might be and why, so a human reviewer can check quickly.'
      },
      confidence: {
        type: 'number', minimum: 0, maximum: 1,
        description: 'Confidence (0-1) the project/subproject match is correct, using the evidence-based rubric given in the prompt (0.9+ explicit match, 0.75-0.89 strong inference, 0.5-0.74 moderate/ambiguous, below 0.5 weak, 0 when project_number is "UNKNOWN"). Base it on the strength of the evidence found, not general confidence in the answer.'
      }
    },
    required: ['is_invoice', 'vendor_name', 'invoice_date', 'amount', 'currency', 'project_number', 'subproject_number', 'match_reasoning', 'confidence']
  };

  const referenceListText = matchableRows.map(r =>
    `${r.projectNumber} | ${r.projectName} | ${r.subprojectNumber || '(no subproject)'} | ${r.subprojectName || ''}`
  ).join('\n');

  const aliasListText = aliasRows.map(a =>
    `"${a.alias}" -> Project ${a.projectNumber}${a.subprojectNumber ? ' / Subproject ' + a.subprojectNumber : ''}`
  ).join('\n');

  const emailDateIso = (emailDate instanceof Date && !isNaN(emailDate.getTime()))
    ? Utilities.formatDate(emailDate, Session.getScriptTimeZone(), 'yyyy-MM-dd')
    : '';

  const prompt = `You are matching a construction-company invoice PDF to the correct project and subproject.\n\n` +
    (emailDateIso ? `This invoice was received by email on ${emailDateIso}.\n\n` : '') +
    `Reference list (Project Number | Project Name | Subproject Number | Subproject Name):\n${referenceListText}\n\n` +
    (aliasListText
      ? `Known aliases — alternate names/addresses invoices sometimes use instead of the project's listed name ` +
        `(if the invoice mentions one of these, use the project/subproject it points to directly):\n${aliasListText}\n\n`
      : '') +
    `First, determine whether this document is actually an invoice or bill requesting payment — as opposed to ` +
    `something else like a banking/payment info update, an account statement, a paid receipt, or an informational ` +
    `email — and set is_invoice accordingly. Then read the document and extract the requested fields regardless ` +
    `(make your best guess for fields that don't clearly apply if it isn't an invoice). ` +
    `For project_number and subproject_number, pick the single best match from the reference list (and alias list, if given) ` +
    `above based on any address, tenant name, or project reference mentioned in the invoice. If a project has no matching ` +
    `subproject, use "NONE" for subproject_number. ` +
    `The reference list may be incomplete — it might not yet include every subproject that actually exists. If the ` +
    `invoice clearly belongs to a listed project but does NOT specifically and confidently match any listed subproject ` +
    `(e.g. a different tenant, unit, or address not on the list), use "NONE" for subproject_number rather than forcing ` +
    `a match to a similar-sounding one, and lower your confidence score to reflect that the specific subproject wasn't found.\n\n` +
    `IMPORTANT — do not force a project match either. The reference list does NOT include every real project or every way ` +
    `an address might be written; a project not appearing here does not mean the invoice is invalid. If you cannot confidently ` +
    `tie the invoice to one specific listed project — even if it clearly mentions a real address or tenant name — set ` +
    `project_number to "UNKNOWN" (and subproject_number to "NONE") rather than guessing the closest-sounding one. When you do ` +
    `this, still use match_reasoning to record your best guess and why (e.g. "invoice is for '1105 Wellington - Old Bay'; not ` +
    `on the list, but tenant/address details suggest it may belong to project 54 WHITE OAKS MALL — needs human confirmation") ` +
    `so a person can quickly review and confirm it. Never guess just to fill the field, and never select a project that is ` +
    `clearly a template, placeholder, or non-project entry.\n\n` +
    `For confidence, score the STRENGTH OF THE EVIDENCE you found, not how sure you feel in general:\n` +
    `- 0.90-1.00: the invoice states the project name/number, or a listed alias, explicitly (verbatim or near-verbatim).\n` +
    `- 0.75-0.89: a specific address or tenant name clearly matches exactly one listed project/subproject, with no other ` +
    `listed project also being a plausible fit.\n` +
    `- 0.50-0.74: some supporting detail exists, but there is real ambiguity — it could plausibly match more than one ` +
    `listed project, or the identifying detail is only partial.\n` +
    `- Below 0.50: little concrete textual evidence ties the invoice to the specific project — this should be rare; if ` +
    `the evidence is this thin, prefer "UNKNOWN" over a low-confidence guess.\n` +
    `- Exactly 0: required whenever project_number is "UNKNOWN".\n` +
    `Only scores of 0.75 and above are auto-filed without human review, so reserve that range for cases where you would ` +
    `bet on the match, not merely lean toward it.\n\n` +
    (emailDateIso
      ? `DATE FORMAT: some invoices print dates numerically in a way that's ambiguous between DD/MM and MM/DD ` +
        `(e.g. "09/07/2026" could mean July 9 or September 7 — ambiguous whenever both the day and month ` +
        `components could be a valid month, i.e. both are 12 or less). When you hit this ambiguity, resolve it using ` +
        `the email date above: invoices are essentially always dated on or shortly before the day they're emailed, so ` +
        `pick whichever interpretation is on or before ${emailDateIso} (and closer to it, if both qualify) rather than ` +
        `one that would place the invoice in the future. If the date isn't ambiguous (a component over 12, or a ` +
        `spelled-out month), just read it directly — this rule only matters for the ambiguous numeric case.`
      : '');

  const payload = {
    contents: [{
      parts: [
        { inlineData: { mimeType: 'application/pdf', data: Utilities.base64Encode(pdfBlob.getBytes()) } },
        { text: prompt }
      ]
    }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: schema
    }
  };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${CONFIG.GEMINI_MODEL}:generateContent`;
  const response = fetchWithRetry_(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-goog-api-key': apiKey },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  const responseCode = response.getResponseCode();
  if (responseCode !== 200) {
    throw new Error(`Gemini API returned ${responseCode}: ${response.getContentText()}`);
  }

  const json = JSON.parse(response.getContentText());
  const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new Error(`Gemini response had no text content: ${response.getContentText()}`);
  }

  const parsed = JSON.parse(text);
  if (parsed.subproject_number === 'NONE') {
    parsed.subproject_number = '';
  }
  if (parsed.project_number === 'UNKNOWN') {
    parsed.project_number = '';
  }
  return parsed;
}

/**
 * Calls UrlFetchApp.fetch, retrying on 429 (rate limit) and 503 (temporary overload) —
 * both are transient per Google's own error messages, which explicitly say to retry.
 * Free-tier Gemini API keys are capped at 5 requests/minute, so bursts of calls (e.g. testRun()
 * processing several PDFs back to back) commonly hit this; retrying with backoff smooths it over.
 */
function fetchWithRetry_(url, options, maxRetries) {
  maxRetries = maxRetries || 4;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = UrlFetchApp.fetch(url, options);
    const code = response.getResponseCode();
    if (code !== 429 && code !== 503) {
      return response; // success, or a non-retryable error — let the caller handle it
    }
    if (attempt < maxRetries) {
      const waitMs = 15000 * (attempt + 1); // 15s, 30s, 45s, 60s
      Logger.log(`Gemini API returned ${code}, retrying in ${waitMs / 1000}s (attempt ${attempt + 1}/${maxRetries})...`);
      Utilities.sleep(waitMs);
    } else {
      return response; // out of retries — return the last response, let the caller throw
    }
  }
}

/**
 * Resolves the extracted project/subproject numbers against the Project Reference rows.
 *
 * Tries an exact project + subproject match first. If that fails but the project number itself
 * exists, falls back to a project-level match: Drive filing is per-project anyway (one archive
 * folder per project number, not per subproject), so a correctly identified project should never
 * be dropped just because its exact subproject row isn't in the reference sheet yet. The old
 * behavior (require both to match) is what left invoices in "_Unmatched"/"Needs Review" with a
 * blank Project Name even when the project number was correct.
 *
 * The Drive Folder ID is resolved with subproject folders preferred over the project's own: when
 * there's an exact subproject match and that row carries its own folder ID (its dedicated
 * subfolder — see DriveSetup.gs/createInvoiceArchiveFolders), that's used; otherwise this falls
 * back to the project-level (blank-subproject) row's folder, then to any sibling row that has one.
 *
 * Excludes CONFIG.EXCLUDE_PROJECT_NUMBERS (template/placeholder rows, e.g. "00 PROJECT TEMPLATE")
 * itself — callers never need to remember to pre-filter referenceRows before calling this.
 *
 * @return {Object|null} { projectNumber, projectName, subprojectNumber, subprojectName,
 *                         driveFolderId, exactSubproject } or null if the project number
 *                         doesn't exist in the (non-excluded) reference data at all.
 */
function findReferenceMatch_(referenceRows, projectNumber, subprojectNumber) {
  if (!projectNumber) return null;
  const matchableRows = getMatchableReferenceRows_(referenceRows);
  const projectRows = matchableRows.filter(r => r.projectNumber === projectNumber);
  if (projectRows.length === 0) return null;

  const sub = subprojectNumber || '';
  const exact = projectRows.find(r => (r.subprojectNumber || '') === sub);
  // Prefer the blank-subproject ("main") row as the fallback identity for the project.
  const base = exact || projectRows.find(r => !r.subprojectNumber) || projectRows[0];
  const projectLevelRow = projectRows.find(r => !r.subprojectNumber && r.driveFolderId);
  const anyRowWithFolder = projectRows.find(r => r.driveFolderId);
  const driveFolderId = (exact && exact.driveFolderId) // the subproject's own dedicated subfolder, if provisioned
    || (projectLevelRow && projectLevelRow.driveFolderId) // else the project's own folder
    || (anyRowWithFolder && anyRowWithFolder.driveFolderId) // else whatever sibling row happens to have one
    || '';

  return {
    projectNumber: projectNumber,
    projectName: base.projectName,
    subprojectNumber: exact ? (exact.subprojectNumber || '') : '',
    subprojectName: exact ? exact.subprojectName : '',
    driveFolderId: driveFolderId,
    exactSubproject: !!exact
  };
}

/**
 * Rule-based sanity check on top of Gemini's self-reported confidence — see plan doc Section 3, step 4.
 * Passes if the extracted project number exists in the reference data (exact subproject no longer
 * required — see findReferenceMatch_).
 */
function validateMatch_(result, referenceRows) {
  return findReferenceMatch_(referenceRows, result.project_number, result.subproject_number) !== null;
}
