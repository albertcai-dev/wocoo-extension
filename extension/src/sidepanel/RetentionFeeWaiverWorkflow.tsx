// Retention Fee Waiver workflow — 3 steps.
//
//   1. Confirm months to waive (auto-parsed from ticket description; overridable).
//   2. Apply Admin Credit in i2c: $20 × months, service = "Admin Funds Credit",
//      comments = WOCOO ticket URL. Reuses the same content-script `apply_credit`
//      flow that QC Fee Waiver uses.
//   3. Post confirmation comment + Move to Done.

import { useEffect, useState } from 'react';
import type { WocooTicket } from '../data/mockTicket';
import { postComment, transitionTicket } from '../api/jira';
import {
  RETENTION_RATE_PER_MONTH,
  parseRetentionMonthsFromText,
  buildRetentionCommentTemplate,
} from '../data/retentionFeeWaiverConfig';

const I2C_LOGIN_URL = 'https://wealthsimplecs.mycardplace.com/customerservice/wealthsimplelogin.jsp';

type StepNum = 1 | 2 | 3 | 4;

const STEP_TITLES: Record<StepNum, string> = {
  1: 'Confirm months',
  2: 'Apply Admin Credit',
  3: 'Post comment & Move to Done',
  4: 'Complete',
};

const STEP_SUBTITLES: Record<StepNum, string> = {
  1: 'How many months are we waiving?',
  2: 'Open i2c with the credit form pre-filled',
  3: 'Review, then post + close the ticket',
  4: '',
};

export function RetentionFeeWaiverWorkflow({ ticket, onClose, onTicketUpdate }: { ticket: WocooTicket; onClose: () => void; onTicketUpdate: (t: WocooTicket) => void }) {
  // Feed both the summary (title) AND the description into the parser — agents frequently
  // put the intent in the title (e.g. "Waive CC fee 12 months") and only elaborate below.
  const parsedMonths = parseRetentionMonthsFromText(
    [ticket.summary || '', ticket.description || ''].join('\n'),
  );
  const [step, setStep] = useState<StepNum>(1);
  const [monthsInput, setMonthsInput] = useState<string>(String(parsedMonths ?? 1));
  const [creditAppliedRan, setCreditAppliedRan] = useState<boolean>(false);
  const [commentText, setCommentText] = useState<string>('');
  const [commentPosting, setCommentPosting] = useState<boolean>(false);
  const [commentPosted, setCommentPosted] = useState<boolean>(false);
  const [commentError, setCommentError] = useState<string | null>(null);
  const [moveDoing, setMoveDoing] = useState<boolean>(false);
  const [moveDone, setMoveDone] = useState<boolean>(false);
  const [moveError, setMoveError] = useState<string | null>(null);

  const months = parseInt(monthsInput, 10);
  const monthsValid = Number.isFinite(months) && months > 0 && months <= 12;
  const creditAmount = monthsValid ? months * RETENTION_RATE_PER_MONTH : null;

  const applyCredit = () => {
    if (!ticket.clientEmail || creditAmount == null) return;
    void chrome.storage.local.set({
      pending_i2c_email: ticket.clientEmail,
      pending_i2c_flow: 'apply_credit',
      pending_i2c_ticket_url: `https://wealthsimple.atlassian.net/browse/${ticket.id}`,
      pending_i2c_admin_credit_amount: creditAmount.toFixed(2),
      pending_i2c_started_at: Date.now(),
    });
    void chrome.storage.local.remove(['pending_i2c_admin_debit_amount', 'qc_search_clicked']);
    window.open(I2C_LOGIN_URL, '_blank', 'noopener,noreferrer');
  };

  // Seed the comment when Step 3 first activates.
  useEffect(() => {
    if (step === 3 && !commentText && !commentPosted) {
      setCommentText(buildRetentionCommentTemplate(ticket.reporter, monthsValid ? months : null));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  // Single combined action: post the comment, then transition to Done. If the comment
  // succeeds but the transition fails, retry re-runs only the transition — no double-post.
  const doPostAndDone = async () => {
    if (commentPosting || moveDoing) return;
    if (!commentText.trim()) { setCommentError('Comment is empty.'); return; }
    setCommentError(null);
    setMoveError(null);
    setCommentPosting(true);
    try {
      if (!commentPosted) {
        const segments = buildCommentSegments(commentText, ticket.reporter, ticket.reporterAccountId);
        await postComment(ticket.id, segments);
        setCommentPosted(true);
      }
      setMoveDoing(true);
      await transitionTicket(ticket.id, '251');
      setMoveDone(true);
      onTicketUpdate({ ...ticket, status: 'Done' });
      setStep(4);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!commentPosted) setCommentError(msg);
      else setMoveError(msg);
    } finally {
      setCommentPosting(false);
      setMoveDoing(false);
    }
  };

  function renderBody(n: StepNum) {
    const onCurrentStep = n === step;
    if (n === 1) return (
      <Step1Body
        monthsInput={monthsInput}
        setMonthsInput={setMonthsInput}
        monthsValid={monthsValid}
        creditAmount={creditAmount}
        parsedHint={parsedMonths != null}
        showAction={onCurrentStep}
        onContinue={() => setStep(2)}
      />
    );
    if (n === 2) return (
      <Step2Body
        creditAmount={creditAmount}
        applyCredit={applyCredit}
        alreadyDone={creditAppliedRan}
        disabled={!ticket.clientEmail || creditAmount == null}
        showAction={onCurrentStep}
        onConfirm={() => {
          setCreditAppliedRan(true);
          setStep(3);
        }}
      />
    );
    if (n === 3) return (
      <Step3Body
        commentText={commentText}
        setCommentText={setCommentText}
        commentPosting={commentPosting}
        commentPosted={commentPosted}
        commentError={commentError}
        moveDoing={moveDoing}
        moveDone={moveDone}
        moveError={moveError}
        doPostAndDone={doPostAndDone}
        reporter={ticket.reporter}
        showAction={onCurrentStep}
      />
    );
    return <div style={{ fontSize: 'var(--mint-text-meta)', color: 'var(--mint-fg-soft)' }}>(stub — step {n})</div>;
  }

  function renderStep(n: StepNum) {
    if (n === 4) return null;
    const isCompleted = n < step;
    const isActive = n === step;
    if (isCompleted) return <ExpandedCard key={n} n={n} completed>{renderBody(n)}</ExpandedCard>;
    if (isActive) return <ExpandedCard key={n} n={n}>{renderBody(n)}</ExpandedCard>;
    return <FutureStub key={n} n={n} />;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh', background: 'var(--mint-bg-page)' }}>
      <Header step={step} ticketId={ticket.id} onClose={onClose} />
      <div style={{ padding: 'var(--mint-sp-3)', display: 'flex', flexDirection: 'column', gap: 'var(--mint-sp-2)' }}>
        {([1, 2, 3] as StepNum[]).map(renderStep)}
        {step === 4 ? (
          <SuccessPanel
            ticketId={ticket.id}
            months={monthsValid ? months : null}
            creditAmount={creditAmount}
            commentPosted={commentPosted}
            onClose={onClose}
          />
        ) : null}
      </div>
    </div>
  );
}

function Step1Body({ monthsInput, setMonthsInput, monthsValid, creditAmount, parsedHint, showAction, onContinue }: {
  monthsInput: string;
  setMonthsInput: (v: string) => void;
  monthsValid: boolean;
  creditAmount: number | null;
  parsedHint: boolean;
  showAction: boolean;
  onContinue: () => void;
}) {
  return (
    <>
      <div style={fieldLabel}>Months to waive</div>
      <input
        type="number"
        min={1}
        max={12}
        value={monthsInput}
        onChange={(e) => setMonthsInput(e.target.value)}
        placeholder="1–12"
        style={{ width: '100%', padding: '6px 10px', fontFamily: 'var(--mint-font-mono)', fontSize: 'var(--mint-text-micro)', border: '1px solid ' + (monthsValid || !monthsInput ? 'var(--mint-outline-strong)' : 'var(--mint-negative-fg-graphic)'), borderRadius: 'var(--mint-radius-button)', background: 'var(--mint-bg-card)', color: 'var(--mint-fg-strong)', boxSizing: 'border-box' }}
      />
      <div style={{ marginTop: 4, fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-soft)', lineHeight: 1.4 }}>
        {parsedHint ? 'Auto-parsed from ticket description — override if needed.' : `Couldn't parse a value — default is 1.`}
      </div>
      {creditAmount != null ? (
        <div style={{ marginTop: 'var(--mint-sp-2)', padding: 'var(--mint-sp-3)', background: 'var(--mint-bg-subtle)', border: 'var(--mint-card-stroke)', borderRadius: 'var(--mint-radius-card)' }}>
          <div style={{ fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-soft)', fontWeight: 700, marginBottom: 4 }}>ADMIN CREDIT</div>
          <div style={{ fontSize: 'var(--mint-text-meta)', fontFamily: 'var(--mint-font-mono)', color: 'var(--mint-fg-strong)' }}>
            ${RETENTION_RATE_PER_MONTH} × {monthsInput} = <strong>${creditAmount.toFixed(2)}</strong>
          </div>
        </div>
      ) : null}
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

function Step2Body({ creditAmount, applyCredit, alreadyDone, disabled, showAction, onConfirm }: {
  creditAmount: number | null;
  applyCredit: () => void;
  alreadyDone: boolean;
  disabled: boolean;
  showAction: boolean;
  onConfirm: () => void;
}) {
  return (
    <>
      <div style={{ fontSize: 'var(--mint-text-meta)', color: 'var(--mint-fg-strong)', lineHeight: 1.5, marginBottom: 'var(--mint-sp-3)' }}>
        <ol style={{ paddingLeft: '1.2em', margin: 0 }}>
          <li>Click <strong>Apply Admin Credit</strong> below — i2c opens with the form pre-filled.</li>
          <li>Service: <strong>Admin Funds Credit</strong>, Amount: <strong>${creditAmount != null ? creditAmount.toFixed(2) : '—'}</strong>, Comments: <strong>this ticket URL</strong>.</li>
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
      }}>↗ Apply Admin Credit ({creditAmount != null ? '$' + creditAmount.toFixed(2) : '—'})</button>

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

function Step3Body({ commentText, setCommentText, commentPosting, commentPosted, commentError, moveDoing, moveDone, moveError, doPostAndDone, reporter, showAction }: {
  commentText: string;
  setCommentText: (v: string) => void;
  commentPosting: boolean;
  commentPosted: boolean;
  commentError: string | null;
  moveDoing: boolean;
  moveDone: boolean;
  moveError: string | null;
  doPostAndDone: () => void;
  reporter: string;
  showAction: boolean;
}) {
  const buttonLabel = moveDoing
    ? 'Moving to Done…'
    : commentPosting
      ? 'Posting…'
      : commentPosted
        ? 'Retry Move to Done'
        : 'Post comment & Move to Done';
  const buttonDisabled = commentPosting || moveDoing || !commentText.trim();

  return (
    <>
      <div style={fieldLabel}>Comment</div>
      <textarea
        value={commentText}
        onChange={(e) => setCommentText(e.target.value)}
        disabled={commentPosted}
        rows={4}
        style={{
          width: '100%', padding: '8px 10px',
          fontFamily: 'var(--mint-font-family)', fontSize: 'var(--mint-text-micro)',
          border: 'var(--mint-card-stroke)', borderRadius: 'var(--mint-radius-button)',
          background: commentPosted ? 'var(--mint-bg-subtle)' : 'var(--mint-bg-card)',
          color: 'var(--mint-fg-strong)', boxSizing: 'border-box', lineHeight: 1.45, resize: 'vertical',
        }}
      />
      <div style={{ marginTop: 4, fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-soft)' }}>
        @{reporter || 'reporter'} renders as a mention.
      </div>

      {commentPosted && !moveDone ? (
        <div style={{ marginTop: 'var(--mint-sp-2)', fontSize: 'var(--mint-text-micro)', color: 'var(--mint-warning-fg-strong)' }}>
          ✓ Comment posted — but Move-to-Done didn't complete. Retry below.
        </div>
      ) : null}

      {showAction && !moveDone ? (
        <div style={{ marginTop: 'var(--mint-sp-3)' }}>
          <button onClick={doPostAndDone} disabled={buttonDisabled} style={{ ...primaryButton, width: '100%', opacity: buttonDisabled ? 0.6 : 1, cursor: buttonDisabled ? 'not-allowed' : 'pointer' }}>
            {buttonLabel}
          </button>
        </div>
      ) : null}

      {commentError ? (
        <div style={{ marginTop: 'var(--mint-sp-2)', padding: 8, background: 'var(--mint-negative-bg-soft)', border: '1px solid var(--mint-negative-fg-graphic)', borderRadius: 'var(--mint-radius-button)', fontSize: 'var(--mint-text-nano)', color: 'var(--mint-negative-fg-strong)' }}>
          {commentError}
        </div>
      ) : null}
      {moveError ? (
        <div style={{ marginTop: 'var(--mint-sp-2)', padding: 8, background: 'var(--mint-negative-bg-soft)', border: '1px solid var(--mint-negative-fg-graphic)', borderRadius: 'var(--mint-radius-button)', fontSize: 'var(--mint-text-nano)', color: 'var(--mint-negative-fg-strong)' }}>
          {moveError}
        </div>
      ) : null}
    </>
  );
}

/** Split `text` so the @<reporter> mention renders as a real Jira mention pill. */
function buildCommentSegments(text: string, reporter: string, reporterAccountId: string | null | undefined) {
  const segments: Array<{ type: 'text' | 'mention'; text: string; accountId?: string }> = [];
  if (!reporter || !reporterAccountId) {
    return [{ type: 'text' as const, text }];
  }
  const needle = '@' + reporter;
  const i = text.indexOf(needle);
  if (i === -1) return [{ type: 'text' as const, text }];
  if (i > 0) segments.push({ type: 'text', text: text.slice(0, i) });
  segments.push({ type: 'mention', text: needle, accountId: reporterAccountId });
  if (i + needle.length < text.length) segments.push({ type: 'text', text: text.slice(i + needle.length) });
  return segments;
}

function SuccessPanel({ ticketId, months, creditAmount, commentPosted, onClose }: {
  ticketId: string;
  months: number | null;
  creditAmount: number | null;
  commentPosted: boolean;
  onClose: () => void;
}) {
  return (
    <section style={{
      background: 'var(--mint-positive-bg-soft)',
      border: '1px solid var(--mint-positive-fg-graphic)',
      borderRadius: 'var(--mint-radius-card)',
      padding: 'var(--mint-sp-3)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 'var(--mint-sp-2)' }}>
        <span style={{ width: 26, height: 26, borderRadius: 9999, background: 'var(--mint-positive-fg-graphic)', color: '#fff', fontSize: 14, fontWeight: 800, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>✓</span>
        <h3 style={{ margin: 0, fontSize: 'var(--mint-text-h-md)', color: 'var(--mint-positive-fg-strong)' }}>Retention Fee Waiver complete</h3>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 'var(--mint-sp-3)' }}>
        <Row label="Ticket" value={ticketId} />
        <Row label="Months" value={months != null ? String(months) : '—'} />
        <Row label="Admin credit" value={creditAmount != null ? `CA$${creditAmount.toFixed(2)} applied in i2c` : '—'} />
        <Row label="Comment" value={commentPosted ? 'posted' : 'skipped'} />
        <Row label="Status" value="Moved to Done" />
      </div>

      <button onClick={onClose} style={{ ...primaryButton, width: '100%' }}>← Back to ticket</button>
    </section>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 'var(--mint-text-nano)' }}>
      <span style={{ color: 'var(--mint-fg-soft)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</span>
      <span style={{ color: 'var(--mint-fg-strong)', fontFamily: 'var(--mint-font-mono)', textAlign: 'right', wordBreak: 'break-all' }}>{value}</span>
    </div>
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

function Header({ step, ticketId, onClose }: { step: StepNum; ticketId: string; onClose: () => void }) {
  const total = 3;
  const displayStep = Math.min(step, total);
  return (
    <header style={{ position: 'sticky', top: 0, zIndex: 50, background: 'var(--mint-bg-card)', borderBottom: 'var(--mint-card-stroke)', padding: 'var(--mint-sp-3) var(--mint-sp-3) var(--mint-sp-2)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <button onClick={onClose} title="Back to ticket" style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--mint-fg-soft)', fontSize: 16, padding: 4 }}>←</button>
        <a href={`https://wealthsimple.atlassian.net/browse/${ticketId}`} target="_blank" rel="noreferrer" style={{ color: 'var(--mint-highlight-fg-strong)', fontWeight: 700, fontSize: 'var(--mint-text-meta)', textDecoration: 'none' }}>{ticketId}</a>
        <span style={{ marginLeft: 'auto', fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-soft)' }}>Step {displayStep} of {total}</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <h2 style={{ margin: 0, fontSize: 'var(--mint-text-h-md)', fontWeight: 700, color: 'var(--mint-fg-strong)' }}>Retention Fee Waiver</h2>
        <ProgressDots step={step} />
      </div>
    </header>
  );
}

function ProgressDots({ step }: { step: StepNum }) {
  const dots = [1, 2, 3, 4];
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      {dots.map((n) => {
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
