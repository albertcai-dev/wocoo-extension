// AI verdict card — replaces the heuristic suggested-response. Fires on ticket open,
// grounded in Albert's own resolved-ticket log plus the Notion playbook mirror.

import { useCallback, useEffect, useState } from 'react';
import type { WocooTicket } from '../data/mockTicket';
import type { TriageVerdict } from '../data/aiTriageTypes';
import { getLlmGatewayKey } from '../auth/credentials';
import { callLlmGateway } from '../api/llmGateway';
import { getRecentLogViaBridge, getPlaybookViaBridge } from '../api/bridge';
import { searchPrecedent } from '../api/jira';
import { joinPrecedentOutcomes } from '../data/precedent';
import { buildTriagePrompt, parseTriageVerdict } from './composePrompt';
import { getOrCompute, invalidate } from './aiTriageCache';

type State =
  | { kind: 'no-key' }
  | { kind: 'loading' }
  | { kind: 'ready'; verdict: TriageVerdict }
  | { kind: 'error'; message: string };

export function AITriageCard({ ticket, onOpenSettings }: { ticket: WocooTicket; onOpenSettings: () => void }) {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [precedentFailed, setPrecedentFailed] = useState(false);

  const run = useCallback(async (force: boolean) => {
    const key = await getLlmGatewayKey();
    if (!key) { setState({ kind: 'no-key' }); return; }

    setState({ kind: 'loading' });
    setPrecedentFailed(false);
    if (force) invalidate(ticket.id, ticket.updated);

    try {
      const verdict = await getOrCompute(ticket.id, ticket.updated, async () => {
        const [recentRows, playbookChunks, precedentRows] = await Promise.all([
          getRecentLogViaBridge(ticket.workType),
          getPlaybookViaBridge(),
          // A precedent-fetch failure must not fail the card: the verdict still renders
          // from log plus playbook. Spec §2b, Degradation.
          searchPrecedent(ticket.workType, ticket.id).catch(() => null),
        ]);
        setPrecedentFailed(precedentRows === null);
        const precedent = joinPrecedentOutcomes(precedentRows ?? [], recentRows);
        const messages = buildTriagePrompt({
          ticketId: ticket.id,
          summary: ticket.summary,
          description: ticket.description,
          workType: ticket.workType,
          allowedWorkTypes: Array.from(new Set([
            ticket.workType,
            ...recentRows.map((r) => r.finalWorkType || r.originalWorkType),
          ].filter(Boolean))),
          recentRows,
          playbookChunks,
          precedent,
        });
        const raw = await callLlmGateway(messages, key);
        const parsed = parseTriageVerdict(raw, precedent.map((c) => c.ticketId));
        if (!parsed.ok) throw new Error(parsed.error);
        return parsed.verdict;
      });
      setState({ kind: 'ready', verdict });
    } catch (e: any) {
      setState({ kind: 'error', message: e?.message || 'The verdict call failed.' });
    }
  }, [ticket.id, ticket.updated, ticket.summary, ticket.description, ticket.workType]);

  useEffect(() => { void run(false); }, [run]);

  // Never hidden outright: a hidden card makes the feature permanently invisible to the
  // one person who uses it.
  if (state.kind === 'no-key') {
    return (
      <div style={cardStyle}>
        <Header />
        <button type="button" onClick={onOpenSettings} style={linkButtonStyle}>
          Add LLM Gateway key in Settings
        </button>
      </div>
    );
  }

  if (state.kind === 'loading') {
    return (
      <div style={cardStyle}>
        <Header />
        <div style={mutedStyle}>Reading your log, playbook and past tickets…</div>
      </div>
    );
  }

  if (state.kind === 'error') {
    return (
      <div style={cardStyle}>
        <Header />
        <div style={{ ...mutedStyle, color: 'var(--mint-negative-fg-strong)' }}>{state.message}</div>
        <button type="button" onClick={() => void run(true)} style={linkButtonStyle}>Retry</button>
      </div>
    );
  }

  const v = state.verdict;
  return (
    <div style={cardStyle}>
      <Header right={<ConfidenceChip level={v.confidence} />} />
      <div style={{ fontSize: 'var(--mint-text-meta)', fontWeight: 700, color: 'var(--mint-fg-strong)' }}>{v.workType}</div>
      {v.rationale && <div style={mutedStyle}>{v.rationale}</div>}

      {v.steps.length > 0 && (
        <ol style={listStyle}>
          {v.steps.map((s, i) => <li key={i}>{s}</li>)}
        </ol>
      )}

      {v.gotchas.length > 0 && (
        <ul style={listStyle}>
          {v.gotchas.map((g, i) => <li key={i}>⚠ {g}</li>)}
        </ul>
      )}

      {v.similarTickets.length > 0 && (
        <div style={{ marginTop: 'var(--mint-sp-2)' }}>
          <div style={{ ...mutedStyle, fontWeight: 600 }}>Precedent</div>
          {v.similarTickets.map((s) => (
            <div key={s.ticketId} style={mutedStyle}>
              <a
                href={`https://wealthsimple.atlassian.net/browse/${s.ticketId}`}
                target="_blank"
                rel="noreferrer"
                style={{ color: 'var(--mint-fg-strong)' }}
              >{s.ticketId}</a>
              <SourceBadge source={s.source} />
              {' — '}{s.whatHappened}
            </div>
          ))}
        </div>
      )}

      {precedentFailed && (
        <div style={{ ...mutedStyle, color: 'var(--mint-fg-soft)' }}>
          Precedent unavailable — verdict is from your log and playbook only.
        </div>
      )}

      <button type="button" onClick={() => void run(true)} style={linkButtonStyle}>Regenerate</button>
    </div>
  );
}

function Header({ right }: { right?: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 'var(--mint-sp-2)' }}>
      <span style={{ fontSize: 'var(--mint-text-meta)', fontWeight: 700, color: 'var(--mint-fg-strong)' }}>AI verdict</span>
      {right && <span style={{ marginLeft: 'auto' }}>{right}</span>}
    </div>
  );
}

function ConfidenceChip({ level }: { level: TriageVerdict['confidence'] }) {
  const color = level === 'high'
    ? 'var(--mint-positive-fg-strong)'
    : level === 'medium' ? 'var(--mint-fg-subdued-title)' : 'var(--mint-fg-soft)';
  return <span style={{ fontSize: 'var(--mint-text-nano)', fontWeight: 600, color }}>{level} confidence</span>;
}

function SourceBadge({ source }: { source: 'logged' | 'intake-only' }) {
  // intake-only means we only have the original request, never the outcome. Say so, so
  // the request text is not read as a resolution.
  const logged = source === 'logged';
  return (
    <span
      title={logged ? 'You logged a resolution note for this ticket' : 'No recorded outcome — request text only'}
      style={{
        marginLeft: 6,
        fontSize: 'var(--mint-text-nano)',
        fontWeight: 600,
        color: logged ? 'var(--mint-positive-fg-strong)' : 'var(--mint-fg-soft)',
      }}
    >{logged ? 'logged' : 'intake only'}</span>
  );
}

const cardStyle: React.CSSProperties = {
  background: 'var(--mint-bg-card)',
  border: 'var(--mint-card-stroke)',
  borderRadius: 'var(--mint-radius-card)',
  padding: 'var(--mint-sp-3)',
  marginTop: 'var(--mint-sp-3)',
};

const mutedStyle: React.CSSProperties = {
  fontSize: 'var(--mint-text-micro)',
  color: 'var(--mint-fg-subdued-title)',
  marginTop: 4,
};

const listStyle: React.CSSProperties = {
  fontSize: 'var(--mint-text-micro)',
  color: 'var(--mint-fg-subdued-title)',
  margin: '6px 0 0',
  paddingLeft: 18,
};

const linkButtonStyle: React.CSSProperties = {
  marginTop: 'var(--mint-sp-2)',
  background: 'none',
  border: 'none',
  padding: 0,
  fontSize: 'var(--mint-text-micro)',
  color: 'var(--mint-fg-strong)',
  textDecoration: 'underline',
  cursor: 'pointer',
};
