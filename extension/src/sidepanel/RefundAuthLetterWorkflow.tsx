// Refund Authorization Letter workflow — 3 steps with a success state.
//
// Step 1: Client details — fetched headlessly from Atlas's Full Client Details grid
//         (name + mailing address), editable before continuing.
// Step 2: Card & refund details — the closed/new card last 4, the declined refund dates
//         and the decline reason that go into the letter's body sentence.
// Step 3: Review & generate — renders the letter as it will read, then asks the GAS
//         bridge to copy the tokenized template, fill it and export a PDF. The PDF is
//         attached to the WOCOO ticket and a comment records the letter.
// Step 4: Success — Doc + PDF links.
//
// Visual conventions match ReverseFeeWorkflow.tsx / OverpaymentTriage.tsx.

import { useEffect, useState } from 'react';
import type { WocooTicket } from '../data/mockTicket';
import { fetchAtlasClientDetailsHeadless } from '../data/atlasAccountLookup';
import { addAttachment, base64ToBlob, getMyself, postComment } from '../api/jira';
import { createRefundLetterViaBridge, type RefundLetterResult } from '../api/bridge';
import { fetchI2cCardDetailsHeadless, I2C_LOGIN_URL, type I2cCard } from '../data/i2cCardLookup';

type StepNum = 1 | 2 | 3 | 4;

const STEP_TITLES: Record<StepNum, string> = {
  1: 'Client details',
  2: 'Card & refund details',
  3: 'Review & generate',
  4: 'Complete',
};

const STEP_SUBTITLES: Record<StepNum, string> = {
  1: 'Pulled from Atlas — check before continuing',
  2: 'What the letter needs to state',
  3: 'Read it, then generate the Doc + PDF',
  4: '',
};

/** Matches the template's phrasing: "…were declined because {reason}." */
const DECLINE_REASONS = [
  'that card was reissued',
  'that card was closed',
  'the account was closed',
  'the card number was no longer valid',
];

export function RefundAuthLetterWorkflow({ ticket, onClose }: { ticket: WocooTicket; onClose: () => void }) {
  const [step, setStep] = useState<StepNum>(1);

  // Step 1 — client details
  const [clientName, setClientName] = useState('');
  const [street, setStreet] = useState('');
  const [cityProvince, setCityProvince] = useState('');
  const [postal, setPostal] = useState('');
  const [atlasState, setAtlasState] = useState<'idle' | 'pending' | 'done' | 'error'>('idle');
  const [atlasError, setAtlasError] = useState<string | null>(null);
  const [atlasPartial, setAtlasPartial] = useState(false);

  // Step 2 — card + refund details
  const [closedCardLast4, setClosedCardLast4] = useState('');
  const [newCardLast4, setNewCardLast4] = useState('');
  const [refundDates, setRefundDates] = useState('');
  const [declineReason, setDeclineReason] = useState(DECLINE_REASONS[0]);
  const [agentFirstName, setAgentFirstName] = useState('');
  const [letterDate, setLetterDate] = useState(formatLetterDate(new Date()));
  // "The refund … was declined" vs "The refunds … were declined". Auto-follows the dates
  // field until the agent overrides it (two refunds on one date is a real case).
  const [multipleRefunds, setMultipleRefunds] = useState<boolean | null>(null);
  const refundsArePlural = multipleRefunds ?? looksLikeMultipleDates(refundDates);
  const [i2cState, setI2cState] = useState<'idle' | 'pending' | 'done' | 'error'>('idle');
  const [i2cError, setI2cError] = useState<string | null>(null);
  const [i2cCards, setI2cCards] = useState<I2cCard[]>([]);

  // Step 3 — generation
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [result, setResult] = useState<RefundLetterResult | null>(null);

  // Auto-fetch from Atlas on mount — the whole point of the step is to save typing.
  useEffect(() => {
    if (atlasState !== 'idle' || !ticket.identityId) return;
    void runAtlasFetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticket.identityId]);

  // Same for i2c the moment step 2 opens. Deferred until then rather than run on mount
  // so we don't spend the i2c login chain on a workflow the agent backs out of at step 1.
  // The `idle` check keeps a Back-then-Continue from re-fetching.
  useEffect(() => {
    if (step !== 2 || i2cState !== 'idle' || !ticket.clientEmail) return;
    void runI2cFetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, ticket.clientEmail]);

  // Default the sign-off to the signed-in agent's first name.
  useEffect(() => {
    if (agentFirstName) return;
    void getMyself()
      .then((me) => {
        const first = (me.displayName || '').trim().split(/\s+/)[0] || '';
        if (first) setAgentFirstName(first);
      })
      .catch(() => { /* leave blank — the field is editable */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function runAtlasFetch() {
    if (!ticket.identityId) { setAtlasError('This ticket has no identity ID.'); setAtlasState('error'); return; }
    setAtlasState('pending');
    setAtlasError(null);
    try {
      const d = await fetchAtlasClientDetailsHeadless({ identityId: ticket.identityId, sourceTicketId: ticket.id });
      if (d.name) setClientName(titleCaseName(d.name));
      if (d.street) setStreet(clean(d.street));
      if (d.cityProvince) setCityProvince(clean(d.cityProvince));
      if (d.postal) setPostal(clean(d.postal));
      setAtlasPartial(!d.complete);
      setAtlasState('done');
    } catch (e) {
      setAtlasError(e instanceof Error ? e.message : String(e));
      setAtlasState('error');
    }
  }

  async function runI2cFetch() {
    if (!ticket.clientEmail) { setI2cError('This ticket has no client email, which i2c needs to find the customer.'); setI2cState('error'); return; }
    setI2cState('pending');
    setI2cError(null);
    try {
      const cards = await fetchI2cCardDetailsHeadless({ clientEmail: ticket.clientEmail, sourceTicketId: ticket.id });
      setI2cCards(cards);
      setI2cState('done');
      if (cards.length === 0) {
        setI2cError('No cards found on the i2c customer page.');
      } else {
        // i2c labels the reissued card ACTIVE and the declined one CLOSED CARD, so when
        // there's exactly one of each the assignment is unambiguous. Anything else stays
        // manual via the chips below.
        const closed = cards.filter((c) => c.closed);
        const active = cards.filter((c) => !c.closed);
        if (closed.length === 1 && !closedCardLast4) setClosedCardLast4(closed[0].last4);
        if (active.length === 1 && !newCardLast4) setNewCardLast4(active[0].last4);
        if (closed.length !== 1 || active.length !== 1) {
          setI2cError(`Found ${cards.length} cards but couldn't tell closed from new automatically — pick below.`);
        }
      }
    } catch (e) {
      setI2cError(e instanceof Error ? e.message : String(e));
      setI2cState('error');
    }
  }

  /** Clicking a found card fills the closed field first, then the new one. */
  function assignCard(last4: string) {
    if (!closedCardLast4) setClosedCardLast4(last4);
    else if (!newCardLast4) setNewCardLast4(last4);
    else setNewCardLast4(last4);
  }

  const openAtlas = () => {
    if (!ticket.identityId) return;
    window.open(`https://atlas.wealthsimple.com/identity/${ticket.identityId}/overview/?ticketId=${ticket.id}`, '_blank', 'noopener,noreferrer');
  };

  const openI2c = () => {
    if (ticket.clientEmail) {
      // Same `card_details` flow as the headless fetch: it logs in, searches, and stops
      // on the results page — which already lists the Accounts and Primary Card(s). The
      // generic flow would click "Continue with this Customer" and land on Account
      // Summary, past the cards we opened this to look at.
      void chrome.storage.local.set({
        pending_i2c_email: ticket.clientEmail,
        pending_i2c_flow: 'card_details',
        pending_i2c_source_ticket_id: ticket.id,
        pending_i2c_started_at: Date.now(),
      });
      void chrome.storage.local.remove(['pending_i2c_ticket_url', 'pending_i2c_admin_debit_amount']);
    }
    window.open(I2C_LOGIN_URL, '_blank', 'noopener,noreferrer');
  };

  const step1Ready = Boolean(clientName.trim() && street.trim() && cityProvince.trim() && postal.trim());
  const step2Ready = Boolean(
    /^\d{4}$/.test(closedCardLast4.trim()) &&
    /^\d{4}$/.test(newCardLast4.trim()) &&
    refundDates.trim() &&
    declineReason.trim() &&
    agentFirstName.trim(),
  );

  async function generate() {
    setBusy(true);
    setError(null);
    setWarning(null);
    try {
      const res = await createRefundLetterViaBridge({
        clientName: clean(clientName),
        addressStreet: clean(street),
        addressCityProvince: clean(cityProvince),
        addressPostal: clean(postal),
        closedCardLast4: clean(closedCardLast4),
        newCardLast4: clean(newCardLast4),
        refundDates: clean(refundDates),
        declineReason: clean(declineReason),
        agentFirstName: clean(agentFirstName),
        refundNoun: refundsArePlural ? 'refunds' : 'refund',
        refundVerb: refundsArePlural ? 'were' : 'was',
        letterDate: letterDate.trim() || undefined,
        wocooTicketId: ticket.id,
        includePdfBase64: true,
      });
      setResult(res);

      // The letter exists at this point — attachment and comment failures are warnings,
      // never a reason to lose the links.
      const followUps: string[] = [];
      if (res.pdfBase64) {
        try {
          await addAttachment(ticket.id, `${res.fileName}.pdf`, base64ToBlob(res.pdfBase64, 'application/pdf'));
        } catch (e) {
          followUps.push(`PDF not attached (${e instanceof Error ? e.message : String(e)})`);
        }
      } else {
        followUps.push('Bridge returned no PDF bytes, so nothing was attached.');
      }
      try {
        await postComment(ticket.id, [{
          type: 'text',
          text: `Refund authorization letter generated for ${clientName.trim()} — closed card ${closedCardLast4.trim()}, new card ${newCardLast4.trim()}. Doc: ${res.docUrl}`,
        }]);
      } catch (e) {
        followUps.push(`Comment not posted (${e instanceof Error ? e.message : String(e)})`);
      }
      if (followUps.length) setWarning(followUps.join(' · '));

      setStep(4);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100%', background: 'var(--mint-bg-page)' }}>
      <Header step={step} ticketId={ticket.id} onClose={onClose} />
      {/* Reference links — open the source systems to eyeball the address (Atlas) and
          the cards (i2c) without leaving the workflow. */}
      <div style={{ display: 'flex', gap: 'var(--mint-sp-2)', padding: 'var(--mint-sp-3) var(--mint-sp-3) 0' }}>
        <button onClick={openAtlas} disabled={!ticket.identityId} title={ticket.identityId ? "Open this client's Atlas overview" : 'No identity ID on this ticket'} style={{ ...refLinkButton, background: 'var(--mint-positive-fg-graphic)', opacity: ticket.identityId ? 1 : 0.5, cursor: ticket.identityId ? 'pointer' : 'not-allowed' }}>
          ↗ Atlas
        </button>
        <button onClick={openI2c} disabled={!ticket.clientEmail} title={ticket.clientEmail ? 'Open i2c and search this client' : 'No client email on this ticket'} style={{ ...refLinkButton, background: 'var(--mint-warning-fg-graphic)', opacity: ticket.clientEmail ? 1 : 0.5, cursor: ticket.clientEmail ? 'pointer' : 'not-allowed' }}>
          ↗ i2c
        </button>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--mint-sp-2)', padding: 'var(--mint-sp-3)' }}>
        {step === 4 && result ? (
          <SuccessPanel result={result} warning={warning} ticketId={ticket.id} onCloseToTicket={onClose} />
        ) : (
          <>
            {step >= 1 ? (
              <ExpandedCard n={1} completed={step > 1}>
                {step === 1 ? (
                  <>
                    <div style={{ display: 'flex', gap: 'var(--mint-sp-2)', alignItems: 'center', marginBottom: 'var(--mint-sp-2)' }}>
                      <button onClick={() => { void runAtlasFetch(); }} disabled={atlasState === 'pending' || !ticket.identityId} style={{ ...secondaryButton, opacity: atlasState === 'pending' || !ticket.identityId ? 0.6 : 1 }}>
                        {atlasState === 'pending' ? '… Fetching from Atlas' : '↗ Fetch from Atlas'}
                      </button>
                      {atlasState === 'done' ? (
                        <span style={{ fontSize: 'var(--mint-text-micro)', color: atlasPartial ? 'var(--mint-warning-fg-strong)' : 'var(--mint-positive-fg-strong)' }}>
                          {atlasPartial ? '⚠ Partial — fill the blanks' : '✓ Fetched'}
                        </span>
                      ) : null}
                    </div>
                    {atlasError ? <ErrorLine text={atlasError} /> : null}
                    <Field label="Client full legal name" value={clientName} onChange={setClientName} />
                    <Field label="Street (incl. unit)" value={street} onChange={setStreet} />
                    <Field label="City, Province" value={cityProvince} onChange={setCityProvince} />
                    <Field label="Postal code" value={postal} onChange={setPostal} />
                    <button onClick={() => setStep(2)} disabled={!step1Ready} style={{ ...primaryButton, width: '100%', marginTop: 'var(--mint-sp-2)', opacity: step1Ready ? 1 : 0.5, cursor: step1Ready ? 'pointer' : 'not-allowed' }}>
                      Continue
                    </button>
                  </>
                ) : (
                  <Summary lines={[clientName, street, `${cityProvince}  ${postal}`]} />
                )}
              </ExpandedCard>
            ) : null}

            {step >= 2 ? (
              <ExpandedCard n={2} completed={step > 2}>
                {step === 2 ? (
                  <>
                    <div style={{ display: 'flex', gap: 'var(--mint-sp-2)', alignItems: 'center', marginBottom: 'var(--mint-sp-2)' }}>
                      <button onClick={() => { void runI2cFetch(); }} disabled={i2cState === 'pending' || !ticket.clientEmail} style={{ ...secondaryButton, opacity: i2cState === 'pending' || !ticket.clientEmail ? 0.6 : 1 }}>
                        {i2cState === 'pending' ? '… Fetching from i2c' : '↗ Fetch from i2c'}
                      </button>
                      {i2cState === 'done' && i2cCards.length > 0 ? (
                        <span style={{ fontSize: 'var(--mint-text-micro)', color: 'var(--mint-positive-fg-strong)' }}>✓ {i2cCards.length} card{i2cCards.length === 1 ? '' : 's'}</span>
                      ) : null}
                    </div>
                    {i2cError ? <ErrorLine text={i2cError} /> : null}
                    {i2cCards.length > 0 ? (
                      <div style={{ marginBottom: 'var(--mint-sp-2)' }}>
                        <div style={{ fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-soft)', marginBottom: 4 }}>
                          Found in i2c — click to re-assign (closed first, then new):
                        </div>
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                          {i2cCards.map((c) => (
                            <button key={c.last4} onClick={() => assignCard(c.last4)} style={cardChipStyle}>
                              ••{c.last4}{c.status ? ` · ${c.status}` : ''}
                            </button>
                          ))}
                        </div>
                      </div>
                    ) : null}
                    <Field label="Closed card — last 4" value={closedCardLast4} onChange={setClosedCardLast4} inputMode="numeric" maxLength={4} />
                    <Field label="New card — last 4" value={newCardLast4} onChange={setNewCardLast4} inputMode="numeric" maxLength={4} />
                    <Field label="Declined refund date(s)" value={refundDates} onChange={setRefundDates} />
                    <label style={fieldLabelStyle}>How many refunds were declined?</label>
                    <select
                      value={refundsArePlural ? 'many' : 'one'}
                      onChange={(e) => setMultipleRefunds(e.target.value === 'many')}
                      style={{ ...inputStyle }}
                      aria-label="Number of declined refunds"
                    >
                      <option value="one">One — “The refund … was declined”</option>
                      <option value="many">More than one — “The refunds … were declined”</option>
                    </select>
                    <label style={fieldLabelStyle}>Reason the refund was declined</label>
                    <select value={DECLINE_REASONS.includes(declineReason) ? declineReason : ''} onChange={(e) => { if (e.target.value) setDeclineReason(e.target.value); }} style={{ ...inputStyle, marginBottom: 4 }}>
                      {DECLINE_REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
                      <option value="">Custom — type below</option>
                    </select>
                    <input value={declineReason} onChange={(e) => setDeclineReason(e.target.value)} style={inputStyle} aria-label="Decline reason wording" />
                    <div style={{ fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-soft)', marginBottom: 'var(--mint-sp-2)' }}>
                      Reads: “…were declined because {declineReason || '…'}.”
                    </div>
                    <Field label="Letter date" value={letterDate} onChange={setLetterDate} />
                    <Field label="CXA first name" value={agentFirstName} onChange={setAgentFirstName} />
                    <div style={{ display: 'flex', gap: 'var(--mint-sp-2)', marginTop: 'var(--mint-sp-2)' }}>
                      <button onClick={() => setStep(1)} style={secondaryButton}>← Back</button>
                      <button onClick={() => setStep(3)} disabled={!step2Ready} style={{ ...primaryButton, flex: 1, opacity: step2Ready ? 1 : 0.5, cursor: step2Ready ? 'pointer' : 'not-allowed' }}>
                        Continue
                      </button>
                    </div>
                  </>
                ) : (
                  <Summary lines={[`Closed ${closedCardLast4} → new ${newCardLast4}`, refundDates, declineReason]} />
                )}
              </ExpandedCard>
            ) : (
              <FutureStub n={2} />
            )}

            {step >= 3 ? (
              <ExpandedCard n={3}>
                <LetterPreview
                  letterDate={letterDate}
                  clientName={clientName}
                  street={street}
                  cityProvince={cityProvince}
                  postal={postal}
                  closedCardLast4={closedCardLast4}
                  newCardLast4={newCardLast4}
                  refundDates={refundDates}
                  declineReason={declineReason}
                  agentFirstName={agentFirstName}
                  refundNoun={refundsArePlural ? 'refunds' : 'refund'}
                  refundVerb={refundsArePlural ? 'were' : 'was'}
                />
                {error ? <ErrorLine text={error} /> : null}
                <div style={{ display: 'flex', gap: 'var(--mint-sp-2)', marginTop: 'var(--mint-sp-3)' }}>
                  <button onClick={() => setStep(2)} disabled={busy} style={secondaryButton}>← Back</button>
                  <button onClick={() => { void generate(); }} disabled={busy} style={{ ...primaryButton, flex: 1, opacity: busy ? 0.6 : 1, cursor: busy ? 'wait' : 'pointer' }}>
                    {busy ? 'Generating…' : '✓ Generate letter + PDF'}
                  </button>
                </div>
                <div style={{ fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-soft)', marginTop: 6, lineHeight: 1.45 }}>
                  Creates “{clientName || 'Client'} | Refund Letter” in Drive, exports a PDF, attaches it to {ticket.id} and comments on the ticket.
                </div>
              </ExpandedCard>
            ) : (
              <FutureStub n={3} />
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ============================================================
// Letter preview
// ============================================================

function LetterPreview(p: {
  letterDate: string; clientName: string; street: string; cityProvince: string; postal: string;
  closedCardLast4: string; newCardLast4: string; refundDates: string; declineReason: string; agentFirstName: string;
  refundNoun: string; refundVerb: string;
}) {
  return (
    <div style={{ padding: 'var(--mint-sp-3)', background: 'var(--mint-bg-subtle)', border: 'var(--mint-card-stroke)', borderRadius: 'var(--mint-radius-card)', fontSize: 'var(--mint-text-micro)', lineHeight: 1.7, color: 'var(--mint-fg-strong)', whiteSpace: 'pre-wrap' }}>
      {`${p.letterDate}
${p.clientName}

My name is ${p.agentFirstName} and I am an Associate of Client Experience at Wealthsimple. I am confirming the following details for ${p.clientName}

${p.clientName}
${p.street}
${p.cityProvince}
${p.postal}

Closed Visa Credit Card Number Last 4 Digits: ${p.closedCardLast4}
New Visa Credit Card Number Last 4 Digits: ${p.newCardLast4}

The ${p.refundNoun} processed on ${p.refundDates} ${p.refundVerb} declined because ${p.declineReason}. The client has an active card account with last four digits ${p.newCardLast4} and is able to receive a refund. Please void the old refund and post to this account.

Please feel free to contact us at support@wealthsimple.com or at +1 (…) if there is anything else we can further assist you with.

Sincerely,

${p.agentFirstName}
Client Experience Associate
Wealthsimple`}
    </div>
  );
}

// ============================================================
// Step 4 — Success
// ============================================================

function SuccessPanel({ result, warning, ticketId, onCloseToTicket }: { result: RefundLetterResult; warning: string | null; ticketId: string; onCloseToTicket: () => void }) {
  return (
    <section style={{ background: 'var(--mint-positive-bg-soft)', border: '1px solid var(--mint-positive-fg-graphic)', borderRadius: 'var(--mint-radius-card)', padding: 'var(--mint-sp-4)', textAlign: 'center' }}>
      <div style={{ width: 48, height: 48, margin: '0 auto var(--mint-sp-2)', borderRadius: 9999, background: 'var(--mint-positive-fg-graphic)', color: '#fff', fontSize: 24, fontWeight: 800, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>✓</div>
      <h3 style={{ margin: 0, fontSize: 'var(--mint-text-h-md)', color: 'var(--mint-fg-strong)', fontWeight: 700 }}>Letter generated</h3>
      <p style={{ margin: 'var(--mint-sp-2) 0 var(--mint-sp-3)', fontSize: 'var(--mint-text-meta)', color: 'var(--mint-fg-subdued-title)', lineHeight: 1.6 }}>
        {result.fileName}
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--mint-sp-2)' }}>
        <a href={result.docUrl} target="_blank" rel="noreferrer" style={{ ...primaryButton, textDecoration: 'none', display: 'block' }}>Open Doc ↗</a>
        <a href={result.pdfUrl} target="_blank" rel="noreferrer" style={{ ...secondaryButton, textDecoration: 'none', display: 'block' }}>Open PDF ↗</a>
      </div>
      {warning ? (
        <div role="alert" style={{ marginTop: 'var(--mint-sp-2)', padding: 6, background: 'var(--mint-warning-bg-soft)', border: '1px solid var(--mint-warning-fg-graphic)', borderRadius: 'var(--mint-radius-button)', fontSize: 'var(--mint-text-nano)', color: 'var(--mint-warning-fg-strong)', textAlign: 'left' }}>
          {warning}
        </div>
      ) : (
        <div style={{ fontSize: 'var(--mint-text-nano)', color: 'var(--mint-positive-fg-strong)', marginTop: 'var(--mint-sp-2)' }}>
          PDF attached to {ticketId} · comment posted
        </div>
      )}
      <button onClick={onCloseToTicket} style={{ ...secondaryButton, width: '100%', marginTop: 'var(--mint-sp-3)' }}>Close &amp; return to ticket</button>
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
        <span style={{ marginLeft: 'auto', fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-soft)' }}>Step {Math.min(step, 3)} of 3</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <h2 style={{ margin: 0, fontSize: 'var(--mint-text-h-md)', fontWeight: 700, color: 'var(--mint-fg-strong)' }}>Refund Auth Letter</h2>
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

function Summary({ lines }: { lines: string[] }) {
  return (
    <div style={{ fontSize: 'var(--mint-text-micro)', color: 'var(--mint-fg-subdued-title)', lineHeight: 1.6 }}>
      {lines.filter(Boolean).map((l, i) => <div key={i}>{l}</div>)}
    </div>
  );
}

function Field({ label, value, onChange, inputMode, maxLength }: {
  label: string; value: string; onChange: (v: string) => void;
  inputMode?: 'numeric' | 'text'; maxLength?: number;
}) {
  return (
    <>
      <label style={fieldLabelStyle}>{label}</label>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        inputMode={inputMode}
        maxLength={maxLength}
        style={inputStyle}
      />
    </>
  );
}

function ErrorLine({ text }: { text: string }) {
  return (
    <div role="alert" style={{ marginBottom: 'var(--mint-sp-2)', padding: 6, background: 'var(--mint-negative-bg-soft)', border: '1px solid var(--mint-negative-fg-graphic)', borderRadius: 'var(--mint-radius-button)', fontSize: 'var(--mint-text-nano)', color: 'var(--mint-negative-fg-strong)', lineHeight: 1.45 }}>
      {text}
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

// ============================================================
// helpers + styles
// ============================================================

/** Collapse embedded newlines/tabs — they'd become real line breaks in the Doc. */
function clean(v: string): string {
  return (v || '').replace(/\s+/g, ' ').trim();
}

/**
 * Atlas stores names however the client typed them, so they arrive all-lowercase or
 * ALL-CAPS. Re-case only those; anything already mixed-case (McDonald, van Dijk) is left
 * alone, and the field stays editable either way.
 */
function titleCaseName(raw: string): string {
  const name = clean(raw);
  if (!name) return name;
  const isUniformCase = name === name.toLowerCase() || name === name.toUpperCase();
  if (!isUniformCase) return name;
  return name.toLowerCase().replace(/(^|[\s'\u2019-])([a-z])/g, (_m, sep: string, ch: string) => sep + ch.toUpperCase());
}

/** Two dates, or a list — "June 7 2026 and May 18 2026", "July 1, July 8". */
function looksLikeMultipleDates(v: string): boolean {
  return /\band\b|[,;&]|\+/i.test(v || '');
}

/** Template format, e.g. "Mon July 20 2026". */
function formatLetterDate(d: Date): string {
  const weekday = d.toLocaleDateString('en-CA', { weekday: 'short' });
  const month = d.toLocaleDateString('en-CA', { month: 'long' });
  return `${weekday} ${month} ${d.getDate()} ${d.getFullYear()}`;
}

const fieldLabelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: 'var(--mint-text-nano)',
  fontWeight: 600,
  color: 'var(--mint-fg-subdued-title)',
  marginBottom: 2,
};

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '8px 10px',
  marginBottom: 'var(--mint-sp-2)',
  fontFamily: 'var(--mint-font-family)',
  fontSize: 'var(--mint-text-meta)',
  border: 'var(--mint-card-stroke)',
  borderRadius: 'var(--mint-radius-button)',
  background: 'var(--mint-bg-card)',
  color: 'var(--mint-fg-strong)',
  boxSizing: 'border-box',
};

const refLinkButton: React.CSSProperties = {
  flex: 1,
  padding: '8px 14px',
  borderRadius: 'var(--mint-radius-button)',
  fontWeight: 600,
  fontSize: 'var(--mint-text-meta)',
  border: 'none',
  color: '#ffffff',
  minHeight: 36,
};

const cardChipStyle: React.CSSProperties = {
  padding: '4px 10px',
  borderRadius: 9999,
  border: 'var(--mint-card-stroke)',
  background: 'var(--mint-bg-card)',
  color: 'var(--mint-fg-strong)',
  fontSize: 'var(--mint-text-nano)',
  fontWeight: 600,
  cursor: 'pointer',
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
  textAlign: 'center',
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
  textAlign: 'center',
};
