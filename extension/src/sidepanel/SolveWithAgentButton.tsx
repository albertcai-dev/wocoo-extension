// "Solve using Sidekick Agent": asks the local agent to draft this ticket now. A paused agent
// switches on for this ticket only and pauses itself once it is solved; a running agent takes
// it next. Renders nothing on machines without the agent and on overpayment tickets.

import { useEffect, useRef, useState } from 'react';
import { getAgentItem, isDraftStoreNotSetUp, solveTicket, type AgentItemState } from '../api/draftStore';
import { checkAgentLogins } from '../api/loginCheck';
import { loginSummary, type LoginSite, type LoginStatus } from '../data/loginCheck';
import { solveOffered, solveView } from '../data/solveState';
import type { WocooTicket } from '../data/mockTicket';

const POLL_MS = 8_000;

/** `solveRequest`: bumped by the draft card's "Solve again" to press Solve from there. */
export function SolveWithAgentButton({ ticket, onSolved, solveRequest = 0 }: {
  ticket: WocooTicket;
  onSolved: () => void;
  solveRequest?: number;
}) {
  const [item, setItem] = useState<AgentItemState | null>(null);
  const [available, setAvailable] = useState(false);
  const [pressed, setPressed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [logins, setLogins] = useState<Partial<Record<LoginSite, LoginStatus | 'checking' | 'error'>>>({});
  const onSolvedRef = useRef(onSolved);
  onSolvedRef.current = onSolved;

  // Where this ticket stands with the agent; re-read on ticket change.
  useEffect(() => {
    let cancelled = false;
    setPressed(false);
    setError(null);
    setLogins({});
    getAgentItem(ticket.id).then(
      (it) => { if (!cancelled) { setItem(it); setAvailable(true); } },
      (e) => { if (!cancelled) setAvailable(!isDraftStoreNotSetUp(e)); },
    );
    return () => { cancelled = true; };
  }, [ticket.id]);

  const view = solveView(item, pressed);

  // While the agent works on it, poll; when it finishes, let the draft card reload.
  useEffect(() => {
    if (view.kind !== 'solving') return;
    const timer = setInterval(() => {
      getAgentItem(ticket.id).then((it) => {
        setItem(it);
        const next = solveView(it, true);
        if (next.kind === 'finished' && next.draftReady) onSolvedRef.current();
      }, () => { /* keep polling */ });
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [view.kind, ticket.id]);

  // "Solve again" on the draft card: same press, then reload the card (the queued ticket has no draft).
  const lastRequest = useRef(solveRequest);
  useEffect(() => {
    if (solveRequest === lastRequest.current) return;
    lastRequest.current = solveRequest;
    void solve().then((ok) => { if (ok) onSolvedRef.current(); });
  }, [solveRequest]);

  if (!available || !solveOffered(ticket.workType)) return null;

  async function solve(): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      const res = await solveTicket(ticket.id);
      setPressed(true);
      setItem({ state: res.state, solo: res.solo, priority: true });
      // The agent was off and is now on (for this ticket): same sign-in check as the toggle.
      if (res.solo) void checkAgentLogins((site, status) => setLogins((prev) => ({ ...prev, [site]: status })));
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  }

  const solving = view.kind === 'solving';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <button
        type="button"
        onClick={() => void solve()}
        disabled={busy || solving}
        title="Ask the Sidekick Agent to draft this ticket now"
        style={{
          width: '100%',
          padding: '8px 14px',
          minHeight: 36,
          borderRadius: 'var(--mint-radius-button)',
          border: 'none',
          fontWeight: 600,
          fontSize: 'var(--mint-text-meta)',
          background: 'var(--mint-fg-strong)',
          color: 'var(--mint-fg-inverted)',
          cursor: busy || solving ? 'default' : 'pointer',
          opacity: busy ? 0.6 : 1,
        }}
      >
        {solving ? view.label : '✨ Solve using Sidekick Agent'}
      </button>
      {view.kind === 'finished' ? (
        <div style={{ fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-soft)', lineHeight: 1.4 }}>{view.label}</div>
      ) : null}
      {Object.keys(logins).length > 0 ? (
        <div style={{ fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-strong)', lineHeight: 1.4 }}>Logins: {loginSummary(logins)}</div>
      ) : null}
      {error ? (
        <div style={{ fontSize: 'var(--mint-text-nano)', color: 'var(--mint-negative-fg-strong)', lineHeight: 1.4 }}>{error}</div>
      ) : null}
    </div>
  );
}
