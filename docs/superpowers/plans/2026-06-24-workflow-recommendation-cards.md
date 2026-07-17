# Workflow Recommendation Cards — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three auto-detection recommendation cards (Overpayment Triage, Reverse Fee, QC Fee Waiver) above QuickActions in the side panel — mirroring the existing CredRoute / WalletTriage / QCAutoReimb cards — so the agent gets a one-click "Start X" affordance when a ticket's summary/description matches each workflow's signal pattern.

**Architecture:** Three new detector modules in `src/data/` follow `credRouteDetect.ts` / `walletTriageDetect.ts` shape. Three new card components in `src/sidepanel/` follow `WalletTriageCard.tsx` shape. `SidePanel.tsx` imports + mounts the 3 new cards above QuickActions and reuses the existing `onStartTriage` / `onStartReverseFee` / `onStartQCFeeWaiver` callbacks (already plumbed). `qcAutoReimbDetect.ts` gains one `export` keyword so its `ELIGIBILITY_FLIP_SIGNALS` constant can be shared as the QC Fee Waiver veto.

**Tech Stack:** TypeScript, React (functional + hooks), Vite (build via `npm run build`), Chrome MV3 extension. No test framework; verification is manual via load-unpacked + clicking through WOCOO tickets that match each detector's signals.

## Global Constraints

- **No automated tests.** Each task ends with `npm run build` (from `~/projects/wocoo-extension/extension/`) + a documented manual verification step. Do not introduce a test framework.
- **Not a git repository.** Skip every "commit" step. Tasks complete when manual verification passes.
- **Do not regress existing flows.** Especially: `CredRouteCard`, `QCAutoReimbCard`, `WalletTriageCard`, and the QuickActions buttons (Triage Overpayment, Reverse Fee, QC Fee Waiver) must work exactly as today. The QCAutoReimb detector's behavior must not change — only the `export` keyword is added to `ELIGIBILITY_FLIP_SIGNALS`.
- **Existing code style:** TypeScript, semicolons, single quotes, 2-space indent, React functional components, no default exports.
- **All three cards** are gated on `ticket.clientEmail` (matches the existing QuickActions button `disabled` state for the three workflows).
- **Mount order** above QuickActions (top → bottom): `QCAutoReimbCard` → `OverpaymentTriageCard` → `ReverseFeeCard` → `QCFeeWaiverCard` → `CredRouteCard` → `WalletTriageCard`.
- **Reload the unpacked extension** in `chrome://extensions` after every build before manual verification.

---

## File Structure

| Path | Change |
|---|---|
| `src/data/overpaymentTriageDetect.ts` | **new** — `detectOverpaymentTriage(summary, description, workType): { matched: boolean; reasons: string[] }`. |
| `src/data/reverseFeeDetect.ts` | **new** — `detectReverseFee(summary, description, workType): { matched: boolean; reasons: string[] }`. |
| `src/data/qcFeeWaiverDetect.ts` | **new** — `detectQCFeeWaiver(summary, description, workType): { matched: boolean; reasons: string[] }`. Imports `ELIGIBILITY_FLIP_SIGNALS` from `qcAutoReimbDetect.ts` as its veto. |
| `src/data/qcAutoReimbDetect.ts` | modify — add `export` keyword to the existing `ELIGIBILITY_FLIP_SIGNALS` constant. No other changes. |
| `src/sidepanel/OverpaymentTriageCard.tsx` | **new** — renders the recommendation card; calls `onStart` (existing `onStartTriage`). |
| `src/sidepanel/ReverseFeeCard.tsx` | **new** — renders the recommendation card; calls `onStart` (existing `onStartReverseFee`). |
| `src/sidepanel/QCFeeWaiverCard.tsx` | **new** — renders the recommendation card; calls `onStart` (existing `onStartQCFeeWaiver`). |
| `src/sidepanel/SidePanel.tsx` | modify — import + mount the 3 new cards above QuickActions, between `QCAutoReimbCard` and `CredRouteCard`. No new state, no new callbacks. |

---

## Task 1: Create detectors + export QCAutoReimb's veto list

**Files:**
- Create: `src/data/overpaymentTriageDetect.ts`
- Create: `src/data/reverseFeeDetect.ts`
- Create: `src/data/qcFeeWaiverDetect.ts`
- Modify: `src/data/qcAutoReimbDetect.ts` (single-keyword `export` addition)

**Interfaces:**
- Consumes: existing `ELIGIBILITY_FLIP_SIGNALS` from `qcAutoReimbDetect.ts` (after Step 1's export change).
- Produces:
  - `detectOverpaymentTriage(summary: string, description: string, workType: string | null | undefined): { matched: boolean; reasons: string[] }`
  - `detectReverseFee(summary: string, description: string, workType: string | null | undefined): { matched: boolean; reasons: string[] }`
  - `detectQCFeeWaiver(summary: string, description: string, workType: string | null | undefined): { matched: boolean; reasons: string[] }`
  - `ELIGIBILITY_FLIP_SIGNALS: string[]` — newly exported from `qcAutoReimbDetect.ts`.

- [ ] **Step 1: Export `ELIGIBILITY_FLIP_SIGNALS`** from `src/data/qcAutoReimbDetect.ts`. Find the existing block (around line 23):

```ts
// The client just became eligible (tier upgrade, AUM threshold, DD eligibility) — they
// don't need a manual refund yet because the system handles it.
const ELIGIBILITY_FLIP_SIGNALS = [
```

Change it to:

```ts
// The client just became eligible (tier upgrade, AUM threshold, DD eligibility) — they
// don't need a manual refund yet because the system handles it.
// Exported so qcFeeWaiverDetect.ts can use the same list as its veto.
export const ELIGIBILITY_FLIP_SIGNALS = [
```

No other changes to this file. The QCAutoReimb detector still uses this list internally — just adding the `export` keyword.

- [ ] **Step 2: Create `src/data/overpaymentTriageDetect.ts`** with this content verbatim:

```ts
// Heuristic to detect credit-card overpayment tickets that should be routed to the
// Overpayment Triage workflow. Mirrors [[cred-route-detect]] / [[wallet-triage-detect]].
//
// The Overpayment Triage workflow handles clients who overpaid their credit card
// and want the credit balance refunded to their chequing account. Per the WOCOO
// Wiki criteria (memory: wocoo-jira-fields), the workflow only applies if the
// amount is ≥ $1,000 — but we don't gate detection on amount because the agent
// reads the description to confirm. The card surfaces the suggestion; the agent
// decides whether to run the workflow.

export interface OverpaymentTriageDetection {
  matched: boolean;
  reasons: string[];
}

const CC_TOPIC_SIGNALS = [
  'credit card', 'cc ', ' cc', 'credit-card', 'cc application',
];

const OVERPAYMENT_ACTION_SIGNALS = [
  'overpayment', 'over payment', 'over-payment', 'overpaid',
  'double payment', 'duplicate payment', 'extra payment',
  'credit balance', 'positive balance',
  'refund the overpayment', 'refund overpayment',
];

// Veto signals — phrasing that puts the ticket on a different workflow.
const VETOES = [
  'fee waiver', 'annual fee', 'fee reversal', 'dispute', 'chargeback',
];

function findMatches(text: string, needles: string[]): string[] {
  const found: string[] = [];
  for (const n of needles) if (text.includes(n)) found.push(n);
  return found;
}

export function detectOverpaymentTriage(
  summary: string,
  description: string,
  _workType: string | null | undefined,
): OverpaymentTriageDetection {
  const text = `${summary || ''}\n${description || ''}`.toLowerCase();

  const vetoes = findMatches(text, VETOES);
  if (vetoes.length) return { matched: false, reasons: [`vetoed: ${vetoes[0]}`] };

  const ccTopic = findMatches(text, CC_TOPIC_SIGNALS);
  const action = findMatches(text, OVERPAYMENT_ACTION_SIGNALS);

  const reasons: string[] = [];
  if (ccTopic.length) reasons.push(`CC topic: ${ccTopic[0].trim()}`);
  if (action.length) reasons.push(`Overpayment action: ${action[0].trim()}`);

  const matched = ccTopic.length > 0 && action.length > 0;
  return { matched, reasons };
}
```

- [ ] **Step 3: Create `src/data/reverseFeeDetect.ts`** with this content verbatim:

```ts
// Heuristic to detect tickets asking for a fee reversal (FX fee, ATM fee, foreign
// transaction fee, etc.). Mirrors [[cred-route-detect]] / [[wallet-triage-detect]].
//
// Action-only matching — phrases like "refund the fee" or "fx fee" are specific
// enough on their own that no separate topic anchor is needed.

export interface ReverseFeeDetection {
  matched: boolean;
  reasons: string[];
}

const REVERSE_FEE_ACTION_SIGNALS = [
  'reverse the fee', 'reverse this fee', 'reverse fee',
  'refund the fee', 'refund this fee',
  'remove the fee', 'credit the fee', 'waive the fee',
  'incorrect fee', 'fee charged in error',
  'fx fee', 'foreign transaction fee', 'atm fee',
];

// Veto signals — phrasing that puts the ticket on a different workflow.
const VETOES = [
  'annual fee', 'overpayment', 'dispute', 'chargeback',
];

function findMatches(text: string, needles: string[]): string[] {
  const found: string[] = [];
  for (const n of needles) if (text.includes(n)) found.push(n);
  return found;
}

export function detectReverseFee(
  summary: string,
  description: string,
  _workType: string | null | undefined,
): ReverseFeeDetection {
  const text = `${summary || ''}\n${description || ''}`.toLowerCase();

  const vetoes = findMatches(text, VETOES);
  if (vetoes.length) return { matched: false, reasons: [`vetoed: ${vetoes[0]}`] };

  const action = findMatches(text, REVERSE_FEE_ACTION_SIGNALS);

  const reasons: string[] = [];
  if (action.length) reasons.push(`Reverse-fee action: ${action[0].trim()}`);

  const matched = action.length > 0;
  return { matched, reasons };
}
```

- [ ] **Step 4: Create `src/data/qcFeeWaiverDetect.ts`** with this content verbatim:

```ts
// Heuristic to detect Quebec residents who need a MANUAL annual-fee waiver — the
// inverse of [[qc-auto-reimb-detect]], which catches the "client just became
// eligible, system auto-handles" case. Mirrors the existing detector shape.
//
// Mutual exclusion with QCAutoReimb: if any ELIGIBILITY_FLIP_SIGNALS are present,
// QCAutoReimb fires and we suppress this card. If those signals are absent and
// the QC + fee-topic combination matches, this card fires.

import { ELIGIBILITY_FLIP_SIGNALS } from './qcAutoReimbDetect';

export interface QCFeeWaiverDetection {
  matched: boolean;
  reasons: string[];
}

const QC_SIGNALS = ['qc', 'quebec', 'québec'];

const FEE_TOPIC_SIGNALS = [
  'fee waiver', 'fee waived', 'fees waived', 'fee reimbursement',
  'annual fee', 'cc fee', 'credit card fee',
  'waive the fee', 'reimburse the fee', 'reimburse the annual',
];

function findMatches(text: string, needles: string[]): string[] {
  const found: string[] = [];
  for (const n of needles) if (text.includes(n)) found.push(n);
  return found;
}

export function detectQCFeeWaiver(
  summary: string,
  description: string,
  _workType: string | null | undefined,
): QCFeeWaiverDetection {
  const text = `${summary || ''}\n${description || ''}`.toLowerCase();

  const vetoes = findMatches(text, ELIGIBILITY_FLIP_SIGNALS);
  if (vetoes.length) return { matched: false, reasons: [`vetoed (handled by QCAutoReimb): ${vetoes[0]}`] };

  const qc = findMatches(text, QC_SIGNALS);
  const feeTopic = findMatches(text, FEE_TOPIC_SIGNALS);

  const reasons: string[] = [];
  if (qc.length) reasons.push(`QC mention: ${qc[0]}`);
  if (feeTopic.length) reasons.push(`Fee topic: ${feeTopic[0].trim()}`);

  const matched = qc.length > 0 && feeTopic.length > 0;
  return { matched, reasons };
}
```

- [ ] **Step 5: Build to confirm everything compiles.**

Run from `~/projects/wocoo-extension/extension/`:
```bash
npm run build
```
Expected: build completes without TypeScript errors. The three new detector files are bundled; `qcAutoReimbDetect.ts`'s output is unchanged behaviorally (the `export` is the only edit).

- [ ] **Step 6: Sanity-grep that QCAutoReimb's detector still works the same way.**

```bash
grep -n 'ELIGIBILITY_FLIP_SIGNALS' /Users/albert.cai/projects/wocoo-extension/extension/src/data/qcAutoReimbDetect.ts
```
Expected: 2 lines — the `export const ELIGIBILITY_FLIP_SIGNALS = [` declaration AND the `const flip = findMatches(text, ELIGIBILITY_FLIP_SIGNALS);` usage inside `detectQCAutoReimb`. If the second is missing, the QCAutoReimb detector regressed.

---

## Task 2: Create cards + wire into SidePanel.tsx

**Files:**
- Create: `src/sidepanel/OverpaymentTriageCard.tsx`
- Create: `src/sidepanel/ReverseFeeCard.tsx`
- Create: `src/sidepanel/QCFeeWaiverCard.tsx`
- Modify: `src/sidepanel/SidePanel.tsx`

**Interfaces:**
- Consumes:
  - From Task 1: `detectOverpaymentTriage`, `detectReverseFee`, `detectQCFeeWaiver`.
  - Existing: `WocooTicket` from `../data/mockTicket`.
  - Existing in SidePanel scope: `onStartTriage`, `onStartReverseFee`, `onStartQCFeeWaiver` (already passed as props to `TicketViewInner`).
- Produces:
  - `OverpaymentTriageCard({ ticket, onStart }): JSX.Element | null`
  - `ReverseFeeCard({ ticket, onStart }): JSX.Element | null`
  - `QCFeeWaiverCard({ ticket, onStart }): JSX.Element | null`

- [ ] **Step 1: Create `src/sidepanel/OverpaymentTriageCard.tsx`** with this content verbatim:

```tsx
// Auto-detect recommendation card for credit-card overpayment tickets. Renders
// above QuickActions in the side panel when detectOverpaymentTriage matches.

import type { WocooTicket } from '../data/mockTicket';
import { detectOverpaymentTriage } from '../data/overpaymentTriageDetect';

export function OverpaymentTriageCard({ ticket, onStart }: { ticket: WocooTicket; onStart: () => void }) {
  if (!ticket.clientEmail) return null;
  const detection = detectOverpaymentTriage(ticket.summary || '', ticket.description || '', ticket.workType);
  if (!detection.matched) return null;

  return (
    <div style={cardStyle}>
      <div style={titleStyle}>⚡ Looks like a credit card overpayment</div>
      <div style={reasonsStyle}>{detection.reasons.join(' · ')}</div>
      <button onClick={onStart} style={buttonStyle}>Start Overpayment Triage</button>
    </div>
  );
}

const cardStyle: React.CSSProperties = {
  background: 'var(--mint-highlight-bg-soft)',
  border: '1px solid var(--mint-highlight-fg-graphic)',
  borderRadius: 'var(--mint-radius-card)',
  padding: 'var(--mint-sp-3)',
  display: 'flex',
  flexDirection: 'column',
};
const titleStyle: React.CSSProperties = {
  fontSize: 'var(--mint-text-meta)',
  fontWeight: 700,
  marginBottom: 4,
  color: 'var(--mint-highlight-fg-strong)',
};
const reasonsStyle: React.CSSProperties = {
  fontSize: 'var(--mint-text-nano)',
  color: 'var(--mint-fg-subdued-title)',
  marginBottom: 'var(--mint-sp-2)',
};
const buttonStyle: React.CSSProperties = {
  padding: '6px 12px',
  borderRadius: 'var(--mint-radius-button)',
  fontWeight: 600,
  fontSize: 'var(--mint-text-meta)',
  border: 'none',
  background: 'var(--mint-fg-strong)',
  color: 'var(--mint-fg-inverted)',
  cursor: 'pointer',
  alignSelf: 'flex-start',
};
```

- [ ] **Step 2: Create `src/sidepanel/ReverseFeeCard.tsx`** with this content verbatim:

```tsx
// Auto-detect recommendation card for fee-reversal tickets. Renders above
// QuickActions in the side panel when detectReverseFee matches.

import type { WocooTicket } from '../data/mockTicket';
import { detectReverseFee } from '../data/reverseFeeDetect';

export function ReverseFeeCard({ ticket, onStart }: { ticket: WocooTicket; onStart: () => void }) {
  if (!ticket.clientEmail) return null;
  const detection = detectReverseFee(ticket.summary || '', ticket.description || '', ticket.workType);
  if (!detection.matched) return null;

  return (
    <div style={cardStyle}>
      <div style={titleStyle}>↗ Looks like a fee reversal request</div>
      <div style={reasonsStyle}>{detection.reasons.join(' · ')}</div>
      <button onClick={onStart} style={buttonStyle}>Start Reverse Fee</button>
    </div>
  );
}

const cardStyle: React.CSSProperties = {
  background: 'var(--mint-highlight-bg-soft)',
  border: '1px solid var(--mint-highlight-fg-graphic)',
  borderRadius: 'var(--mint-radius-card)',
  padding: 'var(--mint-sp-3)',
  display: 'flex',
  flexDirection: 'column',
};
const titleStyle: React.CSSProperties = {
  fontSize: 'var(--mint-text-meta)',
  fontWeight: 700,
  marginBottom: 4,
  color: 'var(--mint-highlight-fg-strong)',
};
const reasonsStyle: React.CSSProperties = {
  fontSize: 'var(--mint-text-nano)',
  color: 'var(--mint-fg-subdued-title)',
  marginBottom: 'var(--mint-sp-2)',
};
const buttonStyle: React.CSSProperties = {
  padding: '6px 12px',
  borderRadius: 'var(--mint-radius-button)',
  fontWeight: 600,
  fontSize: 'var(--mint-text-meta)',
  border: 'none',
  background: 'var(--mint-fg-strong)',
  color: 'var(--mint-fg-inverted)',
  cursor: 'pointer',
  alignSelf: 'flex-start',
};
```

- [ ] **Step 3: Create `src/sidepanel/QCFeeWaiverCard.tsx`** with this content verbatim:

```tsx
// Auto-detect recommendation card for QC fee-waiver tickets. Renders above
// QuickActions in the side panel when detectQCFeeWaiver matches.

import type { WocooTicket } from '../data/mockTicket';
import { detectQCFeeWaiver } from '../data/qcFeeWaiverDetect';

export function QCFeeWaiverCard({ ticket, onStart }: { ticket: WocooTicket; onStart: () => void }) {
  if (!ticket.clientEmail) return null;
  const detection = detectQCFeeWaiver(ticket.summary || '', ticket.description || '', ticket.workType);
  if (!detection.matched) return null;

  return (
    <div style={cardStyle}>
      <div style={titleStyle}>⚖️ Looks like a QC fee waiver request</div>
      <div style={reasonsStyle}>{detection.reasons.join(' · ')}</div>
      <button onClick={onStart} style={buttonStyle}>Start QC Fee Waiver</button>
    </div>
  );
}

const cardStyle: React.CSSProperties = {
  background: 'var(--mint-highlight-bg-soft)',
  border: '1px solid var(--mint-highlight-fg-graphic)',
  borderRadius: 'var(--mint-radius-card)',
  padding: 'var(--mint-sp-3)',
  display: 'flex',
  flexDirection: 'column',
};
const titleStyle: React.CSSProperties = {
  fontSize: 'var(--mint-text-meta)',
  fontWeight: 700,
  marginBottom: 4,
  color: 'var(--mint-highlight-fg-strong)',
};
const reasonsStyle: React.CSSProperties = {
  fontSize: 'var(--mint-text-nano)',
  color: 'var(--mint-fg-subdued-title)',
  marginBottom: 'var(--mint-sp-2)',
};
const buttonStyle: React.CSSProperties = {
  padding: '6px 12px',
  borderRadius: 'var(--mint-radius-button)',
  fontWeight: 600,
  fontSize: 'var(--mint-text-meta)',
  border: 'none',
  background: 'var(--mint-fg-strong)',
  color: 'var(--mint-fg-inverted)',
  cursor: 'pointer',
  alignSelf: 'flex-start',
};
```

- [ ] **Step 4: Import the three new cards** in `src/sidepanel/SidePanel.tsx`. Find the existing block of card imports (around line 21–27 — the imports for `WalletTriageCard`, `CredRouteCard`, `QCAutoReimbCard`):

```ts
import { WalletTriageCard } from './WalletTriageCard';
```

After this line (and any subsequent card imports), add the three new ones:

```ts
import { OverpaymentTriageCard } from './OverpaymentTriageCard';
import { ReverseFeeCard } from './ReverseFeeCard';
import { QCFeeWaiverCard } from './QCFeeWaiverCard';
```

(Order them so they appear grouped with the other card imports.)

- [ ] **Step 5: Mount the three new cards** inside `TicketViewInner` above QuickActions. Find the existing card stack (around line 309–315):

```tsx
      <QCAutoReimbCard ticket={ticket} onTicketUpdate={onTicketUpdate} />

      {/* CRED ROUTE DETECTION — shows when ticket looks like a credit-decisioning task */}
      <CredRouteCard ticket={ticket} onOpenCloneMove={() => openCloneMove('CRED')} />

      {/* WALLET PROVISIONING DETECTION — shows when ticket looks like a wallet-add issue */}
      <WalletTriageCard ticket={ticket} onStart={onStartWalletTriage} />
```

Replace with:

```tsx
      <QCAutoReimbCard ticket={ticket} onTicketUpdate={onTicketUpdate} />

      {/* OVERPAYMENT TRIAGE DETECTION — credit card overpayment refund flow */}
      <OverpaymentTriageCard ticket={ticket} onStart={onStartTriage} />

      {/* REVERSE FEE DETECTION — fee reversal request (FX/ATM/foreign transaction) */}
      <ReverseFeeCard ticket={ticket} onStart={onStartReverseFee} />

      {/* QC FEE WAIVER DETECTION — Quebec client needs MANUAL annual-fee waiver */}
      <QCFeeWaiverCard ticket={ticket} onStart={onStartQCFeeWaiver} />

      {/* CRED ROUTE DETECTION — shows when ticket looks like a credit-decisioning task */}
      <CredRouteCard ticket={ticket} onOpenCloneMove={() => openCloneMove('CRED')} />

      {/* WALLET PROVISIONING DETECTION — shows when ticket looks like a wallet-add issue */}
      <WalletTriageCard ticket={ticket} onStart={onStartWalletTriage} />
```

`onStartTriage`, `onStartReverseFee`, `onStartQCFeeWaiver` are already in scope (props passed from `TicketView` → `TicketViewInner`). No new state or prop plumbing.

- [ ] **Step 6: Build to confirm everything compiles.**

Run from `~/projects/wocoo-extension/extension/`:
```bash
npm run build
```
Expected: build completes without TypeScript errors. Bundle grows by a few kB for the three new cards + detectors.

- [ ] **Step 7: Reload the extension.**

`chrome://extensions` → reload "WOCOO Triager".

- [ ] **Step 8: Smoke — Overpayment.**

  1. Open a WOCOO ticket whose description includes credit card + overpayment language (e.g. "client overpaid their credit card by $1,500, please refund to chequing").
  2. Above QuickActions, confirm the **⚡ Looks like a credit card overpayment** card appears.
  3. Reasons line shows the matched signals (e.g. `CC topic: credit card · Overpayment action: overpaid`).
  4. Click **Start Overpayment Triage** → workflow opens full-screen (existing TriageWorkflow behavior).
  5. Cancel out and verify the side panel still shows the recommendation card on return.

- [ ] **Step 9: Smoke — Reverse Fee.**

  1. Open a WOCOO ticket whose description includes "please reverse the FX fee" or similar.
  2. Confirm the **↗ Looks like a fee reversal request** card appears.
  3. Click **Start Reverse Fee** → workflow opens.

- [ ] **Step 10: Smoke — QC Fee Waiver.**

  1. Open a WOCOO ticket about a QC client needing an annual fee waiver, with NO tier-upgrade / eligibility-flip language.
  2. Confirm the **⚖️ Looks like a QC fee waiver request** card appears.
  3. Confirm `QCAutoReimbCard` does NOT appear (mutual exclusion).
  4. Click **Start QC Fee Waiver** → workflow opens.

- [ ] **Step 11: Mutual exclusion — QC Fee Waiver vs QCAutoReimb.**

  1. Open or simulate a QC + annual-fee ticket that ALSO contains "tier upgrade" or "newly eligible" language.
  2. Confirm `QCAutoReimbCard` fires AND `QCFeeWaiverCard` does NOT.
  3. (Inverse case is covered by Step 10.)

- [ ] **Step 12: Negative — unrelated tickets.**

  1. Open a wallet-provisioning ticket → `WalletTriageCard` fires, none of the 3 new cards fire.
  2. Open a wires ticket → none of the 3 new cards fire.
  3. Open a ticket missing `clientEmail` → none of the 3 new cards fire (even if their text signals would otherwise match).

- [ ] **Step 13: Regression — existing cards.**

  1. CredRouteCard still fires on a CRED-bound ticket (try one with "credit limit increase" or similar).
  2. QCAutoReimbCard still fires on a QC + fee + tier-upgrade ticket.
  3. WalletTriageCard still fires on a wallet-provisioning ticket.
  4. None of the three existing cards regress.

---

## Self-Review Summary

After writing the plan, checked it against the spec:

- **Spec coverage:**
  - 3 new detector files with topic/action/veto rules → Task 1 Steps 2–4.
  - `ELIGIBILITY_FLIP_SIGNALS` export → Task 1 Step 1.
  - 3 new card components (clientEmail-gated, mirror WalletTriageCard) → Task 2 Steps 1–3.
  - SidePanel mount + ordering above QuickActions → Task 2 Step 5.
  - QC Fee Waiver / QCAutoReimb mutual exclusion via detector veto → Task 1 Step 4 (`detectQCFeeWaiver` uses `ELIGIBILITY_FLIP_SIGNALS` as veto) + verified in Task 2 Step 11.
  - No new state / no new callback plumbing → Task 2 Step 5 ("already in scope" note).
  - Manual verification covers Smoke / Mutual exclusion / Negative / Regression → Task 2 Steps 8–13.
- **Placeholder scan:** No "TBD"/"TODO"/"implement later". All code blocks complete. Manual steps name exact buttons/cards.
- **Type consistency:** `OverpaymentTriageDetection`, `ReverseFeeDetection`, `QCFeeWaiverDetection` — distinct types per file, all returning `{ matched, reasons }`. `detectOverpaymentTriage` / `detectReverseFee` / `detectQCFeeWaiver` all share the same `(summary, description, workType)` signature. Card component prop shape `{ ticket, onStart }` consistent across all three.
- **Scope:** One focused feature, eight files (3 new detector + 3 new card + 1 modified detector + 1 modified SidePanel), two tasks. Single plan is the right shape.
