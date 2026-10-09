// Fetch W# Wire Send Monitoring — Home view tool.
//
// For RBC incoming-wire tracker rows with no receiver external account: paste the
// returned wire's txdetail_rmtinfo_ustrd (or just its REF) and get the W# of the account
// the original wire was sent from. Preset runs in a hidden tab; Atlas is GraphQL.
// Read-only — nothing is written to the tracker.

import { useState } from 'react';
import { PresetAuthError } from '../data/presetSql';
import { atlasTransferUrl, fetchWireSendW, type WireSendWResult } from '../data/wireSendW';
import type { WireSendRow } from '../data/presetChartData';
import { CopyButton, errorBanner, listItemStyle, Pill, primaryButton } from './toolUi';

const label: React.CSSProperties = { color: 'var(--mint-positive-fg-strong)', fontWeight: 700, flexShrink: 0 };
const mono: React.CSSProperties = { fontFamily: 'var(--mint-font-mono)', color: 'var(--mint-fg-strong)', overflowWrap: 'anywhere' };

export function FetchWireSendWTile() {
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<WireSendWResult | null>(null);
  const [error, setError] = useState('');

  async function onFetch() {
    if (busy) return; // one hidden Preset tab at a time
    setBusy(true); setError(''); setResult(null);
    try {
      setResult(await fetchWireSendW(input));
    } catch (e) {
      setError(e instanceof PresetAuthError ? 'Sign in to Preset, then press Fetch again.' : (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 8, padding: 'var(--mint-sp-3)',
      background: 'var(--mint-bg-card)', border: 'var(--mint-card-stroke)', borderRadius: 'var(--mint-radius-card)',
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <span style={{ fontSize: 22, lineHeight: 1 }}>🔎</span>
        <span style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
          <span style={{ fontSize: 'var(--mint-text-meta)', fontWeight: 700, color: 'var(--mint-fg-strong)' }}>Fetch W# Wire Send Monitoring</span>
          <span style={{ fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-soft)', lineHeight: 1.45 }}>
            For a returned wire with no receiver account: paste txdetail_rmtinfo_ustrd (or the REF) to get the W# it was sent from.
          </span>
        </span>
      </div>
      <textarea
        value={input}
        onChange={(e) => { setInput(e.target.value); setResult(null); setError(''); }}
        placeholder="Paste txdetail_rmtinfo_ustrd or the REF"
        rows={3}
        style={{ width: '100%', boxSizing: 'border-box', fontFamily: 'var(--mint-font-mono)', fontSize: 'var(--mint-text-nano)', padding: 8, borderRadius: 'var(--mint-radius-button)', border: 'var(--mint-card-stroke)', resize: 'vertical' }}
      />
      <button onClick={onFetch} disabled={busy || !input.trim()} style={{ ...primaryButton, padding: '8px 12px', opacity: busy || !input.trim() ? 0.6 : 1, cursor: busy ? 'wait' : 'pointer' }}>
        {busy ? 'Fetching…' : 'Fetch W#'}
      </button>
      {error ? <div style={errorBanner}>{error}</div> : null}
      {result ? <ResultView result={result} /> : null}
    </div>
  );
}

function ResultView({ result }: { result: WireSendWResult }) {
  switch (result.kind) {
    case 'no_ref':
      return <div style={errorBanner}>Couldn't find a REF in that text.</div>;
    case 'none':
      return <div style={errorBanner}>No wire send with e2e_identifier {result.ref} — this may not be a returned send.</div>;
    case 'multiple':
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={errorBanner}>{result.rows.length} wire sends match {result.ref} — check which one in Atlas.</div>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
            {result.rows.map((row, i) => (
              <li key={i} style={{ ...listItemStyle, flexDirection: 'column', fontSize: 'var(--mint-text-nano)' }}>
                <RowContext row={row} />
              </li>
            ))}
          </ul>
        </div>
      );
    case 'no_account':
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={errorBanner}>{result.reason}</div>
          <div style={{ ...listItemStyle, flexDirection: 'column', fontSize: 'var(--mint-text-nano)' }}><RowContext row={result.row} /></div>
        </div>
      );
    case 'found':
      return (
        <div style={{ padding: '6px 10px', background: 'var(--mint-positive-bg-soft)', border: '1px solid var(--mint-positive-fg-graphic)', borderRadius: 'var(--mint-radius-button)', display: 'flex', flexDirection: 'column', gap: 4, fontSize: 'var(--mint-text-micro)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={label}>W#:</span>
            <span style={{ ...mono, flex: 1, userSelect: 'all' }}>{result.account.accountNumber}</span>
            <CopyButton value={result.account.accountNumber} />
          </div>
          {!result.account.isCadSpend ? (
            <div><Pill tone="warning" wrap label="Not a CAD chequing account — check before pasting." /></div>
          ) : null}
          <RowContext row={result.row} />
        </div>
      );
  }
}

function RowContext({ row }: { row: WireSendRow }) {
  const line = (k: string, v: string) => (
    <div style={{ display: 'flex', gap: 8 }}>
      <span style={{ color: 'var(--mint-fg-soft)', flexShrink: 0 }}>{k}</span>
      <span style={mono}>{v || '—'}</span>
    </div>
  );
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 'var(--mint-text-nano)' }}>
      {line('Identity', row.identityId)}
      {line('Amount', [row.amount, row.currency].filter(Boolean).join(' '))}
      {line('Sent', row.createdAt)}
      {line('Source', row.sourceId)}
      {row.identityId && row.fundingIntentId ? (
        <a href={atlasTransferUrl(row)} target="_blank" rel="noreferrer" style={{ color: 'var(--mint-highlight-fg-strong)', fontWeight: 700 }}>↗ Atlas</a>
      ) : null}
    </div>
  );
}
