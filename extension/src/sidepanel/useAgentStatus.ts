// Polls the local agent's status for the Settings progress card, and ticks a 1 s clock so the
// card's timers move between polls. Both stop while the panel is hidden.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getAgentStatus, isDraftStoreNotSetUp } from '../api/draftStore';
import { agentCardView, type AgentStatus, type CardView } from '../data/agentStatus';

const POLL_MS = 5000;
const CLOCK_MS = 1000;

const nowS = () => Date.now() / 1000;
const visible = () => document.visibilityState === 'visible';

export interface AgentStatusView {
  /** Null until the first status arrives, and for good once the store turns out not to be set up. */
  view: CardView | null;
  /** The last good status (null as for view), and when (Date.now() ms) its request was sent. */
  status: AgentStatus | null;
  requestedAt: number | null;
  /** Epoch seconds the view was computed at. */
  now: number;
  /** The last refresh failed; the view (if any) is the last good one. */
  failed: boolean;
  /** Fetch now, e.g. right after a toggle. */
  refresh: () => void;
}

export function useAgentStatus(): AgentStatusView {
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [requestedAt, setRequestedAt] = useState<number | null>(null);
  const [now, setNow] = useState(nowS);
  const [failed, setFailed] = useState(false);
  const stopped = useRef(false); // not set up here: never ask again
  const mounted = useRef(true);
  const inFlight = useRef(false);
  const again = useRef(false); // a refresh asked for mid-call runs once that call settles
  const timers = useRef<{ poll?: number; clock?: number }>({});

  const stopTimers = useCallback(() => {
    window.clearInterval(timers.current.poll);
    window.clearInterval(timers.current.clock);
    timers.current = {};
  }, []);

  const refresh: () => void = useCallback(() => {
    if (stopped.current) return;
    if (inFlight.current) { again.current = true; return; }
    inFlight.current = true;
    const sentAt = Date.now();
    getAgentStatus()
      .then((s) => {
        if (!mounted.current) return;
        setStatus(s);
        setRequestedAt(sentAt);
        setNow(nowS());
        setFailed(false);
      })
      .catch((e) => {
        if (!mounted.current) return;
        if (isDraftStoreNotSetUp(e)) {
          stopped.current = true;
          stopTimers();
          setStatus(null);
        } else {
          setFailed(true);
        }
      })
      .finally(() => {
        inFlight.current = false;
        if (again.current && mounted.current) {
          again.current = false;
          refresh();
        }
      });
  }, [stopTimers]);

  useEffect(() => {
    mounted.current = true;
    const start = () => {
      if (stopped.current || timers.current.poll !== undefined) return;
      refresh();
      timers.current = {
        // A poll that lands mid-call is just skipped; only explicit refreshes queue up.
        poll: window.setInterval(() => { if (!inFlight.current) refresh(); }, POLL_MS),
        clock: window.setInterval(() => setNow(nowS()), CLOCK_MS),
      };
    };
    const onVisibility = () => {
      if (visible()) start();
      else stopTimers();
    };
    if (visible()) start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      mounted.current = false;
      document.removeEventListener('visibilitychange', onVisibility);
      stopTimers();
    };
  }, [refresh, stopTimers]);

  const view = useMemo(() => (status === null ? null : agentCardView(status, now)), [status, now]);
  return { view, status, requestedAt, now, failed, refresh };
}
