// Home section listing tickets the draft agent has a reply waiting for. Renders nothing when the
// store is unreachable or empty: Home should not carry error noise for an optional integration.

import { useCallback, useEffect, useState } from 'react';
import { listReadyDrafts } from '../api/draftStore';
import type { ReadyDraftRow } from '../data/agentDraftTypes';

export function DraftsReadyList({ onOpenTicket }: { onOpenTicket: (ticketKey: string) => void }) {
  const [rows, setRows] = useState<ReadyDraftRow[]>([]);

  const refresh = useCallback(() => {
    listReadyDrafts().then(
      (items) => setRows(items),
      // DraftStoreUnavailable (or anything else): show nothing rather than a stale or error state.
      () => setRows([]),
    );
  }, []);

  // Load on mount and whenever the panel regains focus or becomes visible again.
  useEffect(() => {
    refresh();
    const onVisible = () => { if (document.visibilityState === 'visible') refresh(); };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh]);

  if (rows.length === 0) return null;

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 'var(--mint-sp-2)' }}>
      <h2 style={{ margin: 0, fontSize: 'var(--mint-text-h-sm)', fontWeight: 700, color: 'var(--mint-fg-strong)' }}>
        Drafts ready ({rows.length})
      </h2>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {rows.map((r) => (
          <button
            key={r.key}
            type="button"
            onClick={() => onOpenTicket(r.key)}
            style={{
              textAlign: 'left',
              padding: 'var(--mint-sp-2) var(--mint-sp-3)',
              background: 'var(--mint-bg-card)',
              border: 'var(--mint-card-stroke)',
              borderRadius: 'var(--mint-radius-card)',
              cursor: 'pointer',
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontWeight: 700, color: 'var(--mint-highlight-fg-strong)', fontSize: 'var(--mint-text-micro)' }}>{r.key}</span>
              {r.marker ? (
                <span style={{ fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-soft)' }}>{r.marker}</span>
              ) : null}
            </div>
            <div style={{ fontSize: 'var(--mint-text-meta)', color: 'var(--mint-fg-strong)', lineHeight: 1.4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {r.summary || <span style={{ color: 'var(--mint-fg-soft)', fontStyle: 'italic' }}>(no summary)</span>}
            </div>
          </button>
        ))}
      </div>
    </section>
  );
}
