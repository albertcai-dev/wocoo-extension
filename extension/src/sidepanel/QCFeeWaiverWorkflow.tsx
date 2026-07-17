// QC Fee Waiver workflow — 7 steps with a success state.
//
// Scenarios:
//   A. Cancellation             → refund = $220 − ($20 × monthsUsed)
//   B. Newly fee-waiver eligible → refund = $20 × (12 − monthsSinceAnniversary)
//
// Both end with: Apply Admin Credit in i2c → (Cancellation+paid only) submit REIMB →
// post comment → move to Done.

import { useEffect, useState } from 'react';
import type { WocooTicket } from '../data/mockTicket';
import { createReimbTicket, postComment, transitionTicket, REIMB_APPROVERS } from '../api/jira';
import { fetchAtlasAccountIdHeadless } from '../data/atlasAccountLookup';

const I2C_LOGIN_URL = 'https://wealthsimplecs.mycardplace.com/customerservice/wealthsimplelogin.jsp';

type StepNum = 1 | 2 | 3 | 4 | 5 | 6 | 7;
type Scenario = 'cancellation' | 'newly_eligible';

const STEP_TITLES: Record<StepNum, string> = {
  1: 'Pick scenario',
  2: 'Collect inputs',
  3: 'Confirm refund',
  4: 'Apply Admin Credit',
  5: 'Submit REIMB ticket',
  6: 'Post comment & Move to Done',
  7: 'Complete',
};

const STEP_SUBTITLES: Record<StepNum, string> = {
  1: 'Which path applies to this ticket?',
  2: 'Months of card usage + scenario inputs',
  3: 'Confirm the calculated refund amount',
  4: 'Open i2c with the credit form pre-filled',
  5: "Reimburse to the client's chequing account",
  6: 'Review, then post + close the ticket',
  7: '',
};

export function QCFeeWaiverWorkflow({ ticket, onClose, onTicketUpdate }: { ticket: WocooTicket; onClose: () => void; onTicketUpdate: (t: WocooTicket) => void }) {
  const [step, setStep] = useState<StepNum>(1);
  const [scenario, setScenario] = useState<Scenario | null>(null);
  const [monthsUsedInput, setMonthsUsedInput] = useState<string>('');
  const [monthsBreakdown, setMonthsBreakdown] = useState<string[]>([]);
  const [clientPaidAnnualFee, setClientPaidAnnualFee] = useState<boolean>(true);
  const [scrapePending, setScrapePending] = useState<boolean>(false);
  // Newly-eligible scenario: single input = months client used the card before their tier
  // upgrade flipped them into the fee-waiver-eligible bracket.
  const [newlyEligibleMonthsUsed, setNewlyEligibleMonthsUsed] = useState<string>('');
  const [refundOverride, setRefundOverride] = useState<string>(''); // empty = use computed
  const [creditAppliedRan, setCreditAppliedRan] = useState<boolean>(false);
  const [reimbKey, setReimbKey] = useState<string | null>(null);
  const [reimbCreating, setReimbCreating] = useState<boolean>(false);
  const [reimbError, setReimbError] = useState<string | null>(null);
  const [commentText, setCommentText] = useState<string>(''); // lazy-seeded when Step 6 mounts
  const [commentPosting, setCommentPosting] = useState<boolean>(false);
  const [commentPosted, setCommentPosted] = useState<boolean>(false);
  const [commentError, setCommentError] = useState<string | null>(null);
  const [moveDoing, setMoveDoing] = useState<boolean>(false);
  const [moveDone, setMoveDone] = useState<boolean>(false);
  const [moveError, setMoveError] = useState<string | null>(null);
  // Step 5 Account ID override + Atlas-driven fetch (mirrors OverpaymentTriage).
  const [accountIdOverride, setAccountIdOverride] = useState<string>('');
  const [accountIdInput, setAccountIdInput] = useState<string>('');
  const [accountIdEditOpen, setAccountIdEditOpen] = useState<boolean>(false);
  const [accountIdFetchPending, setAccountIdFetchPending] = useState<boolean>(false);
  const effectiveAccountId = (accountIdOverride || ticket.accountId || '').toUpperCase();

  const applyAccountIdOverride = () => {
    const v = accountIdInput.trim().toUpperCase();
    if (!v) return;
    setAccountIdOverride(v);
    setAccountIdInput('');
    setAccountIdEditOpen(false);
    setReimbError(null);
  };

  const fetchAccountIdFromAtlas = async () => {
    if (!ticket.identityId || accountIdFetchPending) return;
    setAccountIdFetchPending(true);
    try {
      const { accountNumber } = await fetchAtlasAccountIdHeadless({ identityId: ticket.identityId, sourceTicketId: ticket.id });
      setAccountIdOverride(accountNumber);
      setAccountIdInput('');
      setAccountIdEditOpen(false);
      setReimbError(null);
    } catch (e) {
      setReimbError(e instanceof Error ? e.message : String(e));
    } finally {
      setAccountIdFetchPending(false);
    }
  };

  function computedRefund(): number | null {
    if (scenario === 'cancellation') {
      const m = parseInt(monthsUsedInput, 10);
      if (!isFinite(m) || m < 0) return null;
      return Math.max(0, 220 - 20 * m);
    }
    if (scenario === 'newly_eligible') {
      const used = parseInt(newlyEligibleMonthsUsed, 10);
      if (!isFinite(used) || used < 0 || used > 12) return null;
      const left = 12 - used;
      if (left <= 0) return null;
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

  // Step 4 (Apply Admin Credit) and Step 5 (Submit REIMB) are mutually exclusive — they're
  // the two delivery paths for the refund.
  //   - cancellation + paid    → REIMB to chequing (skip Step 4)
  //   - cancellation + unpaid  → Admin credit reduces the unpaid balance (skip Step 5)
  //   - newly eligible         → Admin credit on the still-active card (skip Step 5)
  const skipStep4 = scenario === 'cancellation' && clientPaidAnnualFee;
  const skipStep5 = !skipStep4;
  const skippedStep: 4 | 5 = skipStep4 ? 4 : 5;

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

  const autoApproverKey: keyof typeof REIMB_APPROVERS =
    effectiveRefund != null && effectiveRefund >= 5000 ? 'amanda' : 'luke';
  const approverInfo = REIMB_APPROVERS[autoApproverKey];

  const doCreateReimb = async () => {
    if (reimbCreating || reimbKey) return;
    setReimbError(null);
    if (!ticket.identityId) { setReimbError('Source ticket is missing Identity ID.'); return; }
    if (!effectiveAccountId) { setReimbError('Account ID is missing — enter or fetch it below.'); return; }
    if (!ticket.tier) { setReimbError('Source ticket is missing Tier.'); return; }
    if (effectiveRefund == null || effectiveRefund <= 0) { setReimbError('Refund amount is invalid.'); return; }
    setReimbCreating(true);
    try {
      const result = await createReimbTicket({
        wocooTicketId: ticket.id,
        identityId: ticket.identityId,
        amount: effectiveRefund,
        accountId: effectiveAccountId,
        approver: autoApproverKey,
        tier: ticket.tier,
        summary: 'Credit Card reimbursement to close card',
      });
      setReimbKey(result.key);
    } catch (e) {
      setReimbError(e instanceof Error ? e.message : String(e));
    } finally {
      setReimbCreating(false);
    }
  };

  function buildCommentTemplate(): string {
    const mention = ticket.reporter ? `@${ticket.reporter}` : 'team';
    const amt = effectiveRefund != null ? effectiveRefund.toFixed(2) : '—';
    if (scenario === 'cancellation') {
      const m = parseInt(monthsUsedInput, 10) || 0;
      const refundLine = skipStep4
        ? ` REIMB ticket ${reimbKey ?? '<pending>'} created to transfer the refund to the chequing account.`
        : ` Admin credit applied in i2c.`;
      return (
        `Hi ${mention}, the client's annual fee has been prorated based on ${m} months of card usage. ` +
        `Refund: $220 − ($20 × ${m}) = $${amt}.` +
        refundLine +
        ` You can proceed with account closure.`
      );
    }
    if (scenario === 'newly_eligible') {
      const used = parseInt(newlyEligibleMonthsUsed, 10) || 0;
      const left = Math.max(0, 12 - used);
      return (
        `Hi ${mention}, the client used the card for ${used} months before becoming fee-waiver eligible (${left} months remaining until their card anniversary). ` +
        `Refund: $20 × ${left} = $${amt}. Admin credit applied in i2c.`
      );
    }
    return '';
  }

  // Seed the editable comment textarea once when Step 6 becomes active (and the user
  // hasn't typed anything yet).
  useEffect(() => {
    if (step === 6 && !commentText && !commentPosted) {
      setCommentText(buildCommentTemplate());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  // Single combined action: post the comment, then transition to Done. If the comment
  // succeeds but the transition fails, the retry button only re-runs the transition so
  // we don't double-post.
  const doPostAndDone = async () => {
    if (commentPosting || moveDoing) return;
    if (!commentText.trim()) { setCommentError('Comment is empty.'); return; }
    setCommentError(null);
    setMoveError(null);
    setCommentPosting(true);
    try {
      if (!commentPosted) {
        const segments = buildCommentSegments(commentText, ticket.reporter, ticket.reporterAccountId, reimbKey);
        await postComment(ticket.id, segments);
        setCommentPosted(true);
      }
      setMoveDoing(true);
      await transitionTicket(ticket.id, '251');
      setMoveDone(true);
      onTicketUpdate({ ...ticket, status: 'Done' });
      setStep(7);
    } catch (e) {
      // Two error buckets: comment-stage vs transition-stage. The UI uses whichever set
      // it can find.
      const msg = e instanceof Error ? e.message : String(e);
      if (!commentPosted) setCommentError(msg);
      else setMoveError(msg);
    } finally {
      setCommentPosting(false);
      setMoveDoing(false);
    }
  };

  const applyCredit = () => {
    if (!ticket.clientEmail || effectiveRefund == null) return;
    void chrome.storage.local.set({
      pending_i2c_email: ticket.clientEmail,
      pending_i2c_flow: 'apply_credit',
      pending_i2c_ticket_url: `https://wealthsimple.atlassian.net/browse/${ticket.id}`,
      pending_i2c_admin_credit_amount: effectiveRefund.toFixed(2),
      pending_i2c_started_at: Date.now(),
    });
    void chrome.storage.local.remove(['pending_i2c_admin_debit_amount', 'qc_search_clicked']);
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
    if (n === 2 && scenario === 'newly_eligible') return (
      <Step2NewlyEligibleBody
        monthsUsedInput={newlyEligibleMonthsUsed}
        setMonthsUsedInput={setNewlyEligibleMonthsUsed}
        showAction={onCurrentStep}
        onContinue={() => setStep(3)}
      />
    );
    if (n === 3) return (
      <Step3Body
        scenario={scenario}
        computed={computed}
        refundOverride={refundOverride}
        setRefundOverride={setRefundOverride}
        monthsUsedInput={monthsUsedInput}
        newlyEligibleMonthsUsed={newlyEligibleMonthsUsed}
        showAction={onCurrentStep}
        onContinue={() => setStep(skipStep4 ? 5 : 4)}
      />
    );
    if (n === 4) return (
      <Step4Body
        refund={effectiveRefund}
        applyCredit={applyCredit}
        alreadyDone={creditAppliedRan}
        disabled={!ticket.clientEmail || effectiveRefund == null || effectiveRefund <= 0}
        showAction={onCurrentStep}
        onConfirm={() => {
          setCreditAppliedRan(true);
          setStep(skipStep5 ? 6 : 5);
        }}
      />
    );
    if (n === 6) return (
      <Step6Body
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
        reimbKey={reimbKey}
        showAction={onCurrentStep}
      />
    );
    if (n === 5) return (
      <Step5Body
        ticket={ticket}
        refund={effectiveRefund}
        approverName={approverInfo.name}
        reimbKey={reimbKey}
        reimbCreating={reimbCreating}
        reimbError={reimbError}
        doCreateReimb={doCreateReimb}
        effectiveAccountId={effectiveAccountId}
        accountIdEditOpen={accountIdEditOpen}
        setAccountIdEditOpen={setAccountIdEditOpen}
        accountIdInput={accountIdInput}
        setAccountIdInput={setAccountIdInput}
        applyAccountIdOverride={applyAccountIdOverride}
        fetchAccountIdFromAtlas={fetchAccountIdFromAtlas}
        accountIdFetchPending={accountIdFetchPending}
        showAction={onCurrentStep}
        onContinue={() => setStep(6)}
      />
    );
    return <div style={{ fontSize: 'var(--mint-text-meta)', color: 'var(--mint-fg-soft)' }}>(stub — step {n})</div>;
  }

  function renderStep(n: StepNum) {
    if (n === 7) return null;
    if (n === skippedStep) return null;
    const isCompleted = n < step;
    const isActive = n === step;
    if (isCompleted) return <ExpandedCard key={n} n={n} completed>{renderBody(n)}</ExpandedCard>;
    if (isActive) return <ExpandedCard key={n} n={n}>{renderBody(n)}</ExpandedCard>;
    return <FutureStub key={n} n={n} />;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh', background: 'var(--mint-bg-page)' }}>
      <Header step={step} skippedStep={skippedStep} ticketId={ticket.id} onClose={onClose} />
      <div style={{ padding: 'var(--mint-sp-3)', display: 'flex', flexDirection: 'column', gap: 'var(--mint-sp-2)' }}>
        {([1, 2, 3, 4, 5, 6] as StepNum[]).map(renderStep)}
        {step === 7 ? (
          <SuccessPanel
            ticketId={ticket.id}
            scenario={scenario}
            refund={effectiveRefund}
            reimbKey={reimbKey}
            commentPosted={commentPosted}
            onClose={onClose}
          />
        ) : null}
      </div>
    </div>
  );
}

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

function Step2NewlyEligibleBody({ monthsUsedInput, setMonthsUsedInput, showAction, onContinue }: {
  monthsUsedInput: string;
  setMonthsUsedInput: (v: string) => void;
  showAction: boolean;
  onContinue: () => void;
}) {
  const used = parseInt(monthsUsedInput, 10);
  const valid = isFinite(used) && used >= 0 && used < 12;
  const left = valid ? 12 - used : null;
  return (
    <>
      <div style={fieldLabel}>Months used before tier upgrade</div>
      <input
        type="number"
        min={0}
        max={11}
        value={monthsUsedInput}
        onChange={(e) => setMonthsUsedInput(e.target.value)}
        placeholder="0–11"
        style={{ width: '100%', padding: '6px 10px', fontFamily: 'var(--mint-font-mono)', fontSize: 'var(--mint-text-micro)', border: '1px solid ' + (valid || !monthsUsedInput ? 'var(--mint-outline-strong)' : 'var(--mint-negative-fg-graphic)'), borderRadius: 'var(--mint-radius-button)', background: 'var(--mint-bg-card)', color: 'var(--mint-fg-strong)', boxSizing: 'border-box' }}
      />
      <div style={{ marginTop: 4, fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-soft)', lineHeight: 1.4 }}>
        How many months the client used the card before upgrading their tier (Core → Premium or qualifying direct deposits).
      </div>
      {left != null ? (
        <div style={{ marginTop: 6, fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-subdued-title)' }}>
          Months remaining until anniversary: <strong>{left}</strong> → refund <strong>${(20 * left).toFixed(2)}</strong>
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

function Step3Body({ scenario, computed, refundOverride, setRefundOverride, monthsUsedInput, newlyEligibleMonthsUsed, showAction, onContinue }: {
  scenario: Scenario | null;
  computed: number | null;
  refundOverride: string;
  setRefundOverride: (v: string) => void;
  monthsUsedInput: string;
  newlyEligibleMonthsUsed: string;
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
    if (scenario === 'newly_eligible') {
      const used = parseInt(newlyEligibleMonthsUsed, 10);
      if (isFinite(used) && used >= 0 && used < 12) {
        const left = 12 - used;
        return `$20 × (12 − ${used}) = $20 × ${left} = $${(20 * left).toFixed(2)}`;
      }
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

function Step4Body({ refund, applyCredit, alreadyDone, disabled, showAction, onConfirm }: {
  refund: number | null;
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

function Step5Body({ ticket, refund, approverName, reimbKey, reimbCreating, reimbError, doCreateReimb, effectiveAccountId, accountIdEditOpen, setAccountIdEditOpen, accountIdInput, setAccountIdInput, applyAccountIdOverride, fetchAccountIdFromAtlas, accountIdFetchPending, showAction, onContinue }: {
  ticket: WocooTicket;
  refund: number | null;
  approverName: string;
  reimbKey: string | null;
  reimbCreating: boolean;
  reimbError: string | null;
  doCreateReimb: () => void;
  effectiveAccountId: string;
  accountIdEditOpen: boolean;
  setAccountIdEditOpen: (v: boolean) => void;
  accountIdInput: string;
  setAccountIdInput: (v: string) => void;
  applyAccountIdOverride: () => void;
  fetchAccountIdFromAtlas: () => void;
  accountIdFetchPending: boolean;
  showAction: boolean;
  onContinue: () => void;
}) {
  const accountIdMissing = !effectiveAccountId;
  const identityIdMissing = !ticket.identityId;
  const tierMissing = !ticket.tier;
  const blocked = accountIdMissing || identityIdMissing || tierMissing || refund == null || refund <= 0;
  const accountIdInputOpen = accountIdEditOpen || accountIdMissing;
  return (
    <>
      <div style={{ padding: 'var(--mint-sp-3)', background: 'var(--mint-bg-subtle)', border: 'var(--mint-card-stroke)', borderRadius: 'var(--mint-radius-card)', marginBottom: 'var(--mint-sp-3)', display: 'flex', flexDirection: 'column', gap: 6 }}>
        <Row label="Summary" value="Credit Card reimbursement to close card" />
        <Row label="Amount" value={refund != null ? `CA$${refund.toFixed(2)}` : '—'} />
        <Row label="Identity ID" value={ticket.identityId || '— (missing)'} missing={identityIdMissing} />
        <AccountIdRow
          value={effectiveAccountId}
          missing={accountIdMissing}
          editOpen={accountIdEditOpen}
          onToggleEdit={() => setAccountIdEditOpen(!accountIdEditOpen)}
        />
        <Row label="Tier" value={ticket.tier || '— (missing)'} missing={tierMissing} />
        <Row label="Approver" value={approverName} />
      </div>

      {accountIdInputOpen ? (
        <div style={{ padding: 'var(--mint-sp-2) var(--mint-sp-3)', background: 'var(--mint-bg-card)', border: 'var(--mint-card-stroke)', borderRadius: 'var(--mint-radius-card)', marginBottom: 'var(--mint-sp-3)', display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={fieldLabel}>{accountIdMissing ? "Account ID missing — enter manually" : 'Override account ID'}</div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <input
              type="text"
              value={accountIdInput}
              onChange={(e) => setAccountIdInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') applyAccountIdOverride(); }}
              placeholder="e.g. WK5TPMJ32CAD"
              style={{ flex: 1, minWidth: 140, padding: '4px 8px', fontFamily: 'var(--mint-font-mono)', fontSize: 'var(--mint-text-meta)', border: 'var(--mint-card-stroke)', borderRadius: 'var(--mint-radius-button)', background: 'var(--mint-bg-card)', color: 'var(--mint-fg-strong)', boxSizing: 'border-box' }}
              autoFocus={accountIdMissing}
            />
            <button
              onClick={applyAccountIdOverride}
              style={{ padding: '4px 10px', background: 'var(--mint-fg-strong)', color: 'var(--mint-fg-inverted)', border: 'none', borderRadius: 'var(--mint-radius-button)', fontSize: 'var(--mint-text-nano)', fontWeight: 700, cursor: 'pointer' }}
            >Set</button>
            <button
              onClick={fetchAccountIdFromAtlas}
              disabled={!ticket.identityId || accountIdFetchPending}
              title="Open Atlas → CHEQUING (SPEND) → auto-fill the account number"
              style={{
                padding: '4px 10px',
                background: 'var(--mint-highlight-fg-graphic)',
                color: '#fff',
                border: 'none',
                borderRadius: 'var(--mint-radius-button)',
                fontSize: 'var(--mint-text-nano)',
                fontWeight: 700,
                cursor: !ticket.identityId || accountIdFetchPending ? 'not-allowed' : 'pointer',
                opacity: !ticket.identityId || accountIdFetchPending ? 0.6 : 1,
                whiteSpace: 'nowrap',
              }}
            >{accountIdFetchPending ? 'Fetching…' : '↗ Fetch'}</button>
          </div>
        </div>
      ) : null}

      {reimbKey ? (
        <div style={{ padding: 'var(--mint-sp-3)', background: 'var(--mint-positive-bg-soft)', border: '1px solid var(--mint-positive-fg-graphic)', borderRadius: 'var(--mint-radius-card)', marginBottom: 'var(--mint-sp-2)' }}>
          <div style={{ fontSize: 'var(--mint-text-meta)', color: 'var(--mint-positive-fg-strong)', fontWeight: 700, marginBottom: 4 }}>✓ REIMB ticket created</div>
          <a href={`https://wealthsimple.atlassian.net/browse/${reimbKey}`} target="_blank" rel="noreferrer" style={{ fontSize: 'var(--mint-text-meta)', color: 'var(--mint-highlight-fg-strong)', fontWeight: 700, textDecoration: 'none' }}>{reimbKey} ↗</a>
        </div>
      ) : (
        <button onClick={doCreateReimb} disabled={blocked || reimbCreating} style={{
          padding: '8px 16px',
          background: 'var(--mint-warning-bg-soft)',
          color: 'var(--mint-warning-fg-strong)',
          border: '1px solid var(--mint-warning-fg-graphic)',
          borderRadius: 'var(--mint-radius-button)',
          fontSize: 'var(--mint-text-meta)',
          fontWeight: 700,
          width: '100%',
          textAlign: 'center',
          cursor: blocked || reimbCreating ? 'not-allowed' : 'pointer',
          opacity: blocked || reimbCreating ? 0.6 : 1,
        }}>
          {reimbCreating ? 'Creating REIMB…' : 'Create REIMB ticket'}
        </button>
      )}

      {reimbError ? (
        <div style={{ marginTop: 'var(--mint-sp-2)', padding: 8, background: 'var(--mint-negative-bg-soft)', border: '1px solid var(--mint-negative-fg-graphic)', borderRadius: 'var(--mint-radius-button)', fontSize: 'var(--mint-text-nano)', color: 'var(--mint-negative-fg-strong)' }}>
          {reimbError}
        </div>
      ) : null}

      {showAction && reimbKey ? (
        <div style={{ marginTop: 'var(--mint-sp-3)' }}>
          <button onClick={onContinue} style={{ ...primaryButton, width: '100%' }}>Continue →</button>
        </div>
      ) : null}
    </>
  );
}

function Step6Body({ commentText, setCommentText, commentPosting, commentPosted, commentError, moveDoing, moveDone, moveError, doPostAndDone, reporter, reimbKey, showAction }: {
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
  reimbKey: string | null;
  showAction: boolean;
}) {
  // Combined action label: covers the three execution states for one button.
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
        rows={7}
        style={{
          width: '100%', padding: '8px 10px',
          fontFamily: 'var(--mint-font-family)', fontSize: 'var(--mint-text-micro)',
          border: 'var(--mint-card-stroke)', borderRadius: 'var(--mint-radius-button)',
          background: commentPosted ? 'var(--mint-bg-subtle)' : 'var(--mint-bg-card)',
          color: 'var(--mint-fg-strong)', boxSizing: 'border-box', lineHeight: 1.45, resize: 'vertical',
        }}
      />
      <div style={{ marginTop: 4, fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-soft)' }}>
        @{reporter || 'reporter'} renders as a mention; {reimbKey ? `${reimbKey} renders as a link` : 'no REIMB to link'}.
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

/**
 * Split `text` into ADF segments so the @<reporter> mention and the REIMB-key string
 * render as a real mention pill / link rather than plain text.
 */
function buildCommentSegments(text: string, reporter: string, reporterAccountId: string | null | undefined, reimbKey: string | null) {
  const segments: Array<{ type: 'text' | 'mention' | 'link'; text: string; accountId?: string; href?: string }> = [];

  type Match = { start: number; end: number; seg: { type: 'mention' | 'link'; text: string; accountId?: string; href?: string } };
  const matches: Match[] = [];

  if (reporter && reporterAccountId) {
    const needle = '@' + reporter;
    const i = text.indexOf(needle);
    if (i !== -1) {
      matches.push({ start: i, end: i + needle.length, seg: { type: 'mention', text: needle, accountId: reporterAccountId } });
    }
  }
  if (reimbKey) {
    const i = text.indexOf(reimbKey);
    if (i !== -1) {
      matches.push({ start: i, end: i + reimbKey.length, seg: { type: 'link', text: reimbKey, href: `https://wealthsimple.atlassian.net/browse/${reimbKey}` } });
    }
  }
  matches.sort((a, b) => a.start - b.start);

  let cursor = 0;
  for (const m of matches) {
    if (m.start < cursor) continue; // overlapping — shouldn't happen with @reporter and REIMB key
    if (m.start > cursor) segments.push({ type: 'text', text: text.slice(cursor, m.start) });
    segments.push(m.seg);
    cursor = m.end;
  }
  if (cursor < text.length) segments.push({ type: 'text', text: text.slice(cursor) });
  return segments;
}

function SuccessPanel({ ticketId, scenario, refund, reimbKey, commentPosted, onClose }: {
  ticketId: string;
  scenario: Scenario | null;
  refund: number | null;
  reimbKey: string | null;
  commentPosted: boolean;
  onClose: () => void;
}) {
  const scenarioLabel = scenario === 'cancellation' ? 'Cancellation' : scenario === 'newly_eligible' ? 'Newly eligible' : '—';
  return (
    <section style={{
      background: 'var(--mint-positive-bg-soft)',
      border: '1px solid var(--mint-positive-fg-graphic)',
      borderRadius: 'var(--mint-radius-card)',
      padding: 'var(--mint-sp-3)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 'var(--mint-sp-2)' }}>
        <span style={{ width: 26, height: 26, borderRadius: 9999, background: 'var(--mint-positive-fg-graphic)', color: '#fff', fontSize: 14, fontWeight: 800, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>✓</span>
        <h3 style={{ margin: 0, fontSize: 'var(--mint-text-h-md)', color: 'var(--mint-positive-fg-strong)' }}>QC Fee Waiver complete</h3>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 'var(--mint-sp-3)' }}>
        <Row label="Ticket" value={ticketId} />
        <Row label="Scenario" value={scenarioLabel} />
        <Row label="Admin credit" value={refund != null ? `CA$${refund.toFixed(2)} applied in i2c` : '—'} />
        <Row label="REIMB" value={reimbKey || 'not required'} />
        <Row label="Comment" value={commentPosted ? 'posted' : 'skipped'} />
        <Row label="Status" value="Moved to Done" />
      </div>

      <button onClick={onClose} style={{ ...primaryButton, width: '100%' }}>← Back to ticket</button>
    </section>
  );
}

function Row({ label, value, missing }: { label: string; value: string; missing?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 'var(--mint-text-nano)' }}>
      <span style={{ color: 'var(--mint-fg-soft)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</span>
      <span style={{ color: missing ? 'var(--mint-negative-fg-strong)' : 'var(--mint-fg-strong)', fontFamily: 'var(--mint-font-mono)', textAlign: 'right', wordBreak: 'break-all' }}>{value}</span>
    </div>
  );
}

function AccountIdRow({ value, missing, editOpen, onToggleEdit }: { value: string; missing: boolean; editOpen: boolean; onToggleEdit: () => void }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 'var(--mint-text-nano)', alignItems: 'center' }}>
      <span style={{ color: 'var(--mint-fg-soft)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5 }}>Account ID</span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <span style={{ color: missing ? 'var(--mint-negative-fg-strong)' : 'var(--mint-fg-strong)', fontFamily: 'var(--mint-font-mono)', textAlign: 'right', wordBreak: 'break-all' }}>{value || '— (missing)'}</span>
        <button
          onClick={onToggleEdit}
          title={editOpen ? 'Close' : 'Override account ID'}
          style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 0, fontSize: 12, lineHeight: 1, color: 'var(--mint-fg-soft)' }}
        >✎</button>
      </span>
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

function Header({ step, skippedStep, ticketId, onClose }: { step: StepNum; skippedStep: 4 | 5; ticketId: string; onClose: () => void }) {
  const total = 5; // 6 step IDs minus the one skipped scenario step
  const rawDisplay = step > skippedStep ? step - 1 : step;
  const displayStep = Math.min(rawDisplay, total);
  return (
    <header style={{ position: 'sticky', top: 0, zIndex: 50, background: 'var(--mint-bg-card)', borderBottom: 'var(--mint-card-stroke)', padding: 'var(--mint-sp-3) var(--mint-sp-3) var(--mint-sp-2)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <button onClick={onClose} title="Back to ticket" style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--mint-fg-soft)', fontSize: 16, padding: 4 }}>←</button>
        <a href={`https://wealthsimple.atlassian.net/browse/${ticketId}`} target="_blank" rel="noreferrer" style={{ color: 'var(--mint-highlight-fg-strong)', fontWeight: 700, fontSize: 'var(--mint-text-meta)', textDecoration: 'none' }}>{ticketId}</a>
        <span style={{ marginLeft: 'auto', fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-soft)' }}>Step {displayStep} of {total}</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <h2 style={{ margin: 0, fontSize: 'var(--mint-text-h-md)', fontWeight: 700, color: 'var(--mint-fg-strong)' }}>QC Fee Waiver</h2>
        <ProgressDots step={step} skippedStep={skippedStep} />
      </div>
    </header>
  );
}

function ProgressDots({ step, skippedStep }: { step: StepNum; skippedStep: 4 | 5 }) {
  const dots = [1, 2, 3, 4, 5, 6, 7].filter((n) => n !== skippedStep);
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
