# QC Fee Waiver Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a "QC Fee Waiver" workflow modal in the WOCOO Triage Chrome extension that walks an agent through a Quebec credit-card annual-fee refund (cancellation or newly-eligible scenarios) per the [Notion policy](https://app.notion.com/p/wealthsimple/Quebec-Credit-Card-Fee-Waiver-32641167bd9680ac935ec99cedd46017).

**Architecture:** New `QCFeeWaiverWorkflow.tsx` mirrors the existing `OverpaymentTriage` / `ReverseFeeWorkflow` step-card pattern. Two new i2c content-script chain variants — `qc_month_scrape` (counts months of card use) and `apply_credit` (pre-fills the Admin Credit form). Reuses existing Jira API helpers (`createReimbTicket`, `postComment`, `transitionTicket`).

**Tech Stack:** Vite + React + TypeScript Chrome MV3 extension. No unit-test framework in this repo — verification per task = `npm run build` (passes TS) + reload `dist/` in `chrome://extensions` + manually smoke-test the affected flow.

**Spec:** `docs/superpowers/specs/2026-06-12-qc-fee-waiver-design.md`

---

## Task 1: Add `qc_month_scrape` + `apply_credit` to the i2c Flow type and bootstrap

Foundation pass — wire the new flow values into the chain plumbing without functional behavior, so later tasks can implement the actual logic in isolation.

**Files:**
- Modify: `extension/src/content/i2c.ts`

- [ ] **Step 1: Widen the `Flow` type to include the two new variants.**

Find the `Flow` union (search `type Flow`) and add the new values:

```ts
type Flow = 'reverse_fee' | 'admin_debit' | 'verify_balance' | 'qc_month_scrape' | 'apply_credit' | null;
async function getFlow(): Promise<Flow> {
  const res = await chrome.storage.local.get('pending_i2c_flow');
  const v = res.pending_i2c_flow;
  return v === 'reverse_fee' || v === 'admin_debit' || v === 'verify_balance'
    || v === 'qc_month_scrape' || v === 'apply_credit' ? v : null;
}
```

- [ ] **Step 2: Add `qc_month_scrape` to `tryAccountTransactions` gating.**

Find the line that gates which flows click the sidebar (currently `if (flow !== 'verify_balance' && flow !== 'reverse_fee') return false;`). Extend it:

```ts
if (flow !== 'verify_balance' && flow !== 'reverse_fee' && flow !== 'qc_month_scrape') return false;
```

- [ ] **Step 3: Add `apply_credit` to `tryAdminServices` gating.**

Find `tryAdminServices` — the gate currently reads `if ((await getFlow()) !== 'admin_debit') return false;`. Change to:

```ts
const flow = await getFlow();
if (flow !== 'admin_debit' && flow !== 'apply_credit') return false;
```

- [ ] **Step 4: Add stub `tryDateRangeScrape` and `tryFillApplyCredit` functions.**

After `tryReadRunningBalance`, paste these stubs (real implementations land in Tasks 7 and 10):

```ts
// ----- qc_month_scrape only (Task 7): set wide Date Range + count months with transactions -----

let dateRangeScrapeRan = false;
async function tryDateRangeScrape(): Promise<boolean> {
  if (dateRangeScrapeRan) return true;
  if ((await getFlow()) !== 'qc_month_scrape') return false;
  log('  → tryDateRangeScrape stub fired (not yet implemented)');
  return false; // not implemented yet — Task 7 fills this in
}

// ----- apply_credit only (Task 10): pre-fill Admin Credit form -----

let applyCreditFilledRan = false;
async function tryFillApplyCredit(): Promise<boolean> {
  if (applyCreditFilledRan) return true;
  if ((await getFlow()) !== 'apply_credit') return false;
  log('  → tryFillApplyCredit stub fired (not yet implemented)');
  return false; // not implemented yet — Task 10 fills this in
}
```

- [ ] **Step 5: Call the new stubs from `pass()`.**

Find `async function pass()` and add the two calls before the closing brace:

```ts
async function pass() {
  await tryAutofill();
  await tryKillSession();
  await tryEmailSearch();
  await tryContinueWithCustomer();
  await tryAccountTransactions();
  await tryAdminServices();
  await tryRecentActivity();
  await tryCurrentStatement();
  await tryClickSearch();
  await tryReadRunningBalance();
  await tryFindAndClickReverseFee();
  await tryPasteTicketUrl();
  await tryFillAdminDebit();
  await tryDateRangeScrape();   // new
  await tryFillApplyCredit();   // new
}
```

- [ ] **Step 6: Verify build passes.**

Run from `extension/`:

```bash
npm run build
```

Expected: `✓ built` with no TS errors. The two stubs will log into the i2c console if someone happens to set `pending_i2c_flow` to one of the new values, but no further behavior changes yet.

- [ ] **Step 7: Commit.**

```bash
git add src/content/i2c.ts
git commit -m "feat(i2c): add qc_month_scrape + apply_credit flow stubs"
```

---

## Task 2: Build the `QCFeeWaiverWorkflow.tsx` shell

The workflow file with header, progress dots, step-card primitives, and a hard-coded `state.step = 1` so the visual layout can be validated independently of the actual step logic.

**Files:**
- Create: `extension/src/sidepanel/QCFeeWaiverWorkflow.tsx`

- [ ] **Step 1: Create the new file with the shell.**

```tsx
// QC Fee Waiver workflow — 7 steps with a success state.
//
// Scenarios:
//   A. Cancellation             → refund = $220 − ($20 × monthsUsed)
//   B. Newly fee-waiver eligible → refund = $20 × (12 − monthsSinceAnniversary)
//
// Both end with: Apply Admin Credit in i2c → (Cancellation+paid only) submit REIMB →
// post comment → move to Done.

import { useState } from 'react';
import type { WocooTicket } from '../data/mockTicket';

type StepNum = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
type Scenario = 'cancellation' | 'newly_eligible';

const STEP_TITLES: Record<StepNum, string> = {
  1: 'Pick scenario',
  2: 'Collect inputs',
  3: 'Confirm refund',
  4: 'Apply Admin Credit',
  5: 'Submit REIMB ticket',
  6: 'Post comment',
  7: 'Move to Done',
  8: 'Complete',
};

const STEP_SUBTITLES: Record<StepNum, string> = {
  1: 'Which path applies to this ticket?',
  2: 'Months of card usage + scenario inputs',
  3: 'Confirm the calculated refund amount',
  4: 'Open i2c with the credit form pre-filled',
  5: 'Reimburse to the client\'s chequing account',
  6: 'Templated explanation for the WOCOO ticket',
  7: 'Final step',
  8: '',
};

export function QCFeeWaiverWorkflow({ ticket, onClose, onTicketUpdate }: { ticket: WocooTicket; onClose: () => void; onTicketUpdate: (t: WocooTicket) => void }) {
  const [step, setStep] = useState<StepNum>(1);
  const [scenario, setScenario] = useState<Scenario | null>(null);

  // hardcoded for now — real renderers land in later tasks
  function renderBody(n: StepNum) {
    if (n === 1) return <div style={{ fontSize: 'var(--mint-text-meta)', color: 'var(--mint-fg-soft)' }}>(scenario picker — Task 4)</div>;
    return <div style={{ fontSize: 'var(--mint-text-meta)', color: 'var(--mint-fg-soft)' }}>(stub — step {n})</div>;
  }

  function renderStep(n: StepNum) {
    if (n === 8) return null;
    const isCompleted = n < step;
    const isActive = n === step;
    if (isCompleted) return <ExpandedCard key={n} n={n} completed>{renderBody(n)}</ExpandedCard>;
    if (isActive) return <ExpandedCard key={n} n={n}>{renderBody(n)}</ExpandedCard>;
    return <FutureStub key={n} n={n} />;
  }

  // suppress unused-warning until later tasks reference these
  void scenario; void setScenario; void setStep; void onTicketUpdate;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh', background: 'var(--mint-bg-page)' }}>
      <Header step={step} ticketId={ticket.id} onClose={onClose} />
      <div style={{ padding: 'var(--mint-sp-3)', display: 'flex', flexDirection: 'column', gap: 'var(--mint-sp-2)' }}>
        {([1, 2, 3, 4, 5, 6, 7] as StepNum[]).map(renderStep)}
        {step === 8 ? <div>(success panel — Task 14)</div> : null}
      </div>
    </div>
  );
}

function Header({ step, ticketId, onClose }: { step: StepNum; ticketId: string; onClose: () => void }) {
  return (
    <header style={{ position: 'sticky', top: 0, zIndex: 50, background: 'var(--mint-bg-card)', borderBottom: 'var(--mint-card-stroke)', padding: 'var(--mint-sp-3) var(--mint-sp-3) var(--mint-sp-2)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <button onClick={onClose} title="Back to ticket" style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--mint-fg-soft)', fontSize: 16, padding: 4 }}>←</button>
        <a href={`https://wealthsimple.atlassian.net/browse/${ticketId}`} target="_blank" rel="noreferrer" style={{ color: 'var(--mint-highlight-fg-strong)', fontWeight: 700, fontSize: 'var(--mint-text-meta)', textDecoration: 'none' }}>{ticketId}</a>
        <span style={{ marginLeft: 'auto', fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-soft)' }}>Step {step} of 7</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <h2 style={{ margin: 0, fontSize: 'var(--mint-text-h-md)', fontWeight: 700, color: 'var(--mint-fg-strong)' }}>QC Fee Waiver</h2>
        <ProgressDots step={step} />
      </div>
    </header>
  );
}

function ProgressDots({ step }: { step: StepNum }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => {
        const done = n < step;
        const active = n === step;
        if (done) return <span key={n} style={{ width: 14, height: 14, borderRadius: 9999, background: 'var(--mint-positive-fg-graphic)', color: '#fff', fontSize: 9, fontWeight: 800, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>✓</span>;
        if (active) return <span key={n} style={{ width: 10, height: 10, borderRadius: 9999, background: 'var(--mint-fg-strong)' }} />;
        return <span key={n} style={{ width: 10, height: 10, borderRadius: 9999, border: '1.5px solid var(--mint-outline-strong)' }} />;
      })}
    </div>
  );
}

function ExpandedCard({ n, children, completed }: { n: StepNum; children: React.ReactNode; completed?: boolean }) {
  return (
    <section style={{
      background: completed ? 'var(--mint-positive-bg-soft)' : 'var(--mint-bg-card)',
      border: completed ? '1px solid var(--mint-positive-fg-graphic)' : '1px solid var(--mint-outline-strong)',
      borderRadius: 'var(--mint-radius-card)',
      padding: 'var(--mint-sp-3)',
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--mint-sp-2)', marginBottom: 'var(--mint-sp-3)' }}>
        {completed ? (
          <span style={{ width: 22, height: 22, borderRadius: 9999, background: 'var(--mint-positive-fg-graphic)', color: '#fff', fontSize: 12, fontWeight: 800, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>✓</span>
        ) : (
          <span style={numCircle}>{n}</span>
        )}
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <span style={{ fontSize: 'var(--mint-text-body)', fontWeight: 700, color: completed ? 'var(--mint-positive-fg-strong)' : 'var(--mint-fg-strong)' }}>{STEP_TITLES[n]}</span>
          {!completed ? <span style={{ fontSize: 'var(--mint-text-micro)', color: 'var(--mint-fg-soft)' }}>{STEP_SUBTITLES[n]}</span> : null}
        </div>
      </div>
      {children}
    </section>
  );
}

function FutureStub({ n }: { n: StepNum }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--mint-sp-2)', padding: '12px var(--mint-sp-3)', background: 'var(--mint-bg-subtle)', border: 'var(--mint-card-stroke)', borderRadius: 'var(--mint-radius-card)', opacity: 0.7 }}>
      <span style={numCircleEmpty}>{n}</span>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <span style={{ fontSize: 'var(--mint-text-body)', fontWeight: 600, color: 'var(--mint-fg-strong)' }}>{STEP_TITLES[n]}</span>
        <span style={{ fontSize: 'var(--mint-text-micro)', color: 'var(--mint-fg-soft)' }}>Not started</span>
      </div>
    </div>
  );
}

const numCircle: React.CSSProperties = {
  width: 22, height: 22, borderRadius: 9999, flexShrink: 0,
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  fontSize: 12, fontWeight: 700,
  background: 'var(--mint-fg-strong)', color: 'var(--mint-fg-inverted)', border: 'none',
};

const numCircleEmpty: React.CSSProperties = {
  width: 22, height: 22, borderRadius: 9999, flexShrink: 0,
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  fontSize: 12, fontWeight: 700,
  background: 'transparent', color: 'var(--mint-fg-soft)', border: '1.5px solid var(--mint-outline-strong)',
};
```

- [ ] **Step 2: Verify build.**

```bash
npm run build
```

Expected: `✓ built` with no TS errors. The new file is not imported anywhere yet, so it ships but does nothing.

- [ ] **Step 3: Commit.**

```bash
git add src/sidepanel/QCFeeWaiverWorkflow.tsx
git commit -m "feat(qc-fee-waiver): scaffold workflow shell"
```

---

## Task 3: Wire QuickActions button + SidePanel routing

Surface the workflow modal in the UI. Add a button next to Reverse Fee, and route to the new workflow component when active.

**Files:**
- Modify: `extension/src/sidepanel/SidePanel.tsx`

- [ ] **Step 1: Import the new workflow.**

Find the imports block (top of file) and add:

```ts
import { QCFeeWaiverWorkflow } from './QCFeeWaiverWorkflow';
```

- [ ] **Step 2: Add `qcFeeWaiverActive` state + route to it in `TicketView`.**

Find `function TicketView(` and add the state + route. The function currently has `triageActive` and `reverseFeeActive`; mirror those for `qcFeeWaiverActive`:

```tsx
function TicketView({ ticket, onTicketUpdate, onGoHome, onOpenSettings }: { ticket: WocooTicket; onTicketUpdate: (t: WocooTicket) => void; onGoHome: () => void; onOpenSettings: () => void }) {
  const [triageActive, setTriageActive] = useState(false);
  const [reverseFeeActive, setReverseFeeActive] = useState(false);
  const [qcFeeWaiverActive, setQCFeeWaiverActive] = useState(false);
  if (triageActive) {
    return (
      <OverpaymentTriage ticket={ticket} onClose={() => setTriageActive(false)} onTicketUpdate={onTicketUpdate} />
    );
  }
  if (reverseFeeActive) {
    return (
      <ReverseFeeWorkflow ticket={ticket} onClose={() => setReverseFeeActive(false)} onTicketUpdate={onTicketUpdate} />
    );
  }
  if (qcFeeWaiverActive) {
    return (
      <QCFeeWaiverWorkflow ticket={ticket} onClose={() => setQCFeeWaiverActive(false)} onTicketUpdate={onTicketUpdate} />
    );
  }
  return (
    <TicketViewInner
      ticket={ticket}
      onTicketUpdate={onTicketUpdate}
      onStartTriage={() => setTriageActive(true)}
      onStartReverseFee={() => setReverseFeeActive(true)}
      onStartQCFeeWaiver={() => setQCFeeWaiverActive(true)}
      onGoHome={onGoHome}
      onOpenSettings={onOpenSettings}
    />
  );
}
```

- [ ] **Step 3: Plumb `onStartQCFeeWaiver` through `TicketViewInner`.**

Find `function TicketViewInner({` (one place — search for the props destructure). Add `onStartQCFeeWaiver: () => void` to the props type and the destructured args:

```tsx
function TicketViewInner({ ticket, onTicketUpdate, onStartTriage, onStartReverseFee, onStartQCFeeWaiver, onGoHome, onOpenSettings }: { ticket: WocooTicket; onTicketUpdate: (t: WocooTicket) => void; onStartTriage: () => void; onStartReverseFee: () => void; onStartQCFeeWaiver: () => void; onGoHome: () => void; onOpenSettings: () => void }) {
```

- [ ] **Step 4: Pass `onStartQCFeeWaiver` into `QuickActions`.**

Find the `<QuickActions …/>` JSX inside `TicketViewInner` and add the new prop:

```tsx
<QuickActions ticket={ticket} onTicketUpdate={onTicketUpdate} onStartTriage={onStartTriage} onStartReverseFee={onStartReverseFee} onStartQCFeeWaiver={onStartQCFeeWaiver} />
```

- [ ] **Step 5: Update `QuickActions` to accept the prop + render the new button.**

Find `function QuickActions({`. Add `onStartQCFeeWaiver: () => void` to the props. In the second `<div style={{ display: 'flex' }}>` (the row currently holding just Reverse Fee), change the layout so both buttons share the row:

```tsx
<div style={{ display: 'flex', gap: 'var(--mint-sp-2)' }}>
  <ActionButton variant="warning" onClick={onStartReverseFee} disabled={!ticket.clientEmail} title="Start Reverse Fee workflow">
    ↗ Reverse Fee
  </ActionButton>
  <ActionButton variant="neutral" onClick={onStartQCFeeWaiver} disabled={!ticket.clientEmail} title="Start QC Fee Waiver workflow">
    ⚖️ QC Fee Waiver
  </ActionButton>
</div>
```

The `variant="neutral"` is the black variant — visually distinct from Reverse Fee's amber + the other action colors. If you prefer a different color, swap the variant value (existing palette: `positive`, `neutral`, `ghost`, `highlight`, `warning`, `special`).

- [ ] **Step 6: Verify build + smoke test.**

```bash
npm run build
```

Expected: `✓ built`. Reload `dist/` in `chrome://extensions`. Open a ticket. Confirm:
- Reverse Fee + QC Fee Waiver buttons share row 2, equal width.
- Clicking QC Fee Waiver opens the workflow modal showing 7 step stubs + "Step 1 of 7" in the header.
- Clicking ← in the modal header returns to the ticket view.

- [ ] **Step 7: Commit.**

```bash
git add src/sidepanel/SidePanel.tsx
git commit -m "feat(qc-fee-waiver): add QuickActions button + SidePanel routing"
```

---

## Task 4: Implement Step 1 — Scenario picker

Replace the Step 1 stub with two radio cards (Cancellation / Newly Eligible) and a Continue button that advances to Step 2.

**Files:**
- Modify: `extension/src/sidepanel/QCFeeWaiverWorkflow.tsx`

- [ ] **Step 1: Write the `Step1Body` component.**

Add this above `function Header`:

```tsx
function Step1Body({ scenario, setScenario, showAction, onContinue }: { scenario: Scenario | null; setScenario: (s: Scenario) => void; showAction: boolean; onContinue: () => void }) {
  return (
    <>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <ScenarioCard
          active={scenario === 'cancellation'}
          title="Cancellation"
          subtitle="Client wants to close the card. Refund = $220 − $20 × months used."
          onClick={() => setScenario('cancellation')}
        />
        <ScenarioCard
          active={scenario === 'newly_eligible'}
          title="Newly fee-waiver eligible"
          subtitle="Client became eligible (tier upgrade or direct deposits) after paying the annual fee."
          onClick={() => setScenario('newly_eligible')}
        />
      </div>
      {showAction ? (
        <div style={{ marginTop: 'var(--mint-sp-3)' }}>
          <button onClick={onContinue} disabled={!scenario} style={{ ...primaryButton, width: '100%', opacity: scenario ? 1 : 0.55, cursor: scenario ? 'pointer' : 'not-allowed' }}>
            Continue →
          </button>
        </div>
      ) : null}
    </>
  );
}

function ScenarioCard({ active, title, subtitle, onClick }: { active: boolean; title: string; subtitle: string; onClick: () => void }) {
  return (
    <button onClick={onClick} style={{
      textAlign: 'left',
      padding: 'var(--mint-sp-3)',
      background: active ? 'var(--mint-highlight-bg-soft)' : 'var(--mint-bg-card)',
      border: '1.5px solid ' + (active ? 'var(--mint-highlight-fg-graphic)' : 'var(--mint-outline-strong)'),
      borderRadius: 'var(--mint-radius-card)',
      cursor: 'pointer',
      display: 'flex', flexDirection: 'column', gap: 4,
    }}>
      <span style={{ fontSize: 'var(--mint-text-meta)', fontWeight: 700, color: active ? 'var(--mint-highlight-fg-strong)' : 'var(--mint-fg-strong)' }}>{title}</span>
      <span style={{ fontSize: 'var(--mint-text-micro)', color: 'var(--mint-fg-soft)', lineHeight: 1.4 }}>{subtitle}</span>
    </button>
  );
}

const primaryButton: React.CSSProperties = {
  padding: '12px 16px',
  borderRadius: 'var(--mint-radius-button)',
  fontWeight: 700,
  fontSize: 'var(--mint-text-meta)',
  border: 'none',
  background: 'var(--mint-fg-strong)',
  color: 'var(--mint-fg-inverted)',
  cursor: 'pointer',
};
```

- [ ] **Step 2: Wire the scenario picker into `renderBody`.**

Replace the existing `renderBody` function:

```tsx
function renderBody(n: StepNum) {
  const onCurrentStep = n === step;
  if (n === 1) return (
    <Step1Body
      scenario={scenario}
      setScenario={setScenario}
      showAction={onCurrentStep}
      onContinue={() => setStep(2)}
    />
  );
  return <div style={{ fontSize: 'var(--mint-text-meta)', color: 'var(--mint-fg-soft)' }}>(stub — step {n})</div>;
}
```

Remove the `void scenario; void setScenario; void setStep;` line that suppressed the unused warnings — those values are now used.

- [ ] **Step 3: Verify build + smoke test.**

```bash
npm run build
```

Reload `dist/`. Open the workflow and confirm:
- Two radio cards visible in Step 1.
- Continue button disabled when nothing selected.
- Picking either scenario enables the button.
- Clicking Continue advances to Step 2 (still a stub). Step 1 now shows as completed (green border + ✓).

- [ ] **Step 4: Commit.**

```bash
git add src/sidepanel/QCFeeWaiverWorkflow.tsx
git commit -m "feat(qc-fee-waiver): implement Step 1 scenario picker"
```

---

## Task 5: Implement Step 2 (Cancellation inputs) + scrape-from-i2c hookup

Cancellation-path inputs only. Newly-Eligible inputs land in Task 6. The scrape button stages storage + opens i2c; the workflow listens via `chrome.storage.onChanged` for the scrape result and auto-populates the months-used input.

**Files:**
- Modify: `extension/src/sidepanel/QCFeeWaiverWorkflow.tsx`

- [ ] **Step 1: Add state for the Cancellation inputs.**

Below `const [scenario, setScenario] = useState<Scenario | null>(null);`:

```tsx
const [monthsUsedInput, setMonthsUsedInput] = useState<string>('');
const [monthsBreakdown, setMonthsBreakdown] = useState<string[]>([]);
const [clientPaidAnnualFee, setClientPaidAnnualFee] = useState<boolean>(true);
const [scrapePending, setScrapePending] = useState<boolean>(false);
```

- [ ] **Step 2: Add the i2c constant + scrape staging function.**

Below the imports section (top of file):

```tsx
const I2C_LOGIN_URL = 'https://wealthsimplecs.mycardplace.com/customerservice/wealthsimplelogin.jsp';
```

Then inside `QCFeeWaiverWorkflow`, after `setScrapePending`:

```tsx
const scrapeFromI2c = () => {
  if (!ticket.clientEmail) return;
  setScrapePending(true);
  void chrome.storage.local.set({
    pending_i2c_email: ticket.clientEmail,
    pending_i2c_source_ticket_id: ticket.id,
    pending_i2c_flow: 'qc_month_scrape',
    pending_i2c_started_at: Date.now(),
  });
  void chrome.storage.local.remove(['pending_i2c_ticket_url', 'pending_i2c_admin_debit_amount', 'pending_i2c_admin_credit_amount']);
  window.open(I2C_LOGIN_URL, '_blank', 'noopener,noreferrer');
};

// Listen for the i2c content script writing back the scrape result.
useEffect(() => {
  if (!scrapePending) return;
  const onChange = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area !== 'local' || !('qc_month_scrape_result' in changes)) return;
    const v = changes.qc_month_scrape_result.newValue as { sourceTicketId?: string; monthsUsed?: number; monthsBreakdown?: string[] } | undefined;
    if (v && v.sourceTicketId === ticket.id && typeof v.monthsUsed === 'number') {
      setMonthsUsedInput(String(v.monthsUsed));
      setMonthsBreakdown(Array.isArray(v.monthsBreakdown) ? v.monthsBreakdown : []);
      setScrapePending(false);
    }
  };
  chrome.storage.onChanged.addListener(onChange);
  return () => chrome.storage.onChanged.removeListener(onChange);
}, [scrapePending, ticket.id]);
```

Add the `useEffect` import to the existing `import { useState } from 'react';` line:

```tsx
import { useEffect, useState } from 'react';
```

- [ ] **Step 3: Write `Step2CancellationBody`.**

```tsx
function Step2CancellationBody({ monthsUsedInput, setMonthsUsedInput, monthsBreakdown, scrapePending, scrapeFromI2c, clientPaidAnnualFee, setClientPaidAnnualFee, clientEmail, showAction, onContinue }: {
  monthsUsedInput: string;
  setMonthsUsedInput: (v: string) => void;
  monthsBreakdown: string[];
  scrapePending: boolean;
  scrapeFromI2c: () => void;
  clientPaidAnnualFee: boolean;
  setClientPaidAnnualFee: (v: boolean) => void;
  clientEmail: string;
  showAction: boolean;
  onContinue: () => void;
}) {
  const monthsUsed = parseInt(monthsUsedInput, 10);
  const monthsValid = isFinite(monthsUsed) && monthsUsed >= 0 && monthsUsed <= 12;
  return (
    <>
      <div style={{ marginBottom: 'var(--mint-sp-3)' }}>
        <div style={fieldLabel}>Months used</div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'stretch' }}>
          <input
            type="number"
            min={0}
            max={12}
            value={monthsUsedInput}
            onChange={(e) => setMonthsUsedInput(e.target.value)}
            placeholder="0–12"
            style={{ flex: 1, minWidth: 0, padding: '6px 10px', fontFamily: 'var(--mint-font-mono)', fontSize: 'var(--mint-text-micro)', border: '1px solid ' + (monthsValid || !monthsUsedInput ? 'var(--mint-outline-strong)' : 'var(--mint-negative-fg-graphic)'), borderRadius: 'var(--mint-radius-button)', background: 'var(--mint-bg-card)', color: 'var(--mint-fg-strong)', boxSizing: 'border-box' }}
          />
          <button
            onClick={scrapeFromI2c}
            disabled={!clientEmail || scrapePending}
            title="Open i2c → Account Transactions → Date Range → scrape distinct months with activity"
            style={{ padding: '4px 10px', background: 'var(--mint-highlight-fg-graphic)', color: '#fff', border: 'none', borderRadius: 'var(--mint-radius-button)', fontSize: 'var(--mint-text-nano)', fontWeight: 700, cursor: !clientEmail || scrapePending ? 'not-allowed' : 'pointer', opacity: !clientEmail || scrapePending ? 0.6 : 1, whiteSpace: 'nowrap' }}
          >
            {scrapePending ? 'Scraping…' : '↗ Scrape from i2c'}
          </button>
        </div>
        {scrapePending ? (
          <div style={{ marginTop: 4, fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-soft)', fontStyle: 'italic' }}>
            Waiting for i2c… (Date Range set to past 14 months, distinct transaction months counted)
          </div>
        ) : null}
        {monthsBreakdown.length > 0 ? (
          <div style={{ marginTop: 6, fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-subdued-title)' }}>
            Months with activity: {monthsBreakdown.join(', ')}
          </div>
        ) : null}
      </div>

      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--mint-text-meta)', color: 'var(--mint-fg-strong)', cursor: 'pointer' }}>
        <input type="checkbox" checked={clientPaidAnnualFee} onChange={(e) => setClientPaidAnnualFee(e.target.checked)} />
        Client has already paid the annual fee
      </label>
      <div style={{ marginTop: 4, fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-soft)', lineHeight: 1.4 }}>
        If paid → REIMB ticket is submitted to refund to chequing in Step 5.
        Unpaid → only the Admin Credit is applied.
      </div>

      {showAction ? (
        <div style={{ marginTop: 'var(--mint-sp-3)' }}>
          <button onClick={onContinue} disabled={!monthsValid} style={{ ...primaryButton, width: '100%', opacity: monthsValid ? 1 : 0.55, cursor: monthsValid ? 'pointer' : 'not-allowed' }}>
            Continue →
          </button>
        </div>
      ) : null}
    </>
  );
}

const fieldLabel: React.CSSProperties = {
  fontSize: 'var(--mint-text-nano)',
  textTransform: 'uppercase',
  letterSpacing: '0.5px',
  color: 'var(--mint-fg-soft)',
  fontWeight: 700,
  marginBottom: 6,
};
```

- [ ] **Step 4: Wire Step 2 into `renderBody`.**

Update `renderBody`:

```tsx
function renderBody(n: StepNum) {
  const onCurrentStep = n === step;
  if (n === 1) return (
    <Step1Body scenario={scenario} setScenario={setScenario} showAction={onCurrentStep} onContinue={() => setStep(2)} />
  );
  if (n === 2 && scenario === 'cancellation') return (
    <Step2CancellationBody
      monthsUsedInput={monthsUsedInput}
      setMonthsUsedInput={setMonthsUsedInput}
      monthsBreakdown={monthsBreakdown}
      scrapePending={scrapePending}
      scrapeFromI2c={scrapeFromI2c}
      clientPaidAnnualFee={clientPaidAnnualFee}
      setClientPaidAnnualFee={setClientPaidAnnualFee}
      clientEmail={ticket.clientEmail}
      showAction={onCurrentStep}
      onContinue={() => setStep(3)}
    />
  );
  return <div style={{ fontSize: 'var(--mint-text-meta)', color: 'var(--mint-fg-soft)' }}>(stub — step {n})</div>;
}
```

- [ ] **Step 5: Verify build + smoke test.**

```bash
npm run build
```

Reload `dist/`. Open the workflow, pick Cancellation, click Continue. Confirm:
- Step 2 shows months-used input, Scrape button, and paid-toggle.
- Continue is disabled until a valid months value is typed (or "0" — full refund is valid).
- Clicking Continue advances to Step 3 (still a stub).

The Scrape button can be clicked — it opens i2c and the content-script log `tryDateRangeScrape stub fired` should appear in the i2c tab's console. The scrape doesn't actually populate the input yet (Task 7).

- [ ] **Step 6: Commit.**

```bash
git add src/sidepanel/QCFeeWaiverWorkflow.tsx
git commit -m "feat(qc-fee-waiver): implement Step 2 Cancellation inputs + scrape hookup"
```

---

## Task 6: Implement Step 2 (Newly Eligible inputs)

The newly-eligible path uses two `type="month"` inputs (anniversary and eligibility-flip month). Computed `monthsLeft` shows as helper text.

**Files:**
- Modify: `extension/src/sidepanel/QCFeeWaiverWorkflow.tsx`

- [ ] **Step 1: Add state.**

Add below `setScrapePending`:

```tsx
const [anniversaryMonth, setAnniversaryMonth] = useState<string>('');     // 'YYYY-MM'
const [eligibilityFlipMonth, setEligibilityFlipMonth] = useState<string>('');
```

- [ ] **Step 2: Write `Step2NewlyEligibleBody`.**

```tsx
function Step2NewlyEligibleBody({ anniversaryMonth, setAnniversaryMonth, eligibilityFlipMonth, setEligibilityFlipMonth, showAction, onContinue }: {
  anniversaryMonth: string;
  setAnniversaryMonth: (v: string) => void;
  eligibilityFlipMonth: string;
  setEligibilityFlipMonth: (v: string) => void;
  showAction: boolean;
  onContinue: () => void;
}) {
  const monthsLeft = computeMonthsLeft(anniversaryMonth, eligibilityFlipMonth);
  const valid = monthsLeft != null && monthsLeft > 0 && monthsLeft <= 12;
  return (
    <>
      <div style={{ marginBottom: 'var(--mint-sp-3)' }}>
        <div style={fieldLabel}>Anniversary month (CC received)</div>
        <input type="month" value={anniversaryMonth} onChange={(e) => setAnniversaryMonth(e.target.value)} style={monthInputStyle} />
      </div>
      <div>
        <div style={fieldLabel}>Eligibility-flip month</div>
        <input type="month" value={eligibilityFlipMonth} onChange={(e) => setEligibilityFlipMonth(e.target.value)} style={monthInputStyle} />
      </div>
      {monthsLeft != null ? (
        <div style={{ marginTop: 6, fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-subdued-title)' }}>
          Months remaining until anniversary: <strong>{monthsLeft}</strong>
        </div>
      ) : null}

      {showAction ? (
        <div style={{ marginTop: 'var(--mint-sp-3)' }}>
          <button onClick={onContinue} disabled={!valid} style={{ ...primaryButton, width: '100%', opacity: valid ? 1 : 0.55, cursor: valid ? 'pointer' : 'not-allowed' }}>
            Continue →
          </button>
        </div>
      ) : null}
    </>
  );
}

const monthInputStyle: React.CSSProperties = {
  width: '100%',
  padding: '6px 10px',
  fontFamily: 'var(--mint-font-family)',
  fontSize: 'var(--mint-text-micro)',
  border: 'var(--mint-card-stroke)',
  borderRadius: 'var(--mint-radius-button)',
  background: 'var(--mint-bg-card)',
  color: 'var(--mint-fg-strong)',
  boxSizing: 'border-box',
};

function computeMonthsLeft(anniversary: string, flip: string): number | null {
  if (!/^\d{4}-\d{2}$/.test(anniversary) || !/^\d{4}-\d{2}$/.test(flip)) return null;
  const [ay, am] = anniversary.split('-').map((s) => parseInt(s, 10));
  const [fy, fm] = flip.split('-').map((s) => parseInt(s, 10));
  // The next anniversary date is exactly 12 months after the receive month.
  const nextAnniversaryMonthsSinceEpoch = ay * 12 + (am - 1) + 12;
  const flipMonthsSinceEpoch = fy * 12 + (fm - 1);
  const left = nextAnniversaryMonthsSinceEpoch - flipMonthsSinceEpoch;
  return left;
}
```

- [ ] **Step 3: Branch Step 2 in `renderBody`.**

Update the Step 2 branch to handle both scenarios:

```tsx
if (n === 2 && scenario === 'cancellation') return (
  <Step2CancellationBody …existing props… />
);
if (n === 2 && scenario === 'newly_eligible') return (
  <Step2NewlyEligibleBody
    anniversaryMonth={anniversaryMonth}
    setAnniversaryMonth={setAnniversaryMonth}
    eligibilityFlipMonth={eligibilityFlipMonth}
    setEligibilityFlipMonth={setEligibilityFlipMonth}
    showAction={onCurrentStep}
    onContinue={() => setStep(3)}
  />
);
```

- [ ] **Step 4: Verify build + smoke test.**

```bash
npm run build
```

Reload `dist/`. Pick Newly Eligible in Step 1, advance. Confirm:
- Two month inputs render.
- Filling both shows "Months remaining: N" below.
- Continue disabled until both valid + monthsLeft is in (0, 12].
- Edge case to verify manually: anniversary 2025-10, eligibility 2026-04 → monthsLeft = 6.

- [ ] **Step 5: Commit.**

```bash
git add src/sidepanel/QCFeeWaiverWorkflow.tsx
git commit -m "feat(qc-fee-waiver): implement Step 2 Newly Eligible inputs"
```

---

## Task 7: Implement `tryDateRangeScrape` in i2c.ts

Replace the stub with the actual scrape logic: set the date dropdown to Date Range, fill From/To with a 14-month window, click Search, scrape distinct month-year values from the Trans. Date column, write back to `chrome.storage.local`.

**Files:**
- Modify: `extension/src/content/i2c.ts`

- [ ] **Step 1: Replace the stub `tryDateRangeScrape`.**

Find the stub (`// ----- qc_month_scrape only…`). Replace the function body:

```ts
let dateRangeScrapeRan = false;
let dateRangeAppliedAt = 0; // when we last clicked Search via this flow
async function tryDateRangeScrape(): Promise<boolean> {
  if (dateRangeScrapeRan) return true;
  if ((await getFlow()) !== 'qc_month_scrape') return false;
  if (!(await chainActive())) return false;

  // Need to be on Account Transactions (the existing tryAccountTransactions step gets us
  // here for this flow — added in Task 1's gating change).
  const body = document.body?.textContent || '';
  if (!/Below is the list of transaction/i.test(body)) return false;

  // Phase 1: switch dropdown to Date Range + fill From/To + click Search. If we haven't
  // applied the Date Range yet this content-script instance, do that.
  if (!dateRangeAppliedAt) {
    const selects = Array.from(document.querySelectorAll<HTMLSelectElement>('select'));
    let target: HTMLSelectElement | null = null;
    let drOption: HTMLOptionElement | null = null;
    for (const s of selects) {
      if (!isVisible(s)) continue;
      const opt = Array.from(s.options).find((o) => /^Date\s*Range$/i.test((o.textContent || '').trim()));
      if (opt) { target = s; drOption = opt; break; }
    }
    if (!target || !drOption) return false;
    if (target.value !== drOption.value) {
      log('  → selecting Date Range option');
      target.focus();
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
      setter?.call(target, drOption.value);
      for (const o of Array.from(target.options)) o.selected = (o === drOption);
      target.dispatchEvent(new Event('input', { bubbles: true }));
      target.dispatchEvent(new Event('change', { bubbles: true }));
      target.blur();
      await sleep(300);
    }

    // Fill From + To inputs. Span = ~14 months back from today.
    const now = new Date(2026, 5, 12); // anchored to "today" — for determinism we use the
                                       // current real date at runtime instead. See note below.
    void now;
    const today = new Date();
    const fromDate = new Date(today.getFullYear(), today.getMonth() - 14, today.getDate());
    const fromStr = formatMmDdYyyy(fromDate);
    const toStr = formatMmDdYyyy(today);

    const fromInput = findInputByLabel(/^From/i);
    const toInput = findInputByLabel(/^To/i);
    if (!fromInput || !toInput) { log('  → From/To inputs not found yet'); return false; }
    setInputValue(fromInput, fromStr);
    setInputValue(toInput, toStr);
    log('  → set Date Range', fromStr, '→', toStr);

    // Click Search inside the search-transaction form.
    const searchBtn = Array.from(document.querySelectorAll<HTMLElement>('input[type="submit"], input[type="button"], button'))
      .find((b) => /^Search$/i.test(((b as HTMLInputElement).value || b.textContent || '').trim()) && isVisible(b));
    if (!searchBtn) return false;
    searchBtn.click();
    dateRangeAppliedAt = Date.now();
    return false; // wait until table reloads before scraping
  }

  // Phase 2: after the search results render, scrape Trans. Date values.
  if (Date.now() - dateRangeAppliedAt < 600) return false; // brief settle

  const tables = Array.from(document.querySelectorAll('table'));
  for (const table of tables) {
    const allCells = Array.from(table.querySelectorAll<HTMLTableCellElement>('th, td'));
    const dateHeader = allCells.find((c) => /^\s*Trans\.?\s*Date\s*$/i.test((c.textContent || '').trim()));
    if (!dateHeader) continue;

    const dateLeft = dateHeader.getBoundingClientRect().left;
    const headerRow = dateHeader.closest('tr');
    const allRows = Array.from(table.querySelectorAll<HTMLTableRowElement>('tr'));
    const dataRows = allRows.filter((r) => r !== headerRow && r.querySelectorAll(':scope > td, :scope > th').length > 1);
    if (dataRows.length === 0) continue;

    const months = new Set<string>();
    for (const row of dataRows) {
      const cells = Array.from(row.querySelectorAll<HTMLTableCellElement>(':scope > td, :scope > th'));
      let best: HTMLTableCellElement | null = null;
      let bestDelta = Infinity;
      for (const c of cells) {
        const left = c.getBoundingClientRect().left;
        const delta = Math.abs(left - dateLeft);
        if (delta < bestDelta && delta < 40) { bestDelta = delta; best = c; }
      }
      const txt = (best?.textContent || '').trim();
      const m = txt.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
      if (m) months.add(`${m[3]}-${m[1].padStart(2, '0')}`);
    }

    if (months.size === 0) continue;

    const breakdown = Array.from(months).sort();
    const ctx = await chrome.storage.local.get('pending_i2c_source_ticket_id');
    const sourceTicketId = typeof ctx.pending_i2c_source_ticket_id === 'string' ? ctx.pending_i2c_source_ticket_id : '';

    log('  → captured', months.size, 'distinct months:', breakdown);
    await chrome.storage.local.set({
      qc_month_scrape_result: {
        sourceTicketId,
        monthsUsed: months.size,
        monthsBreakdown: breakdown,
        capturedAt: new Date().toISOString(),
      },
    });
    dateRangeScrapeRan = true;
    await clearAllPendingKeys();
    return true;
  }
  return false;
}

function formatMmDdYyyy(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${mm}/${dd}/${d.getFullYear()}`;
}

function findInputByLabel(labelRe: RegExp): HTMLInputElement | null {
  const labelEls = Array.from(document.querySelectorAll<HTMLElement>('td, th, label, div, span'));
  for (const el of labelEls) {
    const t = (el.textContent || '').trim();
    if (!labelRe.test(t)) continue;
    const row = el.closest('tr');
    let input: HTMLInputElement | null = null;
    if (row) input = row.querySelector<HTMLInputElement>('input[type="text"], input[type="date"], input:not([type])');
    if (!input) input = el.parentElement?.querySelector<HTMLInputElement>('input[type="text"], input[type="date"], input:not([type])') || null;
    if (input && isVisible(input) && input.type !== 'password') return input;
  }
  return null;
}

function setInputValue(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}
```

> Note: `findInputByLabel` may already be defined in the file from a prior flow (Admin Debit). If TypeScript complains about a duplicate, remove the new declaration here and reuse the existing one.

- [ ] **Step 2: Verify build.**

```bash
npm run build
```

Expected: `✓ built`. If you get a duplicate-`findInputByLabel` error, delete the local copy above and rely on the existing one.

- [ ] **Step 3: Smoke test end-to-end.**

Reload `dist/`. From the QC Fee Waiver workflow:
1. Pick Cancellation.
2. In Step 2, click **↗ Scrape from i2c**. A new tab opens to i2c login.
3. The chain signs in → kills sessions → searches by email → Continue → Account Transactions → applies Date Range with the wide window → clicks Search → scrapes.
4. Console (i2c frame) should log `→ captured N distinct months: [...]`.
5. Back in the side panel, the months-used input populates with the count, and the breakdown chips show below.

If anything misses, check the `[wocoo-i2c]` log lines — the function logs each phase.

- [ ] **Step 4: Commit.**

```bash
git add src/content/i2c.ts
git commit -m "feat(i2c): implement qc_month_scrape Date-Range scrape"
```

---

## Task 8: Implement Step 3 — Refund calculation

Auto-compute refund from Step 2 inputs and the scenario. Show the formula breakdown. Allow override.

**Files:**
- Modify: `extension/src/sidepanel/QCFeeWaiverWorkflow.tsx`

- [ ] **Step 1: Add state for the (possibly-overridden) refund amount.**

Below the existing state declarations:

```tsx
const [refundOverride, setRefundOverride] = useState<string>(''); // empty means use computed
```

- [ ] **Step 2: Compute the refund value.**

Inside `QCFeeWaiverWorkflow`, before `renderBody`:

```tsx
function computedRefund(): number | null {
  if (scenario === 'cancellation') {
    const m = parseInt(monthsUsedInput, 10);
    if (!isFinite(m) || m < 0) return null;
    return Math.max(0, 220 - 20 * m);
  }
  if (scenario === 'newly_eligible') {
    const left = computeMonthsLeft(anniversaryMonth, eligibilityFlipMonth);
    if (left == null || left <= 0) return null;
    return 20 * left;
  }
  return null;
}
const computed = computedRefund();
const effectiveRefund = (() => {
  const ov = parseFloat(refundOverride);
  if (isFinite(ov) && ov >= 0) return ov;
  return computed;
})();
```

- [ ] **Step 3: Write `Step3Body`.**

```tsx
function Step3Body({ scenario, computed, refundOverride, setRefundOverride, monthsUsedInput, monthsLeft, showAction, onContinue }: {
  scenario: Scenario | null;
  computed: number | null;
  refundOverride: string;
  setRefundOverride: (v: string) => void;
  monthsUsedInput: string;
  monthsLeft: number | null;
  showAction: boolean;
  onContinue: () => void;
}) {
  const ov = parseFloat(refundOverride);
  const effective = isFinite(ov) && ov >= 0 ? ov : computed;
  const formula = (() => {
    if (scenario === 'cancellation') {
      const m = parseInt(monthsUsedInput, 10) || 0;
      return `$220 − ($20 × ${m}) = $${(220 - 20 * m).toFixed(2)}`;
    }
    if (scenario === 'newly_eligible' && monthsLeft != null) {
      return `$20 × ${monthsLeft} = $${(20 * monthsLeft).toFixed(2)}`;
    }
    return '—';
  })();
  return (
    <>
      <div style={{ padding: 'var(--mint-sp-3)', background: 'var(--mint-bg-subtle)', border: 'var(--mint-card-stroke)', borderRadius: 'var(--mint-radius-card)', marginBottom: 'var(--mint-sp-3)' }}>
        <div style={{ fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-soft)', fontWeight: 700, marginBottom: 4 }}>FORMULA</div>
        <div style={{ fontSize: 'var(--mint-text-meta)', fontFamily: 'var(--mint-font-mono)', color: 'var(--mint-fg-strong)' }}>{formula}</div>
      </div>

      <div style={fieldLabel}>Refund amount (CA$)</div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <span>$</span>
        <input
          type="number" step="0.01"
          value={refundOverride !== '' ? refundOverride : (computed != null ? computed.toFixed(2) : '')}
          onChange={(e) => setRefundOverride(e.target.value)}
          style={{ flex: 1, padding: '6px 10px', fontFamily: 'var(--mint-font-mono)', fontSize: 'var(--mint-text-micro)', border: 'var(--mint-card-stroke)', borderRadius: 'var(--mint-radius-button)', background: 'var(--mint-bg-card)', color: 'var(--mint-fg-strong)', boxSizing: 'border-box' }}
        />
      </div>
      <div style={{ marginTop: 4, fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-soft)' }}>
        Override only if you've reviewed the policy and need a different amount.
      </div>

      {showAction ? (
        <div style={{ marginTop: 'var(--mint-sp-3)' }}>
          <button onClick={onContinue} disabled={effective == null || effective <= 0} style={{ ...primaryButton, width: '100%', opacity: effective != null && effective > 0 ? 1 : 0.55, cursor: effective != null && effective > 0 ? 'pointer' : 'not-allowed' }}>
            Continue →
          </button>
        </div>
      ) : null}
    </>
  );
}
```

- [ ] **Step 4: Wire Step 3 into `renderBody`.**

Add this branch:

```tsx
if (n === 3) return (
  <Step3Body
    scenario={scenario}
    computed={computed}
    refundOverride={refundOverride}
    setRefundOverride={setRefundOverride}
    monthsUsedInput={monthsUsedInput}
    monthsLeft={computeMonthsLeft(anniversaryMonth, eligibilityFlipMonth)}
    showAction={onCurrentStep}
    onContinue={() => setStep(4)}
  />
);
```

- [ ] **Step 5: Verify build + smoke test.**

```bash
npm run build
```

Reload `dist/`. Run through the workflow:
- Cancellation + monthsUsed=2 → formula shows `$220 − ($20 × 2) = $180.00`, refund input pre-fills with `180.00`.
- Newly Eligible + monthsLeft=6 → formula shows `$20 × 6 = $120.00`, refund input `120.00`.
- Override → typing in the input replaces the computed value.

- [ ] **Step 6: Commit.**

```bash
git add src/sidepanel/QCFeeWaiverWorkflow.tsx
git commit -m "feat(qc-fee-waiver): implement Step 3 refund calculation"
```

---

## Task 9: Implement Step 4 — Apply Credit launcher

Step 4 stages the `apply_credit` flow keys + opens i2c. The actual form-fill lands in Task 10 (i2c content script). The "✓ Credit Applied" button advances locally.

**Files:**
- Modify: `extension/src/sidepanel/QCFeeWaiverWorkflow.tsx`

- [ ] **Step 1: Add `creditAppliedRan` state to track completion.**

```tsx
const [creditAppliedRan, setCreditAppliedRan] = useState<boolean>(false);
```

- [ ] **Step 2: Stage the apply_credit flow.**

After the existing `scrapeFromI2c` definition:

```tsx
const applyCredit = () => {
  if (!ticket.clientEmail || effectiveRefund == null) return;
  void chrome.storage.local.set({
    pending_i2c_email: ticket.clientEmail,
    pending_i2c_flow: 'apply_credit',
    pending_i2c_ticket_url: `https://wealthsimple.atlassian.net/browse/${ticket.id}`,
    pending_i2c_admin_credit_amount: effectiveRefund.toFixed(2),
    pending_i2c_started_at: Date.now(),
  });
  void chrome.storage.local.remove(['pending_i2c_admin_debit_amount']);
  window.open(I2C_LOGIN_URL, '_blank', 'noopener,noreferrer');
};
```

- [ ] **Step 3: Write `Step4Body`.**

```tsx
function Step4Body({ refund, applyCredit, alreadyDone, disabled, showAction, onConfirm }: { refund: number | null; applyCredit: () => void; alreadyDone: boolean; disabled: boolean; showAction: boolean; onConfirm: () => void }) {
  return (
    <>
      <div style={{ fontSize: 'var(--mint-text-meta)', color: 'var(--mint-fg-strong)', lineHeight: 1.5, marginBottom: 'var(--mint-sp-3)' }}>
        <ol style={{ paddingLeft: '1.2em', margin: 0 }}>
          <li>Click <strong>Apply Admin Credit</strong> below — i2c opens with the form pre-filled.</li>
          <li>Service: <strong>Admin Funds Credit</strong>, Amount: <strong>${refund != null ? refund.toFixed(2) : '—'}</strong>, Comments: <strong>this ticket URL</strong>.</li>
          <li>Review and click <strong>Apply</strong> on the i2c page to submit.</li>
        </ol>
      </div>

      <button onClick={applyCredit} disabled={disabled} style={{
        padding: '8px 16px',
        background: 'var(--mint-warning-bg-soft)',
        color: 'var(--mint-warning-fg-strong)',
        border: '1px solid var(--mint-warning-fg-graphic)',
        borderRadius: 'var(--mint-radius-button)',
        fontSize: 'var(--mint-text-meta)',
        fontWeight: 700,
        width: '100%',
        textAlign: 'center',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.6 : 1,
      }}>↗ Apply Admin Credit ({refund != null ? '$' + refund.toFixed(2) : '—'})</button>

      {showAction && !alreadyDone ? (
        <div style={{ marginTop: 'var(--mint-sp-2)' }}>
          <button onClick={onConfirm} style={{ ...primaryButton, width: '100%' }}>✓ Credit Applied</button>
        </div>
      ) : alreadyDone ? (
        <div style={{ marginTop: 'var(--mint-sp-2)', fontSize: 'var(--mint-text-micro)', color: 'var(--mint-positive-fg-strong)' }}>✓ Confirmed.</div>
      ) : null}
    </>
  );
}
```

- [ ] **Step 4: Wire Step 4 into `renderBody`.**

```tsx
if (n === 4) return (
  <Step4Body
    refund={effectiveRefund}
    applyCredit={applyCredit}
    alreadyDone={creditAppliedRan}
    disabled={!ticket.clientEmail || effectiveRefund == null || effectiveRefund <= 0}
    showAction={onCurrentStep}
    onConfirm={() => { setCreditAppliedRan(true); setStep(scenario === 'cancellation' && clientPaidAnnualFee ? 5 : 6); }}
  />
);
```

- [ ] **Step 5: Verify build + smoke test.**

```bash
npm run build
```

Reload `dist/`. From Step 4:
- Apply Admin Credit button reads `↗ Apply Admin Credit ($180.00)` (or whatever refund).
- Clicking it opens i2c (with `tryFillApplyCredit stub fired` in console — Task 10 implements the actual fill).
- Clicking ✓ Credit Applied advances:
  - Cancellation + paid=true → Step 5.
  - Cancellation + paid=false → Step 6.
  - Newly Eligible → Step 6.

- [ ] **Step 6: Commit.**

```bash
git add src/sidepanel/QCFeeWaiverWorkflow.tsx
git commit -m "feat(qc-fee-waiver): implement Step 4 Apply Credit launcher"
```

---

## Task 10: Implement `tryFillApplyCredit` in i2c.ts

Replace the stub with the form-fill logic. Selects the "Admin Funds Credit" Service option, fills the Amount input, pastes the ticket URL into Comments.

**Files:**
- Modify: `extension/src/content/i2c.ts`

- [ ] **Step 1: Replace the stub `tryFillApplyCredit`.**

Find the stub. Replace with:

```ts
let applyCreditFilledRan = false;
async function tryFillApplyCredit(): Promise<boolean> {
  if (applyCreditFilledRan) return true;
  if ((await getFlow()) !== 'apply_credit') return false;
  const body = document.body?.textContent || '';
  if (!/Apply desired service to the card account/i.test(body)) return false;

  const ctx = await chrome.storage.local.get(['pending_i2c_admin_credit_amount', 'pending_i2c_ticket_url']);
  const amountText = typeof ctx.pending_i2c_admin_credit_amount === 'string' ? ctx.pending_i2c_admin_credit_amount : '';
  const ticketUrl = typeof ctx.pending_i2c_ticket_url === 'string' ? ctx.pending_i2c_ticket_url : '';
  if (!amountText || !ticketUrl) { log('  → apply_credit context missing'); return false; }

  // Find the Service select with an "Admin Funds Credit" option. If the actual label
  // differs in your i2c instance, adjust the regex below.
  const selects = Array.from(document.querySelectorAll<HTMLSelectElement>('select'));
  let serviceSelect: HTMLSelectElement | null = null;
  let targetOpt: HTMLOptionElement | null = null;
  for (const s of selects) {
    if (!isVisible(s)) continue;
    const opt = Array.from(s.options).find((o) => /^Admin\s*Funds?\s*Credit$/i.test((o.textContent || '').trim()));
    if (opt) { serviceSelect = s; targetOpt = opt; break; }
  }
  if (!serviceSelect || !targetOpt) { log('  → Admin Funds Credit option not found yet'); return false; }

  if (serviceSelect.value !== targetOpt.value) {
    log('  → selecting Admin Funds Credit');
    serviceSelect.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
    setter?.call(serviceSelect, targetOpt.value);
    for (const o of Array.from(serviceSelect.options)) o.selected = (o === targetOpt);
    serviceSelect.dispatchEvent(new Event('input', { bubbles: true }));
    serviceSelect.dispatchEvent(new Event('change', { bubbles: true }));
    serviceSelect.blur();
    await sleep(250);
  }

  const amountInput = findInputByLabelText(/^Amount/i);
  if (amountInput && amountInput.value !== amountText) {
    log('  → filling Amount:', amountText);
    setValue(amountInput, amountText);
  }

  const commentsArea = findTextareaByLabelText(/^Comments/i);
  if (commentsArea && commentsArea.value !== ticketUrl) {
    log('  → filling Comments with ticket URL');
    setTextareaValue(commentsArea, ticketUrl);
  }

  if (amountInput && commentsArea) {
    applyCreditFilledRan = true;
    await clearAllPendingKeys();
    return true;
  }
  return false;
}
```

> `findInputByLabelText` / `findTextareaByLabelText` / `setTextareaValue` / `setValue` are existing helpers in the file (used by `tryFillAdminDebit`). Reuse them — don't redeclare.

- [ ] **Step 2: Verify build.**

```bash
npm run build
```

Expected: `✓ built`. If you get a duplicate-declaration error, the helpers above already exist; remove any redeclaration.

- [ ] **Step 3: Smoke test end-to-end with the workflow.**

Reload `dist/`. Run the workflow through to Step 4 with a non-zero refund. Click Apply Admin Credit. In the i2c tab:
- Sign in (autofill) → kill session if any → email search → Continue with this Customer → click Administrative Services sidebar.
- On the Admin Services page: Service dropdown switches to "Admin Funds Credit", Amount fills with the refund value, Comments fills with the ticket URL.
- Console logs the steps via `[wocoo-i2c]`.

> If the live i2c dropdown labels its credit option something other than "Admin Funds Credit", check the i2c tab's Service dropdown manually, grab the exact label, and tighten the regex `/^Admin\s*Funds?\s*Credit$/i` in the function above to match.

- [ ] **Step 4: Commit.**

```bash
git add src/content/i2c.ts
git commit -m "feat(i2c): implement apply_credit form-fill"
```

---

## Task 11: Implement Step 5 — REIMB ticket creation

Only visible when scenario = Cancellation AND clientPaidAnnualFee = true. Auto-create a REIMB via the existing `createReimbTicket` helper, show the resulting REIMB key + URL.

**Files:**
- Modify: `extension/src/sidepanel/QCFeeWaiverWorkflow.tsx`

- [ ] **Step 1: Import `createReimbTicket`.**

Add to the imports:

```ts
import { createReimbTicket, REIMB_APPROVERS } from '../api/jira';
```

- [ ] **Step 2: Add state for the REIMB result + busy/error flags.**

```tsx
const [reimbKey, setReimbKey] = useState<string | null>(null);
const [reimbUrl, setReimbUrl] = useState<string | null>(null);
const [busy, setBusy] = useState(false);
const [error, setError] = useState<string | null>(null);
```

- [ ] **Step 3: Add `doCreateReimb`.**

```tsx
async function doCreateReimb() {
  if (!ticket.identityId) { setError('Source ticket is missing Identity ID.'); return; }
  if (!ticket.accountId) { setError('Source ticket is missing Account ID.'); return; }
  if (effectiveRefund == null || effectiveRefund <= 0) { setError('Refund amount is not set.'); return; }
  setBusy(true);
  setError(null);
  try {
    const approverKey: keyof typeof REIMB_APPROVERS = effectiveRefund >= 5000 ? 'amanda' : 'luke';
    const result = await createReimbTicket({
      wocooTicketId: ticket.id,
      identityId: ticket.identityId,
      amount: effectiveRefund,
      accountId: ticket.accountId,
      approver: approverKey,
      tier: ticket.tier,
    });
    setReimbKey(result.key);
    setReimbUrl(result.url);
    setStep(6);
  } catch (e: any) {
    setError(e?.message || String(e));
  } finally {
    setBusy(false);
  }
}
```

- [ ] **Step 4: Write `Step5Body`.**

```tsx
function Step5Body({ refund, reimbKey, reimbUrl, busy, error, showAction, onCreate }: { refund: number | null; reimbKey: string | null; reimbUrl: string | null; busy: boolean; error: string | null; showAction: boolean; onCreate: () => void }) {
  return (
    <>
      <div style={{ fontSize: 'var(--mint-text-meta)', color: 'var(--mint-fg-strong)', lineHeight: 1.5, marginBottom: 'var(--mint-sp-3)' }}>
        Submitting a REIMB ticket to transfer <strong>${refund != null ? refund.toFixed(2) : '—'}</strong> from the credit card to the client's chequing account.
      </div>

      {reimbKey && reimbUrl ? (
        <div style={{ padding: '6px 10px', background: 'var(--mint-positive-bg-soft)', border: '1px solid var(--mint-positive-fg-graphic)', borderRadius: 'var(--mint-radius-button)', fontSize: 'var(--mint-text-micro)' }}>
          ✓ Created: <a href={reimbUrl} target="_blank" rel="noreferrer" style={{ color: 'var(--mint-positive-fg-strong)', fontWeight: 700 }}>{reimbKey}</a>
        </div>
      ) : null}

      {error ? (
        <div style={{ padding: '6px 10px', background: 'var(--mint-negative-bg-soft)', color: 'var(--mint-negative-fg-strong)', fontSize: 'var(--mint-text-micro)', borderRadius: 'var(--mint-radius-button)' }}>⚠ {error}</div>
      ) : null}

      {showAction && !reimbKey ? (
        <div style={{ marginTop: 'var(--mint-sp-3)' }}>
          <button onClick={onCreate} disabled={busy || refund == null || refund <= 0} style={{ ...primaryButton, width: '100%', opacity: busy ? 0.6 : 1, cursor: busy ? 'wait' : 'pointer' }}>
            {busy ? 'Creating…' : '✓ Create REIMB ticket'}
          </button>
        </div>
      ) : null}
    </>
  );
}
```

- [ ] **Step 5: Wire Step 5 into `renderBody`.**

```tsx
if (n === 5) return (
  <Step5Body
    refund={effectiveRefund}
    reimbKey={reimbKey}
    reimbUrl={reimbUrl}
    busy={busy}
    error={error}
    showAction={onCurrentStep}
    onCreate={doCreateReimb}
  />
);
```

- [ ] **Step 6: Verify build + smoke test.**

```bash
npm run build
```

Reload `dist/`. Run the workflow with scenario=Cancellation + paid=true to Step 5. Click Create REIMB ticket. Confirm:
- "Creating…" spinner shows briefly.
- On success, the REIMB key appears as a Jira link.
- Workflow advances to Step 6.

For a quick failure-path test, force an error (e.g., temporarily edit `ticket.identityId` to null in the React Devtools) — confirm the red error banner appears and the workflow stays on Step 5.

- [ ] **Step 7: Commit.**

```bash
git add src/sidepanel/QCFeeWaiverWorkflow.tsx
git commit -m "feat(qc-fee-waiver): implement Step 5 REIMB ticket creation"
```

---

## Task 12: Implement Step 6 — Post comment

Templated comment, editable, posted via the existing `postComment` ADF API. Different template per scenario.

**Files:**
- Modify: `extension/src/sidepanel/QCFeeWaiverWorkflow.tsx`

- [ ] **Step 1: Import `postComment`.**

Add to the imports:

```ts
import { postComment, createReimbTicket, REIMB_APPROVERS } from '../api/jira';
```

(Add `postComment` to the existing import line from Task 11.)

- [ ] **Step 2: Add comment state.**

```tsx
const [commentText, setCommentText] = useState<string>('');
const [commentEditing, setCommentEditing] = useState<boolean>(false);
const [commentPosted, setCommentPosted] = useState<boolean>(false);
```

- [ ] **Step 3: Add a `useEffect` to pre-fill the template when Step 6 becomes active.**

```tsx
useEffect(() => {
  if (step !== 6 || commentText) return;
  const mention = ticket.reporter ? '@' + ticket.reporter : 'team';
  if (scenario === 'cancellation') {
    const monthsUsed = parseInt(monthsUsedInput, 10) || 0;
    const reimbLine = reimbKey ? `\nREIMB ticket ${reimbKey} created to transfer the refund to the chequing account.` : '';
    setCommentText(
      `Hi ${mention}, the client's annual fee has been prorated based on ${monthsUsed} months of card usage. ` +
      `Refund: $220 − ($20 × ${monthsUsed}) = $${(effectiveRefund || 0).toFixed(2)}. Admin Credit applied in i2c.` +
      reimbLine +
      `\nYou can proceed with account closure.`
    );
  } else if (scenario === 'newly_eligible') {
    const left = computeMonthsLeft(anniversaryMonth, eligibilityFlipMonth) || 0;
    setCommentText(
      `Hi ${mention}, the client became fee-waiver eligible in ${eligibilityFlipMonth} (${left} months remaining until their card anniversary). ` +
      `Refund: $20 × ${left} = $${(effectiveRefund || 0).toFixed(2)}. Admin Credit applied in i2c.`
    );
  }
}, [step, scenario, commentText, ticket.reporter, monthsUsedInput, reimbKey, effectiveRefund, anniversaryMonth, eligibilityFlipMonth]);
```

- [ ] **Step 4: Add `doPostComment`.**

```tsx
async function doPostComment() {
  if (!commentText.trim()) { setError('Comment is empty.'); return; }
  setBusy(true);
  setError(null);
  try {
    const segments = buildCommentSegments(ticket, commentText, reimbKey, reimbUrl);
    await postComment(ticket.id, segments);
    setCommentPosted(true);
    setStep(7);
  } catch (e: any) {
    setError(e?.message || String(e));
  } finally {
    setBusy(false);
  }
}

function buildCommentSegments(t: WocooTicket, text: string, reimbKey: string | null, reimbUrl: string | null) {
  const segments: Array<{ type: 'text' | 'mention' | 'link'; text: string; accountId?: string; href?: string }> = [];
  let working = text;
  if (t.reporter && t.reporterAccountId) {
    const mention = '@' + t.reporter;
    const i = working.indexOf(mention);
    if (i !== -1) {
      if (i > 0) segments.push({ type: 'text', text: working.slice(0, i) });
      segments.push({ type: 'mention', text: mention, accountId: t.reporterAccountId });
      working = working.slice(i + mention.length);
    }
  }
  if (reimbKey && reimbUrl) {
    const i = working.indexOf(reimbKey);
    if (i !== -1) {
      if (i > 0) segments.push({ type: 'text', text: working.slice(0, i) });
      segments.push({ type: 'link', text: reimbKey, href: reimbUrl });
      working = working.slice(i + reimbKey.length);
    }
  }
  if (working) segments.push({ type: 'text', text: working });
  return segments;
}
```

- [ ] **Step 5: Write `Step6Body`.**

```tsx
function Step6Body({ commentText, setCommentText, commentEditing, setCommentEditing, busy, alreadyPosted, showAction, onPost, ticket, reimbKey }: { commentText: string; setCommentText: (v: string) => void; commentEditing: boolean; setCommentEditing: (v: boolean) => void; busy: boolean; alreadyPosted: boolean; showAction: boolean; onPost: () => void; ticket: WocooTicket; reimbKey: string | null }) {
  return (
    <>
      {commentEditing ? (
        <textarea value={commentText} onChange={(e) => setCommentText(e.target.value)} rows={8} style={{ width: '100%', padding: 'var(--mint-sp-2)', fontFamily: 'var(--mint-font-family)', fontSize: 'var(--mint-text-meta)', border: 'var(--mint-card-stroke)', borderRadius: 'var(--mint-radius-button)', background: 'var(--mint-bg-card)', boxSizing: 'border-box', lineHeight: 1.5 }} />
      ) : (
        <div style={{ padding: 'var(--mint-sp-3)', background: 'var(--mint-bg-subtle)', border: 'var(--mint-card-stroke)', borderRadius: 'var(--mint-radius-card)', fontSize: 'var(--mint-text-meta)', lineHeight: 1.6, color: 'var(--mint-fg-strong)', whiteSpace: 'pre-wrap' }}>
          <CommentPreview text={commentText} reporter={ticket.reporter} reimbKey={reimbKey} />
        </div>
      )}
      {showAction && !alreadyPosted ? (
        <div style={{ marginTop: 'var(--mint-sp-2)', display: 'flex', gap: 'var(--mint-sp-2)' }}>
          <button onClick={() => setCommentEditing(!commentEditing)} style={{ padding: '10px 16px', borderRadius: 'var(--mint-radius-button)', fontWeight: 600, fontSize: 'var(--mint-text-meta)', border: 'var(--mint-card-stroke)', background: 'var(--mint-bg-card)', color: 'var(--mint-fg-strong)', cursor: 'pointer' }}>
            {commentEditing ? '✓ Done editing' : '✏ Edit'}
          </button>
          <button onClick={onPost} disabled={busy} style={{ ...primaryButton, flex: 1, opacity: busy ? 0.6 : 1, cursor: busy ? 'wait' : 'pointer' }}>
            {busy ? 'Posting…' : 'Post comment'}
          </button>
        </div>
      ) : alreadyPosted ? (
        <div style={{ marginTop: 'var(--mint-sp-2)', fontSize: 'var(--mint-text-micro)', color: 'var(--mint-positive-fg-strong)' }}>✓ Posted.</div>
      ) : null}
    </>
  );
}

function CommentPreview({ text, reporter, reimbKey }: { text: string; reporter: string; reimbKey: string | null }) {
  const parts: React.ReactNode[] = [];
  let working = text || '';
  let key = 0;
  if (reporter) {
    const mention = '@' + reporter;
    const i = working.indexOf(mention);
    if (i !== -1) {
      if (i > 0) parts.push(<span key={key++}>{working.slice(0, i)}</span>);
      parts.push(<span key={key++} style={{ background: 'var(--mint-highlight-bg-soft)', color: 'var(--mint-highlight-fg-strong)', padding: '0 4px', borderRadius: 4, fontWeight: 600 }}>{mention}</span>);
      working = working.slice(i + mention.length);
    }
  }
  if (reimbKey) {
    const i = working.indexOf(reimbKey);
    if (i !== -1) {
      if (i > 0) parts.push(<span key={key++}>{working.slice(0, i)}</span>);
      parts.push(<span key={key++} style={{ color: 'var(--mint-highlight-fg-strong)', fontWeight: 600 }}>[{reimbKey}]</span>);
      working = working.slice(i + reimbKey.length);
    }
  }
  if (working) parts.push(<span key={key++}>{working}</span>);
  return <>{parts}</>;
}
```

- [ ] **Step 6: Wire Step 6 into `renderBody`.**

```tsx
if (n === 6) return (
  <Step6Body
    commentText={commentText}
    setCommentText={setCommentText}
    commentEditing={commentEditing}
    setCommentEditing={setCommentEditing}
    busy={busy}
    alreadyPosted={commentPosted}
    showAction={onCurrentStep}
    onPost={doPostComment}
    ticket={ticket}
    reimbKey={reimbKey}
  />
);
```

- [ ] **Step 7: Verify build + smoke test.**

```bash
npm run build
```

Reload `dist/`. Run the workflow through Step 6:
- Templated comment pre-fills correctly for both scenarios.
- @reporter mention renders in highlight color in the preview.
- REIMB key (if any) renders bracketed.
- Edit button toggles to textarea, Done editing toggles back to preview.
- Post button calls Jira and on success advances to Step 7.

- [ ] **Step 8: Commit.**

```bash
git add src/sidepanel/QCFeeWaiverWorkflow.tsx
git commit -m "feat(qc-fee-waiver): implement Step 6 templated comment"
```

---

## Task 13: Implement Step 7 — Move to Done

Reuses the existing `transitionTicket(ticketId, '251')`. Standard pattern from the other workflows.

**Files:**
- Modify: `extension/src/sidepanel/QCFeeWaiverWorkflow.tsx`

- [ ] **Step 1: Add `transitionTicket` to imports.**

```ts
import { createReimbTicket, postComment, transitionTicket, REIMB_APPROVERS } from '../api/jira';
```

- [ ] **Step 2: Define the transition constant + handler.**

Near the top of the file with the other constants:

```ts
const TRANSITION_TO_DONE_ID = '251';
```

Inside `QCFeeWaiverWorkflow`:

```tsx
const [transitionedToDone, setTransitionedToDone] = useState(false);

async function doTransitionDone() {
  setBusy(true);
  setError(null);
  try {
    await transitionTicket(ticket.id, TRANSITION_TO_DONE_ID);
    onTicketUpdate({ ...ticket, status: 'Done' });
    setTransitionedToDone(true);
    setStep(8);
  } catch (e: any) {
    setError(e?.message || String(e));
  } finally {
    setBusy(false);
  }
}
```

- [ ] **Step 3: Write `Step7Body`.**

```tsx
function Step7Body({ ticketId, busy, alreadyDone, showAction, onMove }: { ticketId: string; busy: boolean; alreadyDone: boolean; showAction: boolean; onMove: () => void }) {
  return (
    <>
      <div style={{ fontSize: 'var(--mint-text-meta)', color: 'var(--mint-fg-subdued-title)', lineHeight: 1.6, marginBottom: 'var(--mint-sp-3)' }}>
        All steps complete. Move <strong>{ticketId}</strong> to Done.
      </div>
      {showAction && !alreadyDone ? (
        <button onClick={onMove} disabled={busy} style={{ ...primaryButton, width: '100%', opacity: busy ? 0.6 : 1, cursor: busy ? 'wait' : 'pointer' }}>
          {busy ? 'Moving…' : '✓ Move to Done'}
        </button>
      ) : alreadyDone ? (
        <div style={{ fontSize: 'var(--mint-text-micro)', color: 'var(--mint-positive-fg-strong)' }}>✓ Transitioned.</div>
      ) : null}
    </>
  );
}
```

- [ ] **Step 4: Wire Step 7 into `renderBody`.**

```tsx
if (n === 7) return (
  <Step7Body
    ticketId={ticket.id}
    busy={busy}
    alreadyDone={transitionedToDone}
    showAction={onCurrentStep}
    onMove={doTransitionDone}
  />
);
```

- [ ] **Step 5: Verify build + smoke test.**

```bash
npm run build
```

Reload `dist/`. Run the workflow to Step 7. Click Move to Done. Confirm:
- Spinner briefly shows.
- On success, advances to Step 8.
- Verify in Jira that the ticket transitioned to Done.

- [ ] **Step 6: Commit.**

```bash
git add src/sidepanel/QCFeeWaiverWorkflow.tsx
git commit -m "feat(qc-fee-waiver): implement Step 7 Move to Done"
```

---

## Task 14: Implement Step 8 — Success panel

Green confirmation card summarizing what happened. Close button returns to the ticket view.

**Files:**
- Modify: `extension/src/sidepanel/QCFeeWaiverWorkflow.tsx`

- [ ] **Step 1: Write `SuccessPanel`.**

```tsx
function SuccessPanel({ ticketId, refund, reimbKey, reimbUrl, onCloseToTicket }: { ticketId: string; refund: number | null; reimbKey: string | null; reimbUrl: string | null; onCloseToTicket: () => void }) {
  return (
    <section style={{ background: 'var(--mint-positive-bg-soft)', border: '1px solid var(--mint-positive-fg-graphic)', borderRadius: 'var(--mint-radius-card)', padding: 'var(--mint-sp-4)', textAlign: 'center' }}>
      <div style={{ width: 48, height: 48, margin: '0 auto var(--mint-sp-2)', borderRadius: 9999, background: 'var(--mint-positive-fg-graphic)', color: '#fff', fontSize: 24, fontWeight: 800, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>✓</div>
      <h3 style={{ margin: 0, fontSize: 'var(--mint-text-h-md)', color: 'var(--mint-fg-strong)', fontWeight: 700 }}>QC Fee Waiver complete</h3>
      <p style={{ margin: 'var(--mint-sp-2) 0 var(--mint-sp-3)', fontSize: 'var(--mint-text-meta)', color: 'var(--mint-fg-subdued-title)', lineHeight: 1.6 }}>
        ${refund != null ? refund.toFixed(2) : '—'} credit applied{reimbKey && reimbUrl ? <> · <a href={reimbUrl} target="_blank" rel="noreferrer" style={{ color: 'var(--mint-fg-strong)', fontWeight: 600 }}>{reimbKey}</a></> : null} · Comment posted · Moved to Done
      </p>
      <button onClick={onCloseToTicket} style={{ ...primaryButton, width: '100%' }}>Close & return to ticket</button>
      <div style={{ fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-soft)', marginTop: 'var(--mint-sp-2)' }}>
        Open <a href={`https://wealthsimple.atlassian.net/browse/${ticketId}`} target="_blank" rel="noreferrer" style={{ color: 'var(--mint-highlight-fg-strong)' }}>{ticketId}</a> in Jira to verify.
      </div>
    </section>
  );
}
```

- [ ] **Step 2: Render the panel when `step === 8`.**

Replace the existing `{step === 8 ? <div>(success panel — Task 14)</div> : null}` line:

```tsx
{step === 8 ? (
  <SuccessPanel
    ticketId={ticket.id}
    refund={effectiveRefund}
    reimbKey={reimbKey}
    reimbUrl={reimbUrl}
    onCloseToTicket={onClose}
  />
) : null}
```

- [ ] **Step 3: Verify build + smoke test.**

```bash
npm run build
```

Reload `dist/`. Run a full workflow end-to-end. Confirm:
- After Step 7 → green success panel with summary line.
- Close button returns to the ticket view.

- [ ] **Step 4: Commit.**

```bash
git add src/sidepanel/QCFeeWaiverWorkflow.tsx
git commit -m "feat(qc-fee-waiver): implement Step 8 success panel"
```

---

## Task 15: End-to-end run + polish

Walk through both scenarios on real tickets and clean up anything that's rough. This task captures the iteration that always happens once the full chain is wired.

**Files:**
- Modify: `extension/src/sidepanel/QCFeeWaiverWorkflow.tsx`
- Modify: `extension/src/content/i2c.ts`

- [ ] **Step 1: Run scenario A (Cancellation + clientPaidAnnualFee=true) on a real ticket.**

From a Credit Card overpayment ticket:
1. Click QC Fee Waiver button.
2. Step 1: pick Cancellation.
3. Step 2: click Scrape from i2c. Verify months count populates from i2c.
4. Step 3: check the formula breakdown is correct.
5. Step 4: click Apply Admin Credit. In the i2c tab, verify the form is pre-filled correctly. Submit Apply manually.
6. Back in extension: click ✓ Credit Applied.
7. Step 5: click Create REIMB ticket. Verify a REIMB ticket appears in Jira with the right amount.
8. Step 6: review the comment template, post.
9. Step 7: Move to Done.
10. Step 8: success panel.
11. Verify the WOCOO ticket in Jira: status = Done, comment posted with @mention + REIMB link.

- [ ] **Step 2: Run scenario B (Newly Eligible) on a real ticket.**

1. Click QC Fee Waiver button.
2. Step 1: pick Newly Eligible.
3. Step 2: enter anniversary + flip months.
4. Step 3: verify the calculation is `$20 × N`.
5. Step 4–7: same as above (no REIMB step).

- [ ] **Step 3: Fix anything you noticed.**

Common things to look for:
- The Admin Funds Credit service name regex (Task 10) — adjust if the live i2c label is different.
- 14-month scrape window (Task 7) — tighten or expand based on what the scrape returns.
- Comment template wording — tweak if it reads awkward in Jira.

For each fix: edit the relevant file, `npm run build`, smoke test, commit.

- [ ] **Step 4: Final commit (if anything was changed).**

```bash
git add -A
git commit -m "fix(qc-fee-waiver): polish based on end-to-end run"
```

---

## Self-review checklist (already done)

- **Spec coverage:** every spec section is mapped to a task. Step 1–8 → Tasks 4, 5, 6, 8, 9, 11, 12, 13, 14. New i2c flows → Tasks 1, 7, 10. SidePanel routing → Task 3.
- **Placeholders:** none — every step shows the actual code to write or the actual command to run.
- **Type consistency:** the new `Flow` union, storage keys (`pending_i2c_admin_credit_amount`, `qc_month_scrape_result`), and props (`onStartQCFeeWaiver`, scenario `'cancellation' | 'newly_eligible'`) are used consistently across tasks.
- **Known unknowns** flagged in the spec (Admin Funds Credit label, REIMB wording, scrape window) appear in the smoke-test steps and Task 15's polish step.
