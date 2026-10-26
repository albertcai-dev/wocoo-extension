# Sidekick Agent card: live progress, current step, and queue

Date: 2026-10-25
Repos: `wocoo-extension` (card, native host) and `wocoo-draft-agent` (agent, store_cli)
Approved mockup: `docs/superpowers/specs/2026-10-25-sidekick-agent-progress-card-mockup.html` (open in a browser)

## Intent

The Sidekick Agent card in Settings (`extension/src/sidepanel/SettingsView.tsx`, `DraftAgentSection`)
today shows only a running/paused checkbox and a "since" time, read once when Settings opens.
When the agent is running, Albert opens the card to answer four questions at a glance:

1. Is it moving or stuck?
2. Roughly how long until the current ticket is done?
3. Where is it inside the current ticket (e.g. checking Preset, waiting on Compass)?
4. What is queued next, and in what order?

## Goals

- A per-ticket progress view for the ticket the agent is working on now, using a vertical step
  checklist (mockup "B").
- A live queue list under it, in the agent's real order, with ticket summaries.
- Distinct visual states for: working, a ticket parked waiting on Compass, a step running too long,
  running with an empty queue, and paused.
- The card updates live while Settings is open.

## Non-goals

- A progress bar or ETA for the whole queue. The queue is re-ranked after every ticket (Solve presses
  and Compass replies jump to the front) and the agent has no fixed end, so a queue-wide bar would
  jump backwards. Explicitly rejected.
- Controls on queue rows (reorder, skip, solve-now). Display only.
- Showing the daily log or raw step numbers (1–14).
- Changing how the agent chooses or works tickets.

## Anti-goals (it would be a failure if...)

- The bar moves backwards or the queue order shown differs from what the agent actually picks next.
- A ticket waiting on Compass looks "stuck"; waiting there is normal and must read as calm amber,
  not red.
- The card looks frozen while the agent is in fact working (stale data presented as current).

## Card layout (approved)

Top row unchanged: checkbox, "Sidekick Agent running" / "Sidekick Agent Paused", "since …". The
existing helper sentence, login summary and error line stay. Below a divider:

### Current ticket

- Row: ticket key, a **system tag** (e.g. `KOHO prepaid`, `i2c credit`, `i2c prepaid`; the result of
  the jev route), and on the right elapsed time for this ticket plus "usually ~Nm".
- Ticket summary on the next line, one line, ellipsised.
- A thin progress bar (fills by steps completed out of steps in the checklist).
- A vertical checklist of six friendly steps:

  | Row | Prompt steps it covers | Stage |
  |---|---|---|
  | Read ticket & client email | 1–2 | gather |
  | Checking Preset | 3 | gather |
  | i2c / KOHO lookup | 4 | gather |
  | Precedent & guides | 5–8 | gather |
  | Ask Compass (if needed) | 9 | write |
  | Write draft | 10–14 | write |

  Finished rows: green check and how long that step took. Current row: bold, pulsing indigo dot,
  time on this step so far. Upcoming rows: grey hollow dot.
- **Route is not a step row.** It takes under a second; its result is the system tag.
- On a Compass resume the agent skips gather; rows 1–4 render as done (no times).

### Waiting on Compass

The agent does not sit on a ticket while Compass is asked: the item goes to `awaiting_compass` and
the agent works other tickets. So waiting tickets get their own section between the current ticket
and Up next: amber label "Waiting on Compass · N", one row per ticket (key, summary, "Nm left"
countdown to `compass_timeout_s`), and the line "Asked Nm ago. Jumps to the front when Compass
answers, or drafts without it when time runs out." (The line may be shown once under the section
rather than per row; builder's call.)

### Up next

Label "Up next · N", numbered rows: key, summary (ellipsised), and an optional reason tag on the right
for why it's ranked high: `Solve` (indigo; `priority_at`), `Compass replied` (amber; compass resume),
`Reply in` (green; `external_reply`). Show the first 3, then "+N more" which expands the rest.

### States

1. **Working**: as above.
2. **Waiting on Compass**: the Waiting section appears; the current ticket section shows whatever
   the agent picked next.
3. **Taking too long**: when the current step (or ticket) runs well past normal, the dot, step time
   and bar turn red, with a note: "Same step for N min. Might be stuck on a login. Gets cut off in Nm
   and retried (attempt X of 3)." Cutoff from the 1500 s session watchdog; attempts from the item.
4. **Running, nothing to do**: "Queue empty", "checks again in Nm" (next launchd tick, every 5 min),
   "Last: KEY drafted at TIME · N drafted today", plus any Waiting on Compass rows.
5. **Paused**: header shows Paused; "Queued · N" list still shown, no current ticket.
6. **Paused, finishing a ticket** (Albert decided: show it). The drain loop only checks the mode
   between tickets, so a session can run up to 25 min after a pause. Header shows Paused; a line
   "Finishing WOCOO-4821, then stopping"; the current-ticket section and checklist stay live as in
   Working. Then falls through to Paused.
7. **Running, tickets queued, but none being worked** (Albert decided: name each case). Replaces the
   current-ticket section with one status line (dot + text + time), the queue still listed below:
   - **Checking for new tickets**: the poll session is running.
   - **Between checks · next check in Nm**: drain budget used up, or the tick ended normally.
   - **Waiting for your browser session to close**: tick deferred on a foreign Playwright session.
   - **Check failed · VPN or MCPLocker may be down · retrying in Nm** (red): the poll failed and the
     drain was skipped. Show how long it has been failing if more than one tick in a row.
   - **Agent hasn't checked in for N min** (red): no tick has recorded anything for well over the
     5-min schedule (launchd not firing, machine asleep). Builder picks the threshold (~15 min).
8. **Solo solve** (my call): when Solve was pressed while paused (`mode=running, solo=KEY`), Up next is
   replaced by "Solving only KEY, then pausing."

Retries (my call): when a ticket starts over (retry after a kill/fail, or a deferred ticket coming
back), the checklist restarts from the top with an "attempt N of 3" label next to the elapsed time.
This is a new attempt, not the bar moving backwards; step history may be cleared on `begin`.

Skipped steps (my call): a step the ticket never runs (no Preset query, no Compass question) shows
the dashed "skipped" dot (`d-skip` in the mockup) once the agent has moved past it, and does not
count toward the bar, so the bar does not jump at the end.

Styling follows the extension: inline `style={{}}` with `--mint-*` tokens (`styles/mint-tokens.css`).
Indigo = highlight (working), green = positive (done), amber = warning (Compass), red = negative
(slow). The mockup file is the visual reference.

## What has to be built (decided)

There is no data for any of this on the extension side today. Findings from the code:

- Transport is Chrome native messaging: `api/draftStore.ts` → `native-host/wocoo_launcher.py`
  (`draft_action`, `DRAFT_ACTIONS`) → `wocoo-draft-agent/src/store_cli.py`. Every call is one-shot.
- Queue order lives in `work_items.next_item` (`src/work_items.py`), which returns only the single
  top candidate. Ranking: Solve presses (`priority_at`), then Compass resumes, then `external_reply`,
  then board status (`work_order`), then oldest `ticket_created`, then `queued_at`.
- `run.sh` `run_item` runs: `begin` → jev route (gather only) → stage `gather` → stage `write` →
  `finish`. The stage is only an env var (`STAGE`); it is never saved. Steps inside a stage are only
  prose in `logs/YYYY-MM-DD.log`.

Required pieces:

1. **Agent: ranked queue.** Refactor `next_item` so the sort key is computed by a shared function and
   add a function that returns all eligible candidates in order. `next_item` must keep returning the
   first of that same list, so the card's order can never disagree with the agent's pick.
2. **Agent: record progress on the item.** `run.sh` saves the jev system result and the current
   stage to the in-progress item, with timestamps.
3. **Agent: step reporting from the draft session.** A new `store_cli` command the draft session
   calls when it actually starts each checklist step (step id + timestamp saved on the item), added
   to the prompt's `allowed-tools` line. This is the only source of "Checking Preset"-level detail.
   The prompt headings do not line up one-to-one with the rows (Step 3 holds both the system choice
   and nearly all i2c/KOHO/Atlas browsing; Preset is only the ATM-fee query; Step 4 is login rules),
   so report on the action, not the heading:
   - *Read ticket & client email*: start of Step 1.
   - *Checking Preset*: just before running `queries.py atm-fees` (or any Preset query).
   - *i2c / KOHO lookup*: just before the first i2c, KOHO or Atlas page visit.
   - *Precedent & guides*: start of Step 5.
   - *Ask Compass*: just before posting the Compass question.
   - *Write draft*: start of the write stage (Step 10).
   Steps may be reported out of table order (e.g. Preset after the lookup); the card shows rows in
   table order and marks whichever is current.
3a. **Agent: tick phase and outcome.** `run.sh` saves what the current tick is doing and how the last
   one ended (polling / draining / deferred-foreign-playwright / poll-failed / drain-skipped-paused /
   ended, with timestamps and consecutive-failure count), so `status` can drive state 7.
3b. **Agent: exact queue order.** `run.sh` saves the tick's `TRIED` set (cleared at tick end) and
   `status` passes it and the solo key into the ranked-list function, so Up next matches what the
   agent will really pick next within this tick.
4. **Agent: status command.** A `store_cli status` command returning, in one JSON reply: mode/since,
   the in-progress item (key, summary, system, kind, resume reason, stage, step history with
   timestamps, attempts, begun_at), awaiting_compass items (key, summary, asked_at, timeout), the
   ranked queue (key, summary, reason tag), the typical ticket duration, last drafted item, count
   drafted today, and the time of the next tick if known.
5. **Native host + extension API.** New `agent_status` action in `wocoo_launcher.py` (added to
   `DRAFT_ACTIONS` and to the `isDraftStoreNotSetUp` "unknown action" regex in `draftStore.ts` so an
   old host degrades quietly), and a `getAgentStatus()` in `api/draftStore.ts` with a typed result.
6. **Card.** `DraftAgentSection` polls `getAgentStatus()` while Settings is open and renders the
   states above. Follows the existing polling pattern in `SolveWithAgentButton.tsx` (8 s there).

## Calls I made (Albert to check)

- **"Usually ~Nm"** = median wall time of recently drafted tickets, from `begun_at` to finish.
- **Too-long threshold**: a ticket goes red at roughly 3× its usual time, or whenever it is within
  5 minutes of the 1500 s session cutoff, whichever comes first.
- **"N drafted today"** on the idle state.
- Six friendly step rows, grouped as in the table above.
- Poll interval while Settings is open: about 5 s, stopping when the panel is hidden.
- Retries restart the checklist with an "attempt N of 3" label (see States).
- Steps that never run show as skipped and leave the bar's count.
- Step reports fire on the action (e.g. the Preset query), not the prompt heading.
- Solo solve shows "Solving only KEY, then pausing." instead of Up next.
- Up next is exact within a tick (TRIED set and solo key are saved for `status`).

## Left to the builder

- Data shapes, field names, and where step history is stored on the item.
- How the per-step timer ticks between polls (client-side from the last timestamp is fine).
- Whether "checks again in Nm" is computed from the last tick time or omitted if unknown.
- Splitting `DraftAgentSection` into smaller components.
- Tests: follow the repos' existing style (`work_items` tests in the agent, `*.test.ts` in the
  extension). The queue-order function must be tested to match `next_item`.
