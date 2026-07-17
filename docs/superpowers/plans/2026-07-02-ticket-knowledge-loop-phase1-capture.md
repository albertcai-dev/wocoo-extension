# Ticket Knowledge Loop — Phase 1 (Capture) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every ticket Albert resolves (Done / Cancelled / Moved) is auto-logged to a Google Sheet with optional resolution note, tools used, mistriage flag, and novelty flag — driven by a transition listener in the WOCOO extension and an inline non-modal note prompt.

**Architecture:** Extension detects Jira transitions two ways — (a) any sidepanel-initiated `transitionTicket` call fires a local event on success, and (b) a content script observes the Jira status pill and broadcasts to the service worker when it changes. Both feed a single dedup'd event bus inside the sidepanel. When an event lands, the sidepanel writes a bare-metadata row via a new Apps Script bridge endpoint and shows an inline non-modal `NotePrompt` that can update the row with resolution note + tools + flags, or be dismissed to keep only the metadata.

**Tech Stack:** Vite + React + TypeScript Chrome extension (MV3), Google Apps Script bridge (Web App), Google Sheets. No new deps.

## Global Constraints

- **Apps Script edits via the web editor only.** Per `feedback_no_clasp` — do not propose `clasp` commands. Paste the code blocks below verbatim into the GAS editor.
- **Re-deploy is required** after editing GAS code, per `reference_apps_script_gotchas` — Apps Script caches at deploy time.
- **The wocoo-extension directory is NOT a git repo.** Steps do not include `git commit`; verification is manual (build succeeds, extension reload, click through the flow, watch the sheet).
- **Existing bridge base URL** in `extension/src/api/bridge.ts:10-11` is reused. The new handler is added to the same Apps Script project.
- **Sidepanel-originating transitions and DOM-observed transitions can fire for the same event.** Dedup key is `ticketId + kind + 30-second bucket` — only the first wins per bucket.
- **Rows are always written on transition,** even if the note prompt is skipped or dismissed. The prompt updates the existing row by `ticket_id + logged_at`; it does not create a second row.
- **No unit test framework in this repo.** Verification is via `npm run build` + Chrome extension reload + real click-through with a live Jira ticket (use a test ticket).

---

## File Structure

| Path | Change |
|---|---|
| Apps Script bridge `code.gs` (web editor) | Add `handleLogTicket` and `handleUpdateTicketLog` handlers + dispatcher cases. Sheet ID is a top-level GAS constant. |
| New Google Sheet (owned by Albert) | Create with schema from spec Section "Sheet Schema"; grab sheet ID for the GAS constant. |
| `extension/src/data/ticketLogTypes.ts` | New file. `TicketLogPayload` interface + `TicketTransitionKind` type. |
| `extension/src/api/bridge.ts` | Add `logTicketViaBridge` and `updateTicketLogViaBridge` calls, mirroring `logMoveViaBridge` pattern. |
| `extension/src/api/jira.ts` | Modify `transitionTicket` (line 369) to emit a `ticketTransition` event on success. Add helper `emitMoveTransition` for MoveModal to call. |
| `extension/src/sidepanel/ticketLogEvents.ts` | New file. Tiny event bus (`emitTicketTransition`, `subscribeToTicketTransitions`) with 30s-bucket dedup. |
| `extension/src/content/jira.ts` | Extend content script (currently 64 lines) with status-pill MutationObserver + broadcast. |
| `extension/src/background/service-worker.ts` | Extend service worker (currently 86 lines) to relay `wocoo:transition-detected` messages to any open sidepanel via `chrome.runtime.sendMessage`. |
| `extension/src/sidepanel/NotePrompt.tsx` | New file. Inline non-modal card component with note/tools/mistriaged/novel fields + Save/Skip. |
| `extension/src/sidepanel/SidePanel.tsx` | Hook up `subscribeToTicketTransitions`, render `NotePrompt` for the latest event, maintain an "unsaved chip" queue for dismissed prompts. Also add `emitMoveTransition` calls into `MoveModal`. |
| `extension/src/sidepanel/MoveModal.tsx` | On successful move-flow completion, call `emitMoveTransition(sourceTicketId, destProject)`. |
| WOCOO Notion page | Manual restructure per the template in the spec. Standalone task, no code dependency. |

---

## Task 1: Create Google Sheet + Apps Script `logTicket` / `updateTicketLog` handlers

**Files:**
- Create: A new Google Sheet titled "WOCOO Ticket Log — Albert" in Albert's Drive.
- Modify (via GAS web editor): the bridge project's `code.gs` — append constants + two handlers + two dispatcher cases.

**Interfaces:**
- Consumes: nothing from earlier tasks. `SpreadsheetApp`, `Utilities`, `Session` (GAS built-ins).
- Produces:
  - Bridge action `logTicket` accepting query params: `ticket_id`, `ticket_link`, `summary`, `description_snippet`, `original_work_type`, `final_work_type`, `transition`, `moved_to_board`, `time_on_ticket_minutes`. Returns `{ action: 'ticketLogged', row_number: <n>, logged_at: <iso> }`.
  - Bridge action `updateTicketLog` accepting query params: `row_number`, `resolution_note`, `tools_used`, `mistriaged` ("true"/"false"), `novel_pattern` ("true"/"false"), `novel_note`. Returns `{ action: 'ticketLogUpdated' }`.

- [ ] **Step 1: Create the sheet.** Go to `sheets.new` (signed in as Albert). Rename it to "WOCOO Ticket Log — Albert." Rename the default tab to `Log`. In row 1, paste these column headers left to right:

```
logged_at	ticket_id	ticket_link	summary	description_snippet	original_work_type	final_work_type	transition	moved_to_board	resolution_note	tools_used	mistriaged	novel_pattern	novel_note	time_on_ticket_minutes	embedding	embedded_at	promoted_at
```

Freeze row 1 (View → Freeze → 1 row). Copy the sheet ID from the URL — the string between `/d/` and `/edit`.

- [ ] **Step 2: Open the existing WOCOO bridge Apps Script project.** The URL is derived from the deployment URL in `extension/src/api/bridge.ts:11` — open Apps Script by going to `script.google.com` and finding the project that owns that deployment (or open the deployment URL, then Deploy → Manage Deployments → click the project name in the header).

- [ ] **Step 3: Append the sheet constant and headers block** at the end of `code.gs`:

```js
// ============================================================
// Ticket Log (Phase 1 of Ticket Knowledge Loop)
// ============================================================
const TICKET_LOG_SPREADSHEET_ID = 'PASTE_SHEET_ID_HERE'; // from Step 1
const TICKET_LOG_TAB = 'Log';

// Column indices are 1-indexed (SpreadsheetApp is 1-indexed).
const TL_COL_LOGGED_AT = 1;
const TL_COL_TICKET_ID = 2;
const TL_COL_TICKET_LINK = 3;
const TL_COL_SUMMARY = 4;
const TL_COL_DESCRIPTION_SNIPPET = 5;
const TL_COL_ORIGINAL_WORK_TYPE = 6;
const TL_COL_FINAL_WORK_TYPE = 7;
const TL_COL_TRANSITION = 8;
const TL_COL_MOVED_TO_BOARD = 9;
const TL_COL_RESOLUTION_NOTE = 10;
const TL_COL_TOOLS_USED = 11;
const TL_COL_MISTRIAGED = 12;
const TL_COL_NOVEL_PATTERN = 13;
const TL_COL_NOVEL_NOTE = 14;
const TL_COL_TIME_ON_TICKET_MINUTES = 15;
const TL_COL_EMBEDDING = 16;
const TL_COL_EMBEDDED_AT = 17;
const TL_COL_PROMOTED_AT = 18;
```

Replace `PASTE_SHEET_ID_HERE` with the sheet ID from Step 1.

- [ ] **Step 4: Append the two handler functions** after the constants block:

```js
function handleLogTicket(params) {
  const ss = SpreadsheetApp.openById(TICKET_LOG_SPREADSHEET_ID);
  const sh = ss.getSheetByName(TICKET_LOG_TAB);
  if (!sh) throw new Error('Log tab not found in ' + TICKET_LOG_SPREADSHEET_ID);

  const now = new Date();
  const loggedAtIso = now.toISOString();

  const row = new Array(18).fill('');
  row[TL_COL_LOGGED_AT - 1] = loggedAtIso;
  row[TL_COL_TICKET_ID - 1] = String(params.ticket_id || '');
  row[TL_COL_TICKET_LINK - 1] = String(params.ticket_link || '');
  row[TL_COL_SUMMARY - 1] = String(params.summary || '');
  row[TL_COL_DESCRIPTION_SNIPPET - 1] = String(params.description_snippet || '');
  row[TL_COL_ORIGINAL_WORK_TYPE - 1] = String(params.original_work_type || '');
  row[TL_COL_FINAL_WORK_TYPE - 1] = String(params.final_work_type || '');
  row[TL_COL_TRANSITION - 1] = String(params.transition || '');
  row[TL_COL_MOVED_TO_BOARD - 1] = String(params.moved_to_board || '');
  // 10-14 (note/tools/flags/novel_note) left blank — filled by updateTicketLog if user saves the prompt.
  const tMin = Number(params.time_on_ticket_minutes || 0);
  row[TL_COL_TIME_ON_TICKET_MINUTES - 1] = isFinite(tMin) && tMin > 0 ? tMin : '';
  // 16-18 (embedding, embedded_at, promoted_at) left blank — filled by Phase 2 / Phase 3 workers.

  sh.appendRow(row);
  const rowNumber = sh.getLastRow();
  return { action: 'ticketLogged', row_number: rowNumber, logged_at: loggedAtIso };
}

function handleUpdateTicketLog(params) {
  const ss = SpreadsheetApp.openById(TICKET_LOG_SPREADSHEET_ID);
  const sh = ss.getSheetByName(TICKET_LOG_TAB);
  if (!sh) throw new Error('Log tab not found in ' + TICKET_LOG_SPREADSHEET_ID);

  const rowNumber = Number(params.row_number);
  if (!isFinite(rowNumber) || rowNumber < 2) throw new Error('Invalid row_number: ' + params.row_number);

  const updates = [
    [TL_COL_RESOLUTION_NOTE, String(params.resolution_note || '')],
    [TL_COL_TOOLS_USED, String(params.tools_used || '')],
    [TL_COL_MISTRIAGED, params.mistriaged === 'true' ? 'TRUE' : 'FALSE'],
    [TL_COL_NOVEL_PATTERN, params.novel_pattern === 'true' ? 'TRUE' : 'FALSE'],
    [TL_COL_NOVEL_NOTE, String(params.novel_note || '')],
  ];
  updates.forEach(function (u) {
    sh.getRange(rowNumber, u[0]).setValue(u[1]);
  });
  return { action: 'ticketLogUpdated' };
}
```

- [ ] **Step 5: Wire the dispatcher.** Find the existing `doGet` (or `doPost`) function in `code.gs` — it has a switch/if chain on `params.action`. Add two branches:

```js
if (action === 'logTicket') {
  return replyJson(handleLogTicket(params));
}
if (action === 'updateTicketLog') {
  return replyJson(handleUpdateTicketLog(params));
}
```

Use the same `replyJson` (or equivalent) helper the file already uses for other actions. If the file uses a `switch (action) { case '...': ... }` shape, add matching `case 'logTicket':` and `case 'updateTicketLog':` branches instead.

- [ ] **Step 6: Save + re-deploy.** In the GAS editor: Deploy → Manage Deployments → the active Web App deployment → Edit (pencil) → Version: New version → Deploy. Confirm the deployment URL is unchanged (matches `BRIDGE_URL` in `extension/src/api/bridge.ts:11`).

- [ ] **Step 7: Smoke-test `handleLogTicket` directly.** In the GAS editor, create a scratch function at the very bottom:

```js
function _testLogTicketRoundTrip() {
  const r = handleLogTicket({
    ticket_id: 'WOCOO-TEST-1',
    ticket_link: 'https://wealthsimple.atlassian.net/browse/WOCOO-TEST-1',
    summary: 'smoke test summary',
    description_snippet: 'smoke test description snippet',
    original_work_type: 'Test WT',
    final_work_type: '',
    transition: 'Done',
    moved_to_board: '',
    time_on_ticket_minutes: '7',
  });
  Logger.log(JSON.stringify(r));
  const u = handleUpdateTicketLog({
    row_number: String(r.row_number),
    resolution_note: 'smoke test note',
    tools_used: 'SQL: cc_fees_daily',
    mistriaged: 'false',
    novel_pattern: 'true',
    novel_note: 'smoke test novel',
  });
  Logger.log(JSON.stringify(u));
}
```

Select `_testLogTicketRoundTrip` in the Run dropdown, click Run. Grant sheet-access permissions when prompted.

Expected: Execution log prints `{"action":"ticketLogged","row_number":2,"logged_at":"..."}` then `{"action":"ticketLogUpdated"}`. Open the sheet — row 2 has all values set correctly, including `resolution_note`, `tools_used`, `mistriaged` = FALSE, `novel_pattern` = TRUE, `novel_note` set. Delete row 2 after verifying, and delete the `_testLogTicketRoundTrip` function.

- [ ] **Step 8: Update Albert's memory** with the sheet ID. Add a new memory file under `~/.claude/projects/-Users-albert-cai/memory/`:

Create `reference_ticket_log_sheet.md`:

```markdown
---
name: reference-ticket-log-sheet
description: WOCOO Ticket Log sheet (Phase 1 of Ticket Knowledge Loop) + Apps Script bridge actions
metadata:
  type: reference
---

Sheet: "WOCOO Ticket Log — Albert"
Sheet ID: <PASTE_SHEET_ID>
Tab: `Log`

Bridge actions on the existing WOCOO Apps Script:
- `logTicket` (writes a row on transition, returns row_number)
- `updateTicketLog` (updates fields 10-14 by row_number after the user saves the note prompt)

See [[project_wocoo_extension]] for extension-side wiring.
```

Then add one line to `MEMORY.md`:

```
- [Ticket Log sheet + bridge](reference_ticket_log_sheet.md) — Phase 1 sheet ID + logTicket/updateTicketLog bridge actions
```

---

## Task 2: Extension types + bridge caller

**Files:**
- Create: `extension/src/data/ticketLogTypes.ts`
- Modify: `extension/src/api/bridge.ts` (append two new exported functions to the end of the file)

**Interfaces:**
- Consumes: `callBridge` (already exists in `bridge.ts`).
- Produces:
  - `TicketTransitionKind = 'Done' | 'Cancelled' | 'Moved'`
  - `TicketLogPayload` interface (all fields from the sheet's write-time columns).
  - `TicketLogUpdatePayload` interface (fields 10-14 + row_number).
  - `logTicketViaBridge(p: TicketLogPayload): Promise<{ rowNumber: number; loggedAt: string }>`
  - `updateTicketLogViaBridge(p: TicketLogUpdatePayload): Promise<void>`

- [ ] **Step 1: Create `extension/src/data/ticketLogTypes.ts`:**

```ts
// Types for the Phase 1 ticket log — payload shapes shared between the sidepanel
// (which emits transitions) and the Apps Script bridge (which writes rows).

export type TicketTransitionKind = 'Done' | 'Cancelled' | 'Moved';

export interface TicketLogPayload {
  ticketId: string;
  ticketLink: string;
  summary: string;
  descriptionSnippet: string; // first ~500 chars, trimmed by caller
  originalWorkType: string;
  finalWorkType: string; // blank if unchanged
  transition: TicketTransitionKind;
  movedToBoard: string; // blank unless transition === 'Moved'
  timeOnTicketMinutes: number; // 0 if unknown
}

export interface TicketLogUpdatePayload {
  rowNumber: number;
  resolutionNote: string;
  toolsUsed: string;
  mistriaged: boolean;
  novelPattern: boolean;
  novelNote: string;
}
```

- [ ] **Step 2: Append to `extension/src/api/bridge.ts`** (do NOT touch existing exports):

```ts
// ============ Ticket Log bridge calls (Phase 1 of Ticket Knowledge Loop) ============

import type { TicketLogPayload, TicketLogUpdatePayload } from '../data/ticketLogTypes';

/** Append a row to the Ticket Log sheet. Fires immediately on transition; the row is
 *  bare-metadata until the user saves the note prompt (updateTicketLogViaBridge). */
export async function logTicketViaBridge(p: TicketLogPayload): Promise<{ rowNumber: number; loggedAt: string }> {
  const res = await callBridge('logTicket', {
    ticket_id: p.ticketId,
    ticket_link: p.ticketLink,
    summary: p.summary,
    description_snippet: p.descriptionSnippet,
    original_work_type: p.originalWorkType,
    final_work_type: p.finalWorkType,
    transition: p.transition,
    moved_to_board: p.movedToBoard,
    time_on_ticket_minutes: String(p.timeOnTicketMinutes),
  }, 'ticketLogged');
  return {
    rowNumber: Number(res.row_number),
    loggedAt: String(res.logged_at || ''),
  };
}

/** Fill in note/tools/flags on an existing row (row_number returned by logTicketViaBridge). */
export async function updateTicketLogViaBridge(p: TicketLogUpdatePayload): Promise<void> {
  await callBridge('updateTicketLog', {
    row_number: String(p.rowNumber),
    resolution_note: p.resolutionNote,
    tools_used: p.toolsUsed,
    mistriaged: p.mistriaged ? 'true' : 'false',
    novel_pattern: p.novelPattern ? 'true' : 'false',
    novel_note: p.novelNote,
  }, 'ticketLogUpdated');
}
```

- [ ] **Step 3: Verify the build passes.** Run:

```bash
cd ~/projects/wocoo-extension/extension && npm run build
```

Expected: `vite v5.x building for production...` then `✓ built in ...s` with no TypeScript errors. If TS complains about unused imports in `bridge.ts`, ensure the `import type` line lives at the top of the appended block (or move it to the top of the file with the other imports — whichever is stylistically consistent with the rest of the file).

---

## Task 3: Ticket transition event bus (in-sidepanel)

**Files:**
- Create: `extension/src/sidepanel/ticketLogEvents.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `TicketTransitionEvent` interface (ticketId, kind, movedToBoard?, source: 'sidepanel' | 'dom').
  - `emitTicketTransition(evt: TicketTransitionEvent): boolean` — returns `false` when deduped, `true` when accepted.
  - `subscribeToTicketTransitions(cb: (evt: TicketTransitionEvent) => void): () => void` — returns an unsubscribe function.

- [ ] **Step 1: Create `extension/src/sidepanel/ticketLogEvents.ts`:**

```ts
// Tiny in-process event bus for ticket transitions. Two sources push into it:
//   1. Sidepanel-originating transitionTicket() calls (wrapped in api/jira.ts).
//   2. Content-script status-pill observations, relayed through the service worker
//      and re-emitted here by SidePanel.tsx's chrome.runtime.onMessage listener.
//
// Dedup: same ticketId + kind within 30 seconds is dropped. Prevents both channels
// firing for the same transition (sidepanel button click also updates the Jira DOM
// which the observer sees a moment later).

import type { TicketTransitionKind } from '../data/ticketLogTypes';

export interface TicketTransitionEvent {
  ticketId: string;
  kind: TicketTransitionKind;
  movedToBoard?: string;
  source: 'sidepanel' | 'dom';
}

const DEDUP_WINDOW_MS = 30_000;

type Listener = (evt: TicketTransitionEvent) => void;
const listeners = new Set<Listener>();
const recent = new Map<string, number>(); // key: `${ticketId}::${kind}` -> timestampMs

function dedupKey(evt: TicketTransitionEvent): string {
  return evt.ticketId + '::' + evt.kind;
}

export function emitTicketTransition(evt: TicketTransitionEvent): boolean {
  const key = dedupKey(evt);
  const now = Date.now();
  const last = recent.get(key);
  if (last != null && now - last < DEDUP_WINDOW_MS) {
    console.debug('[ticketLog] deduped', evt.source, key);
    return false;
  }
  recent.set(key, now);
  console.debug('[ticketLog] emit', evt.source, key, evt);
  listeners.forEach((l) => {
    try { l(evt); } catch (e) { console.error('[ticketLog] listener threw', e); }
  });
  // Garbage-collect old dedup entries occasionally.
  if (recent.size > 200) {
    for (const [k, t] of recent) {
      if (now - t > DEDUP_WINDOW_MS) recent.delete(k);
    }
  }
  return true;
}

export function subscribeToTicketTransitions(cb: Listener): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}
```

- [ ] **Step 2: Verify the build passes.** Run:

```bash
cd ~/projects/wocoo-extension/extension && npm run build
```

Expected: clean build. The file has no runtime side effects yet; it just exports.

---

## Task 4: Wrap `transitionTicket` + instrument MoveModal

**Files:**
- Modify: `extension/src/api/jira.ts` — replace lines 363-386 (existing `transitionTicket`) with a wrapped version that emits an event on success. Do NOT change the function signature; existing callers work unchanged.
- Modify: `extension/src/sidepanel/MoveModal.tsx` — after the Clone/Move flow's terminal success branch, emit a 'Moved' event.

**Interfaces:**
- Consumes: `emitTicketTransition` from `sidepanel/ticketLogEvents.ts` (Task 3).
- Produces: `emitMoveTransition(sourceTicketId: string, destProject: string): void` exported from `sidepanel/ticketLogEvents.ts` — a thin convenience wrapper for MoveModal.

- [ ] **Step 1: Add the convenience wrapper to `sidepanel/ticketLogEvents.ts`.** Append to the file created in Task 3:

```ts
export function emitMoveTransition(sourceTicketId: string, destProject: string): void {
  emitTicketTransition({
    ticketId: sourceTicketId,
    kind: 'Moved',
    movedToBoard: destProject,
    source: 'sidepanel',
  });
}
```

- [ ] **Step 2: Wrap `transitionTicket` in `extension/src/api/jira.ts`.** Replace the existing function (lines 363-386) with:

```ts
/**
 * Transition a Jira issue to a new state by transition ID.
 * Common transition IDs in WOCOO:
 *   - 251: Move to Done
 *   - 261: Cancel (verify against your workflow; adjust if different)
 * Returns void on success (Jira returns 204 No Content).
 *
 * On success this ALSO emits a ticketTransition event so the Phase 1 Capture flow
 * can log a row. The transition ID → kind mapping is intentionally minimal:
 * ID '251' -> 'Done'; anything else -> 'Cancelled' by default. If more transitions
 * are ever wired through this function that are NOT terminal (e.g. re-open), the
 * caller must guard the emit itself; today all callers use terminal transitions.
 */
export async function transitionTicket(ticketKey: string, transitionId: string): Promise<void> {
  const token = await getValidAccessToken();
  const cloudId = await getCloudId();
  const url = `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/issue/${encodeURIComponent(ticketKey)}/transitions`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ transition: { id: transitionId } }),
  });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error('Transition failed (HTTP ' + resp.status + '): ' + txt);
  }
  // Emit for the Phase 1 Capture flow. Lazy-import to avoid a hard dependency from
  // the API layer into the sidepanel layer — the sidepanel-only bus is a no-op in
  // any hypothetical non-sidepanel caller.
  try {
    const { emitTicketTransition } = await import('../sidepanel/ticketLogEvents');
    const kind = transitionId === '251' ? 'Done' : 'Cancelled';
    emitTicketTransition({ ticketId: ticketKey, kind, source: 'sidepanel' });
  } catch (e) {
    console.debug('[jira.transitionTicket] event emit failed (non-fatal):', e);
  }
}
```

- [ ] **Step 3: Instrument MoveModal.** Open `extension/src/sidepanel/MoveModal.tsx`. Locate the top of the file's imports and add:

```ts
import { emitMoveTransition } from './ticketLogEvents';
```

Next, find the branch where the entire Move flow succeeds. From your grep earlier this is around line 294-296 of `MoveModal.tsx` — the block that transitions the CLONE to Done. Immediately AFTER the try/catch around `transitionTicket(clone.key, '251')` — that is, once all move steps have completed and `warnings` is finalized — add:

```ts
try {
  emitMoveTransition(ticket.id, destProject);
} catch (e) {
  console.debug('[MoveModal] emitMoveTransition failed (non-fatal):', e);
}
```

Where `ticket.id` is the source ticket key (already in scope from the component's `ticket` prop) and `destProject` is the destination project key MoveModal already tracks (open the file and confirm the exact variable name — likely `destKey`, `destination`, or similar — and use the matching name).

- [ ] **Step 4: Verify the build passes.**

```bash
cd ~/projects/wocoo-extension/extension && npm run build
```

Expected: clean build.

- [ ] **Step 5: Manual smoke test.** Reload the extension in `chrome://extensions/`, open the sidepanel on a WOCOO test ticket, open DevTools on the panel. Click any workflow that ends in `transitionTicket` (e.g. Visa Companion, or the panel's `Done` button if it has one). In the DevTools console you should see a `[ticketLog] emit sidepanel WOCOO-XXXXX::Done` log. Then click a Clone/Move to a CRED destination — you should see `[ticketLog] emit sidepanel WOCOO-XXXXX::Moved` after the flow completes. (No rows are written yet — that's Task 7.)

---

## Task 5: Content-script status-pill observer + service-worker relay

**Files:**
- Modify: `extension/src/content/jira.ts` (currently 64 lines) — add MutationObserver on the status pill and broadcast on change.
- Modify: `extension/src/background/service-worker.ts` (currently 86 lines) — relay `wocoo:transition-detected` messages to sidepanel-side listeners.

**Interfaces:**
- Consumes: nothing from earlier tasks (only Chrome APIs).
- Produces:
  - Chrome runtime message shape: `{ type: 'wocoo:transition-detected', ticketId: string, statusName: string }`. The service worker relays this to the sidepanel via `chrome.runtime.sendMessage` (the sidepanel already listens for `wocoo:ticket-changed`; we register a second handler).

- [ ] **Step 1: Extend `extension/src/content/jira.ts`.** Append the following AFTER the existing `hashchange` listener (currently the last line at 64):

```ts
// ------------------------------------------------------------
// Status-pill observer: detects when a WOCOO ticket transitions to Done / Cancelled
// (or any other status) while the user is viewing it in Jira, whether the transition
// came from the sidepanel or from Jira's own status dropdown.
//
// The selector Atlassian uses for the status pill on the detail view is not stable
// across product surfaces; we use a defensive combination of aria-label + data-testid
// and fall back to text content of any element with role="button" whose text matches
// a known WOCOO status ("Done", "Cancelled", "In Progress", etc.). Only "terminal"
// transitions (Done / Cancelled) are broadcast — other status transitions are noisy
// and not useful for the ticket log.
// ------------------------------------------------------------

const TERMINAL_STATUSES = new Set(['Done', 'Cancelled', 'Canceled']);

function findStatusPillText(): string | null {
  // Jira "status" button typically has data-testid containing "status-field" OR
  // aria-label starting with "Change status". Try both, take the visible text.
  const candidates = Array.from(document.querySelectorAll<HTMLElement>(
    '[data-testid*="status" i], [aria-label*="Change status" i]'
  ));
  for (const el of candidates) {
    const text = (el.innerText || el.textContent || '').trim();
    if (text) return text;
  }
  return null;
}

let lastStatusByTicket: Record<string, string> = {};

function checkStatusChange(): void {
  const key = currentTicketKey();
  if (!key) return;
  const status = findStatusPillText();
  if (!status) return;
  const prev = lastStatusByTicket[key];
  if (prev === status) return;
  lastStatusByTicket[key] = status;
  if (prev == null) return; // first observation; don't fire — user just landed
  if (!TERMINAL_STATUSES.has(status)) return;
  try {
    chrome.runtime.sendMessage({
      type: 'wocoo:transition-detected',
      ticketId: key,
      statusName: status,
    });
  } catch (e) {
    // Service worker asleep or panel closed — nothing to do.
  }
}

// Observe body mutations at a coarse level; the status pill lives deep in a
// virtualized tree so a global observer is simpler than pinning to the pill's
// container (which re-mounts on nav). Debounce to avoid thrashing on typing.
let mutationDebounce: number | null = null;
const bodyObserver = new MutationObserver(() => {
  if (mutationDebounce != null) window.clearTimeout(mutationDebounce);
  mutationDebounce = window.setTimeout(() => { mutationDebounce = null; checkStatusChange(); }, 250);
});
bodyObserver.observe(document.body, { childList: true, subtree: true, characterData: true });

// Also check on SPA navigations (the URL change handlers above fire broadcast(); do
// a status check on the same beat).
window.addEventListener('popstate', () => setTimeout(checkStatusChange, 400));
window.addEventListener('hashchange', () => setTimeout(checkStatusChange, 400));
```

- [ ] **Step 2: Extend `extension/src/background/service-worker.ts`** to relay the new message type. Read the file first to find the existing `chrome.runtime.onMessage.addListener` callback (there is one for `wocoo:ticket-changed`). Inside that same listener callback, add a branch:

```ts
if (msg && msg.type === 'wocoo:transition-detected') {
  // Broadcast to the sidepanel. Sidepanel-open state is not directly observable
  // from the service worker in MV3, so we fire-and-forget — sendMessage rejects
  // silently if no listener is registered.
  try {
    chrome.runtime.sendMessage({
      type: 'wocoo:transition-detected',
      ticketId: msg.ticketId,
      statusName: msg.statusName,
    }).catch(() => { /* no sidepanel open */ });
  } catch (e) {
    /* no sidepanel open */
  }
  return; // fully handled; don't fall through to other branches
}
```

Place this branch BEFORE the existing `wocoo:ticket-changed` handling (or after — order doesn't matter as long as it doesn't accidentally intercept other message types).

- [ ] **Step 3: Verify the build passes.**

```bash
cd ~/projects/wocoo-extension/extension && npm run build
```

Expected: clean build.

- [ ] **Step 4: Manual smoke test.** Reload the extension. Open a WOCOO test ticket in the main Jira tab. Open DevTools on the SIDEPANEL (not the Jira tab). In Jira, transition the ticket to Done via Jira's own status dropdown (not the sidepanel button). Within ~500ms, the sidepanel console should show the incoming `chrome.runtime.onMessage` for `wocoo:transition-detected`. (No sidepanel-side handler yet — that's Task 7. This test only confirms the message reaches the sidepanel process.)

If nothing arrives: open DevTools on the Jira tab (not the sidepanel) and confirm the content script's console log shows the status change was detected. If the content script sees the change but the sidepanel doesn't, the service-worker relay is the culprit — check the branch order.

---

## Task 6: `NotePrompt` component

**Files:**
- Create: `extension/src/sidepanel/NotePrompt.tsx`

**Interfaces:**
- Consumes: `TicketTransitionEvent` from `ticketLogEvents.ts`, `TicketLogUpdatePayload` from `data/ticketLogTypes.ts`, `updateTicketLogViaBridge` from `api/bridge.ts`.
- Produces:
  - Component props:
    ```ts
    interface NotePromptProps {
      ticketId: string;
      kind: TicketTransitionKind;
      rowNumber: number;
      seedResolutionNote?: string;
      seedToolsUsed?: string;
      seedNovelPattern?: boolean;
      onSaved: () => void;   // called after Save & close succeeds
      onSkipped: () => void; // called after Skip button clicked (no bridge call)
      onDismissed: () => void; // called if the user closes without either
    }
    ```

- [ ] **Step 1: Create `extension/src/sidepanel/NotePrompt.tsx`:**

```tsx
// Inline non-modal prompt that appears in the sidepanel immediately after a Jira
// transition is detected (either from a sidepanel button click or the Jira DOM
// observer). The row has already been written by the transition handler; this
// component's job is to (optionally) fill in the note / tools / flags on that row.
//
// Non-modal means the user can dismiss this without losing anything — the bare-
// metadata row stays in the sheet. Dismissal creates an "unsaved chip" the user
// can click to bring the prompt back within 5 minutes (managed by the parent,
// SidePanel.tsx).

import { useState } from 'react';
import type { TicketTransitionKind } from '../data/ticketLogTypes';
import { updateTicketLogViaBridge } from '../api/bridge';

interface NotePromptProps {
  ticketId: string;
  kind: TicketTransitionKind;
  rowNumber: number;
  seedResolutionNote?: string;
  seedToolsUsed?: string;
  seedNovelPattern?: boolean;
  onSaved: () => void;
  onSkipped: () => void;
  onDismissed: () => void;
}

export function NotePrompt({
  ticketId,
  kind,
  rowNumber,
  seedResolutionNote = '',
  seedToolsUsed = '',
  seedNovelPattern = false,
  onSaved,
  onSkipped,
  onDismissed,
}: NotePromptProps) {
  const [note, setNote] = useState(seedResolutionNote);
  const [tools, setTools] = useState(seedToolsUsed);
  const [mistriaged, setMistriaged] = useState(false);
  const [novel, setNovel] = useState(seedNovelPattern);
  const [novelNote, setNovelNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      await updateTicketLogViaBridge({
        rowNumber,
        resolutionNote: note,
        toolsUsed: tools,
        mistriaged,
        novelPattern: novel,
        novelNote: novel ? novelNote : '',
      });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  }

  return (
    <section
      style={{
        border: '1px solid var(--mint-border, #d0d5dd)',
        borderRadius: 8,
        padding: 12,
        margin: '12px 0',
        background: 'var(--mint-highlight-bg-soft, #f4f7fb)',
      }}
      aria-live="polite"
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
        <div style={{ fontWeight: 700, fontSize: 13 }}>
          Logged: {ticketId} → {kind}
        </div>
        <button
          onClick={onDismissed}
          style={{ background: 'none', border: 'none', fontSize: 16, cursor: 'pointer', padding: 4 }}
          aria-label="Dismiss note prompt"
          title="Dismiss (metadata row is kept)"
        >
          ✕
        </button>
      </div>

      <label style={{ display: 'block', fontSize: 11, marginTop: 8, marginBottom: 2, color: 'var(--mint-fg-soft, #667085)' }}>
        Resolution note (optional)
      </label>
      <input
        type="text"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="One line about what you did"
        style={{ width: '100%', padding: 6, fontSize: 13, boxSizing: 'border-box' }}
      />

      <label style={{ display: 'block', fontSize: 11, marginTop: 8, marginBottom: 2, color: 'var(--mint-fg-soft, #667085)' }}>
        Tools used (optional — free text; paste SQL, URLs, Guru card titles)
      </label>
      <textarea
        value={tools}
        onChange={(e) => setTools(e.target.value)}
        rows={2}
        style={{ width: '100%', padding: 6, fontSize: 13, boxSizing: 'border-box', resize: 'vertical' }}
      />

      <label style={{ display: 'flex', alignItems: 'center', marginTop: 8, fontSize: 12 }}>
        <input
          type="checkbox"
          checked={mistriaged}
          onChange={(e) => setMistriaged(e.target.checked)}
          style={{ marginRight: 6 }}
        />
        Mistriaged (agent picked wrong work type)
      </label>

      <label style={{ display: 'flex', alignItems: 'center', marginTop: 4, fontSize: 12 }}>
        <input
          type="checkbox"
          checked={novel}
          onChange={(e) => setNovel(e.target.checked)}
          style={{ marginRight: 6 }}
        />
        Novel pattern — flag for source-of-truth update
      </label>

      {novel ? (
        <textarea
          value={novelNote}
          onChange={(e) => setNovelNote(e.target.value)}
          rows={2}
          placeholder="1-2 sentences on what was new"
          style={{ width: '100%', padding: 6, fontSize: 13, boxSizing: 'border-box', resize: 'vertical', marginTop: 4 }}
        />
      ) : null}

      {error ? (
        <div style={{ color: '#b42318', fontSize: 12, marginTop: 8 }}>
          Save failed: {error}
        </div>
      ) : null}

      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <button
          onClick={handleSave}
          disabled={saving}
          style={{
            padding: '6px 12px',
            fontSize: 13,
            background: 'var(--mint-highlight-fg-strong, #175cd3)',
            color: '#fff',
            border: 'none',
            borderRadius: 6,
            cursor: saving ? 'default' : 'pointer',
            opacity: saving ? 0.6 : 1,
          }}
        >
          {saving ? 'Saving…' : 'Save & close'}
        </button>
        <button
          onClick={onSkipped}
          disabled={saving}
          style={{
            padding: '6px 12px',
            fontSize: 13,
            background: 'transparent',
            color: 'var(--mint-fg-soft, #667085)',
            border: '1px solid var(--mint-border, #d0d5dd)',
            borderRadius: 6,
            cursor: 'pointer',
          }}
        >
          Skip — log metadata only
        </button>
      </div>
    </section>
  );
}
```

- [ ] **Step 2: Verify the build passes.**

```bash
cd ~/projects/wocoo-extension/extension && npm run build
```

Expected: clean build. The component is not yet mounted anywhere — Task 7 handles that.

---

## Task 7: SidePanel integration — event subscription, row write, prompt render, unsaved chip

**Files:**
- Modify: `extension/src/sidepanel/SidePanel.tsx`

**Interfaces:**
- Consumes: everything from Tasks 2-6 (`subscribeToTicketTransitions`, `logTicketViaBridge`, `NotePrompt`).
- Produces: no new exports. Behavior only.

- [ ] **Step 1: Add imports to `SidePanel.tsx`.** Near the top of the file's imports:

```tsx
import { useEffect, useState } from 'react';
import { subscribeToTicketTransitions, emitTicketTransition, type TicketTransitionEvent } from './ticketLogEvents';
import { logTicketViaBridge } from '../api/bridge';
import { NotePrompt } from './NotePrompt';
```

If `useEffect` / `useState` are already imported from React, don't duplicate.

- [ ] **Step 2: Add the chrome.runtime bridge from service-worker messages into the event bus.** Anywhere at the top level of the module (outside any component), add:

```tsx
// Bridge: DOM-observer transition detections come in as chrome.runtime messages.
// Feed them into the local event bus so a single subscribe path handles both
// sidepanel-originating and DOM-originating transitions.
if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'wocoo:transition-detected') {
      const statusName: string = String(msg.statusName || '');
      const kind: 'Done' | 'Cancelled' = statusName === 'Cancelled' || statusName === 'Canceled' ? 'Cancelled' : 'Done';
      emitTicketTransition({
        ticketId: String(msg.ticketId),
        kind,
        source: 'dom',
      });
    }
  });
}
```

- [ ] **Step 3: Add state + effect for the note prompt inside the main SidePanel component.** Find the SidePanel functional component (around line 220-230 based on your earlier grep — the block that computes `description` and `descShort`). At the top of that component, add:

```tsx
// Ticket log: track the most recent transition event and the row_number returned
// from logTicketViaBridge, so NotePrompt can update it. `unsavedChips` holds
// dismissed prompts the user can restore for up to 5 minutes.
interface ActivePrompt {
  ticketId: string;
  kind: 'Done' | 'Cancelled' | 'Moved';
  rowNumber: number;
  movedToBoard?: string;
  createdAtMs: number;
}
const [activePrompt, setActivePrompt] = useState<ActivePrompt | null>(null);
const [unsavedChips, setUnsavedChips] = useState<ActivePrompt[]>([]);

useEffect(() => {
  const unsub = subscribeToTicketTransitions(async (evt: TicketTransitionEvent) => {
    // Best-effort description snippet + workType from the currently loaded ticket.
    // If the sidepanel is between tickets we still log with blanks — the transition
    // is authoritative.
    const t = ticket && ticket.id === evt.ticketId ? ticket : null;
    try {
      const { rowNumber } = await logTicketViaBridge({
        ticketId: evt.ticketId,
        ticketLink: 'https://wealthsimple.atlassian.net/browse/' + evt.ticketId,
        summary: t?.summary || '',
        descriptionSnippet: (t?.description || '').slice(0, 500),
        originalWorkType: t?.workType || '',
        finalWorkType: '', // Phase 1: blank; Phase 2 can reconcile with post-transition ticket refetch
        transition: evt.kind,
        movedToBoard: evt.movedToBoard || '',
        timeOnTicketMinutes: 0, // Phase 1: not tracked; Phase 2 wires this via panel-open timestamps
      });
      setActivePrompt({
        ticketId: evt.ticketId,
        kind: evt.kind,
        rowNumber,
        movedToBoard: evt.movedToBoard,
        createdAtMs: Date.now(),
      });
    } catch (e) {
      console.error('[SidePanel] logTicketViaBridge failed:', e);
      // Bridge failed; do not show the prompt (there's no row to update). Surface
      // an error toast if the panel has one; otherwise console-only per current
      // pattern in bridge.ts callers.
    }
  });
  return unsub;
}, [ticket]);

// Age out unsaved chips beyond 5 minutes. Runs on every render but tiny cost.
useEffect(() => {
  if (unsavedChips.length === 0) return;
  const now = Date.now();
  const kept = unsavedChips.filter((c) => now - c.createdAtMs < 5 * 60_000);
  if (kept.length !== unsavedChips.length) setUnsavedChips(kept);
  const nextExpiry = kept.length > 0 ? Math.min(...kept.map((c) => c.createdAtMs + 5 * 60_000)) : null;
  if (nextExpiry == null) return;
  const timer = window.setTimeout(() => setUnsavedChips((cs) => cs.filter((c) => Date.now() - c.createdAtMs < 5 * 60_000)), Math.max(1000, nextExpiry - now));
  return () => window.clearTimeout(timer);
}, [unsavedChips]);
```

Note: `ticket` in the effect body refers to the currently loaded ticket from the surrounding component. Confirm the exact variable name by looking at the file — from your grep it's `ticket`. If the file exposes it as `currentTicket` or similar, adjust.

- [ ] **Step 4: Render unsaved chips above the description.** In `SidePanel.tsx`, just BEFORE the `{/* DESCRIPTION */}` section at line 308, add:

```tsx
{unsavedChips.length > 0 ? (
  <section style={{ padding: '4px 12px', display: 'flex', flexWrap: 'wrap', gap: 6 }}>
    {unsavedChips.map((c) => (
      <button
        key={c.ticketId + '::' + c.createdAtMs}
        onClick={() => {
          setActivePrompt(c);
          setUnsavedChips((cs) => cs.filter((x) => x !== c));
        }}
        style={{
          fontSize: 11,
          padding: '3px 8px',
          borderRadius: 12,
          border: '1px solid var(--mint-border, #d0d5dd)',
          background: '#fff8ea',
          cursor: 'pointer',
        }}
        title="Reopen the note prompt for this ticket (kept for 5 min)"
      >
        unsaved: {c.ticketId} → {c.kind}
      </button>
    ))}
  </section>
) : null}
```

- [ ] **Step 5: Render the NotePrompt between description and workflow cards.** Directly AFTER the `{/* DESCRIPTION */}` section's closing `</section>` at line 322 and BEFORE the `{/* QC AUTO-REIMB DETECTION */}` line at 324, add:

```tsx
{activePrompt ? (
  <NotePrompt
    ticketId={activePrompt.ticketId}
    kind={activePrompt.kind}
    rowNumber={activePrompt.rowNumber}
    onSaved={() => setActivePrompt(null)}
    onSkipped={() => setActivePrompt(null)}
    onDismissed={() => {
      setUnsavedChips((cs) => [...cs, activePrompt]);
      setActivePrompt(null);
    }}
  />
) : null}
```

- [ ] **Step 6: Verify the build passes.**

```bash
cd ~/projects/wocoo-extension/extension && npm run build
```

Expected: clean build. If TypeScript complains that `ticket` might be undefined inside the effect callback, wrap the log-and-set block in `if (t == null && !evt.ticketId) return;` — but the code above already handles null-ticket by using blank strings.

- [ ] **Step 7: End-to-end manual smoke test.**

7a. Reload the extension in `chrome://extensions/`. Open a WOCOO test ticket in the main Jira tab. Open DevTools on the sidepanel.

7b. Trigger a sidepanel-originating transition. Best candidate: click the Visa Companion card's action button, or use a workflow that ends in `transitionTicket(ticket.id, '251')`. If your test ticket doesn't match any workflow, use MoveModal → Clone/Move to CRED.

7c. Within ~2 seconds:
   - The sidepanel should render a `NotePrompt` card between the description and the recommendation cards.
   - Open the Google Sheet from Task 1. A new row should exist with `ticket_id`, `transition` (Done or Moved), and the other metadata columns populated. Fields `resolution_note` through `novel_note` should be blank.

7d. Fill in `Resolution note` = "smoke test", tick `Novel pattern`, add novel note = "phase 1 e2e." Click Save & close.
   - The NotePrompt disappears.
   - The sheet row now has `resolution_note = smoke test`, `novel_pattern = TRUE`, `novel_note = phase 1 e2e`.

7e. Trigger another transition. When the NotePrompt appears, click the ✕ dismiss button.
   - The NotePrompt disappears.
   - A yellow chip labeled `unsaved: WOCOO-XXXXX → Done` appears near the top of the panel.
   - Click the chip — the NotePrompt reappears with the same row_number.

7f. Trigger a transition, then let the panel sit for 5 minutes and 30 seconds. Confirm the chip disappears on its own.

7g. Trigger a transition from OUTSIDE the sidepanel — in the Jira tab, use Jira's own status dropdown to move a ticket to Done. Within ~1 second the sidepanel should show the NotePrompt and a matching row should appear in the sheet. Then trigger the same-kind transition on the same ticket AGAIN within 30 seconds (via any path). Confirm that only ONE new row was written (dedup working).

If any of 7c-7g fails, add `console.log` at the failing boundary (event emit, bridge call, chrome.runtime.sendMessage relay) and iterate. Common breakages: (a) MoveModal's `destProject` variable is named differently in your file — adjust the Task 4 Step 3 call. (b) Jira's status pill selector doesn't match on some ticket types — widen the selector in `content/jira.ts`.

---

## Task 8: Notion source-of-truth restructure (manual — no code)

**Files:**
- Modify: The existing WOCOO Notion page at the URL in [User context — original message] (Wealthsimple Notion).

**Interfaces:**
- Consumes: nothing. This is a documentation task.
- Produces: A Notion page structured per the spec's "Notion Structure" section, ready for Phase 2 to hit via the Notion API.

- [ ] **Step 1: Duplicate the existing WOCOO Notion page** into a working copy (right-click page → Duplicate). Rename the copy `WOCOO Board — Ticket Playbook (v2 draft)`. This preserves the current page unchanged until you're ready to swap.

- [ ] **Step 2: Create the new top-level structure** on the v2 draft:

```
WOCOO Board — Ticket Playbook
  ├── Overview         (paste the current intro from v1; no rewrite needed)
  ├── Triage rules
  │   ├── When to keep on WOCOO
  │   ├── When to move to CRED
  │   ├── When to move to PFO
  │   └── When to move to EOC
  ├── Work types       (child pages, one per work type — see Step 3)
  └── Change log       (empty bulleted list; Phase 3 will append here)
```

- [ ] **Step 3: For each work type**, create a child page under "Work types" with the exact 5-block template. Use these headings verbatim inside each work-type sub-page:

```
When this applies
Steps
Tools + queries
Gotchas
Example tickets
```

Initial work-type sub-pages to create (add or split as content dictates):

- Reverse Fee
- Overpayment
- Inquiry Removal
- Statement Correction
- Retention Fee Waiver
- QC Fee Waiver
- QC Auto-Reimburse
- Wallet Provisioning
- Visa Companion
- Wires — Pending Posting
- Mobile Cheque Validation
- Card-Specific: i2c
- Card-Specific: Koho

- [ ] **Step 4: Migrate content from v1 into the v2 sub-pages.** For each existing section in the v1 page, find its work-type home in v2 and copy its content into the appropriate template block. If a v1 section doesn't fit any work type cleanly, either (a) create a new work-type sub-page for it or (b) put it under `Overview` if it's cross-cutting. Aim for one sub-page per resolvable work type; do not merge unrelated topics.

- [ ] **Step 5: Fill in Example tickets** by pasting 2-3 canonical Jira links per work type. Use tickets you personally remember solving well. If you can't recall any for a given work type, leave the section as `TBD — populate from ticket log as Phase 1 fills in`.

- [ ] **Step 6: Verify uniformity.** Every work-type sub-page must have ALL five heading blocks in that exact order, even if some blocks are empty. This uniformity is what makes Phase 2's embedding pipeline able to chunk cleanly.

- [ ] **Step 7: Publish + retire v1.** When v2 is complete: (a) rename v2 to `WOCOO Board — Ticket Playbook` (dropping the v2 draft suffix), (b) rename v1 to `WOCOO Board — Ticket Playbook (v1 archive, retired 2026-07-XX)`, (c) archive v1. Update the Notion pointer in Albert's memory file [[reference_wocoo_notion]] (or the equivalent existing entry) to reference the new page URL.

**No build or bridge verification** — this task is pure content work. Its completion signal is: every work-type sub-page has all five headings, and Phase 2 can start indexing.

---

## Verification Checklist (before declaring Phase 1 done)

Run through this after all tasks. Each item must pass:

- [ ] `npm run build` completes with no errors from `~/projects/wocoo-extension/extension/`.
- [ ] Google Sheet has all 18 columns in the correct order.
- [ ] Apps Script bridge redeploy succeeded (same URL) and `_testLogTicketRoundTrip` scratch function still writes/updates cleanly.
- [ ] Sidepanel transitions from any workflow write one row to the sheet.
- [ ] Jira-DOM-only transitions (no sidepanel involvement) also write one row.
- [ ] Same-kind transitions on the same ticket within 30 s only write ONE row (dedup).
- [ ] NotePrompt Save updates row fields 10-14 correctly (values match what was typed).
- [ ] NotePrompt Skip leaves fields 10-14 blank; row stays.
- [ ] NotePrompt Dismiss adds an unsaved chip that opens the prompt again.
- [ ] Unsaved chips age out at 5 minutes.
- [ ] Notion v2 page has all work-type sub-pages with the 5-block template; v1 archived.

Once every box is checked, Phase 1 is shippable. Phase 2 (Retrieval) can be started against the Phase 1 outputs.
