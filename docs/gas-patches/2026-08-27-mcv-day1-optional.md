# MCV: make the Day 1 Rejects tab optional (2026-08-27)

**Problem.** `mcvReadDay1YesterdayRows` threw when `MCV_DAY1_TAB` was missing. The throw
is caught by `runMobileChequeValidation`'s outer `catch`, which replaces the whole run
with `mcvBuildErrorRecord(dateKey, 'pipeline_error', …)` — zeroed totals, status
`anomaly`. The extension then only offers the "Channel post was NOT sent" DM, even though
the CSV paste, Main read, and every total had already succeeded (the Day 1 read is the
last step before `mcvComputeTotals`).

**Fix.** Missing tab becomes a *note*, not an error: `day1Reversed` stays 0, the
`day1_unreversed` anomaly can't fire (no rows), and the run completes as `ready` so the
channel post goes out. The note is surfaced in the extension modal so a silently-zeroed
Day 1 count can't be mistaken for a verified zero.

Paste order matters only in that all three edits must land together.

## 1. Add near the other MCV globals

```js
// Set by mcvReadDay1YesterdayRows when the Day 1 Rejects tab can't be found. Carried
// into the record as a note (not an anomaly) so the run still counts as 'ready'.
var MCV_DAY1_SKIP_NOTE = null;
```

## 2. Add this helper next to mcvReadDay1YesterdayRows

```js
/** Locate the Day 1 Rejects tab. Tries the exact configured name first, then a
 *  whitespace-collapsed, case-insensitive match so a tab renamed from the verbatim
 *  double-space form to a single space still resolves. Returns null if absent. */
function mcvFindDay1Sheet(ss) {
  const exact = ss.getSheetByName(MCV_DAY1_TAB);
  if (exact) return exact;
  const want = MCV_DAY1_TAB.replace(/\s+/g, ' ').trim().toLowerCase();
  const sheets = ss.getSheets();
  for (let i = 0; i < sheets.length; i++) {
    if (sheets[i].getName().replace(/\s+/g, ' ').trim().toLowerCase() === want) return sheets[i];
  }
  return null;
}
```

## 3. Replace the first three lines of mcvReadDay1YesterdayRows

Was:

```js
  const ss = SpreadsheetApp.openById(MCV_SPREADSHEET_ID);
  const sheet = ss.getSheetByName(MCV_DAY1_TAB);
  if (!sheet) throw new Error('Day 1 Rejects tab not found: ' + MCV_DAY1_TAB);
```

Now:

```js
  const ss = SpreadsheetApp.openById(MCV_SPREADSHEET_ID);
  const sheet = mcvFindDay1Sheet(ss);
  // No tab → skip Day 1 entirely rather than failing the whole run. day1Reversed stays
  // 0 and day1_unreversed can't fire, so the channel post is still sendable.
  if (!sheet) {
    MCV_DAY1_SKIP_NOTE = 'Day 1 Rejects tab not found (' + MCV_DAY1_TAB + ') — Day 1 numbers skipped, reported as 0.';
    mcvLog('Day 1 Rejects tab missing, skipping Day 1', { tab: MCV_DAY1_TAB });
    return [];
  }
```

## 4. In runMobileChequeValidation

Reset the flag as the first line inside the function (before the `try`), so a stale note
from a previous execution can't leak into this run:

```js
  MCV_DAY1_SKIP_NOTE = null;
```

Then add `notes` to the success record:

```js
    const record = {
      date: dateKey,
      status: anomalies.length > 0 ? 'anomaly' : 'ready',
      totals: totals,
      anomalies: anomalies,
      notes: MCV_DAY1_SKIP_NOTE ? [MCV_DAY1_SKIP_NOTE] : [],
      sentAt: null,
    };
```

Optionally add `notes: []` to `mcvBuildErrorRecord` for shape consistency; the extension
treats the field as optional either way.

## Verify

1. Run `runMobileChequeValidation` from the editor with the tab absent.
2. Expect `status: 'ready'`, real `receivedCount`/`processedCount`, `day1Reversed: 0`,
   and one entry in `notes`.
3. In the sidepanel, Mobile Cheque Validation should offer the Ready-style DM with the
   note shown above the message body.
