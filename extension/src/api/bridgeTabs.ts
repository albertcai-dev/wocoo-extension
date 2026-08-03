// Bridge tab plumbing — the published Apps Script URL, plus a defensive sweeper for
// background tabs that leaked.
//
// Every headless bridge call (`callBridge(..., openInBackground = true)`) opens a
// background script.google.com tab and depends on one of two things to close it again:
// the GAS page's own `window.close()` (fired from its reply <script>), or `callBridge`'s
// in-memory `cleanup()` calling chrome.tabs.remove. Both can fail:
//
//   - GAS never renders a reply payload. An action missing from the `doGet` router falls
//     through to the dashboard HTML; a handler that throws before emitting its reply
//     <script> renders GAS's own error page. Either way nothing self-closes.
//   - The MV3 service worker is evicted mid-call. `callBridge`'s timeout is a bare
//     setTimeout, so a 30s wait with no intervening extension API activity races Chrome's
//     ~30s idle eviction. Lose that race and the chrome.tabs.remove never runs.
//
// A one-off leak is invisible; an alarm-driven caller leaks one tab per period forever.
// So we persist the set of open bridge tabs to chrome.storage.local — which survives
// worker eviction, unlike the closure state in callBridge — and sweep it.
//
// Two sweeps, catching different failures:
//   sweepExpiredBridgeTabs()      registry entries past their own deadline. Catches a live
//                                 worker whose reply never arrived, plus anything stranded
//                                 by an earlier eviction.
//   sweepAllBridgeTabsOnStartup() every ?action= bridge tab, unconditionally. Only sound
//                                 at worker startup, where no call can be in flight.

export const BRIDGE_URL =
  'https://script.google.com/a/macros/wealthsimple.com/s/AKfycbzWtgcWj8MgRW-MV9Yf9O5cLgDdktBsMw7vno760EJTjTMQsQKrKg9sZK7LCA73XuA-rA/exec';

const REGISTRY_KEY = 'bridge_open_tabs';

/** Extra slack past a call's own timeout before we consider its tab abandoned. Keeps the
 *  sweep from racing a `cleanup()` that is already closing the same tab. */
const SWEEP_GRACE_MS = 15_000;

interface BridgeTabEntry {
  action: string;
  openedAt: number;
  /** openedAt + the call's timeoutMs. Per-entry because timeouts vary widely — 30s for a
   *  sheet append, 120s for the mobile-cheque CSV paste. */
  deadlineAt: number;
}
type Registry = Record<string, BridgeTabEntry>;

function log(msg: string, ...args: unknown[]) {
  console.log('[wocoo-bridge-tabs]', msg, ...args);
}

// Serialises read-modify-write on the registry so two concurrent bridge calls in the same
// context can't clobber each other's entry. This is per-JS-context: the service worker and
// the side panel each hold their own instance, so a cross-context write can still race.
// That window is a few milliseconds and the startup sweep's URL scan backstops it, so it
// isn't worth a real cross-context lock.
let mutex: Promise<unknown> = Promise.resolve();

function withRegistry<T>(fn: (reg: Registry) => Promise<T> | T): Promise<T> {
  const run = async (): Promise<T> => {
    const stored = await chrome.storage.local.get(REGISTRY_KEY);
    const reg = (stored[REGISTRY_KEY] as Registry | undefined) || {};
    const result = await fn(reg);
    await chrome.storage.local.set({ [REGISTRY_KEY]: reg });
    return result;
  };
  // Chain onto the tail whether or not it settled cleanly, so one failure can't wedge the
  // queue permanently.
  const next = mutex.then(run, run);
  mutex = next.then(() => undefined, () => undefined);
  return next;
}

/** Note a freshly-opened bridge tab. Call as soon as the tab handle exists. */
export async function registerBridgeTab(tabId: number, action: string, timeoutMs: number): Promise<void> {
  const now = Date.now();
  await withRegistry((reg) => {
    reg[String(tabId)] = { action, openedAt: now, deadlineAt: now + timeoutMs };
  });
}

/** Forget a bridge tab. Safe to call for a tab that was never registered, and for one the
 *  user closed by hand (that's what the tabs.onRemoved hook uses it for). */
export async function unregisterBridgeTab(tabId: number): Promise<void> {
  // Cheap read outside the mutex first. tabs.onRemoved fires for every tab the user closes
  // and almost none are bridge tabs, so bail before the read-modify-write rather than
  // churning a storage write (and an onChanged broadcast) on every tab close.
  const stored = await chrome.storage.local.get(REGISTRY_KEY);
  const reg = (stored[REGISTRY_KEY] as Registry | undefined) || {};
  if (!(String(tabId) in reg)) return;
  await withRegistry((r) => {
    delete r[String(tabId)];
  });
}

async function closeTab(tabId: number): Promise<boolean> {
  try {
    await chrome.tabs.remove(tabId);
    return true;
  } catch {
    return false; // already gone
  }
}

async function tabExists(tabId: number): Promise<boolean> {
  try {
    await chrome.tabs.get(tabId);
    return true;
  } catch {
    return false;
  }
}

/** Close every registered bridge tab whose deadline (plus grace) has passed, and drop
 *  entries whose tab no longer exists. Returns the number of tabs actually closed.
 *  Never throws — a failed sweep must not break the caller that triggered it. */
export async function sweepExpiredBridgeTabs(): Promise<number> {
  try {
    const now = Date.now();
    const expired = await withRegistry(async (reg) => {
      const victims: Array<{ tabId: number; entry: BridgeTabEntry }> = [];
      for (const [key, entry] of Object.entries(reg)) {
        const tabId = Number(key);
        if (!Number.isFinite(tabId)) {
          delete reg[key];
          continue;
        }
        if (!(await tabExists(tabId))) {
          delete reg[key]; // closed by hand, or by a cleanup() we didn't see
          continue;
        }
        if (now > entry.deadlineAt + SWEEP_GRACE_MS) {
          victims.push({ tabId, entry });
          delete reg[key];
        }
      }
      return victims;
    });

    let closed = 0;
    for (const { tabId, entry } of expired) {
      if (await closeTab(tabId)) {
        closed++;
        log('swept orphan tab', {
          tabId,
          action: entry.action,
          ageSec: Math.round((now - entry.openedAt) / 1000),
        });
      }
    }
    if (closed > 0) log('swept', closed, 'orphaned bridge tab(s)');
    return closed;
  } catch (e) {
    log('sweepExpiredBridgeTabs failed', e);
    return 0;
  }
}

/** True for a bridge tab that exists only to service a `callBridge` request.
 *
 *  Gated on an `action` param so we never touch a tab the user wants: the dashboard is
 *  plain `/exec` with no query, and the Atlassian OAuth callback is `/exec?code=&state=`.
 *  Neither carries `action`, so neither is swept. */
function isBridgeActionTab(url: string | undefined): boolean {
  if (!url || !url.startsWith(BRIDGE_URL)) return false;
  try {
    return new URL(url).searchParams.has('action');
  } catch {
    return false;
  }
}

/** Close every bridge action tab, then clear the registry.
 *
 *  Only valid from runtime.onInstalled / onStartup: a fresh worker holds no pending
 *  callBridge promises, so any such tab is by definition abandoned. This is the sweep that
 *  actually cleans up after an eviction, where the registry entry survived but the timeout
 *  that would have closed the tab did not.
 *
 *  Scans by URL as well as by registry, so it still collects tabs whose registry entry was
 *  lost to a cross-context write race. */
export async function sweepAllBridgeTabsOnStartup(): Promise<number> {
  try {
    const tracked = await withRegistry((reg) => {
      const ids = Object.keys(reg).map(Number).filter(Number.isFinite);
      for (const key of Object.keys(reg)) delete reg[key];
      return ids;
    });

    const found = await chrome.tabs.query({ url: 'https://script.google.com/*' });
    const byUrl = found.filter((t) => isBridgeActionTab(t.url)).map((t) => t.id);

    const victims = new Set<number>();
    for (const id of [...tracked, ...byUrl]) {
      if (typeof id === 'number' && Number.isFinite(id)) victims.add(id);
    }

    let closed = 0;
    for (const tabId of victims) {
      if (await closeTab(tabId)) closed++;
    }
    if (closed > 0) log('startup sweep closed', closed, 'stale bridge tab(s)');
    return closed;
  } catch (e) {
    log('sweepAllBridgeTabsOnStartup failed', e);
    return 0;
  }
}
