// Text for the Sidekick Agent progress card (sidepanel/AgentProgress.tsx). Pure, so it is tested
// without a DOM.

import { agentLocalTime } from './agentMode';
import type { CardView, QueueTag } from './agentStatus';

type Current = NonNullable<CardView['current']>;
type Slow = NonNullable<Current['slow']>;

/** m:ss under an hour (3:12), h:mm:ss from an hour on. Negative or junk counts as 0. */
export function formatClock(seconds: number): string {
  const total = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const ss = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** Right side of the current-ticket row: "3:12 · usually ~6m · attempt 2 of 3". */
export function currentMeta(c: Pick<Current, 'elapsedS' | 'typicalS' | 'attempt' | 'maxAttempts'>): string {
  const parts = [formatClock(c.elapsedS)];
  if (c.typicalS !== null) parts.push(`usually ~${Math.max(1, Math.round(c.typicalS / 60))}m`);
  if (c.attempt !== null) parts.push(`attempt ${c.attempt} of ${c.maxAttempts}`);
  return parts.join(' · ');
}

/** The red note under a slow checklist. The cutoff clause needs a session deadline. */
export function slowNote(s: Slow): string {
  const base = `Same step for ${s.stepMin} min. Might be stuck on a login.`;
  if (s.cutoffMin === null) return base;
  return `${base} Gets cut off in ${s.cutoffMin}m and retried (attempt ${s.attempt} of ${s.maxAttempts}).`;
}

/** The explainer under the first Waiting on Compass row. */
export function waitingNote(askedMinAgo: number): string {
  return `Asked ${askedMinAgo}m ago. Jumps to the front when Compass answers, or drafts without it when time runs out.`;
}

/** The empty-queue footer, split so the card can bold the key: "Last: <key><tail>". With no
 *  last draft, key is null and tail is just the day's count. */
export function emptyFooterText(f: NonNullable<CardView['emptyFooter']>): { key: string | null; tail: string } {
  const today = `${f.draftedToday} drafted today`;
  if (f.lastKey === null) return { key: null, tail: today };
  const when = agentLocalTime(f.lastAt);
  return { key: f.lastKey, tail: `${when === null ? ' drafted' : ` drafted at ${when}`} · ${today}` };
}

export const QUEUE_TAG_LABEL: Record<QueueTag, string> = {
  solve: 'Solve',
  compass: 'Compass replied',
  reply: 'Reply in',
};

/** How many queue rows show before "+N more". */
export const QUEUE_PREVIEW = 3;
