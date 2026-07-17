// Auto-detect recommendation card for credit-card overpayment tickets. Renders
// above QuickActions in the side panel when detectOverpaymentTriage matches.

import type { WocooTicket } from '../data/mockTicket';
import { detectOverpaymentTriage } from '../data/overpaymentTriageDetect';

export function OverpaymentTriageCard({ ticket, onStart }: { ticket: WocooTicket; onStart: () => void }) {
  if (!ticket.clientEmail) return null;
  const detection = detectOverpaymentTriage(ticket.summary || '', ticket.description || '', ticket.workType);
  if (!detection.matched) return null;

  return (
    <div style={cardStyle}>
      <div style={titleStyle}>⚡ Looks like a credit card overpayment</div>
      <div style={reasonsStyle}>{detection.reasons.join(' · ')}</div>
      <button onClick={onStart} style={buttonStyle}>Start Overpayment Triage</button>
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
