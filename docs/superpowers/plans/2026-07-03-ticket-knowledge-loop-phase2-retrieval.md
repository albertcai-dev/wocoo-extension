# Ticket Knowledge Loop — Phase 2 (Retrieval) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the sidepanel's heuristic suggested-response cards with an AI verdict card grounded in (a) semantically-retrieved similar past ticket resolutions from the Phase 1 sheet and (b) semantically-retrieved chunks of Albert's personal Notion playbook. Sync is on-demand (Claude session).

**Architecture:** Server-side embeddings via a `embedText` Apps Script bridge action calling the Voyage-3 API. Vectors stored as JSON strings in Google Sheets: existing `embedding` column on the `Log` tab for past resolutions, and a new `Playbook Embeddings` tab for the Notion playbook chunks. Retrieval is a bridge action (`getVerdict`) that embeds the incoming ticket text, walks the two tabs to compute cosine similarity (Apps Script), picks top-k of each, packages the context into a MagicAI prompt (`generateVerdict`), and returns a JSON verdict. Extension renders an AI verdict card and caches result by `ticket_id + updated_at`.

**Tech Stack:** Vite + React + TypeScript Chrome extension, Google Apps Script bridge, Google Sheets (as vector store), Voyage-3 embedding API, MagicAI (existing `parseTranscript` uses it — same helper pattern).

## Global Constraints

- **Apps Script edits via the web editor only.** Per `feedback_no_clasp`.
- **Re-deploy is required** after every GAS code change, per `reference_apps_script_gotchas` — Apps Script caches at deploy time.
- **The extension is not a git repo.** Steps do not include `git commit`; verification is via `npm run build` + Chrome extension reload + manual smoke test.
- **All bridge handlers follow the `_handle*FromGet_` + postMessage-in-HTML pattern** used by the existing dispatcher (see [[reference_ticket_log_sheet]]). Direct-JSON return works for GAS Run-button testing but the browser bridge in `bridge.ts` requires the postMessage envelope.
- **API keys live in Script Properties**, never in code. Add `VOYAGE_API_KEY` to the existing WOCOO GAS project's Script Properties (Project Settings → Script properties → Add script property).
- **Vector serialization**: `JSON.stringify(numArray)` on write, `JSON.parse` on read. Voyage-3 dims (~1024 for `voyage-3-large`) fit inside a Sheet cell (~50 KB limit) with slack.
- **On-demand sync only** in Phase 2 — the Claude session runs the Notion-fetch → embed → write sequence via MCP tools when Albert asks. No cron.
- **Sync target = personal playbook**, NOT the shared team Notion page. Top page ID: `39241167-bd96-81d5-92b1-da6303f0b22c`.

---

## File Structure

| Path / surface | Change |
|---|---|
| WOCOO Apps Script bridge `code.gs` (web editor) | Add `handleEmbedText` + wrapper + dispatcher case. Add `handleGetVerdict` + wrapper + dispatcher case. Add sheet-row embedding worker `embedTicketLogRows` + time trigger install. |
| Ticket Log sheet | Add `Playbook Embeddings` tab with schema. |
| Ticket Log sheet | Existing `embedding` and `embedded_at` columns (reserved in Phase 1) start getting written by the worker. |
| `extension/src/api/bridge.ts` | Add `getVerdictViaBridge` (Voyage embed happens server-side; extension just calls `getVerdict` with ticket text). |
| `extension/src/sidepanel/AIVerdictCard.tsx` | New component. Renders verdict JSON: work type + confidence + steps + gotchas + similar tickets + playbook sections. |
| `extension/src/sidepanel/SidePanel.tsx` | Wire `AIVerdictCard` under description, above the existing heuristic cards. Cache by `ticket_id + updated_at`. |
| `extension/src/sidepanel/verdictCache.ts` | Tiny in-process cache keyed on ticket id + updated_at. |
| Notion playbook | No changes; content is what it is. Sync reads pages as they exist. |
| Memory | Update `project_ticket_knowledge_loop.md` when Phase 2 ships. |

---

## Task 1: Voyage API key + `embedText` bridge handler

**Files:**
- Modify (GAS web editor): `code.gs` — append constants + `embedTextWithVoyage` helper + `handleEmbedText` + `_handleEmbedTextFromGet_` + dispatcher case.
- No extension-side changes yet.

**Interfaces:**
- Consumes: nothing from earlier tasks. Voyage-3 REST API + PropertiesService for the key.
- Produces:
  - Bridge action `embedText` accepting query params `text` (string) and optional `model` (default `voyage-3-large`). Returns `{ action: 'textEmbedded', vector: number[], dims: number, model: string }`.
  - GAS-side callable helper `embedTextWithVoyage(text, model)`  → `number[]` for reuse from other GAS handlers (Task 3, Task 4).

- [ ] **Step 1: Get a Voyage API key.** Go to https://dashboard.voyageai.com/ (or ask Albert). Sign in with a Wealthsimple email if possible so it lives inside the company's account, otherwise personal for now.

- [ ] **Step 2: Add the key to Script Properties.** GAS editor → Project Settings (gear icon, left rail) → Script properties → Add script property. Name: `VOYAGE_API_KEY`. Value: the key. Save.

- [ ] **Step 3: Append the embedding helper and handler to `code.gs`.** Paste at the end of the file (after the Ticket Log block from Phase 1):

```js
// ============================================================
// Voyage-3 embeddings (Phase 2 of Ticket Knowledge Loop)
// ============================================================

/** Server-side callable — used by both handleEmbedText and the ticket-log embedding worker. */
function embedTextWithVoyage(text, model) {
  var key = PropertiesService.getScriptProperties().getProperty('VOYAGE_API_KEY');
  if (!key) throw new Error('VOYAGE_API_KEY not set in Script Properties.');
  var body = {
    input: [String(text || '')],
    model: model || 'voyage-3-large',
    input_type: 'document', // 'document' for the corpus, 'query' for lookups (getVerdict overrides)
  };
  var resp = UrlFetchApp.fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + key },
    payload: JSON.stringify(body),
    muteHttpExceptions: true,
  });
  var code = resp.getResponseCode();
  if (code < 200 || code >= 300) {
    throw new Error('Voyage embed failed (HTTP ' + code + '): ' + resp.getContentText().substring(0, 240));
  }
  var data = JSON.parse(resp.getContentText());
  if (!data || !data.data || !data.data[0] || !Array.isArray(data.data[0].embedding)) {
    throw new Error('Voyage returned unexpected shape: ' + resp.getContentText().substring(0, 240));
  }
  return data.data[0].embedding;
}

function handleEmbedText(params) {
  var text = String(params.text || '');
  if (!text) throw new Error('embedText: empty text');
  var model = String(params.model || 'voyage-3-large');
  var inputType = String(params.input_type || 'document'); // 'document' | 'query'
  // For 'query' input_type we call the API directly instead of the helper (which fixes 'document').
  var key = PropertiesService.getScriptProperties().getProperty('VOYAGE_API_KEY');
  if (!key) throw new Error('VOYAGE_API_KEY not set in Script Properties.');
  var body = { input: [text], model: model, input_type: inputType };
  var resp = UrlFetchApp.fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + key },
    payload: JSON.stringify(body),
    muteHttpExceptions: true,
  });
  var code = resp.getResponseCode();
  if (code < 200 || code >= 300) throw new Error('Voyage embed failed (HTTP ' + code + '): ' + resp.getContentText().substring(0, 240));
  var data = JSON.parse(resp.getContentText());
  var vec = data.data[0].embedding;
  return { action: 'textEmbedded', vector: vec, dims: vec.length, model: model };
}

function _handleEmbedTextFromGet_(e) {
  var ALLOW = HtmlService.XFrameOptionsMode.ALLOWALL;
  function postScript(msg) {
    var json = JSON.stringify(msg);
    return '<script>try{window.top.postMessage(' + json + ', "*");}catch(e){}try{window.parent.postMessage(' + json + ', "*");}catch(e){}</script>';
  }
  try {
    var result = handleEmbedText(e.parameter || {});
    return HtmlService.createHtmlOutput(
      '<html><body><p style="font-family:sans-serif;padding:24px;color:#16a34a;">✓ Embedded (' + result.dims + ' dims)</p>' +
      postScript(result) + '</body></html>'
    ).setXFrameOptionsMode(ALLOW);
  } catch (err) {
    var msg = err.message || String(err);
    return HtmlService.createHtmlOutput(
      '<html><body><p style="font-family:sans-serif;padding:24px;color:#991b1b;">Embed failed: ' + msg.replace(/</g, '&lt;') + '</p>' +
      postScript({ action: 'textEmbedded', error: msg }) + '</body></html>'
    ).setXFrameOptionsMode(ALLOW);
  }
}
```

- [ ] **Step 4: Wire the dispatcher.** In `doGet`, after the `updateTicketLog` branch, add:

```js
if (e && e.parameter && e.parameter.action === 'embedText') {
  return _handleEmbedTextFromGet_(e);
}
```

- [ ] **Step 5: Deploy new version.** Deploy → Manage Deployments → active Web App → Edit → Version: New version → Deploy. Confirm URL unchanged.

- [ ] **Step 6: Direct smoke test.** In the GAS editor, add a scratch function:

```js
function _testEmbedText() {
  var r = embedTextWithVoyage('reverse fee for foreign transaction on credit card', 'voyage-3-large');
  Logger.log('dims: ' + r.length + ', first 5: ' + JSON.stringify(r.slice(0, 5)));
}
```

Run it. Expected: log line like `dims: 1024, first 5: [0.012, -0.048, ...]`. Delete the scratch function after verifying.

---

## Task 2: `Playbook Embeddings` sheet tab

**Files:**
- Modify: existing Ticket Log sheet (`1UnCQoj_oPiJshzP65QpU0hp6-DmcLtN-6H4WLV7HbPw`) — add a tab.

**Interfaces:**
- Consumes: nothing.
- Produces: A `Playbook Embeddings` tab with columns: `page_id`, `page_title`, `parent_path`, `chunk_key`, `chunk_text`, `updated_at`, `embedding`, `embedded_at`, `model`.

- [ ] **Step 1: Add the tab via MCP.** Call `google_sheets_add_tab` on spreadsheet `1UnCQoj_oPiJshzP65QpU0hp6-DmcLtN-6H4WLV7HbPw` with title `Playbook Embeddings`.

- [ ] **Step 2: Populate the header row.** Call `google_sheets_batch_update_values` with `range` = `Playbook Embeddings!A1:I1` and `values`:

```json
[["page_id", "page_title", "parent_path", "chunk_key", "chunk_text", "updated_at", "embedding", "embedded_at", "model"]]
```

`value_input_option`: `RAW`.

- [ ] **Step 3: Freeze row 1.** Call `google_sheets_get_metadata` to find the new tab's `sheet_id`, then `google_sheets_freeze` with `frozen_row_count: 1`.

**No code to run or GAS deploy** — this is pure sheet setup.

---

## Task 3: Ticket Log embedding worker (Apps Script time trigger)

**Files:**
- Modify (GAS web editor): `code.gs` — append `embedTicketLogRows` function + `installTicketLogEmbeddingTrigger` installer.

**Interfaces:**
- Consumes: `embedTextWithVoyage` (Task 1).
- Produces: A time trigger that runs every 5 minutes, processes up to N=10 rows per tick with `embedded_at IS NULL`, and populates `embedding` + `embedded_at`.

- [ ] **Step 1: Append the worker function to `code.gs`:**

```js
// ============================================================
// Ticket Log embedding worker (Phase 2)
// ============================================================
const TL_EMBEDDING_MODEL = 'voyage-3-large';
const TL_EMBEDDING_BATCH = 10; // rows per tick; keeps GAS run under 30s comfortably

function embedTicketLogRows() {
  var ss = SpreadsheetApp.openById(TICKET_LOG_SPREADSHEET_ID);
  var sh = ss.getSheetByName(TICKET_LOG_TAB);
  if (!sh) throw new Error('Log tab not found');
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return { processed: 0 };
  // Pull the columns we need in one round trip.
  var range = sh.getRange(2, 1, lastRow - 1, 18);
  var all = range.getValues();
  var processed = 0;
  for (var i = 0; i < all.length && processed < TL_EMBEDDING_BATCH; i++) {
    var row = all[i];
    var embeddedAt = row[TL_COL_EMBEDDED_AT - 1];
    if (embeddedAt) continue; // already embedded
    var summary = String(row[TL_COL_SUMMARY - 1] || '');
    var descSnippet = String(row[TL_COL_DESCRIPTION_SNIPPET - 1] || '');
    var resolutionNote = String(row[TL_COL_RESOLUTION_NOTE - 1] || '');
    var toolsUsed = String(row[TL_COL_TOOLS_USED - 1] || '');
    var novelNote = String(row[TL_COL_NOVEL_NOTE - 1] || '');
    var text = [summary, descSnippet, resolutionNote, toolsUsed, novelNote].filter(Boolean).join('\n');
    if (!text.trim()) continue;
    var vec;
    try {
      vec = embedTextWithVoyage(text, TL_EMBEDDING_MODEL);
    } catch (e) {
      Logger.log('embedTicketLogRows: row ' + (i + 2) + ' failed: ' + e.message);
      continue; // skip; next tick will retry
    }
    var rowNumber = i + 2;
    sh.getRange(rowNumber, TL_COL_EMBEDDING).setValue(JSON.stringify(vec));
    sh.getRange(rowNumber, TL_COL_EMBEDDED_AT).setValue(new Date().toISOString());
    processed++;
  }
  Logger.log('embedTicketLogRows: processed ' + processed);
  return { processed: processed };
}

function installTicketLogEmbeddingTrigger() {
  // Remove any existing trigger for this handler first.
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'embedTicketLogRows') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  ScriptApp.newTrigger('embedTicketLogRows').timeBased().everyMinutes(5).create();
  return { ok: true };
}
```

- [ ] **Step 2: Save + deploy new version.** (Even though the trigger runs server-side, deploying refreshes the code the trigger will execute.)

- [ ] **Step 3: Install the trigger — one-time.** Select `installTicketLogEmbeddingTrigger` in the Run dropdown → Run. Grant "Manage triggers" permission when prompted. Verify: Project Settings → Triggers → you should see one entry for `embedTicketLogRows`, every 5 minutes.

- [ ] **Step 4: Force a first tick to backfill existing rows.** Select `embedTicketLogRows` in the Run dropdown → Run. Check the execution log for `embedTicketLogRows: processed N`. Then open the sheet — the earliest Log rows should have JSON in the `embedding` column and a timestamp in `embedded_at`.

- [ ] **Step 5: Verify quality.** In the sheet, spot-check one row's `embedding` cell — it should be a JSON array starting with `[` and running ~5-8k characters (1024 floats × ~5-8 chars each). If it looks garbled, revisit Task 1.

---

## Task 4: `getVerdict` bridge handler (retrieval + verdict generation)

**Files:**
- Modify (GAS web editor): `code.gs` — append `cosineSim` helper, `handleGetVerdict`, `_handleGetVerdictFromGet_`, dispatcher case.

**Interfaces:**
- Consumes: `embedTextWithVoyage` (Task 1). MagicAI helper — reuse the same helper the existing `parseTranscript` handler uses. (If none exists as a named helper, inline the fetch to MagicAI following the parseTranscript pattern.)
- Produces:
  - Bridge action `getVerdict` accepting query params: `ticket_id`, `summary`, `description`, `original_work_type`. Returns `{ action: 'verdictGenerated', verdict: {...} }` where verdict is JSON with `likely_work_type`, `confidence`, `board`, `novel`, `novel_likelihood`, `steps` (array), `gotchas` (array), `similar_tickets` (array of `{ ticket_id, summary }`), `playbook_sections` (array of `{ page_title, chunk_key }`).

- [ ] **Step 1: Read the existing `parseTranscript` handler** in `code.gs` to identify the MagicAI helper pattern (function name, URL, headers, auth). The Phase 2 verdict prompt reuses the same helper.

- [ ] **Step 2: Append the verdict handler to `code.gs`.** Replace `MAGIC_AI_HELPER_CALL` in the block below with the actual call — copy the shape from the existing parseTranscript handler:

```js
// ============================================================
// getVerdict — semantic retrieval + AI verdict card (Phase 2)
// ============================================================
const VERDICT_LOG_TOP_K = 5;
const VERDICT_PLAYBOOK_TOP_K = 3;

function cosineSim(a, b) {
  var dot = 0, na = 0, nb = 0;
  var n = Math.min(a.length, b.length);
  for (var i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9);
}

function readLogEmbeddings() {
  var ss = SpreadsheetApp.openById(TICKET_LOG_SPREADSHEET_ID);
  var sh = ss.getSheetByName(TICKET_LOG_TAB);
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return [];
  var range = sh.getRange(2, 1, lastRow - 1, 18).getValues();
  var out = [];
  for (var i = 0; i < range.length; i++) {
    var row = range[i];
    var vecJson = row[TL_COL_EMBEDDING - 1];
    if (!vecJson) continue;
    var vec;
    try { vec = JSON.parse(vecJson); } catch (e) { continue; }
    out.push({
      ticket_id: String(row[TL_COL_TICKET_ID - 1] || ''),
      summary: String(row[TL_COL_SUMMARY - 1] || ''),
      resolution_note: String(row[TL_COL_RESOLUTION_NOTE - 1] || ''),
      tools_used: String(row[TL_COL_TOOLS_USED - 1] || ''),
      original_work_type: String(row[TL_COL_ORIGINAL_WORK_TYPE - 1] || ''),
      transition: String(row[TL_COL_TRANSITION - 1] || ''),
      moved_to_board: String(row[TL_COL_MOVED_TO_BOARD - 1] || ''),
      vector: vec,
    });
  }
  return out;
}

function readPlaybookEmbeddings() {
  var ss = SpreadsheetApp.openById(TICKET_LOG_SPREADSHEET_ID);
  var sh = ss.getSheetByName('Playbook Embeddings');
  if (!sh) return [];
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return [];
  var range = sh.getRange(2, 1, lastRow - 1, 9).getValues();
  var out = [];
  for (var i = 0; i < range.length; i++) {
    var row = range[i];
    var vecJson = row[6]; // column G (embedding)
    if (!vecJson) continue;
    var vec;
    try { vec = JSON.parse(vecJson); } catch (e) { continue; }
    out.push({
      page_id: String(row[0] || ''),
      page_title: String(row[1] || ''),
      parent_path: String(row[2] || ''),
      chunk_key: String(row[3] || ''),
      chunk_text: String(row[4] || ''),
      vector: vec,
    });
  }
  return out;
}

function handleGetVerdict(params) {
  var summary = String(params.summary || '');
  var description = String(params.description || '');
  var workType = String(params.original_work_type || '');
  var ticketId = String(params.ticket_id || '');
  var queryText = [summary, description, workType].filter(Boolean).join('\n');
  if (!queryText.trim()) throw new Error('getVerdict: empty query');

  // 1. Embed the query as a 'query' input_type.
  var key = PropertiesService.getScriptProperties().getProperty('VOYAGE_API_KEY');
  var resp = UrlFetchApp.fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'post', contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + key },
    payload: JSON.stringify({ input: [queryText], model: TL_EMBEDDING_MODEL, input_type: 'query' }),
    muteHttpExceptions: true,
  });
  if (resp.getResponseCode() >= 300) throw new Error('Voyage query embed failed: ' + resp.getContentText().substring(0, 200));
  var queryVec = JSON.parse(resp.getContentText()).data[0].embedding;

  // 2. Score both tabs.
  var logRows = readLogEmbeddings().map(function (r) { r.score = cosineSim(queryVec, r.vector); return r; });
  var playbookRows = readPlaybookEmbeddings().map(function (r) { r.score = cosineSim(queryVec, r.vector); return r; });
  logRows.sort(function (a, b) { return b.score - a.score; });
  playbookRows.sort(function (a, b) { return b.score - a.score; });
  var topLog = logRows.slice(0, VERDICT_LOG_TOP_K);
  var topPlaybook = playbookRows.slice(0, VERDICT_PLAYBOOK_TOP_K);

  // 3. Build the MagicAI prompt.
  var prompt = _buildVerdictPrompt(summary, description, workType, ticketId, topLog, topPlaybook);
  var verdictJson = callMagicAI_(prompt); // REPLACE with the actual helper name used by parseTranscript
  var verdict = _parseVerdictJson(verdictJson, topLog, topPlaybook);
  return { action: 'verdictGenerated', verdict: verdict };
}

function _buildVerdictPrompt(summary, description, workType, ticketId, topLog, topPlaybook) {
  var lines = [];
  lines.push('You are helping a WOCOO ops associate triage and resolve a JIRA ticket. Classify the ticket, judge whether it is novel, and produce grounded resolution steps + gotchas using the retrieved context.');
  lines.push('');
  lines.push('=== Current ticket ===');
  lines.push('ID: ' + ticketId);
  lines.push('Original work type: ' + workType);
  lines.push('Summary: ' + summary);
  lines.push('Description: ' + description);
  lines.push('');
  lines.push('=== Similar past resolutions (' + topLog.length + ') ===');
  for (var i = 0; i < topLog.length; i++) {
    var r = topLog[i];
    lines.push('[' + r.ticket_id + '] (' + r.original_work_type + ' → ' + r.transition + (r.moved_to_board ? ' → ' + r.moved_to_board : '') + ')');
    lines.push('  Summary: ' + r.summary);
    if (r.resolution_note) lines.push('  Resolution: ' + r.resolution_note);
    if (r.tools_used) lines.push('  Tools: ' + r.tools_used);
  }
  lines.push('');
  lines.push('=== Playbook chunks (' + topPlaybook.length + ') ===');
  for (var j = 0; j < topPlaybook.length; j++) {
    var p = topPlaybook[j];
    lines.push('--- ' + p.page_title + ' → ' + p.chunk_key + ' ---');
    lines.push(p.chunk_text);
  }
  lines.push('');
  lines.push('=== Output requirements ===');
  lines.push('Respond with ONLY valid JSON, no prose, matching this schema:');
  lines.push('{');
  lines.push('  "likely_work_type": string,           // e.g. "Reverse Fee"');
  lines.push('  "confidence": number,                  // 0-1');
  lines.push('  "board": string,                       // "WOCOO" | "CRED" | "PFO" | "EOC" | "Other"');
  lines.push('  "novel": boolean,                      // true if no similar past resolution AND no matching playbook');
  lines.push('  "novel_likelihood": number,            // 0-1');
  lines.push('  "steps": string[],                     // 3-6 numbered resolution steps, imperative voice');
  lines.push('  "gotchas": string[],                   // 0-4 short warnings');
  lines.push('  "similar_ticket_ids": string[],        // subset of the retrieved ids that actually informed the answer');
  lines.push('  "playbook_chunk_keys": string[]        // subset of retrieved chunk_keys that actually informed the answer');
  lines.push('}');
  return lines.join('\n');
}

function _parseVerdictJson(raw, topLog, topPlaybook) {
  // Extract JSON from the model's response — tolerate leading/trailing whitespace or code fences.
  var s = String(raw || '').trim();
  var first = s.indexOf('{');
  var last = s.lastIndexOf('}');
  if (first < 0 || last < 0) throw new Error('Verdict response contained no JSON object: ' + s.substring(0, 200));
  var jsonStr = s.substring(first, last + 1);
  var v = JSON.parse(jsonStr);
  // Attach the actual retrieved rows for the ids the model cited.
  var citedIds = new Set(v.similar_ticket_ids || []);
  v.similar_tickets = topLog.filter(function (r) { return citedIds.has(r.ticket_id); }).map(function (r) { return { ticket_id: r.ticket_id, summary: r.summary }; });
  var citedChunks = new Set(v.playbook_chunk_keys || []);
  v.playbook_sections = topPlaybook.filter(function (p) { return citedChunks.has(p.chunk_key); }).map(function (p) { return { page_title: p.page_title, chunk_key: p.chunk_key }; });
  return v;
}

// NOTE: Task 4 Step 1 requires copying the exact MagicAI helper the existing parseTranscript handler uses.
// If parseTranscript defines something like `_callMagicAiSync_(prompt)` or `magicAiComplete_(prompt)`,
// use that name in place of the `callMagicAI_(prompt)` reference above. Do NOT reinvent — keep the auth path
// identical to parseTranscript so the same api key/route/scopes work.

function _handleGetVerdictFromGet_(e) {
  var ALLOW = HtmlService.XFrameOptionsMode.ALLOWALL;
  function postScript(msg) {
    var json = JSON.stringify(msg);
    return '<script>try{window.top.postMessage(' + json + ', "*");}catch(e){}try{window.parent.postMessage(' + json + ', "*");}catch(e){}</script>';
  }
  try {
    var result = handleGetVerdict(e.parameter || {});
    return HtmlService.createHtmlOutput(
      '<html><body><p style="font-family:sans-serif;padding:24px;color:#16a34a;">✓ Verdict generated</p>' +
      postScript(result) + '</body></html>'
    ).setXFrameOptionsMode(ALLOW);
  } catch (err) {
    var msg = err.message || String(err);
    return HtmlService.createHtmlOutput(
      '<html><body><p style="font-family:sans-serif;padding:24px;color:#991b1b;">Verdict failed: ' + msg.replace(/</g, '&lt;') + '</p>' +
      postScript({ action: 'verdictGenerated', error: msg }) + '</body></html>'
    ).setXFrameOptionsMode(ALLOW);
  }
}
```

- [ ] **Step 3: Wire the dispatcher.** In `doGet`, add after the `embedText` branch:

```js
if (e && e.parameter && e.parameter.action === 'getVerdict') {
  return _handleGetVerdictFromGet_(e);
}
```

- [ ] **Step 4: Deploy new version.**

- [ ] **Step 5: Direct smoke test.** Wait until at least a few Log rows have been embedded (Task 3 worker will have run one tick by now). Also complete Task 5 first if the playbook is empty of embeddings — otherwise `topPlaybook` is empty and the prompt is thinner. Add a scratch function:

```js
function _testGetVerdict() {
  var r = handleGetVerdict({
    ticket_id: 'WOCOO-TEST-VERDICT',
    summary: 'reverse the fx fee on my credit card',
    description: 'Client got charged an FX fee on a US purchase and is asking us to refund it. Card is a WSCC credit card.',
    original_work_type: 'Credit Card: Transactions',
  });
  Logger.log(JSON.stringify(r, null, 2));
}
```

Run it. Expected: log shows a verdict JSON with `likely_work_type: "Reverse Fee"` (or similar) + non-empty `steps` + `similar_tickets`. If the MagicAI call errors, revisit Step 2's helper wiring.

---

## Task 5: Session-driven Notion → Playbook Embeddings sync (Claude action, not code)

**Files:** No files — this is a documented Claude-session runbook, not a code task.

**Interfaces:**
- Consumes: `mcp__mcplocker__notion__notion-fetch`, the `embedText` bridge action, `mcp__mcplocker__google_sheets_append`.
- Produces: rows in the `Playbook Embeddings` tab, one per 5-block chunk of each work-type sub-page.

**Runbook — invoke by asking Claude "sync playbook":**

- [ ] **Step 1: Fetch the top playbook page and its children.** Call `notion-fetch` on the top page ID `39241167-bd96-81d5-92b1-da6303f0b22c`. This surfaces the four section sub-pages (Overview / Triage rules / Work types / Change log).

- [ ] **Step 2: Fetch each Work-types sub-page** (Reverse Fee, Overpayment, Inquiry Removal, Statement Correction, Retention Fee Waiver, QC Fee Waiver, QC Auto-Reimburse, Wallet Provisioning, Visa Companion, Wires — Pending Posting, Mobile Cheque Validation, Card-Specific: i2c, Card-Specific: Koho). Their IDs are in [[project_ticket_knowledge_loop]] or can be re-discovered by fetching the Work types parent page.

- [ ] **Step 3: For each work-type sub-page**, split content into 5 chunks using the exact block headings (`## When this applies`, `## Steps`, `## Tools + queries`, `## Gotchas`, `## Example tickets`). Only embed chunks whose body is NON-empty (skip `_TBD_`-only chunks).

- [ ] **Step 4: For each non-empty chunk**, call `embedText` via the bridge with the chunk text and `input_type: 'document'`. The bridge returns the vector.

- [ ] **Step 5: Append rows to `Playbook Embeddings`** using `google_sheets_append`. One row per chunk:
  - `page_id`: sub-page ID
  - `page_title`: e.g. "Reverse Fee"
  - `parent_path`: "Work types"
  - `chunk_key`: e.g. "reverse-fee/steps" (kebab-cased page title + block heading slug)
  - `chunk_text`: raw text of the chunk (no heading)
  - `updated_at`: ISO timestamp from the Notion page (or current time)
  - `embedding`: `JSON.stringify(vector)`
  - `embedded_at`: current ISO timestamp
  - `model`: `voyage-3-large`

- [ ] **Step 6: Delta-only re-syncs.** For subsequent syncs, before embedding, read the existing `Playbook Embeddings` rows via `google_sheets_get` and skip chunks whose `chunk_text` hasn't changed. This is a nice-to-have for Phase 2 v1; for v0, full re-sync is fine since the playbook is small (~65 chunks max).

**No GAS changes for this task.** The sync is entirely orchestrated in the Claude session; the bridge just provides the `embedText` endpoint (already in Task 1).

---

## Task 6: `getVerdictViaBridge` on the extension side

**Files:**
- Modify: `extension/src/api/bridge.ts` — append `getVerdictViaBridge` after `updateTicketLogViaBridge`.
- Create: `extension/src/data/verdictTypes.ts` — the `VerdictResult` interface.

**Interfaces:**
- Consumes: `callBridge` in `bridge.ts`.
- Produces:
  - `VerdictResult` interface with `likely_work_type`, `confidence`, `board`, `novel`, `novel_likelihood`, `steps: string[]`, `gotchas: string[]`, `similar_tickets: { ticket_id: string; summary: string }[]`, `playbook_sections: { page_title: string; chunk_key: string }[]`.
  - `getVerdictViaBridge(payload): Promise<VerdictResult>`.

- [ ] **Step 1: Create `extension/src/data/verdictTypes.ts`:**

```ts
export interface VerdictSimilarTicket { ticket_id: string; summary: string }
export interface VerdictPlaybookSection { page_title: string; chunk_key: string }

export interface VerdictResult {
  likely_work_type: string;
  confidence: number;
  board: string;
  novel: boolean;
  novel_likelihood: number;
  steps: string[];
  gotchas: string[];
  similar_tickets: VerdictSimilarTicket[];
  playbook_sections: VerdictPlaybookSection[];
}

export interface VerdictQueryPayload {
  ticketId: string;
  summary: string;
  description: string;
  originalWorkType: string;
}
```

- [ ] **Step 2: Append to `extension/src/api/bridge.ts`:**

```ts
import type { VerdictQueryPayload, VerdictResult } from '../data/verdictTypes';

export async function getVerdictViaBridge(p: VerdictQueryPayload): Promise<VerdictResult> {
  // The bridge takes a while — Voyage embed + MagicAI call + sheet reads. Give it up to 60s.
  const res = await callBridge('getVerdict', {
    ticket_id: p.ticketId,
    summary: p.summary,
    description: p.description,
    original_work_type: p.originalWorkType,
  }, 'verdictGenerated', 60_000);
  return res.verdict as VerdictResult;
}
```

Adjust the import position/style to match the existing file conventions.

- [ ] **Step 3: `npm run build`.** Expected: clean build.

---

## Task 7: `AIVerdictCard.tsx` + SidePanel wiring

**Files:**
- Create: `extension/src/sidepanel/AIVerdictCard.tsx`.
- Create: `extension/src/sidepanel/verdictCache.ts`.
- Modify: `extension/src/sidepanel/SidePanel.tsx` — render `AIVerdictCard` between the description section and the existing heuristic recommendation cards.

**Interfaces:**
- Consumes: `getVerdictViaBridge` (Task 6), `VerdictResult`.
- Produces: no new exports beyond the two files.

- [ ] **Step 1: Create `extension/src/sidepanel/verdictCache.ts`:**

```ts
// Tiny in-process cache for AI verdicts, keyed on ticket id + a version tag (updated_at
// or a fetch timestamp) so re-opening a ticket doesn't burn a new bridge call.

import type { VerdictResult } from '../data/verdictTypes';

interface Entry { key: string; verdict: VerdictResult; storedAt: number }

const TTL_MS = 15 * 60_000; // 15 minutes
const entries = new Map<string, Entry>();

export function verdictCacheKey(ticketId: string, versionTag: string): string {
  return ticketId + '::' + versionTag;
}

export function getCachedVerdict(key: string): VerdictResult | null {
  const e = entries.get(key);
  if (!e) return null;
  if (Date.now() - e.storedAt > TTL_MS) { entries.delete(key); return null; }
  return e.verdict;
}

export function setCachedVerdict(key: string, verdict: VerdictResult): void {
  entries.set(key, { key, verdict, storedAt: Date.now() });
}
```

- [ ] **Step 2: Create `extension/src/sidepanel/AIVerdictCard.tsx`.** Full component:

```tsx
import { useEffect, useState } from 'react';
import type { WocooTicket } from '../data/mockTicket';
import type { VerdictResult } from '../data/verdictTypes';
import { getVerdictViaBridge } from '../api/bridge';
import { verdictCacheKey, getCachedVerdict, setCachedVerdict } from './verdictCache';

// AI verdict card — replaces the ad-hoc suggested response with a grounded
// recommendation using semantic retrieval over past tickets + Notion playbook.

interface AIVerdictCardProps {
  ticket: WocooTicket;
  // versionTag: any stable string that changes when the ticket's summary/description
  // or the sidepanel's understanding of it changes. Use ticket.updated || ticket.created.
  versionTag: string;
}

export function AIVerdictCard({ ticket, versionTag }: AIVerdictCardProps) {
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [verdict, setVerdict] = useState<VerdictResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const key = verdictCacheKey(ticket.id, versionTag);
    const cached = getCachedVerdict(key);
    if (cached) { setVerdict(cached); setState('ready'); return; }
    setState('loading');
    setError(null);
    let cancelled = false;
    getVerdictViaBridge({
      ticketId: ticket.id,
      summary: ticket.summary,
      description: ticket.description,
      originalWorkType: ticket.workType,
    }).then((v) => {
      if (cancelled) return;
      setVerdict(v);
      setCachedVerdict(key, v);
      setState('ready');
    }).catch((e) => {
      if (cancelled) return;
      setError(e instanceof Error ? e.message : String(e));
      setState('error');
    });
    return () => { cancelled = true; };
  }, [ticket.id, versionTag]);

  if (state === 'idle') return null;

  const container: React.CSSProperties = {
    border: '1px solid var(--mint-border, #d0d5dd)',
    borderRadius: 8,
    padding: 12,
    margin: '12px 0',
    background: 'var(--mint-highlight-bg-soft, #f4f7fb)',
  };

  if (state === 'loading') {
    return (
      <section style={container} aria-live="polite">
        <div style={{ fontWeight: 700, fontSize: 12, marginBottom: 4 }}>AI VERDICT</div>
        <div style={{ fontSize: 12, color: 'var(--mint-fg-soft, #667085)' }}>Analyzing ticket…</div>
      </section>
    );
  }

  if (state === 'error') {
    return (
      <section style={container}>
        <div style={{ fontWeight: 700, fontSize: 12, marginBottom: 4 }}>AI VERDICT</div>
        <div style={{ fontSize: 12, color: '#b42318' }}>AI unavailable: {error}</div>
      </section>
    );
  }

  if (!verdict) return null;

  return (
    <section style={container} aria-live="polite">
      <div style={{ fontWeight: 700, fontSize: 12, marginBottom: 8 }}>AI VERDICT</div>
      <div style={{ fontSize: 13, marginBottom: 6 }}>
        Likely work type: <b>{verdict.likely_work_type}</b> ({Math.round(verdict.confidence * 100)}%)
      </div>
      <div style={{ fontSize: 12, marginBottom: 6, color: 'var(--mint-fg-soft, #667085)' }}>
        Board: {verdict.board} · Novel: {verdict.novel ? 'yes' : 'no'} ({Math.round(verdict.novel_likelihood * 100)}%)
      </div>

      {verdict.steps.length > 0 ? (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', color: 'var(--mint-fg-soft, #667085)' }}>Recommended steps</div>
          <ol style={{ margin: '4px 0 0 16px', padding: 0, fontSize: 12 }}>
            {verdict.steps.map((s, i) => (<li key={i} style={{ marginBottom: 2 }}>{s}</li>))}
          </ol>
        </div>
      ) : null}

      {verdict.gotchas.length > 0 ? (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', color: 'var(--mint-fg-soft, #667085)' }}>Watch out for</div>
          <ul style={{ margin: '4px 0 0 16px', padding: 0, fontSize: 12 }}>
            {verdict.gotchas.map((g, i) => (<li key={i} style={{ marginBottom: 2 }}>{g}</li>))}
          </ul>
        </div>
      ) : null}

      {verdict.similar_tickets.length > 0 ? (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', color: 'var(--mint-fg-soft, #667085)' }}>Similar past tickets</div>
          <ul style={{ margin: '4px 0 0 0', padding: 0, listStyle: 'none', fontSize: 12 }}>
            {verdict.similar_tickets.map((t) => (
              <li key={t.ticket_id} style={{ marginBottom: 2 }}>
                <a href={'https://wealthsimple.atlassian.net/browse/' + t.ticket_id} target="_blank" rel="noreferrer" style={{ color: 'var(--mint-highlight-fg-strong, #175cd3)' }}>{t.ticket_id}</a>
                {' — '}{t.summary}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {verdict.playbook_sections.length > 0 ? (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', color: 'var(--mint-fg-soft, #667085)' }}>Playbook sections used</div>
          <div style={{ fontSize: 12, display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
            {verdict.playbook_sections.map((p) => (
              <span key={p.chunk_key} style={{ padding: '2px 6px', borderRadius: 8, background: 'var(--mint-highlight-bg, #e7f0fc)' }}>
                {p.page_title} → {p.chunk_key.split('/').pop()}
              </span>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}
```

- [ ] **Step 3: Wire `AIVerdictCard` into `SidePanel.tsx`.** Import at the top of `SidePanel.tsx`:

```tsx
import { AIVerdictCard } from './AIVerdictCard';
```

Then, in `TicketViewInner`, insert the card immediately AFTER the `{/* DESCRIPTION */}` closing `</section>` and BEFORE the NotePrompt block (which currently sits between description and QCAutoReimbCard):

```tsx
<AIVerdictCard
  ticket={ticket}
  versionTag={ticket.created /* or ticket.updated when available */}
/>
```

Use whichever ticket field changes when the ticket meaningfully changes — `created` is fine if `updated` isn't in `WocooTicket`; the cache TTL of 15 min will refresh eventually anyway.

- [ ] **Step 4: `npm run build`.** Expected: clean build.

- [ ] **Step 5: Reload the extension.** Open a WOCOO test ticket. Expected: sidepanel renders the `AIVerdictCard` under the description; card shows "Analyzing ticket…" for a few seconds, then populates with the AI verdict.

- [ ] **Step 6: Sanity check.** Two spot-checks:
  1. Verdict populates within ~10 s for a fresh ticket.
  2. Re-opening the same ticket in the same panel session hits the cache (no additional 10 s wait; card is instant).

If a verdict fails (bridge error, MagicAI error, empty verdict), the card shows "AI unavailable" and the existing heuristic recommendation cards below still work — no hard dependency.

---

## Task 8: Update memory

**Files:**
- Modify: `~/.claude/projects/-Users-albert-cai/memory/project_ticket_knowledge_loop.md` — flip Phase 2 status from "not built" to "shipped" (or note partial ship if the smoke tests reveal issues).

- [ ] **Step 1: Update the top blurb** so it reflects: Phase 1 Capture shipped, Phase 2 Retrieval shipped, Phase 3 novelty digest not built.

- [ ] **Step 2: Add a "Phase 2 code touch points" subsection** mirroring the existing "Phase 1 code touch points" subsection: sheet's `Playbook Embeddings` tab, `embedText` / `getVerdict` bridge actions, `embedTicketLogRows` worker + trigger, `AIVerdictCard.tsx`, `verdictCache.ts`, `verdictTypes.ts`.

- [ ] **Step 3: Verify the sync-runbook** (Task 5) is documented enough that a future session can execute "sync playbook" without asking. If it isn't, add a short bulleted runbook to `[[reference_ticket_log_sheet]]` (or a new memory).

---

## Verification Checklist (before declaring Phase 2 done)

- [ ] `VOYAGE_API_KEY` set in Script Properties; `embedTextWithVoyage` scratch test returns a 1024-dim vector.
- [ ] `Playbook Embeddings` tab exists with the 9-column header and frozen row 1.
- [ ] `embedTicketLogRows` trigger installed; runs every 5 min; existing Log rows have `embedding` + `embedded_at` populated.
- [ ] Playbook sync via Claude session populates `Playbook Embeddings` with one row per non-empty 5-block chunk of every work-type sub-page that has real content (not `_TBD_`).
- [ ] `handleGetVerdict` scratch test returns a plausible verdict JSON on a realistic Reverse-Fee input.
- [ ] `AIVerdictCard` renders in the sidepanel under the description, above the heuristic recommendation cards.
- [ ] `AIVerdictCard` populates within ~15 s on a fresh ticket; cache hit is instant on re-open.
- [ ] When MagicAI or Voyage errors, the card shows "AI unavailable" and the heuristic cards still work below it.

## Explicitly Deferred to Phase 3

- Novel-flag daily digest UI.
- Notion-write-back for AI-drafted new work-type sections.
- Change log auto-append on publish.
