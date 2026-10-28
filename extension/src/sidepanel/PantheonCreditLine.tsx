// Overpayment step 2's Pantheon line: the card's credit (positive total_balance) from
// credit.mart_cc_accounts, compared to the ticket amount. Informational only — like the
// i2c capture, it never blocks Verified. Pantheon lags ~2 days, so the as-of date is shown.

import { useEffect, useState } from 'react';
import { creditOnCard, type CardChoice } from '../data/estateCcPayment';
import { loadPantheonCard } from '../data/estateCcPaymentApi';

type LoadState = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; card: CardChoice };

function fmtAsOf(asOf: string): string {
  const d = new Date(`${asOf.slice(0, 10)}T12:00:00`);
  return Number.isNaN(d.getTime()) ? asOf : d.toLocaleDateString('en-CA', { month: 'short', day: 'numeric' });
}

export function PantheonCreditLine({ identityId, amount }: { identityId: string; amount: number | null }) {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [run, setRun] = useState(0);

  useEffect(() => {
    if (!identityId) { setState({ kind: 'error', message: 'No Identity ID on this ticket.' }); return; }
    let cancelled = false;
    setState({ kind: 'loading' });
    loadPantheonCard(identityId)
      .then((card) => { if (!cancelled) setState({ kind: 'ready', card }); })
      .catch((e: unknown) => { if (!cancelled) setState({ kind: 'error', message: e instanceof Error ? e.message : String(e) }); });
    return () => { cancelled = true; };
  }, [identityId, run]);

  let body: React.ReactNode;
  let tone: 'neutral' | 'warning' | 'negative' = 'neutral';
  if (state.kind === 'loading') {
    body = 'Loading Pantheon balance…';
  } else if (state.kind === 'error') {
    tone = 'negative';
    body = (
      <>
        <span style={{ flex: 1 }}>⚠ {state.message}</span>
        <button onClick={() => setRun((r) => r + 1)} style={retryButton}>Retry</button>
      </>
    );
  } else if (state.card.kind !== 'ok') {
    tone = 'warning';
    body = state.card.kind === 'multiple' ? `Pantheon: multiple cards (${state.card.count}) — check i2c.` : 'Pantheon: no credit card found.';
  } else {
    const { card, closed } = state.card;
    const credit = creditOnCard(card.totalBalance);
    const asOf = `as of ${fmtAsOf(card.asOf)}${closed ? ' · card is closed' : ''}`;
    if (credit == null) {
      tone = 'warning';
      body = <>Pantheon: no credit on the card ({asOf})</>;
    } else {
      const diff = amount != null ? Math.abs(credit - amount) : null;
      body = (
        <>
          <span style={{ flex: 1 }}><strong>Pantheon: ${credit.toFixed(2)} credit</strong> · {asOf}</span>
          {diff == null ? null : diff < 0.01
            ? <span style={{ color: 'var(--mint-positive-fg-strong)', fontWeight: 600 }}>✓ matches</span>
            : <span style={{ color: 'var(--mint-warning-fg-strong)', fontWeight: 600 }} title={`Ticket amount: $${amount!.toFixed(2)}`}>⚠ differs by ${diff.toFixed(2)}</span>}
        </>
      );
    }
  }

  const bg = tone === 'neutral' ? 'var(--mint-bg-subtle)' : `var(--mint-${tone}-bg-soft)`;
  const fg = tone === 'neutral' ? 'var(--mint-fg-strong)' : `var(--mint-${tone}-fg-strong)`;
  return (
    <div style={{ marginBottom: 'var(--mint-sp-3)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', background: bg, color: fg, border: 'var(--mint-card-stroke)', borderRadius: 'var(--mint-radius-button)', fontSize: 'var(--mint-text-micro)' }}>
        {body}
      </div>
    </div>
  );
}

const retryButton: React.CSSProperties = {
  padding: '4px 10px',
  borderRadius: 'var(--mint-radius-button)',
  fontWeight: 600,
  fontSize: 'var(--mint-text-nano)',
  border: 'var(--mint-card-stroke)',
  background: 'var(--mint-bg-card)',
  color: 'var(--mint-fg-strong)',
  cursor: 'pointer',
};
