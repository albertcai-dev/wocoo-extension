# Wallet Triage Workflow

**Date**: 2026-06-23
**Author**: Albert Cai (with Claude)
**Status**: Draft, pending implementation

## Problem

WOCOO tickets routinely arrive describing a client who can't add their Wealthsimple credit card to a phone wallet (Apple Pay, Google Pay, Samsung Pay, etc.). The canonical example is WOCOO-23426, with summary "Credit card cannot be added to Apple pay" and description referencing "Visa Provisioning Service" / "Red Path" decline reasons.

The first triage move for these tickets is always the same: look up the client's identity_id on a specific Preset dashboard, cross-reference a specific Google Doc, then ask the reporting agent whether they've already done that check. Today the agent does this by hand — find the URLs in a Slack channel, copy/paste the identity_id, manually type a comment, then close the ticket. The new workflow automates all of that.

## Goals

- Auto-detect wallet-provisioning tickets and surface a one-click "Start Wallet Triage" affordance.
- Also expose a manual button so agents can launch the same workflow on tickets the detector misses.
- Open the Preset dashboard (pre-filtered to the client's identity_id) and the Google Doc in two new tabs in a single click.
- Post a structured "have you checked yet?" comment to the reporter and transition the source ticket to Done.
- Reuse the existing Preset content script's filter manipulation — clears existing chips, types the new identity, clicks Apply Filters — with a tiny extension to recognize the new dashboard's filter label.

## Non-Goals

- Replacing or modifying any existing workflow (OverpaymentTriage, QC Fee Waiver, Reverse Fee, Clone/Move, Create REIMB Ticket).
- Resolving the wallet-provisioning issue automatically. The workflow is a triage check-in, not a fix.
- Detecting wallets beyond the configured signal list (Apple Pay, Google Pay, Samsung Pay, Garmin Pay, generic "virtual wallet" / "phone wallet" / "mobile wallet" / "tokenization" / "Visa Provisioning Service" / "Red Path"). New signals are a config edit, not a code change.
- Supporting clients whose source ticket lacks an `identityId` — the dashboard filter requires it.

## Detection

New file `src/data/walletTriageDetect.ts`. Mirrors the shape of `src/data/credRouteDetect.ts`.

Signal lists (case-insensitive substring match against `summary + '\n' + description`):

**Credit card topic** (any one match):
```
'credit card', 'cc ', ' cc', 'credit-card', 'cc application'
```

**Wallet / provisioning signal** (any one match):
```
'apple pay', 'google pay', 'samsung pay', 'garmin pay',
'virtual wallet', 'phone wallet', 'mobile wallet',
'wallet provisioning', 'tokenization',
'visa provisioning service', 'red path'
```

**No veto list** — none of these phrases land cleanly on a non-wallet category. False positives are tolerated since the recommendation card is dismissible.

**Match rule**:
```
matched = (any credit-card topic signal present) AND (any wallet signal present)
```

Exported function:
```ts
export function detectWalletTriage(
  summary: string,
  description: string,
  workType: string | null | undefined,
): { matched: boolean; reasons: string[] }
```

`workType` is accepted for future use but not consulted in v1.

## Workflow

Two-step workflow component `src/sidepanel/WalletTriageWorkflow.tsx`. Modeled on `QCFeeWaiverWorkflow.tsx`'s shape but smaller. Full-screen render when active (same gate pattern as Reverse Fee / QC Fee Waiver — returns from `TicketView` instead of rendering inside `TicketViewInner`).

### Step 1 — Open dashboard & doc

**Title**: "Open dashboard & doc"
**Subtitle**: "Both tabs open at once; dashboard auto-filters by identity_id"

**Action** (single button "↗ Open dashboard + doc"):

1. `await chrome.storage.local.set({ pending_preset_identity_id: ticket.identityId })` — same key the existing Verify Eligible DD button uses; triggers the Preset content script.
2. `window.open(WALLET_TRIAGE_DASHBOARD_URL, '_blank', 'noopener,noreferrer')` — opens the Preset dashboard. The Preset content script (already shipping; see "Preset content script extension" below) handles the rest: clears existing identity chips, types the new identity_id, clicks Apply Filters.
3. `window.open(WALLET_TRIAGE_DOC_URL, '_blank', 'noopener,noreferrer')` — opens the Google Doc in a second tab.
4. Mark the step "Done" state: green check + label "Opened both ↗ — click any tab to review".

**Done state caption**: A small note reminds the agent to review both before advancing to Step 2.

### Step 2 — Post comment & Move to Done

**Title**: "Post comment & Move to Done"
**Subtitle**: "Ask the reporter to confirm, then close"

**Action** (single button "Post & Move to Done"):

1. Build comment segments (ADF with real @mention pill — same pattern OverpaymentTriage uses via `buildCommentSegments` / `postComment`):
   - `text` "Hi "
   - `mention` (accountId = ticket.reporterAccountId if available, text = "@" + reporter name) — falls back to plain text "@<reporter>" if no accountId
   - `text` " have you checked the Preset dash and doc yet?"
2. Call `postComment(ticket.id, segments)`.
3. On success: call `transitionTicket(ticket.id, '251')` (Done).
4. Soft-failure pattern:
   - Comment fails → abort, surface error, status returns to "configuring" so agent retries.
   - Comment succeeds, transition fails → soft warning shown on success panel: "Comment posted, but Move-to-Done failed: {err}. Close the ticket manually."

### Step 3 (success state) — Triage complete

Same success-panel pattern OverpaymentTriage uses:
- ✓ banner
- "Triage complete" headline
- Link back to the source WOCOO ticket
- Soft warnings if any (the transition failure case)
- Close button

## Detection card

New file `src/sidepanel/WalletTriageCard.tsx`. Mirrors `CredRouteCard.tsx`'s shape: renders above QuickActions when `detectWalletTriage(...).matched` is true. Shows a brief summary of matched signals (e.g. "CC topic: credit card · Wallet signal: apple pay") and a primary button **"Start Wallet Triage"** that launches the same workflow as the manual button.

Hidden when:
- Detection doesn't match
- `!ticket.identityId` (workflow can't run without identity_id)

## Manual button

QuickActions row 2 grows from `Reverse Fee · QC Fee Waiver` (2 buttons) to `Reverse Fee · QC Fee Waiver · Wallet Triage` (3 buttons). Same `variant="neutral"` styling to visually group with the other credit-card-related workflows. Disabled when `!ticket.identityId`, with `title="Need identity ID to filter the dashboard"`.

## Preset content script extension

`src/content/preset.ts` line 134 currently matches only the literal label `Identity Canonical ID`:

```ts
if (!/^Identity\s+Canonical\s+ID/i.test(t)) continue;
```

The new dashboard's filter is labeled `identity_id`. Broaden the regex to accept either:

```ts
if (!/^(Identity\s+Canonical\s+ID|identity_id)\b/i.test(t)) continue;
```

Everything downstream (clearing chips, typing, clicking Apply Filters) works unchanged — the chip matcher uses `/^identity[-_]/i` against the chip text which already matches both dashboards.

No other changes to the Preset content script.

## Configuration

New file `src/data/walletTriageConfig.ts`. Holds the dashboard URL, doc URL, and comment template builder.

```ts
// Strip native_filters_key — the Preset content script can't clear filter chips
// baked into that param. The script applies the filter from storage instead.
export const WALLET_TRIAGE_DASHBOARD_URL =
  'https://8a26d867.wealthsimple-aws-mpc.app.preset.io/superset/dashboard/8014/';

export const WALLET_TRIAGE_DOC_URL =
  'https://docs.google.com/document/d/18G1-lYpfxS-FHDVTYwKyypmnXF_0evFO2pFTJRRIbXU/edit?tab=t.0#heading=h.oqcm6k38vnmt';

// Comment template — agent's check-in to the reporter
export const WALLET_TRIAGE_COMMENT_TEXT_AFTER_MENTION =
  ' have you checked the Preset dash and doc yet?';
```

## Architecture

### Files touched

| Path | New? | Responsibility |
|---|---|---|
| `src/data/walletTriageDetect.ts` | new | `detectWalletTriage(summary, description, workType)` — signal lists + match rule |
| `src/data/walletTriageConfig.ts` | new | Dashboard URL, Doc URL, comment template fragment |
| `src/sidepanel/WalletTriageWorkflow.tsx` | new | 2-step workflow component (open dashboard+doc, then post+transition) |
| `src/sidepanel/WalletTriageCard.tsx` | new | Auto-detect recommendation card; mirrors `CredRouteCard` |
| `src/sidepanel/SidePanel.tsx` | modify | Lift `walletTriageActive` state into `TicketView`; full-screen render of `<WalletTriageWorkflow>` when active (same pattern as Reverse Fee / QC Fee Waiver); mount `<WalletTriageCard>` above QuickActions inside `TicketViewInner`; pass `onStartWalletTriage` down through `TicketViewInner` → `QuickActions`; add the manual button to QuickActions row 2 |
| `src/content/preset.ts` | modify | One-line regex tweak in `findFilterInput` to accept `identity_id` label |

No deletions; no moves.

### Reused machinery

- `chrome.storage.local` key `pending_preset_identity_id` — already triggers the Preset content script's filter-application chain.
- `buildCommentSegments` / `postComment` / ADF mention nodes — in `jira.ts` and `OverpaymentTriage.tsx`. The wallet workflow uses the same ADF shape for its comment.
- `transitionTicket(ticketKey, '251')` — Done transition, used by OverpaymentTriage, MoveModal, CreateReimbModal.
- Workflow-active-state pattern: `if (walletTriageActive) return <WalletTriageWorkflow .../>` from `TicketView`, matching how `reverseFeeActive` / `qcFeeWaiverActive` work today (lines 160–177 of `SidePanel.tsx`).

## Comment Format

Modeled on the @mention pattern from OverpaymentTriage and CreateReimbModal:

ADF segments:
1. `text` `"Hi "`
2. `mention` with `accountId = ticket.reporterAccountId`, `text = "@" + ticket.reporter`
3. `text` `" have you checked the Preset dash and doc yet?"`

If `ticket.reporterAccountId` is unavailable (matches existing fallback in `buildCommentSegments`), the mention degrades to plain text `"@<reporter name>"`, which still reads naturally.

Resulting Jira display (with @mention pill):
```
Hi @Asher Kahiya have you checked the Preset dash and doc yet?
```

## Error Handling

**Hard failures** (abort, no side effect):
- Source ticket has no `identityId` → detection card hidden; manual button disabled with tooltip "Need identity ID to filter the dashboard"; workflow cannot launch.
- Step 1's `chrome.storage.local.set` rejects → surface error inline ("Failed to queue dashboard filter — try again"). Tabs are NOT opened so the agent isn't left with un-filtered tabs.
- Step 2's `postComment` rejects → abort, return to configuring, agent retries.

**Soft failures** (workflow succeeded materially):
- `transitionTicket` rejects after `postComment` succeeded → success panel shows the comment-posted state plus a soft warning: "Comment posted, but Move-to-Done on {ticketId} failed: {err}. Close the ticket manually in Jira."
- Preset content script can't find the filter input on the new dashboard → tabs open but identity stays un-filtered. Agent applies it by hand. The Preset content script logs to console; we don't surface that to the side panel.

**Edge cases:**

- **Detection false positive**: Card shows on a non-wallet ticket. Agent ignores it and uses other actions. Card is suggestive, not a blocker.
- **Agent closes tabs before Step 2**: No data dependency on the tabs staying open. Step 2 still works.
- **Agent clicks Step 1 twice**: Both clicks open two more dashboard tabs each. Acceptable — second open is harmless and the storage write is idempotent. (Could add a "already-opened" guard if it becomes annoying.)
- **Source ticket already Done**: Step 2's transition is a no-op or fails with a `400`. Surface as a soft warning; the comment still posts successfully.
- **Reporter mention falls back to plain text** (no `reporterAccountId`): comment still posts; reporter receives no Jira-native notification but the comment is still attributed and readable.

## Testing

Manual, no automated tests (extension has none today).

1. **Smoke — happy path**: Open WOCOO-23426 (or a similar wallet-provisioning ticket). Confirm the detection card appears with reasons. Click Start Wallet Triage → Step 1 → ↗ Open dashboard + doc. Both tabs open; the Preset dashboard auto-filters to the client's identity_id (chip clears and reapplies). Return to side panel → Step 2 → Post & Move to Done. Open Jira and verify: comment exists with proper @mention pill ("Hi @<reporter> have you checked the Preset dash and doc yet?"); source ticket status = Done.
2. **Smoke — manual button**: On a ticket the detector misses, click the QuickActions "Wallet Triage" button. Same outcome as test 1.
3. **Smoke — manual button on a ticket WITHOUT identity_id**: Button is disabled with tooltip.
4. **Preset filter extension**: On the existing Verify Eligible DD dashboard, run that flow (unchanged). Confirm filter still applies — the regex broadening shouldn't regress.
5. **Negative — comment fails**: Temporarily revoke the Atlassian OAuth token, click Post & Move to Done, confirm error surfaces and ticket is NOT transitioned.
6. **Negative — transition fails**: Manually transition the source ticket to Done before clicking Step 2 (so the configured Done transition no-ops or 400s). Confirm comment still posts; soft warning appears on the success panel.

## Out of Scope

- Detecting Garmin Pay / Fitbit Pay / other less-common wallets if the user starts filing those tickets. (Easy follow-up: add to the signal list.)
- Per-wallet dashboard variants. v1 assumes one dashboard + one doc covers all wallet-provisioning issues.
- Re-opening the workflow on a Done ticket (the agent reverts the ticket manually in Jira if needed).
- Surfacing the dashboard's actual decline-reason data inside the side panel. Open question for a future iteration.
