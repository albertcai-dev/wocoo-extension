# MCV: Main tab columns shifted right by one — all Main-derived totals read 0 (2026-09-15)

**Symptom.** `runMobileChequeValidation` returned `status: 'ready'` for `2026-09-14`
with every Main-derived total at zero:

```
Of the cheque 0 return images received, we have successfully processed 0
Additionally 8 "Day 1 Cheques" received via email have been reversed
0 Cheques breached Ops Reversal SLA
0 Cheques breached Risk SLA
```

Ground truth for `2026-09-14`: **49** return images received and **3** cheques breached
Risk SLA. `day1Reversed = 8` was correct. Because the live `mcvComputeAnomalies` no longer
runs the `count_mismatch` check, nothing flagged the zeros and the run came back `ready`
rather than `anomaly`.

## Root cause

`MCV_MAIN_*_COL_INDEX` are hardcoded 1-indexed positions. A column was inserted into
`Main` (`M = RBC PORTAL`) between June and September 2026, shifting the three columns the
pipeline cares about one to the right.

Live `Main!A1:R1` headers, verified 2026-09-15:

| Col | Header | Constant pointing here |
|---|---|---|
| J (10) | `Cheque image received?` | `MCV_MAIN_RECEIVED_COL_INDEX = 10` ✅ still correct |
| M (13) | `RBC PORTAL` | `MCV_MAIN_DATE_COL_INDEX = 13` ❌ |
| N (14) | `Cheque image received date` | ← date column belongs here |
| P (16) | `Cheque reversal date ` | `MCV_MAIN_OPS_SLA_COL_INDEX = 16` ❌ |
| Q (17) | `OPS REVERSAL SLA [NEEDS TO BE 1 BD]` | `MCV_MAIN_RISK_SLA_COL_INDEX = 17` ❌ (this is Ops, not Risk) |
| R (18) | `RISK SLA\n[NEED TO KEEP UNDER 6 BD]` | ← Risk SLA belongs here, and is never read at all (`MCV_MAIN_LAST_COL_TO_READ = 17`) |

`MCV_MAIN_FUNDING_INTENT_COL_INDEX = 4` (`D = Funding Intent`) is still correct.

The date filter in `mcvReadMainYesterdayRows` therefore compared `dateKey` against col M,
which holds the boolean `FALSE`, so **no row ever matched** and `mainRows` came back empty.
All four Main-derived totals (`receivedCount`, `processedCount`, `opsSlaBreach`,
`riskSlaBreach`) are computed by filtering `mainRows`, so all four collapsed to 0 together.
`day1Reversed` reads the Day 1 tab (col E, col AC — both still correct) and was unaffected,
which is why 8 was right while everything else was zero.

Note `opsSlaBreach = 0` was right by accident: col P (reversal date) is a non-number, so
`typeof r.opsSla === 'number'` is false — and the real Ops SLA values in col Q are all `0`
for 2026-09-14, which is not `> 0` anyway.

## The fix

Four constants. Replace:

```js
const MCV_MAIN_DATE_COL_INDEX = 13;
const MCV_MAIN_OPS_SLA_COL_INDEX = 16;
const MCV_MAIN_RISK_SLA_COL_INDEX = 17;
const MCV_MAIN_LAST_COL_TO_READ = 17;
```

with:

```js
const MCV_MAIN_DATE_COL_INDEX = 14;     // N — Cheque image received date
const MCV_MAIN_OPS_SLA_COL_INDEX = 17;  // Q — OPS REVERSAL SLA [NEEDS TO BE 1 BD]
const MCV_MAIN_RISK_SLA_COL_INDEX = 18; // R — RISK SLA [NEED TO KEEP UNDER 6 BD]
const MCV_MAIN_LAST_COL_TO_READ = 18;   // through R
```

**`MCV_MAIN_LAST_COL_TO_READ` must go to 18 as well.** Without it the `getValues` range
stops at Q, `row[17]` is `undefined`, and `riskSlaBreach` stays 0 even with the right index.

Then **Deploy → New version**. Saving alone does not take effect.

## Expected numbers after the fix (verified against the sheet, 2026-09-15)

`Main` rows whose col N = `2026-09-14`: rows **16009–16057**, 49 rows.

| Total | Before | After | Evidence |
|---|---|---|---|
| `receivedCount` | 0 | **49** | all 49 rows have `J = TRUE` |
| `processedCount` | 0 | **49** | `Main!P16009:P16057` all `14-Sep-2026`, so every funding intent resolves in the CSV |
| `day1Reversed` | 8 | 8 | unchanged — Day 1 filters on `day1DateKey` = 2026-09-11, which has exactly 8 rows |
| `opsSlaBreach` | 0 | **0** | `Q16009:Q16057` all `0`, threshold is `> 0` |
| `riskSlaBreach` | 0 | **3** | `R16009:R16057` has 13, 17, 28 above the `> 6` threshold |

## Verify

1. Clear the cached record for the date so the run recomputes — in the GAS editor run a
   one-off `PropertiesService.getScriptProperties().deleteProperty('mcv_record_2026-09-14')`,
   or just wait for the next business day.
2. Run `runMobileChequeValidation` from the editor. Logs should show
   `main/day1 yesterday rows {"mainCount":49,"day1Count":8}`.
3. The DM draft should read `49 return images received … processed 49 … 0 Ops … 3 Risk`.

## Durable fix (recommended follow-up, not applied here)

This is the second column/tab-name drift to take MCV down in two days (see
`2026-09-14-mcv-day1-tab-rename.md`). Hardcoded positions against a sheet other teams
edit will keep breaking. Resolve the columns by header text at read time instead —
`mcvReadMainYesterdayRows` already reads row 1 for free if the range starts at row 1 —
and record a `column_resolution` anomaly when a header goes missing, so the next rename
surfaces as an anomaly instead of a silent row of zeros.

## Also still unapplied

`2026-08-27-mcv-day1-optional.md` (`mcvFindDay1Sheet`) is **not** in the live project as of
the 2026-09-14 source export. It is unrelated to this bug but still worth applying.
