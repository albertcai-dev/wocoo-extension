# Mobile Cheque Validation — Design

**Date:** 2026-06-16 (refresh of 2026-06-15 brainstorm with updated architecture)
**Status:** Approved (verbal) — pending written review

## Goal

Automate the daily 9 AM "Mobile Cheque Returns Validation" task so the validation message in `#Mobile Cheque Deposits Returns Working group` is generated, reviewed, and posted by Albert (or whoever's on rotation) with minimal manual work.

Reference: How-To Mobile Cheques Validation Google Doc (`1zLQwE-IU3iG1QM4HoF_SZRkC4PEKIU8th_dOu72bsbg`).

## Output (the canonical Slack post)

```
Hey Team, Here's a Validation update on mobile cheque deposit returns for {DATE}.

Cheque Returns: ✍️
Of the cheque {RECEIVED} return images received, we have successfully processed {PROCESSED} ✅
Additionally {DAY1} "Day 1 Cheques" received via email have been reversed

Breaches: 🤚
{OPS_BREACH} Cheques breached Ops Reversal SLA
{RISK_BREACH} Cheques breached Risk SLA

cc: @Estelle @Muaiz Khan @Jon @Vanessa @Nick Kiss @Eugene @Paula Bastos @Odi @Taylor @Rose @adriana @Luke Gazmin @Albert @Ishan @Amanda Burke
```

`{DATE}` is the day being validated (yesterday), in `Month Dth, YYYY` format (`June 15th, 2026`). Each `@name` must render as a real Slack mention pill (not grey text) — requires typing char-by-char into Slack's composer to trigger autocomplete.

## Architecture (hybrid)

**Apps Script — server-side, scheduled:**
- Time-trigger fires daily at 9:00 AM ET.
- `GmailApp.search()` for the Preset CSV email (subject prefix `Mobile Cheque Validation - YYYY-MM-DD`, narrowed to the last ~6 hours).
- Parse the CSV attachment, paste into the Tracker's **Validation Sheet** tab. The Main Sheet auto-populates via existing formulas.
- Read five summary cells from the Main Sheet: received, processed, Day 1 reversed, Ops SLA breach count, Risk SLA breach count.
- Scan columns P and Q of the yesterday-dated rows for `#N/A` / `#REF!` / `#VALUE!` / `#ERROR!`.
- Check the RBC Day 1 Rejects tab — for each yesterday-dated row, look up its funding-intent canonical ID in the CSV; trip if missing or `cheque_status !== reversed`.
- Persist a per-day **status record** (`{ date, status: 'ready'|'anomaly', totals, anomalies, sentAt? }`) to `PropertiesService.getScriptProperties()` keyed by date. (Lightweight, no extra sheet, naturally scoped.)

**Extension (browser-side):**
- New Home-view tile **"📋 Mobile Cheque Validation"** with three visual states (based on bridge `getMobileChequeValidationStatus` response):
  - **No record yet for today** — disabled tile reading `Waiting for daily run (scheduled 9 AM)…` with a Run-Now button below as escape hatch.
  - **Ready (clean)** — green tile: `✅ Ready to post for June 15th — 64 / 64 / 3 / 1 / 13` summary. Click → opens the workflow modal.
  - **Anomaly** — amber tile: `⚠ Validation needs attention — {N} issues`. Click → opens the workflow modal in anomaly mode.
- Modal preview shows the full Slack message text in an editable textarea (in case minor edits are needed), the destination channel, and the cc list. Send button → opens slack.com in a new tab → content script navigates to channel → types message char-by-char with autocomplete mentions → clicks send.
- On send success, calls bridge `markMobileChequeValidationSent` with today's date so the Home tile reflects the sent state next time it polls.

**Anomaly DM path** — when status is `anomaly`, the Send button is replaced by a DM-to-Albert button (or Slackbot self-DM). Same tab + content script flow, just a different destination. No channel post happens in anomaly mode.

## Anomaly checks (any one trips the DM path)

1. **Count mismatch** — `tracker_yesterday_row_count !== query_processed_count`. Cross-check against Physical Ops's Slack post is **out of scope for v1** (Apps Script can't easily read Slack without a bot token; revisit if false positives are an issue).
2. **P/Q errors** — any error sentinel in cols P or Q of yesterday's rows in the Main Sheet.
3. **Day 1 Rejects not Reversed** — see above.

Each trip is added to the status record's `anomalies` array as `{ kind, detail }`. The modal renders them in a list for triage.

## Setup outside extension (one-time)

1. **Preset scheduled email** at 8:50 AM daily to Albert's work Gmail with stable subject `Mobile Cheque Validation - YYYY-MM-DD` (CSV attachment preferred).
2. **Apps Script web app** — extends the existing v3 bridge project. New functions:
   - `runMobileChequeValidation_()` — orchestrator
   - `_handleGetMobileChequeValidationStatusFromGet_(e)` — bridge action for the extension
   - `_handleMarkMobileChequeValidationSentFromGet_(e)` — bridge action for the extension
   - Time-trigger installed via `enableMobileChequeValidationTrigger()` (callable once from the Apps Script editor).
3. **Tracker Sheet cell map** — five known cells on the Main Sheet (TBD with you during implementation by inspecting the live sheet); also the Validation Sheet tab name + paste range, and Day 1 Rejects tab name + its date column.
4. **Channel ID + cc list** — hardcoded in `data/chequeValidationConfig.ts`.

## Components

```
src/
├─ sidepanel/
│  ├─ MobileChequeValidationTile.tsx   home-view tile (status-aware)
│  └─ MobileChequeValidationModal.tsx  preview + send/DM workflow
├─ content/
│  └─ slack.ts                         shared Slack-driver (also useful for future tools)
├─ api/
│  └─ bridge.ts                        + 3 new bridge calls
└─ data/
   └─ chequeValidationConfig.ts        channel name, cc list, date-format constants
```

Apps Script additions described in §"Setup outside extension".

## Slack content script

New `src/content/slack.ts`, matched on `https://app.slack.com/*` (also `slack.com` for the redirect). Responsibilities:

- Navigate to a specific channel by clicking the channel name in the sidebar (or via URL if Slack accepts deep links).
- Focus the message composer (it's a `contenteditable` div, not a textarea — handling differs from regular inputs).
- For each cc'd person: type `@<first-few-chars>` → wait for the autocomplete dropdown → arrow-down to the matching user → press Enter to insert. This produces a real mention pill rather than plain `@Name` text.
- For plain text segments, just type the characters via `execCommand('insertText', ...)` or the modern equivalent.
- Click the send button (or press Cmd-Enter).

Same queue-based handoff pattern as the Ledge driver: side panel writes a job to `chrome.storage.local`, content script picks it up, returns result.

## Out of scope for v1

- Reading Physical Ops's Slack post to cross-check counts (Slack-API or bot-token required).
- Backfilling validation for days where the extension wasn't open / Apps Script run failed.
- Self-healing or retry of the daily Apps Script run (manual `Run Now` button is the escape hatch).
- Mobile / non-Chrome environments.

## Risks / open questions

1. **Slack DOM** is the highest-risk piece. Slack's composer is React + Draft.js; sending programmatic events to a `contenteditable` is fiddlier than a regular input. Worth prototyping the Slack content script first — if it works, the rest of the design is straightforward.
2. **Preset email format consistency** — if Preset ever changes the subject prefix or the CSV header order, the parser breaks. Lock down with a stable scheduled report config + add format-version guard in the parser.
3. **Time-trigger reliability** — Apps Script time-triggers occasionally miss a slot or run late. Manual Run-Now button mitigates.
4. **Day 1 Rejects tab schema** — need to confirm date column letter and row format before implementation.

## Implementation phases

A small Phase A first to de-risk the Slack-driving piece, then expand:

- **Phase A (~2 hr): Manual-only MVP.** Home tile "Run Now" button → Apps Script does Gmail+Sheet work on demand → extension shows preview → Slack content script types and sends. Time trigger and status caching skipped.
- **Phase B (~1 hr): Add scheduled trigger + status caching.** Apps Script writes daily status record; Home tile auto-polls and reflects today's state.
- **Phase C (~1 hr): Anomaly DM path.** When status is `anomaly`, replace channel-post with self-DM.
- **Phase D (deferred): Physical Ops cross-check** if it turns out to matter in practice.

## Related memory

- `[[mobile-cheque-validation]]` — design notes from the original brainstorm
- `[[wocoo-extension]]` — extension project state
- `[[slack-human-post-preference]]` — why we drive slack.com via content script, not WB webhook
- `[[apps-script-gotchas]]` — deployment + signature constraints
