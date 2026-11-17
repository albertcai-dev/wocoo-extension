# Deactivate Wallet Token Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A "Deactivate token in i2c" button on the Sidekick Agent draft card. It opens the client's Manage Card Tokens page, Selects the Active token the agent named (matched by exact token ID), and fills New Status = deactivate, Reason = Other, Comments = WOCOO Jira link. Albert clicks Update Status himself.

**Architecture:** The existing `activate_token` chain is extended with a mode instead of being copied. Pure helpers in `extension/src/data/i2cTokenActivate.ts` decide the row and the options for each mode. `content/i2c.ts` runs one `tryTokenStatusChange()` for both flows. The side panel and draft card treat `deactivate_token` like `activate_token`. The draft agent (`~/projects/wocoo-draft-agent`) learns to emit the new workflow.

**Tech Stack:** TypeScript + React (MV3 extension, Vite, vitest); Python 3 unittest (draft agent).

**Spec:** `docs/superpowers/specs/2026-11-16-deactivate-token-design.md`

## Global Constraints

- Never Select or deactivate an **InActive** token, and never touch a **DeActivated** one. Only an **Active** row whose token ID matches exactly qualifies.
- Form values: New Status = the deactivate option (`/^(de-?activ(e|ate|ated)|delete)$/i`, never matching `InActive` or `Active`); Reason = `Other`; Comments = `https://wealthsimple.atlassian.net/browse/<WOCOO key>`.
- Never click Update Status. Albert's click ticks "I've done this", using the shared `TOKEN_ACTIVATED_KEY`.
- One token per run.
- PUBLIC repo (`wocoo-extension`): no real token numbers, emails or client data in tests, commits or docs. Use made-up 16-digit IDs.
- Activate behaviour must stay byte-for-byte the same (existing `i2cTokenActivate.test.ts` keeps passing unchanged).
- Own build only: build into `extension/dist`; nothing to the shared or AppSec repo.

## Review Focus

1. **Two Active rows on the same device** (WOCOO-31689 has two "Pixel 9 Pro" rows): match by token ID only. Task 1 test `never picks by device when IDs differ`.
2. **The agent names an InActive or DeActivated token for deactivation** → return null and leave it to Albert. Task 1 test `refuses InActive and DeActivated rows even with a matching id`.
3. **Token ID shown with spaces or masked** (`4133 5295 3810 6527`, or a masked middle) → strip whitespace when comparing. A masked cell never matches, so the result is null. Task 1 test `compares ids ignoring whitespace; a masked id never matches`.
4. **Token ID missing from the agent JSON** → `pickActiveTokenRowById` returns null; the schema also rejects it. Task 1 test `is null without a token id` and Task 4 test `test_deactivate_token_requires_token_id`.
5. **Stale `activate_token` keys from an earlier run** leaking into a deactivate run: the side panel clears the same keys before both flows. Covered in Task 3 Step 1 (shared opener) and checked in the Task 5 live run.

---

### Task 1: Mode-aware token helpers

**Files:**
- Modify: `extension/src/data/i2cTokenActivate.ts`
- Test: `extension/src/data/i2cTokenActivate.test.ts` (append; existing cases untouched)

**Interfaces:**
- Produces:
  - `export type TokenFlow = 'activate_token' | 'deactivate_token'`
  - `export function isTokenFlow(v: unknown): v is TokenFlow`
  - `TokenTarget.tokenId?: string | null`: digits only, whitespace stripped. `parseTokenTarget` reads `token_id ?? tokenId`; any value that isn't 12–19 digits after stripping becomes null.
  - `export function isActiveStatus(s: string): boolean`: true only for `Active` (not InActive or DeActivated).
  - `export function locateTokenIdColumn(rows: string[][], headerAt: number): number`: the index of the header cell matching `/^Token\s*(ID|Number|No\.?)$/i`, or -1.
  - `export function pickActiveTokenRowById(rows: string[][], target: TokenTarget): number | null`
  - `export const DEACTIVATE_OPTION_RE = /^(de-?activ(e|ate|ated)|delete)$/i`
  - `export const OTHER_REASON_RE = /^other$/i`
  - `export function tokenFormFor(flow: TokenFlow): { statusRe: RegExp; reasonRe: RegExp; statusLabel: string; reasonLabel: string }`. For activate it returns `ACTIVE_OPTION_RE`/`CSR_REASON_RE`/`'Active'`/`'Authenticated with CSR'`; for deactivate, `DEACTIVATE_OPTION_RE`/`OTHER_REASON_RE`/`'Deactivate'`/`'Other'`.

- [ ] **Step 1: Write the failing tests** (header `['Token ID','Type','Token Status','Device ID','Device Name','Created On']`):
  - `pickActiveTokenRowById` › `picks the Active row with the matching id`: rows Active `1111222233334444` "Pixel 9 Pro XL" and Active `1111222233335555` "Pixel 9 Pro", target `{tokenId:'1111222233334444'}` → index of the first data row.
  - › `never picks by device when IDs differ`: same rows, target `{tokenId:'9999888877776666', device:'Pixel 9 Pro XL'}` → `null`.
  - › `refuses InActive and DeActivated rows even with a matching id`: one InActive and one DeActivated row with the target id → `null` for each.
  - › `compares ids ignoring whitespace; a masked id never matches`: cell `'1111 2222 3333 4444'` matches; cell `'1111********4444'` → `null`.
  - › `is null without a token id`: `{device:'Pixel 9 Pro XL'}` → `null`.
  - `isActiveStatus` › `matches Active only`: `Active` and ` active ` are true; `InActive` and `DeActivated` are false.
  - `deactivate option regexes`: `findOption(['Active','InActive','DeActivate'], DEACTIVATE_OPTION_RE) === 2`; `'Delete'` and `'Deactivated'` match; `'InActive'` and `'Active'` don't; `findOption(['Lost','Other'], OTHER_REASON_RE) === 1`.
  - `parseTokenTarget` › `reads token_id, stripping spaces; drops a non-numeric id`: `{token_id:'1111 2222 3333 4444'}` → `tokenId '1111222233334444'`; `{token_id:'abc'}` → `tokenId null`.
  - `tokenFormFor` › `deactivate picks Other; activate unchanged`: `tokenFormFor('deactivate_token').reasonRe === OTHER_REASON_RE`; `tokenFormFor('activate_token').statusRe === ACTIVE_OPTION_RE`.
  - `isTokenFlow`: true for both flow names; false for `'admin_debit'` and `null`.

- [ ] **Step 2: Run, expect FAIL** — `cd extension && npx vitest run src/data/i2cTokenActivate.test.ts` → missing exports.

- [ ] **Step 3: Implement the helpers.** `pickActiveTokenRowById` uses `locateTokenColumns` for the header and status column and `locateTokenIdColumn` for the ID column. It returns null if either column is missing or `target.tokenId` is unset, and it only considers rows where `isActiveStatus` is true and the ID cell with whitespace stripped `=== target.tokenId`. Exactly one hit returns its index, anything else null. Update the file's header comment to cover both flows.

- [ ] **Step 4: Run, expect PASS** — the same command; all old and new cases are green.

- [ ] **Step 5: Commit** — `git commit -m "feat(token): mode-aware helpers for deactivating an Active token by id"`

### Task 2: Content script runs both flows

**Files:**
- Modify: `extension/src/content/i2c.ts`. `Flow` type and `getFlow` (~253–258); the product-row pick (~375–384); `selectAccountForTokenCard` call (~429–430) and its log lines (~449–464); `tryActivateToken` (~1731–1827); the `bootstrap` pass (~1897).

**Interfaces:**
- Consumes: everything Task 1 produces.
- Produces: `tryTokenStatusChange(): Promise<boolean>` (replaces `tryActivateToken`); `pending_i2c_flow = 'deactivate_token'` is a valid flow.

- [ ] **Step 1: Widen `Flow`/`getFlow`** to accept `'deactivate_token'`. Replace the three `=== 'activate_token'` checks at the product row and account row with `isTokenFlow(await getFlow())`. Log prefixes use the current flow name instead of the hard-coded `activate_token`.
- [ ] **Step 2: Rename `tryActivateToken` → `tryTokenStatusChange`.** Use `const flow = await getFlow(); if (!isTokenFlow(flow)) return false; const form = tokenFormFor(flow);`. Form fill uses `labelledOption(/^New\s+Status\b/i, form.statusRe)` and `labelledOption(/^Reason\b/i, form.reasonRe)`, and logs `form.statusLabel`/`form.reasonLabel`. Comments stays `ticketUrl`. The row pick is `flow === 'deactivate_token' ? pickActiveTokenRowById(fresh.rows, target) : pickInactiveTokenRow(fresh.rows, target)`. The null-row log for deactivate says `no Active token row with that token id; leaving it to the user`. Update the section comment above the function.
- [ ] **Step 3: Typecheck and build** — `cd extension && npx tsc -b && npx vitest run` → no errors, all tests pass.
- [ ] **Step 4: Commit** — `git commit -m "feat(token): i2c chain fills Deactivate / Other / ticket link for deactivate_token"`

### Task 3: Side panel and draft card

**Files:**
- Modify: `extension/src/data/agentDraftTypes.ts:29-31,56-62`; `extension/src/sidepanel/AgentDraftCard.tsx:114-118,184-185`; `extension/src/sidepanel/SidePanel.tsx:651,731-752`

**Interfaces:**
- Consumes: `TokenFlow`, `isTokenFlow` (Task 1).
- Produces: `DraftWorkflow` includes `'deactivate_token'`; `DraftToken.token_id?: string | null`; `openI2cTokenFlow(ticket: WocooTicket, token: DraftToken | null | undefined, flow: TokenFlow)`.

- [ ] **Step 1: Generalize the opener.** `openI2cActivateToken` becomes `openI2cTokenFlow(…, flow)` and sets `pending_i2c_flow: flow`, clearing the same keys as today. The click handler calls `if (isTokenFlow(w)) void openI2cTokenFlow(ticket, action.token, w)`.
- [ ] **Step 2: Types and card.** Add `deactivate_token: 'Deactivate token in i2c'` to `VENDOR_WORKFLOW_LABEL`, set `watchTokenClick = isTokenFlow(draft.action_needed?.workflow)`, and add a `token_id` doc line to `DraftToken` ("Token ID exactly as Manage Card Tokens shows it; required for deactivate_token").
- [ ] **Step 3: Verify** — `cd extension && npx tsc -b && npx vitest run` → clean.
- [ ] **Step 4: Commit** — `git commit -m "feat(agent-draft): Deactivate token in i2c button"`

### Task 4: Draft agent emits `deactivate_token`

**Files** (repo `~/projects/wocoo-draft-agent`, private):
- Modify: `src/draft_schema.py:15-16,40,120-133`; `prompt/draft.md` (workflow list ~848-851; new rule after the activate_token bullet ~861)
- Test: `tests/test_draft_schema.py`

**Interfaces:**
- Produces: `action_needed.workflow = "deactivate_token"` with `token: {card_last4, token_id, device, created}`, where `card_last4` and `token_id` (12–19 digits) are required.

- [ ] **Step 1: Write the failing tests**
  - `test_deactivate_token_requires_token_id`: without `token` → an error mentioning `token`; with `{"card_last4":"9355","token_id":None,...}` → an error mentioning `token_id`; with `token_id:"1111222233334444"` → `[]`.
  - `test_token_rejected_on_other_workflows` is unchanged and still passes. Its message becomes "only for workflow 'activate_token' or 'deactivate_token'".
- [ ] **Step 2: Run, expect FAIL** — `python3 -m unittest tests.test_draft_schema -v`.
- [ ] **Step 3: Implement.** Add `"deactivate_token"` to the workflow tuple and apply the token checks to both workflows; `token_id` is required only for deactivate. In `draft.md`, add `deactivate_token` to the list and a bullet saying: use it only when the client agreed to remove an **Active** token. Set `token` with `token_id` exactly as the Token ID column shows. Never use it for InActive (activate those) or DeActivated tokens (nothing to do). One token per draft; any other token to remove goes in `summary`. Sidekick fills Status deactivate, Reason Other and the Jira link; Albert clicks Update Status.
- [ ] **Step 4: Run, expect PASS** — `python3 -m unittest discover tests` → OK.
- [ ] **Step 5: Commit** (agent repo) — `git commit -m "feat: deactivate_token workflow for removing an Active wallet token"`

### Task 5: Build and live check on WOCOO-31689

- [ ] **Step 1: Build into the loaded dist** — `cd ~/projects/wocoo-extension/extension && npx vite build --outDir dist --emptyOutDir` (check `.env` is present first). Then ask Albert to click reload on chrome://extensions and reload his Jira tab.
- [ ] **Step 2: Albert clicks "Solve again" on WOCOO-31689.** Expect `action_needed.workflow = deactivate_token` with the Pixel 9 Pro XL token's ID and the button "Deactivate token in i2c".
- [ ] **Step 3: Albert clicks the button.** Expect: i2c logs in → ••9789 → Manage Card Tokens → only the Pixel 9 Pro XL row ticked → New Status = deactivate option, Reason = Other, Comments = the Jira link. **Stop there.** Confirm the real i2c option labels and tighten `DEACTIVATE_OPTION_RE` if needed (Task 1 test updated to match).
- [ ] **Step 4: Albert clicks Update Status himself.** Expect "I've done this" to tick on the card.
- [ ] **Step 5:** Push `wocoo-extension` main only if Albert asks.
