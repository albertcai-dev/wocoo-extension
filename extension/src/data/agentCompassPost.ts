// The local draft agent asks Compass (an AI agent in Slack) questions as the user. Posts made
// through an API relay are flagged by Slack and their @mention is escaped, so Compass's
// shortcuts never run; the agent instead opens the channel in its own Slack web tab and asks
// slack.ts to type and send the question there, with a real mention pill.
//
// The agent talks to slack.ts with window.postMessage from its tab. These pure helpers decide
// which requests are accepted, so the guard rules are testable without a DOM.

/** postMessage type the agent sends. */
export const AGENT_COMPASS_MSG = 'wocoo-agent:compass-post';

/** Attribute slack.ts sets on <html> with the JSON result, so the agent can read it back. */
export const AGENT_COMPASS_RESULT_ATTR = 'data-wocoo-compass-result';

/** sessionStorage key prefix recording that a job was already attempted in this tab. */
export const AGENT_COMPASS_DONE_PREFIX = 'wocoo-agent-compass:';

/** The only mention a request may (and must) start with. */
export const COMPASS_MENTION = 'compass';

export const MAX_TEXT_LENGTH = 4000;

/** Slack's composer renders a picked mention as <ts-mention data-label="@name" class="c-member_slug">
 *  (checked live 2026-10-20); the other selectors are fallbacks for older markup. */
export const MENTION_PILL_SELECTOR = 'ts-mention, [data-stringify-type="mention"], .c-member_slug';

/** Whether a pill's label / text names Compass. */
export function isCompassPillLabel(label: string | null | undefined): boolean {
  return (label || '').trim().replace(/^@/, '').toLowerCase() === COMPASS_MENTION;
}

export interface AgentCompassRequest {
  jobId: string;
  text: string;
}

export interface AgentCompassResult {
  jobId: string;
  ok: boolean;
  /** true when this job was already attempted in this tab; nothing was posted this time. */
  duplicate?: boolean;
  reason?: string;
}

const JOB_ID = /^[A-Z][A-Z0-9]*-\d+(?::[A-Za-z0-9_-]{1,40})?$/;

/**
 * Validates a window message. Returns null when the message is not an agent Compass request
 * at all (ignore it), `{ error }` when it is one but malformed, otherwise the request.
 * The text must start with "@compass " so the handler can only ever ask Compass.
 */
export function parseAgentCompassRequest(data: unknown): AgentCompassRequest | { error: string } | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  if (d.type !== AGENT_COMPASS_MSG) return null;
  const { jobId, text } = d;
  if (typeof jobId !== 'string' || !JOB_ID.test(jobId)) return { error: 'bad jobId' };
  if (typeof text !== 'string') return { error: 'text must be a string' };
  if (!text.startsWith('@' + COMPASS_MENTION + ' ')) return { error: 'text must start with "@compass "' };
  if (text.trim().length <= COMPASS_MENTION.length + 1) return { error: 'empty question' };
  if (text.length > MAX_TEXT_LENGTH) return { error: `text longer than ${MAX_TEXT_LENGTH} characters` };
  return { jobId, text };
}

/** sessionStorage key for a job. */
export function doneKey(jobId: string): string {
  return AGENT_COMPASS_DONE_PREFIX + jobId;
}
