// Banner that surfaces when a ticket looks like it should be on the CRED (Credit
// Decisioning) board rather than CXA. One-click opens the existing Clone/Move modal
// with CRED preselected.

import { useMemo } from 'react';
import type { WocooTicket } from '../data/mockTicket';
import { detectCredRoute } from '../data/credRouteDetect';

export function CredRouteCard({ ticket, onOpenCloneMove }: { ticket: WocooTicket; onOpenCloneMove: () => void }) {
  const detection = useMemo(
    () => detectCredRoute(ticket.summary || '', ticket.description || '', ticket.workType),
    [ticket.summary, ticket.description, ticket.workType],
  );
  if (!detection.matched) return null;

  return (
    <div style={wrap}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <span style={{ fontSize: 18, lineHeight: 1 }}>⚡</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 'var(--mint-text-meta)', fontWeight: 700, color: 'var(--mint-highlight-fg-strong)', marginBottom: 4 }}>
            Recommended: Clone/Move to CRED
          </div>
          <div style={{ fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-strong)', lineHeight: 1.45 }}>
            Looks like a credit-card decisioning task (application reset, identity loop, credit limit, or similar). The Credit Decisioning team owns these — Clone/Move the original so the Zendesk thread stays intact and the CXA clone is logged for tracking.
          </div>
          <div style={{ marginTop: 4, fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-soft)', fontStyle: 'italic' }}>
            Signals: {detection.reasons.join(' · ')}
          </div>
          <div style={{ marginTop: 'var(--mint-sp-2)' }}>
            <button
              onClick={onOpenCloneMove}
              style={{
                padding: '6px 12px',
                background: 'var(--mint-fg-strong)',
                color: 'var(--mint-fg-inverted)',
                border: 'none',
                borderRadius: 'var(--mint-radius-button)',
                fontSize: 'var(--mint-text-nano)',
                fontWeight: 700,
                cursor: 'pointer',
              }}
            >
              ↗ Open Clone/Move (CRED preselected)
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

const wrap: React.CSSProperties = {
  padding: 'var(--mint-sp-2) var(--mint-sp-3)',
  background: 'var(--mint-highlight-bg-soft)',
  border: '1px solid var(--mint-highlight-fg-graphic)',
  borderRadius: 'var(--mint-radius-card)',
  fontSize: 'var(--mint-text-meta)',
};
