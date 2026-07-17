# Mobile Cheque Validation — GAS Function Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the Apps Script side of Mobile Cheque Validation — three handlers (`runMobileChequeValidation`, `getMobileChequeValidationStatus`, `markMobileChequeValidationSent`) that satisfy the existing extension bridge contract, with a full Gmail-scrape → CSV-parse → VALIDATION-paste → Main-read → anomaly-check → cache pipeline.

**Architecture:** All work is in the Apps Script bridge's `code.gs` (web editor — no clasp per `feedback_no_clasp`). Task 1 pastes the entire MCV module (constants + helpers + handlers) and verifies it via the GAS Run button without touching the dispatcher. Task 2 wires the three dispatcher cases, re-deploys the Web App, and end-to-end tests via the extension's tile.

**Tech Stack:** Google Apps Script (V8 runtime), GmailApp, SpreadsheetApp, PropertiesService, Utilities. No extension-side changes — everything in the WOCOO Triager extension is already wired to consume these handlers.

## Global Constraints

- **Apps Script edits via the web editor only.** Per `feedback_no_clasp` — do not propose `clasp` commands. Paste the code blocks below verbatim into the GAS editor.
- **No extension build needed.** All changes are GAS-side. The extension picks up the new behavior automatically once the bridge re-deploys.
- **Spreadsheet ID is hardcoded** (`1hW-o3Mpu7SW_CH9mf9oYhN2Q9lPS9ndT7S4c0gynSfo`) inside the GAS module — Albert's owned sheet, not a parameter.
- **Tab names with spaces** (`RBC | Mobile  cheque returns (Day 1 rejects)` has a **double space** between "Mobile" and "cheque") must be preserved verbatim.
- **Re-deploy is required** after editing GAS code, per `reference_apps_script_gotchas` — Apps Script caches at deploy time.
- **Date math runs in `America/New_York`** (the spreadsheet's timezone) to align with how Preset sends the CSV and with the team's calendar.

---

## File Structure

| Path / surface | Change |
|---|---|
| Apps Script bridge `code.gs` (web editor) | Add ~250 lines of MCV module code: constants, date helpers, Gmail/CSV helpers, sheet I/O helpers, totals/anomaly logic, three top-level handlers (`runMobileChequeValidation`, `getMobileChequeValidationStatus`, `markMobileChequeValidationSent`). |
| Apps Script bridge `code.gs` dispatcher (`doGet` / `doPost`) | Add 3 new `case` branches routing the matching `action` query-params to the new handlers. |
| Apps Script deployment | Re-deploy the Web App via Deploy → Manage deployments → New version. |
| Extension-side code | **No changes.** Already wired. |

---

## Task 1: Paste the MCV module + direct smoke-test

**Files:**
- Modify (via GAS web editor): `code.gs` — append the MCV module at the end of the file.

**Interfaces:**
- Consumes: nothing from earlier tasks. GmailApp, SpreadsheetApp, PropertiesService, Utilities (all GAS built-ins).
- Produces:
  - `runMobileChequeValidation(): { record: MCVRecord }` — full pipeline.
  - `getMobileChequeValidationStatus(): { dateKey: string, record: MCVRecord | null }`
  - `markMobileChequeValidationSent({ dateKey: string }): { ok: true }`
  - The MCVRecord shape:
    ```
    {
      date: string (yyyy-MM-dd),
      status: 'ready' | 'anomaly',
      totals: { receivedCount, processedCount, day1Reversed, opsSlaBreach, riskSlaBreach },
      anomalies: [{ kind: string, detail: string }],
      sentAt: string | null
    }
    ```

- [ ] **Step 1: Open the GAS web editor** for the bridge project. Locate the existing `code.gs` file (or whichever file holds the dispatcher). Scroll to the very bottom.

- [ ] **Step 2: Paste the constants block** verbatim at the end of the file:

```js
// ============================================================
// Mobile Cheque Validation
// ============================================================
const MCV_SPREADSHEET_ID = '1hW-o3Mpu7SW_CH9mf9oYhN2Q9lPS9ndT7S4c0gynSfo';
const MCV_TIMEZONE = 'America/New_York';

const MCV_VALIDATION_TAB = 'VALIDATION';
const MCV_MAIN_TAB = 'Main';
const MCV_DAY1_TAB = 'RBC | Mobile  cheque returns (Day 1 rejects)'; // double space preserved verbatim

const MCV_MAIN_DATE_COL_INDEX = 13;     // M (1-indexed)
const MCV_MAIN_RECEIVED_COL_INDEX = 10; // J
const MCV_MAIN_OPS_SLA_COL_INDEX = 16;  // P
const MCV_MAIN_RISK_SLA_COL_INDEX = 17; // Q
const MCV_MAIN_FIRST_DATA_ROW = 2;
const MCV_MAIN_LAST_COL_TO_READ = 17;   // through Q

const MCV_DAY1_DATE_COL_INDEX = 5;             // E
const MCV_DAY1_FUNDING_INTENT_COL_INDEX = 29;  // AC
const MCV_DAY1_FIRST_DATA_ROW = 2;
const MCV_DAY1_LAST_COL_TO_READ = 29;          // through AC

const MCV_VALIDATION_FIRST_DATA_ROW = 2;
const MCV_VALIDATION_PASTE_COL_COUNT = 9; // cols A:I

const MCV_EMAIL_SENDER = 'no-reply-reports@bounces.preset.io';
const MCV_EMAIL_SUBJECT_PREFIX = '[Report] Mobile Cheque Validation - Daily CSV';

const MCV_CSV_COL_FUNDING_INTENT = 0;
const MCV_CSV_COL_CHEQUE_STATUS = 1;
const MCV_CSV_COL_REVERSAL_DATE = 2;

const MCV_PROPS_KEY_PREFIX = 'mcv_record_';

const MCV_OPS_SLA_THRESHOLD = 0;
const MCV_RISK_SLA_THRESHOLD = 6;

const MCV_ERROR_MARKERS = ['#N/A', '#REF!', '#VALUE!', '#ERROR!', '#NUM!', '#DIV/0!'];

function mcvLog(msg, extra) {
  if (extra !== undefined) Logger.log('[mcv] ' + msg + ' ' + JSON.stringify(extra));
  else Logger.log('[mcv] ' + msg);
}
```

- [ ] **Step 3: Paste the date helpers** immediately after the constants:

```js
function mcvPreviousBusinessDay(now) {
  let d = new Date(now);
  d.setDate(d.getDate() - 1);
  for (let i = 0; i < 7; i++) {
    const dow = Number(Utilities.formatDate(d, MCV_TIMEZONE, 'u')); // 1 = Mon, 7 = Sun
    if (dow < 6) return d;
    d.setDate(d.getDate() - 1);
  }
  return d;
}

function mcvDateKey(d) {
  return Utilities.formatDate(d, MCV_TIMEZONE, 'yyyy-MM-dd');
}
```

- [ ] **Step 4: Paste the Gmail + CSV helpers**:

```js
/** Find the most recent Preset email with the MCV subject prefix. Returns the
 *  CSV attachment text, or null if no matching email found within 48h. */
function mcvFindLatestPresetCsv() {
  const query = 'from:' + MCV_EMAIL_SENDER + ' subject:"' + MCV_EMAIL_SUBJECT_PREFIX + '" newer_than:2d';
  const threads = GmailApp.search(query, 0, 10);
  if (!threads || threads.length === 0) {
    mcvLog('no matching Gmail threads', { query: query });
    return null;
  }
  // Walk threads newest → oldest, return the first CSV attachment found.
  threads.sort(function (a, b) { return b.getLastMessageDate().getTime() - a.getLastMessageDate().getTime(); });
  for (let i = 0; i < threads.length; i++) {
    const messages = threads[i].getMessages();
    for (let j = messages.length - 1; j >= 0; j--) {
      const atts = messages[j].getAttachments();
      for (let k = 0; k < atts.length; k++) {
        const name = atts[k].getName() || '';
        if (/\.csv$/i.test(name)) {
          mcvLog('found CSV attachment', { name: name, threadIndex: i });
          return atts[k].getDataAsString();
        }
      }
    }
  }
  mcvLog('matching email(s) found but no CSV attachment');
  return null;
}

/** Parse the Preset CSV, skip the pandas-index column (col 0) and the header row.
 *  Returns rows as arrays-of-strings, one per data row, 9 cols each. */
function mcvParseCsv(text) {
  const all = Utilities.parseCsv(text);
  if (!all || all.length < 2) return [];
  const rows = all.slice(1); // drop header
  return rows.map(function (r) { return r.slice(1, 10); }); // drop col 0, keep cols 1..9
}
```

- [ ] **Step 5: Paste the sheet I/O helpers**:

```js
/** Clear VALIDATION!A2:I<lastRow>, then write the parsed CSV rows starting at A2.
 *  Col N and beyond are untouched. */
function mcvPasteCsvIntoValidation(rows) {
  const ss = SpreadsheetApp.openById(MCV_SPREADSHEET_ID);
  const sheet = ss.getSheetByName(MCV_VALIDATION_TAB);
  if (!sheet) throw new Error('VALIDATION tab not found: ' + MCV_VALIDATION_TAB);

  const lastRow = sheet.getLastRow();
  if (lastRow >= MCV_VALIDATION_FIRST_DATA_ROW) {
    sheet
      .getRange(MCV_VALIDATION_FIRST_DATA_ROW, 1, lastRow - MCV_VALIDATION_FIRST_DATA_ROW + 1, MCV_VALIDATION_PASTE_COL_COUNT)
      .clearContent();
  }

  if (rows.length === 0) return;
  sheet
    .getRange(MCV_VALIDATION_FIRST_DATA_ROW, 1, rows.length, MCV_VALIDATION_PASTE_COL_COUNT)
    .setValues(rows);

  SpreadsheetApp.flush();
}

/** Read Main!A2:Q<lastRow> once, filter to rows where col M (date) formats to dateKey,
 *  return [{ rowIndex, received, opsSla, riskSla }]. opsSla/riskSla may be a number
 *  or an error string starting with '#'. */
function mcvReadMainYesterdayRows(dateKey) {
  const ss = SpreadsheetApp.openById(MCV_SPREADSHEET_ID);
  const sheet = ss.getSheetByName(MCV_MAIN_TAB);
  if (!sheet) throw new Error('Main tab not found: ' + MCV_MAIN_TAB);

  const lastRow = sheet.getLastRow();
  if (lastRow < MCV_MAIN_FIRST_DATA_ROW) return [];
  const values = sheet
    .getRange(MCV_MAIN_FIRST_DATA_ROW, 1, lastRow - MCV_MAIN_FIRST_DATA_ROW + 1, MCV_MAIN_LAST_COL_TO_READ)
    .getValues();

  const out = [];
  for (let i = 0; i < values.length; i++) {
    const row = values[i];
    const dateVal = row[MCV_MAIN_DATE_COL_INDEX - 1];
    if (!dateVal) continue;
    // dateVal may be a Date object or a string. Normalize.
    let rowDateKey;
    if (dateVal instanceof Date) {
      rowDateKey = Utilities.formatDate(dateVal, MCV_TIMEZONE, 'yyyy-MM-dd');
    } else {
      rowDateKey = String(dateVal);
    }
    if (rowDateKey !== dateKey) continue;
    out.push({
      rowIndex: MCV_MAIN_FIRST_DATA_ROW + i,
      received: row[MCV_MAIN_RECEIVED_COL_INDEX - 1] === true,
      opsSla: row[MCV_MAIN_OPS_SLA_COL_INDEX - 1],
      riskSla: row[MCV_MAIN_RISK_SLA_COL_INDEX - 1],
    });
  }
  return out;
}

/** Read Day 1 Rejects tab A2:AC<lastRow>, filter to rows where col E (date) formats
 *  to dateKey, return [{ rowIndex, fundingIntent }]. */
function mcvReadDay1YesterdayRows(dateKey) {
  const ss = SpreadsheetApp.openById(MCV_SPREADSHEET_ID);
  const sheet = ss.getSheetByName(MCV_DAY1_TAB);
  if (!sheet) throw new Error('Day 1 Rejects tab not found: ' + MCV_DAY1_TAB);

  const lastRow = sheet.getLastRow();
  if (lastRow < MCV_DAY1_FIRST_DATA_ROW) return [];
  const values = sheet
    .getRange(MCV_DAY1_FIRST_DATA_ROW, 1, lastRow - MCV_DAY1_FIRST_DATA_ROW + 1, MCV_DAY1_LAST_COL_TO_READ)
    .getValues();

  const out = [];
  for (let i = 0; i < values.length; i++) {
    const row = values[i];
    const dateVal = row[MCV_DAY1_DATE_COL_INDEX - 1];
    if (!dateVal) continue;
    let rowDateKey;
    if (dateVal instanceof Date) {
      rowDateKey = Utilities.formatDate(dateVal, MCV_TIMEZONE, 'yyyy-MM-dd');
    } else {
      rowDateKey = String(dateVal);
    }
    if (rowDateKey !== dateKey) continue;
    out.push({
      rowIndex: MCV_DAY1_FIRST_DATA_ROW + i,
      fundingIntent: row[MCV_DAY1_FUNDING_INTENT_COL_INDEX - 1],
    });
  }
  return out;
}
```

- [ ] **Step 6: Paste totals + anomaly + error-cell helpers**:

```js
function mcvIsErrorCell(value) {
  if (typeof value !== 'string') return false;
  for (let i = 0; i < MCV_ERROR_MARKERS.length; i++) {
    if (value.indexOf(MCV_ERROR_MARKERS[i]) !== -1) return true;
  }
  return false;
}

function mcvComputeTotals(csvRows, dateKey, mainRows, day1Rows) {
  const receivedCount = mainRows.filter(function (r) { return r.received === true; }).length;
  const processedCount = csvRows.filter(function (r) {
    return r[MCV_CSV_COL_REVERSAL_DATE] === dateKey;
  }).length;
  const day1Reversed = day1Rows.length;
  const opsSlaBreach = mainRows.filter(function (r) {
    return typeof r.opsSla === 'number' && r.opsSla > MCV_OPS_SLA_THRESHOLD;
  }).length;
  const riskSlaBreach = mainRows.filter(function (r) {
    return typeof r.riskSla === 'number' && r.riskSla > MCV_RISK_SLA_THRESHOLD;
  }).length;
  return { receivedCount: receivedCount, processedCount: processedCount, day1Reversed: day1Reversed, opsSlaBreach: opsSlaBreach, riskSlaBreach: riskSlaBreach };
}

function mcvComputeAnomalies(csvRows, totals, mainRows, day1Rows) {
  const anomalies = [];

  if (totals.receivedCount !== totals.processedCount) {
    anomalies.push({
      kind: 'count_mismatch',
      detail: 'received=' + totals.receivedCount + ', processed=' + totals.processedCount,
    });
  }

  const errorRows = mainRows.filter(function (r) {
    return mcvIsErrorCell(r.opsSla) || mcvIsErrorCell(r.riskSla);
  });
  if (errorRows.length > 0) {
    const sample = errorRows.slice(0, 10).map(function (r) { return r.rowIndex; }).join(', ');
    anomalies.push({
      kind: 'pq_errors',
      detail: errorRows.length + ' rows with formula errors in cols P/Q (rows: ' + sample + (errorRows.length > 10 ? ', …' : '') + ')',
    });
  }

  const csvFundingIntents = {};
  csvRows.forEach(function (r) { csvFundingIntents[String(r[MCV_CSV_COL_FUNDING_INTENT] || '')] = true; });
  const unreversed = day1Rows.filter(function (r) {
    return !csvFundingIntents[String(r.fundingIntent || '')];
  });
  if (unreversed.length > 0) {
    const sample = unreversed.slice(0, 5).map(function (r) { return r.fundingIntent; }).join(', ');
    anomalies.push({
      kind: 'day1_unreversed',
      detail: unreversed.length + ' Day 1 Rejects not in CSV (i.e. not reversed yet): ' + sample + (unreversed.length > 5 ? ', …' : ''),
    });
  }

  return anomalies;
}

function mcvBuildErrorRecord(dateKey, kind, detail) {
  return {
    date: dateKey,
    status: 'anomaly',
    totals: { receivedCount: 0, processedCount: 0, day1Reversed: 0, opsSlaBreach: 0, riskSlaBreach: 0 },
    anomalies: [{ kind: kind, detail: detail }],
    sentAt: null,
  };
}

function mcvCacheRecord(record) {
  PropertiesService.getScriptProperties().setProperty(
    MCV_PROPS_KEY_PREFIX + record.date,
    JSON.stringify(record),
  );
}

function mcvLoadRecord(dateKey) {
  const raw = PropertiesService.getScriptProperties().getProperty(MCV_PROPS_KEY_PREFIX + dateKey);
  return raw ? JSON.parse(raw) : null;
}
```

- [ ] **Step 7: Paste the three top-level handlers**:

```js
function runMobileChequeValidation() {
  const now = new Date();
  const targetDate = mcvPreviousBusinessDay(now);
  const dateKey = mcvDateKey(targetDate);
  mcvLog('runMobileChequeValidation start', { dateKey: dateKey });

  try {
    const csvText = mcvFindLatestPresetCsv();
    if (csvText === null) {
      const errRec = mcvBuildErrorRecord(dateKey, 'no_email', 'no Preset email matched within last 48h');
      mcvCacheRecord(errRec);
      return { record: errRec };
    }
    const csvRows = mcvParseCsv(csvText);
    mcvLog('parsed CSV rows', { count: csvRows.length });

    mcvPasteCsvIntoValidation(csvRows);
    Utilities.sleep(2000); // let Main's VLOOKUPs recalc

    const mainRows = mcvReadMainYesterdayRows(dateKey);
    const day1Rows = mcvReadDay1YesterdayRows(dateKey);
    mcvLog('main/day1 yesterday rows', { mainCount: mainRows.length, day1Count: day1Rows.length });

    const totals = mcvComputeTotals(csvRows, dateKey, mainRows, day1Rows);
    const anomalies = mcvComputeAnomalies(csvRows, totals, mainRows, day1Rows);

    const record = {
      date: dateKey,
      status: anomalies.length > 0 ? 'anomaly' : 'ready',
      totals: totals,
      anomalies: anomalies,
      sentAt: null,
    };
    mcvCacheRecord(record);
    mcvLog('runMobileChequeValidation complete', { status: record.status, anomalyCount: anomalies.length });
    return { record: record };
  } catch (e) {
    mcvLog('runMobileChequeValidation failed', { error: String(e) });
    const errRec = mcvBuildErrorRecord(dateKey, 'pipeline_error', String(e && e.message ? e.message : e));
    mcvCacheRecord(errRec);
    return { record: errRec };
  }
}

function getMobileChequeValidationStatus() {
  const targetDate = mcvPreviousBusinessDay(new Date());
  const dateKey = mcvDateKey(targetDate);
  const record = mcvLoadRecord(dateKey);
  return { dateKey: dateKey, record: record };
}

function markMobileChequeValidationSent(args) {
  const dateKey = args && args.dateKey ? args.dateKey : '';
  if (!dateKey) throw new Error('markMobileChequeValidationSent: missing dateKey');
  const record = mcvLoadRecord(dateKey);
  if (!record) throw new Error('No cached record for ' + dateKey);
  record.sentAt = new Date().toISOString();
  mcvCacheRecord(record);
  return { ok: true };
}
```

- [ ] **Step 8: Save the GAS file** (⌘S / Ctrl+S in the editor).

- [ ] **Step 9: Direct smoke-test via the Run button.** In the GAS editor's function dropdown (top toolbar, next to the Run button), pick `runMobileChequeValidation`. Click Run.

Expected: the first time, you may be prompted to authorize permissions (Gmail read, Sheets edit, ScriptProperties). Approve. Then the function runs.

Open **Executions** in the left sidebar to see the result. The latest execution should be `Completed`. Inside it, the Logs panel should show:
- `[mcv] runMobileChequeValidation start {"dateKey":"<yesterday>"}`
- `[mcv] found CSV attachment {"name":"...csv","threadIndex":0}`
- `[mcv] parsed CSV rows {"count":<N>}`
- `[mcv] main/day1 yesterday rows {"mainCount":<X>,"day1Count":<Y>}`
- `[mcv] runMobileChequeValidation complete {"status":"<ready|anomaly>","anomalyCount":<N>}`

If any line is missing or the execution shows `Failed`, look at the log entry just before to see what blew up.

- [ ] **Step 10: Verify the sheet was modified.** Open the Tracker spreadsheet in a browser tab. Switch to the `VALIDATION` tab. Expect: cols A:I starting at row 2 are populated with CSV data; col N still has whatever it had before; row 1 (headers) untouched.

Switch to the `Main` tab. Yesterday's date rows in col M should have populated values in cols P and Q (no #N/A errors).

- [ ] **Step 11: Verify the cached record via getStatus.** In the GAS function dropdown, pick `getMobileChequeValidationStatus` → click Run. In Executions → Logs, the return value should appear as a JSON object: `{dateKey: "<yesterday>", record: {...}}`. Confirm `record.status`, `record.totals`, and `record.anomalies` look right.

- [ ] **Step 12: Verify markSent works.** In the GAS editor, add a temporary test function at the bottom (delete after):

```js
function testMarkSent() {
  const status = getMobileChequeValidationStatus();
  Logger.log('before: ' + JSON.stringify(status));
  const result = markMobileChequeValidationSent({ dateKey: status.dateKey });
  Logger.log('result: ' + JSON.stringify(result));
  const after = getMobileChequeValidationStatus();
  Logger.log('after: ' + JSON.stringify(after.record));
}
```

Run `testMarkSent`. Expect the `after` log to show `sentAt` populated with an ISO timestamp. Delete `testMarkSent` after the test passes (or leave it — harmless).

---

## Task 2: Wire dispatcher + re-deploy + end-to-end test through extension

**Files:**
- Modify (via GAS web editor): `code.gs` — add 3 cases to the existing dispatcher.
- Deploy: GAS Web App via Deploy → Manage deployments → New version.

**Interfaces:**
- Consumes: Task 1's `runMobileChequeValidation`, `getMobileChequeValidationStatus`, `markMobileChequeValidationSent` functions.
- Produces: bridge actions reachable via `callBridge('runMobileChequeValidation', {}, 'mobileChequeValidationRun')` (and the other two), so the extension's `MobileChequeValidationTile` works end-to-end.

- [ ] **Step 1: Locate the existing dispatcher.** In `code.gs`, find your `doGet(e)` or `doPost(e)` function. It will have something like:

```js
function doGet(e) {
  const action = e.parameter.action || '';
  switch (action) {
    case 'readPendingWires': { /* ... */ return postReplyToParent('pendingWiresRead', result); }
    case 'sendKohoEmail':    { /* ... */ return postReplyToParent('kohoEmailSent',    result); }
    // ... other cases
  }
  // fallback...
}
```

The exact syntax (switch vs if-else) and reply-helper name (`postReplyToParent`, `replyToParent`, inline HtmlService template, etc.) vary by your bridge's history. Match whatever pattern your existing cases use.

- [ ] **Step 2: Add the three new cases** alongside the existing ones. Drop these inside the dispatcher's switch (or as new `if/else if` branches) — adapt the reply-helper call to match your bridge's existing convention. Below assumes a `postReplyToParent(replyAction, payload)` helper (common pattern); if your bridge uses something else, substitute the equivalent.

```js
    case 'runMobileChequeValidation': {
      const result = runMobileChequeValidation();
      return postReplyToParent('mobileChequeValidationRun', result);
    }
    case 'getMobileChequeValidationStatus': {
      const result = getMobileChequeValidationStatus();
      return postReplyToParent('mobileChequeValidationStatus', result);
    }
    case 'markMobileChequeValidationSent': {
      const result = markMobileChequeValidationSent({ dateKey: e.parameter.dateKey || '' });
      return postReplyToParent('mobileChequeValidationMarkSent', result);
    }
```

The reply-action names (`mobileChequeValidationRun`, `mobileChequeValidationStatus`, `mobileChequeValidationMarkSent`) MUST be these exact strings — they match what the extension's `callBridge(..., expectedReply)` is listening for.

- [ ] **Step 3: Save the GAS file.**

- [ ] **Step 4: Re-deploy the Web App.** Click **Deploy** (top right) → **Manage deployments** → click the pencil/edit icon on the existing Web App deployment → **Version**: dropdown → **New version** → optional description "MCV handlers" → click **Deploy**.

The URL should NOT change (deployment URL is sticky if you edit-in-place). Confirm by copying the displayed URL after deploy and checking it matches the `BRIDGE_URL` constant the extension uses (in `src/api/bridge.ts`'s top).

- [ ] **Step 5: Clear the auto-attempt gate on the extension side** so the catch-up will fire today. In any open Chrome DevTools window (e.g. the side panel's), run:

```js
chrome.storage.local.remove(['mcv_auto_attempt_date', 'mcv_record_cache']);
```

(The second key isn't critical — included only if you've ever set one manually.)

- [ ] **Step 6: Reload the extension.** `chrome://extensions` → reload "WOCOO Triager".

- [ ] **Step 7: End-to-end test via the tile.**

  1. Open the side panel on any WOCOO ticket (or the Home view if MCV lives there).
  2. Scroll to the **Mobile Cheque Validation** tile.
  3. The tile should auto-fire `runNow()` if past 9 AM local AND no record cached. Wait ~10-30s for the bridge call.
  4. Tile transitions out of "Checking…" into either:
     - **"✅ Ready to post for <date> — N/N/N/N/N"** if no anomalies, OR
     - **"⚠ Validation needs attention — N issue(s)"** if anomalies detected.
  5. Click the tile → modal opens with the editable Slack draft prefilled.

- [ ] **Step 8: Verify cache hit on second load.** Close the side panel, reopen it. The tile should render the same state instantly (no spinner) because the bridge's `getMobileChequeValidationStatus` returns the cached record without re-running the pipeline.

- [ ] **Step 9: Sanity — existing bridge actions still work.**

  1. Open a WOCOO ticket and run a `Wires Pending Posting` pass (uses `readPendingWiresViaBridge`). Confirm it still works end-to-end.
  2. Trigger a `sendKohoEmail` via the Koho card if you have a ticket that surfaces it. Confirm send works.
  3. The new dispatcher cases are additive — existing actions should be unaffected.

- [ ] **Step 10 (optional): Send the Slack message to verify the markSent path.**

  1. From the MCV modal, click **Send to channel** (or **Send DM to self** for anomaly path).
  2. Slack tab opens, content script posts.
  3. After posting, the extension calls `markMobileChequeValidationSentViaBridge(dateKey)`.
  4. The tile transitions to "✓ Sent <time> for <date>".
  5. Verify in the GAS editor: run `getMobileChequeValidationStatus` → the returned `record.sentAt` should be populated.

---

## Self-Review Summary

After writing the plan, checked it against the spec:

- **Spec coverage:**
  - Constants block → Task 1 Step 2.
  - Date logic (previous business day, skip weekends) → Task 1 Step 3 (`mcvPreviousBusinessDay`).
  - Gmail + CSV helpers → Task 1 Step 4.
  - Clear-then-write VALIDATION paste + Main read + Day 1 read → Task 1 Step 5.
  - Five totals (received from Main!J, processed from CSV, day1Reversed from Day 1 tab, ops/risk breaches from Main!P/Q) → Task 1 Step 6 (`mcvComputeTotals`).
  - Three anomaly checks (count mismatch, P/Q errors, Day 1 unreversed) → Task 1 Step 6 (`mcvComputeAnomalies`).
  - ScriptProperties caching keyed by date → Task 1 Step 6 (`mcvCacheRecord` + `mcvLoadRecord`).
  - Three top-level handlers (`runMobileChequeValidation`, `getMobileChequeValidationStatus`, `markMobileChequeValidationSent`) → Task 1 Step 7.
  - Error envelope (`buildErrorRecord` + try/catch around the pipeline) → Task 1 Step 6 (`mcvBuildErrorRecord`) and Task 1 Step 7 (try/catch in `runMobileChequeValidation`).
  - Dispatcher wiring with exact `expectedReply` strings → Task 2 Step 2.
  - Re-deploy convention → Task 2 Step 4.
  - End-to-end via extension tile → Task 2 Steps 5–10.
- **Placeholder scan:** No "TBD"/"TODO". The dispatcher's `postReplyToParent` call name is explicitly flagged as needing adaptation to the bridge's existing reply-helper convention — that's a real environmental variation, not a placeholder.
- **Type consistency:** `MCVRecord` shape consistent across `runMobileChequeValidation` return, `mcvCacheRecord`/`mcvLoadRecord` JSON, and extension's `MCVRecord` interface in `bridge.ts`. Reply-action strings (`mobileChequeValidationRun`/`Status`/`MarkSent`) match the existing `callBridge` calls in `src/api/bridge.ts`.
- **Scope:** One focused feature, GAS-only, two tasks. Single plan, right shape.
