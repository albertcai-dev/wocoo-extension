# Workflow Recommendation Cards (Overpayment Triage, Reverse Fee, QC Fee Waiver)

**Date**: 2026-06-24
**Author**: Albert Cai (with Claude)
**Status**: Draft, pending implementation

## Problem

The side panel already auto-suggests three workflows via stacked recommendation cards above QuickActions:

- `QCAutoReimbCard` — recommends a "no action needed" templated reply for QC clients whose system will auto-reimburse next statement.
- `CredRouteCard` — recommends Clone/Move to the CRED board for credit-decisioning tickets.
- `WalletTriageCard` — recommends Start Wallet Triage for credit-card-into-wallet provisioning tickets.

Three QuickActions buttons today have NO auto-detection card. The agent has to read the ticket and decide which workflow to start manually:

- **Triage Overpayment** (credit-card overpayment refund flow)
- **Reverse Fee** (manual fee reversal in i2c)
- **QC Fee Waiver** (manual annual-fee waiver for QC clients)

Wiring up detection cards for all three gives the same one-click affordance the other workflows have.

## Goals

- Add three independent detectors (`detectOverpaymentTriage`, `detectReverseFee`, `detectQCFeeWaiver`) mirroring the existing `credRouteDetect.ts` and `walletTriageDetect.ts` shape.
- Add three matching recommendation cards (`OverpaymentTriageCard`, `ReverseFeeCard`, `QCFeeWaiverCard`) that render above QuickActions when their detector matches and pipe to the existing `onStart*` callbacks already plumbed through `TicketView` → `TicketViewInner` → `QuickActions`.
- Keep cards independent (no precedence rule between the three new ones — multiple can show simultaneously if a ticket genuinely matches more than one).
- Enforce QC Fee Waiver ↔ QCAutoReimb mutual exclusion via detector logic, not via render order — they target opposite cases.

## Non-Goals

- A single "Recommended workflow" picker that ranks all detectors and shows just one. The existing pattern is independent stacked cards; this design follows it.
- Detection for any other workflow (Clone/Move beyond CRED, Create REIMB Ticket, Verify Eligible DD, Wires Pending Posting). Out of scope for v1.
- LLM-based detection. Keyword rules only.
- Tunable detector configuration in a settings panel — keyword arrays live in source; tweaks are code changes.

## Detection Signals

Each detector matches against `summary + '\n' + description`, lowercased, using substring matches (same primitive as `credRouteDetect.ts` / `walletTriageDetect.ts`). All three return `{ matched: boolean; reasons: string[] }`.

### `detectOverpaymentTriage`

**Topic signals** (must have at least one):
```
'credit card', 'cc ', ' cc', 'credit-card', 'cc application'
```

**Action signals** (must have at least one):
```
'overpayment', 'over payment', 'over-payment', 'overpaid',
'double payment', 'duplicate payment', 'extra payment',
'credit balance', 'positive balance',
'refund the overpayment', 'refund overpayment'
```

**Veto signals** (suppress match if any present — these tickets belong to other workflows):
```
'fee waiver', 'annual fee', 'fee reversal', 'dispute', 'chargeback'
```

**Match rule**: `topic.length > 0 && action.length > 0 && veto.length === 0`

### `detectReverseFee`

**Action signals** (must have at least one):
```
'reverse the fee', 'reverse this fee', 'reverse fee',
'refund the fee', 'refund this fee',
'remove the fee', 'credit the fee', 'waive the fee',
'incorrect fee', 'fee charged in error',
'fx fee', 'foreign transaction fee', 'atm fee'
```

**Veto signals**:
```
'annual fee', 'overpayment', 'dispute', 'chargeback'
```

**Match rule**: `action.length > 0 && veto.length === 0`

No standalone topic requirement — the action signals are specific enough (e.g. "refund the fee", "fx fee") that they don't need a corroborating topic anchor.

### `detectQCFeeWaiver`

**QC signals** (must have at least one):
```
'qc', 'quebec', 'québec'
```

**Fee-topic signals** (must have at least one):
```
'fee waiver', 'fee waived', 'fees waived', 'fee reimbursement',
'annual fee', 'cc fee', 'credit card fee',
'waive the fee', 'reimburse the fee', 'reimburse the annual'
```

**Veto signals** — same list as `ELIGIBILITY_FLIP_SIGNALS` in `qcAutoReimbDetect.ts` (the QCAutoReimb auto-handled case):
```
'tier upgrade', 'upgraded tier', 'newly eligible', 'now eligible', 'now meets',
'now qualified', 'now qualify', 'now over 100k', 'over 100k', 'over $100k',
'over 100,000', 'over $100,000', 'crossed 100k', 'aum', 'assets under management',
'direct deposit', 'dd eligibility', 'dd eligible', 'qualifying direct deposit',
'qualified direct deposit', 'become premium', 'became premium', 'now premium'
```

**Match rule**: `qc.length > 0 && feeTopic.length > 0 && veto.length === 0`

Mutual exclusion with QCAutoReimb: when QCAutoReimb's eligibility-flip signals are present, this detector vetoes. When QCAutoReimb's EXCEPTION_SIGNALS are present (client already waited, still not reimbursed), QCAutoReimb itself vetoes — and since the eligibility-flip signals likely AREN'T present in that case, this detector matches. The two never fire on the same ticket.

The QC keyword 'qc' is short and could substring-match unrelated words ('acquire'... no, 'qc' is preceded by 'a' there but the substring check still hits). Risk: tolerable false-positive rate. If it becomes noisy, tighten to word-boundary regex match (small follow-up).

## Cards

Three new files, all modeled byte-for-byte on `src/sidepanel/WalletTriageCard.tsx`'s shape — render null if detector doesn't match or required state is missing, else render a one-paragraph card with the title, matched reasons, and a primary button that calls the workflow's existing start callback.

### `src/sidepanel/OverpaymentTriageCard.tsx`

```tsx
export function OverpaymentTriageCard({ ticket, onStart }: { ticket: WocooTicket; onStart: () => void }) {
  if (!ticket.clientEmail) return null;
  const detection = detectOverpaymentTriage(ticket.summary || '', ticket.description || '', ticket.workType);
  if (!detection.matched) return null;
  // Card markup: title "⚡ Looks like a credit card overpayment", reasons, "Start Overpayment Triage" button.
}
```

Title: `⚡ Looks like a credit card overpayment`
Button label: `Start Overpayment Triage`

### `src/sidepanel/ReverseFeeCard.tsx`

```tsx
export function ReverseFeeCard({ ticket, onStart }: { ticket: WocooTicket; onStart: () => void }) {
  if (!ticket.clientEmail) return null;
  const detection = detectReverseFee(ticket.summary || '', ticket.description || '', ticket.workType);
  if (!detection.matched) return null;
  // Card markup: title "↗ Looks like a fee reversal request", reasons, "Start Reverse Fee" button.
}
```

Title: `↗ Looks like a fee reversal request`
Button label: `Start Reverse Fee`

### `src/sidepanel/QCFeeWaiverCard.tsx`

```tsx
export function QCFeeWaiverCard({ ticket, onStart }: { ticket: WocooTicket; onStart: () => void }) {
  if (!ticket.clientEmail) return null;
  const detection = detectQCFeeWaiver(ticket.summary || '', ticket.description || '', ticket.workType);
  if (!detection.matched) return null;
  // Card markup: title "⚖️ Looks like a QC fee waiver request", reasons, "Start QC Fee Waiver" button.
}
```

Title: `⚖️ Looks like a QC fee waiver request`
Button label: `Start QC Fee Waiver`

All three use the same `cardStyle` + `titleStyle` + `reasonsStyle` + `buttonStyle` pattern as `WalletTriageCard.tsx`. Copy verbatim — no shared style file pulled out for one-time use, but easy to extract later if a pattern emerges (YAGNI for now).

## SidePanel Wiring

In `src/sidepanel/SidePanel.tsx`:

1. Add imports for the three new card components alongside `WalletTriageCard`.
2. Mount them above `QuickActions`, in this order (top → bottom):
   ```
   <QCAutoReimbCard ticket onTicketUpdate />
   <OverpaymentTriageCard ticket onStart={onStartTriage} />   ← NEW
   <ReverseFeeCard ticket onStart={onStartReverseFee} />       ← NEW
   <QCFeeWaiverCard ticket onStart={onStartQCFeeWaiver} />     ← NEW
   <CredRouteCard ticket onOpenCloneMove={...} />
   <WalletTriageCard ticket onStart={onStartWalletTriage} />
   ```

`onStartTriage`, `onStartReverseFee`, `onStartQCFeeWaiver` are already in scope inside `TicketViewInner` (props from `TicketView`). No new prop plumbing needed.

The chosen order — QCAutoReimb at the very top, then the three new cards in QuickActions row 1+2 order (Triage → ReverseFee → QCFeeWaiver), then CredRoute and WalletTriage at the bottom — reads naturally and keeps the "no action needed" card (QCAutoReimb) most prominent when it fires.

## Architecture

| Path | New? | Responsibility |
|---|---|---|
| `src/data/overpaymentTriageDetect.ts` | new | `detectOverpaymentTriage(summary, description, workType): { matched, reasons }` — keyword arrays + match rule. |
| `src/data/reverseFeeDetect.ts` | new | `detectReverseFee(summary, description, workType): { matched, reasons }`. |
| `src/data/qcFeeWaiverDetect.ts` | new | `detectQCFeeWaiver(summary, description, workType): { matched, reasons }` — uses the existing `ELIGIBILITY_FLIP_SIGNALS` list from `qcAutoReimbDetect.ts` as its veto. |
| `src/sidepanel/OverpaymentTriageCard.tsx` | new | Mirrors `WalletTriageCard.tsx`; calls `onStart` (existing `onStartTriage`). |
| `src/sidepanel/ReverseFeeCard.tsx` | new | Mirrors `WalletTriageCard.tsx`; calls `onStart` (existing `onStartReverseFee`). |
| `src/sidepanel/QCFeeWaiverCard.tsx` | new | Mirrors `WalletTriageCard.tsx`; calls `onStart` (existing `onStartQCFeeWaiver`). |
| `src/sidepanel/SidePanel.tsx` | modify | Import the 3 new cards. Mount them between `QCAutoReimbCard` and `CredRouteCard`. No new state, no new callback plumbing — `onStartTriage` / `onStartReverseFee` / `onStartQCFeeWaiver` are already in scope. |
| `src/data/qcAutoReimbDetect.ts` | modify | Add `export` keyword to the existing `ELIGIBILITY_FLIP_SIGNALS` constant so `qcFeeWaiverDetect.ts` can import it as its veto list. No other changes — the QCAutoReimb detector's behavior is unchanged. |

No file is deleted, moved, or restructured. The only change to existing detection logic is the one-keyword `export` addition above.

## Reused machinery

- `findMatches(text, needles)` helper pattern — each new detector defines its own local copy (same as `credRouteDetect.ts` and `walletTriageDetect.ts`; YAGNI on extracting a shared util for three tiny one-line functions).
- `WalletTriageCard.tsx` style constants — copied verbatim into each new card. Could extract later if more cards land; not now.
- `ELIGIBILITY_FLIP_SIGNALS` — imported from `qcAutoReimbDetect.ts` into `qcFeeWaiverDetect.ts` as the veto list. Need to export it from `qcAutoReimbDetect.ts` (currently file-local).

## Error Handling

- **Source ticket missing `clientEmail`**: Card hidden (matches the QuickActions button's `disabled` state for these three workflows). No false promises.
- **Source ticket missing `summary` or `description`**: detector receives `''` for the missing field; no signals fire on empty input; detector returns `matched: false`. Card stays hidden.
- **Detector throws** (shouldn't happen — pure substring code): the React error boundary upstream handles it; worst case a single card crash takes down the side panel until reload. Acceptable for a v1; harden later if it ever happens in practice.

## Edge Cases

- **Ticket matches Overpayment AND Reverse Fee** (e.g. agent writes "client overpaid by reversing a fee"): both cards show. The agent picks the more relevant workflow. The veto lists (`fee reversal` on Overpayment, `overpayment` on Reverse Fee) cover the common cases; if the agent's text is genuinely ambiguous, two cards is acceptable.
- **Ticket matches QCAutoReimb AND QC Fee Waiver**: detector logic enforces mutual exclusion (each vetoes on the other's positive signals). Should not happen in practice.
- **Card detector matches but the workflow's QuickActions button is disabled** (e.g. ticket has `clientEmail` cleared mid-session): both card and button respect the `clientEmail` gate, so they hide/disable together.
- **Substring false positives**: the QC `'qc'` signal can match inside unrelated words. Tolerated for v1 — if noisy, tighten to a word-boundary regex match.

## Testing

Manual, no automated tests (extension has none).

1. **Smoke — Overpayment**: Open a WOCOO ticket whose description mentions credit-card overpayment (e.g. "client overpaid their credit card by $X, please refund"). Confirm the **⚡ Looks like a credit card overpayment** card appears between QCAutoReimbCard's region and CredRouteCard's region. Click **Start Overpayment Triage** → workflow opens. No regression to existing QuickActions button.
2. **Smoke — Reverse Fee**: Ticket asks "please reverse the FX fee". Confirm the **↗ Looks like a fee reversal request** card appears. Click → Reverse Fee workflow opens.
3. **Smoke — QC Fee Waiver**: Ticket about QC client needing an annual fee waiver, with no eligibility-flip language. Confirm **⚖️ Looks like a QC fee waiver request** card appears. Click → QC Fee Waiver workflow opens.
4. **Mutual exclusion — QC Fee Waiver vs QCAutoReimb**: Ticket about QC client with "tier upgrade" in description (eligibility flip). Confirm QCAutoReimbCard fires AND QCFeeWaiverCard does NOT fire. Then rewrite the description to remove eligibility-flip language and add "still not reimbursed". Confirm QCAutoReimbCard vetoes (its own EXCEPTION_SIGNALS) AND QCFeeWaiverCard fires.
5. **Negative — unrelated ticket**: A wallet-provisioning ticket. None of the three new cards fire; only WalletTriageCard fires (as today).
6. **Negative — no clientEmail**: A ticket missing `clientEmail` (rare but possible). None of the three new cards fire even if their text signals would otherwise match. The corresponding QuickActions buttons stay disabled (existing behavior).
7. **Regression — existing cards**: CredRouteCard still fires on CRED-bound tickets; QCAutoReimbCard still fires on auto-reimb tickets; WalletTriageCard still fires on wallet tickets. None of the new cards regress those.

## Out of Scope

- Settings UI to enable/disable individual cards.
- Server-side feedback loop (which suggestions get used vs ignored) to tune detectors.
- Card "Dismiss" / "Don't show again" affordance — agents just ignore cards that don't apply.
- Detection for the remaining QuickActions buttons (Done, Clone/Move-to-EOC / -to-PFO / -to-FRAUD, Verify Eligible DD, Create REIMB Ticket, Wallet Triage, Wires Pending Posting). All have specific triggers that don't fit the "auto-detect from summary/description" pattern cleanly; revisit if/when patterns emerge.
