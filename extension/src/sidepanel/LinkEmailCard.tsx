// Manual email-thread linking. The agent pastes a Gmail URL (or a search term), picks
// the thread from a short candidate list, and it joins the ticket's tracked threads.
//
// Two stages because the id in a Gmail permalink can't be used directly: `#search/…`
// URLs carry an `FMfcgz…` id that GmailApp won't accept, so the thread has to be found
// by search. `#inbox/<hex>` URLs skip straight to confirmation.

import { useState } from 'react';
import {
  linkEmailThreadViaBridge,
  searchEmailThreadsViaBridge,
  type EmailThreadCandidate,
} from '../api/bridge';
import { parseGmailLink } from '../data/emailLink';
import { runReplyPollNow } from '../background/replyPollScheduler';

type Stage =
  | { kind: 'closed' }
  | { kind: 'input'; value: string; error?: string }
  | { kind: 'searching'; query: string }
  | { kind: 'picking'; query: string; candidates: EmailThreadCandidate[] }
  | { kind: 'linking' }
  | { kind: 'linked'; subject: string };

export function LinkEmailCard({ ticketId }: { ticketId: string }) {
  const [stage, setStage] = useState<Stage>({ kind: 'closed' });

  const search = async (raw: string) => {
    const target = parseGmailLink(raw);
    if (!target) {
      setStage({
        kind: 'input',
        value: raw,
        error: "Couldn't read that. Paste a Gmail thread URL, or type a search term like "
          + '"subject:dailypay".',
      });
      return;
    }
    // A hex thread id needs no search — confirm it directly so the agent still sees what
    // they're about to link.
    const query = target.kind === 'thread' ? `threadId:${target.threadId}` : target.query;
    setStage({ kind: 'searching', query });
    try {
      const candidates = target.kind === 'thread'
        ? await searchEmailThreadsViaBridge(`threadId:${target.threadId}`, 1)
        : await searchEmailThreadsViaBridge(target.query, 8);
      if (!candidates.length) {
        setStage({
          kind: 'input',
          value: target.kind === 'thread' ? target.threadId : target.query,
          error: 'No threads matched. Edit the query and try again — a bare word often '
            + 'matches Jira digests instead of the thread you want.',
        });
        return;
      }
      setStage({ kind: 'picking', query, candidates });
    } catch (e) {
      setStage({
        kind: 'input',
        value: raw,
        error: 'Gmail search failed through the bridge. ' + (e instanceof Error ? e.message : String(e)),
      });
    }
  };

  const link = async (c: EmailThreadCandidate) => {
    setStage({ kind: 'linking' });
    try {
      await linkEmailThreadViaBridge(ticketId, c.threadId);
      // Poll straight away so the new card appears without waiting up to 5 min.
      await runReplyPollNow('sidepanel-trigger');
      setStage({ kind: 'linked', subject: c.subject });
    } catch (e) {
      setStage({
        kind: 'input',
        value: c.threadId,
        error: 'Linking failed. ' + (e instanceof Error ? e.message : String(e)),
      });
    }
  };

  if (stage.kind === 'closed') {
    return (
      <button
        type="button"
        onClick={() => setStage({ kind: 'input', value: '' })}
        title="Attach a Gmail thread to this ticket so its replies show up here and on Home"
        style={chipStyle}
      >
        🔗 Link an email
      </button>
    );
  }

  if (stage.kind === 'linked') {
    return (
      <div style={{ ...panelStyle, color: 'var(--mint-fg-soft)' }}>
        <div style={{ fontSize: 'var(--mint-text-nano)' }}>
          Linked · {stage.subject || 'thread'}
        </div>
        <button type="button" onClick={() => setStage({ kind: 'closed' })} style={linkBtnStyle}>
          Link another
        </button>
      </div>
    );
  }

  if (stage.kind === 'searching' || stage.kind === 'linking') {
    return (
      <div style={panelStyle}>
        <div style={{ fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-soft)' }}>
          {stage.kind === 'searching' ? `Searching Gmail for "${stage.query}"…` : 'Linking…'}
        </div>
      </div>
    );
  }

  if (stage.kind === 'picking') {
    return (
      <div style={panelStyle}>
        <div style={{ fontSize: 'var(--mint-text-nano)', fontWeight: 700 }}>
          Pick the thread to link
        </div>
        {stage.candidates.map((c) => (
          <button
            key={c.threadId}
            type="button"
            onClick={() => void link(c)}
            style={{ ...candidateStyle, cursor: 'pointer' }}
            title={`Link ${c.threadId} to ${ticketId}`}
          >
            <span style={{ fontWeight: 600, fontSize: 'var(--mint-text-nano)' }}>
              {c.subject || '(no subject)'}
            </span>
            <span style={{ fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-soft)' }}>
              {c.lastFrom || c.from} · {c.messageCount} msg{c.messageCount === 1 ? '' : 's'}
              {c.lastDate ? ` · ${new Date(c.lastDate).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' })}` : ''}
            </span>
            {c.linkedTo && c.linkedTo !== ticketId ? (
              <span style={{ fontSize: 'var(--mint-text-nano)', color: 'var(--mint-negative-fg-strong)' }}>
                ⚠ already linked to {c.linkedTo} — linking here as well is allowed
              </span>
            ) : null}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setStage({ kind: 'input', value: stage.query })}
          style={linkBtnStyle}
        >
          Edit the query
        </button>
      </div>
    );
  }

  return (
    <div style={panelStyle}>
      <label style={{ fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-soft)' }}>
        Paste the Gmail URL, or a search term
      </label>
      <input
        autoFocus
        value={stage.value}
        onChange={(e) => setStage({ kind: 'input', value: e.target.value })}
        onKeyDown={(e) => { if (e.key === 'Enter') void search(stage.value); }}
        placeholder="https://mail.google.com/… or subject:dailypay"
        style={{
          font: 'inherit',
          fontSize: 'var(--mint-text-nano)',
          padding: '4px 6px',
          border: 'var(--mint-card-stroke)',
          borderRadius: 4,
          background: 'var(--mint-bg-card)',
          color: 'var(--mint-fg-strong)',
        }}
      />
      {stage.error ? (
        <div style={{ fontSize: 'var(--mint-text-nano)', color: 'var(--mint-negative-fg-strong)' }}>
          {stage.error}
        </div>
      ) : null}
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" onClick={() => void search(stage.value)} style={linkBtnStyle}>
          Search
        </button>
        <button type="button" onClick={() => setStage({ kind: 'closed' })} style={linkBtnStyle}>
          Cancel
        </button>
      </div>
    </div>
  );
}

const chipStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '4px 10px',
  margin: '0 var(--mint-sp-3)',
  background: 'var(--mint-bg-subtle)',
  border: 'var(--mint-card-stroke)',
  borderRadius: 'var(--mint-radius-card)',
  cursor: 'pointer',
  textAlign: 'left',
  width: 'calc(100% - 2 * var(--mint-sp-3))',
  boxSizing: 'border-box',
  font: 'inherit',
  fontSize: 'var(--mint-text-nano)',
  fontWeight: 600,
  color: 'var(--mint-fg-soft)',
};

const panelStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  padding: '8px 12px',
  margin: '0 var(--mint-sp-3)',
  background: 'var(--mint-bg-subtle)',
  border: 'var(--mint-card-stroke)',
  borderRadius: 'var(--mint-radius-card)',
  width: 'calc(100% - 2 * var(--mint-sp-3))',
  boxSizing: 'border-box',
};

const candidateStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  padding: '6px 8px',
  background: 'var(--mint-bg-card)',
  border: 'var(--mint-card-stroke)',
  borderRadius: 4,
  textAlign: 'left',
  font: 'inherit',
  color: 'var(--mint-fg-strong)',
};

const linkBtnStyle: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  padding: 0,
  font: 'inherit',
  fontSize: 'var(--mint-text-nano)',
  fontWeight: 600,
  color: 'var(--mint-highlight-fg-strong)',
  cursor: 'pointer',
  textAlign: 'left',
};
