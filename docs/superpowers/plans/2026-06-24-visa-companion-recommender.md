# Visa Companion Recommender — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-detect Visa Airport Companion tickets and surface a one-click recommendation card that posts a canned reply @mentioning the reporter (with Guru/doc links + Visa Concierge phone number `1-855-822-1240`) and transitions the source ticket to Done.

**Architecture:** New detector module in `src/data/` mirrors the `walletTriageDetect.ts` shape. New config module holds URLs + phone. New self-contained card component owns its `idle` / `posting` / `done` / `error` state machine and calls existing `postComment` + `transitionTicket` helpers inline (no separate workflow file). SidePanel mounts the card at the bottom of the recommendation-card stack.

**Tech Stack:** TypeScript, React (functional + hooks), Vite (build via `npm run build`), Chrome MV3 extension. No test framework; verification is manual via load-unpacked + clicking through a real Visa Companion WOCOO ticket.

## Global Constraints

- **No automated tests.** Each task ends with `npm run build` (from `~/projects/wocoo-extension/extension/`) + a documented manual verification step.
- **Not a git repository.** Skip every "commit" step. Tasks complete when manual verification passes.
- **Existing code style:** TypeScript, semicolons, single quotes, 2-space indent, React functional components, no default exports.
- **Concierge phone**: `1-855-822-1240` (exact value — already confirmed).
- **Guru URL**: `https://app.getguru.com/card/idGo6pdT/Wealthsimple-Visa-Infinite-Privilege-credit-card-benefits` (exact).
- **Doc URL**: `https://docs.google.com/document/d/1K9huSHGOCkScKj22F5aMBdtJYisixnJmXyIj9vAPVP4/edit?tab=t.0` (exact).
- **Done transition id** = `'251'`.
- **Do not regress existing flows.** All current recommendation cards (QCAutoReimbCard, OverpaymentTriageCard, ReverseFeeCard, QCFeeWaiverCard, CredRouteCard, WalletTriageCard) must keep firing on their respective tickets.
- **Reload the unpacked extension** in `chrome://extensions` after every build before manual verification.

---

## File Structure

| Path | Change |
|---|---|
| `src/data/visaCompanionDetect.ts` | **new** — `detectVisaCompanion(summary, description, workType)`. |
| `src/data/visaCompanionConfig.ts` | **new** — Guru URL, doc URL, concierge phone constants. |
| `src/sidepanel/VisaCompanionCard.tsx` | **new** — self-contained card with `idle` / `posting` / `done` / `error` states; calls `postComment` + `transitionTicket` inline. |
| `src/sidepanel/SidePanel.tsx` | modify — import + mount `<VisaCompanionCard>` after `WalletTriageCard` in the recommendation-card stack. |

---

## Task 1: Add detector + config data files

**Files:**
- Create: `src/data/visaCompanionDetect.ts`
- Create: `src/data/visaCompanionConfig.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `interface VisaCompanionDetection { matched: boolean; reasons: string[] }`
  - `detectVisaCompanion(summary: string, description: string, workType: string | null | undefined): VisaCompanionDetection`
  - `VISA_COMPANION_GURU_URL: string`
  - `VISA_COMPANION_DOC_URL: string`
  - `VISA_COMPANION_CONCIERGE_PHONE: string`

- [ ] **Step 1: Create `src/data/visaCompanionDetect.ts`** with this content verbatim:

```ts
// Heuristic to detect "client can't register for Visa Airport Companion" tickets.
// Mirrors the existing detector shape ([[wallet-triage-detect]] / [[cred-route-detect]]).
//
// Narrow signal set per the brainstorming decision (2026-06-24): only fire on
// Visa Companion / Airport Companion mentions. Broader Visa Infinite benefit
// detection (concierge, priority pass, lounge access) was scoped out.

export interface VisaCompanionDetection {
  matched: boolean;
  reasons: string[];
}

const SIGNALS = [
  'visa companion',
  'airport companion',
  'visa airport companion',
];

function findMatches(text: string, needles: string[]): string[] {
  const found: string[] = [];
  for (const n of needles) if (text.includes(n)) found.push(n);
  return found;
}

export function detectVisaCompanion(
  summary: string,
  description: string,
  _workType: string | null | undefined,
): VisaCompanionDetection {
  const text = `${summary || ''}\n${description || ''}`.toLowerCase();
  const hits = findMatches(text, SIGNALS);

  const reasons: string[] = [];
  if (hits.length) reasons.push(`Visa Companion signal: ${hits[0].trim()}`);

  return { matched: hits.length > 0, reasons };
}
```

- [ ] **Step 2: Create `src/data/visaCompanionConfig.ts`** with this content verbatim:

```ts
// Visa Companion / Airport Companion reply constants. Edit here to update the
// guru/doc URLs or the concierge phone without touching the card component.

export const VISA_COMPANION_GURU_URL =
  'https://app.getguru.com/card/idGo6pdT/Wealthsimple-Visa-Infinite-Privilege-credit-card-benefits';

export const VISA_COMPANION_DOC_URL =
  'https://docs.google.com/document/d/1K9huSHGOCkScKj22F5aMBdtJYisixnJmXyIj9vAPVP4/edit?tab=t.0';

export const VISA_COMPANION_CONCIERGE_PHONE = '1-855-822-1240';
```

- [ ] **Step 3: Build to confirm both files compile.**

Run from `~/projects/wocoo-extension/extension/`:
```bash
npm run build
```
Expected: build completes with no TypeScript errors.

---

## Task 2: Create card + wire into SidePanel.tsx

**Files:**
- Create: `src/sidepanel/VisaCompanionCard.tsx`
- Modify: `src/sidepanel/SidePanel.tsx`

**Interfaces:**
- Consumes:
  - From Task 1: `detectVisaCompanion`, `VISA_COMPANION_GURU_URL`, `VISA_COMPANION_DOC_URL`, `VISA_COMPANION_CONCIERGE_PHONE`.
  - Existing: `WocooTicket` from `../data/mockTicket`; `postComment`, `transitionTicket`, `type CommentSegment` from `../api/jira`.
- Produces:
  - `VisaCompanionCard({ ticket, onTicketUpdate }): JSX.Element | null`

- [ ] **Step 1: Create `src/sidepanel/VisaCompanionCard.tsx`** with this content verbatim:

```tsx
// Auto-detect recommendation card for "client can't register for Visa Airport
// Companion" tickets. One-click action: post a canned @reporter reply pointing
// to the Guru card + doc + Visa Concierge phone, then transition the source
// ticket to Done. Self-contained (no separate workflow file).

import { useState } from 'react';
import type { WocooTicket } from '../data/mockTicket';
import { postComment, transitionTicket, type CommentSegment } from '../api/jira';
import { detectVisaCompanion } from '../data/visaCompanionDetect';
import {
  VISA_COMPANION_GURU_URL,
  VISA_COMPANION_DOC_URL,
  VISA_COMPANION_CONCIERGE_PHONE,
} from '../data/visaCompanionConfig';

type CardState = 'idle' | 'posting' | 'done' | 'error';

export function VisaCompanionCard({ ticket, onTicketUpdate }: {
  ticket: WocooTicket;
  onTicketUpdate: (t: WocooTicket) => void;
}) {
  const [state, setState] = useState<CardState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [softWarning, setSoftWarning] = useState<string | null>(null);

  // Hide entirely without a reporter — the @mention is the point of the comment.
  if (!ticket.reporter) return null;
  const detection = detectVisaCompanion(ticket.summary || '', ticket.description || '', ticket.workType);
  if (!detection.matched) return null;

  const reporterName = ticket.reporter;
  const reporterAccountId = (ticket as any).reporterAccountId as string | undefined;

  async function postAndMoveToDone() {
    setState('posting');
    setError(null);
    setSoftWarning(null);
    try {
      const mentionText = '@' + reporterName;
      const trailer = ' , We can follow this ';
      const middle = ' and this ';
      const tail = `. If its resolved using these documents then we can always direct the client to Visa Infinite Concierge: ${VISA_COMPANION_CONCIERGE_PHONE}.\n\nFor benefits enabled through Visa directly, those are managed on Visas end so unfortunately we don't have visibility into eligibility for that program.\n\nThe best people to assist would be the Visa Concierge team.`;

      const segments: CommentSegment[] = [
        { type: 'text', text: 'Hi ' },
        reporterAccountId
          ? { type: 'mention', text: mentionText, accountId: reporterAccountId }
          : { type: 'text', text: mentionText },
        { type: 'text', text: trailer },
        { type: 'link', text: 'guru', href: VISA_COMPANION_GURU_URL },
        { type: 'text', text: middle },
        { type: 'link', text: 'document', href: VISA_COMPANION_DOC_URL },
        { type: 'text', text: tail },
      ];

      await postComment(ticket.id, segments);

      try {
        await transitionTicket(ticket.id, '251');
        onTicketUpdate({ ...ticket, status: 'Done' });
      } catch (transitionErr: any) {
        setSoftWarning(
          'Comment posted on ' + ticket.id + ', but Move-to-Done failed: ' +
          (transitionErr?.message || String(transitionErr)) +
          '. Close the ticket manually in Jira.',
        );
      }

      setState('done');
    } catch (e: any) {
      setError(e?.message || String(e));
      setState('error');
    }
  }

  function onRetry() {
    setState('idle');
    setError(null);
  }

  if (state === 'done') {
    return (
      <div style={doneStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--mint-sp-2)' }}>
          <span style={{ fontSize: 18 }}>✓</span>
          <span style={{ fontSize: 'var(--mint-text-meta)', fontWeight: 700, color: 'var(--mint-positive-fg-strong)' }}>
            Posted on {ticket.id}{softWarning ? '' : ' and moved to Done.'}
          </span>
        </div>
        {softWarning ? (
          <div style={softWarningStyle}>{softWarning}</div>
        ) : null}
      </div>
    );
  }

  return (
    <div style={cardStyle}>
      <div style={titleStyle}>🛫 Looks like a Visa Companion / Airport Companion ticket</div>
      <div style={reasonsStyle}>{detection.reasons.join(' · ')}</div>

      {/* Comment preview */}
      <div style={previewStyle}>
        Hi{' '}
        <span style={mentionPillStyle}>@{reporterName}</span>
        {' '}, We can follow this{' '}
        <span style={linkPreviewStyle}>guru</span>
        {' '}and this{' '}
        <span style={linkPreviewStyle}>document</span>
        . If its resolved using these documents then we can always direct the client to Visa Infinite Concierge: {VISA_COMPANION_CONCIERGE_PHONE}.
        <br /><br />
        For benefits enabled through Visa directly, those are managed on Visas end so unfortunately we don't have visibility into eligibility for that program.
        <br /><br />
        The best people to assist would be the Visa Concierge team.
      </div>

      {state === 'error' && error ? (
        <div style={errorBannerStyle}>
          <span>⚠ {error}</span>
          <button onClick={onRetry} style={textLinkStyle}>Retry</button>
        </div>
      ) : null}

      <button
        onClick={postAndMoveToDone}
        disabled={state === 'posting'}
        style={{ ...buttonStyle, opacity: state === 'posting' ? 0.6 : 1, cursor: state === 'posting' ? 'wait' : 'pointer' }}
      >
        {state === 'posting' ? 'Posting & moving…' : 'Send concierge reply & Move to Done'}
      </button>
    </div>
  );
}

// ===== styles =====

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
const previewStyle: React.CSSProperties = {
  background: 'var(--mint-bg-subtle)',
  border: 'var(--mint-card-stroke)',
  borderRadius: 'var(--mint-radius-button)',
  padding: 'var(--mint-sp-2) var(--mint-sp-3)',
  fontSize: 'var(--mint-text-nano)',
  color: 'var(--mint-fg-strong)',
  lineHeight: 1.5,
  marginBottom: 'var(--mint-sp-2)',
};
const mentionPillStyle: React.CSSProperties = {
  background: 'var(--mint-highlight-bg-soft)',
  color: 'var(--mint-highlight-fg-strong)',
  padding: '0 4px',
  borderRadius: 4,
  fontWeight: 600,
};
const linkPreviewStyle: React.CSSProperties = {
  color: 'var(--mint-highlight-fg-strong)',
  textDecoration: 'underline',
  fontWeight: 600,
};
const buttonStyle: React.CSSProperties = {
  padding: '8px 14px',
  borderRadius: 'var(--mint-radius-button)',
  fontWeight: 600,
  fontSize: 'var(--mint-text-meta)',
  border: 'none',
  background: 'var(--mint-fg-strong)',
  color: 'var(--mint-fg-inverted)',
  alignSelf: 'stretch',
};
const errorBannerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 'var(--mint-sp-2)',
  padding: 'var(--mint-sp-2) var(--mint-sp-3)',
  background: 'var(--mint-negative-bg-soft)',
  color: 'var(--mint-negative-fg-strong)',
  borderRadius: 'var(--mint-radius-button)',
  fontSize: 'var(--mint-text-meta)',
  marginBottom: 'var(--mint-sp-2)',
};
const textLinkStyle: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: 'var(--mint-highlight-fg-strong)',
  fontWeight: 600,
  fontSize: 'var(--mint-text-meta)',
  cursor: 'pointer',
  padding: 0,
};
const doneStyle: React.CSSProperties = {
  background: 'var(--mint-positive-bg-soft)',
  border: '1px solid var(--mint-positive-fg-graphic)',
  borderRadius: 'var(--mint-radius-card)',
  padding: 'var(--mint-sp-3)',
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--mint-sp-2)',
};
const softWarningStyle: React.CSSProperties = {
  background: 'var(--mint-warning-bg-soft)',
  border: '1px solid var(--mint-warning-fg-graphic)',
  borderRadius: 'var(--mint-radius-button)',
  padding: 'var(--mint-sp-2) var(--mint-sp-3)',
  fontSize: 'var(--mint-text-nano)',
  color: 'var(--mint-warning-fg-strong)',
};
```

- [ ] **Step 2: Open `src/sidepanel/SidePanel.tsx`** and add the import next to the existing card imports. Find the existing block of card imports (around `import { WalletTriageCard } from './WalletTriageCard';` and friends):

```ts
import { OverpaymentTriageCard } from './OverpaymentTriageCard';
import { ReverseFeeCard } from './ReverseFeeCard';
import { QCFeeWaiverCard } from './QCFeeWaiverCard';
```

Add immediately after:

```ts
import { VisaCompanionCard } from './VisaCompanionCard';
```

(Place it after the workflow cards so the import order roughly matches the render order.)

- [ ] **Step 3: Mount the card at the bottom of the recommendation-card stack** inside `TicketViewInner`. Find the existing `WalletTriageCard` render (around line 318):

```tsx
      {/* WALLET PROVISIONING DETECTION — shows when ticket looks like a wallet-add issue */}
      <WalletTriageCard ticket={ticket} onStart={onStartWalletTriage} />
```

Add immediately after it:

```tsx
      {/* VISA COMPANION — one-click canned reply + Move to Done */}
      <VisaCompanionCard ticket={ticket} onTicketUpdate={onTicketUpdate} />
```

`onTicketUpdate` is already in scope inside `TicketViewInner` (passed as a prop from `TicketView`).

- [ ] **Step 4: Build to confirm everything compiles.**

Run from `~/projects/wocoo-extension/extension/`:
```bash
npm run build
```
Expected: build completes without TypeScript errors. Bundle grows by ~3-4 kB for the new card + data files.

- [ ] **Step 5: Reload the extension.**

`chrome://extensions` → reload "WOCOO Triager".

- [ ] **Step 6: Smoke — happy path on WOCOO-23600.**

  1. Open WOCOO-23600 (or another Visa Companion ticket) in Jira.
  2. In the side panel, scroll to the recommendation-card stack above QuickActions. The **🛫 Looks like a Visa Companion / Airport Companion ticket** card should appear at the bottom of the stack.
  3. Confirm the reasons line shows `Visa Companion signal: visa companion` (or similar matched signal).
  4. Confirm the preview shows: `Hi @<reporter>, We can follow this guru and this document. If its resolved using these documents then we can always direct the client to Visa Infinite Concierge: 1-855-822-1240.` followed by two more paragraphs.
  5. Click **Send concierge reply & Move to Done**.
  6. Within ~2 seconds: card transforms into the green `done` state: `✓ Posted on WOCOO-23600 and moved to Done.`.
  7. Open the Jira ticket. Verify: comment posted with `@<reporter>` as a real mention pill, `guru` and `document` as clickable links to the configured URLs, phone number `1-855-822-1240` inline. Source ticket status is now `Done`.

- [ ] **Step 7: Smoke — soft-warning path (transition fails).**

  1. Manually transition a Visa Companion ticket to Done in Jira BEFORE clicking the card's button.
  2. In the side panel, click **Send concierge reply & Move to Done**.
  3. Comment posts on the (already Done) ticket. The card transitions to `done` state but the message includes a soft-warning line: `Comment posted on ... but Move-to-Done failed: ...`.

- [ ] **Step 8: Negative — unrelated ticket.**

  1. Open a wallet-provisioning ticket (no Visa Companion language).
  2. Confirm the VisaCompanionCard does NOT appear.
  3. Other relevant cards (WalletTriageCard etc.) still appear as today.

- [ ] **Step 9: Negative — no reporter.**

  1. Find or simulate a ticket with no `reporter` field.
  2. Confirm the VisaCompanionCard does NOT appear (gated on `ticket.reporter`).

- [ ] **Step 10: Error-and-retry path.**

  1. Temporarily revoke the Atlassian OAuth token (sign out via the side panel's settings, then sign back in halfway through).
  2. With a Visa Companion ticket open, click the card's button.
  3. `postComment` rejects → card shows the error banner with a `Retry` link.
  4. Click **Retry** → card returns to `idle`.
  5. (Restore the token, then re-test the happy path on a different ticket to confirm retry actually works.)

- [ ] **Step 11: Regression — all other recommendation cards.**

  1. CredRouteCard still fires on a CRED-bound ticket.
  2. QCAutoReimbCard still fires on a QC + fee + tier-upgrade ticket.
  3. OverpaymentTriageCard still fires on a credit card overpayment ticket.
  4. ReverseFeeCard still fires on a fee-reversal ticket.
  5. QCFeeWaiverCard still fires on a QC + annual-fee ticket (no eligibility flip).
  6. WalletTriageCard still fires on a wallet-provisioning ticket.

---

## Self-Review Summary

After writing the plan, checked it against the spec:

- **Spec coverage:**
  - Detection signals + match rule → Task 1 Step 1 (`SIGNALS` array + match rule).
  - Config constants (Guru URL, doc URL, phone) → Task 1 Step 2.
  - Card states `idle` / `posting` / `done` / `error` → Task 2 Step 1 (`useState<CardState>`).
  - Hide when `!ticket.reporter` → Task 2 Step 1 (early `if (!ticket.reporter) return null`).
  - Comment preview with @mention pill + link styling → Task 2 Step 1 (`previewStyle` block).
  - ADF segment building (text + mention + link + text + link + text) → Task 2 Step 1 (`segments` array).
  - `postComment` + soft-fail `transitionTicket` → Task 2 Step 1 (`postAndMoveToDone`).
  - `done` state's success panel + optional soft warning → Task 2 Step 1 (early return for `state === 'done'`).
  - Mount at bottom of stack after WalletTriageCard → Task 2 Step 3.
  - Manual verification covers happy / soft-warning / negative-unrelated / negative-no-reporter / error-retry / regression → Task 2 Steps 6–11.
- **Placeholder scan:** No "TBD"/"TODO"/"implement later". All code blocks complete; manual steps name exact buttons + cards + expected text.
- **Type consistency:** `VisaCompanionDetection`, `detectVisaCompanion`, `VISA_COMPANION_GURU_URL`, `VISA_COMPANION_DOC_URL`, `VISA_COMPANION_CONCIERGE_PHONE`, `CardState`, `VisaCompanionCard` — names match across Task 1 / Task 2. `postComment` and `transitionTicket` signatures consistent with their usage in other workflows.
- **Scope:** One focused feature, four files (3 new + 1 modified), two tasks. Single plan is right-sized.
