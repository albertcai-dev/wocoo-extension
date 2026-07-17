// Reverse Fee workflow — 2 steps with a success state.
//
// Step 1: Fee reverse — opens the i2c auto-chain in a new tab; agent reviews and submits
//         the Reverse Fee form there, then comes back and clicks "✓ Fee Reversed".
// Step 2: Post comment & Mark as Done — pre-filled "Hi @reporter, the fee has been
//         reversed!" comment posted via ADF + Jira transition to Done in one action.
// Step 3: Success — confirmation panel.
//
// Visual conventions match OverpaymentTriage.tsx: completed steps stay expanded with a
// green border and ✓ in the number slot; active step is a white card with subtitle.

import { useEffect, useState } from 'react';
import type { WocooTicket } from '../data/mockTicket';
import { postComment, transitionTicket } from '../api/jira';
import { fetchAtlasClientEmailHeadless } from '../data/atlasAccountLookup';
import { isInterestRelatedWorkType, isInterestFeeInContent } from '../data/reverseFeeDetect';

const TRANSITION_TO_DONE_ID = '251';
const I2C_LOGIN_URL = 'https://wealthsimplecs.mycardplace.com/customerservice/wealthsimplelogin.jsp';

type StepNum = 1 | 2 | 3;

const STEP_TITLES: Record<StepNum, string> = {
  1: 'Fee reverse',
  2: 'Post comment & Mark as Done',
  3: 'Complete',
};

const STEP_SUBTITLES: Record<StepNum, string> = {
  1: 'Apply the reversal in i2c, then confirm',
  2: 'Review, then post + close the ticket',
  3: '',
};

export function ReverseFeeWorkflow({ ticket, onClose, onTicketUpdate }: { ticket: WocooTicket; onClose: () => void; onTicketUpdate: (t: WocooTicket) => void }) {
  const isInterestFlow = isInterestRelatedWorkType(ticket.workType)
    || isInterestFeeInContent(ticket.summary, ticket.description);
  const [step, setStep] = useState<StepNum>(1);
  // Fetched-from-Atlas email overrides the ticket's clientEmail when present. For
  // Interest-Related Issues tickets, the ticket usually doesn't carry an email.
  const [fetchedEmail, setFetchedEmail] = useState<string | null>(null);
  const [emailFetchState, setEmailFetchState] = useState<'idle' | 'pending' | 'error'>('idle');
  const [emailFetchError, setEmailFetchError] = useState<string | null>(null);
  const effectiveEmail = ticket.clientEmail || fetchedEmail || '';

  const [commentText, setCommentText] = useState<string>(buildInitialComment(ticket, isInterestFlow));
  const [commentEditing, setCommentEditing] = useState(false);
  const [commentPosted, setCommentPosted] = useState(false);
  const [transitionedToDone, setTransitionedToDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // For interest-related tickets that don't carry a clientEmail, auto-fetch from Atlas on
  // mount so the "Open i2c" step is ready without an extra click. Idempotent — only runs
  // when we're missing an email and haven't already tried.
  useEffect(() => {
    if (ticket.clientEmail || fetchedEmail || emailFetchState !== 'idle') return;
    if (!isInterestFlow || !ticket.identityId) return;
    setEmailFetchState('pending');
    setEmailFetchError(null);
    fetchAtlasClientEmailHeadless({ identityId: ticket.identityId, sourceTicketId: ticket.id })
      .then((email) => {
        setFetchedEmail(email);
        setEmailFetchState('idle');
      })
      .catch((e: any) => {
        setEmailFetchError(e?.message || 'Atlas email fetch failed');
        setEmailFetchState('error');
      });
  }, [ticket.clientEmail, ticket.identityId, ticket.id, isInterestFlow, fetchedEmail, emailFetchState]);

  const retryEmailFetch = () => {
    if (!ticket.identityId || emailFetchState === 'pending') return;
    setEmailFetchState('pending');
    setEmailFetchError(null);
    fetchAtlasClientEmailHeadless({ identityId: ticket.identityId, sourceTicketId: ticket.id })
      .then((email) => {
        setFetchedEmail(email);
        setEmailFetchState('idle');
      })
      .catch((e: any) => {
        setEmailFetchError(e?.message || 'Atlas email fetch failed');
        setEmailFetchState('error');
      });
  };

  const openI2c = async () => {
    if (effectiveEmail) {
      // Clear the interest-statement fallback tracker so a prior aborted chain doesn't
      // cause this new run to skip Recent Activity and jump straight to Current Statement.
      await chrome.storage.local.remove('pending_i2c_interest_stmt_attempted');
      // Await the write so the tab we're about to open sees these keys on its first
      // content-script pass. Without the await, the i2c login tab can race ahead and
      // read `pending_i2c_flow` as undefined, silently downgrading to the generic flow.
      await chrome.storage.local.set({
        pending_i2c_email: effectiveEmail,
        // Interest-Related Issues use a distinct chain: Recent Activity filter + Next
        // pagination to reach the Interest FinCharges row, then Current Statement fallback.
        pending_i2c_flow: isInterestFlow ? 'reverse_interest_fee' : 'reverse_fee',
        pending_i2c_ticket_url: `https://wealthsimple.atlassian.net/browse/${ticket.id}`,
        pending_i2c_started_at: Date.now(),
      });
    }
    window.open(I2C_LOGIN_URL, '_blank', 'noopener,noreferrer');
  };

  // Single combined action: post the comment, then transition to Done. If the comment
  // succeeds but the transition fails, surface the failure with a retry path that ONLY
  // runs the transition (so we don't double-post).
  async function doPostAndDone() {
    if (!commentText.trim()) { setError('Comment is empty.'); return; }
    setBusy(true); setError(null);
    try {
      if (!commentPosted) {
        const segments = buildCommentSegments(ticket, commentText);
        await postComment(ticket.id, segments);
        setCommentPosted(true);
      }
      await transitionTicket(ticket.id, TRANSITION_TO_DONE_ID);
      onTicketUpdate({ ...ticket, status: 'Done' });
      setTransitionedToDone(true);
      setStep(3);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  function renderStep(n: StepNum) {
    if (n === 3) return null;
    const isCompleted = n < step;
    const isActive = n === step;
    if (isCompleted) return <ExpandedCard key={n} n={n} completed>{renderBody(n, false)}</ExpandedCard>;
    if (isActive) return <ExpandedCard key={n} n={n}>{renderBody(n, true)}</ExpandedCard>;
    return <FutureStub key={n} n={n} />;
  }

  function renderBody(n: StepNum, onCurrentStep: boolean) {
    switch (n) {
      case 1: return (
        <Step1Body
          openI2c={openI2c}
          showActionButton={onCurrentStep}
          onConfirm={() => setStep(2)}
          emailFetchState={emailFetchState}
          emailFetchError={emailFetchError}
          effectiveEmail={effectiveEmail}
          onRetryEmail={retryEmailFetch}
        />
      );
      case 2: return (
        <Step2Body
          ticket={ticket}
          commentText={commentText}
          setCommentText={setCommentText}
          commentEditing={commentEditing}
          setCommentEditing={setCommentEditing}
          commentPosted={commentPosted}
          transitionedToDone={transitionedToDone}
          busy={busy}
          showActionButton={onCurrentStep}
          onPostAndDone={doPostAndDone}
        />
      );
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh', background: 'var(--mint-bg-page)' }}>
      <Header step={step} ticketId={ticket.id} onClose={onClose} />
      <div style={{ padding: 'var(--mint-sp-3)', display: 'flex', flexDirection: 'column', gap: 'var(--mint-sp-2)' }}>
        {error ? <div role="alert" style={errorBanner}>⚠ {error}</div> : null}
        {([1, 2] as StepNum[]).map(renderStep)}
        {step === 3 ? <SuccessPanel ticketId={ticket.id} onCloseToTicket={onClose} /> : null}
      </div>
    </div>
  );
}

// ============================================================
// Step 1 — Fee reverse (launches i2c chain, agent confirms when done)
// ============================================================

function Step1Body({
  openI2c,
  showActionButton,
  onConfirm,
  emailFetchState,
  emailFetchError,
  effectiveEmail,
  onRetryEmail,
}: {
  openI2c: () => void;
  showActionButton: boolean;
  onConfirm: () => void;
  emailFetchState: 'idle' | 'pending' | 'error';
  emailFetchError: string | null;
  effectiveEmail: string;
  onRetryEmail: () => void;
}) {
  const emailPending = emailFetchState === 'pending';
  const emailFailed = emailFetchState === 'error';
  const emailMissing = !effectiveEmail;
  const canOpenI2c = !emailMissing && !emailPending;

  return (
    <>
      <NumberedList>
        <NumberedItem n={1}>Open i2c — the customer is pre-loaded</NumberedItem>
        <NumberedItem n={2}>Click <strong>Reverse Fee</strong> on the matching transaction</NumberedItem>
        <NumberedItem n={3}>Submit the Fee Reversal Request with the ticket URL pre-pasted</NumberedItem>
      </NumberedList>
      {emailPending ? (
        <div style={emailStatusBox}>Fetching client email from Atlas…</div>
      ) : null}
      {emailFailed ? (
        <div style={{ ...emailStatusBox, background: 'var(--mint-negative-bg-soft)', color: 'var(--mint-negative-fg-strong)', border: '1px solid var(--mint-negative-fg-graphic)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <span>⚠ {emailFetchError || 'Atlas email fetch failed.'}</span>
          <button onClick={onRetryEmail} style={{ ...secondaryButton, padding: '4px 10px', fontSize: 'var(--mint-text-nano)' }}>Retry</button>
        </div>
      ) : null}
      {effectiveEmail && !emailPending ? (
        <div style={{ ...emailStatusBox, background: 'var(--mint-positive-bg-soft)', border: '1px solid var(--mint-positive-fg-graphic)', color: 'var(--mint-positive-fg-strong)' }}>
          ✓ Client email: <span style={{ fontFamily: 'var(--mint-font-mono)', color: 'var(--mint-fg-strong)' }}>{effectiveEmail}</span>
        </div>
      ) : null}
      <button
        onClick={openI2c}
        disabled={!canOpenI2c}
        style={{ ...pillLink('warning'), display: 'block', textAlign: 'center', marginTop: 'var(--mint-sp-3)', width: '100%', boxSizing: 'border-box', border: '1px solid var(--mint-warning-fg-graphic)', cursor: canOpenI2c ? 'pointer' : 'not-allowed', opacity: canOpenI2c ? 1 : 0.6 }}
      >
        Open i2c ↗
      </button>
      {showActionButton ? (
        <div style={{ marginTop: 'var(--mint-sp-2)' }}>
          <button onClick={onConfirm} style={{ ...primaryButton, width: '100%' }}>✓ Fee Reversed</button>
        </div>
      ) : null}
    </>
  );
}

const emailStatusBox: React.CSSProperties = {
  marginTop: 'var(--mint-sp-2)',
  padding: '6px 10px',
  background: 'var(--mint-bg-subtle)',
  border: 'var(--mint-card-stroke)',
  borderRadius: 'var(--mint-radius-button)',
  fontSize: 'var(--mint-text-micro)',
  color: 'var(--mint-fg-subdued-title)',
};

// ============================================================
// Step 2 — Post comment & Mark as Done (combined)
// ============================================================

function Step2Body(props: {
  ticket: WocooTicket;
  commentText: string;
  setCommentText: (v: string) => void;
  commentEditing: boolean;
  setCommentEditing: (v: boolean) => void;
  commentPosted: boolean;
  transitionedToDone: boolean;
  busy: boolean;
  showActionButton: boolean;
  onPostAndDone: () => void;
}) {
  // After clicking the action: if the comment posted but transition failed, the retry
  // button should say "Retry Move to Done" (and the comment textarea locks).
  const commentLocked = props.commentPosted;
  const buttonLabel = props.busy
    ? (props.commentPosted ? 'Moving to Done…' : 'Posting…')
    : props.commentPosted
      ? 'Retry Move to Done'
      : 'Post comment & Mark as Done';

  return (
    <>
      {props.commentEditing ? (
        <textarea
          value={props.commentText}
          onChange={(e) => props.setCommentText(e.target.value)}
          rows={4}
          disabled={commentLocked}
          style={{ width: '100%', padding: 'var(--mint-sp-2)', fontFamily: 'var(--mint-font-family)', fontSize: 'var(--mint-text-meta)', border: 'var(--mint-card-stroke)', borderRadius: 'var(--mint-radius-button)', background: commentLocked ? 'var(--mint-bg-subtle)' : 'var(--mint-bg-card)', boxSizing: 'border-box', lineHeight: 1.5 }}
        />
      ) : (
        <div style={{ padding: 'var(--mint-sp-3)', background: 'var(--mint-bg-subtle)', border: 'var(--mint-card-stroke)', borderRadius: 'var(--mint-radius-card)', fontSize: 'var(--mint-text-meta)', lineHeight: 1.6, color: 'var(--mint-fg-strong)' }}>
          <CommentPreview text={props.commentText} reporter={props.ticket.reporter} />
        </div>
      )}
      {props.commentPosted && !props.transitionedToDone ? (
        <div style={{ marginTop: 'var(--mint-sp-2)', fontSize: 'var(--mint-text-micro)', color: 'var(--mint-warning-fg-strong)' }}>
          ✓ Comment posted — but Move-to-Done didn't complete. Retry below.
        </div>
      ) : null}
      {props.showActionButton ? (
        <div style={{ marginTop: 'var(--mint-sp-2)', display: 'flex', gap: 'var(--mint-sp-2)' }}>
          {!props.commentPosted ? (
            <button onClick={() => props.setCommentEditing(!props.commentEditing)} style={{ ...secondaryButton, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              {props.commentEditing ? '✓ Done editing' : '✏ Edit'}
            </button>
          ) : null}
          <button onClick={props.onPostAndDone} disabled={props.busy} style={{ ...primaryButton, flex: 1, opacity: props.busy ? 0.6 : 1, cursor: props.busy ? 'wait' : 'pointer' }}>
            {buttonLabel}
          </button>
        </div>
      ) : null}
    </>
  );
}

function CommentPreview({ text, reporter }: { text: string; reporter: string }) {
  let working = text || '';
  const parts: React.ReactNode[] = [];
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
  if (working) parts.push(<span key={key++}>{working}</span>);
  return <>{parts}</>;
}

// ============================================================
// Step 3 — Success
// ============================================================

function SuccessPanel({ ticketId, onCloseToTicket }: { ticketId: string; onCloseToTicket: () => void }) {
  return (
    <section style={{ background: 'var(--mint-positive-bg-soft)', border: '1px solid var(--mint-positive-fg-graphic)', borderRadius: 'var(--mint-radius-card)', padding: 'var(--mint-sp-4)', textAlign: 'center' }}>
      <div style={{ width: 48, height: 48, margin: '0 auto var(--mint-sp-2)', borderRadius: 9999, background: 'var(--mint-positive-fg-graphic)', color: '#fff', fontSize: 24, fontWeight: 800, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>✓</div>
      <h3 style={{ margin: 0, fontSize: 'var(--mint-text-h-md)', color: 'var(--mint-fg-strong)', fontWeight: 700 }}>Reverse fee complete</h3>
      <p style={{ margin: 'var(--mint-sp-2) 0 var(--mint-sp-3)', fontSize: 'var(--mint-text-meta)', color: 'var(--mint-fg-subdued-title)', lineHeight: 1.6 }}>
        Fee reversed · Comment posted · Moved to Done
      </p>
      <button onClick={onCloseToTicket} style={{ ...primaryButton, width: '100%' }}>Close & return to ticket</button>
      <div style={{ fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-soft)', marginTop: 'var(--mint-sp-2)' }}>
        Open <a href={`https://wealthsimple.atlassian.net/browse/${ticketId}`} target="_blank" rel="noreferrer" style={{ color: 'var(--mint-highlight-fg-strong)' }}>{ticketId}</a> in Jira to verify.
      </div>
    </section>
  );
}

// ============================================================
// Header + visual primitives
// ============================================================

function Header({ step, ticketId, onClose }: { step: StepNum; ticketId: string; onClose: () => void }) {
  return (
    <header style={{ position: 'sticky', top: 0, zIndex: 50, background: 'var(--mint-bg-card)', borderBottom: 'var(--mint-card-stroke)', padding: 'var(--mint-sp-3) var(--mint-sp-3) var(--mint-sp-2)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <button onClick={onClose} title="Back to ticket" style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--mint-fg-soft)', fontSize: 16, padding: 4 }}>←</button>
        <a href={`https://wealthsimple.atlassian.net/browse/${ticketId}`} target="_blank" rel="noreferrer" style={{ color: 'var(--mint-highlight-fg-strong)', fontWeight: 700, fontSize: 'var(--mint-text-meta)', textDecoration: 'none' }}>{ticketId}</a>
        <span style={{ marginLeft: 'auto', fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-soft)' }}>Step {step} of 2</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <h2 style={{ margin: 0, fontSize: 'var(--mint-text-h-md)', fontWeight: 700, color: 'var(--mint-fg-strong)' }}>Reverse fee</h2>
        <ProgressDots step={step} />
      </div>
    </header>
  );
}

function ProgressDots({ step }: { step: StepNum }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      {[1, 2, 3].map((n) => {
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
      boxShadow: completed ? 'none' : '0 1px 3px rgba(20,17,12,0.04)',
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--mint-sp-2)', marginBottom: 'var(--mint-sp-3)' }}>
        {completed ? (
          <span style={{ width: 22, height: 22, borderRadius: 9999, background: 'var(--mint-positive-fg-graphic)', color: '#fff', fontSize: 12, fontWeight: 800, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>✓</span>
        ) : (
          <span style={stepNumberCircleStyle(true)}>{n}</span>
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
      <span style={stepNumberCircleStyle(false)}>{n}</span>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <span style={{ fontSize: 'var(--mint-text-body)', fontWeight: 600, color: 'var(--mint-fg-strong)' }}>{STEP_TITLES[n]}</span>
        <span style={{ fontSize: 'var(--mint-text-micro)', color: 'var(--mint-fg-soft)' }}>Not started</span>
      </div>
    </div>
  );
}

function stepNumberCircleStyle(filled: boolean): React.CSSProperties {
  return {
    width: 22, height: 22, borderRadius: 9999, flexShrink: 0,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    fontSize: 12, fontWeight: 700,
    background: filled ? 'var(--mint-fg-strong)' : 'transparent',
    color: filled ? 'var(--mint-fg-inverted)' : 'var(--mint-fg-soft)',
    border: filled ? 'none' : '1.5px solid var(--mint-outline-strong)',
  };
}

function NumberedList({ children }: { children: React.ReactNode }) {
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>{children}</div>;
}

function NumberedItem({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--mint-sp-2)', fontSize: 'var(--mint-text-meta)', color: 'var(--mint-fg-strong)', lineHeight: 1.5 }}>
      <span style={{ width: 18, height: 18, borderRadius: 9999, background: 'var(--mint-bg-subtle)', border: 'var(--mint-card-stroke)', color: 'var(--mint-fg-subdued-title)', fontSize: 11, fontWeight: 700, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginTop: 1 }}>{n}</span>
      <span>{children}</span>
    </div>
  );
}

// ============================================================
// helpers
// ============================================================

function buildInitialComment(ticket: WocooTicket, isInterestFlow: boolean): string {
  const mention = ticket.reporter ? `@${ticket.reporter}` : 'team';
  return isInterestFlow
    ? `Hi ${mention}, the interest fee has been waived!`
    : `Hi ${mention}, the fee has been reversed!`;
}

function buildCommentSegments(ticket: WocooTicket, text: string) {
  const segments: Array<{ type: 'text' | 'mention'; text: string; accountId?: string }> = [];
  let working = text;
  if (ticket.reporter && ticket.reporterAccountId) {
    const mention = '@' + ticket.reporter;
    const i = working.indexOf(mention);
    if (i !== -1) {
      if (i > 0) segments.push({ type: 'text', text: working.slice(0, i) });
      segments.push({ type: 'mention', text: mention, accountId: ticket.reporterAccountId });
      working = working.slice(i + mention.length);
    }
  }
  if (working) segments.push({ type: 'text', text: working });
  return segments;
}

// ============================================================
// styles
// ============================================================

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
const secondaryButton: React.CSSProperties = {
  padding: '10px 16px',
  borderRadius: 'var(--mint-radius-button)',
  fontWeight: 600,
  fontSize: 'var(--mint-text-meta)',
  border: 'var(--mint-card-stroke)',
  background: 'var(--mint-bg-card)',
  color: 'var(--mint-fg-strong)',
  cursor: 'pointer',
};
function pillLink(tone: 'highlight' | 'positive' | 'warning'): React.CSSProperties {
  return {
    padding: '8px 16px',
    background: `var(--mint-${tone}-bg-soft)`,
    color: `var(--mint-${tone}-fg-strong)`,
    borderRadius: 'var(--mint-radius-button)',
    fontSize: 'var(--mint-text-meta)',
    fontWeight: 600,
    textDecoration: 'none',
  };
}
const errorBanner: React.CSSProperties = {
  padding: '8px 12px',
  background: 'var(--mint-negative-bg-soft)',
  color: 'var(--mint-negative-fg-strong)',
  fontSize: 'var(--mint-text-meta)',
  borderRadius: 'var(--mint-radius-button)',
};
