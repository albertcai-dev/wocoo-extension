# Mobile Cheque Validation — Apps Script (GAS) Function

**Date**: 2026-06-25
**Author**: Albert Cai (with Claude)
**Status**: Draft, pending implementation
**Depends on**: existing extension-side scaffolding (`MobileChequeValidationTile`, `chequeValidationScheduler`, bridge wrappers) — all shipped.

## Problem

The extension's `MobileChequeValidationTile` calls three bridge actions (`runMobileChequeValidation`, `getMobileChequeValidationStatus`, `markMobileChequeValidationSent`) that don't yet have Apps Script handlers. Today the tile reports `"Bridge returned no validation record"` because the GAS dispatcher either has no case for `runMobileChequeValidation` or returns an empty payload. This spec defines those three handlers + the data pipeline they orchestrate.

## Goals

- Implement `parseTranscript`-style GAS handlers wired into the existing bridge dispatcher.
- `runMobileChequeValidation` performs the daily validation pipeline end-to-end: Gmail scrape → CSV parse → VALIDATION tab paste → Main tab read → anomaly checks → cache record.
- `getMobileChequeValidationStatus` returns the cached record for the current target date without re-running.
- `markMobileChequeValidationSent` patches `sentAt` on the cached record after the agent posts to Slack.
- Cache survives across days (records keyed by ISO date) so historical lookups remain possible without re-running.

## Non-Goals

- Bank-holiday handling. v1 treats Sat/Sun as non-business days but doesn't skip Canadian banking holidays. A `BANK_HOLIDAYS` constant can be added later.
- Re-running historic validations. The pipeline always targets the most recent business day relative to "now in America/New_York"; back-runs are not exposed.
- Anomaly auto-remediation. The function detects anomalies and surfaces them; the agent investigates manually.
- Validating cheques that arrived more than 1 business day ago. Only yesterday's cohort is reconciled.

## Constants (top of `code.gs`)

```js
// ===== Mobile Cheque Validation config =====
const MCV_SPREADSHEET_ID = '1hW-o3Mpu7SW_CH9mf9oYhN2Q9lPS9ndT7S4c0gynSfo';
const MCV_TIMEZONE = 'America/New_York';

const MCV_VALIDATION_TAB = 'VALIDATION';
const MCV_MAIN_TAB = 'Main';
const MCV_DAY1_TAB = 'RBC | Mobile  cheque returns (Day 1 rejects)'; // double space preserved verbatim

// Main tab columns
const MCV_MAIN_DATE_COL = 'M';                 // Cheque image received date
const MCV_MAIN_RECEIVED_COL = 'J';             // Cheque image received? (TRUE/FALSE)
const MCV_MAIN_OPS_SLA_COL = 'P';              // OPS REVERSAL SLA — breach when > 0
const MCV_MAIN_RISK_SLA_COL = 'Q';             // RISK SLA — breach when > 6
const MCV_MAIN_FIRST_DATA_ROW = 2;             // row 1 = headers

// Day 1 Rejects tab columns
const MCV_DAY1_DATE_COL = 'E';
const MCV_DAY1_FUNDING_INTENT_COL = 'AC';

// VALIDATION paste target — write CSV (minus pandas index col) into cols A:I,
// starting row 2, after clearing the prior day's paste. Col N is left untouched
// per the sheet's existing protection.
const MCV_VALIDATION_FIRST_COL = 'A';
const MCV_VALIDATION_LAST_COL = 'I';
const MCV_VALIDATION_FIRST_DATA_ROW = 2;

// Gmail search
const MCV_EMAIL_SENDER = 'no-reply-reports@bounces.preset.io';
const MCV_EMAIL_SUBJECT_PREFIX = '[Report] Mobile Cheque Validation - Daily CSV';

// CSV column indices AFTER skipping pandas index column (col 0 of raw CSV)
const MCV_CSV_COL_FUNDING_INTENT = 0;
const MCV_CSV_COL_CHEQUE_STATUS = 1;
const MCV_CSV_COL_REVERSAL_DATE = 2;
// (others not consumed by the validation pipeline; preserved in the paste)

// ScriptProperties key prefix for cached records
const MCV_PROPS_KEY_PREFIX = 'mcv_record_'; // → mcv_record_2026-06-24

// SLA thresholds
const MCV_OPS_SLA_THRESHOLD = 0;  // breach when value > 0 BD
const MCV_RISK_SLA_THRESHOLD = 6; // breach when value > 6 BD

// Cell-error markers we scan for in P/Q
const MCV_ERROR_MARKERS = ['#N/A', '#REF!', '#VALUE!', '#ERROR!', '#NUM!', '#DIV/0!'];
```

## Date logic — "previous business day"

```js
/** Return the date object representing the previous business day from `now`,
 *  in MCV_TIMEZONE. Weekend dates (Sat/Sun) are skipped. Time portion is set
 *  to midnight in MCV_TIMEZONE for stable date comparisons. */
function mcvPreviousBusinessDay(now) {
  const tz = MCV_TIMEZONE;
  // Walk back one day at a time until a weekday is found.
  let d = new Date(now);
  d.setDate(d.getDate() - 1);
  for (let i = 0; i < 7; i++) {
    const dow = Number(Utilities.formatDate(d, tz, 'u')); // 1 = Mon, 7 = Sun
    if (dow < 6) return d; // 1..5 = Mon..Fri
    d.setDate(d.getDate() - 1);
  }
  return d; // fallback — shouldn't reach
}

function mcvDateKey(d) {
  return Utilities.formatDate(d, MCV_TIMEZONE, 'yyyy-MM-dd');
}
```

Behavior table:

| Today (in ET) | dateKey |
|---|---|
| Mon | previous Fri |
| Tue | Mon |
| Wed | Tue |
| Thu | Wed |
| Fri | Thu |
| Sat | Fri |
| Sun | Fri |

## Pipeline — `runMobileChequeValidation`

```
1. Compute targetDate (previous business day in ET) and dateKey ("yyyy-MM-dd").
2. Find latest matching Gmail email (within last 48h to tolerate weekends):
   GmailApp.search('from:' + MCV_EMAIL_SENDER + ' subject:"' + MCV_EMAIL_SUBJECT_PREFIX + '" newer_than:2d')
   Pick the freshest thread. Extract the first CSV attachment.
   If none found → return error record (status='anomaly', anomaly kind='no_email').
3. Parse CSV with Utilities.parseCsv. Skip pandas index col (col 0); retain cols 1..9.
   Skip the header row (first row).
4. Clear VALIDATION!A2:I<lastRow> on the sheet, then write the parsed rows starting at A2.
   SpreadsheetApp.flush() to commit + trigger Main's formulas.
5. Brief sleep (Utilities.sleep(2000)) — Main's VLOOKUPs sometimes need a moment
   to recalc after a large bulk write.
6. Read totals (see below).
7. Run anomaly checks (see below).
8. Build MCVRecord:
     { date: dateKey, status: anomalies.length ? 'anomaly' : 'ready',
       totals, anomalies, sentAt: null }
9. Cache via PropertiesService.getScriptProperties().setProperty(
     MCV_PROPS_KEY_PREFIX + dateKey, JSON.stringify(record))
10. Return { record }.
```

## Totals — all scoped to yesterday in ET

```js
function mcvComputeTotals(csvRows, dateKey) {
  const main = mcvReadMainYesterdayRows(dateKey);
  const day1 = mcvReadDay1YesterdayRows(dateKey);

  // receivedCount = rows in Main where M=yesterday AND J=TRUE
  const receivedCount = main.filter((r) => r.received === true).length;

  // processedCount = rows in CSV where reversal_date = yesterday
  const processedCount = csvRows.filter((r) => r[MCV_CSV_COL_REVERSAL_DATE] === dateKey).length;

  // day1Reversed = count of Day 1 Rejects rows where E=yesterday
  const day1Reversed = day1.length;

  // opsSlaBreach = count of Main yesterday rows where P > 0 (skip error cells)
  const opsSlaBreach = main.filter((r) => typeof r.opsSla === 'number' && r.opsSla > MCV_OPS_SLA_THRESHOLD).length;

  // riskSlaBreach = count of Main yesterday rows where Q > 6 (skip error cells)
  const riskSlaBreach = main.filter((r) => typeof r.riskSla === 'number' && r.riskSla > MCV_RISK_SLA_THRESHOLD).length;

  return { receivedCount, processedCount, day1Reversed, opsSlaBreach, riskSlaBreach };
}
```

`mcvReadMainYesterdayRows(dateKey)` reads `Main!A2:Q<lastRow>` once, filters to rows where col M (date) formats to dateKey, returns `[{ rowIndex, received, opsSla, riskSla }]`. The `opsSla` and `riskSla` fields are raw cell values — numbers when the formula succeeded, strings starting with `#` (e.g. `#N/A`) when it errored. Both totals and the error scan read these same fields. Single read for both totals + error scan.

`mcvReadDay1YesterdayRows(dateKey)` reads `Day1!A2:AC<lastRow>`, filters to rows where col E = dateKey, returns `[{ rowIndex, fundingIntent }]`.

## Anomaly checks

```js
function mcvComputeAnomalies(csvRows, totals, mainRows, day1Rows) {
  const anomalies = [];

  // 1. Count mismatch
  if (totals.receivedCount !== totals.processedCount) {
    anomalies.push({
      kind: 'count_mismatch',
      detail: 'received=' + totals.receivedCount + ', processed=' + totals.processedCount,
    });
  }

  // 2. P/Q error cells in yesterday's row range
  const errorRows = mainRows.filter((r) => mcvIsErrorCell(r.opsSla) || mcvIsErrorCell(r.riskSla));
  if (errorRows.length > 0) {
    anomalies.push({
      kind: 'pq_errors',
      detail: errorRows.length + ' rows with #N/A / #REF! / #VALUE! / #ERROR! in cols P/Q ' +
              '(rows: ' + errorRows.map((r) => r.rowIndex).slice(0, 10).join(', ') +
              (errorRows.length > 10 ? ', …' : '') + ')',
    });
  }

  // 3. Day 1 Rejects unreversed
  const csvFundingIntents = new Set(csvRows.map((r) => String(r[MCV_CSV_COL_FUNDING_INTENT] || '')));
  const unreversed = day1Rows.filter((r) => !csvFundingIntents.has(String(r.fundingIntent || '')));
  if (unreversed.length > 0) {
    anomalies.push({
      kind: 'day1_unreversed',
      detail: unreversed.length + ' Day 1 Rejects not in CSV (i.e. not reversed yet): ' +
              unreversed.map((r) => r.fundingIntent).slice(0, 5).join(', ') +
              (unreversed.length > 5 ? ', …' : ''),
    });
  }

  return anomalies;
}

function mcvIsErrorCell(value) {
  if (typeof value !== 'string') return false;
  return MCV_ERROR_MARKERS.some((m) => value.indexOf(m) !== -1);
}
```

The CSV is already filtered to `state='reversed'`, so a Day 1 Rejects row appearing in the CSV implies reversed. Absence = unreversed = anomaly.

## Dispatcher actions

The existing bridge `doGet(e)` / `doPost(e)` already routes `action` via a switch. Three new cases:

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

Top-level functions:

```js
function runMobileChequeValidation() {
  const targetDate = mcvPreviousBusinessDay(new Date());
  const dateKey = mcvDateKey(targetDate);

  // ... pipeline steps 2-9 ...

  return { record };
}

function getMobileChequeValidationStatus() {
  const dateKey = mcvDateKey(mcvPreviousBusinessDay(new Date()));
  const stored = PropertiesService.getScriptProperties().getProperty(MCV_PROPS_KEY_PREFIX + dateKey);
  return { dateKey, record: stored ? JSON.parse(stored) : null };
}

function markMobileChequeValidationSent(args) {
  const key = MCV_PROPS_KEY_PREFIX + args.dateKey;
  const stored = PropertiesService.getScriptProperties().getProperty(key);
  if (!stored) throw new Error('No cached record for ' + args.dateKey);
  const record = JSON.parse(stored);
  record.sentAt = new Date().toISOString();
  PropertiesService.getScriptProperties().setProperty(key, JSON.stringify(record));
  return { ok: true };
}
```

## Error envelope

Pipeline failures (no email, sheet permission denied, etc.) don't crash the function — they produce a record with `status: 'anomaly'` and an explanatory entry in `anomalies[]`. The bridge always sees a `{ record: ... }` payload, so the extension never gets the "Bridge returned no validation record" error again.

```js
function buildErrorRecord(dateKey, kind, detail) {
  return {
    date: dateKey,
    status: 'anomaly',
    totals: { receivedCount: 0, processedCount: 0, day1Reversed: 0, opsSlaBreach: 0, riskSlaBreach: 0 },
    anomalies: [{ kind, detail }],
    sentAt: null,
  };
}
```

Wrap the pipeline in `try/catch`; on any throw, build an error record with `kind: 'pipeline_error'`, cache it as today's record (so re-clicking Run doesn't retry an infinite loop), and return.

## VALIDATION paste — clear-then-write

```js
function mcvPasteCsvIntoValidation(rows) {
  const ss = SpreadsheetApp.openById(MCV_SPREADSHEET_ID);
  const sheet = ss.getSheetByName(MCV_VALIDATION_TAB);
  if (!sheet) throw new Error('VALIDATION tab not found');

  const lastRow = sheet.getLastRow();
  if (lastRow >= MCV_VALIDATION_FIRST_DATA_ROW) {
    // Clear cols A:I from row 2 to the last used row. Leaves col N alone.
    sheet
      .getRange(MCV_VALIDATION_FIRST_DATA_ROW, 1, lastRow - 1, 9) // A..I
      .clearContent();
  }

  if (rows.length === 0) return; // nothing to paste
  sheet
    .getRange(MCV_VALIDATION_FIRST_DATA_ROW, 1, rows.length, 9)
    .setValues(rows);

  SpreadsheetApp.flush();
}
```

## Architecture

| Path / surface | Change |
|---|---|
| Apps Script bridge `code.gs` (web editor, no clasp) | Add all constants, `mcvPreviousBusinessDay`, `mcvDateKey`, `mcvFindLatestPresetCsv`, `mcvParseCsv`, `mcvPasteCsvIntoValidation`, `mcvReadMainYesterdayRows`, `mcvReadDay1YesterdayRows`, `mcvComputeTotals`, `mcvComputeAnomalies`, `mcvIsErrorCell`, `buildErrorRecord`, `runMobileChequeValidation`, `getMobileChequeValidationStatus`, `markMobileChequeValidationSent`. Wire 3 new cases into the `doGet`/`doPost` dispatcher. |
| Extension-side code (`bridge.ts`, `MobileChequeValidation.tsx`, scheduler) | No changes — already wired to call these actions and consume `{ record }`. |

## Error Handling

- **No matching email**: pipeline returns `{ record: errorRecord(kind='no_email', detail='no Preset email matched within last 48h') }`. Tile renders the anomaly path.
- **CSV missing attachment / wrong type**: same — `kind='bad_email'` with detail.
- **Sheet permission denied**: `kind='sheet_access'` with the underlying exception message.
- **Pipeline exception**: any throw is caught at the top of `runMobileChequeValidation`, wrapped in `kind='pipeline_error'`, cached, and returned.
- **`getMobileChequeValidationStatus` on a day with no cached record**: returns `{ dateKey, record: null }`. The tile shows "No run yet" and exposes the Run Now button.
- **`markMobileChequeValidationSent` for a non-existent dateKey**: throws `'No cached record for <dateKey>'`. The extension catches via `callBridge`'s reject path.

## Edge Cases

- **Multiple matching emails (e.g. test run + real)**: `mcvFindLatestPresetCsv` picks the most recent thread, sorted by `messageDate` desc.
- **CSV has 0 rows after header**: VALIDATION paste skips, totals all 0, anomalies likely fire (no Day 1 unreversed if no Day 1 rows either, but `count_mismatch` won't fire if both received and processed are 0). Channel post proceeds with all zeros.
- **Time zone weirdness across DST**: dates are formatted via `Utilities.formatDate(d, 'America/New_York', 'yyyy-MM-dd')` — Apps Script handles DST internally.
- **Day 1 Rejects has a row whose AC value matches a CSV funding_intent but with `cheque_status !== 'reversed'`**: since the CSV is pre-filtered to `state='reversed'`, this case CAN'T happen — every row in the CSV is reversed by construction.
- **Sheet's protected col N during paste**: `getRange(...).setValues(...)` writes only the explicit range; col N is outside it and untouched.

## Testing

Manual, GAS-side.

1. **Smoke — happy path**: in the GAS web editor, run `runMobileChequeValidation()` directly via the Run button. Inspect the Logger output / returned value:
   - Open the VALIDATION tab in the spreadsheet: confirm rows starting at A2, prior rows cleared.
   - Open Main: confirm formulas recalc (no #N/A in P/Q for yesterday's rows).
   - Confirm `record.status === 'ready'` AND `record.totals` looks right.
   - Open ScriptProperties (Settings → Script Properties): confirm `mcv_record_<yesterday>` key exists.
2. **Smoke — getStatus**: run `getMobileChequeValidationStatus()`. Expect the same record back without re-running the pipeline.
3. **Smoke — markSent**: run `markMobileChequeValidationSent({ dateKey: '<yesterday>' })`. Verify the cached JSON now has `sentAt`.
4. **End-to-end via extension**: reload extension → side panel → MCV tile. The auto-catch-up should fire, the bridge call should now succeed, tile shows "Ready to post" or "anomaly".
5. **Negative — no email**: temporarily rename the Preset report (so the subject prefix doesn't match) → run. Expect `kind='no_email'`. Restore the report name.
6. **Negative — sheet wrong**: temporarily rename a tab → run. Expect `kind='pipeline_error'` with the sheet-not-found message. Restore.
7. **Anomaly — Day 1 unreversed**: pick a Day 1 Rejects row for yesterday's date, note its AC value. Confirm that funding_intent IS in the CSV → clean run. Then artificially mismatch (or wait for a real unreversed day) → confirm the anomaly fires with the right funding_intent listed.

## Out of scope

- Banking-holiday date math.
- Backfilling missed days.
- Validating amounts (we only check existence + status).
- Sending the Slack message from GAS (existing extension handles that via the slack.ts content script).
- Auto-emailing the agent when an anomaly is detected (the tile shows it on next side-panel open).
