// Overpayment Triage — 8-step in-panel workflow (F4).
//
// Visual target:
//   • Completed steps stay fully expanded with a green ✓ in the number slot and a green border —
//     bodies still visible, action buttons hidden, override controls remain functional
//   • Active step is a white card with a dark numbered circle, subtitle, body, and primary action
//   • Future steps are soft-gray collapsed stubs with "Not started"
//   • Progress is shown as 8 discrete dots in the sticky header
//
// Scope cuts (v1, per session):
//   • No "Decline & comment" path when amount < $1,000 (warn only)
//   • No write to Moves/Errors sheet (v3 has this; extension parity-later)

import { useEffect, useState } from 'react';
import type { WocooTicket } from '../data/mockTicket';
import {
  createReimbTicket,
  postComment,
  transitionTicket,
  REIMB_APPROVERS,
  REIMB_APPROVER_KEYS,
} from '../api/jira';
import type { ReimbApproverKey } from '../api/jira';
import { fetchAtlasAccountIdHeadless } from '../data/atlasAccountLookup';

const TRANSITION_TO_DONE_ID = '251';

// ============================================================
// types + constants
// ============================================================

type StepNum = 1 | 2 | 3 | 4 | 5 | 6;

const STEP_TITLES: Record<StepNum, string> = {
  1: 'Pull ticket details',
  2: 'Verify balance',
  3: 'Create REIMB ticket',
  4: 'Admin debit in i2c',
  5: 'Post comment & Move to Done',
  6: 'Complete',
};

const STEP_SUBTITLES: Record<StepNum, string> = {
  1: 'Confirm details and criteria',
  2: 'Open the source systems to confirm',
  3: 'Review before creating',
  4: 'Apply the debit manually',
  5: 'Review, then post and close in one click',
  6: '',
};

interface WorkflowState {
  step: StepNum;
  // Step 1
  amount: number | null;
  amountEditOpen: boolean;
  manualAmountInput: string;
  // Step 3
  balanceVerified: boolean;
  adjustOpen: boolean;
  adjustedAmountInput: string;
  // Step 2 decline path (amount < $1,000)
  declineText: string;
  declinePosted: boolean;
  // Step 4 overrides
  tierOverride: WocooTicket['tier'] | null;
  tierEditOpen: boolean;
  approverOverride: ReimbApproverKey | null;
  approverEditOpen: boolean;
  accountIdOverride: string;
  accountIdInput: string; // staged value while user is typing; applied to override on Set
  accountIdEditOpen: boolean;
  reimbKey: string | null;
  reimbUrl: string | null;
  // Step 5
  adminDebitDone: boolean;
  // Step 5
  commentEditing: boolean;
  commentText: string;
  commentPosted: boolean;
  transitionedToDone: boolean;
  // async / errors
  busy: boolean;
  error: string | null;
}

// Decline-comment template lifted verbatim from wocoo-triage-v3 / app-workflows.js.
// {{REPORTER_MENTION}} resolves to @<reporter display name> so buildCommentSegments can
// emit a proper Jira @mention node when posting via the ADF comment API.
const DECLINE_TEMPLATE =
  'Hi {{REPORTER_MENTION}}, unfortunately because this overpayment transfer request is under $1,000 I am unable to action. ' +
  'We typically only action overpayments above $1,000. ' +
  'You can let the customer know that "While we are unable to process refunds to your cash account, please note that this balance will be applied to future purchases on the card."';

function initialState(ticket: WocooTicket): WorkflowState {
  const reporterMention = ticket.reporter ? '@' + ticket.reporter : 'team';
  return {
    step: 1,
    amount: ticket.totalReimbursementAmount ?? extractAmountFromDescription(ticket.description),
    amountEditOpen: false,
    manualAmountInput: '',
    balanceVerified: false,
    adjustOpen: false,
    adjustedAmountInput: '',
    declineText: DECLINE_TEMPLATE.replace('{{REPORTER_MENTION}}', reporterMention),
    declinePosted: false,
    tierOverride: null,
    tierEditOpen: false,
    approverOverride: null,
    approverEditOpen: false,
    accountIdOverride: '',
    accountIdInput: '',
    accountIdEditOpen: false,
    reimbKey: null,
    reimbUrl: null,
    adminDebitDone: false,
    commentEditing: false,
    commentText: '',
    commentPosted: false,
    transitionedToDone: false,
    busy: false,
    error: null,
  };
}

// ============================================================
// main component
// ============================================================

export function OverpaymentTriage({ ticket, onClose, onTicketUpdate }: { ticket: WocooTicket; onClose: () => void; onTicketUpdate: (t: WocooTicket) => void }) {
  const [state, setState] = useState<WorkflowState>(() => initialState(ticket));

  // Derived values
  const autoApproverKey: keyof typeof REIMB_APPROVERS = state.amount && state.amount >= 5000 ? 'amanda' : 'luke';
  const approverKey: keyof typeof REIMB_APPROVERS = state.approverOverride || autoApproverKey;
  const approver = REIMB_APPROVERS[approverKey];
  const effectiveTier: WocooTicket['tier'] = state.tierOverride || ticket.tier;
  const effectiveAccountId = (state.accountIdOverride || ticket.accountId || '').trim().toUpperCase();
  const accountIdValid = /^[CHWN][0-9A-Z]{7,}$/i.test(effectiveAccountId);
  const meetsMinimum = !!state.amount && state.amount >= 1000;
  const fmtAmt = state.amount != null ? `$${state.amount.toFixed(2)}` : '—';

  // Re-init if ticket changes (rare)
  useEffect(() => { setState(initialState(ticket)); }, [ticket.id]);

  const setS = (patch: Partial<WorkflowState>) => setState((s) => ({ ...s, ...patch }));
  const advanceTo = (target: StepNum) => setS({ step: target, error: null });

  // ---- step actions ----

  function applyManualAmount() {
    const n = parseFloat(state.manualAmountInput);
    if (!isFinite(n) || n <= 0) { setS({ error: 'Enter a positive amount.' }); return; }
    setS({ amount: n, manualAmountInput: '', amountEditOpen: false, error: null });
  }

  function applyAccountIdOverride() {
    const v = state.accountIdInput.trim().toUpperCase();
    if (!v) { setS({ error: 'Account ID is required.' }); return; }
    setS({ accountIdOverride: v, accountIdInput: '', accountIdEditOpen: false, error: null });
  }

  // Atlas-driven account number lookup. Opens Atlas in a headless background tab via
  // the shared helper; the content script scrapes CHEQUING (SPEND) and the helper
  // resolves with the value once it lands in storage.
  const [accountIdFetchPending, setAccountIdFetchPending] = useState(false);

  async function fetchAccountIdFromAtlas() {
    if (!ticket.identityId || accountIdFetchPending) return;
    setAccountIdFetchPending(true);
    try {
      const { accountNumber } = await fetchAtlasAccountIdHeadless({ identityId: ticket.identityId, sourceTicketId: ticket.id });
      setS({ accountIdOverride: accountNumber, accountIdInput: '', accountIdEditOpen: false, error: null });
    } catch (e) {
      setS({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      setAccountIdFetchPending(false);
    }
  }

  function toggleAccountIdEdit(open: boolean) {
    // When opening: seed the staged input with the current override so the user can edit
    // an existing value rather than start from blank. When closing without applying: don't
    // clobber the override; just hide the card.
    if (open) {
      setS({ accountIdEditOpen: true, accountIdInput: state.accountIdOverride || '' });
    } else {
      setS({ accountIdEditOpen: false });
    }
  }

  function applyAdjustedAmount() {
    const n = parseFloat(state.adjustedAmountInput);
    if (!isFinite(n) || n <= 0) { setS({ error: 'Enter a positive amount.' }); return; }
    setS({ amount: n, balanceVerified: true, adjustOpen: false, step: 3, error: null });
  }

  async function doCreateReimb() {
    if (!ticket.identityId) { setS({ error: 'Source ticket is missing Identity ID.' }); return; }
    if (!accountIdValid) { setS({ error: 'Account ID is missing or invalid. Use the override.' }); return; }
    if (!state.amount || state.amount <= 0) { setS({ error: 'Amount is not set.' }); return; }
    setS({ busy: true, error: null });
    try {
      const result = await createReimbTicket({
        wocooTicketId: ticket.id,
        identityId: ticket.identityId,
        amount: state.amount,
        accountId: effectiveAccountId,
        approver: approverKey,
        tier: effectiveTier,
      });
      const commentText = buildCommentText(ticket, result.key, state.amount);
      setS({ busy: false, reimbKey: result.key, reimbUrl: result.url, commentText, step: 4 });
    } catch (e: any) {
      setS({ busy: false, error: e?.message || String(e) });
    }
  }

  async function doPostComment() {
    if (!state.reimbKey || !state.reimbUrl || !state.amount) return;
    setS({ busy: true, error: null });
    try {
      const segments = buildCommentSegments(ticket, state.reimbKey, state.reimbUrl, state.amount, state.commentText);
      await postComment(ticket.id, segments);
      // Chain the transition like the decline path. Comment is already posted at
      // this point — if the transition fails, surface a soft warning rather than
      // rolling back, so the agent can finish the move-to-Done manually.
      try {
        await transitionTicket(ticket.id, TRANSITION_TO_DONE_ID);
        onTicketUpdate({ ...ticket, status: 'Done' });
        setS({ busy: false, commentPosted: true, transitionedToDone: true, step: 6 });
      } catch (transitionErr: any) {
        setS({
          busy: false,
          commentPosted: true,
          error: 'Comment posted, but Move-to-Done failed: ' + (transitionErr?.message || String(transitionErr)),
        });
      }
    } catch (e: any) {
      setS({ busy: false, error: e?.message || String(e) });
    }
  }

  async function doPostDeclineComment() {
    if (!state.declineText.trim()) { setS({ error: 'Decline message is empty.' }); return; }
    setS({ busy: true, error: null });
    try {
      const segments = buildDeclineCommentSegments(ticket, state.declineText);
      await postComment(ticket.id, segments);
      // Match v3: post comment, mark posted, then transition to Done so the agent doesn't
      // have to bounce back to Jira to close out a clearly-declined ticket.
      try {
        await transitionTicket(ticket.id, TRANSITION_TO_DONE_ID);
        onTicketUpdate({ ...ticket, status: 'Done' });
      } catch (transitionErr: any) {
        // Comment posted but transition failed — surface a soft warning, don't roll back.
        setS({ busy: false, declinePosted: true, error: 'Decline comment posted, but Move-to-Done failed: ' + (transitionErr?.message || String(transitionErr)) });
        return;
      }
      setS({ busy: false, declinePosted: true });
    } catch (e: any) {
      setS({ busy: false, error: e?.message || String(e) });
    }
  }

  // ============================================================
  // render
  // ============================================================

  function renderStep(n: StepNum) {
    if (n === 6) return null;
    const isCompleted = n < state.step;
    const isActive = n === state.step;

    if (isCompleted) {
      return <ExpandedCard key={n} n={n} completed>{renderStepBody(n)}</ExpandedCard>;
    }
    if (isActive) {
      return <ExpandedCard key={n} n={n}>{renderStepBody(n)}</ExpandedCard>;
    }
    return <FutureStub key={n} n={n} />;
  }

  function renderStepBody(n: StepNum) {
    const onCurrentStep = n === state.step;
    switch (n) {
      case 1: return (
        <Step1Body
          ticket={ticket}
          amount={state.amount}
          fmtAmt={fmtAmt}
          tier={effectiveTier}
          effectiveAccountId={effectiveAccountId}
          accountIdEditOpen={state.accountIdEditOpen}
          setAccountIdEditOpen={toggleAccountIdEdit}
          accountIdInput={state.accountIdInput}
          setAccountIdInput={(v) => setS({ accountIdInput: v })}
          applyAccountIdOverride={applyAccountIdOverride}
          fetchAccountId={fetchAccountIdFromAtlas}
          accountIdFetchPending={accountIdFetchPending}
          amountEditOpen={state.amountEditOpen}
          setAmountEditOpen={(v) => setS({ amountEditOpen: v })}
          manualAmountInput={state.manualAmountInput}
          setManualAmountInput={(v) => setS({ manualAmountInput: v })}
          applyManualAmount={applyManualAmount}
          // criteria + approver (merged in from former Step 2)
          meetsMinimum={meetsMinimum}
          approverName={approver.name}
          approverKey={approverKey}
          isLarge={!!state.amount && state.amount >= 5000}
          approverEditOpen={state.approverEditOpen}
          setApproverEditOpen={(v) => setS({ approverEditOpen: v })}
          setApproverOverride={(v) => setS({ approverOverride: v, approverEditOpen: false })}
          // decline-path props (still here when amount < $1k)
          declineText={state.declineText}
          setDeclineText={(v) => setS({ declineText: v })}
          declinePosted={state.declinePosted}
          busy={state.busy}
          onDecline={doPostDeclineComment}
          showContinue={onCurrentStep}
          onContinue={() => advanceTo(2)}
        />
      );
      case 2: return (
        <Step3Body
          ticket={ticket}
          fmtAmt={fmtAmt}
          amount={state.amount}
          adjustOpen={state.adjustOpen}
          setAdjustOpen={(v) => setS({ adjustOpen: v })}
          adjustedAmountInput={state.adjustedAmountInput}
          setAdjustedAmountInput={(v) => setS({ adjustedAmountInput: v })}
          applyAdjustedAmount={applyAdjustedAmount}
          showContinue={onCurrentStep}
          onVerify={() => advanceTo(3)}
        />
      );
      case 3: return (
        <Step4Body
          ticket={ticket}
          fmtAmt={fmtAmt}
          effectiveTier={effectiveTier}
          effectiveAccountId={effectiveAccountId}
          accountIdValid={accountIdValid}
          approverKey={approverKey}
          approverName={approver.name}
          amountEditOpen={state.amountEditOpen}
          setAmountEditOpen={(v) => setS({ amountEditOpen: v })}
          manualAmountInput={state.manualAmountInput}
          setManualAmountInput={(v) => setS({ manualAmountInput: v })}
          applyManualAmount={applyManualAmount}
          tierEditOpen={state.tierEditOpen}
          setTierEditOpen={(v) => setS({ tierEditOpen: v })}
          setTierOverride={(v) => setS({ tierOverride: v, tierEditOpen: false })}
          approverEditOpen={state.approverEditOpen}
          setApproverEditOpen={(v) => setS({ approverEditOpen: v })}
          setApproverOverride={(v) => setS({ approverOverride: v, approverEditOpen: false })}
          accountIdEditOpen={state.accountIdEditOpen}
          setAccountIdEditOpen={toggleAccountIdEdit}
          accountIdInput={state.accountIdInput}
          setAccountIdInput={(v) => setS({ accountIdInput: v })}
          applyAccountIdOverride={applyAccountIdOverride}
          fetchAccountId={fetchAccountIdFromAtlas}
          accountIdFetchPending={accountIdFetchPending}
          busy={state.busy}
          alreadyCreated={!!state.reimbKey}
          reimbKey={state.reimbKey}
          reimbUrl={state.reimbUrl}
          showActionButton={onCurrentStep}
          onCreate={doCreateReimb}
        />
      );
      case 4: return (
        <Step5Body
          fmtAmt={fmtAmt}
          clientEmail={ticket.clientEmail}
          ticketId={ticket.id}
          amount={state.amount}
          alreadyDone={state.adminDebitDone}
          showActionButton={onCurrentStep}
          onConfirm={() => advanceTo(5)}
        />
      );
      case 5: return (
        <Step6Body
          ticket={ticket}
          commentText={state.commentText}
          setCommentText={(v) => setS({ commentText: v })}
          commentEditing={state.commentEditing}
          setCommentEditing={(v) => setS({ commentEditing: v })}
          busy={state.busy}
          alreadyPosted={state.commentPosted}
          showActionButton={onCurrentStep}
          reimbKey={state.reimbKey}
          onPost={doPostComment}
        />
      );
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh', background: 'var(--mint-bg-page)' }}>
      <Header step={state.step} ticketId={ticket.id} onClose={onClose} />
      <div style={{ padding: 'var(--mint-sp-3)', display: 'flex', flexDirection: 'column', gap: 'var(--mint-sp-2)' }}>
        {state.error ? (
          <div role="alert" style={errorBanner}>⚠ {state.error}</div>
        ) : null}
        {([1, 2, 3, 4, 5] as StepNum[]).map(renderStep)}
        {state.step === 6 ? (
          <SuccessPanel
            reimbKey={state.reimbKey}
            reimbUrl={state.reimbUrl}
            ticketId={ticket.id}
            fmtAmt={fmtAmt}
            onCloseToTicket={onClose}
            onReload={() => { onClose(); /* simple — closing the workflow returns to ticket view */ }}
          />
        ) : null}
      </div>
    </div>
  );
}

// ============================================================
// shared visual primitives
// ============================================================

function Header({ step, ticketId, onClose }: { step: StepNum; ticketId: string; onClose: () => void }) {
  return (
    <header style={{ position: 'sticky', top: 0, zIndex: 50, background: 'var(--mint-bg-card)', borderBottom: 'var(--mint-card-stroke)', padding: 'var(--mint-sp-3) var(--mint-sp-3) var(--mint-sp-2)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <button onClick={onClose} title="Back to ticket" style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--mint-fg-soft)', fontSize: 16, padding: 4 }}>←</button>
        <a href={`https://wealthsimple.atlassian.net/browse/${ticketId}`} target="_blank" rel="noreferrer" style={{ color: 'var(--mint-highlight-fg-strong)', fontWeight: 700, fontSize: 'var(--mint-text-meta)', textDecoration: 'none' }}>{ticketId}</a>
        <span style={{ marginLeft: 'auto', fontSize: 'var(--mint-text-micro)', color: 'var(--mint-fg-soft)' }}>Step {step} of 7</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <h2 style={{ margin: 0, fontSize: 'var(--mint-text-h-md)', fontWeight: 700, color: 'var(--mint-fg-strong)' }}>Overpayment triage</h2>
        <ProgressDots step={step} />
      </div>
    </header>
  );
}

function ProgressDots({ step }: { step: StepNum }) {
  // green ✓ for done, dark filled for current, outlined gray for future
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      {[1, 2, 3, 4, 5, 6].map((n) => {
        const done = n < step;
        const active = n === step;
        if (done) {
          return (
            <span key={n} style={{ width: 14, height: 14, borderRadius: 9999, background: 'var(--mint-positive-fg-graphic)', color: '#fff', fontSize: 9, fontWeight: 800, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>✓</span>
          );
        }
        if (active) {
          return <span key={n} style={{ width: 10, height: 10, borderRadius: 9999, background: 'var(--mint-fg-strong)' }} />;
        }
        return <span key={n} style={{ width: 10, height: 10, borderRadius: 9999, border: '1.5px solid var(--mint-outline-strong)' }} />;
      })}
    </div>
  );
}

function FutureStub({ n }: { n: StepNum }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 'var(--mint-sp-2)',
      padding: '12px var(--mint-sp-3)',
      background: 'var(--mint-bg-subtle)',
      border: 'var(--mint-card-stroke)',
      borderRadius: 'var(--mint-radius-card)',
      opacity: 0.7,
    }}>
      <span style={stepNumberCircleStyle(false)}>{n}</span>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <span style={{ fontSize: 'var(--mint-text-body)', fontWeight: 600, color: 'var(--mint-fg-strong)' }}>{STEP_TITLES[n]}</span>
        <span style={{ fontSize: 'var(--mint-text-micro)', color: 'var(--mint-fg-soft)' }}>Not started</span>
      </div>
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

// ============================================================
// Step 1 — Pull ticket details
// ============================================================

function Step1Body(props: {
  ticket: WocooTicket;
  amount: number | null;
  fmtAmt: string;
  tier: WocooTicket['tier'];
  effectiveAccountId: string;
  accountIdEditOpen: boolean;
  setAccountIdEditOpen: (v: boolean) => void;
  accountIdInput: string;
  setAccountIdInput: (v: string) => void;
  applyAccountIdOverride: () => void;
  fetchAccountId: () => void;
  accountIdFetchPending: boolean;
  amountEditOpen: boolean;
  setAmountEditOpen: (v: boolean) => void;
  manualAmountInput: string;
  setManualAmountInput: (s: string) => void;
  applyManualAmount: () => void;
  // Criteria + approver (formerly Step 2)
  meetsMinimum: boolean;
  approverName: string;
  approverKey: ReimbApproverKey;
  isLarge: boolean;
  approverEditOpen: boolean;
  setApproverEditOpen: (v: boolean) => void;
  setApproverOverride: (v: ReimbApproverKey) => void;
  // Decline-path (amount < $1k)
  declineText: string;
  setDeclineText: (v: string) => void;
  declinePosted: boolean;
  busy: boolean;
  onDecline: () => void;
  // Continue
  showContinue: boolean;
  onContinue: () => void;
}) {
  const amountEditOpen = props.amountEditOpen || props.amount == null;
  const accountIdMissing = !props.effectiveAccountId;
  const accountIdInputOpen = props.accountIdEditOpen || accountIdMissing;
  return (
    <>
      <FieldGrid>
        <FieldCell label="Identity ID" mono action={<CopyIcon value={props.ticket.identityId} />}>
          {truncate(props.ticket.identityId, 14) || <Missing />}
        </FieldCell>
        <FieldCell
          label="Amount"
          action={props.amount != null
            ? <EditIcon onClick={() => props.setAmountEditOpen(!props.amountEditOpen)} title={props.amountEditOpen ? 'Close' : 'Edit'} />
            : null}
        >
          {props.amount != null
            ? <span style={{ color: 'var(--mint-negative-fg-strong)', fontWeight: 700 }}>{props.fmtAmt}</span>
            : <Missing />}
        </FieldCell>
        <FieldCell label="Tier"><TierPill tier={props.tier} /></FieldCell>
        <FieldCell
          label="Account ID"
          mono
          action={accountIdMissing ? null : (
            <>
              <CopyIcon value={props.effectiveAccountId} />
              <EditIcon onClick={() => props.setAccountIdEditOpen(!props.accountIdEditOpen)} title="Override account ID" />
            </>
          )}
        >
          {props.effectiveAccountId || <Missing />}
        </FieldCell>
        <FieldCell label="Client Email" mono action={<CopyIcon value={props.ticket.clientEmail} />}>
          {props.ticket.clientEmail || <Missing />}
        </FieldCell>
        <FieldCell label="Reporter">{props.ticket.reporter}</FieldCell>
      </FieldGrid>

      {amountEditOpen ? (
        <InlineEditCard label={props.amount == null ? "Couldn't auto-detect amount — enter manually" : 'Override amount'}>
          <span style={{ alignSelf: 'center' }}>$</span>
          <input
            type="number" step="0.01"
            value={props.manualAmountInput}
            onChange={(e) => props.setManualAmountInput(e.target.value)}
            placeholder={props.amount != null ? String(props.amount) : '1000.00'}
            style={inlineInput}
          />
          <button onClick={props.applyManualAmount} style={smallPrimaryButton}>Set</button>
        </InlineEditCard>
      ) : null}

      {accountIdInputOpen ? (
        <InlineEditCard label={accountIdMissing ? "Account ID missing — enter manually" : 'Override account ID'}>
          <input
            type="text"
            value={props.accountIdInput}
            onChange={(e) => props.setAccountIdInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') props.applyAccountIdOverride(); }}
            placeholder="e.g. WK5TPMJ32CAD"
            style={inlineInput}
            autoFocus={accountIdMissing}
          />
          <button onClick={props.applyAccountIdOverride} style={smallPrimaryButton}>Set</button>
          <button
            onClick={props.fetchAccountId}
            disabled={!props.ticket.identityId || props.accountIdFetchPending}
            title="Open Atlas → CHEQUING (SPEND) → auto-fill the account number"
            style={{
              padding: '4px 10px',
              background: 'var(--mint-highlight-fg-graphic)',
              color: '#fff',
              border: 'none',
              borderRadius: 'var(--mint-radius-button)',
              fontSize: 'var(--mint-text-nano)',
              fontWeight: 700,
              cursor: !props.ticket.identityId || props.accountIdFetchPending ? 'not-allowed' : 'pointer',
              opacity: !props.ticket.identityId || props.accountIdFetchPending ? 0.6 : 1,
              whiteSpace: 'nowrap',
            }}
          >
            {props.accountIdFetchPending ? 'Fetching…' : '↗ Fetch'}
          </button>
        </InlineEditCard>
      ) : null}

      {/* Acceptance criteria (merged in from former Step 2) */}
      <div style={{ marginTop: 'var(--mint-sp-3)' }}>
        <CheckRow ok={props.meetsMinimum} label="Amount ≥ $1,000" right={<strong style={{ color: 'var(--mint-fg-strong)' }}>{props.fmtAmt}</strong>} />
        <Divider />
        <CheckRow ok={true} label="Tier requirement" right={<TierPill tier={props.tier} />} />
        <Divider />
        <CheckRow
          ok={true}
          label={<>
            <span>Approver: <strong>{props.approverName}</strong></span>
            {/* the $5K authority note only describes the amount-based default —
                a manually picked approver (e.g. Vivian) has no threshold */}
            {props.approverKey === 'vivian' ? null : (
              <span style={{ color: 'var(--mint-fg-soft)', marginLeft: 6 }}>· authority {props.isLarge ? '≥ $5K' : '< $5K'}</span>
            )}
          </>}
          right={<EditIcon onClick={() => props.setApproverEditOpen(!props.approverEditOpen)} title="Override approver" />}
        />
        {props.approverEditOpen ? (
          <InlineEditCard label="Pick approver">
            {REIMB_APPROVER_KEYS.map((k) => {
              const name = REIMB_APPROVERS[k].name;
              const active = k === props.approverKey;
              return (
                <button key={k} onClick={() => props.setApproverOverride(k)} style={{ ...togglePillButton, background: active ? 'var(--mint-fg-strong)' : 'var(--mint-bg-card)', color: active ? 'var(--mint-fg-inverted)' : 'var(--mint-fg-strong)' }}>{name}</button>
              );
            })}
          </InlineEditCard>
        ) : null}
      </div>

      {/* Action: continue OR decline-path when amount < $1k AND tier is Core.
          Premium / Generation under $1k can still be processed as an exception, so we
          skip the templated decline and just show the continue button below. */}
      {props.amount != null && !props.meetsMinimum && props.tier === 'Core' ? (
        <div style={{ marginTop: 'var(--mint-sp-3)', padding: 'var(--mint-sp-3)', background: 'var(--mint-warning-bg-soft)', border: '1px solid var(--mint-warning-fg-graphic)', borderRadius: 'var(--mint-radius-card)' }}>
          <div style={{ fontSize: 'var(--mint-text-nano)', textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--mint-warning-fg-strong)', fontWeight: 700, marginBottom: 6 }}>
            📝 Decline comment (Core client, amount under $1,000)
          </div>
          <textarea
            value={props.declineText}
            onChange={(e) => props.setDeclineText(e.target.value)}
            rows={6}
            disabled={props.declinePosted || props.busy}
            style={{ width: '100%', padding: 'var(--mint-sp-2)', fontFamily: 'var(--mint-font-family)', fontSize: 'var(--mint-text-meta)', border: 'var(--mint-card-stroke)', borderRadius: 'var(--mint-radius-button)', background: 'var(--mint-bg-card)', boxSizing: 'border-box', lineHeight: 1.5, color: 'var(--mint-fg-strong)' }}
          />
          {props.declinePosted ? (
            <div style={{ marginTop: 'var(--mint-sp-2)', fontSize: 'var(--mint-text-micro)', color: 'var(--mint-positive-fg-strong)', fontWeight: 600 }}>✓ Decline comment posted · ticket moved to Done</div>
          ) : props.showContinue ? (
            <div style={{ display: 'flex', gap: 'var(--mint-sp-2)', marginTop: 'var(--mint-sp-2)', flexWrap: 'wrap' }}>
              <button onClick={props.onDecline} disabled={props.busy} style={{ ...primaryButton, background: 'var(--mint-negative-fg-graphic)', opacity: props.busy ? 0.6 : 1, cursor: props.busy ? 'wait' : 'pointer', flex: 1 }}>
                {props.busy ? 'Posting…' : '✉️ Decline & Comment'}
              </button>
              <button onClick={props.onContinue} disabled={props.busy} style={{ ...secondaryButton, color: 'var(--mint-warning-fg-strong)', borderColor: 'var(--mint-warning-fg-graphic)' }}>
                Proceed as exception →
              </button>
            </div>
          ) : null}
        </div>
      ) : props.showContinue ? (
        <div style={{ marginTop: 'var(--mint-sp-3)' }}>
          <button onClick={props.onContinue} disabled={props.amount == null} style={{ ...primaryButton, opacity: props.amount != null ? 1 : 0.55, cursor: props.amount != null ? 'pointer' : 'not-allowed' }}>
            {props.amount != null && !props.meetsMinimum ? 'Proceed as exception →' : 'Criteria met, continue →'}
          </button>
        </div>
      ) : null}
    </>
  );
}

// ============================================================
// Step 2 — Acceptance criteria
// ============================================================

function Step2Body(props: {
  fmtAmt: string;
  amount: number | null;
  meetsMinimum: boolean;
  tier: WocooTicket['tier'];
  approverName: string;
  approverKey: ReimbApproverKey;
  isLarge: boolean;
  approverEditOpen: boolean;
  setApproverEditOpen: (v: boolean) => void;
  setApproverOverride: (v: ReimbApproverKey) => void;
  declineText: string;
  setDeclineText: (v: string) => void;
  declinePosted: boolean;
  busy: boolean;
  onDecline: () => void;
  showContinue: boolean;
  onContinue: () => void;
}) {
  const showDeclinePath = props.amount != null && !props.meetsMinimum;
  return (
    <>
      <CheckRow ok={props.meetsMinimum} label="Amount ≥ $1,000" right={<strong style={{ color: 'var(--mint-fg-strong)' }}>{props.fmtAmt}</strong>} />
      <Divider />
      <CheckRow ok={true} label="Tier requirement" right={<TierPill tier={props.tier} />} />
      <Divider />
      <CheckRow
        ok={true}
        label={<><span>Approver: <strong>{props.approverName}</strong></span> <span style={{ color: 'var(--mint-fg-soft)', marginLeft: 6 }}>· authority {props.isLarge ? '≥ $5K' : '< $5K'}</span></>}
        right={<EditIcon onClick={() => props.setApproverEditOpen(!props.approverEditOpen)} title="Override approver" />}
      />
      {props.approverEditOpen ? (
        <InlineEditCard label="Pick approver">
          {REIMB_APPROVER_KEYS.map((k) => {
            const name = REIMB_APPROVERS[k].name;
            const active = k === props.approverKey;
            return (
              <button key={k} onClick={() => props.setApproverOverride(k)} style={{ ...togglePillButton, background: active ? 'var(--mint-fg-strong)' : 'var(--mint-bg-card)', color: active ? 'var(--mint-fg-inverted)' : 'var(--mint-fg-strong)' }}>{name}</button>
            );
          })}
        </InlineEditCard>
      ) : null}

      {showDeclinePath ? (
        <div style={{ marginTop: 'var(--mint-sp-3)', padding: 'var(--mint-sp-3)', background: 'var(--mint-warning-bg-soft)', border: '1px solid var(--mint-warning-fg-graphic)', borderRadius: 'var(--mint-radius-card)' }}>
          <div style={{ fontSize: 'var(--mint-text-nano)', textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--mint-warning-fg-strong)', fontWeight: 700, marginBottom: 6 }}>
            📝 Decline comment (amount under $1,000)
          </div>
          <textarea
            value={props.declineText}
            onChange={(e) => props.setDeclineText(e.target.value)}
            rows={6}
            disabled={props.declinePosted || props.busy}
            style={{ width: '100%', padding: 'var(--mint-sp-2)', fontFamily: 'var(--mint-font-family)', fontSize: 'var(--mint-text-meta)', border: 'var(--mint-card-stroke)', borderRadius: 'var(--mint-radius-button)', background: 'var(--mint-bg-card)', boxSizing: 'border-box', lineHeight: 1.5, color: 'var(--mint-fg-strong)' }}
          />
          {props.declinePosted ? (
            <div style={{ marginTop: 'var(--mint-sp-2)', fontSize: 'var(--mint-text-micro)', color: 'var(--mint-positive-fg-strong)', fontWeight: 600 }}>✓ Decline comment posted · ticket moved to Done</div>
          ) : props.showContinue ? (
            <div style={{ display: 'flex', gap: 'var(--mint-sp-2)', marginTop: 'var(--mint-sp-2)', flexWrap: 'wrap' }}>
              <button
                onClick={props.onDecline}
                disabled={props.busy}
                style={{ ...primaryButton, background: 'var(--mint-negative-fg-graphic)', opacity: props.busy ? 0.6 : 1, cursor: props.busy ? 'wait' : 'pointer', flex: 1 }}
              >
                {props.busy ? 'Posting…' : '✉️ Decline & Comment'}
              </button>
              <button
                onClick={props.onContinue}
                disabled={props.busy}
                style={{ ...secondaryButton, color: 'var(--mint-warning-fg-strong)', borderColor: 'var(--mint-warning-fg-graphic)' }}
              >
                Proceed as exception →
              </button>
            </div>
          ) : null}
        </div>
      ) : props.showContinue ? (
        <div style={{ marginTop: 'var(--mint-sp-3)' }}>
          <button onClick={props.onContinue} style={primaryButton}>Criteria met, continue →</button>
        </div>
      ) : null}
    </>
  );
}

// ============================================================
// Step 3 — Verify balance
// ============================================================

function Step3Body(props: {
  ticket: WocooTicket;
  fmtAmt: string;
  amount: number | null;
  adjustOpen: boolean;
  setAdjustOpen: (v: boolean) => void;
  adjustedAmountInput: string;
  setAdjustedAmountInput: (s: string) => void;
  applyAdjustedAmount: () => void;
  showContinue: boolean;
  onVerify: () => void;
}) {
  const presetUrl = 'https://8a26d867.wealthsimple-aws-mpc.app.preset.io/superset/dashboard/5790/';
  const atlasUrl = `https://atlas.wealthsimple.com/identity/${props.ticket.identityId}/overview/?ticketId=${props.ticket.id}`;
  const i2cUrl = 'https://wealthsimplecs.mycardplace.com/customerservice/wealthsimplelogin.jsp';
  const stageI2cEmail = () => {
    if (props.ticket.clientEmail) {
      // Set verify_balance flow so the i2c chain knows to: navigate to Account
      // Transactions, switch to Recent Activity, click Search, then scrape and write
      // back the most-recent Running Balance for this ticket.
      void chrome.storage.local.set({
        pending_i2c_email: props.ticket.clientEmail,
        pending_i2c_source_ticket_id: props.ticket.id,
        pending_i2c_flow: 'verify_balance',
        pending_i2c_started_at: Date.now(),
      });
      // Clear any stale flow-specific keys from a previous run.
      void chrome.storage.local.remove(['pending_i2c_ticket_url', 'pending_i2c_admin_debit_amount']);
    }
  };
  const stagePresetIdentity = () => {
    if (props.ticket.identityId) {
      void chrome.storage.local.set({ pending_preset_identity_id: props.ticket.identityId });
    }
  };

  // Read the running balance the i2c content script writes back after Search succeeds.
  // Only display it when sourceTicketId matches this ticket (otherwise it's a stale
  // capture from another customer).
  const [runningBalance, setRunningBalance] = useState<{ value: number; valueText: string; capturedAt: string } | null>(null);
  useEffect(() => {
    const read = () => {
      chrome.storage.local.get('i2c_running_balance').then((res) => {
        const v = res.i2c_running_balance as { sourceTicketId?: string; value?: number; valueText?: string; capturedAt?: string } | undefined;
        if (v && v.sourceTicketId === props.ticket.id && typeof v.value === 'number') {
          setRunningBalance({ value: v.value, valueText: v.valueText || `$${v.value.toFixed(2)}`, capturedAt: v.capturedAt || '' });
        } else {
          setRunningBalance(null);
        }
      });
    };
    read();
    const onChange = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && 'i2c_running_balance' in changes) read();
    };
    chrome.storage.onChanged.addListener(onChange);
    return () => chrome.storage.onChanged.removeListener(onChange);
  }, [props.ticket.id]);
  return (
    <>
      <div style={{ display: 'flex', gap: 'var(--mint-sp-2)', flexWrap: 'wrap', marginBottom: 'var(--mint-sp-3)' }}>
        <a href={presetUrl} target="_blank" rel="noreferrer" onClick={stagePresetIdentity} style={pillLink('highlight')}>Preset ↗</a>
        <a href={atlasUrl} target="_blank" rel="noreferrer" style={pillLink('positive')}>Atlas ↗</a>
        <a href={i2cUrl} target="_blank" rel="noreferrer" onClick={stageI2cEmail} style={pillLink('warning')}>i2c ↗</a>
      </div>
      <div style={{ marginBottom: 'var(--mint-sp-3)' }}>
        <div style={{ fontSize: 'var(--mint-text-nano)', textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--mint-fg-soft)', fontWeight: 700, marginBottom: 6 }}>Filter by</div>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
          <span style={{ flex: 1, padding: '6px 10px', background: 'var(--mint-bg-subtle)', border: 'var(--mint-card-stroke)', borderRadius: 'var(--mint-radius-button)', fontFamily: 'var(--mint-font-mono)', fontSize: 'var(--mint-text-micro)', color: 'var(--mint-fg-strong)', wordBreak: 'break-all', lineHeight: 1.4 }}>
            {props.ticket.identityId}
          </span>
          <CopyIcon value={props.ticket.identityId} />
        </div>
      </div>

      {/* Running balance captured by the i2c content script after clicking i2c ↗ */}
      <div style={{ marginBottom: 'var(--mint-sp-3)' }}>
        <div style={{ fontSize: 'var(--mint-text-nano)', textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--mint-fg-soft)', fontWeight: 700, marginBottom: 6 }}>Running balance (from i2c)</div>
        {runningBalance == null ? (
          <div style={{ padding: '6px 10px', background: 'var(--mint-bg-subtle)', border: 'var(--mint-card-stroke)', borderRadius: 'var(--mint-radius-button)', fontSize: 'var(--mint-text-micro)', color: 'var(--mint-fg-soft)', fontStyle: 'italic' }}>
            Click i2c ↗ to capture
          </div>
        ) : (() => {
          // Compare |running balance| to the ticket's amount. Overpayment running balances
          // are typically negative (credit on the card), so absolute value is what matches.
          const amount = props.amount;
          const diff = amount != null ? Math.abs(Math.abs(runningBalance.value) - amount) : null;
          const matches = diff != null && diff < 0.01;
          return (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ flex: 1, padding: '6px 10px', background: 'var(--mint-bg-subtle)', border: 'var(--mint-card-stroke)', borderRadius: 'var(--mint-radius-button)', fontFamily: 'var(--mint-font-mono)', fontSize: 'var(--mint-text-micro)', color: 'var(--mint-fg-strong)' }}>
                {runningBalance.valueText}
              </span>
              {amount != null ? (
                matches ? (
                  <span style={{ fontSize: 'var(--mint-text-micro)', color: 'var(--mint-positive-fg-strong)', fontWeight: 600 }}>✓ matches</span>
                ) : (
                  <span style={{ fontSize: 'var(--mint-text-micro)', color: 'var(--mint-warning-fg-strong)', fontWeight: 600 }} title={`Ticket amount: $${amount.toFixed(2)}`}>
                    ⚠ differs by ${diff!.toFixed(2)}
                  </span>
                )
              ) : null}
            </div>
          );
        })()}
      </div>

      {props.showContinue ? (
        <>
          <button onClick={props.onVerify} style={{ ...primaryButton, background: 'var(--mint-positive-fg-graphic)', width: '100%' }}>✓ Verified</button>
          <button onClick={() => props.setAdjustOpen(!props.adjustOpen)} style={{ ...secondaryButton, width: '100%', marginTop: 'var(--mint-sp-2)', color: 'var(--mint-warning-fg-strong)', borderColor: 'var(--mint-warning-fg-graphic)' }}>Balance differs</button>
          {props.adjustOpen ? (
            <InlineEditCard label="Enter the verified balance">
              <span style={{ alignSelf: 'center' }}>$</span>
              <input
                type="number" step="0.01"
                value={props.adjustedAmountInput}
                onChange={(e) => props.setAdjustedAmountInput(e.target.value)}
                placeholder="1000.00"
                style={inlineInput}
              />
              <button onClick={props.applyAdjustedAmount} style={smallPrimaryButton}>Use</button>
            </InlineEditCard>
          ) : null}
        </>
      ) : (
        <div style={reviewNote}>Verified at <strong>{props.fmtAmt}</strong> earlier.</div>
      )}
    </>
  );
}

// ============================================================
// Step 4 — Create REIMB ticket
// ============================================================

function Step4Body(props: {
  ticket: WocooTicket;
  fmtAmt: string;
  effectiveTier: WocooTicket['tier'];
  effectiveAccountId: string;
  accountIdValid: boolean;
  approverKey: ReimbApproverKey;
  approverName: string;
  amountEditOpen: boolean;
  setAmountEditOpen: (v: boolean) => void;
  manualAmountInput: string;
  setManualAmountInput: (v: string) => void;
  applyManualAmount: () => void;
  tierEditOpen: boolean;
  setTierEditOpen: (v: boolean) => void;
  setTierOverride: (v: WocooTicket['tier']) => void;
  approverEditOpen: boolean;
  setApproverEditOpen: (v: boolean) => void;
  setApproverOverride: (v: ReimbApproverKey) => void;
  accountIdEditOpen: boolean;
  setAccountIdEditOpen: (v: boolean) => void;
  accountIdInput: string;
  setAccountIdInput: (v: string) => void;
  applyAccountIdOverride: () => void;
  fetchAccountId: () => void;
  accountIdFetchPending: boolean;
  busy: boolean;
  alreadyCreated: boolean;
  reimbKey: string | null;
  reimbUrl: string | null;
  showActionButton: boolean;
  onCreate: () => void;
}) {
  const summary = `Credit card overpayment reimbursement for ${props.ticket.id}`;
  return (
    <div style={{ background: 'var(--mint-bg-subtle)', border: 'var(--mint-card-stroke)', borderRadius: 'var(--mint-radius-card)', padding: 'var(--mint-sp-3)' }}>
      <div style={{ fontSize: 'var(--mint-text-nano)', textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--mint-fg-soft)', fontWeight: 700, marginBottom: 6 }}>Summary</div>
      <div style={{ fontSize: 'var(--mint-text-meta)', color: 'var(--mint-fg-strong)', lineHeight: 1.5, marginBottom: 'var(--mint-sp-2)' }}>{summary}</div>
      <Divider />

      <FieldRowStack>
        <FieldRow label="Identity" mono>{truncate(props.ticket.identityId, 18)}</FieldRow>
        <FieldRow
          label="Amount"
          action={!props.alreadyCreated ? <EditIcon onClick={() => props.setAmountEditOpen(!props.amountEditOpen)} title="Override amount" /> : null}
        >
          <span style={{ color: 'var(--mint-negative-fg-strong)', fontWeight: 700 }}>{props.fmtAmt}</span>
        </FieldRow>
        {props.amountEditOpen && !props.alreadyCreated ? (
          <InlineEditCard label="Override amount">
            <input
              type="number"
              value={props.manualAmountInput}
              onChange={(e) => props.setManualAmountInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') props.applyManualAmount(); }}
              placeholder="e.g. 2183.55"
              style={inlineInput}
              autoFocus
            />
            <button onClick={props.applyManualAmount} style={smallPrimaryButton}>Set</button>
          </InlineEditCard>
        ) : null}
        <FieldRow
          label="Approver"
          action={!props.alreadyCreated ? <EditIcon onClick={() => props.setApproverEditOpen(!props.approverEditOpen)} title="Override approver" /> : null}
        >
          {props.approverName}
        </FieldRow>
        {props.approverEditOpen && !props.alreadyCreated ? (
          <InlineEditCard label="Pick approver">
            {REIMB_APPROVER_KEYS.map((k) => {
              const name = REIMB_APPROVERS[k].name;
              const active = k === props.approverKey;
              return (
                <button key={k} onClick={() => props.setApproverOverride(k)} style={{ ...togglePillButton, background: active ? 'var(--mint-fg-strong)' : 'var(--mint-bg-card)', color: active ? 'var(--mint-fg-inverted)' : 'var(--mint-fg-strong)' }}>{name}</button>
              );
            })}
          </InlineEditCard>
        ) : null}

        <FieldRow
          label="Tier"
          action={!props.alreadyCreated ? <EditIcon onClick={() => props.setTierEditOpen(!props.tierEditOpen)} title="Override tier" /> : null}
        >
          <TierPill tier={props.effectiveTier} />
        </FieldRow>
        {props.tierEditOpen && !props.alreadyCreated ? (
          <InlineEditCard label="Pick tier">
            {(['Core', 'Premium', 'Generation'] as const).map((t) => (
              <button key={t} onClick={() => props.setTierOverride(t)} style={{ ...togglePillButton, background: t === props.effectiveTier ? 'var(--mint-fg-strong)' : 'var(--mint-bg-card)', color: t === props.effectiveTier ? 'var(--mint-fg-inverted)' : 'var(--mint-fg-strong)' }}>{t}</button>
            ))}
          </InlineEditCard>
        ) : null}

        {(() => {
          const accountIdMissing = !props.effectiveAccountId;
          const inputOpen = (props.accountIdEditOpen || accountIdMissing) && !props.alreadyCreated;
          return (
            <>
              <FieldRow
                label="Account ID"
                mono
                action={!props.alreadyCreated && !accountIdMissing
                  ? <EditIcon onClick={() => props.setAccountIdEditOpen(!props.accountIdEditOpen)} title="Override account ID" />
                  : null}
              >
                {props.effectiveAccountId ? props.effectiveAccountId : <Missing />}
                {!props.accountIdValid && props.effectiveAccountId ? (
                  <span style={{ color: 'var(--mint-negative-fg-strong)', fontSize: 'var(--mint-text-nano)', marginLeft: 6, fontFamily: 'var(--mint-font-family)' }}>invalid</span>
                ) : null}
              </FieldRow>
              {inputOpen ? (
                <InlineEditCard label={accountIdMissing ? "Account ID missing — enter manually" : 'Override account ID'}>
                  <input
                    type="text"
                    value={props.accountIdInput}
                    onChange={(e) => props.setAccountIdInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') props.applyAccountIdOverride(); }}
                    placeholder="e.g. WK5TPMJ32CAD"
                    style={inlineInput}
                    autoFocus={accountIdMissing}
                  />
                  <button onClick={props.applyAccountIdOverride} style={smallPrimaryButton}>Set</button>
                  <button
                    onClick={props.fetchAccountId}
                    disabled={!props.ticket.identityId || props.accountIdFetchPending}
                    title="Open Atlas → CHEQUING (SPEND) → auto-fill the account number"
                    style={{
                      padding: '4px 10px',
                      background: 'var(--mint-highlight-fg-graphic)',
                      color: '#fff',
                      border: 'none',
                      borderRadius: 'var(--mint-radius-button)',
                      fontSize: 'var(--mint-text-nano)',
                      fontWeight: 700,
                      cursor: !props.ticket.identityId || props.accountIdFetchPending ? 'not-allowed' : 'pointer',
                      opacity: !props.ticket.identityId || props.accountIdFetchPending ? 0.6 : 1,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {props.accountIdFetchPending ? 'Fetching…' : '↗ Fetch'}
                  </button>
                </InlineEditCard>
              ) : null}
            </>
          );
        })()}
      </FieldRowStack>

      {props.alreadyCreated && props.reimbKey ? (
        <>
          <Divider />
          <div style={{ fontSize: 'var(--mint-text-micro)', color: 'var(--mint-positive-fg-strong)' }}>
            ✓ Created as <a href={props.reimbUrl!} target="_blank" rel="noreferrer" style={{ color: 'var(--mint-positive-fg-strong)', fontWeight: 700 }}>{props.reimbKey}</a>
          </div>
          <div style={{ marginTop: 'var(--mint-sp-1)', fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-soft)', fontStyle: 'italic' }}>
            To create a different REIMB, cancel this one in Jira and restart the triage.
          </div>
        </>
      ) : null}

      {props.showActionButton && !props.alreadyCreated ? (
        <div style={{ marginTop: 'var(--mint-sp-3)' }}>
          <button onClick={props.onCreate} disabled={props.busy || !props.accountIdValid} style={{ ...primaryButton, background: 'var(--mint-positive-fg-graphic)', width: '100%', opacity: (props.busy || !props.accountIdValid) ? 0.6 : 1, cursor: (props.busy || !props.accountIdValid) ? 'not-allowed' : 'pointer' }}>
            {props.busy ? 'Creating…' : '✓ Create REIMB ticket'}
          </button>
        </div>
      ) : null}
    </div>
  );
}

// ============================================================
// Step 5 — Admin debit
// ============================================================

function Step5Body({ fmtAmt, clientEmail, ticketId, amount, alreadyDone, showActionButton, onConfirm }: { fmtAmt: string; clientEmail: string; ticketId: string; amount: number | null; alreadyDone: boolean; showActionButton: boolean; onConfirm: () => void }) {
  const i2cUrl = 'https://wealthsimplecs.mycardplace.com/customerservice/wealthsimplelogin.jsp';
  // "Apply Admin Debit" launches the admin_debit chain in the i2c content script:
  // sign in → kill session → search by email → Continue with this Customer → click
  // Administrative Services sidebar → select Admin Funds Debit → fill Amount (positive)
  // + Comments (ticket URL). Agent reviews + clicks Apply manually.
  const stageAdminDebit = () => {
    if (!clientEmail || amount == null) return;
    void chrome.storage.local.set({
      pending_i2c_email: clientEmail,
      pending_i2c_flow: 'admin_debit',
      pending_i2c_ticket_url: `https://wealthsimple.atlassian.net/browse/${ticketId}`,
      pending_i2c_admin_debit_amount: amount.toFixed(2),
      pending_i2c_started_at: Date.now(),
    });
  };
  const disabled = !clientEmail || amount == null;
  return (
    <>
      <NumberedList>
        <NumberedItem n={1}>Click <strong>Apply Admin Debit</strong> — i2c opens with the form pre-filled</NumberedItem>
        <NumberedItem n={2}>Review the Service / Amount / Comments fields</NumberedItem>
        <NumberedItem n={3}>Click <strong>Apply</strong> on the i2c page to submit, then return here</NumberedItem>
      </NumberedList>
      <a
        href={disabled ? undefined : i2cUrl}
        target="_blank"
        rel="noreferrer"
        onClick={disabled ? (e) => e.preventDefault() : stageAdminDebit}
        aria-disabled={disabled}
        style={{
          ...pillLink('warning'),
          display: 'block',
          textAlign: 'center',
          marginTop: 'var(--mint-sp-3)',
          width: '100%',
          boxSizing: 'border-box',
          opacity: disabled ? 0.55 : 1,
          pointerEvents: disabled ? 'none' : 'auto',
        }}
        title={amount == null ? 'Amount not set' : !clientEmail ? 'Client email missing' : `Apply $${amount.toFixed(2)} debit in i2c`}
      >
        Apply Admin Debit ({fmtAmt}) ↗
      </a>
      {showActionButton && !alreadyDone ? (
        <div style={{ marginTop: 'var(--mint-sp-2)' }}>
          <button onClick={onConfirm} style={{ ...primaryButton, width: '100%' }}>✓ Admin debit applied</button>
        </div>
      ) : alreadyDone ? (
        <div style={{ marginTop: 'var(--mint-sp-2)', fontSize: 'var(--mint-text-micro)', color: 'var(--mint-positive-fg-strong)' }}>✓ Confirmed applied.</div>
      ) : null}
    </>
  );
}

// ============================================================
// Step 6 — Post comment
// ============================================================

function Step6Body(props: {
  ticket: WocooTicket;
  commentText: string;
  setCommentText: (v: string) => void;
  commentEditing: boolean;
  setCommentEditing: (v: boolean) => void;
  busy: boolean;
  alreadyPosted: boolean;
  showActionButton: boolean;
  reimbKey: string | null;
  onPost: () => void;
}) {
  // Render the comment text with @mention and [REIMB-key] inline-styled segments for preview
  return (
    <>
      {props.commentEditing ? (
        <textarea
          value={props.commentText}
          onChange={(e) => props.setCommentText(e.target.value)}
          rows={6}
          style={{ width: '100%', padding: 'var(--mint-sp-2)', fontFamily: 'var(--mint-font-family)', fontSize: 'var(--mint-text-meta)', border: 'var(--mint-card-stroke)', borderRadius: 'var(--mint-radius-button)', background: 'var(--mint-bg-card)', boxSizing: 'border-box', lineHeight: 1.5 }}
        />
      ) : (
        <div style={{ padding: 'var(--mint-sp-3)', background: 'var(--mint-bg-subtle)', border: 'var(--mint-card-stroke)', borderRadius: 'var(--mint-radius-card)', fontSize: 'var(--mint-text-meta)', lineHeight: 1.6, color: 'var(--mint-fg-strong)' }}>
          <CommentPreview text={props.commentText} reporter={props.ticket.reporter} reimbKey={props.reimbKey} />
        </div>
      )}
      {props.showActionButton && !props.alreadyPosted ? (
        <div style={{ marginTop: 'var(--mint-sp-2)', display: 'flex', gap: 'var(--mint-sp-2)' }}>
          <button onClick={() => props.setCommentEditing(!props.commentEditing)} style={{ ...secondaryButton, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            {props.commentEditing ? '✓ Done editing' : '✏ Edit'}
          </button>
          <button onClick={props.onPost} disabled={props.busy} style={{ ...primaryButton, flex: 1, opacity: props.busy ? 0.6 : 1, cursor: props.busy ? 'wait' : 'pointer' }}>
            {props.busy ? 'Posting & moving…' : 'Review, approve & move to Done'}
          </button>
        </div>
      ) : props.alreadyPosted ? (
        <div style={{ marginTop: 'var(--mint-sp-2)', fontSize: 'var(--mint-text-micro)', color: 'var(--mint-positive-fg-strong)' }}>✓ Posted and moved to Done.</div>
      ) : null}
    </>
  );
}

function CommentPreview({ text, reporter, reimbKey }: { text: string; reporter: string; reimbKey: string | null }) {
  // Visually style @<reporter> as a mention pill and [REIMB-KEY] as a link
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

// ============================================================
// Step 6 — Success
// ============================================================

function SuccessPanel({ reimbKey, reimbUrl, ticketId, fmtAmt, onCloseToTicket, onReload }: { reimbKey: string | null; reimbUrl: string | null; ticketId: string; fmtAmt: string; onCloseToTicket: () => void; onReload: () => void }) {
  return (
    <section style={{ background: 'var(--mint-positive-bg-soft)', border: '1px solid var(--mint-positive-fg-graphic)', borderRadius: 'var(--mint-radius-card)', padding: 'var(--mint-sp-4)', textAlign: 'center' }}>
      <div style={{ width: 48, height: 48, margin: '0 auto var(--mint-sp-2)', borderRadius: 9999, background: 'var(--mint-positive-fg-graphic)', color: '#fff', fontSize: 24, fontWeight: 800, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>✓</div>
      <h3 style={{ margin: 0, fontSize: 'var(--mint-text-h-md)', color: 'var(--mint-fg-strong)', fontWeight: 700 }}>Triage complete</h3>
      <p style={{ margin: 'var(--mint-sp-2) 0 var(--mint-sp-3)', fontSize: 'var(--mint-text-meta)', color: 'var(--mint-fg-subdued-title)', lineHeight: 1.6 }}>
        {reimbKey ? <a href={reimbUrl!} target="_blank" rel="noreferrer" style={{ color: 'var(--mint-fg-strong)', fontWeight: 600 }}>{reimbKey}</a> : '—'}
        {' · '}Admin Debit Applied · Comment Posted · Moved to Done
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--mint-sp-2)' }}>
        <button onClick={onCloseToTicket} style={{ ...primaryButton, width: '100%' }}>Close & return to ticket</button>
        <button onClick={onReload} style={{ ...secondaryButton, width: '100%' }}>Close & reload dashboard</button>
      </div>
      <div style={{ fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-soft)', marginTop: 'var(--mint-sp-2)' }}>
        Open <a href={`https://wealthsimple.atlassian.net/browse/${ticketId}`} target="_blank" rel="noreferrer" style={{ color: 'var(--mint-highlight-fg-strong)' }}>{ticketId}</a> in Jira to verify.
      </div>
    </section>
  );
}

// ============================================================
// helpers (extraction + comment building)
// ============================================================

function extractAmountFromDescription(desc: string): number | null {
  if (!desc) return null;
  // Overpayments are often written as a negative ("-$7,405.79" / "-7405.79"), so
  // match an optional sign on either side of the $ and normalise to a magnitude.
  const patterns = [
    /-?\$\s?-?([\d,]+\.\d{2})/, // $7,405.79 / -$7,405.79 / $-7,405.79
    /-?\b(\d[\d,]*\.\d{2})\b/,  // bare 7405.79 / -7405.79
  ];
  for (const re of patterns) {
    const m = desc.match(re);
    if (!m) continue;
    const n = parseFloat(m[1].replace(/,/g, ''));
    if (isFinite(n) && n > 0) return n;
  }
  return null;
}

function buildCommentText(ticket: WocooTicket, reimbKey: string, amount: number): string {
  const mention = ticket.reporter ? `@${ticket.reporter}` : 'team';
  return `Hi ${mention}, a reimbursement ticket has been created ${reimbKey}. ` +
    `You can let the client know to expect the overpayment amount of $${amount.toFixed(2)} ` +
    `back in their chequing account within the next 2-3 business days.`;
}

function buildCommentSegments(ticket: WocooTicket, reimbKey: string, reimbUrl: string, amount: number, customText?: string) {
  if (customText && customText.trim()) {
    const segments: Array<{ type: 'text' | 'mention' | 'link'; text: string; accountId?: string; href?: string }> = [];
    let working = customText;
    if (ticket.reporter && ticket.reporterAccountId) {
      const i = working.indexOf('@' + ticket.reporter);
      if (i !== -1) {
        if (i > 0) segments.push({ type: 'text', text: working.slice(0, i) });
        segments.push({ type: 'mention', text: '@' + ticket.reporter, accountId: ticket.reporterAccountId });
        working = working.slice(i + 1 + ticket.reporter.length);
      }
    }
    const j = working.indexOf(reimbKey);
    if (j !== -1) {
      if (j > 0) segments.push({ type: 'text', text: working.slice(0, j) });
      segments.push({ type: 'link', text: reimbKey, href: reimbUrl });
      working = working.slice(j + reimbKey.length);
    }
    if (working) segments.push({ type: 'text', text: working });
    return segments;
  }
  const useMention = !!ticket.reporterAccountId;
  return [
    { type: 'text' as const, text: 'Hi ' },
    useMention
      ? { type: 'mention' as const, text: '@' + ticket.reporter, accountId: ticket.reporterAccountId }
      : { type: 'text' as const, text: 'team' },
    { type: 'text' as const, text: ', a reimbursement ticket has been created ' },
    { type: 'link' as const, text: reimbKey, href: reimbUrl },
    { type: 'text' as const, text: `. You can let the client know to expect the overpayment amount of $${amount.toFixed(2)} back in their chequing account within the next 2-3 business days.` },
  ];
}

/** Build ADF segments for the under-$1,000 decline comment. Just splits out the @mention. */
function buildDeclineCommentSegments(ticket: WocooTicket, text: string) {
  const segments: Array<{ type: 'text' | 'mention' | 'link'; text: string; accountId?: string; href?: string }> = [];
  let working = text;
  if (ticket.reporter && ticket.reporterAccountId) {
    const i = working.indexOf('@' + ticket.reporter);
    if (i !== -1) {
      if (i > 0) segments.push({ type: 'text', text: working.slice(0, i) });
      segments.push({ type: 'mention', text: '@' + ticket.reporter, accountId: ticket.reporterAccountId });
      working = working.slice(i + 1 + ticket.reporter.length);
    }
  }
  if (working) segments.push({ type: 'text', text: working });
  return segments;
}

function truncate(s: string | null | undefined, max: number): string {
  if (!s) return '';
  if (s.length <= max) return s;
  return s.slice(0, max) + '…';
}

// ============================================================
// small visual building blocks
// ============================================================

function FieldGrid({ children }: { children: React.ReactNode }) {
  return <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 'var(--mint-sp-3)' }}>{children}</div>;
}

function FieldCell({ label, mono, action, children }: { label: string; mono?: boolean; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 'var(--mint-text-nano)', textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--mint-fg-soft)', fontWeight: 700, marginBottom: 4 }}>{label}</div>
      {/* wrap so an action pill that can't fit beside the value drops onto its own
          line under the value instead of overflowing the panel */}
      <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6, rowGap: 4, fontSize: 'var(--mint-text-micro)', color: 'var(--mint-fg-strong)', fontFamily: mono ? 'var(--mint-font-mono)' : 'inherit' }}>
        <span style={{ minWidth: 0, maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{children}</span>
        {action}
      </div>
    </div>
  );
}

function FieldRowStack({ children }: { children: React.ReactNode }) {
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>{children}</div>;
}

function FieldRow({ label, mono, action, children }: { label: string; mono?: boolean; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--mint-sp-2)', padding: '6px 0' }}>
      <div style={{ fontSize: 'var(--mint-text-micro)', color: 'var(--mint-fg-soft)', fontWeight: 500 }}>{label}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--mint-text-micro)', color: 'var(--mint-fg-strong)', fontFamily: mono ? 'var(--mint-font-mono)' : 'inherit', textAlign: 'right', minWidth: 0 }}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{children}</span>
        {action}
      </div>
    </div>
  );
}

function Divider() {
  return <div style={{ height: 1, background: 'var(--mint-outline)', margin: 'var(--mint-sp-2) 0' }} />;
}

function Missing() {
  return <span style={{ color: 'var(--mint-negative-fg-strong)', fontStyle: 'italic', fontFamily: 'var(--mint-font-family)' }}>missing</span>;
}

function CheckRow({ ok, label, right }: { ok: boolean; label: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '8px 0', fontSize: 'var(--mint-text-meta)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ width: 18, height: 18, borderRadius: 9999, background: ok ? 'var(--mint-positive-fg-graphic)' : 'var(--mint-warning-fg-graphic)', color: '#fff', fontSize: 11, fontWeight: 800, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
          {ok ? '✓' : '!'}
        </span>
        <div>{label}</div>
      </div>
      {right ? <div>{right}</div> : null}
    </div>
  );
}

function TierPill({ tier }: { tier: WocooTicket['tier'] }) {
  return (
    <span style={{ padding: '2px 8px', background: 'var(--mint-highlight-bg-soft)', color: 'var(--mint-highlight-fg-strong)', borderRadius: 9999, fontSize: 'var(--mint-text-micro)', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <span style={{ width: 4, height: 4, borderRadius: 9999, background: 'currentColor' }} />
      {tier}
    </span>
  );
}

function NumberedList({ children }: { children: React.ReactNode }) {
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>{children}</div>;
}

function NumberedItem({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--mint-sp-2)', fontSize: 'var(--mint-text-meta)', color: 'var(--mint-fg-strong)', lineHeight: 1.5 }}>
      <span style={{ width: 18, height: 18, borderRadius: 9999, background: 'var(--mint-bg-subtle)', border: 'var(--mint-card-stroke)', color: 'var(--mint-fg-subdued-title)', fontSize: 11, fontWeight: 700, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginTop: 1 }}>
        {n}
      </span>
      <span>{children}</span>
    </div>
  );
}

function InlineEditCard({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginTop: 'var(--mint-sp-2)', padding: 'var(--mint-sp-2) var(--mint-sp-3)', background: 'var(--mint-warning-bg-soft)', borderRadius: 'var(--mint-radius-button)' }}>
      <div style={{ fontSize: 'var(--mint-text-nano)', textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--mint-warning-fg-strong)', fontWeight: 700, marginBottom: 6 }}>{label}</div>
      <div style={{ display: 'flex', gap: 6, rowGap: 6, alignItems: 'center', flexWrap: 'wrap' }}>{children}</div>
    </div>
  );
}

function CopyIcon({ value }: { value: string | null | undefined }) {
  const [copied, setCopied] = useState(false);
  if (!value) return null;
  return (
    <button
      onClick={() => { if (navigator.clipboard && value) { navigator.clipboard.writeText(value).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1200); }); } }}
      title="Copy"
      style={{ width: 20, height: 20, padding: 0, background: 'transparent', border: 'none', borderRadius: 4, color: 'var(--mint-fg-soft)', fontSize: 12, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
    >
      {copied ? '✓' : '⧉'}
    </button>
  );
}

function EditIcon({ onClick, title, label = 'Override' }: { onClick: () => void; title: string; label?: string }) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        padding: '3px 8px',
        background: 'var(--mint-bg-card)',
        border: 'var(--mint-card-stroke)',
        borderRadius: 'var(--mint-radius-pill)',
        color: 'var(--mint-fg-subdued-title)',
        fontSize: 'var(--mint-text-nano)',
        fontWeight: 600,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      }}
    >
      <span style={{ fontSize: 10 }}>✏</span> {label}
    </button>
  );
}

// ============================================================
// styles (button + pill primitives)
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
const smallPrimaryButton: React.CSSProperties = {
  padding: '6px 12px',
  borderRadius: 'var(--mint-radius-button)',
  fontWeight: 600,
  fontSize: 'var(--mint-text-micro)',
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
const togglePillButton: React.CSSProperties = {
  padding: '4px 12px',
  borderRadius: 'var(--mint-radius-pill)',
  fontWeight: 600,
  fontSize: 'var(--mint-text-micro)',
  border: 'var(--mint-card-stroke)',
  cursor: 'pointer',
};
function pillLink(tone: 'highlight' | 'positive' | 'warning'): React.CSSProperties {
  return {
    padding: '8px 16px',
    background: `var(--mint-${tone}-bg-soft)`,
    color: `var(--mint-${tone}-fg-strong)`,
    border: '1px solid currentColor',
    borderRadius: 'var(--mint-radius-button)',
    fontSize: 'var(--mint-text-meta)',
    fontWeight: 600,
    textDecoration: 'none',
    flex: 1,
    textAlign: 'center',
  };
}
const inlineInput: React.CSSProperties = {
  flex: 1,
  minWidth: 0, // default flex min-width is auto → causes overflow when content > available
  padding: '6px 10px',
  fontFamily: 'var(--mint-font-mono)',
  fontSize: 'var(--mint-text-micro)',
  border: 'var(--mint-card-stroke)',
  borderRadius: 'var(--mint-radius-button)',
  background: 'var(--mint-bg-card)',
  color: 'var(--mint-fg-strong)',
  boxSizing: 'border-box',
};
const errorBanner: React.CSSProperties = {
  padding: '8px 12px',
  background: 'var(--mint-negative-bg-soft)',
  color: 'var(--mint-negative-fg-strong)',
  fontSize: 'var(--mint-text-meta)',
  borderRadius: 'var(--mint-radius-button)',
};
const reviewNote: React.CSSProperties = {
  fontSize: 'var(--mint-text-micro)',
  color: 'var(--mint-fg-soft)',
  fontStyle: 'italic',
};
