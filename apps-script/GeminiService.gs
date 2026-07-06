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
  // '' (empty string) is a valid "no subproject" value for projects that don't have numbered subprojects
  const subprojectNumbers = [...new Set(referenceRows.map(r => r.subprojectNumber).concat(['']))];

  const schema = {
    type: 'object',
    properties: {
      vendor_name: { type: 'string', description: 'The vendor/company name that issued the invoice.' },
      invoice_number: { type: ['string', 'null'], description: 'The invoice number, if present.' },
      invoice_date: { type: 'string', format: 'date', description: 'Invoice date in YYYY-MM-DD format.' },
      due_date: { type: ['string', 'null'], format: 'date', description: 'Payment due date in YYYY-MM-DD format, if present.' },
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
        description: 'Best-match subproject number, or empty string if the project has no matching numbered subproject.'
      },
      match_reasoning: { type: 'string', description: 'One sentence on why this project/subproject was chosen.' },
      confidence: {
        type: 'number', minimum: 0, maximum: 1,
        description: 'Self-assessed confidence (0-1) that the project/subproject match is correct. Treat as a rough signal, not a calibrated probability.'
      }
    },
    required: ['vendor_name', 'invoice_date', 'amount', 'currency', 'project_number', 'subproject_number', 'confidence']
  };

  const referenceListText = referenceRows.map(r =>
    `${r.projectNumber} | ${r.projectName} | ${r.subprojectNumber || '(no subproject)'} | ${r.subprojectName || ''}`
  ).join('\n');

  const prompt = `You are matching a construction-company invoice PDF to the correct project and subproject.\n\n` +
    `Reference list (Project Number | Project Name | Subproject Number | Subproject Name):\n${referenceListText}\n\n` +
    `Read the attached invoice PDF and extract the requested fields. For project_number and subproject_number, ` +
    `pick the single best match from the reference list above based on any address, tenant name, or project reference ` +
    `mentioned in the invoice. If a project has no matching subproject, use an empty string for subproject_number. ` +
    `If you are not confident in the match, still make your best guess but reflect that in a low confidence score.`;

  const payload = {
    contents: [{
      parts: [
        { inlineData: { mimeType: 'application/pdf', data: Utilities.base64Encode(pdfBlob.getBytes()) } },
        { text: prompt }
      ]
    }],
    generationConfig: {
      responseFormat: {
        text: { mimeType: 'application/json', schema: schema }
      }
    }
  };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${CONFIG.GEMINI_MODEL}:generateContent`;
  const response = UrlFetchApp.fetch(url, {
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

  return JSON.parse(text);
}

/**
 * Rule-based sanity check on top of Gemini's self-reported confidence — see plan doc Section 3, step 4.
 * Returns true only if the project/subproject Gemini returned actually exists in the reference data
 * (belt-and-braces on top of the `enum` constraint, which should already guarantee this).
 */
function validateMatch_(result, referenceRows) {
  return referenceRows.some(r =>
    r.projectNumber === result.project_number &&
    (r.subprojectNumber || '') === (result.subproject_number || '')
  );
}
