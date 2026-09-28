// Auto-detect recommendation card for Visa Airport Companion / DragonPass tickets.
// Renders above QuickActions when detectVisaCompanion matches and launches the
// Visa Companion RPIN workflow.

import type { WocooTicket } from '../data/mockTicket';
import { detectVisaCompanion } from '../data/visaCompanionDetect';

export function VisaCompanionCard({ ticket, onStart }: { ticket: WocooTicket; onStart: () => void }) {
  if (!ticket.identityId) return null;
  const detection = detectVisaCompanion(ticket.summary || '', ticket.description || '', ticket.workType);
  if (!detection.matched) return null;

  return (
    <div style={cardStyle}>
      <div style={titleStyle}>✈️ Looks like a Visa Companion issue</div>
      <div style={reasonsStyle}>{detection.reasons.join(' · ')}</div>
      <button onClick={onStart} style={buttonStyle}>Start Visa Companion</button>
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
