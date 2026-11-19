// Service-worker half of the agent tab sweep (see data/agentTabs.ts for the why). The registry
// lives in chrome.storage.local so it survives worker eviction, like the bridge-tab registry.

import { getAgentStatus } from '../api/draftStore';
import {
  AGENT_TAB_SWEEP_ALARM,
  planAgentTabSweep,
  type AgentTabRegistry,
} from '../data/agentTabs';

const REGISTRY_KEY = 'agent_tabs';
const SWEEP_PERIOD_MIN = 2;

function log(msg: string, ...args: unknown[]) {
  console.log('[wocoo-agent-tabs]', msg, ...args);
}

// Same per-context read-modify-write chain as bridgeTabs.ts.
let mutex: Promise<unknown> = Promise.resolve();

function withRegistry<T>(fn: (reg: AgentTabRegistry) => Promise<T> | T): Promise<T> {
  const run = async (): Promise<T> => {
    const stored = await chrome.storage.local.get(REGISTRY_KEY);
    const reg = (stored[REGISTRY_KEY] as AgentTabRegistry | undefined) || {};
    const result = await fn(reg);
    await chrome.storage.local.set({ [REGISTRY_KEY]: reg });
    return result;
  };
  const next = mutex.then(run, run);
  mutex = next.then(() => undefined, () => undefined);
  return next;
}

/** Note that the agent spoke from this tab. */
export async function recordAgentTab(tabId: number): Promise<void> {
  await withRegistry((reg) => {
    reg[String(tabId)] = { lastHelloAt: Date.now() };
  });
}

export function scheduleAgentTabSweep(): Promise<void> {
  return chrome.alarms.create(AGENT_TAB_SWEEP_ALARM, { periodInMinutes: SWEEP_PERIOD_MIN });
}

/** Close the agent's leftover tabs if no draft session is running. Never throws. On a machine
 *  without the agent the registry stays empty, so this returns before asking the native host. */
export async function sweepAgentTabs(): Promise<number> {
  try {
    const stored = await chrome.storage.local.get(REGISTRY_KEY);
    const reg = (stored[REGISTRY_KEY] as AgentTabRegistry | undefined) || {};
    if (Object.keys(reg).length === 0) return 0;

    const status = await getAgentStatus();
    const tabs = await chrome.tabs.query({});
    const plan = await withRegistry((r) => {
      const p = planAgentTabSweep(r, tabs, status.tick?.phase, Date.now());
      for (const key of p.forget) delete r[key];
      return p;
    });

    let closed = 0;
    for (const tabId of plan.close) {
      try {
        await chrome.tabs.remove(tabId);
        closed++;
      } catch {
        /* already gone */
      }
    }
    if (closed > 0) log('closed', closed, 'leftover agent tab(s)', { phase: status.tick?.phase });
    return closed;
  } catch (e) {
    log('sweepAgentTabs failed', e);
    return 0;
  }
}
