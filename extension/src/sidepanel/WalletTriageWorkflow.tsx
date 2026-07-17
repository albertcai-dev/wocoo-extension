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
