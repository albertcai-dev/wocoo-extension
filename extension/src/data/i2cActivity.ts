// Decides when Albert's i2c tab should tell the local draft agent he is active.
// The agent shares his i2c login (one customer context per login), so it stays out
// until he has been idle a while. Pure so the throttle/agent-tab rules are testable.

/** At most one activity report per this many milliseconds. */
export const REPORT_THROTTLE_MS = 30_000;

/** sessionStorage flag the agent sets on its own i2c tab. */
export const AGENT_TAB_KEY = 'wocoo-agent';

/**
 * True when an input event should be reported as Albert's activity: it was produced by a
 * real user (not a script), it is not in the agent's own tab, and no report went out in
 * the last REPORT_THROTTLE_MS. `lastSentTs` and `now` are epoch milliseconds.
 */
export function shouldReport(
  e: { isTrusted: boolean },
  isAgentTab: boolean,
  lastSentTs: number,
  now: number,
): boolean {
  if (!e.isTrusted) return false;
  if (isAgentTab) return false;
  return now - lastSentTs >= REPORT_THROTTLE_MS;
}
