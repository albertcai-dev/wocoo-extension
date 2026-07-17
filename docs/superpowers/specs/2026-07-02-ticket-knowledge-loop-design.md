# WOCOO Ticket Knowledge Loop

**Date**: 2026-07-02
**Author**: Albert Cai (with Claude)
**Status**: Draft, pending implementation

## Problem

Albert resolves 50+ WOCOO tickets a day. When a ticket type recurs, he re-derives the solution from scratch — which dashboard, which SQL query, which Guru card, which admin flow — because there is no personal record of how similar tickets were solved before. The team's existing Notion playbook is slightly outdated, and there is no feedback loop from resolved tickets back into it.

Three coupled gaps drive this:

1. **No log.** Resolved tickets leave no trace beyond the Jira transition. He cannot search "how did I solve reverse-fee tickets last month."
2. **No AI guidance grounded in his own history.** The existing sidepanel "suggested response" is heuristic (keyword rules) and cannot say "similar past ticket WOCOO-11284 was solved this way."
3. **No promotion path.** When he does solve a genuinely novel ticket, that learning does not get promoted back into the Notion source of truth.

Additionally, agents sometimes file tickets under the wrong work type or on the wrong board, and there is no accumulated record of those mistriage patterns.

## Goals

- Log every ticket Albert resolves (Done / Cancelled / Moved) with metadata plus optional resolution note and tools used.
- Restructure the existing WOCOO Notion playbook into a strict per-work-type template so it is both human-scannable and machine-chunkable.
- Replace the sidepanel heuristic "suggested response" with an AI verdict card grounded in the current ticket plus semantically-retrieved past tickets and Notion sections.
- Provide a daily digest workflow that promotes novel-flagged tickets into new Notion sections with AI-drafted content that Albert approves before publish.
- Ship in three phases where each phase is independently useful; do not gate value on the whole loop being live.

## Non-Goals

- Team-shared version. This is personal-first. Sharing/duplication is a later phase and out of scope for this spec.
- Analytics dashboards on top of the sheet (throughput by work type, mistriage rate). Data will be in the sheet; visualization is deferred.
- Cross-linking beyond free-text `tools_used`. No structured linkages to Slack threads, Guru card IDs, Superset dashboards.
- Replacing the existing heuristic workflow-recommendation cards (Overpayment Triage, Reverse Fee, QC Fee Waiver, CRED Route, Wallet Triage). Those remain; the AI verdict card lives alongside as a separate section of the sidepanel.
- Fallback Notion access paths (extension-scrape, Google-Doc-as-machine-source). Notion API internal-integration (Path A) is the plan; alternatives are only designed if Path A fails at Wealthsimple's workspace level.

## Architecture

Three subsystems, one virtuous loop:

```
NOTION (source of truth, human)
   restructured per-work-type sections
   read via Notion internal integration + API
        |
        |  Notion API poll (hourly)
        v
MAGICSTORAGE (machine-readable index)
   Notion sections, chunked + embedded
   Sheet rows, embedded on write
   powers semantic retrieval for AI guide
        ^                              ^
        | embeddings query             | writes on log
        |                              |
WOCOO EXTENSION                 GOOGLE SHEET (ticket log)
   sidepanel AI verdict card       one row per resolved ticket
   transition listener             auto-populated by extension
   note prompt + novel flag        novel-flag column drives
   daily novelty digest UI         daily draft queue
```

The loop: transition fires -> row lands in Sheet -> embedding job writes vector to MagicStorage -> next similar ticket's AI verdict retrieves that row -> novel-flagged rows queue up -> daily digest -> Albert approves an AI-drafted Notion section -> hourly Notion sync re-embeds -> next ticket benefits at the source-of-truth layer.

## Notion Structure

Rebuild the existing WOCOO Notion page around a strict per-work-type template. Uniform structure is what makes it AI-chunkable.

```
WOCOO Board — Ticket Playbook
  Overview (existing intro)
  Triage rules (when to keep vs. move to CRED / PFO / EOC)
    Signals for each destination board
  Work types
    Reverse Fee
      When this applies
      Steps (numbered)
      Tools + queries (SQL, dashboards, Guru cards)
      Gotchas
      Example tickets (2-3 canonical links)
    Overpayment
      (same 5-block template)
    Inquiry Removal
    Statement Correction
    ... one section per work type ...
    Card-specific (i2c, Koho)
  Change log (auto-appended by daily digest workflow)
```

- Each work type is one Notion sub-page with the identical 5-block template. One work-type page = one embedding chunk.
- The **Change log** at the bottom is a bulleted list of `[date] [ticket link] promoted to [work type]` — populated by the daily digest publish step.
- First-pass migration from the current Notion page is manual. AI can draft the reshape; the taxonomy call is Albert's.

## Sheet Schema

One row per resolved-ticket transition Albert owns. Sheet is dedicated (new sheet, not the old shared one linked from memory).

| Column | Type | Source | Notes |
|---|---|---|---|
| `logged_at` | timestamp | Extension | When the row was written |
| `ticket_id` | text | Jira | e.g. `WOCOO-12345` |
| `ticket_link` | url | Jira | Direct Jira link |
| `summary` | text | Jira | Ticket title |
| `description_snippet` | text | Jira | First ~500 chars, for embedding |
| `original_work_type` | text | Jira | Work type when Albert picked it up |
| `final_work_type` | text | Jira | Work type when he resolved it (blank if unchanged) |
| `transition` | enum | Extension | `Done` / `Cancelled` / `Moved` |
| `moved_to_board` | text | Extension | Blank unless transition = Moved (e.g. `CRED`, `PFO`, `EOC`) |
| `resolution_note` | text | Albert (prompt) | One-line what did you do. May be blank. |
| `tools_used` | text (free-form) | Albert (prompt) | Free-text: paste SQL, dashboard URLs, Guru cards |
| `mistriaged` | bool | Albert (checkbox) | True if the ticket was filed as the wrong work type |
| `novel_pattern` | bool | Albert (checkbox) | True if the resolution taught him something not in Notion |
| `novel_note` | text | Albert (only if novel) | 1-2 sentences on what was new |
| `time_on_ticket_minutes` | number | Extension | From first sidepanel open to transition (approximate) |
| `embedding` | vector (hidden col) | Backend | Populated by embedding job on write |
| `embedded_at` | timestamp | Backend | Blank until embedding written |
| `promoted_at` | timestamp | Extension | Blank until novel row is published to Notion |

Design notes:
- No `resolved_by` column — personal sheet.
- `tools_used` is free-text so Albert can paste exact SQL, URLs, and Guru card titles verbatim without a chip-selection UI.
- `time_on_ticket_minutes` is best-effort: the interval between the extension first observing him on the ticket and the transition firing.
- `embedding` / `embedded_at` columns are the semantic-search substrate — sheet stays sortable/filterable without touching them.
- Rows for tickets Albert only viewed but did not resolve are NOT logged. Transition is the trigger.

## AI Guide + Retrieval Pipeline

The sidepanel replaces the current heuristic suggested-response card with an AI verdict card. Placement: **under the ticket description, above the Clone/Move and Triage Overpayment buttons**.

Verdict card structure:

```
AI VERDICT
  Likely work type: <name> (confidence %)
  Board: <stay on WOCOO / route to X>
  Novel? <yes / no> — <reasoning>

  Recommended steps
    1. ...
    2. ...

  Watch out for
    - ...

  Similar past tickets
    [WOCOO-11284] <summary>
    [WOCOO-10982] <summary>
    [WOCOO-10771] <summary>

  Notion sections used
    [Section A] [Section B]
```

### Retrieval pipeline (per ticket)

1. Extension detects ticket opened in sidepanel.
2. Extension pulls `summary + description` from the Jira DOM (already implemented).
3. Extension calls a backend endpoint that embeds the ticket text (e.g. `voyage-3` or Anthropic embedding model when available).
4. Backend queries MagicStorage for top-k nearest vectors, split into two pools:
   - Top 5 past sheet rows
   - Top 3 Notion sections
5. Backend packages current ticket + retrieved rows + retrieved Notion sections and calls Claude via MagicAI with instructions to: classify work type + confidence, judge novelty, produce numbered steps + gotchas from source of truth, cite the past ticket IDs and Notion sections used.
6. Extension renders the returned JSON as the verdict card.
7. Result cached in the extension keyed by `ticket_id + ticket_updated_at` so re-opens are instant.

### Embedding pipeline (background)

**Sheet rows:**
- Apps Script time trigger runs every 5 minutes, selects rows with `embedded_at IS NULL`.
- For each: embed `summary + description_snippet + resolution_note + tools_used + novel_note`.
- Write vector to MagicStorage keyed by `ticket_id`.
- Stamp `embedded_at`.

**Notion sections:**
- Apps Script hourly cron.
- Fetch pages via Notion API using internal-integration token.
- Diff against last snapshot stored in MagicStorage metadata.
- For each changed section: re-embed and update MagicStorage.
- Deleted sections are removed from MagicStorage.

### Novelty judgment

Claude's verdict response includes a `novel_likelihood` score (0-1). If > 0.7, the verdict card shows a subtle nudge: "This looks new — flag it when resolving?" It does not force the flag; it is a hint to help the flag-now workflow.

### Failure modes

- **Embedding endpoint down** — Backend falls back to keyword search on the sheet's `original_work_type` column, skips embedding on write; embedding worker retries the row on next tick.
- **Notion API down** — Retrieval uses the last cached snapshot in MagicStorage.
- **MagicAI down** — Verdict card shows "AI unavailable" and the sidepanel reverts to the existing heuristic suggested response. No hard dependency.

## Extension Changes

### A. Transition listener

- After any sidepanel click that triggers a Jira transition (Clone/Move, mark Done, Cancel), the extension fires a `logTicket` event locally with the transition kind.
- For transitions performed directly in the Jira web UI outside the sidepanel: a content-script observer on `atlassian.net` watches the ticket's status pill; on change it fires the same `logTicket` event.
- On `logTicket`, the extension gathers ticket metadata (already known) and starts building a row payload.

### B. Note prompt (inline, non-modal)

Fires immediately after a transition, inside the sidepanel:

```
Logged: WOCOO-12345 -> Done

Resolution note (optional): [ ______________ ]
Tools used (optional, free text): [ ______________ ]
[ ] Mistriaged (agent picked wrong work type)
[ ] Novel pattern — flag for source-of-truth update

[ Save & close ]   [ Skip — log metadata only ]
```

- Non-modal — dismissible; other sidepanel work continues.
- Fields seeded from the AI verdict where reasonable:
  - `Resolution note` prefilled with the verdict's top recommended step.
  - `Tools used` prefilled with tools the verdict cited.
  - `Novel pattern` pre-checked if verdict's `novel_likelihood > 0.7`.
- **Save**: full row written to the sheet.
- **Skip**: bare-metadata row written (blank note, blank tools, unflagged). Nothing is ever lost.
- 5-minute grace: if the prompt is closed without either action, a small "unsaved: WOCOO-12345" chip appears at the top of the sidepanel so it can be recovered.

### C. Daily novelty digest

- Daily (fires when Albert first opens the sidepanel on a weekday, or on-demand via a "Review novel patterns" button).
- Digest shows all rows from the past 24h with `novel_pattern = true` and `promoted_at IS NULL`.
- For each: AI drafts a Notion section (title, when-applies, steps, gotchas, example ticket link) using `resolution_note + description_snippet + tools_used + novel_note` as source material.
- Albert reviews each draft inline, edits as needed, clicks "Publish to Notion."
- Publish action calls the Notion API to create the section under the correct work-type sub-page, stamps `promoted_at` on the sheet row, and appends a line to the Notion Change log.

### Data flow, end to end

```
Ticket opens
  -> embed(ticket text) -> query MagicStorage
  -> render verdict card
Ticket resolved
  -> transition fires -> note prompt
  -> row -> Sheet -> embedding worker -> MagicStorage
  -> next similar ticket benefits.

If novel_flag = true
  -> daily digest -> AI draft -> Albert approves
  -> Notion API write -> hourly Notion sync -> MagicStorage
  -> next similar ticket benefits at the source-of-truth level.
```

## Build Sequence

Three phases, each independently useful.

### Phase 1 — Capture

**Ship first.** Value: every resolved ticket leaves a trail. Cmd+F over your own sheet works even without AI.

- Restructure the WOCOO Notion page into the per-work-type template above.
- Create the new Google Sheet with the schema above.
- Extension changes:
  - Transition listener (sidepanel-click path and Jira-DOM observer path).
  - Inline note prompt UI with Save and Skip.
  - Apps Script webhook / Sheets API call to append rows.
- 5-minute unsaved-chip recovery UI.

### Phase 2 — Retrieval

**Ship second.** Value: guided resolution. Stops re-deriving how to solve tickets that were solved before.

- Set up Notion internal integration; verify Wealthsimple workspace allows third-party integrations (Path A validation).
- Backend endpoint: embed input text, query MagicStorage, package retrieved context, call MagicAI, return verdict JSON.
- Embedding worker (Apps Script time trigger, 5-minute cadence, targets `embedded_at IS NULL`).
- Notion sync worker (Apps Script hourly cron, diffs against last snapshot).
- Backfill: embed all Notion sections and all Phase-1 sheet rows.
- Replace the sidepanel heuristic suggested-response card with the AI verdict card. Placement: under description, above Clone/Move and Triage Overpayment buttons.
- Result cache keyed on `ticket_id + ticket_updated_at`.

### Phase 3 — Feedback loop

**Ship third.** Value: Notion stops going stale on its own.

- Daily novelty digest UI in the sidepanel.
- Notion write path (create-section via Notion API using the internal integration token).
- `promoted_at` column wiring.
- Change-log append on publish.
- Fallback: if Notion API write fails, extension surfaces the drafted markdown for manual paste.

## Explicitly Deferred

- Team-shared version (Phase 4 or later).
- Cross-linking (structured Slack thread IDs, Guru card IDs, Superset dashboard IDs).
- Analytics dashboard over the sheet.
- Notion access fallback paths B (extension DOM scrape) and C (Google-Doc-as-machine-source). Built only if Path A is blocked at the workspace level.

## Success Criteria

- Phase 1: 95%+ of Albert's resolved tickets over one week land as rows in the sheet, with no manual data entry beyond the optional inline prompt.
- Phase 2: For a sample of 20 recurring-pattern tickets, the AI verdict correctly identifies the work type in >= 18 and cites at least one relevant past ticket in >= 15.
- Phase 3: Novel-flagged tickets from a given day are drafted and published-or-approved within 24 hours in >= 80% of cases; Notion Change log grows monotonically without duplicate promotions.
