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
 * @param {GoogleAppsScript.Base.Blob} pdfBlob
 * @param {Array<Object>} referenceRows - from getReferenceData_()
 * @return {Object} parsed extraction result, or throws on failure
 */
function extractAndMatchInvoice_(pdfBlob, referenceRows) {
  const apiKey = PropertiesService.getScriptProperties().getProperty(CONFIG.GEMINI_API_KEY_PROPERTY);
  if (!apiKey) {
    throw new Error(`Script Property "${CONFIG.GEMINI_API_KEY_PROPERTY}" is not set. Generate a key at aistudio.google.com/apikey and add it under Project Settings > Script Properties.`);
  }

  const projectNumbers = [...new Set(referenceRows.map(r => r.projectNumber))];
  // Gemini's schema validation rejects an empty string as an enum value, so use the sentinel
  // "NONE" instead, then convert it back to '' after parsing the response (see below).
  const subprojectNumbers = [...new Set(referenceRows.map(r => r.subprojectNumber || 'NONE'))];

  const schema = {
    type: 'object',
    properties: {
      is_invoice: {
        type: 'boolean',
        description: 'True only if this document is a genuine invoice/bill requesting payment for goods or services (typically has an invoice number, amount due, and due date). False for anything else — payment/banking info updates, account statements, paid receipts, marketing or informational emails, etc.'
      },
      vendor_name: { type: 'string', description: 'The vendor/company name that issued the invoice.' },
      invoice_number: { type: 'string', nullable: true, description: 'The invoice number, if present.' },
      invoice_date: { type: 'string', format: 'date', description: 'Invoice date in YYYY-MM-DD format.' },
      due_date: { type: 'string', format: 'date', nullable: true, description: 'Payment due date in YYYY-MM-DD format, if present.' },
      amount: { type: 'number', description: 'Total amount due on the invoice.' },
      currency: { type: 'string', description: 'ISO 4217 currency code, e.g. CAD, USD.' },
      project_number: {
        type: 'string',
        enum: projectNumbers,
        description: 'Best-match project number from the provided reference list.'
      },
      subproject_number: {
        type: 'string',
        enum: subprojectNumbers,
        description: 'Best-match subproject number, or "NONE" if the project has no matching numbered subproject.'
      },
      match_reasoning: { type: 'string', description: 'One sentence on why this project/subproject was chosen.' },
      confidence: {
        type: 'number', minimum: 0, maximum: 1,
        description: 'Self-assessed confidence (0-1) that the project/subproject match is correct. Treat as a rough signal, not a calibrated probability.'
      }
    },
    required: ['is_invoice', 'vendor_name', 'invoice_date', 'amount', 'currency', 'project_number', 'subproject_number', 'confidence']
  };

  const referenceListText = referenceRows.map(r =>
    `${r.projectNumber} | ${r.projectName} | ${r.subprojectNumber || '(no subproject)'} | ${r.subprojectName || ''}`
  ).join('\n');

  const prompt = `You are matching a construction-company invoice PDF to the correct project and subproject.\n\n` +
    `Reference list (Project Number | Project Name | Subproject Number | Subproject Name):\n${referenceListText}\n\n` +
    `First, determine whether this document is actually an invoice or bill requesting payment — as opposed to ` +
    `something else like a banking/payment info update, an account statement, a paid receipt, or an informational ` +
    `email — and set is_invoice accordingly. Then read the document and extract the requested fields regardless ` +
    `(make your best guess for fields that don't clearly apply if it isn't an invoice). For project_number and subproject_number, ` +
    `pick the single best match from the reference list above based on any address, tenant name, or project reference ` +
    `mentioned in the invoice. If a project has no matching subproject, use "NONE" for subproject_number. ` +
    `The reference list may be incomplete — it might not yet include every subproject that actually exists. If the ` +
    `invoice clearly belongs to a listed project but does NOT specifically and confidently match any listed subproject ` +
    `(e.g. a different tenant, unit, or address not on the list), use "NONE" for subproject_number rather than forcing ` +
    `a match to a similar-sounding one, and lower your confidence score to reflect that the specific subproject wasn't found. ` +
    `If you are not confident in the match, still make your best guess but reflect that in a low confidence score.`;

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
 * The Drive Folder ID is resolved at the project level too — if the matched row doesn't carry one,
 * any sibling row of the same project that does is used.
 *
 * @return {Object|null} { projectNumber, projectName, subprojectNumber, subprojectName,
 *                         driveFolderId, exactSubproject } or null if the project number
 *                         doesn't exist in the reference data at all.
 */
function findReferenceMatch_(referenceRows, projectNumber, subprojectNumber) {
  if (!projectNumber) return null;
  const projectRows = referenceRows.filter(r => r.projectNumber === projectNumber);
  if (projectRows.length === 0) return null;

  const sub = subprojectNumber || '';
  const exact = projectRows.find(r => (r.subprojectNumber || '') === sub);
  // Prefer the blank-subproject ("main") row as the fallback identity for the project.
  const base = exact || projectRows.find(r => !r.subprojectNumber) || projectRows[0];
  const rowWithFolder = projectRows.find(r => r.driveFolderId);

  return {
    projectNumber: projectNumber,
    projectName: base.projectName,
    subprojectNumber: exact ? (exact.subprojectNumber || '') : '',
    subprojectName: exact ? exact.subprojectName : '',
    driveFolderId: (exact && exact.driveFolderId) || (rowWithFolder ? rowWithFolder.driveFolderId : ''),
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
