# MCV: Day 1 Rejects tab renamed to a single space (2026-09-14)

**Symptom.** The Anomaly modal in the sidepanel showed a single anomaly and refused to
send the channel post:

```
pipeline_error: Day 1 Rejects tab not found: RBC | Mobile  cheque returns (Day 1 rejects)
```

Every total was zeroed and the run came back as `anomaly`, even though the CSV paste and
the Main read had both succeeded.

**Root cause.** The tab on the tracker sheet was renamed at some point between June and
September 2026. `MCV_DAY1_TAB` no longer matches it.

| | Value |
|---|---|
| Live tab name (verified 2026-09-14) | `RBC \| Mobile cheque returns (Day 1 rejects)` |
| `MCV_DAY1_TAB` at time of failure | `RBC \| Mobile  cheque returns (Day 1 rejects)` |

The difference is the gap between **Mobile** and **cheque**: the live tab has one space,
the constant has two. The original June plan
(`docs/superpowers/plans/2026-06-25-mcv-gas-function.md:16`) recorded the double space as
correct and called for it to be "preserved verbatim", which it was at the time — the tab
has since been renamed on the sheet, so the verbatim value is now stale.

Spreadsheet: `Mobile Cheque Reversal Log`,
ID `1hW-o3Mpu7SW_CH9mf9oYhN2Q9lPS9ndT7S4c0gynSfo`, sheet index 1, sheet_id `1108663558`.
No trailing space on this tab (unlike several others in the same workbook, e.g.
`Investigation - Non Standard Mobile-Cheques `, which do have one — copy tab names from
the sheet metadata rather than retyping them).

## The fix

Replace the `MCV_DAY1_TAB` constant.

Was:

```js
const MCV_DAY1_TAB = 'RBC | Mobile  cheque returns (Day 1 rejects)'; // double space preserved verbatim
```

Now:

```js
const MCV_DAY1_TAB = 'RBC | Mobile cheque returns (Day 1 rejects)'; // single space — matches live tab as of 2026-09-14
```

Then **Deploy → New version**. Saving alone does not take effect; deployments cache the
script at deploy time.

## Also apply the 2026-08-27 patch

`2026-08-27-mcv-day1-optional.md` is still unapplied in the live project. The hard
`pipeline_error` above carries the exact string from the pre-patch throw:

```js
if (!sheet) throw new Error('Day 1 Rejects tab not found: ' + MCV_DAY1_TAB);
```

A patched project would not have produced this failure at all. `mcvFindDay1Sheet` does a
whitespace-collapsed, case-insensitive fallback match, which resolves precisely this
rename regardless of what the constant says; and on a genuine miss it records a note and
lets the run finish as `ready` instead of zeroing the totals.

**The constant fix above unblocks today's run. The 2026-08-27 patch is what prevents the
next rename from taking the whole pipeline down.** Apply both.

## Verify

1. Run `runMobileChequeValidation` from the editor.
2. Expect `status: 'ready'` (assuming no genuine anomalies) with a non-zero
   `day1Reversed` on a day that has Day 1 rows.
3. In the sidepanel, the tile should offer the Ready-style DM rather than the
   "Channel post was NOT sent" anomaly modal.

## Note for future triage

The modal header date and the footer date are intentionally different. The header uses
today's local date; the footer (`Batch validated: …`) uses the validated batch's date,
which is the previous business day. See the comment at
`extension/src/sidepanel/MobileChequeValidation.tsx:104`. A Monday run showing "September
14th" in the body and "Batch validated: September 11th" underneath is correct, not a bug.
