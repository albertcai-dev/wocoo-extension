// Auto-detect recommendation card for "why was this interest charged?" tickets. Renders
// above the other cards in the side panel when detectInterestInvestigation matches, and
// launches the local Interest Validation tool with this ticket's identity prefilled.

import { useMemo } from 'react';
import type { WocooTicket } from '../data/mockTicket';
import { detectInterestInvestigation } from '../data/interestInvestigationDetect';
import { useInterestTool } from './useInterestTool';

export function InterestInvestigationCard({ ticket }: { ticket: WocooTicket }) {
  const detection = useMemo(
    () => detectInterestInvestigation(ticket.summary || '', ticket.description || '', ticket.workType),
    [ticket.summary, ticket.description, ticket.workType],
  );
  const { busy, note, run } = useInterestTool();

  if (!detection.matched) return null;

  return (
    <div style={wrap}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <span style={{ fontSize: 18, lineHeight: 1 }}>🔎</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 'var(--mint-text-meta)', fontWeight: 700, color: 'var(--mint-highlight-fg-strong)', marginBottom: 4 }}>
            Interest investigation
          </div>
          <div style={{ fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-strong)', lineHeight: 1.45 }}>
            The client is asking why interest was charged, not for it to be reversed. Run the Interest Validation tool first — it opens on Single User Validation with this identity filled in.
          </div>
          {detection.reasons.length > 0 ? (
            <div style={{ fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-subdued-title)', marginTop: 4 }}>
              {detection.reasons.slice(0, 2).join(' · ')}
            </div>
          ) : null}

          <div style={{ marginTop: 'var(--mint-sp-2)' }}>
            <button
              onClick={() => { void run({ identityId: ticket.identityId, ticketId: ticket.id }); }}
              disabled={busy || !ticket.identityId}
              title={ticket.identityId
                ? 'Open the Interest Validation tool with this identity prefilled'
                : 'No identity ID on this ticket'}
              style={{
                padding: '6px 12px',
                background: 'var(--mint-fg-strong)',
                color: 'var(--mint-fg-inverted)',
                border: 'none',
                borderRadius: 'var(--mint-radius-button)',
                fontSize: 'var(--mint-text-nano)',
                fontWeight: 700,
                cursor: busy || !ticket.identityId ? 'not-allowed' : 'pointer',
                opacity: busy || !ticket.identityId ? 0.6 : 1,
              }}
            >
              {busy ? '… Starting tool' : '🔎 Investigate Interest'}
            </button>
          </div>

          {note ? (
            <div
              role={note.kind === 'error' ? 'alert' : undefined}
              style={{
                marginTop: 8,
                padding: 6,
                borderRadius: 'var(--mint-radius-button)',
                fontSize: 'var(--mint-text-nano)',
                lineHeight: 1.45,
                background: note.kind === 'error' ? 'var(--mint-negative-bg-soft)' : 'var(--mint-positive-bg-soft)',
                border: `1px solid ${note.kind === 'error' ? 'var(--mint-negative-fg-graphic)' : 'var(--mint-positive-fg-graphic)'}`,
                color: note.kind === 'error' ? 'var(--mint-negative-fg-strong)' : 'var(--mint-positive-fg-strong)',
              }}
            >
              {note.text}
            </div>
          ) : null}
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
