// Run/pause state of the local draft agent, as reported by the native host.

export type AgentMode = 'running' | 'paused';

export interface AgentModeState {
  mode: AgentMode;
  /** Epoch seconds when the mode last changed, or null when unknown. */
  since: number | null;
}

/** Turns a host reply into a state. Anything other than 'running' counts as paused, so an
 *  unexpected value never makes the UI claim the agent is working. */
export function normaliseAgentMode(reply: { mode?: unknown; since?: unknown }): AgentModeState {
  const since = typeof reply.since === 'number' && Number.isFinite(reply.since) ? reply.since : null;
  return { mode: reply.mode === 'running' ? 'running' : 'paused', since };
}

export function agentModeHelper(mode: AgentMode): string {
  return mode === 'running'
    ? 'The agent drafts tickets and may use i2c on its own, logging in when needed.'
    : "Paused: the agent won't draft or touch i2c, so you can work.";
}

/** "since <local time>" for a mode-change timestamp in epoch seconds, or null when unset. */
export function agentModeSince(since: number | null): string | null {
  if (since === null || !Number.isFinite(since)) return null;
  const when = new Date(since * 1000);
  if (Number.isNaN(when.getTime())) return null;
  return `since ${when.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`;
}
