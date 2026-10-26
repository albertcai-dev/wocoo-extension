# Sidekick Agent Progress Card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Sidekick Agent card in Settings shows, live, the ticket the agent is on, which step of it, a step checklist with times, tickets waiting on Compass, the exact upcoming queue, and what the agent is doing when no ticket is being worked.

**Architecture:** The agent (`wocoo-draft-agent`) starts recording what it is doing: the stage and checklist step on the in-progress item, and the tick phase in `state/tick.json`. It also exposes the ranked queue it already computes. A new `store_cli status` command assembles all of it in one JSON reply. The native host passes it through as `agent_status`. The extension polls it every 5 s while Settings is open and renders it through a pure view-model function.

**Tech Stack:** Python 3 stdlib + `unittest` and bash (agent); Python native host; React 18 + TypeScript + Vitest (extension), inline styles with `--mint-*` tokens.

**Spec:** `docs/superpowers/specs/2026-10-25-sidekick-agent-progress-card-design.md`. The mockup next to it (`…-mockup.html`) is the visual reference.

**Repos and branches:** Tasks 1–6 in `~/projects/wocoo-draft-agent-progress`, Tasks 7–9 in `~/projects/wocoo-extension-progress` (worktrees on `feat/agent-progress`; the live checkouts stay on `main` because launchd runs the agent from there). In the agent worktree there is no `config.json`/`state/` (gitignored) — tests use temp roots.

**Test commands:**
- Agent: `cd ~/projects/wocoo-draft-agent-progress && python3 -m unittest discover -s tests -v`
- Host: `cd ~/projects/wocoo-extension-progress && python3 -m unittest native-host/test_wocoo_launcher.py -v`
- Extension: `cd ~/projects/wocoo-extension-progress/extension && npm test` and `npx tsc -b`

## Global Constraints

- Checklist rows, in this order, with step ids: `read` "Read ticket & client email", `preset` "Checking Preset", `lookup` "i2c / KOHO lookup", `precedent` "Precedent & guides", `compass` "Ask Compass" (shown with "(if needed)" while todo), `write` "Write draft".
- There is no Route row. The jev result (`state/route/<KEY>.json` → `system`) is the system tag. Labels: `i2c_credit` → "i2c credit", `i2c_prepaid` → "i2c prepaid", `koho` → "KOHO prepaid", `atlas` → "Atlas". `none` or a missing route → no tag.
- Queue reason tags: `priority_at` → "Solve" (indigo), compass resume → "Compass replied" (amber), `external_reply` → "Reply in" (green).
- Up next shows 3 rows, then "+N more", which expands the list.
- Session cutoff is 1500 s (`WDA_SESSION_TIMEOUT_S`); max attempts come from config `max_attempts` (3). The Compass timeout is `compass_timeout_s` (1800). Ticks run every `poll_interval_s` (300).
- Too long = elapsed on the ticket > 3 × typical, or under 300 s left before the session cutoff.
- "Hasn't checked in" = no tick write for over 900 s while the phase is not `polling` or `draining`, or over 1800 s in any phase.
- The card refreshes about every 5 s, only while the panel is visible.
- Copy, verbatim:
  - "Finishing KEY, then stopping"
  - "Solving only KEY, then pausing."
  - "Checking for new tickets"
  - "Between checks · next check in Nm"
  - "Waiting for your browser session to close"
  - "Check failed · VPN or MCPLocker may be down · retrying in Nm"
  - "Agent hasn't checked in for N min"
  - "Queue empty"
  - "Asked Nm ago. Jumps to the front when Compass answers, or drafts without it when time runs out."
  - "Same step for N min. Might be stuck on a login. Gets cut off in Nm and retried (attempt X of 3)."
- Display only: no buttons on queue rows.
- Old host or agent without `agent_status`: the card falls back to today's behaviour with no error shown.

## Review Focus

- **Stale data after the agent dies mid-ticket.** An item left `in_progress` by a killed tick must not show as "working" forever. When the tick file says the tick ended, or the tick is stale, `current` is null. Tested in Task 4.
- **Steps reported out of table order**, e.g. `lookup` before `preset`, then `preset`. The current row is the last one reported, and rows are never marked done twice. Tested in Task 8.
- **The tried set leaks across ticks.** A key tried in the last tick must not stay hidden from Up next once a new tick starts. Tested in Task 3.
- **A Compass resume with no gather steps.** The `read`–`precedent` rows render done with no times, and the bar starts at 4/6, not 0. Tested in Task 8.
- **Polling while the side panel is closed or hidden** must stop, so it doesn't spawn a native-host process every 5 s. Covered in Task 9.

---

### Task 1: Ranked queue shared with `next_item`

**Files:**
- Modify: `src/work_items.py:410-453` (`next_item`)
- Test: `tests/test_queue.py`

**Interfaces:**
- Produces:
  - `ranked_queue(items, now, compass_timeout_s, defer_cap_s=DEFAULT_DEFER_CAP_S, exclude=frozenset(), work_order=WORK_ORDER, only=None) -> list[dict]`
  - Each entry is `{"key": str, "reason": str | None, "tag": "solve" | "compass" | "reply" | None}`, sorted by the existing key.
  - `next_item` keeps its signature and behaviour, and returns the first entry of `ranked_queue`, in the same `(key, item_copy_with_resume_reason)` shape.

- [ ] **Step 1: Write failing tests** in `tests/test_queue.py`:
  - `test_ranked_queue_order_matches_next_item`: a fixture of 5 items covering a solve, a compass reply, an external reply, two board statuses and two created dates. Assert that `[e["key"] for e in ranked_queue(...)]` equals the order produced by calling `next_item` repeatedly with a growing `exclude`.
  - `test_ranked_queue_tags`: `priority_at` → `"solve"`; awaiting_compass with a reply → `"compass"`; `external_reply` → `"reply"`; plain → `None`. Priority wins when both are set.
  - `test_ranked_queue_respects_exclude_and_only`.
  - `test_ranked_queue_skips_awaiting_compass_without_resume`.
- [ ] **Step 2: Run** `python3 -m unittest tests.test_queue -v`. Expected: FAIL, `ranked_queue` not defined.
- [ ] **Step 3: Implement.** Extract the candidate loop from `next_item` into `ranked_queue`. Rewrite `next_item` as `q = ranked_queue(...)`, then return a deep copy of `items[q[0]["key"]]` with `resume_reason` set. Keep the `i2c_idle` parameter on `next_item` only.
- [ ] **Step 4: Run** the full agent suite. Expected: PASS, including the existing `next_item` tests.
- [ ] **Step 5: Commit** with message `queue: ranked_queue shares next_item's order`.

### Task 2: Record stage and checklist steps on the in-progress item

**Files:**
- Modify: `src/work_items.py` (`begin_item`, new functions)
- Modify: `src/store_cli.py` (new `stage` and `step` commands, plus `build_parser`)
- Test: `tests/test_queue.py`, `tests/test_store_cli.py`

**Interfaces:**
- Produces:
  - `STEP_IDS = ("read", "preset", "lookup", "precedent", "compass", "write")`
  - `STAGES = ("gather", "write")`
  - `record_stage(items, key, stage, now) -> dict`: sets `item["stage"]` and `item["stage_at"]`. Raises `ValueError` unless the state is `in_progress` and `stage in STAGES`.
  - `record_step(items, key, step, now) -> dict`: appends `{"step": step, "at": now}` to `item["steps"]`, but does nothing when the last entry has the same step. Raises `ValueError` unless the state is `in_progress` and `step in STEP_IDS`.
  - `begin_item` now also sets `steps=[]`, `stage=None`, `stage_at=None`. Retries therefore restart the checklist.
  - CLI: `store_cli.py stage --key K --stage {gather,write}` and `store_cli.py step --key K --step {read,…}`. Both reply `{"ok": true, "key": K}`, or fail with exit 1 through `fail()`.

- [ ] **Step 1: Write failing tests:**
  - `test_record_step_appends_and_dedupes_consecutive`
  - `test_record_step_rejects_unknown_step_and_non_in_progress`
  - `test_begin_resets_steps_and_stage`
  - `test_record_stage_sets_stage_at`
  - CLI round-trip in `test_store_cli.py`: `begin`, then `stage --stage gather`, then `step --step preset`, then `items` shows `steps[0]["step"] == "preset"` and `stage == "gather"`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement** the functions in `work_items.py`. Add `cmd_stage` and `cmd_step` in `store_cli.py`, following the load → mutate → `save_items` → `emit` pattern of `cmd_begin`.
- [ ] **Step 4: Run** the full agent suite. Expected: PASS.
- [ ] **Step 5: Commit** with message `items: record stage and checklist step for the card`.

### Task 3: Tick phase file

**Files:**
- Modify: `src/store.py` (new `write_tick`, `read_tick`)
- Modify: `src/store_cli.py` (new `tick` command)
- Test: `tests/test_store.py`, `tests/test_store_cli.py`

**Interfaces:**
- Produces:
  - `TICK_PHASES = ("start", "polling", "draining", "deferred_foreign_pw", "poll_failed", "paused", "ended")`.
  - `write_tick(root, phase, now, tried=None) -> dict` writes `state/tick.json` atomically with the shape `{"phase", "at", "started_at", "tried": [keys], "poll_failures": int}`. The rules:
    - `start` sets `started_at=now` and `tried=[]`, and keeps `poll_failures`.
    - `poll_failed` increments `poll_failures`.
    - `draining` resets `poll_failures` to 0.
    - `ended` clears `tried`.
    - `tried`, when given as a list, replaces the stored list.
  - `read_tick(root) -> dict | None`.
  - CLI: `store_cli.py tick --phase P [--tried CSV]` replies with the written dict.

- [ ] **Step 1: Write failing tests:**
  - `test_tick_start_clears_tried`. This is the Review Focus item: a key in `tried` from the previous tick is gone after `start`.
  - `test_poll_failures_count_and_reset`: `poll_failed` twice gives 2, then `draining` gives 0.
  - `test_ended_clears_tried_keeps_failures`.
  - `test_unknown_phase_raises`.
  - A CLI round-trip.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement** using the existing `_atomic_write`.
- [ ] **Step 4: Run** the full agent suite. Expected: PASS.
- [ ] **Step 5: Commit** with message `store: tick phase file for the Sidekick card`.

### Task 4: `status` command

**Files:**
- Create: `src/status.py` (a pure builder)
- Modify: `src/store_cli.py`:
  - add the `cmd_status` command
  - add `"session_timeout_s": 1500` to `DEFAULTS`; `"poll_interval_s": 300` too if it's missing
- Test: `tests/test_status.py` (new, `unittest` style like `test_queue.py`), plus one CLI smoke test in `tests/test_store_cli.py`

**Interfaces:**
- Consumes: `ranked_queue` (Task 1), `steps`/`stage`/`stage_at` (Task 2), `read_tick` (Task 3), `store.read_route`, `store.read_agent_mode`, `store.read_agent_solo`.
- Produces `build_status(items, *, mode, since, solo, tick, routes, cfg, now, work_order) -> dict`. `routes` is `{key: route_dict}`. `cfg` needs `compass_timeout_s`, `defer_cap_s`, `max_attempts`, `session_timeout_s` and `poll_interval_s`. The return value is this exact shape, which Tasks 7–9 depend on:

```
{"ok": true, "mode": "running"|"paused", "since": float|null, "solo": str|null,
 "tick": {"phase": str|null, "at": float|null, "poll_failures": int,
          "next_check_at": float|null, "stale": bool},
 "current": null | {"key", "summary", "system", "kind", "resume_reason", "stage",
                    "begun_at", "attempts", "max_attempts", "steps": [{"step","at"}],
                    "deadline_at"},
 "waiting": [{"key", "summary", "asked_at", "timeout_at"}],
 "queue":   [{"key", "summary", "tag"}],
 "typical_s": float|null, "last_drafted": {"key","at"}|null, "drafted_today": int}
```

Rules:
- `current` is the single `in_progress` item. It is `null` when `tick` is `None`, when `tick.phase` is `"ended"`, or when `tick.stale` (see the Review Focus item on stale data).
- `deadline_at = stage_at + session_timeout_s`, or `null` if no stage has been recorded yet.
- `waiting`: items in state `awaiting_compass`. `timeout_at = compass.asked_at + compass_timeout_s`.
- `queue`: `ranked_queue(items, now, …, exclude=set(tick.tried), only=solo)`, with the current key also excluded.
- `next_check_at = tick.at + poll_interval_s` when the phase is in `("ended", "deferred_foreign_pw", "poll_failed", "paused")`, otherwise `null`.
- `stale`:
  - true when `now - tick.at > 900` and the phase is not `polling` or `draining`
  - true when `now - tick.at > 1800` in any phase
  - false when there is no tick file
- `typical_s`: the median of `draft_written_at - begun_at` over items that have both, using the 20 most recent by `draft_written_at`. `null` if there are fewer than 3.
- `last_drafted`: the item with the largest `draft_written_at`.
- `drafted_today`: the count of `draft_written_at` values on today's local date.
- `system`: `routes[key]["system"]` when present and not `"none"`.

- [ ] **Step 1: Write failing tests** in `tests/test_status.py`, one each:
  - current present while draining
  - current null after `ended`, even though the item is still `in_progress`
  - current null when the tick is stale
  - the queue excludes tried and current, and is limited to solo
  - waiting `timeout_at`
  - `next_check_at` per phase
  - `stale` thresholds: 899 s → false, 901 s → true for `ended`; 1700 s draining → false; 1801 s draining → true
  - `typical_s` median, and null with fewer than 3
  - `drafted_today`
  - `system` for `"none"` → null

  Add a CLI smoke test: `status` against an empty root returns `ok`, `current` null and `queue` empty.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement** `build_status`. `cmd_status` loads items, mode, solo, tick and the routes for the current, waiting and queued keys, then emits the result.
- [ ] **Step 4: Run** the full agent suite. Expected: PASS.
- [ ] **Step 5: Commit** with message `status: one-shot agent status for the Sidekick card`.

### Task 5: Wire `run.sh`

**Files:**
- Modify: `run.sh` (tick body at lines 300–432, `run_item` at lines 238–296)
- Test: `tests/test_run_sh.py`

**Interfaces:**
- Consumes: the CLI commands `tick` (Task 3) and `stage` (Task 2).
- Produces: `state/tick.json` and item `stage` fields written during a real tick.

Where the calls go:
- Add a helper `tick_phase() { python3 "$STORE" tick "$@" >/dev/null 2>&1 || true; }`. It is best effort and must never fail a tick.
- `start`: after `acquire_lock`.
- `deferred_foreign_pw`: in the initial `foreign_pw` branch, and in the mid-drain one.
- `polling`: before `run_claude poll`.
- `poll_failed`: when `rc != 0`, or when `apply-inbox` fails.
- `paused`: in both "agent paused in Sidekick" branches.
- `draining`: before the drain loop.
- `draining --tried "$TRIED"`: right after `TRIED` is extended.
- `ended`: at both `=== tick end ===` exits, including "drain skipped: no fresh inbox".
- The manual `--one` path writes `start` and `ended` only.
- In `run_item`, call `python3 "$STORE" stage --key "$key" --stage "$stage"` right before `run_claude draft`, the same way (best effort, logged on failure).

- [ ] **Step 1: Write failing tests** in `test_run_sh.py`, using the existing fakes:
  - `test_tick_file_ended_after_normal_tick`
  - `test_tick_file_poll_failed_when_poll_exits_nonzero` (with `poll_failures == 1`)
  - `test_tick_file_deferred_on_foreign_playwright` (with `FAKE_FOREIGN=1`)
  - `test_stage_recorded_before_draft_session`: the fake claude reads `items.json` during a draft run and echoes `stage`; assert `gather`.
- [ ] **Step 2: Run** `python3 -m unittest tests.test_run_sh -v`. Expected: FAIL.
- [ ] **Step 3: Implement** the calls listed above.
- [ ] **Step 4: Run** the full agent suite. Expected: PASS.
- [ ] **Step 5: Commit** with message `run.sh: record tick phase and stage for the card`.

### Task 6: Step reports from the draft prompt

**Files:**
- Modify: `prompt/draft.md`:
  - the `allowed-tools` line (line 1)
  - the Commands section (around line 136)
  - Steps 1, 3, 5 and 9, and the start of the write stage
- Test: `tests/test_prompts.py`

**Interfaces:**
- Consumes: `store_cli.py step --key <TICKET> --step <id>` (Task 2).

What to change in the prompt:
- Add `Bash(python3 src/store_cli.py step --key:*)` to `allowed-tools`.
- In Commands, add one line: report progress with `python3 src/store_cli.py step --key <TICKET> --step <id>`. It is best effort: if it fails, carry on.
- Report on the action, not on the heading:
  - `read`: first thing in Step 1.
  - `preset`: immediately before any `queries.py atm-fees` or Preset MCP query.
  - `lookup`: immediately before the first i2c, KOHO or Atlas page visit.
  - `precedent`: start of Step 5.
  - `compass`: immediately before posting the Compass question.
  - `write`: first thing in the write stage (Step 10).
- Each step is reported at most once per session, except that it is fine to report one again after another step.

- [ ] **Step 1: Write a failing test** `test_draft_prompt_reports_every_checklist_step`. For each id in `work_items.STEP_IDS`, assert that `--step <id>` appears in `draft.md`. The existing `test_allowed_tools_line_covers_every_tool_named` and `test_bash_is_narrowed_and_covers_every_command` will also catch a missing `allowed-tools` entry.
- [ ] **Step 2: Run** `python3 -m unittest tests.test_prompts -v`. Expected: FAIL.
- [ ] **Step 3: Edit** `prompt/draft.md` as listed above.
- [ ] **Step 4: Run** the full agent suite. Expected: PASS.
- [ ] **Step 5: Commit** with message `draft prompt: report checklist steps to the store`.

### Task 7: Native host `agent_status`

**Files:**
- Modify: `native-host/wocoo_launcher.py`:
  - `draft_action` (around line 100)
  - `DRAFT_ACTIONS` (around line 158)
- Test: `native-host/test_wocoo_launcher.py`. Extend the `STUB` with a `status` branch that prints `{"ok": true, "mode": "running", "queue": []}`.

**Interfaces:**
- Consumes: `store_cli.py status` (Task 4).
- Produces: native message `{action: "agent_status"}`. The reply is the status dict passed through, or `{ok: false, error}` on failure.

- [ ] **Step 1: Write failing tests** `test_agent_status_passes_through` and `test_agent_status_store_error`.
- [ ] **Step 2: Run them.** Expected: FAIL with "Unknown action".
- [ ] **Step 3: Implement.** Use `run_store(['status'])` and return the dict, following the `agent_item` branch.
- [ ] **Step 4: Run** the host tests. Expected: PASS.
- [ ] **Step 5: Commit** in `wocoo-extension` with message `native host: agent_status action`. After merging, the host has to be reinstalled with `native-host/install.sh`; note this in the PR.

### Task 8: Status types and card view model

**Files:**
- Create: `extension/src/data/agentStatus.ts`
- Test: `extension/src/data/agentStatus.test.ts`

**Interfaces:**
- Consumes: the status JSON shape from Task 4.
- Produces:
  - `type AgentStatus`: mirrors the Task 4 shape in camelCase.
  - `normaliseAgentStatus(reply: unknown): AgentStatus`: defensive, like `normaliseAgentMode`. Bad fields become null or empty, and an unknown mode becomes paused.
  - `STEP_ROWS: { id: StepId; label: string }[]`: from Global Constraints.
  - `systemLabel(system: string | null): string | null`.
  - `type RowState = 'done' | 'now' | 'skipped' | 'todo'`.
  - `agentCardView(s: AgentStatus, now: number): CardView`, where:

```ts
type CardView = {
  header: 'running' | 'paused';
  finishing: string | null;            // key, when paused with a current ticket
  solo: string | null;                 // key, when Up next is replaced
  current: null | {
    key: string; summary: string; system: string | null;
    elapsedS: number; typicalS: number | null; attempt: number | null; // null when attempts === 0
    rows: { id: StepId; label: string; state: RowState; seconds: number | null }[];
    barPct: number;                    // done / (6 - skipped), 0..100
    slow: null | { stepMin: number; cutoffMin: number; attempt: number; maxAttempts: number };
  };
  idleLine: null | { tone: 'neutral' | 'warning' | 'negative'; text: string }; // the "nothing being worked" line
  waiting: { key: string; summary: string; minutesLeft: number; askedMinAgo: number }[];
  queue: { key: string; summary: string; tag: 'solve' | 'compass' | 'reply' | null }[];
  queueLabel: 'Up next' | 'Queued';
  emptyFooter: null | { lastKey: string | null; lastAt: number | null; draftedToday: number };
};
```

Row rules:
- The current row is the step of the last `steps` entry.
- A row is `done` if it was reported and isn't current. Its `seconds` run from its first report to the next entry's `at`.
- A row is `skipped` if it wasn't reported and a later row in table order was reported (or is current). For example, `compass` is skipped when `write` was reported.
- Anything else is `todo`.
- With no steps reported and `stage === 'write'` after a compass resume (`resumeReason` starting with `compass_`), rows `read`–`precedent` are `done` with `seconds: null`. The bar then starts at 4/6, not 0. This is a Review Focus item.

`idleLine`, used only when `current` is null and the mode is running:
- `tick.stale` → negative, "Agent hasn't checked in for N min".
- `poll_failed` → negative, the check-failed copy.
- `polling` → neutral, "Checking for new tickets".
- `deferred_foreign_pw` → warning, "Waiting for your browser session to close".
- the queue is empty → `emptyFooter` and the text "Queue empty".
- anything else → neutral, "Between checks · next check in Nm".

`N` and `Nm` are rounded up to whole minutes, with a minimum of 1.

- [ ] **Step 1: Write failing tests** for:
  - `normaliseAgentStatus` with junk input
  - the working state's rows and bar
  - steps out of order (`lookup`, then `preset`): `preset` is now, `lookup` is done, `read` is skipped (Review Focus)
  - a skipped `compass` once `write` is reported, with the bar denominator at 5
  - a compass resume with no steps: bar 4/6 (Review Focus)
  - `slow` at 3 × typical, and at under 300 s to the deadline
  - paused with a current ticket → `finishing`
  - solo → `solo` set
  - each `idleLine` case, with exact copy from Global Constraints
  - `attempt` shown only when attempts > 0
- [ ] **Step 2: Run** `npm test -- agentStatus`. Expected: FAIL.
- [ ] **Step 3: Implement** `agentStatus.ts`.
- [ ] **Step 4: Run** `npm test` and `npx tsc -b`. Expected: PASS.
- [ ] **Step 5: Commit** with message `agent status: types and card view model`.

### Task 9: API call, card UI, polling

**Files:**
- Modify: `extension/src/api/draftStore.ts`:
  - add `getAgentStatus()`
  - add `agent_status` to the "unknown action" regex at line 27
- Create: `extension/src/sidepanel/AgentProgress.tsx`. It renders a `CardView` only; no data fetching.
- Modify: `extension/src/sidepanel/SettingsView.tsx` (`DraftAgentSection`, lines 287–373)

**Interfaces:**
- Consumes: `normaliseAgentStatus` and `agentCardView` (Task 8), `agent_status` (Task 7).
- Produces:
  - `getAgentStatus(): Promise<AgentStatus>`
  - `<AgentProgress view={CardView} now={number} />`

Card behaviour:
- `DraftAgentSection` keeps its current toggle, helper text, logins and error.
- Its `useEffect` polls `getAgentStatus()` every 5000 ms. It pauses while `document.visibilityState !== 'visible'` (listen for `visibilitychange`) and clears on unmount.
- A 1 s local clock (`now`) drives the timers between polls.
- If the call fails with `isDraftStoreNotSetUp`, stop polling and render no progress. Other errors keep the last view, plus one soft line.
- After toggling, refresh status at once.
- `AgentProgress` follows the mockup `b-states-v2.html` exactly: same structure, `--mint-*` tokens, and dot styles for done, now (pulsing), wait, slow and skipped (dashed).

- [ ] **Step 1: Add** `getAgentStatus` and the regex entry. Extend `src/api/draftStore.test.ts` (or create it) with a case asserting that `isDraftStoreNotSetUp(new Error("Unknown action: 'agent_status'"))` is true.
- [ ] **Step 2: Build** `AgentProgress.tsx` and wire `DraftAgentSection`.
- [ ] **Step 3: Run** `npm test`, `npx tsc -b` and `npm run build`. Expected: all PASS.
- [ ] **Step 4: Manual check.** Load the built extension and open Settings while the agent is running and while it is paused. Compare against the mockup states: working, waiting, idle, paused, and between checks. With DevTools open, confirm that hiding the panel stops the native calls.
- [ ] **Step 5: Commit** with message `settings: live Sidekick Agent progress card`.
