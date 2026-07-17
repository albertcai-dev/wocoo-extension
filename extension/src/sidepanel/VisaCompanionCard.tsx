// Auto-detect recommendation card for "client can't register for Visa Airport
// Companion" tickets. One-click action: post a canned @reporter reply pointing
// to the Guru card + doc + Visa Concierge phone, then transition the source
// ticket to Done. Self-contained (no separate workflow file).

import { useState } from 'react';
import type { WocooTicket } from '../data/mockTicket';
import { postComment, transitionTicket, type CommentSegment } from '../api/jira';
import { detectVisaCompanion } from '../data/visaCompanionDetect';
import {
  VISA_COMPANION_GURU_URL,
  VISA_COMPANION_DOC_URL,
  VISA_COMPANION_CONCIERGE_PHONE,
} from '../data/visaCompanionConfig';

type CardState = 'idle' | 'posting' | 'done' | 'error';

/** Build the templated comment text the textarea pre-fills with. The substrings
 *  `@<reporter>`, the guru URL, and the doc URL are detected at submit time and
 *  re-emitted as ADF mention + link nodes. */
function buildCommentText(reporterName: string): string {
  return (
    `Hi @${reporterName} , We can follow this ${VISA_COMPANION_GURU_URL} ` +
    `and this ${VISA_COMPANION_DOC_URL}. If its not resolved using these documents then we can always direct the client to Visa Infinite Concierge: ${VISA_COMPANION_CONCIERGE_PHONE}.\n\n` +
    `For benefits enabled through Visa directly, those are managed on Visas end so unfortunately we don't have visibility into eligibility for that program.\n\n` +
    `The best people to assist would be the Visa Concierge team.`
  );
}

/** Split the comment text on the literal @mention + guru URL + doc URL substrings
 *  (in whichever order they appear) and emit ADF segments. If any sentinel is
 *  absent (agent deleted it during edit), that segment degrades to plain text. */
function buildAdfSegments(
  text: string,
  reporterName: string,
  reporterAccountId: string | undefined,
): CommentSegment[] {
  const mentionLiteral = '@' + reporterName;
  const markers: Array<{ pos: number; length: number; emit: () => CommentSegment }> = [];

  const mPos = text.indexOf(mentionLiteral);
  if (mPos !== -1) {
    markers.push({
      pos: mPos,
      length: mentionLiteral.length,
      emit: () => reporterAccountId
        ? { type: 'mention', text: mentionLiteral, accountId: reporterAccountId }
        : { type: 'text', text: mentionLiteral },
    });
  }
  const gPos = text.indexOf(VISA_COMPANION_GURU_URL);
  if (gPos !== -1) {
    markers.push({
      pos: gPos,
      length: VISA_COMPANION_GURU_URL.length,
      emit: () => ({ type: 'link', text: 'guru', href: VISA_COMPANION_GURU_URL }),
    });
  }
  const dPos = text.indexOf(VISA_COMPANION_DOC_URL);
  if (dPos !== -1) {
    markers.push({
      pos: dPos,
      length: VISA_COMPANION_DOC_URL.length,
      emit: () => ({ type: 'link', text: 'document', href: VISA_COMPANION_DOC_URL }),
    });
  }

  markers.sort((a, b) => a.pos - b.pos);

  const segments: CommentSegment[] = [];
  let cursor = 0;
  for (const m of markers) {
    if (m.pos > cursor) segments.push({ type: 'text', text: text.slice(cursor, m.pos) });
    segments.push(m.emit());
    cursor = m.pos + m.length;
  }
  if (cursor < text.length) segments.push({ type: 'text', text: text.slice(cursor) });

  return segments;
}

export function VisaCompanionCard({ ticket, onTicketUpdate }: {
  ticket: WocooTicket;
  onTicketUpdate: (t: WocooTicket) => void;
}) {
  const [state, setState] = useState<CardState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [softWarning, setSoftWarning] = useState<string | null>(null);

  // Hide entirely without a reporter — the @mention is the point of the comment.
  if (!ticket.reporter) return null;
  const detection = detectVisaCompanion(ticket.summary || '', ticket.description || '', ticket.workType);
  if (!detection.matched) return null;

  const reporterName = ticket.reporter;
  const reporterAccountId = (ticket as any).reporterAccountId as string | undefined;

  // Lazy-init the textarea text from the template. The reporter doesn't change
  // during the session so a single initialization is enough.
  const [commentText, setCommentText] = useState<string>(() => buildCommentText(reporterName));

  async function postAndMoveToDone() {
    setState('posting');
    setError(null);
    setSoftWarning(null);
    try {
      if (!commentText.trim()) throw new Error('Comment is empty.');
      const segments = buildAdfSegments(commentText, reporterName, reporterAccountId);
      await postComment(ticket.id, segments);

      try {
        await transitionTicket(ticket.id, '251');
        onTicketUpdate({ ...ticket, status: 'Done' });
      } catch (transitionErr: any) {
        setSoftWarning(
          'Comment posted on ' + ticket.id + ', but Move-to-Done failed: ' +
          (transitionErr?.message || String(transitionErr)) +
          '. Close the ticket manually in Jira.',
        );
      }

      setState('done');
    } catch (e: any) {
      setError(e?.message || String(e));
      setState('error');
    }
  }

  function onRetry() {
    setState('idle');
    setError(null);
  }

  if (state === 'done') {
    return (
      <div style={doneStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--mint-sp-2)' }}>
          <span style={{ fontSize: 18 }}>✓</span>
          <span style={{ fontSize: 'var(--mint-text-meta)', fontWeight: 700, color: 'var(--mint-positive-fg-strong)' }}>
            Posted on {ticket.id}{softWarning ? '' : ' and moved to Done.'}
          </span>
        </div>
        {softWarning ? (
          <div style={softWarningStyle}>{softWarning}</div>
        ) : null}
      </div>
    );
  }

  return (
    <div style={cardStyle}>
      <div style={titleStyle}>🛫 Looks like a Visa Companion / Airport Companion ticket</div>
      <div style={reasonsStyle}>{detection.reasons.join(' · ')}</div>

      {/* Editable comment — substrings `@<reporter>`, guru URL, and doc URL
          become a mention pill + two clickable links at submit time. */}
      <textarea
        value={commentText}
        onChange={(e) => setCommentText(e.target.value)}
        disabled={state === 'posting'}
        rows={9}
        style={textareaStyle}
      />
      <div style={hintStyle}>
        Editable. Keep <code>@{reporterName}</code> and the URLs intact for the mention pill and clickable links.
      </div>

      {state === 'error' && error ? (
        <div style={errorBannerStyle}>
          <span>⚠ {error}</span>
          <button onClick={onRetry} style={textLinkStyle}>Retry</button>
        </div>
      ) : null}

      <button
        onClick={postAndMoveToDone}
        disabled={state === 'posting'}
        style={{ ...buttonStyle, opacity: state === 'posting' ? 0.6 : 1, cursor: state === 'posting' ? 'wait' : 'pointer' }}
      >
        {state === 'posting' ? 'Posting & moving…' : 'Send reply & Move to Done'}
      </button>
    </div>
  );
}

// ===== styles =====

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
const textareaStyle: React.CSSProperties = {
  width: '100%',
  padding: 'var(--mint-sp-2)',
  background: 'var(--mint-bg-subtle)',
  border: 'var(--mint-card-stroke)',
  borderRadius: 'var(--mint-radius-button)',
  fontFamily: 'var(--mint-font-family)',
  fontSize: 'var(--mint-text-nano)',
  color: 'var(--mint-fg-strong)',
  lineHeight: 1.5,
  boxSizing: 'border-box',
  resize: 'vertical',
  marginBottom: 4,
};
const hintStyle: React.CSSProperties = {
  fontSize: 'var(--mint-text-nano)',
  color: 'var(--mint-fg-soft)',
  marginBottom: 'var(--mint-sp-2)',
};
const buttonStyle: React.CSSProperties = {
  padding: '8px 14px',
  borderRadius: 'var(--mint-radius-button)',
  fontWeight: 600,
  fontSize: 'var(--mint-text-meta)',
  border: 'none',
  background: 'var(--mint-fg-strong)',
  color: 'var(--mint-fg-inverted)',
  alignSelf: 'stretch',
};
const errorBannerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 'var(--mint-sp-2)',
  padding: 'var(--mint-sp-2) var(--mint-sp-3)',
  background: 'var(--mint-negative-bg-soft)',
  color: 'var(--mint-negative-fg-strong)',
  borderRadius: 'var(--mint-radius-button)',
  fontSize: 'var(--mint-text-meta)',
  marginBottom: 'var(--mint-sp-2)',
};
const textLinkStyle: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: 'var(--mint-highlight-fg-strong)',
  fontWeight: 600,
  fontSize: 'var(--mint-text-meta)',
  cursor: 'pointer',
  padding: 0,
};
const doneStyle: React.CSSProperties = {
  background: 'var(--mint-positive-bg-soft)',
  border: '1px solid var(--mint-positive-fg-graphic)',
  borderRadius: 'var(--mint-radius-card)',
  padding: 'var(--mint-sp-3)',
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--mint-sp-2)',
};
const softWarningStyle: React.CSSProperties = {
  background: 'var(--mint-warning-bg-soft)',
  border: '1px solid var(--mint-warning-fg-graphic)',
  borderRadius: 'var(--mint-radius-button)',
  padding: 'var(--mint-sp-2) var(--mint-sp-3)',
  fontSize: 'var(--mint-text-nano)',
  color: 'var(--mint-warning-fg-strong)',
};
