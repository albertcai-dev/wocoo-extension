// Pre-workflow banner for tickets that must route to an L3 agent (Reverse Fee,
// Code 450, joint account, DD deposit timing analysis). One click posts the
// templated reply and cancels the ticket. The reply is always visible —
// matching the Overpayment Step 6 pattern — with an Edit toggle for tweaks.

import { useMemo, useState } from 'react';
import type { WocooTicket } from '../data/mockTicket';
import { detectL3Escalation, buildL3EscalationComment } from '../data/l3EscalationDetect';
import { postComment, transitionTicket } from '../api/jira';

type Status = 'idle' | 'posting' | 'done' | 'error';

// "Cancel request" → status "Cancelled/ No Action". L3 work is owned by the L3 agent
// after the handoff comment, so the WOCOO ticket is closed as no-action rather than Done
// (which would count it as work this team completed).
const CANCEL_TRANSITION_ID = '201';

export function L3EscalationCard({ ticket, onTicketUpdate }: { ticket: WocooTicket; onTicketUpdate: (t: WocooTicket) => void }) {
  const detection = useMemo(
    () => detectL3Escalation(ticket.summary || '', ticket.description || '', ticket.workType, ticket.attachmentCount || 0),
    [ticket.summary, ticket.description, ticket.workType, ticket.attachmentCount],
  );
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);
  const [commentText, setCommentText] = useState<string>(() => buildL3EscalationComment(ticket.reporter));

  if (!detection.matched) return null;
  if (status === 'done') {
    return (
      <div style={{ ...wrap, background: 'var(--mint-positive-bg-soft)', border: '1px solid var(--mint-positive-fg-graphic)', color: 'var(--mint-positive-fg-strong)' }}>
        ✓ L3 escalation comment posted &amp; ticket moved to Cancelled/No Action.
      </div>
    );
  }

  async function doPostAndCancel() {
    if (!commentText.trim()) { setError('Comment is empty.'); return; }
    setStatus('posting');
    setError(null);
    try {
      const segments = buildSegments(commentText, ticket.reporter, ticket.reporterAccountId);
      await postComment(ticket.id, segments);
      try {
        await transitionTicket(ticket.id, CANCEL_TRANSITION_ID);
        onTicketUpdate({ ...ticket, status: 'Cancelled' });
      } catch (e) {
        // Comment succeeded — surface the transition failure as a soft warning.
        setError(`Comment posted, but Cancel failed: ${e instanceof Error ? e.message : String(e)}. Cancel manually.`);
        setStatus('error');
        return;
      }
      setStatus('done');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus('error');
    }
  }

  return (
    <div style={wrap}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <span style={{ fontSize: 18, lineHeight: 1 }}>🚨</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 'var(--mint-text-meta)', fontWeight: 700, color: 'var(--mint-negative-fg-strong)', marginBottom: 4 }}>
            Escalate to L3 agent
          </div>
          <div style={{ fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-strong)', lineHeight: 1.45 }}>
            These cases (Reverse Fee, Code 450, joint account, DD deposit timing analysis) route to an L3 agent. One click posts the templated reply and moves to Cancelled/No Action.
          </div>
          {detection.reasons.length > 0 ? (
            <div style={{ fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-subdued-title)', marginTop: 4 }}>
              {detection.reasons.slice(0, 2).join(' · ')}
            </div>
          ) : null}

          {/* Comment — always visible and directly editable */}
          <textarea
            value={commentText}
            onChange={(e) => setCommentText(e.target.value)}
            disabled={status === 'posting'}
            rows={3}
            aria-label="L3 escalation comment"
            style={{
              width: '100%',
              marginTop: 'var(--mint-sp-2)',
              padding: '8px 10px',
              fontFamily: 'var(--mint-font-family)',
              fontSize: 'var(--mint-text-nano)',
              border: 'var(--mint-card-stroke)',
              borderRadius: 'var(--mint-radius-button)',
              background: 'var(--mint-bg-card)',
              color: 'var(--mint-fg-strong)',
              boxSizing: 'border-box',
              lineHeight: 1.45,
              resize: 'vertical',
            }}
          />

          <div style={{ marginTop: 'var(--mint-sp-2)', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button
              onClick={doPostAndCancel}
              disabled={status === 'posting'}
              style={{
                padding: '6px 12px',
                background: 'var(--mint-fg-strong)',
                color: 'var(--mint-fg-inverted)',
                border: 'none',
                borderRadius: 'var(--mint-radius-button)',
                fontSize: 'var(--mint-text-nano)',
                fontWeight: 700,
                cursor: status === 'posting' ? 'not-allowed' : 'pointer',
                opacity: status === 'posting' ? 0.6 : 1,
              }}
            >
              {status === 'posting' ? 'Posting…' : '✓ Post Comment & Cancel Ticket'}
            </button>
          </div>

          {error ? (
            <div role="alert" style={{ marginTop: 8, padding: 6, background: 'var(--mint-negative-bg-soft)', border: '1px solid var(--mint-negative-fg-graphic)', borderRadius: 'var(--mint-radius-button)', fontSize: 'var(--mint-text-nano)', color: 'var(--mint-negative-fg-strong)' }}>
              {error}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

const wrap: React.CSSProperties = {
  padding: 'var(--mint-sp-2) var(--mint-sp-3)',
  background: 'var(--mint-negative-bg-soft)',
  border: '1px solid var(--mint-negative-fg-graphic)',
  borderRadius: 'var(--mint-radius-card)',
  fontSize: 'var(--mint-text-meta)',
};

/**
 * Split the comment text into ADF segments so the @<reporter> mention renders as a real
 * mention pill. Same shape as the QC Auto-Reimb card's comment poster.
 */
function buildSegments(text: string, reporter: string, reporterAccountId: string | null | undefined) {
  const segments: Array<{ type: 'text' | 'mention'; text: string; accountId?: string }> = [];
  if (reporter && reporterAccountId) {
    const needle = `@${reporter}`;
    const i = text.indexOf(needle);
    if (i !== -1) {
      if (i > 0) segments.push({ type: 'text', text: text.slice(0, i) });
      segments.push({ type: 'mention', text: needle, accountId: reporterAccountId });
      const rest = text.slice(i + needle.length);
      if (rest) segments.push({ type: 'text', text: rest });
      return segments;
    }
  }
  segments.push({ type: 'text', text });
  return segments;
}
