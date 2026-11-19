// Relays the draft agent's `wocoo-agent:hello` (posted from its own tab after each navigation)
// to the service worker, which records the tab for the leftover-tab sweep (data/agentTabs.ts).

import { AGENT_HELLO_TYPE, AGENT_TAB_HELLO_MSG } from '../data/agentTabs';

export function relayAgentHello(): void {
  window.addEventListener('message', (e) => {
    if (e.source !== window || (e.data as { type?: unknown } | null)?.type !== AGENT_HELLO_TYPE) return;
    try {
      chrome.runtime.sendMessage({ type: AGENT_TAB_HELLO_MSG }).catch(() => { /* worker asleep */ });
    } catch {
      /* extension reloaded under this page */
    }
  });
}
