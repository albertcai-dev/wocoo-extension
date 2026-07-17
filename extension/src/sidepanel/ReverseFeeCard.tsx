// Auto-detect recommendation card for fee-reversal tickets. Renders above
// QuickActions in the side panel when detectReverseFee matches.

import type { WocooTicket } from '../data/mockTicket';
import { detectReverseFee } from '../data/reverseFeeDetect';

export function ReverseFeeCard({ ticket, onStart }: { ticket: WocooTicket; onStart: () => void }) {
  const detection = detectReverseFee(ticket.summary || '', ticket.description || '', ticket.workType);
  if (!detection.matched) return null;
  // Interest-Related Issues tickets don't carry a clientEmail — the workflow fetches it
  // from Atlas on entry. Every other trigger still requires the email up front.
  if (!ticket.clientEmail && !detection.isInterestFlow) return null;

  const title = detection.isInterestFlow
    ? '↗ Interest fee waiver — Reverse Fee'
    : '↗ Looks like a fee reversal request';

  return (
    <div style={cardStyle}>
      <div style={titleStyle}>{title}</div>
      <div style={reasonsStyle}>{detection.reasons.join(' · ')}</div>
      <button onClick={onStart} style={buttonStyle}>Start Reverse Fee</button>
    </div>
  );
}

const cardStyle: React.CSSProperties = {
  background: 'var(--mint-highlight-bg-soft)',
  border: '1px solid var(--mint-highlight-fg-graphic)',
  borderRadius: 'var(--mint-radius-card)',
  padding: 'var(--mint-sp-3)',
  display: 'flex',
  flexDirection: 'column',
};
const titleStyle: React.CSSProperties = {
  fontSize: 'var(--mint-text-meta)',
  fontWeight: 700,
  marginBottom: 4,
  color: 'var(--mint-highlight-fg-strong)',
};
const reasonsStyle: React.CSSProperties = {
  fontSize: 'var(--mint-text-nano)',
  color: 'var(--mint-fg-subdued-title)',
  marginBottom: 'var(--mint-sp-2)',
};
const buttonStyle: React.CSSProperties = {
  padding: '6px 12px',
  borderRadius: 'var(--mint-radius-button)',
  fontWeight: 600,
  fontSize: 'var(--mint-text-meta)',
  border: 'none',
  background: 'var(--mint-fg-strong)',
  color: 'var(--mint-fg-inverted)',
  cursor: 'pointer',
  alignSelf: 'flex-start',
};
