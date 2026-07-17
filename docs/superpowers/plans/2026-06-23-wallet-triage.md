# Wallet Triage Workflow — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an auto-detected + manually-launchable 2-step workflow for credit-card-into-wallet-provisioning tickets (Apple Pay / Google Pay / Samsung Pay / etc.). Step 1 opens the configured Preset dashboard (filtered to the client's identity_id) and a reference Google Doc in two new tabs. Step 2 posts a "have you checked yet?" comment to the reporter and transitions the source WOCOO ticket to Done.

**Architecture:** Two new data files (`walletTriageDetect.ts`, `walletTriageConfig.ts`) follow the existing `credRouteDetect` shape. New `WalletTriageWorkflow.tsx` mirrors `QCFeeWaiverWorkflow.tsx`'s state-and-render pattern but with just two steps. New `WalletTriageCard.tsx` mirrors `CredRouteCard.tsx`'s detection-driven recommendation. `SidePanel.tsx` lifts `walletTriageActive` state (alongside `reverseFeeActive`), early-returns the workflow when active, mounts the card above QuickActions, and adds a third manual button to QuickActions row 2. `src/content/preset.ts` gets a one-line regex broadening so the existing identity-filter-clearer also recognizes the new dashboard's `identity_id` label.

**Tech Stack:** TypeScript, React (functional + hooks), Vite (build via `npm run build`), Chrome MV3 extension. No test framework; verification is manual via load-unpacked + clicking through real WOCOO tickets.

## Global Constraints

- **No automated tests.** Each task ends with `npm run build` (from `~/projects/wocoo-extension/extension/`) + a documented manual verification step. Do not introduce a test framework.
- **Not a git repository.** Skip every "commit" step. Tasks complete when manual verification passes.
- **Do not regress existing flows.** OverpaymentTriage, QC Fee Waiver, Reverse Fee, Clone/Move, Create REIMB Ticket, and Verify Eligible DD must all work exactly as they do today.
- **Existing code style:** TypeScript, semicolons, single quotes, 2-space indent, React functional components, no default exports.
- **Hardcoded URLs** (from spec, byte-for-byte):
  - Dashboard: `https://8a26d867.wealthsimple-aws-mpc.app.preset.io/superset/dashboard/8014/` (stripped of `native_filters_key`)
  - Doc: `https://docs.google.com/document/d/18G1-lYpfxS-FHDVTYwKyypmnXF_0evFO2pFTJRRIbXU/edit?tab=t.0#heading=h.oqcm6k38vnmt`
- **Comment template** (verbatim from spec): `Hi ` + `@<reporter mention>` + ` have you checked the Preset dash and doc yet?`
- **Done transition id** is `'251'` (used by every other workflow that transitions the source ticket).
- **Reload the unpacked extension** in `chrome://extensions` after every build before manual verification.

---

## File Structure

| Path | New? | Responsibility |
|---|---|---|
| `src/data/walletTriageDetect.ts` | new | `detectWalletTriage(summary, description, workType)` — signal lists + match rule. |
| `src/data/walletTriageConfig.ts` | new | Dashboard URL, Doc URL, comment-text-after-mention constant. |
| `src/sidepanel/WalletTriageWorkflow.tsx` | new | 2-step workflow component. Opens both tabs (queues Preset filter), posts comment with ADF @mention, transitions source to Done. Full-screen render, mirrors QCFeeWaiverWorkflow's shape. |
| `src/sidepanel/WalletTriageCard.tsx` | new | Auto-detect recommendation card. Renders above QuickActions when `detectWalletTriage(...).matched`. Mirrors `CredRouteCard`'s shape. |
| `src/sidepanel/SidePanel.tsx` | modify | Lift `walletTriageActive` state into `TicketView`; early-return `<WalletTriageWorkflow>` when active; pass `onStartWalletTriage` down through `TicketViewInner` → `QuickActions`; mount `<WalletTriageCard>` above QuickActions inside `TicketViewInner`; add a third manual button to QuickActions row 2. |
| `src/content/preset.ts` | modify | One-line regex broadening in `findFilterInput` (line ~134) to accept `identity_id` label alongside `Identity Canonical ID`. |

---

## Task 1: Create walletTriageDetect.ts + walletTriageConfig.ts

**Files:**
- Create: `src/data/walletTriageDetect.ts`
- Create: `src/data/walletTriageConfig.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `interface WalletTriageDetection { matched: boolean; reasons: string[] }`
  - `function detectWalletTriage(summary: string, description: string, workType: string | null | undefined): WalletTriageDetection`
  - `const WALLET_TRIAGE_DASHBOARD_URL: string`
  - `const WALLET_TRIAGE_DOC_URL: string`
  - `const WALLET_TRIAGE_COMMENT_TEXT_AFTER_MENTION: string`

- [ ] **Step 1: Create `src/data/walletTriageDetect.ts`** with the following content verbatim:

```ts
// Heuristic to detect tickets that look like a credit-card-into-wallet provisioning
// issue (Apple Pay / Google Pay / Samsung Pay / etc.). Mirrors the shape of
// [[cred-route-detect]] — exports a CCDetection-style result the WalletTriageCard
// uses to decide whether to surface the recommendation.

export interface WalletTriageDetection {
  matched: boolean;
  reasons: string[];
}

const CC_TOPIC_SIGNALS = [
  'credit card', 'cc ', ' cc', 'credit-card', 'cc application',
];

// Wallet / provisioning signals. Includes the technical Visa decline reasons
// because some agents quote them verbatim from i2c rather than saying "Apple Pay".
const WALLET_SIGNALS = [
  'apple pay', 'google pay', 'samsung pay', 'garmin pay',
  'virtual wallet', 'phone wallet', 'mobile wallet',
  'wallet provisioning', 'tokenization',
  'visa provisioning service', 'red path',
];

function findMatches(text: string, needles: string[]): string[] {
  const found: string[] = [];
  for (const n of needles) if (text.includes(n)) found.push(n);
  return found;
}

export function detectWalletTriage(
  summary: string,
  description: string,
  _workType: string | null | undefined,
): WalletTriageDetection {
  const text = `${summary || ''}\n${description || ''}`.toLowerCase();
  const ccTopic = findMatches(text, CC_TOPIC_SIGNALS);
  const wallet = findMatches(text, WALLET_SIGNALS);

  const reasons: string[] = [];
  if (ccTopic.length) reasons.push(`CC topic: ${ccTopic[0].trim()}`);
  if (wallet.length) reasons.push(`Wallet signal: ${wallet[0].trim()}`);

  // Match rule: BOTH a credit-card topic signal AND a wallet signal must appear.
  const matched = ccTopic.length > 0 && wallet.length > 0;
  return { matched, reasons };
}
```

- [ ] **Step 2: Create `src/data/walletTriageConfig.ts`** with this content verbatim:

```ts
// Wallet Triage workflow constants — URLs the workflow opens, and the
// comment template fragment used after the @mention.

// Dashboard URL stripped of `native_filters_key`. Per [[preset-native-filters-key]]:
// the Preset content script can't clear filter chips baked into that URL param,
// so we apply the identity_id filter via chrome.storage.local instead.
export const WALLET_TRIAGE_DASHBOARD_URL =
  'https://8a26d867.wealthsimple-aws-mpc.app.preset.io/superset/dashboard/8014/';

// Internal reference doc that agents consult alongside the Preset dashboard
// when triaging wallet-provisioning issues.
export const WALLET_TRIAGE_DOC_URL =
  'https://docs.google.com/document/d/18G1-lYpfxS-FHDVTYwKyypmnXF_0evFO2pFTJRRIbXU/edit?tab=t.0#heading=h.oqcm6k38vnmt';

// Comment template — agent's check-in to the reporter. Appended after the
// "Hi " + @reporter mention segment built by the workflow component.
export const WALLET_TRIAGE_COMMENT_TEXT_AFTER_MENTION =
  ' have you checked the Preset dash and doc yet?';
```

- [ ] **Step 3: Build to confirm both files compile.**

Run from `~/projects/wocoo-extension/extension/`:
```bash
npm run build
```
Expected: build completes with no TypeScript errors. The `dist/` folder rebuilds.

---

## Task 2: Broaden the Preset content script's filter-input matcher

**Files:**
- Modify: `src/content/preset.ts` — line ~134 (the `findFilterInput` function's label regex).

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: no new exports. The existing `findFilterInput()` now matches one additional label.

- [ ] **Step 1: Open `src/content/preset.ts`** and locate the existing line in `findFilterInput`:

```ts
    if (!/^Identity\s+Canonical\s+ID/i.test(t)) continue;
```

(The line is in a `for` loop inside `findFilterInput`, around line 134.)

- [ ] **Step 2: Replace the line** with this broadened regex:

```ts
    if (!/^(Identity\s+Canonical\s+ID|identity_id)\b/i.test(t)) continue;
```

That's the only change to the file. Both alternatives anchor at `^` (start of trimmed label text) and the `\b` ends the second alternative at a word boundary so something like `identity_id_v2` would still match.

- [ ] **Step 3: Build to confirm TypeScript compiles.**

Run from `~/projects/wocoo-extension/extension/`:
```bash
npm run build
```
Expected: build completes without TypeScript errors.

- [ ] **Step 4: Manual smoke — Verify Eligible DD still works** (regression check on the existing dashboard).

  1. `chrome://extensions` → reload "WOCOO Triager" (unpacked).
  2. Open any WOCOO ticket with an `identityId`.
  3. Click **📊 Verify Eligible DD** in the side panel.
  4. Confirm the existing dashboard opens in a new tab AND the `Identity Canonical ID` filter chip clears, the new identity is typed and selected, and **Apply Filters** is clicked automatically (look at the chip — it should show the ticket's identity-XXX).

If any of those steps regresses, revert this task's single-line change and report. The regex broadening shouldn't change behavior on the existing dashboard.

---

## Task 3: Create WalletTriageWorkflow.tsx

**Files:**
- Create: `src/sidepanel/WalletTriageWorkflow.tsx`

**Interfaces:**
- Consumes:
  - From Task 1: `WALLET_TRIAGE_DASHBOARD_URL`, `WALLET_TRIAGE_DOC_URL`, `WALLET_TRIAGE_COMMENT_TEXT_AFTER_MENTION`.
  - Existing: `WocooTicket` from `../data/mockTicket`; `postComment`, `transitionTicket`, `type CommentSegment` from `../api/jira`.
- Produces:
  - `export function WalletTriageWorkflow({ ticket, onClose, onTicketUpdate }: { ticket: WocooTicket; onClose: () => void; onTicketUpdate: (t: WocooTicket) => void }): JSX.Element` — full-screen workflow component, returned from `TicketView` when `walletTriageActive` is true.

- [ ] **Step 1: Create the file** at `src/sidepanel/WalletTriageWorkflow.tsx` with this full content verbatim:

```tsx
// Wallet Triage workflow — 2 steps with a success state.
//
// Step 1: Queue identity_id filter + open Preset dashboard + open Google Doc in two tabs.
//         The Preset content script handles clearing existing chips, typing the new
//         identity, and clicking Apply Filters on its end.
// Step 2: Post a "have you checked yet?" comment to the reporter (ADF @mention pill)
//         and transition the source ticket to Done.

import { useEffect, useState } from 'react';
import type { WocooTicket } from '../data/mockTicket';
import { postComment, transitionTicket, type CommentSegment } from '../api/jira';
import {
  WALLET_TRIAGE_DASHBOARD_URL,
  WALLET_TRIAGE_DOC_URL,
  WALLET_TRIAGE_COMMENT_TEXT_AFTER_MENTION,
} from '../data/walletTriageConfig';

type StepNum = 1 | 2 | 3;

const STEP_TITLES: Record<StepNum, string> = {
  1: 'Open dashboard & doc',
  2: 'Post comment & Move to Done',
  3: 'Complete',
};

const STEP_SUBTITLES: Record<StepNum, string> = {
  1: 'Both tabs open at once; dashboard auto-filters by identity_id',
  2: 'Ask the reporter to confirm, then close',
  3: '',
};

export function WalletTriageWorkflow({ ticket, onClose, onTicketUpdate }: {
  ticket: WocooTicket;
  onClose: () => void;
  onTicketUpdate: (t: WocooTicket) => void;
}) {
  const [step, setStep] = useState<StepNum>(1);
  const [openedBoth, setOpenedBoth] = useState(false);
  const [commentPosted, setCommentPosted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [softWarning, setSoftWarning] = useState<string | null>(null);

  // Close on Esc when not mid-network-call
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, busy]);

  async function openDashboardAndDoc() {
    if (!ticket.identityId) {
      setError('Source ticket has no Identity ID — dashboard filter requires it.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // Same key Verify Eligible DD uses; triggers src/content/preset.ts to clear
      // existing chips, type the new identity, and click Apply Filters.
      await chrome.storage.local.set({ pending_preset_identity_id: ticket.identityId });
      window.open(WALLET_TRIAGE_DASHBOARD_URL, '_blank', 'noopener,noreferrer');
      window.open(WALLET_TRIAGE_DOC_URL, '_blank', 'noopener,noreferrer');
      setOpenedBoth(true);
      setStep(2);
    } catch (e: any) {
      setError('Failed to queue dashboard filter — try again. ' + (e?.message || String(e)));
    } finally {
      setBusy(false);
    }
  }

  async function postAndMoveToDone() {
    setBusy(true);
    setError(null);
    setSoftWarning(null);
    try {
      const reporterAccountId = (ticket as any).reporterAccountId as string | undefined;
      const mentionText = '@' + (ticket.reporter || 'team');
      const segments: CommentSegment[] = [
        { type: 'text', text: 'Hi ' },
        reporterAccountId
          ? { type: 'mention', text: mentionText, accountId: reporterAccountId }
          : { type: 'text', text: mentionText },
        { type: 'text', text: WALLET_TRIAGE_COMMENT_TEXT_AFTER_MENTION },
      ];
      await postComment(ticket.id, segments);

      // Comment posted. Transition is soft — if it fails, we still treat the
      // workflow as success and surface a warning, matching every other workflow.
      try {
        await transitionTicket(ticket.id, '251');
        onTicketUpdate({ ...ticket, status: 'Done' });
      } catch (transitionErr: any) {
        setSoftWarning(
          'Comment posted, but Move-to-Done on ' + ticket.id + ' failed: ' +
          (transitionErr?.message || String(transitionErr)) +
          '. Close the ticket manually in Jira.',
        );
      }

      setCommentPosted(true);
      setStep(3);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh', background: 'var(--mint-bg-page)' }}>
      {/* Header */}
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: 'var(--mint-sp-3) var(--mint-sp-4)', borderBottom: 'var(--mint-card-stroke)' }}>
        <div>
          <div style={{ fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-soft)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            Wallet Triage · {ticket.id}
          </div>
          <h2 style={{ margin: 0, fontSize: 'var(--mint-text-h-md)', color: 'var(--mint-fg-strong)' }}>
            {STEP_TITLES[step]}
          </h2>
          {STEP_SUBTITLES[step] && (
            <div style={{ fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-subdued-title)', marginTop: 2 }}>
              {STEP_SUBTITLES[step]}
            </div>
          )}
        </div>
        <button onClick={onClose} disabled={busy} style={iconButtonStyle} aria-label="Close">×</button>
      </header>

      {/* Body */}
      <div style={{ padding: 'var(--mint-sp-3) var(--mint-sp-4)', display: 'flex', flexDirection: 'column', gap: 'var(--mint-sp-3)' }}>
        {step === 1 && (
          <div style={cardStyle}>
            <div style={{ fontSize: 'var(--mint-text-meta)', color: 'var(--mint-fg-strong)', marginBottom: 'var(--mint-sp-2)', lineHeight: 1.5 }}>
              Opens the Preset dashboard pre-filtered to <strong>{ticket.identityId}</strong> and the reference Google Doc, both in new tabs.
            </div>
            {openedBoth ? (
              <div style={{ fontSize: 'var(--mint-text-micro)', color: 'var(--mint-positive-fg-strong)', marginBottom: 'var(--mint-sp-2)' }}>
                ✓ Opened both — click any tab to review.
              </div>
            ) : null}
            <button
              onClick={openDashboardAndDoc}
              disabled={busy || !ticket.identityId}
              style={{ ...primaryButton, width: '100%', opacity: !ticket.identityId ? 0.55 : 1, cursor: !ticket.identityId ? 'not-allowed' : 'pointer' }}
            >
              {busy ? 'Opening…' : '↗ Open dashboard + doc'}
            </button>
          </div>
        )}

        {step === 2 && (
          <div style={cardStyle}>
            <div style={{ fontSize: 'var(--mint-text-meta)', color: 'var(--mint-fg-strong)', marginBottom: 'var(--mint-sp-2)', lineHeight: 1.5 }}>
              Will post:
            </div>
            <div style={{ padding: 'var(--mint-sp-2) var(--mint-sp-3)', background: 'var(--mint-bg-subtle)', borderRadius: 'var(--mint-radius-button)', fontSize: 'var(--mint-text-meta)', color: 'var(--mint-fg-strong)', marginBottom: 'var(--mint-sp-3)', lineHeight: 1.5 }}>
              Hi <span style={{ background: 'var(--mint-highlight-bg-soft)', color: 'var(--mint-highlight-fg-strong)', padding: '0 4px', borderRadius: 4, fontWeight: 600 }}>@{ticket.reporter || 'team'}</span>
              {WALLET_TRIAGE_COMMENT_TEXT_AFTER_MENTION}
            </div>
            <button
              onClick={postAndMoveToDone}
              disabled={busy}
              style={{ ...primaryButton, width: '100%', opacity: busy ? 0.6 : 1, cursor: busy ? 'wait' : 'pointer' }}
            >
              {busy ? 'Posting & moving…' : 'Post & Move to Done'}
            </button>
          </div>
        )}

        {step === 3 && (
          <div style={{ ...cardStyle, background: 'var(--mint-positive-bg-soft)', border: '1px solid var(--mint-positive-fg-graphic)', textAlign: 'center', padding: 'var(--mint-sp-4)' }}>
            <div style={{ fontSize: 28, marginBottom: 'var(--mint-sp-2)' }}>✓</div>
            <h3 style={{ margin: 0, fontSize: 'var(--mint-text-h-md)', color: 'var(--mint-positive-fg-strong)' }}>Triage complete</h3>
            <p style={{ margin: 'var(--mint-sp-2) 0 var(--mint-sp-3)', fontSize: 'var(--mint-text-meta)', color: 'var(--mint-fg-subdued-title)' }}>
              Comment posted on{' '}
              <a href={`https://wealthsimple.atlassian.net/browse/${ticket.id}`} target="_blank" rel="noreferrer" style={{ color: 'var(--mint-highlight-fg-strong)', fontWeight: 600 }}>
                {ticket.id}
              </a>
              {softWarning ? '' : ' and source ticket transitioned to Done.'}
            </p>
            {softWarning ? (
              <div style={{ background: 'var(--mint-warning-bg-soft)', border: '1px solid var(--mint-warning-fg-graphic)', borderRadius: 'var(--mint-radius-button)', padding: 'var(--mint-sp-2) var(--mint-sp-3)', fontSize: 'var(--mint-text-nano)', color: 'var(--mint-warning-fg-strong)', textAlign: 'left', marginBottom: 'var(--mint-sp-3)' }}>
                {softWarning}
              </div>
            ) : null}
            <button onClick={onClose} style={{ ...primaryButton, marginTop: 'var(--mint-sp-2)' }}>Close</button>
          </div>
        )}

        {error ? (
          <div style={{ background: 'var(--mint-negative-bg-soft)', color: 'var(--mint-negative-fg-strong)', padding: 'var(--mint-sp-2) var(--mint-sp-3)', borderRadius: 'var(--mint-radius-button)', fontSize: 'var(--mint-text-meta)' }}>
            ⚠ {error}
          </div>
        ) : null}

        {/* Progress dots */}
        {step !== 3 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'center', marginTop: 'var(--mint-sp-2)' }}>
            {[1, 2].map((n) => {
              const done = n < step;
              const active = n === step;
              if (done) return <span key={n} style={dotDone} />;
              if (active) return <span key={n} style={dotActive} />;
              return <span key={n} style={dotFuture} />;
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ===== styles =====

const cardStyle: React.CSSProperties = {
  background: 'var(--mint-bg-card)',
  border: 'var(--mint-card-stroke)',
  borderRadius: 'var(--mint-radius-card)',
  padding: 'var(--mint-sp-3)',
  display: 'flex',
  flexDirection: 'column',
};
const iconButtonStyle: React.CSSProperties = {
  width: 28, height: 28, padding: 0, background: 'transparent', border: 'none', borderRadius: 6,
  color: 'var(--mint-fg-soft)', fontSize: 20, cursor: 'pointer',
};
const primaryButton: React.CSSProperties = {
  padding: '8px 14px', borderRadius: 'var(--mint-radius-button)', fontWeight: 600,
  fontSize: 'var(--mint-text-meta)', border: 'none',
  background: 'var(--mint-fg-strong)', color: 'var(--mint-fg-inverted)', cursor: 'pointer',
};
const dotDone: React.CSSProperties = { width: 14, height: 14, borderRadius: 9999, background: 'var(--mint-positive-fg-graphic)' };
const dotActive: React.CSSProperties = { width: 10, height: 10, borderRadius: 9999, background: 'var(--mint-fg-strong)' };
const dotFuture: React.CSSProperties = { width: 10, height: 10, borderRadius: 9999, border: '1.5px solid var(--mint-outline-strong)' };
```

- [ ] **Step 2: Build to confirm TypeScript compiles.**

Run from `~/projects/wocoo-extension/extension/`:
```bash
npm run build
```
Expected: build completes without TypeScript errors. The component is not yet mounted from anywhere — that happens in Task 4.

---

## Task 4: Create WalletTriageCard + wire everything into SidePanel.tsx

**Files:**
- Create: `src/sidepanel/WalletTriageCard.tsx`
- Modify: `src/sidepanel/SidePanel.tsx`

**Interfaces:**
- Consumes:
  - From Task 1: `detectWalletTriage`.
  - From Task 3: `WalletTriageWorkflow`.
  - Existing: `WocooTicket`, `ActionButton`, etc., already in `SidePanel.tsx`.
- Produces:
  - `export function WalletTriageCard({ ticket, onStart }: { ticket: WocooTicket; onStart: () => void }): JSX.Element | null` — renders null when detection doesn't match or `identityId` is missing.
  - SidePanel state plumbing: `walletTriageActive` lifted to `TicketView`, passed via `onStartWalletTriage` callback prop into `TicketViewInner` → `QuickActions`.

- [ ] **Step 1: Create the file** at `src/sidepanel/WalletTriageCard.tsx` with this content verbatim:

```tsx
// Auto-detect recommendation card for wallet-provisioning tickets. Renders above
// QuickActions in the side panel when detectWalletTriage matches.

import type { WocooTicket } from '../data/mockTicket';
import { detectWalletTriage } from '../data/walletTriageDetect';

export function WalletTriageCard({ ticket, onStart }: { ticket: WocooTicket; onStart: () => void }) {
  if (!ticket.identityId) return null;
  const detection = detectWalletTriage(ticket.summary || '', ticket.description || '', ticket.workType);
  if (!detection.matched) return null;

  return (
    <div style={cardStyle}>
      <div style={titleStyle}>💳 Looks like a wallet provisioning issue</div>
      <div style={reasonsStyle}>{detection.reasons.join(' · ')}</div>
      <button onClick={onStart} style={buttonStyle}>Start Wallet Triage</button>
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

- [ ] **Step 2: Open `src/sidepanel/SidePanel.tsx`** and add two new imports next to the existing workflow imports. Find:

```tsx
import { MoveModal } from './MoveModal';
import { CreateReimbModal } from './CreateReimbModal';
```

Add immediately after:

```tsx
import { WalletTriageWorkflow } from './WalletTriageWorkflow';
import { WalletTriageCard } from './WalletTriageCard';
```

- [ ] **Step 3: Add the `walletTriageActive` state in `TicketView`** alongside the other workflow-active flags. Find:

```ts
  const [reverseFeeActive, setReverseFeeActive] = useState(false);
```

Add immediately after:

```ts
  const [walletTriageActive, setWalletTriageActive] = useState(false);
```

(Note: `qcFeeWaiverActive` exists between these too — leave its declaration in place; just insert `walletTriageActive` after the `reverseFeeActive` line.)

- [ ] **Step 4: Add the workflow's early-return branch in `TicketView`.** Find the existing block:

```tsx
  if (qcFeeWaiverActive) {
    return (
      <QCFeeWaiverWorkflow
        ticket={ticket}
        onClose={() => setQCFeeWaiverActive(false)}
        onTicketUpdate={onTicketUpdate}
      />
    );
  }
```

Add immediately after it:

```tsx
  if (walletTriageActive) {
    return (
      <WalletTriageWorkflow
        ticket={ticket}
        onClose={() => setWalletTriageActive(false)}
        onTicketUpdate={onTicketUpdate}
      />
    );
  }
```

- [ ] **Step 5: Pass the new prop down to `TicketViewInner`.** Find the `<TicketViewInner ...>` JSX block at the end of `TicketView`:

```tsx
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
```

Add the `onStartWalletTriage` prop:

```tsx
  return (
    <TicketViewInner
      ticket={ticket}
      onTicketUpdate={onTicketUpdate}
      onStartTriage={() => setTriageActive(true)}
      onStartReverseFee={() => setReverseFeeActive(true)}
      onStartQCFeeWaiver={() => setQCFeeWaiverActive(true)}
      onStartWalletTriage={() => setWalletTriageActive(true)}
      onGoHome={onGoHome}
      onOpenSettings={onOpenSettings}
    />
  );
```

- [ ] **Step 6: Update `TicketViewInner`'s signature** to accept the new prop. Find the existing function signature (around line 191):

```tsx
function TicketViewInner({ ticket, onTicketUpdate, onStartTriage, onStartReverseFee, onStartQCFeeWaiver, onGoHome, onOpenSettings }: { ticket: WocooTicket; onTicketUpdate: (t: WocooTicket) => void; onStartTriage: () => void; onStartReverseFee: () => void; onStartQCFeeWaiver: () => void; onGoHome: () => void; onOpenSettings: () => void }) {
```

Replace with:

```tsx
function TicketViewInner({ ticket, onTicketUpdate, onStartTriage, onStartReverseFee, onStartQCFeeWaiver, onStartWalletTriage, onGoHome, onOpenSettings }: { ticket: WocooTicket; onTicketUpdate: (t: WocooTicket) => void; onStartTriage: () => void; onStartReverseFee: () => void; onStartQCFeeWaiver: () => void; onStartWalletTriage: () => void; onGoHome: () => void; onOpenSettings: () => void }) {
```

- [ ] **Step 7: Mount the WalletTriageCard above QuickActions.** Find the existing `<CredRouteCard>` render block (around line 298):

```tsx
      {/* CRED ROUTE DETECTION — shows when ticket looks like a credit-decisioning task */}
      <CredRouteCard ticket={ticket} onOpenCloneMove={() => openCloneMove('CRED')} />
```

Add immediately after it:

```tsx
      {/* WALLET PROVISIONING DETECTION — shows when ticket looks like a wallet-add issue */}
      <WalletTriageCard ticket={ticket} onStart={onStartWalletTriage} />
```

- [ ] **Step 8: Pass `onStartWalletTriage` into `<QuickActions>`.** Find the existing `<QuickActions ...>` block in `TicketViewInner` (around line 302):

```tsx
      <QuickActions
        ticket={ticket}
        onTicketUpdate={onTicketUpdate}
        onStartTriage={onStartTriage}
        onStartReverseFee={onStartReverseFee}
        onStartQCFeeWaiver={onStartQCFeeWaiver}
        onOpenCloneMove={openCloneMove}
        onOpenCreateReimb={() => setCreateReimbActive(true)}
      />
```

Add the new prop:

```tsx
      <QuickActions
        ticket={ticket}
        onTicketUpdate={onTicketUpdate}
        onStartTriage={onStartTriage}
        onStartReverseFee={onStartReverseFee}
        onStartQCFeeWaiver={onStartQCFeeWaiver}
        onStartWalletTriage={onStartWalletTriage}
        onOpenCloneMove={openCloneMove}
        onOpenCreateReimb={() => setCreateReimbActive(true)}
      />
```

- [ ] **Step 9: Update `QuickActions`'s signature** to accept the new prop. Find the existing signature (around line 521):

```tsx
function QuickActions({ ticket, onTicketUpdate, onStartTriage, onStartReverseFee, onStartQCFeeWaiver, onOpenCloneMove, onOpenCreateReimb }: { ticket: WocooTicket; onTicketUpdate: (t: WocooTicket) => void; onStartTriage: () => void; onStartReverseFee: () => void; onStartQCFeeWaiver: () => void; onOpenCloneMove: (initialDestKey?: MoveDestination) => void; onOpenCreateReimb: () => void }) {
```

Replace with:

```tsx
function QuickActions({ ticket, onTicketUpdate, onStartTriage, onStartReverseFee, onStartQCFeeWaiver, onStartWalletTriage, onOpenCloneMove, onOpenCreateReimb }: { ticket: WocooTicket; onTicketUpdate: (t: WocooTicket) => void; onStartTriage: () => void; onStartReverseFee: () => void; onStartQCFeeWaiver: () => void; onStartWalletTriage: () => void; onOpenCloneMove: (initialDestKey?: MoveDestination) => void; onOpenCreateReimb: () => void }) {
```

- [ ] **Step 10: Add the third button to row 2 of QuickActions.** Find the existing row-2 block (around line 568):

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

Replace with:

```tsx
      <div style={{ display: 'flex', gap: 'var(--mint-sp-2)' }}>
        <ActionButton variant="warning" onClick={onStartReverseFee} disabled={!ticket.clientEmail} title="Start Reverse Fee workflow">
          ↗ Reverse Fee
        </ActionButton>
        <ActionButton variant="neutral" onClick={onStartQCFeeWaiver} disabled={!ticket.clientEmail} title="Start QC Fee Waiver workflow">
          ⚖️ QC Fee Waiver
        </ActionButton>
        <ActionButton variant="neutral" onClick={onStartWalletTriage} disabled={!ticket.identityId} title="Start Wallet Triage workflow (Apple Pay / Google Pay / etc.)">
          💳 Wallet Triage
        </ActionButton>
      </div>
```

- [ ] **Step 11: Build to confirm everything compiles.**

Run from `~/projects/wocoo-extension/extension/`:
```bash
npm run build
```
Expected: build completes without TypeScript errors.

- [ ] **Step 12: Reload the extension.**

`chrome://extensions` → reload "WOCOO Triager".

- [ ] **Step 13: Manual smoke — auto-detect card appears on a wallet ticket.**

  1. Open WOCOO-23426 (or a similar ticket: summary mentions Apple/Google/Samsung Pay AND description mentions credit card).
  2. Confirm a card titled **💳 Looks like a wallet provisioning issue** appears between CredRouteCard's region and QuickActions, with reasons like "CC topic: credit card · Wallet signal: apple pay".
  3. Confirm the **Wallet Triage** button in QuickActions row 2 (next to QC Fee Waiver) is enabled.

- [ ] **Step 14: Manual smoke — auto-detect card hidden on unrelated tickets.**

  1. Open a non-wallet ticket (e.g. a wires ticket, or an overpayment ticket).
  2. Confirm the wallet card does NOT appear.
  3. Confirm the **Wallet Triage** button in QuickActions is still visible (it's the manual fallback), and disabled if `identityId` is missing.

- [ ] **Step 15: End-to-end test — Start Wallet Triage from the card.**

  1. On WOCOO-23426, click **Start Wallet Triage** in the auto-detect card.
  2. The side panel switches to the full-screen Wallet Triage workflow, Step 1 active.
  3. Click **↗ Open dashboard + doc**.
     - Expect: two new tabs open. The Preset dashboard auto-clears any existing `identity_id` chip and reapplies with the source ticket's identity_id, then clicks Apply Filters. The Google Doc opens cleanly.
     - The workflow advances to Step 2.
  4. On Step 2, confirm the preview text reads: `Hi @<reporter> have you checked the Preset dash and doc yet?` with the reporter's name styled as a mention pill.
  5. Click **Post & Move to Done**.
     - Expect: Step 3 (Triage complete) appears. Comment is posted on WOCOO-23426 (verify in Jira) with a real @mention, and the source ticket's status is now Done.
  6. Click **Close** → side panel returns to TicketView.

- [ ] **Step 16: End-to-end test — Start Wallet Triage from the QuickActions button.**

  1. On a ticket the detector misses (e.g. an overpayment ticket), confirm the auto-detect card is hidden but the **Wallet Triage** button is enabled.
  2. Click the button → same workflow opens.
  3. Walk through Steps 1 + 2.
  4. Expect identical behavior to test 15.

  > Caveat: this test will post a "have you checked yet?" comment on an unrelated ticket and close it. Pick a disposable test ticket OR don't actually click Confirm in Step 2.

- [ ] **Step 17: Sanity — Verify Eligible DD regression (covers Task 2's change too).**

  1. On any WOCOO ticket with identityId, click **📊 Verify Eligible DD**.
  2. Confirm the existing dashboard still applies its filter automatically (chip clears + new identity types + Apply Filters clicks).

If anything breaks, the regex broadening in Task 2 likely affected it — revert that change and report.

- [ ] **Step 18: Sanity — workflow buttons disabled when no identity.**

  1. Open a ticket that has no `identityId` (or temporarily clear the side panel's ticket).
  2. Confirm the **Wallet Triage** button is disabled with the tooltip "Start Wallet Triage workflow (Apple Pay / Google Pay / etc.)".
  3. The card should also be hidden.

---

## Self-Review Summary

After writing the plan, checked it against the spec:

- **Spec coverage:**
  - Detection signals + match rule → Task 1 Step 1.
  - Dashboard URL stripped of native_filters_key + Doc URL + comment fragment → Task 1 Step 2.
  - Workflow shape (2 steps + success state) → Task 3 Step 1.
  - Step 1 opens both tabs and queues filter via `pending_preset_identity_id` → Task 3 Step 1 (`openDashboardAndDoc`).
  - Step 2 posts ADF mention comment + transitions to Done with soft-failure handling → Task 3 Step 1 (`postAndMoveToDone`).
  - Preset content script regex broadening → Task 2.
  - Auto-detect card mirrors CredRouteCard → Task 4 Step 1.
  - Manual button in QuickActions row 2 → Task 4 Step 10.
  - State lift + early-return + prop plumbing → Task 4 Steps 3–9.
  - Manual smokes (happy path, no-identity, regression) → Task 4 Steps 13–18.
- **Placeholder scan:** No "TBD"/"TODO"/"add appropriate". Code blocks have complete content. Manual verification steps name the exact buttons/inputs to click.
- **Type consistency:** `WalletTriageDetection`, `detectWalletTriage`, `WALLET_TRIAGE_DASHBOARD_URL`, `WALLET_TRIAGE_DOC_URL`, `WALLET_TRIAGE_COMMENT_TEXT_AFTER_MENTION`, `WalletTriageWorkflow`, `WalletTriageCard`, `onStartWalletTriage` all match across tasks.
- **Scope:** Single feature, six files (2 new + 1 modified existing data path + 2 new sidepanel + 1 modified sidepanel + 1 content script), four tasks. Single plan is the right shape.
