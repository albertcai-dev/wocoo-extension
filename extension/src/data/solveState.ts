// What the "Solve using Sidekick Agent" button shows, from where the ticket stands with the agent.

import type { AgentItemState } from '../api/draftStore';

export type SolveView =
  | { kind: 'idle' }
  | { kind: 'solving'; label: string }
  | { kind: 'finished'; label: string; draftReady: boolean };

/** `pressed`: the user pressed Solve in this panel session (so a finished state is news). */
export function solveView(item: AgentItemState | null, pressed: boolean): SolveView {
  if (!item) return { kind: 'idle' };
  const { state, priority, solo } = item;
  if (state === 'in_progress' && (priority || solo)) return { kind: 'solving', label: 'Solving with Sidekick Agent…' };
  if (state === 'queued' && (priority || solo)) return { kind: 'solving', label: 'Queued for Sidekick Agent…' };
  if (state === 'awaiting_compass' && (priority || solo || pressed)) {
    return { kind: 'solving', label: 'Waiting for Compass to answer…' };
  }
  if (!pressed) return { kind: 'idle' };
  switch (state) {
    case 'drafted': return { kind: 'finished', label: 'Solved: the draft is below.', draftReady: true };
    case 'no_new_angle': return { kind: 'finished', label: 'Nothing new to add since your last reply.', draftReady: true };
    case 'skipped': return { kind: 'finished', label: 'Skipped: overpayments are yours to handle.', draftReady: false };
    case 'failed': return { kind: 'finished', label: "The agent couldn't solve this one (see its log).", draftReady: false };
    default: return { kind: 'idle' };
  }
}

/** Overpayment tickets are never offered to the agent. */
export function solveOffered(workType: string | undefined): boolean {
  return !/overpayment/i.test(workType || '');
}
