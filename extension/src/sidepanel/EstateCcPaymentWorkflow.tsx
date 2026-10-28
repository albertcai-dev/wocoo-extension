// Estate CC Payment workflow — pays off a deceased client's credit card from their SPEND
// chequing, then comments on the ticket and marks it Done.
//
// Step 1: Verify balance — Pantheon balance shown up front; the shared VerifyBalanceStep
//         offers the i2c live capture. Verified / Balance differs unlock step 2.
// Step 2: Confirm & pay — stop conditions, then an "Are you sure?" dialog. Pay sends
//         Atlas's own logRolesAndScopes + AdminCreateCreditPayment, guarded so one ticket
//         can only ever send one mutation (in-flight ref here, shared promise in the API,
//         server-side idempotency keyed on the ticket).
// Step 3: Payment result — polls until `succeeded`; nothing below unlocks otherwise.
// Step 4: Post comment & Mark as Done — the Reverse Fee doPostAndDone pattern.
//
// Reopening the tile after paying resumes from the stored payment id (or the ticket's
// existing payment) at step 3 and never offers Pay again.
// See docs/superpowers/specs/2026-10-28-estate-cc-payment-design.md.

import { useEffect, useRef, useState } from 'react';
import type { WocooTicket } from '../data/mockTicket';
import { postComment, transitionTicket } from '../api/jira';
import { markWorkflowHandled } from '../data/outcomeCapture';
import { fetchAtlasClientDetailsViaGraphql } from '../data/atlasGraphql';
import {
  amountOwed,
  buildEstateComment,
  extractAccountNumbers,
  formatPaymentAmount,
  strangerAccountNumbers,
  type CreditPayment,
} from '../data/estateCcPayment';
import {
  loadEstateLookup,
  loadEstateState,
  payEstateCard,
  waitForSucceeded,
  type EstateLookup,
} from '../data/estateCcPaymentApi';
import { VerifyBalanceStep } from './VerifyBalanceStep';

const TRANSITION_TO_DONE_ID = '251';

type StepNum = 1 | 2 | 3 | 4 | 5;

const STEP_TITLES: Record<StepNum, string> = {
  1: 'Verify balance',
  2: 'Confirm & pay',
  3: 'Payment result',
  4: 'Post comment & Mark as Done',
  5: 'Complete',
};

const STEP_SUBTITLES: Record<StepNum, string> = {
  1: 'Pantheon balance, plus an optional live i2c check',
  2: 'Check the accounts, then confirm the payment',
  3: 'Waiting for Atlas to report succeeded',
  4: 'Review, then post + close the ticket',
  5: '',
};

type LookupState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; lookup: EstateLookup };

type ResultState =
  | { kind: 'idle' }
  | { kind: 'checking'; paymentId: string | null }
  | { kind: 'done'; paymentId: string | null; payment: CreditPayment | null };

function fmtMoney(n: number): string {
  return `$${formatPaymentAmount(n)}`;
}

function fmtAsOf(asOf: string): string {
  const d = new Date(`${asOf.slice(0, 10)}T12:00:00`);
  return Number.isNaN(d.getTime()) ? asOf : d.toLocaleDateString('en-CA', { month: 'short', day: 'numeric' });
}

export function EstateCcPaymentWorkflow({ ticket, onClose, onTicketUpdate }: { ticket: WocooTicket; onClose: () => void; onTicketUpdate: (t: WocooTicket) => void }) {
  const [step, setStep] = useState<StepNum>(1);
  const [lookupState, setLookupState] = useState<LookupState>({ kind: 'loading' });
  const [lookupRun, setLookupRun] = useState(0);
  const [result, setResult] = useState<ResultState>({ kind: 'idle' });

  // Step 1 state
  const [i2cBalance, setI2cBalance] = useState<number | null>(null);
  const [verifiedAmount, setVerifiedAmount] = useState<{ amount: number | null; source: string } | null>(null);
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [adjustedAmountInput, setAdjustedAmountInput] = useState('');

  // Step 2 state
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [paying, setPaying] = useState(false);
  const payingRef = useRef(false);
  const [clientName, setClientName] = useState<string | null>(null);

  // Step 4 state
  const [commentText, setCommentText] = useState<string>(buildEstateComment(ticket.reporter || undefined));
  const [commentEditing, setCommentEditing] = useState(false);
  const [commentPosted, setCommentPosted] = useState(false);
  const [transitionedToDone, setTransitionedToDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const lookup = lookupState.kind === 'ready' ? lookupState.lookup : null;
  const card = lookup?.card.kind === 'ok' ? lookup.card : null;
  const cardId = card?.card.accountCanonicalId ?? null;
  const pantheonOwed = card ? amountOwed(card.card.totalBalance) : null;

  // Re-check the ticket's payment until it is succeeded (or give up with the last status).
  async function checkPayment(forCardId: string, paymentId: string | null) {
    setResult({ kind: 'checking', paymentId });
    try {
      const payment = await waitForSucceeded(forCardId, ticket.id);
      setResult({ kind: 'done', paymentId: payment?.id ?? paymentId, payment });
    } catch (e: any) {
      setResult({ kind: 'done', paymentId, payment: null });
      setError(e?.message || String(e));
    }
  }

  // Mount (and Retry): stored payment → resume at the result; else look everything up.
  useEffect(() => {
    let cancelled = false;
    setLookupState({ kind: 'loading' });
    setError(null);
    (async () => {
      try {
        if (!ticket.identityId) throw new Error('This ticket has no Identity ID.');
        const [stored, l] = await Promise.all([
          loadEstateState(ticket.id),
          loadEstateLookup(ticket.identityId, ticket.id),
        ]);
        if (cancelled) return;
        setLookupState({ kind: 'ready', lookup: l });
        const lCardId = l.card.kind === 'ok' ? l.card.card.accountCanonicalId : null;
        if (l.existing) {
          setStep(3);
          if (l.existing.status === 'succeeded') {
            setResult({ kind: 'done', paymentId: l.existing.id, payment: l.existing });
          } else if (lCardId) {
            void checkPayment(lCardId, l.existing.id);
          }
        } else if (stored) {
          // Stored id but the payment isn't listed yet: still never offer Pay again.
          setStep(3);
          if (lCardId) void checkPayment(lCardId, stored.paymentId);
          else setResult({ kind: 'done', paymentId: stored.paymentId, payment: null });
        }
      } catch (e: any) {
        if (cancelled) return;
        // Even when the lookup fails, a stored payment means this ticket was already paid.
        const stored = await loadEstateState(ticket.id).catch(() => null);
        if (cancelled) return;
        if (stored) {
          setStep(3);
          setResult({ kind: 'done', paymentId: stored.paymentId, payment: null });
        }
        setLookupState({ kind: 'error', message: e?.message || String(e) });
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticket.id, ticket.identityId, lookupRun]);

  // Client name for the confirm dialog — best effort, display only.
  useEffect(() => {
    if (!ticket.identityId) return;
    fetchAtlasClientDetailsViaGraphql({ identityId: ticket.identityId })
      .then((d) => setClientName(d.name || null))
      .catch(() => setClientName(null));
  }, [ticket.identityId]);

  // --- Step 1 ---
  const liveAmount = i2cBalance != null && i2cBalance > 0 ? Math.round(i2cBalance * 100) / 100 : null;
  function doVerified() {
    if (i2cBalance != null) {
      setVerifiedAmount({ amount: liveAmount, source: 'i2c live running balance' });
    } else {
      setVerifiedAmount({
        amount: pantheonOwed,
        source: card ? `Pantheon as of ${fmtAsOf(card.card.asOf)}` : 'Pantheon',
      });
    }
    setAdjustOpen(false);
    setError(null);
    setStep(2);
  }
  function applyAdjustedAmount() {
    const n = parseFloat(adjustedAmountInput);
    if (!isFinite(n) || n <= 0) { setError('Enter a positive amount.'); return; }
    setVerifiedAmount({ amount: Math.round(n * 100) / 100, source: 'entered by you (balance differs)' });
    setAdjustOpen(false);
    setError(null);
    setStep(2);
  }

  // --- Step 2: stop conditions ---
  const named = extractAccountNumbers(ticket.description || '');
  const strangers = lookup ? strangerAccountNumbers(named, lookup.ownedAccountNumbers) : [];
  const amount = verifiedAmount?.amount ?? null;
  const stops: string[] = [];
  if (!lookup) stops.push('Account lookup has not finished.');
  if (lookup) {
    if (lookup.existing) stops.push(`This ticket already has a payment (${lookup.existing.id}).`);
    if (lookup.card.kind === 'none') stops.push('No credit card found for this client.');
    if (lookup.card.kind === 'multiple') stops.push(`Multiple cards (${lookup.card.count}) — do this one manually.`);
    if (!lookup.spendSlug) stops.push('No SPEND chequing link found for this client.');
    if (strangers.length > 0) stops.push(`The ticket names account numbers that don't belong to this chequing or card: ${strangers.join(', ')}.`);
  }
  if (amount == null || amount <= 0) stops.push('Nothing owed — the card may already be paid off or in credit.');
  if (result.kind !== 'idle') stops.push('A payment was already sent for this ticket.');
  const canPay = stops.length === 0;
  const spendNumber = lookup?.ownedAccountNumbers.find((n) => /^W/i.test(n)) ?? null;

  async function doPay() {
    if (payingRef.current || !canPay || !lookup || !cardId || !lookup.spendSlug || amount == null) return;
    payingRef.current = true;
    setPaying(true);
    setError(null);
    try {
      const out = await payEstateCard({ ticketKey: ticket.id, cardId, spendSlug: lookup.spendSlug, amount });
      if (out.kind === 'failed') {
        setError(out.message);
        // Safe to allow another try: the server keys idempotency on the ticket, so a retry
        // after an unseen success comes back as a conflict and resolves to that payment.
        payingRef.current = false;
        setConfirmOpen(false);
        return;
      }
      setConfirmOpen(false);
      setStep(3);
      if (out.kind === 'paid' && out.payment.status === 'succeeded') {
        setResult({ kind: 'done', paymentId: out.payment.id, payment: out.payment });
      } else {
        await checkPayment(cardId, out.kind === 'paid' ? out.payment.id : out.paymentId);
      }
    } finally {
      setPaying(false);
    }
  }

  // --- Step 4 ---
  async function doPostAndDone() {
    if (!commentText.trim()) { setError('Comment is empty.'); return; }
    setBusy(true); setError(null);
    try {
      if (!commentPosted) {
        await postComment(ticket.id, buildCommentSegments(ticket, commentText));
        // This reply is the workflow's, not one based on an agent draft: no draft outcome row.
        void markWorkflowHandled(ticket.id);
        setCommentPosted(true);
      }
      await transitionTicket(ticket.id, TRANSITION_TO_DONE_ID);
      onTicketUpdate({ ...ticket, status: 'Done' });
      setTransitionedToDone(true);
      setStep(5);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  const succeeded = result.kind === 'done' && result.payment?.status === 'succeeded';

  function renderStep(n: StepNum) {
    if (n === 5) return null;
    // Resuming at step 3 skips 1–2; show them collapsed as completed context.
    if (n < step) return <ExpandedCard key={n} n={n} completed>{renderBody(n, false)}</ExpandedCard>;
    if (n === step) return <ExpandedCard key={n} n={n}>{renderBody(n, true)}</ExpandedCard>;
    return <FutureStub key={n} n={n} />;
  }

  function renderBody(n: StepNum, onCurrentStep: boolean) {
    switch (n) {
      case 1: {
        if (!onCurrentStep && !verifiedAmount) return <div style={reviewNote}>Skipped — this ticket already has a payment.</div>;
        const pantheonLine = lookupState.kind === 'loading'
          ? <InfoBox>Loading Pantheon balance and Atlas accounts…</InfoBox>
          : lookupState.kind === 'error'
            ? (
              <InfoBox tone="negative">
                <span style={{ flex: 1 }}>⚠ {lookupState.message}</span>
                <button onClick={() => setLookupRun((r) => r + 1)} style={{ ...secondaryButton, padding: '4px 10px', fontSize: 'var(--mint-text-nano)' }}>Retry</button>
              </InfoBox>
            )
            : card
              ? (pantheonOwed != null
                ? <InfoBox><strong>Pantheon: {fmtMoney(pantheonOwed)} owed</strong>&nbsp;· as of {fmtAsOf(card.card.asOf)}{card.closed ? ' · card is closed' : ''}</InfoBox>
                : <InfoBox tone="warning">Nothing owed (as of {fmtAsOf(card.card.asOf)}){card.closed ? ' · card is closed' : ''}</InfoBox>)
              : <InfoBox tone="warning">{lookup?.card.kind === 'multiple' ? `Multiple cards (${lookup.card.count}) — do this one manually.` : 'No credit card found for this client.'}</InfoBox>;
        return (
          <VerifyBalanceStep
            compareMode="owed"
            ticket={ticket}
            fmtAmt={verifiedAmount?.amount != null ? fmtMoney(verifiedAmount.amount) : '—'}
            amount={pantheonOwed}
            adjustOpen={adjustOpen}
            setAdjustOpen={setAdjustOpen}
            adjustedAmountInput={adjustedAmountInput}
            setAdjustedAmountInput={setAdjustedAmountInput}
            applyAdjustedAmount={applyAdjustedAmount}
            showContinue={onCurrentStep && lookupState.kind === 'ready'}
            onVerify={doVerified}
            onRunningBalance={setI2cBalance}
            extraInfo={<div style={{ marginBottom: 'var(--mint-sp-3)' }}>{pantheonLine}</div>}
          />
        );
      }
      case 2: {
        if (!onCurrentStep) {
          return <div style={reviewNote}>{result.kind !== 'idle' && result.paymentId ? <>Payment <code>{result.paymentId}</code> sent.</> : 'Skipped — this ticket already has a payment.'}</div>;
        }
        return (
          <>
            <SummaryRows rows={[
              ['Amount', amount != null ? fmtMoney(amount) : '—'],
              ['Source', verifiedAmount?.source ?? '—'],
              ['From', lookup?.spendSlug ? `${lookup.spendSlug}${spendNumber ? ` (${spendNumber})` : ''}` : '—'],
              ['To', cardId ? `${cardId}${card?.closed ? ' · card is closed' : ''}` : '—'],
            ]} />
            {named.length === 0 && lookup ? (
              <div style={{ ...reviewNote, marginTop: 'var(--mint-sp-2)' }}>Ticket names no account numbers — not cross-checked.</div>
            ) : null}
            {named.length > 0 && strangers.length === 0 && lookup ? (
              <div style={{ marginTop: 'var(--mint-sp-2)', fontSize: 'var(--mint-text-micro)', color: 'var(--mint-positive-fg-strong)' }}>✓ Ticket's account numbers ({named.join(', ')}) match this client.</div>
            ) : null}
            {stops.map((s) => (
              <div key={s} role="alert" style={{ ...errorBanner, marginTop: 'var(--mint-sp-2)', fontSize: 'var(--mint-text-micro)' }}>⛔ {s}</div>
            ))}
            <div style={{ marginTop: 'var(--mint-sp-3)', display: 'flex', gap: 'var(--mint-sp-2)' }}>
              <button onClick={() => { setStep(1); setVerifiedAmount(null); }} style={secondaryButton}>← Back</button>
              <button
                onClick={() => setConfirmOpen(true)}
                disabled={!canPay}
                style={{ ...primaryButton, flex: 1, opacity: canPay ? 1 : 0.5, cursor: canPay ? 'pointer' : 'not-allowed' }}
              >
                Review payment…
              </button>
            </div>
          </>
        );
      }
      case 3: {
        if (result.kind === 'idle') return null;
        const id = result.paymentId;
        if (result.kind === 'checking') {
          return <InfoBox>Checking payment {id ? <code>{id}</code> : ''} status in Atlas…</InfoBox>;
        }
        const p = result.payment;
        return (
          <>
            <SummaryRows rows={[
              ['Payment', id ?? '—'],
              ['Amount', p ? `$${p.amount}` : '—'],
              ['Status', p?.status ?? 'not found yet'],
              ['Created', p?.createdAt ? new Date(p.createdAt).toLocaleString('en-CA') : '—'],
            ]} />
            {!succeeded ? (
              <>
                <div role="alert" style={{ ...warningBanner, marginTop: 'var(--mint-sp-2)' }}>
                  Payment {id ?? ''} is {p?.status ?? 'not listed yet'} — check Atlas before closing out.
                </div>
                {cardId ? (
                  <button onClick={() => { void checkPayment(cardId, id); }} style={{ ...secondaryButton, width: '100%', marginTop: 'var(--mint-sp-2)' }}>Re-check</button>
                ) : null}
              </>
            ) : onCurrentStep ? (
              <button onClick={() => setStep(4)} style={{ ...primaryButton, width: '100%', marginTop: 'var(--mint-sp-3)' }}>Continue</button>
            ) : null}
          </>
        );
      }
      case 4: return (
        <CommentStep
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
        {([1, 2, 3, 4] as StepNum[]).map(renderStep)}
        {step === 5 ? <SuccessPanel ticketId={ticket.id} onCloseToTicket={onClose} /> : null}
      </div>
      {confirmOpen && canPay && amount != null ? (
        <Overlay onClick={() => { if (!paying) setConfirmOpen(false); }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: 'var(--mint-bg-card)', borderRadius: 'var(--mint-radius-card)', padding: 'var(--mint-sp-4)', width: '100%', maxWidth: 380, boxShadow: '0 8px 32px rgba(20,17,12,0.25)' }}>
            <h3 style={{ margin: '0 0 var(--mint-sp-3)', fontSize: 'var(--mint-text-h-md)', fontWeight: 700, color: 'var(--mint-fg-strong)' }}>Are you sure?</h3>
            <SummaryRows rows={[
              ['Ticket', ticket.id],
              ...(clientName ? [['Client', clientName] as [string, string]] : []),
              ['From', `${lookup!.spendSlug}${spendNumber ? ` (${spendNumber})` : ''}`],
              ['To', `${cardId}${card?.closed ? ' · card is closed' : ''}`],
              ['Amount', fmtMoney(amount)],
              ['Balance source', verifiedAmount?.source ?? '—'],
            ]} />
            <div style={{ marginTop: 'var(--mint-sp-3)', display: 'flex', gap: 'var(--mint-sp-2)' }}>
              <button onClick={() => setConfirmOpen(false)} disabled={paying} style={secondaryButton}>Cancel</button>
              <button
                onClick={() => { void doPay(); }}
                disabled={paying}
                style={{ ...primaryButton, flex: 1, background: 'var(--mint-positive-fg-graphic)', opacity: paying ? 0.6 : 1, cursor: paying ? 'wait' : 'pointer' }}
              >
                {paying ? 'Paying…' : `Pay ${fmtMoney(amount)}`}
              </button>
            </div>
          </div>
        </Overlay>
      ) : null}
    </div>
  );
}

// ============================================================
// Step 4 — Post comment & Mark as Done (copied from ReverseFeeWorkflow Step2Body)
// ============================================================

function CommentStep(props: {
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
// Success + header + visual primitives (Reverse Fee conventions)
// ============================================================

function SuccessPanel({ ticketId, onCloseToTicket }: { ticketId: string; onCloseToTicket: () => void }) {
  return (
    <section style={{ background: 'var(--mint-positive-bg-soft)', border: '1px solid var(--mint-positive-fg-graphic)', borderRadius: 'var(--mint-radius-card)', padding: 'var(--mint-sp-4)', textAlign: 'center' }}>
      <div style={{ width: 48, height: 48, margin: '0 auto var(--mint-sp-2)', borderRadius: 9999, background: 'var(--mint-positive-fg-graphic)', color: '#fff', fontSize: 24, fontWeight: 800, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>✓</div>
      <h3 style={{ margin: 0, fontSize: 'var(--mint-text-h-md)', color: 'var(--mint-fg-strong)', fontWeight: 700 }}>Estate payment complete</h3>
      <p style={{ margin: 'var(--mint-sp-2) 0 var(--mint-sp-3)', fontSize: 'var(--mint-text-meta)', color: 'var(--mint-fg-subdued-title)', lineHeight: 1.6 }}>
        Card paid · Comment posted · Moved to Done
      </p>
      <button onClick={onCloseToTicket} style={{ ...primaryButton, width: '100%' }}>Close & return to ticket</button>
      <div style={{ fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-soft)', marginTop: 'var(--mint-sp-2)' }}>
        Open <a href={`https://wealthsimple.atlassian.net/browse/${ticketId}`} target="_blank" rel="noreferrer" style={{ color: 'var(--mint-highlight-fg-strong)' }}>{ticketId}</a> in Jira to verify.
      </div>
    </section>
  );
}

function Header({ step, ticketId, onClose }: { step: StepNum; ticketId: string; onClose: () => void }) {
  return (
    <header style={{ position: 'sticky', top: 0, zIndex: 50, background: 'var(--mint-bg-card)', borderBottom: 'var(--mint-card-stroke)', padding: 'var(--mint-sp-3) var(--mint-sp-3) var(--mint-sp-2)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <button onClick={onClose} title="Back to ticket" style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--mint-fg-soft)', fontSize: 16, padding: 4 }}>←</button>
        <a href={`https://wealthsimple.atlassian.net/browse/${ticketId}`} target="_blank" rel="noreferrer" style={{ color: 'var(--mint-highlight-fg-strong)', fontWeight: 700, fontSize: 'var(--mint-text-meta)', textDecoration: 'none' }}>{ticketId}</a>
        <span style={{ marginLeft: 'auto', fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-soft)' }}>Step {Math.min(step, 4)} of 4</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <h2 style={{ margin: 0, fontSize: 'var(--mint-text-h-md)', fontWeight: 700, color: 'var(--mint-fg-strong)' }}>Estate CC payment</h2>
        <ProgressDots step={step} />
      </div>
    </header>
  );
}

function ProgressDots({ step }: { step: StepNum }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      {[1, 2, 3, 4, 5].map((n) => {
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

function InfoBox({ children, tone }: { children: React.ReactNode; tone?: 'warning' | 'negative' }) {
  const bg = tone ? `var(--mint-${tone}-bg-soft)` : 'var(--mint-bg-subtle)';
  const fg = tone ? `var(--mint-${tone}-fg-strong)` : 'var(--mint-fg-strong)';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', background: bg, color: fg, border: 'var(--mint-card-stroke)', borderRadius: 'var(--mint-radius-button)', fontSize: 'var(--mint-text-micro)' }}>
      {children}
    </div>
  );
}

function SummaryRows({ rows }: { rows: Array<[string, string]> }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 'var(--mint-sp-3)', rowGap: 6, fontSize: 'var(--mint-text-micro)' }}>
      {rows.map(([k, v]) => (
        <div key={k} style={{ display: 'contents' }}>
          <span style={{ color: 'var(--mint-fg-soft)', fontWeight: 600 }}>{k}</span>
          <span style={{ color: 'var(--mint-fg-strong)', fontFamily: 'var(--mint-font-mono)', wordBreak: 'break-all' }}>{v}</span>
        </div>
      ))}
    </div>
  );
}

function Overlay({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <div
      onClick={onClick}
      style={{
        position: 'fixed', inset: 0,
        background: 'rgba(20,17,12,0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 'var(--mint-sp-3)',
        zIndex: 1000,
      }}
    >
      {children}
    </div>
  );
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
const errorBanner: React.CSSProperties = {
  padding: '8px 12px',
  background: 'var(--mint-negative-bg-soft)',
  color: 'var(--mint-negative-fg-strong)',
  fontSize: 'var(--mint-text-meta)',
  borderRadius: 'var(--mint-radius-button)',
};
const warningBanner: React.CSSProperties = {
  padding: '8px 12px',
  background: 'var(--mint-warning-bg-soft)',
  color: 'var(--mint-warning-fg-strong)',
  fontSize: 'var(--mint-text-micro)',
  borderRadius: 'var(--mint-radius-button)',
};
const reviewNote: React.CSSProperties = {
  fontSize: 'var(--mint-text-micro)',
  color: 'var(--mint-fg-soft)',
  fontStyle: 'italic',
};
