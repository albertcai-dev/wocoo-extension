// Leftover browser tabs of the local draft agent. Each agent session drives Chrome through the
// Playwright extension, which puts the session's tabs in a tab group of their own. Sessions are
// told to close their tabs when done, but a killed or sloppy session leaves them behind, and
// nothing else closes them (not the session's exit, not Playwright's server stopping).
//
// So the agent announces its tab: after each navigation it posts `wocoo-agent:hello` from the
// page, a content script relays it, and the service worker records the tab. Between sessions
// (tick phase not draining) the sweeper closes recorded tabs and every tab in their groups,
// which also catches the session's connect page and blank tabs it never navigated.
//
// Only an explicit hello records a tab. The `wocoo-agent` sessionStorage marker alone is not
// enough: a tab Albert opens from an agent tab inherits its sessionStorage.

/** window.postMessage type the agent sends from its own tab. */
export const AGENT_HELLO_TYPE = 'wocoo-agent:hello';
/** chrome.runtime message a content script relays it as. */
export const AGENT_TAB_HELLO_MSG = 'wocoo:agent-tab-hello';
export const AGENT_TAB_SWEEP_ALARM = 'wocoo-agent-tab-sweep';

/** Tick phases with no draft session running. `draining` is a session; `start` / `polling` /
 *  `polled` lead into one (and a manual `--one` run sits in `start` while it drafts). */
const BETWEEN_SESSIONS = new Set(['ended', 'paused', 'poll_failed', 'deferred_foreign_pw']);

/** A tab that said hello this recently is left alone even between sessions: the phase read
 *  can be a few seconds stale when a new session starts. */
export const QUIET_MS = 90_000;

export interface AgentTabEntry {
  lastHelloAt: number;
}
export type AgentTabRegistry = Record<string, AgentTabEntry>;

export interface TabLite {
  id?: number;
  /** -1 (chrome.tabGroups.TAB_GROUP_ID_NONE) when the tab is in no group. */
  groupId?: number;
}

export interface SweepPlan {
  /** Tab ids to close. */
  close: number[];
  /** Registry keys to drop (closed now, or the tab is already gone). */
  forget: string[];
}

export function isBetweenSessions(phase: string | null | undefined): boolean {
  return !!phase && BETWEEN_SESSIONS.has(phase);
}

/** What to close, given the registry, every open tab and the agent's tick phase. Pure. */
export function planAgentTabSweep(
  reg: AgentTabRegistry,
  tabs: TabLite[],
  phase: string | null | undefined,
  now: number,
): SweepPlan {
  const live = new Map<number, TabLite>();
  for (const t of tabs) if (typeof t.id === 'number') live.set(t.id, t);

  const forget: string[] = [];
  const close = new Set<number>();
  const between = isBetweenSessions(phase);
  for (const [key, entry] of Object.entries(reg)) {
    const tab = live.get(Number(key));
    if (!tab) { forget.push(key); continue; }
    if (!between || now - entry.lastHelloAt < QUIET_MS) continue;
    forget.push(key);
    close.add(tab.id as number);
    const group = tab.groupId ?? -1;
    if (group >= 0) {
      for (const other of live.values()) if (other.groupId === group) close.add(other.id as number);
    }
  }
  return { close: [...close], forget };
}
