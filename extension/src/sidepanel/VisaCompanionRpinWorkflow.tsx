// Visa Companion RPIN diagnostic workflow.
//
//   1. Auto-open the "Account ID & RPIN" Preset dashboard (7666) filtered by identity_id.
//      Agent inspects — is there an RPIN value, or does it show n/a?
//   2a. RPIN n/a → open an i2c JSM ticket with the "please add an RPIN" template
//       pre-filled. Reuses the existing i2cservicedesk.ts content script + storage key.
//   2b. RPIN present → placeholder for future logic.
//
// Not to be confused with `VisaCompanionCard` — that's a canned-reply card for the
// separate case where a client got an ERROR trying to register for Visa Airport
// Companion. This workflow is the diagnostic path for the "can't enroll → check RPIN"
// scenario.

import { useEffect, useState } from 'react';
import type { WocooTicket } from '../data/mockTicket';
import { postComment, transitionTicketThroughPath } from '../api/jira';

const RPIN_DASHBOARD_URL = 'https://8a26d867.wealthsimple-aws-mpc.app.preset.io/superset/dashboard/7666/';
const I2C_FORM_URL = 'https://tracking.i2cinc.com/servicedesk/customer/portal/2/create/17';
// WOCOO workflow requires Triage → Back Office → Pending External; there's no direct
// Triage → Pending External transition. We walk the chain via transitionTicketThroughPath,
// which is idempotent (skips hops the ticket is already past).
const PENDING_EXTERNAL_PATH = ['Back Office', 'Pending External'];
const RPIN_PRESENT_COMMENT_TEXT = " there is currently an ongoing investigation with Visa for CC's being ineligible, will come back to you with next steps";

type StepNum = 1 | 2 | 3 | 4 | 5;
type Branch = 'na' | 'present' | null;

const STEP_TITLES: Record<StepNum, string> = {
  1: 'Check RPIN in Preset',
  2: 'Create i2c ticket',
  3: 'Post comment & Move to Pending External',
  4: 'Post comment & Move to Pending External',
  5: 'Complete',
};

const STEP_SUBTITLES: Record<StepNum, string> = {
  1: 'Open the Account ID & RPIN dashboard filtered by this identity',
  2: 'Ask i2c to add an RPIN for this account',
  3: 'Notify the reporter and move the WOCOO ticket',
  4: 'RPIN present — flag the Visa investigation and move to Pending External',
  5: '',
};

function buildDescription(clientEmail: string): string {
  return [
    "Client holds a WS Visa Infinite Privilege card, but is unable to enroll in Visa Airport Companion / access VIP-provided benefits. Can you please add an RPIN for this account? Please review and update/fix the RPIN on the client's account",
    '',
    `Client Email: ${clientEmail || '—'}`,
  ].join('\n');
}

function buildSummary(): string {
  return 'Client unable to enroll in Visa Airport Companion — RPIN missing';
}

export function VisaCompanionRpinWorkflow({ ticket, onClose }: { ticket: WocooTicket; onClose: () => void }) {
  const [step, setStep] = useState<StepNum>(1);
  const [branch, setBranch] = useState<Branch>(null);
  const [presetOpened, setPresetOpened] = useState(false);
  const [summary, setSummary] = useState(buildSummary());
  const [description, setDescription] = useState(buildDescription(ticket.clientEmail || ''));
  const [i2cOpened, setI2cOpened] = useState(false);
  const [i2cTicketUrl, setI2cTicketUrl] = useState('');
  const [commentPosting, setCommentPosting] = useState(false);
  const [commentPosted, setCommentPosted] = useState(false);
  const [commentError, setCommentError] = useState<string | null>(null);
  const [moveDoing, setMoveDoing] = useState(false);
  const [moveDone, setMoveDone] = useState(false);
  const [moveError, setMoveError] = useState<string | null>(null);
  const [presentCommentText, setPresentCommentText] = useState('');

  // Seed the editable comment textarea once when Step 4 becomes active (present branch).
  useEffect(() => {
    if (step === 4 && !presentCommentText && !commentPosted) {
      const reporter = ticket.reporter || 'reporter';
      setPresentCommentText(`Hi @${reporter}${RPIN_PRESENT_COMMENT_TEXT}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  // Auto-open the Preset dashboard once when the workflow mounts.
  useEffect(() => {
    if (presetOpened || !ticket.identityId) return;
    void chrome.storage.local.set({ pending_preset_identity_id: ticket.identityId });
    window.open(RPIN_DASHBOARD_URL, '_blank', 'noopener,noreferrer');
    setPresetOpened(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const reopenPreset = () => {
    if (!ticket.identityId) return;
    void chrome.storage.local.set({ pending_preset_identity_id: ticket.identityId });
    window.open(RPIN_DASHBOARD_URL, '_blank', 'noopener,noreferrer');
  };

  const openI2cForm = () => {
    void chrome.storage.local.set({ pending_i2c_servicedesk_form: { summary, description } });
    window.open(I2C_FORM_URL, '_blank', 'noopener,noreferrer');
    setI2cOpened(true);
  };

  // Compose the follow-up comment on the WOCOO ticket, then transition it to Pending
  // External. Split the ADF into segments so the reporter renders as a real mention pill
  // and the i2c URL renders as a real link (not just plain text).
  const doPostAndMove = async () => {
    if (commentPosting || moveDoing) return;
    if (!i2cTicketUrl.trim()) { setCommentError('Please paste the i2c ticket URL first.'); return; }
    setCommentError(null);
    setMoveError(null);
    setCommentPosting(true);
    try {
      if (!commentPosted) {
        const url = i2cTicketUrl.trim();
        const reporter = ticket.reporter || 'team';
        const hasAccountId = !!(ticket.reporter && ticket.reporterAccountId);
        // Inline paragraph → smartcard block. Jira unfurls the URL into a rich card
        // (title / description / favicon) instead of a plain hyperlink, matching the
        // format we want the reporter to see.
        const segments: Array<{ type: 'text' | 'mention' | 'link' | 'smartcard'; text: string; accountId?: string; href?: string }> = [];
        segments.push({ type: 'text', text: 'Hi ' });
        if (hasAccountId) {
          segments.push({ type: 'mention', text: '@' + reporter, accountId: ticket.reporterAccountId! });
        } else {
          segments.push({ type: 'text', text: '@' + reporter });
        }
        segments.push({ type: 'text', text: ' an i2c ticket has been created to add the RPIN to the CC account.' });
        segments.push({ type: 'smartcard', text: url, href: url });
        await postComment(ticket.id, segments);
        setCommentPosted(true);
      }
      setMoveDoing(true);
      await transitionTicketThroughPath(ticket.id, ...PENDING_EXTERNAL_PATH);
      setMoveDone(true);
      // Not updating local ticket.status — "Pending External" isn't in the WocooTicket
      // status union. Jira has the authoritative state; next fetch will reconcile.
      setStep(5);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!commentPosted) setCommentError(msg);
      else setMoveError(msg);
    } finally {
      setCommentPosting(false);
      setMoveDoing(false);
    }
  };

  // "RPIN present" branch — no i2c ticket, just a heads-up comment + move to Pending External.
  // Shares the same commentPosting/commentPosted/moveDoing/moveDone state as the NA
  // branch because the two branches are mutually exclusive (agent commits to one at
  // Step 1).
  const doPostAndMoveExternalReview = async () => {
    if (commentPosting || moveDoing) return;
    if (!presentCommentText.trim()) { setCommentError('Comment is empty.'); return; }
    setCommentError(null);
    setMoveError(null);
    setCommentPosting(true);
    try {
      if (!commentPosted) {
        // Free-form text — find the `@<reporter>` needle and wrap it as a real mention
        // pill; everything else stays plain text. Mirrors the pattern used in
        // RetentionFeeWaiver / QCFeeWaiver.
        const segments = buildFreeformCommentSegments(presentCommentText, ticket.reporter, ticket.reporterAccountId);
        await postComment(ticket.id, segments);
        setCommentPosted(true);
      }
      setMoveDoing(true);
      await transitionTicketThroughPath(ticket.id, ...PENDING_EXTERNAL_PATH);
      setMoveDone(true);
      setStep(5);
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
        identityId={ticket.identityId}
        presetOpened={presetOpened}
        reopenPreset={reopenPreset}
        branch={branch}
        setBranch={setBranch}
        showAction={onCurrentStep}
        onContinue={() => setStep(branch === 'na' ? 2 : 4)}
      />
    );
    if (n === 2) return (
      <Step2Body
        summary={summary}
        setSummary={setSummary}
        description={description}
        setDescription={setDescription}
        openI2cForm={openI2cForm}
        i2cOpened={i2cOpened}
        showAction={onCurrentStep}
        onConfirm={() => setStep(3)}
      />
    );
    if (n === 3) return (
      <Step3Body
        i2cTicketUrl={i2cTicketUrl}
        setI2cTicketUrl={setI2cTicketUrl}
        reporter={ticket.reporter}
        commentPosting={commentPosting}
        commentPosted={commentPosted}
        commentError={commentError}
        moveDoing={moveDoing}
        moveDone={moveDone}
        moveError={moveError}
        doPostAndMove={doPostAndMove}
        showAction={onCurrentStep}
      />
    );
    if (n === 4) return (
      <Step4Body
        commentText={presentCommentText}
        setCommentText={setPresentCommentText}
        commentPosting={commentPosting}
        commentPosted={commentPosted}
        commentError={commentError}
        moveDoing={moveDoing}
        moveDone={moveDone}
        moveError={moveError}
        doPostAndMove={doPostAndMoveExternalReview}
        showAction={onCurrentStep}
      />
    );
    return <div style={{ fontSize: 'var(--mint-text-meta)', color: 'var(--mint-fg-soft)' }}>(stub — step {n})</div>;
  }

  function renderStep(n: StepNum) {
    if (n === 5) return null;
    // Only render the branch step that matches the agent's choice; the other branch
    // stays hidden so the flow reads linearly.
    if ((n === 2 || n === 3) && branch === 'present') return null;
    if (n === 4 && branch === 'na') return null;

    const isCompleted = n < step;
    const isActive = n === step;
    if (isCompleted) return <ExpandedCard key={n} n={n} completed>{renderBody(n)}</ExpandedCard>;
    if (isActive) return <ExpandedCard key={n} n={n}>{renderBody(n)}</ExpandedCard>;
    return <FutureStub key={n} n={n} />;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh', background: 'var(--mint-bg-page)' }}>
      <Header step={step} branch={branch} ticketId={ticket.id} onClose={onClose} />
      <div style={{ padding: 'var(--mint-sp-3)', display: 'flex', flexDirection: 'column', gap: 'var(--mint-sp-2)' }}>
        {([1, 2, 3, 4] as StepNum[]).map(renderStep)}
        {step === 5 ? (
          <SuccessPanel
            ticketId={ticket.id}
            branch={branch}
            i2cOpened={i2cOpened}
            i2cTicketUrl={i2cTicketUrl}
            commentPosted={commentPosted}
            moveDone={moveDone}
            onClose={onClose}
          />
        ) : null}
      </div>
    </div>
  );
}

function Step1Body({ identityId, presetOpened, reopenPreset, branch, setBranch, showAction, onContinue }: {
  identityId: string | null;
  presetOpened: boolean;
  reopenPreset: () => void;
  branch: Branch;
  setBranch: (b: Branch) => void;
  showAction: boolean;
  onContinue: () => void;
}) {
  return (
    <>
      {!identityId ? (
        <div style={{ padding: 8, background: 'var(--mint-negative-bg-soft)', border: '1px solid var(--mint-negative-fg-graphic)', borderRadius: 'var(--mint-radius-button)', fontSize: 'var(--mint-text-nano)', color: 'var(--mint-negative-fg-strong)', marginBottom: 'var(--mint-sp-3)' }}>
          Ticket is missing Identity ID — the dashboard can't be filtered.
        </div>
      ) : null}

      <div style={{ fontSize: 'var(--mint-text-meta)', color: 'var(--mint-fg-strong)', lineHeight: 1.5, marginBottom: 'var(--mint-sp-3)' }}>
        {presetOpened ? (
          <>Opened the <strong>Account ID & RPIN</strong> dashboard in a new tab, filtered by this identity. Check the RPIN column:</>
        ) : (
          <>Opening the <strong>Account ID & RPIN</strong> dashboard filtered by this identity…</>
        )}
      </div>

      {identityId ? (
        <div style={{ padding: '8px 12px', background: 'var(--mint-bg-subtle)', border: 'var(--mint-card-stroke)', borderRadius: 'var(--mint-radius-button)', marginBottom: 'var(--mint-sp-3)', display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-soft)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5 }}>Identity ID</span>
          <span style={{ fontSize: 'var(--mint-text-micro)', fontFamily: 'var(--mint-font-mono)', color: 'var(--mint-fg-strong)', wordBreak: 'break-all' }}>{identityId}</span>
        </div>
      ) : null}

      <button
        onClick={reopenPreset}
        disabled={!identityId}
        style={{ padding: '6px 12px', background: 'var(--mint-bg-card)', color: 'var(--mint-fg-strong)', border: 'var(--mint-card-stroke)', borderRadius: 'var(--mint-radius-button)', fontSize: 'var(--mint-text-nano)', fontWeight: 700, cursor: identityId ? 'pointer' : 'not-allowed', opacity: identityId ? 1 : 0.6, marginBottom: 'var(--mint-sp-3)', alignSelf: 'flex-start' }}
      >↗ Re-open dashboard</button>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <BranchCard
          active={branch === 'na'}
          title="🔴 RPIN is N/A"
          subtitle="No RPIN on the account. Create an i2c ticket to have one added."
          onClick={() => setBranch('na')}
        />
        <BranchCard
          active={branch === 'present'}
          title="🟢 RPIN is present"
          subtitle="Points at the known Visa investigation. Post a heads-up comment and move to Pending External."
          onClick={() => setBranch('present')}
        />
      </div>

      {showAction ? (
        <div style={{ marginTop: 'var(--mint-sp-3)' }}>
          <button onClick={onContinue} disabled={!branch} style={{ ...primaryButton, width: '100%', opacity: branch ? 1 : 0.55, cursor: branch ? 'pointer' : 'not-allowed' }}>
            Continue →
          </button>
        </div>
      ) : null}
    </>
  );
}

function BranchCard({ active, title, subtitle, onClick }: { active: boolean; title: string; subtitle: string; onClick: () => void }) {
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

function Step2Body({ summary, setSummary, description, setDescription, openI2cForm, i2cOpened, showAction, onConfirm }: {
  summary: string;
  setSummary: (v: string) => void;
  description: string;
  setDescription: (v: string) => void;
  openI2cForm: () => void;
  i2cOpened: boolean;
  showAction: boolean;
  onConfirm: () => void;
}) {
  return (
    <>
      <div style={fieldLabel}>Summary</div>
      <textarea
        value={summary}
        onChange={(e) => setSummary(e.target.value)}
        rows={2}
        style={textareaStyle}
      />

      <div style={{ ...fieldLabel, marginTop: 'var(--mint-sp-3)' }}>Description</div>
      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        rows={7}
        style={textareaStyle}
      />

      <button onClick={openI2cForm} style={{
        marginTop: 'var(--mint-sp-3)',
        padding: '8px 16px',
        background: 'var(--mint-warning-bg-soft)',
        color: 'var(--mint-warning-fg-strong)',
        border: '1px solid var(--mint-warning-fg-graphic)',
        borderRadius: 'var(--mint-radius-button)',
        fontSize: 'var(--mint-text-meta)',
        fontWeight: 700,
        width: '100%',
        textAlign: 'center',
        cursor: 'pointer',
      }}>↗ Open & Fill i2c Form</button>

      {showAction && !i2cOpened ? (
        <div style={{ marginTop: 'var(--mint-sp-2)', fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-soft)' }}>
          Fill the form, submit it in i2c, then click Continue.
        </div>
      ) : null}

      {showAction ? (
        <div style={{ marginTop: 'var(--mint-sp-2)' }}>
          <button onClick={onConfirm} style={{ ...primaryButton, width: '100%' }}>✓ i2c ticket submitted → Continue</button>
        </div>
      ) : null}
    </>
  );
}

function Step3Body({ i2cTicketUrl, setI2cTicketUrl, reporter, commentPosting, commentPosted, commentError, moveDoing, moveDone, moveError, doPostAndMove, showAction }: {
  i2cTicketUrl: string;
  setI2cTicketUrl: (v: string) => void;
  reporter: string;
  commentPosting: boolean;
  commentPosted: boolean;
  commentError: string | null;
  moveDoing: boolean;
  moveDone: boolean;
  moveError: string | null;
  doPostAndMove: () => void;
  showAction: boolean;
}) {
  const buttonLabel = moveDoing
    ? 'Moving to Pending External…'
    : commentPosting
      ? 'Posting…'
      : commentPosted
        ? 'Retry Move to Pending External'
        : 'Post comment & Move to Pending External';
  const urlValid = i2cTicketUrl.trim().length > 0;
  const buttonDisabled = commentPosting || moveDoing || !urlValid;

  return (
    <>
      <div style={fieldLabel}>i2c ticket URL</div>
      <input
        type="text"
        value={i2cTicketUrl}
        onChange={(e) => setI2cTicketUrl(e.target.value)}
        placeholder="https://tracking.i2cinc.com/servicedesk/customer/portal/2/CS-…"
        disabled={commentPosted}
        style={{
          width: '100%', padding: '6px 10px',
          fontFamily: 'var(--mint-font-mono)', fontSize: 'var(--mint-text-micro)',
          border: 'var(--mint-card-stroke)', borderRadius: 'var(--mint-radius-button)',
          background: commentPosted ? 'var(--mint-bg-subtle)' : 'var(--mint-bg-card)',
          color: 'var(--mint-fg-strong)', boxSizing: 'border-box',
        }}
      />
      <div style={{ marginTop: 4, fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-soft)', lineHeight: 1.4 }}>
        Paste the URL of the i2c ticket you just submitted. The comment will read:
        <br />
        <em>Hi @{reporter || 'reporter'} an i2c ticket has been created to add the RPIN to the CC account. &lt;url&gt;</em>
      </div>

      {commentPosted && !moveDone ? (
        <div style={{ marginTop: 'var(--mint-sp-2)', fontSize: 'var(--mint-text-micro)', color: 'var(--mint-warning-fg-strong)' }}>
          ✓ Comment posted — but Move-to-Pending-External didn't complete. Retry below.
        </div>
      ) : null}

      {showAction && !moveDone ? (
        <div style={{ marginTop: 'var(--mint-sp-3)' }}>
          <button onClick={doPostAndMove} disabled={buttonDisabled} style={{ ...primaryButton, width: '100%', opacity: buttonDisabled ? 0.6 : 1, cursor: buttonDisabled ? 'not-allowed' : 'pointer' }}>
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

function Step4Body({ commentText, setCommentText, commentPosting, commentPosted, commentError, moveDoing, moveDone, moveError, doPostAndMove, showAction }: {
  commentText: string;
  setCommentText: (v: string) => void;
  commentPosting: boolean;
  commentPosted: boolean;
  commentError: string | null;
  moveDoing: boolean;
  moveDone: boolean;
  moveError: string | null;
  doPostAndMove: () => void;
  showAction: boolean;
}) {
  const buttonLabel = moveDoing
    ? 'Moving to Pending External…'
    : commentPosting
      ? 'Posting…'
      : commentPosted
        ? 'Retry Move to Pending External'
        : 'Post comment & Move to Pending External';
  const buttonDisabled = commentPosting || moveDoing || !commentText.trim();

  return (
    <>
      <div style={{ padding: 'var(--mint-sp-3)', background: 'var(--mint-bg-subtle)', border: 'var(--mint-card-stroke)', borderRadius: 'var(--mint-radius-card)', marginBottom: 'var(--mint-sp-3)', fontSize: 'var(--mint-text-meta)', color: 'var(--mint-fg-strong)', lineHeight: 1.5 }}>
        RPIN is present on the account — this points at the known Visa investigation, not
        an account setup issue. Post a heads-up comment on the WOCOO ticket and move it to
        Pending External.
      </div>

      <div style={fieldLabel}>Comment</div>
      <textarea
        value={commentText}
        onChange={(e) => setCommentText(e.target.value)}
        disabled={commentPosted}
        rows={5}
        style={{
          ...textareaStyle,
          background: commentPosted ? 'var(--mint-bg-subtle)' : 'var(--mint-bg-card)',
          marginBottom: 'var(--mint-sp-2)',
        }}
      />
      <div style={{ marginTop: 4, marginBottom: 'var(--mint-sp-3)', fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-soft)' }}>
        Keep the `@&lt;reporter&gt;` token intact — it renders as a real mention pill.
      </div>

      {commentPosted && !moveDone ? (
        <div style={{ marginTop: 'var(--mint-sp-2)', fontSize: 'var(--mint-text-micro)', color: 'var(--mint-warning-fg-strong)' }}>
          ✓ Comment posted — but Move-to-External-Review didn't complete. Retry below.
        </div>
      ) : null}

      {showAction && !moveDone ? (
        <div style={{ marginTop: 'var(--mint-sp-2)' }}>
          <button onClick={doPostAndMove} disabled={buttonDisabled} style={{ ...primaryButton, width: '100%', opacity: buttonDisabled ? 0.6 : 1, cursor: buttonDisabled ? 'not-allowed' : 'pointer' }}>
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

function SuccessPanel({ ticketId, branch, i2cOpened, i2cTicketUrl, commentPosted, moveDone, onClose }: {
  ticketId: string;
  branch: Branch;
  i2cOpened: boolean;
  i2cTicketUrl: string;
  commentPosted: boolean;
  moveDone: boolean;
  onClose: () => void;
}) {
  const summary = branch === 'na'
    ? (moveDone
        ? 'i2c ticket submitted; WOCOO comment posted and moved to Pending External.'
        : commentPosted
          ? 'Comment posted, but transition to Pending External did not complete.'
          : i2cOpened
            ? 'RPIN missing — remember to submit the i2c ticket and complete the comment + move step.'
            : 'RPIN missing — remember to submit the i2c ticket.')
    : (moveDone
        ? 'RPIN present — WOCOO comment posted and moved to Pending External.'
        : commentPosted
          ? 'Comment posted, but transition to Pending External did not complete.'
          : 'RPIN present — continue manually.');
  return (
    <section style={{
      background: 'var(--mint-positive-bg-soft)',
      border: '1px solid var(--mint-positive-fg-graphic)',
      borderRadius: 'var(--mint-radius-card)',
      padding: 'var(--mint-sp-3)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 'var(--mint-sp-2)' }}>
        <span style={{ width: 26, height: 26, borderRadius: 9999, background: 'var(--mint-positive-fg-graphic)', color: '#fff', fontSize: 14, fontWeight: 800, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>✓</span>
        <h3 style={{ margin: 0, fontSize: 'var(--mint-text-h-md)', color: 'var(--mint-positive-fg-strong)' }}>Visa Companion — complete</h3>
      </div>
      <div style={{ fontSize: 'var(--mint-text-meta)', color: 'var(--mint-fg-strong)', marginBottom: 'var(--mint-sp-3)' }}>
        {summary}
      </div>
      <div style={{ fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-soft)', marginBottom: 'var(--mint-sp-3)' }}>
        Ticket: <a href={`https://wealthsimple.atlassian.net/browse/${ticketId}`} target="_blank" rel="noreferrer" style={{ color: 'var(--mint-highlight-fg-strong)', fontWeight: 700, textDecoration: 'none' }}>{ticketId}</a>
        {i2cTicketUrl ? (
          <>
            <br />
            i2c: <a href={i2cTicketUrl} target="_blank" rel="noreferrer" style={{ color: 'var(--mint-highlight-fg-strong)', fontWeight: 700, textDecoration: 'none' }}>{i2cTicketUrl}</a>
          </>
        ) : null}
      </div>
      <button onClick={onClose} style={{ ...primaryButton, width: '100%' }}>← Back to ticket</button>
    </section>
  );
}

/** Split free-form comment text into ADF segments: `@<reporter>` becomes a real mention
 *  pill, everything else stays plain text. If the needle isn't in the text (or reporter
 *  has no accountId), the whole thing is one plain-text segment. */
function buildFreeformCommentSegments(
  text: string,
  reporter: string,
  reporterAccountId: string | null | undefined,
): Array<{ type: 'text' | 'mention' | 'link' | 'smartcard'; text: string; accountId?: string; href?: string }> {
  if (!reporter || !reporterAccountId) {
    return [{ type: 'text', text }];
  }
  const needle = '@' + reporter;
  const i = text.indexOf(needle);
  if (i === -1) return [{ type: 'text', text }];
  const segments: Array<{ type: 'text' | 'mention' | 'link' | 'smartcard'; text: string; accountId?: string; href?: string }> = [];
  if (i > 0) segments.push({ type: 'text', text: text.slice(0, i) });
  segments.push({ type: 'mention', text: needle, accountId: reporterAccountId });
  if (i + needle.length < text.length) segments.push({ type: 'text', text: text.slice(i + needle.length) });
  return segments;
}

const textareaStyle: React.CSSProperties = {
  width: '100%', padding: '8px 10px',
  fontFamily: 'var(--mint-font-family)', fontSize: 'var(--mint-text-micro)',
  border: 'var(--mint-card-stroke)', borderRadius: 'var(--mint-radius-button)',
  background: 'var(--mint-bg-card)', color: 'var(--mint-fg-strong)',
  boxSizing: 'border-box', lineHeight: 1.45, resize: 'vertical',
};

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

function Header({ step, branch, ticketId, onClose }: { step: StepNum; branch: Branch; ticketId: string; onClose: () => void }) {
  // na branch: 1 → 2 → 3 (three real steps). present branch: 1 → 4 (two real steps).
  const total = branch === 'present' ? 2 : 3;
  const displayStep = branch === 'present'
    ? (step === 1 ? 1 : 2)
    : step === 1 ? 1 : step === 2 ? 2 : 3;
  return (
    <header style={{ position: 'sticky', top: 0, zIndex: 50, background: 'var(--mint-bg-card)', borderBottom: 'var(--mint-card-stroke)', padding: 'var(--mint-sp-3) var(--mint-sp-3) var(--mint-sp-2)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <button onClick={onClose} title="Back to ticket" style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--mint-fg-soft)', fontSize: 16, padding: 4 }}>←</button>
        <a href={`https://wealthsimple.atlassian.net/browse/${ticketId}`} target="_blank" rel="noreferrer" style={{ color: 'var(--mint-highlight-fg-strong)', fontWeight: 700, fontSize: 'var(--mint-text-meta)', textDecoration: 'none' }}>{ticketId}</a>
        <span style={{ marginLeft: 'auto', fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-soft)' }}>Step {Math.min(displayStep, total)} of {total}</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <h2 style={{ margin: 0, fontSize: 'var(--mint-text-h-md)', fontWeight: 700, color: 'var(--mint-fg-strong)' }}>Visa Companion</h2>
        <ProgressDots step={step} branch={branch} />
      </div>
    </header>
  );
}

function ProgressDots({ step, branch }: { step: StepNum; branch: Branch }) {
  const dots = branch === 'present' ? [1, 4, 5] : [1, 2, 3, 5];
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
