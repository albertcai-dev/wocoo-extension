// Tiny in-process event bus for ticket transitions. Two sources push into it:
//   1. Sidepanel-originating transitionTicket() calls (wrapped in api/jira.ts).
//   2. Content-script status-pill observations, relayed through the service worker
//      and re-emitted here by SidePanel.tsx's chrome.runtime.onMessage listener.
//
// Dedup: same ticketId + kind within 30 seconds is dropped. Prevents both channels
// firing for the same transition (sidepanel button click also updates the Jira DOM
// which the observer sees a moment later).

import type { TicketTransitionKind } from '../data/ticketLogTypes';

export interface TicketTransitionEvent {
  ticketId: string;
  kind: TicketTransitionKind;
  movedToBoard?: string;
  source: 'sidepanel' | 'dom';
}

const DEDUP_WINDOW_MS = 30_000;

type Listener = (evt: TicketTransitionEvent) => void;
const listeners = new Set<Listener>();
const recent = new Map<string, number>(); // key: `${ticketId}::${kind}` -> timestampMs

function dedupKey(evt: TicketTransitionEvent): string {
  return evt.ticketId + '::' + evt.kind;
}

export function emitTicketTransition(evt: TicketTransitionEvent): boolean {
  const key = dedupKey(evt);
  const now = Date.now();
  const last = recent.get(key);
  if (last != null && now - last < DEDUP_WINDOW_MS) {
    console.debug('[ticketLog] deduped', evt.source, key);
    return false;
  }
  recent.set(key, now);
  console.debug('[ticketLog] emit', evt.source, key, evt);
  listeners.forEach((l) => {
    try { l(evt); } catch (e) { console.error('[ticketLog] listener threw', e); }
  });
  // Garbage-collect old dedup entries occasionally.
  if (recent.size > 200) {
    for (const [k, t] of recent) {
      if (now - t > DEDUP_WINDOW_MS) recent.delete(k);
    }
  }
  return true;
}

export function subscribeToTicketTransitions(cb: Listener): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

export function emitMoveTransition(sourceTicketId: string, destProject: string): void {
  emitTicketTransition({
    ticketId: sourceTicketId,
    kind: 'Moved',
    movedToBoard: destProject,
    source: 'sidepanel',
  });
}
