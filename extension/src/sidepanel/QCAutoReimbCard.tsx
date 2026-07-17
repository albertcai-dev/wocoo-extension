// Pre-workflow banner that surfaces when a ticket looks like a QC client just became
// fee-waiver-eligible and is asking for a refund. Per the auto-reimbursement policy,
// no manual action is needed — the system handles it next statement period. One-click
// posts the templated comment and moves the ticket to Done.

import { useMemo, useState } from 'react';
import type { WocooTicket } from '../data/mockTicket';
import { detectQCAutoReimb, buildQCAutoReimbComment } from '../data/qcAutoReimbDetect';
import { postComment, transitionTicket } from '../api/jira';

type Status = 'idle' | 'editing' | 'posting' | 'done' | 'error';

export function QCAutoReimbCard({ ticket, onTicketUpdate }: { ticket: WocooTicket; onTicketUpdate: (t: WocooTicket) => void }) {
  const detection = useMemo(
    () => detectQCAutoReimb(ticket.summary || '', ticket.description || ''),
    [ticket.summary, ticket.description],
  );
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);
  const [commentText, setCommentText] = useState<string>(() => buildQCAutoReimbComment(ticket.reporter));
  const [expanded, setExpanded] = useState<boolean>(false);

  if (!detection.matched) return null;
  if (status === 'done') {
    return (
      <div style={{ ...wrap, background: 'var(--mint-positive-bg-soft)', border: '1px solid var(--mint-positive-fg-graphic)', color: 'var(--mint-positive-fg-strong)' }}>
        ✓ "No action required" comment posted &amp; ticket moved to Done.
      </div>
    );
  }

  async function doPostAndDone() {
    if (!commentText.trim()) { setError('Comment is empty.'); return; }
    setStatus('posting');
    setError(null);
    try {
      const segments = buildSegments(commentText, ticket.reporter, ticket.reporterAccountId);
      await postComment(ticket.id, segments);
      try {
        await transitionTicket(ticket.id, '251');
        onTicketUpdate({ ...ticket, status: 'Done' });
      } catch (e) {
        // Comment succeeded — surface the transition failure as a soft warning.
        setError(`Comment posted, but Move-to-Done failed: ${e instanceof Error ? e.message : String(e)}. Move manually.`);
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
        <span style={{ fontSize: 18, lineHeight: 1 }}>⚡</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 'var(--mint-text-meta)', fontWeight: 700, color: 'var(--mint-warning-fg-strong)', marginBottom: 4 }}>
            QC auto-reimbursement detected
          </div>
          <div style={{ fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-strong)', lineHeight: 1.45 }}>
            Looks like a newly-eligible QC client asking for a fee refund. Per policy, the system auto-reimburses on the next statement period — no manual action required.
          </div>
          <div style={{ marginTop: 'var(--mint-sp-2)', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button
              onClick={doPostAndDone}
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
              {status === 'posting' ? 'Posting…' : '✓ Post Comment & Move to Done'}
            </button>
            <button
              onClick={() => setExpanded((v) => !v)}
              style={{
                padding: '6px 12px',
                background: 'transparent',
                color: 'var(--mint-warning-fg-strong)',
                border: '1px solid var(--mint-warning-fg-graphic)',
                borderRadius: 'var(--mint-radius-button)',
                fontSize: 'var(--mint-text-nano)',
                fontWeight: 700,
                cursor: 'pointer',
              }}
            >
              {expanded ? 'Hide preview' : 'Preview / Edit'}
            </button>
          </div>
          {expanded ? (
            <textarea
              value={commentText}
              onChange={(e) => setCommentText(e.target.value)}
              disabled={status === 'posting'}
              rows={6}
              style={{
                width: '100%',
                marginTop: 8,
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
          ) : null}
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
  background: 'var(--mint-warning-bg-soft)',
  border: '1px solid var(--mint-warning-fg-graphic)',
  borderRadius: 'var(--mint-radius-card)',
  fontSize: 'var(--mint-text-meta)',
};

/**
 * Split the comment text into ADF segments so the @<reporter> mention renders as a real
 * mention pill. Same shape as the QC Fee Waiver workflow's comment poster.
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
