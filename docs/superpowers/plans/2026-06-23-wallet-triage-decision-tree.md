# Wallet Triage Decision Tree — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Wallet Triage's single fixed-comment Step 2 with a two-sub-step decision flow: pick one of 5 outcomes from the investigation guide, then review/edit the templated comment, then post (and transition to Done for outcomes A–D; leave open for outcome E).

**Architecture:** `src/data/walletTriageConfig.ts` gains a `WALLET_TRIAGE_OUTCOMES` array (5 entries: label, subtitle, body template, `shouldTransition`) and a `buildOutcomeCommentText` helper. `src/sidepanel/WalletTriageWorkflow.tsx` is restructured from 2 active steps to 3 active steps + complete: Step 1 unchanged (open dashboard & doc), new Step 2 = outcome picker, new Step 3 = editable comment + submit. At submit time the workflow splits the textarea text on the literal `@<reporter name>` and doc URL substrings to emit ADF mention + link nodes — graceful degradation if the agent deletes either while editing.

**Tech Stack:** TypeScript, React (functional + hooks), Vite (build via `npm run build`), Chrome MV3 extension. No test framework; verification is manual via load-unpacked + clicking through a real wallet-provisioning WOCOO ticket.

## Global Constraints

- **No automated tests.** Each task ends with `npm run build` (from `~/projects/wocoo-extension/extension/`) + a documented manual verification step. Do not introduce a test framework.
- **Not a git repository.** Skip every "commit" step. Tasks complete when manual verification passes.
- **Do not regress existing flows.** OverpaymentTriage, QC Fee Waiver, Reverse Fee, Clone/Move, Create REIMB Ticket, Verify Eligible DD, and the **Wallet Triage detection card + manual button + Step 1** must all work exactly as they do today. Only Steps 2+ of Wallet Triage are restructured.
- **Existing code style:** TypeScript, semicolons, single quotes, 2-space indent, React functional components, no default exports.
- **Outcomes A–D** (`MAX_TOKEN_LIMIT`, `DEVICE_TOKEN_MATCH`, `NO_DECLINE`, `DEVICE_SCORE`) transition the source ticket to Done. **Outcome E** (`WOCOO_REVIEW`) does NOT transition — ticket stays open for downstream review.
- **Done transition id** = `'251'` (unchanged from prior workflows).
- **Reload the unpacked extension** in `chrome://extensions` after every build before manual verification.

---

## File Structure

| Path | Change |
|---|---|
| `src/data/walletTriageConfig.ts` | Add `WalletTriageOutcomeKey` type, `WalletTriageOutcome` interface, `WALLET_TRIAGE_OUTCOMES` array (5 entries), `buildOutcomeCommentText` helper. Remove `WALLET_TRIAGE_COMMENT_TEXT_AFTER_MENTION` at the end of Task 2 (after no consumer references it). |
| `src/sidepanel/WalletTriageWorkflow.tsx` | Restructure: `StepNum` becomes `1 \| 2 \| 3 \| 4`, `STEP_TITLES`/`STEP_SUBTITLES` grow to cover step 3, header counter shows "Step N of 3" or "Complete", `ProgressDots` renders 3 dots. New state (`selectedOutcome`, `commentText`, `commentDirty`). New `selectOutcome` and `submitComment` handlers. Drop the old `postAndMoveToDone`. Render loop maps steps 1/2/3 to ExpandedCard/FutureStub and Step 4 to a success panel. ADF segment builder at submit time. |
| All other files | Unchanged. |

---

## Task 1: Add outcomes + builder to walletTriageConfig.ts

**Files:**
- Modify: `src/data/walletTriageConfig.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `type WalletTriageOutcomeKey = 'MAX_TOKEN_LIMIT' | 'DEVICE_TOKEN_MATCH' | 'NO_DECLINE' | 'DEVICE_SCORE' | 'WOCOO_REVIEW'`
  - `interface WalletTriageOutcome { key: WalletTriageOutcomeKey; label: string; subtitle: string; bodyTemplate: string; shouldTransition: boolean }`
  - `const WALLET_TRIAGE_OUTCOMES: WalletTriageOutcome[]` — 5 entries
  - `function buildOutcomeCommentText(reporterName: string, docUrl: string, body: string): string`

This task is **additive only** — `WALLET_TRIAGE_COMMENT_TEXT_AFTER_MENTION` stays in place so the workflow still builds. Task 2 removes it when no consumer remains.

- [ ] **Step 1: Open `src/data/walletTriageConfig.ts`.** Locate the existing `WALLET_TRIAGE_COMMENT_TEXT_AFTER_MENTION` export at the bottom of the file. Leave it.

- [ ] **Step 2: Append the new types, outcomes array, and helper** at the end of the file:

```ts

// ===== Decision tree outcomes (Step 2 of the workflow) =====

export type WalletTriageOutcomeKey =
  | 'MAX_TOKEN_LIMIT'
  | 'DEVICE_TOKEN_MATCH'
  | 'NO_DECLINE'
  | 'DEVICE_SCORE'
  | 'WOCOO_REVIEW';

export interface WalletTriageOutcome {
  key: WalletTriageOutcomeKey;
  /** Card title shown in the Step 2 picker. */
  label: string;
  /** One-line description shown under the title — names the chart that triggers this outcome. */
  subtitle: string;
  /** Template body — comes after "Hi @<reporter> after looking into the Preset dashboard doc <doc-url> ". */
  bodyTemplate: string;
  /** true → transition to Done on submit; false → leave the ticket open. */
  shouldTransition: boolean;
}

export const WALLET_TRIAGE_OUTCOMES: WalletTriageOutcome[] = [
  {
    key: 'MAX_TOKEN_LIMIT',
    label: 'Max token limit hit',
    subtitle: 'Step 1 chart: distinct_token_count = 20',
    bodyTemplate:
      'I can see that the client has hit the maximum token limit (20 tokens). ' +
      'A token must be deactivated before a new one can be added. ' +
      'Please ask the client to deactivate an existing token first, then retry.',
    shouldTransition: true,
  },
  {
    key: 'DEVICE_TOKEN_MATCH',
    label: 'Active device token matches',
    subtitle: "Step 2 chart: token_device_number matches client's device",
    bodyTemplate:
      "I can see there's an active device token matching the client's device. " +
      "I'll deactivate the matching token in i2c — please ask the client to try adding the card again.",
    shouldTransition: true,
  },
  {
    key: 'NO_DECLINE',
    label: 'No decline on record',
    subtitle: 'Step 3 chart: empty / blank error_message',
    bodyTemplate:
      "I don't see any decline on record. " +
      'Please ask the client to try adding the card again; escalate if the issue persists.',
    shouldTransition: true,
  },
  {
    key: 'DEVICE_SCORE',
    label: 'Device score issue',
    subtitle: 'Step 3 chart: error_message present + scr_info_devicescore ≤ 3',
    bodyTemplate:
      'I can see that the decline is due to a device score issue. ' +
      'Please send the client the device score macro.',
    shouldTransition: true,
  },
  {
    key: 'WOCOO_REVIEW',
    label: 'Other decline — WOCOO review',
    subtitle: 'Step 3 chart: error_message present + scr_info_devicescore > 3',
    bodyTemplate:
      "I see a decline that isn't related to device score. Cutting to WOCOO for review.",
    shouldTransition: false,
  },
];

/**
 * Build the full templated comment text the Step 3 textarea pre-fills with.
 * The literal "@<reporter name>" and doc URL substrings inside the result are
 * detected at submit time and re-emitted as ADF mention + link nodes.
 */
export function buildOutcomeCommentText(reporterName: string, docUrl: string, body: string): string {
  return `Hi @${reporterName} after looking into the Preset dashboard doc ${docUrl} ${body}`;
}
```

- [ ] **Step 3: Build to confirm TypeScript compiles.**

Run from `~/projects/wocoo-extension/extension/`:
```bash
npm run build
```
Expected: build completes with no TypeScript errors. The existing `WALLET_TRIAGE_COMMENT_TEXT_AFTER_MENTION` is still exported and consumed by `WalletTriageWorkflow.tsx` (which compiles unchanged at this point).

---

## Task 2: Restructure WalletTriageWorkflow.tsx for the 3-active-step decision flow

**Files:**
- Modify: `src/sidepanel/WalletTriageWorkflow.tsx` (full rewrite of the file body — keep the file path, replace contents).
- Modify: `src/data/walletTriageConfig.ts` (remove the now-orphaned `WALLET_TRIAGE_COMMENT_TEXT_AFTER_MENTION` constant at the end).

**Interfaces:**
- Consumes:
  - From Task 1: `WALLET_TRIAGE_DASHBOARD_URL`, `WALLET_TRIAGE_DOC_URL`, `WALLET_TRIAGE_OUTCOMES`, `WalletTriageOutcome`, `buildOutcomeCommentText`.
  - Existing: `WocooTicket`, `postComment`, `transitionTicket`, `type CommentSegment`.
- Produces: same exported `WalletTriageWorkflow` component signature — no API change to `SidePanel.tsx`.

- [ ] **Step 1: Replace the entire contents of `src/sidepanel/WalletTriageWorkflow.tsx`** with the following. Path is unchanged.

```tsx
// Wallet Triage workflow — 3 active steps + complete.
//
// Step 1: Open dashboard + doc (queues identity_id filter via chrome.storage.local;
//         the Preset content script handles clearing chips, typing, and Apply Filters).
// Step 2: Pick the outcome from a flat list of 5 cards sourced from the investigation
//         guide (Max Token / Device Match / No Decline / Device Score / WOCOO Review).
// Step 3: Review the pre-filled comment, edit if needed, then Post & Move to Done
//         (or just Post for the WOCOO Review outcome, which leaves the ticket open).

import { useEffect, useState } from 'react';
import type { WocooTicket } from '../data/mockTicket';
import { postComment, transitionTicket, type CommentSegment } from '../api/jira';
import {
  WALLET_TRIAGE_DASHBOARD_URL,
  WALLET_TRIAGE_DOC_URL,
  WALLET_TRIAGE_OUTCOMES,
  type WalletTriageOutcome,
  buildOutcomeCommentText,
} from '../data/walletTriageConfig';

type StepNum = 1 | 2 | 3 | 4;

const STEP_TITLES: Record<Exclude<StepNum, 4>, string> = {
  1: 'Open dashboard & doc',
  2: 'Pick outcome',
  3: 'Review & post comment',
};

const STEP_SUBTITLES: Record<Exclude<StepNum, 4>, string> = {
  1: 'Both tabs open at once; auto-filters by identity_id',
  2: 'Choose what you found on the dashboard',
  3: 'Edit if needed, then post',
};

export function WalletTriageWorkflow({ ticket, onClose, onTicketUpdate }: {
  ticket: WocooTicket;
  onClose: () => void;
  onTicketUpdate: (t: WocooTicket) => void;
}) {
  const [step, setStep] = useState<StepNum>(1);
  const [openedBoth, setOpenedBoth] = useState(false);
  const [selectedOutcome, setSelectedOutcome] = useState<WalletTriageOutcome | null>(null);
  const [commentText, setCommentText] = useState<string>('');
  const [commentDirty, setCommentDirty] = useState<boolean>(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [softWarning, setSoftWarning] = useState<string | null>(null);

  const reporterName = ticket.reporter || 'team';

  // Close on Esc when not mid-network-call
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, busy]);

  // Re-template the textarea whenever selectedOutcome changes, unless the agent has
  // already edited it. Clearing the textarea to empty resets dirty so the template can re-fill.
  useEffect(() => {
    if (!selectedOutcome) return;
    if (commentDirty) return;
    setCommentText(buildOutcomeCommentText(reporterName, WALLET_TRIAGE_DOC_URL, selectedOutcome.bodyTemplate));
  }, [selectedOutcome, commentDirty, reporterName]);

  function onCommentChange(v: string) {
    setCommentText(v);
    setCommentDirty(v !== '');
  }

  async function openDashboardAndDoc() {
    if (!ticket.identityId) {
      setError('Source ticket has no Identity ID — dashboard filter requires it.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
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

  function selectOutcome(o: WalletTriageOutcome) {
    setSelectedOutcome(o);
    setCommentDirty(false); // re-template
    setStep(3);
    setError(null);
  }

  function backToOutcomes() {
    setStep(2);
    setError(null);
  }

  async function submitComment() {
    if (!selectedOutcome) {
      setError('No outcome selected.');
      return;
    }
    if (!commentText.trim()) {
      setError('Comment is empty.');
      return;
    }
    setBusy(true);
    setError(null);
    setSoftWarning(null);
    try {
      const reporterAccountId = (ticket as any).reporterAccountId as string | undefined;
      const segments = buildAdfSegments(commentText, reporterName, WALLET_TRIAGE_DOC_URL, reporterAccountId);
      await postComment(ticket.id, segments);

      if (selectedOutcome.shouldTransition) {
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
      }

      setStep(4);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  function renderStepCard(n: Exclude<StepNum, 4>) {
    const isCompleted = n < step;
    const isActive = n === step;
    if (isCompleted) return <ExpandedCard key={n} n={n} completed>{renderBody(n)}</ExpandedCard>;
    if (isActive) return <ExpandedCard key={n} n={n}>{renderBody(n)}</ExpandedCard>;
    return <FutureStub key={n} n={n} />;
  }

  function renderBody(n: Exclude<StepNum, 4>) {
    if (n === 1) {
      return (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{ fontSize: 'var(--mint-text-meta)', color: 'var(--mint-fg-strong)', marginBottom: 'var(--mint-sp-2)', lineHeight: 1.5 }}>
            Opens the Preset dashboard pre-filtered to <strong>{ticket.identityId}</strong> and the reference Google Doc, both in new tabs.
          </div>
          {openedBoth ? (
            <div style={{ fontSize: 'var(--mint-text-micro)', color: 'var(--mint-positive-fg-strong)', marginBottom: 'var(--mint-sp-2)' }}>
              ✓ Opened both — click any tab to review.
            </div>
          ) : null}
          {step === 1 ? (
            <button
              onClick={openDashboardAndDoc}
              disabled={busy || !ticket.identityId}
              style={{ ...primaryButton, opacity: !ticket.identityId ? 0.55 : 1, cursor: !ticket.identityId ? 'not-allowed' : 'pointer' }}
            >
              {busy ? 'Opening…' : '↗ Open dashboard + doc'}
            </button>
          ) : null}
        </div>
      );
    }
    if (n === 2) {
      if (step !== 2) {
        // Completed view: just show which outcome was picked.
        return (
          <div style={{ fontSize: 'var(--mint-text-meta)', color: 'var(--mint-positive-fg-strong)' }}>
            Picked: <strong>{selectedOutcome?.label}</strong>
          </div>
        );
      }
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--mint-sp-2)' }}>
          <div style={{ fontSize: 'var(--mint-text-meta)', color: 'var(--mint-fg-strong)', marginBottom: 'var(--mint-sp-2)', lineHeight: 1.5 }}>
            What did the dashboard show?
          </div>
          {WALLET_TRIAGE_OUTCOMES.map((o) => (
            <button
              key={o.key}
              onClick={() => selectOutcome(o)}
              disabled={busy}
              style={outcomeCardStyle}
            >
              <div style={{ fontWeight: 700, fontSize: 'var(--mint-text-meta)', color: 'var(--mint-fg-strong)' }}>{o.label}</div>
              <div style={{ fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-soft)', marginTop: 2 }}>{o.subtitle}</div>
            </button>
          ))}
        </div>
      );
    }
    if (n === 3) {
      return (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{ fontSize: 'var(--mint-text-meta)', color: 'var(--mint-fg-strong)', marginBottom: 6, lineHeight: 1.5 }}>
            Selected: <strong>{selectedOutcome?.label}</strong>
          </div>
          <textarea
            value={commentText}
            disabled={busy}
            onChange={(e) => onCommentChange(e.target.value)}
            rows={5}
            style={textareaStyle}
          />
          <div style={{ marginTop: 4, fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-soft)' }}>
            {commentDirty
              ? 'Edited manually. Clear the field to restore the template.'
              : 'Auto-filled from the selected outcome.'}
          </div>
          <div style={{ display: 'flex', gap: 'var(--mint-sp-2)', marginTop: 'var(--mint-sp-3)', alignItems: 'center' }}>
            <button onClick={backToOutcomes} disabled={busy} style={linkButton}>← Back</button>
            <button
              onClick={submitComment}
              disabled={busy || !commentText.trim()}
              style={{ ...primaryButton, flex: 1, opacity: (busy || !commentText.trim()) ? 0.6 : 1, cursor: (busy || !commentText.trim()) ? 'not-allowed' : 'pointer' }}
            >
              {busy
                ? (selectedOutcome?.shouldTransition ? 'Posting & moving…' : 'Posting…')
                : (selectedOutcome?.shouldTransition ? 'Post & Move to Done' : 'Post (leave open)')}
            </button>
          </div>
        </div>
      );
    }
    return null;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh', background: 'var(--mint-bg-page)' }}>
      <Header ticketId={ticket.id} step={step} onClose={onClose} />

      <div style={{ padding: 'var(--mint-sp-3)', display: 'flex', flexDirection: 'column', gap: 'var(--mint-sp-2)' }}>
        {error ? (
          <div role="alert" style={errorBanner}>⚠ {error}</div>
        ) : null}

        {step === 4 ? (
          <section style={successPanelStyle}>
            <div style={successBadgeStyle}>✓</div>
            <h3 style={{ margin: 0, fontSize: 'var(--mint-text-h-md)', color: 'var(--mint-fg-strong)', fontWeight: 700 }}>Triage complete</h3>
            <p style={{ margin: 'var(--mint-sp-2) 0 var(--mint-sp-3)', fontSize: 'var(--mint-text-meta)', color: 'var(--mint-fg-subdued-title)', lineHeight: 1.6 }}>
              Comment posted on{' '}
              <a href={`https://wealthsimple.atlassian.net/browse/${ticket.id}`} target="_blank" rel="noreferrer" style={{ color: 'var(--mint-highlight-fg-strong)', fontWeight: 600 }}>
                {ticket.id}
              </a>
              {selectedOutcome?.shouldTransition
                ? (softWarning ? '' : ' and source ticket transitioned to Done.')
                : '. Ticket left open for WOCOO review.'}
            </p>
            {softWarning ? (
              <div style={softWarningBox}>{softWarning}</div>
            ) : null}
            <button onClick={onClose} style={primaryButton}>Close</button>
          </section>
        ) : (
          ([1, 2, 3] as Exclude<StepNum, 4>[]).map(renderStepCard)
        )}
      </div>
    </div>
  );
}

// ===== ADF segment building =====

/**
 * Split the comment text on the literal "@<reporterName>" and doc URL substrings
 * and emit ADF segments in order. If either substring is absent, that segment
 * type is omitted — the rest still posts as plain text.
 */
function buildAdfSegments(
  text: string,
  reporterName: string,
  docUrl: string,
  reporterAccountId: string | undefined,
): CommentSegment[] {
  const mentionLiteral = '@' + reporterName;
  const segments: CommentSegment[] = [];

  // First pass: split on the @mention literal.
  const mIdx = text.indexOf(mentionLiteral);
  let beforeMention = text;
  let afterMention = '';
  if (mIdx !== -1) {
    beforeMention = text.slice(0, mIdx);
    afterMention = text.slice(mIdx + mentionLiteral.length);
  }

  // Second pass on `afterMention`: split on the doc URL literal.
  let beforeUrl = afterMention;
  let afterUrl = '';
  let foundUrl = false;
  if (afterMention) {
    const uIdx = afterMention.indexOf(docUrl);
    if (uIdx !== -1) {
      beforeUrl = afterMention.slice(0, uIdx);
      afterUrl = afterMention.slice(uIdx + docUrl.length);
      foundUrl = true;
    }
  }

  // If no @mention literal was found, the entire text is one text segment.
  if (mIdx === -1) {
    if (text) segments.push({ type: 'text', text });
    return segments;
  }

  // before mention
  if (beforeMention) segments.push({ type: 'text', text: beforeMention });
  // mention (with fallback to plain text)
  if (reporterAccountId) {
    segments.push({ type: 'mention', text: mentionLiteral, accountId: reporterAccountId });
  } else {
    segments.push({ type: 'text', text: mentionLiteral });
  }
  // between mention and url
  if (beforeUrl) segments.push({ type: 'text', text: beforeUrl });
  // url (link) if found
  if (foundUrl) {
    segments.push({ type: 'link', text: docUrl, href: docUrl });
  }
  // tail after url (or all of afterMention if no url found)
  if (foundUrl) {
    if (afterUrl) segments.push({ type: 'text', text: afterUrl });
  }
  return segments;
}

// ===== header + step cards =====

function Header({ ticketId, step, onClose }: { ticketId: string; step: StepNum; onClose: () => void }) {
  const total = 3;
  const displayStep = step === 4 ? total : Math.min(step, total);
  return (
    <header style={{ position: 'sticky', top: 0, zIndex: 50, background: 'var(--mint-bg-card)', borderBottom: 'var(--mint-card-stroke)', padding: 'var(--mint-sp-3) var(--mint-sp-3) var(--mint-sp-2)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <button onClick={onClose} title="Back to ticket" style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--mint-fg-soft)', fontSize: 16, padding: 4 }}>←</button>
        <a href={`https://wealthsimple.atlassian.net/browse/${ticketId}`} target="_blank" rel="noreferrer" style={{ color: 'var(--mint-highlight-fg-strong)', fontWeight: 700, fontSize: 'var(--mint-text-meta)', textDecoration: 'none' }}>{ticketId}</a>
        <span style={{ marginLeft: 'auto', fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-soft)' }}>
          {step === 4 ? 'Complete' : `Step ${displayStep} of ${total}`}
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <h2 style={{ margin: 0, fontSize: 'var(--mint-text-h-md)', fontWeight: 700, color: 'var(--mint-fg-strong)' }}>Wallet Triage</h2>
        <ProgressDots step={step} />
      </div>
    </header>
  );
}

function ProgressDots({ step }: { step: StepNum }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      {[1, 2, 3].map((n) => {
        const done = step === 4 || n < step;
        const active = step !== 4 && n === step;
        if (done) return <span key={n} style={{ width: 14, height: 14, borderRadius: 9999, background: 'var(--mint-positive-fg-graphic)', color: '#fff', fontSize: 9, fontWeight: 800, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>✓</span>;
        if (active) return <span key={n} style={{ width: 10, height: 10, borderRadius: 9999, background: 'var(--mint-fg-strong)' }} />;
        return <span key={n} style={{ width: 10, height: 10, borderRadius: 9999, border: '1.5px solid var(--mint-outline-strong)' }} />;
      })}
    </div>
  );
}

function ExpandedCard({ n, children, completed }: { n: Exclude<StepNum, 4>; children: React.ReactNode; completed?: boolean }) {
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

function FutureStub({ n }: { n: Exclude<StepNum, 4> }) {
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

// ===== styles =====

const primaryButton: React.CSSProperties = {
  padding: '8px 14px', borderRadius: 'var(--mint-radius-button)', fontWeight: 600,
  fontSize: 'var(--mint-text-meta)', border: 'none',
  background: 'var(--mint-fg-strong)', color: 'var(--mint-fg-inverted)', cursor: 'pointer',
};

const linkButton: React.CSSProperties = {
  background: 'transparent', border: 'none', cursor: 'pointer',
  color: 'var(--mint-fg-soft)', fontSize: 'var(--mint-text-meta)', fontWeight: 600,
  padding: '4px 0',
};

const outcomeCardStyle: React.CSSProperties = {
  display: 'block',
  textAlign: 'left',
  padding: 'var(--mint-sp-3)',
  background: 'var(--mint-bg-card)',
  border: 'var(--mint-card-stroke)',
  borderRadius: 'var(--mint-radius-button)',
  cursor: 'pointer',
  width: '100%',
};

const textareaStyle: React.CSSProperties = {
  width: '100%',
  padding: 'var(--mint-sp-2)',
  fontFamily: 'var(--mint-font-family)',
  fontSize: 'var(--mint-text-meta)',
  border: 'var(--mint-card-stroke)',
  borderRadius: 'var(--mint-radius-button)',
  background: 'var(--mint-bg-card)',
  color: 'var(--mint-fg-strong)',
  boxSizing: 'border-box',
  lineHeight: 1.5,
  resize: 'vertical',
};

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

const errorBanner: React.CSSProperties = {
  background: 'var(--mint-negative-bg-soft)',
  color: 'var(--mint-negative-fg-strong)',
  padding: 'var(--mint-sp-2) var(--mint-sp-3)',
  borderRadius: 'var(--mint-radius-button)',
  fontSize: 'var(--mint-text-meta)',
};

const successPanelStyle: React.CSSProperties = {
  background: 'var(--mint-positive-bg-soft)',
  border: '1px solid var(--mint-positive-fg-graphic)',
  borderRadius: 'var(--mint-radius-card)',
  padding: 'var(--mint-sp-4)',
  textAlign: 'center',
};

const successBadgeStyle: React.CSSProperties = {
  width: 48, height: 48, margin: '0 auto var(--mint-sp-2)', borderRadius: 9999,
  background: 'var(--mint-positive-fg-graphic)', color: '#fff', fontSize: 24, fontWeight: 800,
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
};

const softWarningBox: React.CSSProperties = {
  background: 'var(--mint-warning-bg-soft)',
  border: '1px solid var(--mint-warning-fg-graphic)',
  borderRadius: 'var(--mint-radius-button)',
  padding: 'var(--mint-sp-2) var(--mint-sp-3)',
  fontSize: 'var(--mint-text-nano)',
  color: 'var(--mint-warning-fg-strong)',
  textAlign: 'left',
  marginBottom: 'var(--mint-sp-3)',
};
```

- [ ] **Step 2: Remove the obsolete `WALLET_TRIAGE_COMMENT_TEXT_AFTER_MENTION` constant** from `src/data/walletTriageConfig.ts`. Find and delete this block:

```ts
// Comment template — agent's check-in to the reporter. Appended after the
// "Hi " + @reporter mention segment built by the workflow component.
export const WALLET_TRIAGE_COMMENT_TEXT_AFTER_MENTION =
  ' have you checked the Preset dash and doc yet?';
```

The new workflow doesn't import it; nothing else in the codebase references it.

- [ ] **Step 3: Build to confirm TypeScript compiles.**

Run from `~/projects/wocoo-extension/extension/`:
```bash
npm run build
```
Expected: build completes without TypeScript errors.

- [ ] **Step 4: Sanity-grep for stale references** to the removed constant:

```bash
grep -rn WALLET_TRIAGE_COMMENT_TEXT_AFTER_MENTION /Users/albert.cai/projects/wocoo-extension/extension/src/
```
Expected: no matches.

- [ ] **Step 5: Reload the extension.** `chrome://extensions` → reload "WOCOO Triager".

- [ ] **Step 6: End-to-end test — Outcome D (device score), the user's reference case.**

  1. Open WOCOO-23426 (or any wallet-provisioning ticket).
  2. Click the auto-detect card's **Start Wallet Triage**.
  3. Step 1 → **↗ Open dashboard + doc**. Two tabs open, Preset auto-filters.
  4. Step 2 should now show 5 outcome cards: "Max token limit hit", "Active device token matches", "No decline on record", "Device score issue", "Other decline — WOCOO review".
  5. Click **Device score issue**.
  6. Step 3 textarea should pre-fill: `Hi @<reporter> after looking into the Preset dashboard doc https://docs.google.com/... I can see that the decline is due to a device score issue. Please send the client the device score macro.`
  7. Verify the submit button reads **Post & Move to Done**.
  8. Click submit. Open Jira and confirm: the comment posted with a clickable @mention pill, a clickable doc link, and the source ticket transitioned to Done.

- [ ] **Step 7: End-to-end test — Outcome E (WOCOO review, no transition).**

  1. On a different (or same — agent's call) wallet-provisioning ticket, walk to Step 3.
  2. Pick **Other decline — WOCOO review**.
  3. Verify the submit button reads **Post (leave open)** (no Move to Done).
  4. Click submit. Verify the comment posts AND the source ticket **stays in its current status** (not Done). Success panel reads "Ticket left open for WOCOO review."

- [ ] **Step 8: End-to-end test — Edit-before-post.**

  1. Walk to Step 3 with any outcome.
  2. Edit the textarea (add a sentence or change wording). Hint text should flip to "Edited manually. Clear the field to restore the template."
  3. Submit. Verify the posted Jira comment contains the edited text and still has the @mention pill + doc link (because the literal `@<name>` and URL substrings were preserved during the edit).

- [ ] **Step 9: Re-pick path.**

  1. Open the workflow, advance to Step 2, pick outcome A.
  2. On Step 3, click **← Back**. Step 2 reappears.
  3. Pick outcome B. Step 3 re-templates with B's text (textarea isn't dirty because the agent never edited).

- [ ] **Step 10: Negative — empty textarea.**

  1. Walk to Step 3, delete all text from the textarea.
  2. Submit button is disabled.

- [ ] **Step 11: Regression — detection card + manual button still work.**

  1. Auto-detect card still appears on WOCOO-23426. Click Start Wallet Triage → workflow opens.
  2. Manual button **💳 Wallet Triage** in QuickActions row 2 launches the same workflow.

- [ ] **Step 12: Regression — Verify Eligible DD still works.**

  1. On any ticket with identityId, click **📊 Verify Eligible DD**. Confirm the existing dashboard still applies its identity filter (chip clears + new identity types + Apply Filters clicks).

---

## Self-Review Summary

After writing the plan, checked it against the spec:

- **Spec coverage:**
  - 5 outcomes, types, helper → Task 1 Step 2.
  - 3-active-step workflow shape (Open / Pick / Review) + Complete → Task 2 Step 1.
  - StepNum `1 | 2 | 3 | 4` + step counter "Step N of 3" / "Complete" → Task 2 Step 1 (Header).
  - Outcome picker as flat cards on Step 2 → Task 2 Step 1 (`renderBody(2)`).
  - Editable textarea with dirty-flag re-template → Task 2 Step 1 (`useEffect` on `selectedOutcome` + `onCommentChange`).
  - Submit button label varies by `shouldTransition` → Task 2 Step 1 (button label ternary).
  - Outcomes A–D transition; E doesn't → Task 2 Step 1 (`submitComment` checks `selectedOutcome.shouldTransition`).
  - ADF substring detection with graceful degradation → Task 2 Step 1 (`buildAdfSegments`).
  - Success panel: two variants per outcome → Task 2 Step 1 (success section ternary on `shouldTransition`).
  - Comment templates verbatim → Task 1 Step 2 (the 5 `bodyTemplate` strings) + Task 2 verification steps.
  - Soft-warning treatment unchanged → Task 2 Step 1 (`submitComment` inner try/catch on transition).
  - Remove `WALLET_TRIAGE_COMMENT_TEXT_AFTER_MENTION` → Task 2 Step 2.
  - Manual verification covers all 5 outcomes' submit paths (D + E explicitly; A/B/C use the same code path as D, which is the path tested in Step 6).
- **Placeholder scan:** No "TBD"/"TODO"/"implement later". All code blocks complete; all manual steps name the exact buttons/inputs.
- **Type consistency:** `WalletTriageOutcomeKey`, `WalletTriageOutcome`, `WALLET_TRIAGE_OUTCOMES`, `buildOutcomeCommentText` defined in Task 1 and consumed in Task 2 with matching property names. `StepNum`, `selectedOutcome`, `commentText`, `commentDirty` are all introduced in Task 2 Step 1 and used consistently.
- **Scope:** One focused feature, two files, two tasks. Single plan is right-sized.
