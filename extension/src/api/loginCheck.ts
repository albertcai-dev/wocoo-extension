// Opens a site in a background tab and watches where it lands, to tell whether the user is
// signed in (see data/loginCheck.ts). Signed-in tabs are closed again; any other tab is left
// open so the user can sign in there.

import { LOGIN_SITE_URLS, classifyLogin, type LoginProbe, type LoginSite, type LoginStatus } from '../data/loginCheck';

/** Long enough for Atlas's auto "Login With Okta" round trip and KOHO's SPA to settle. */
const PROBE_DEADLINE_MS = 25_000;
const PROBE_STEP_MS = 1_500;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** What the tab shows right now. Page text is only readable on the site's own host (host
 *  permission); on Okta only the URL is known, which is enough. */
async function readTab(tabId: number): Promise<LoginProbe> {
  const tab = await chrome.tabs.get(tabId);
  const url = tab.url || tab.pendingUrl || '';
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => ({
        text: (document.body?.innerText || '').slice(0, 4000),
        hasKohoSearch: !!document.querySelector('input[placeholder*="search Users" i]'),
      }),
    });
    return { url, ...(res?.result as { text: string; hasKohoSearch: boolean } | undefined) };
  } catch {
    return { url };
  }
}

export interface SiteLoginResult {
  site: LoginSite;
  status: LoginStatus;
  /** The tab left open for the user (status not 'in'). */
  tabId?: number;
}

/** Opens the site in an inactive tab and polls until it is clearly signed in (then closes
 *  the tab) or the deadline passes (then reports the last status and keeps the tab). */
export async function checkSiteLogin(site: LoginSite): Promise<SiteLoginResult> {
  const tab = await chrome.tabs.create({ url: LOGIN_SITE_URLS[site], active: false });
  const tabId = tab.id;
  if (tabId == null) return { site, status: 'unknown' };
  const end = Date.now() + PROBE_DEADLINE_MS;
  let status: LoginStatus = 'unknown';
  let outSince: number | null = null;
  while (Date.now() < end) {
    await sleep(PROBE_STEP_MS);
    let probe: LoginProbe;
    try {
      probe = await readTab(tabId);
    } catch {
      return { site, status: 'unknown' }; // the user closed the tab
    }
    status = classifyLogin(site, probe);
    if (status === 'in') {
      await chrome.tabs.remove(tabId).catch(() => {});
      return { site, status };
    }
    // A sign-in page can be a step on the way in (Atlas clicks "Login With Okta" by itself and
    // a live Okta session sends it straight back), so only trust "out" once it has held a while.
    if (status === 'out') {
      outSince ??= Date.now();
      if (Date.now() - outSince > 8_000) break;
    } else {
      outSince = null;
    }
  }
  return { site, status, tabId };
}

/** Brings a tab the user needs to act in to the front. */
export async function focusTab(tabId: number): Promise<void> {
  try {
    const tab = await chrome.tabs.update(tabId, { active: true });
    if (tab?.windowId != null) await chrome.windows.update(tab.windowId, { focused: true });
  } catch { /* tab gone */ }
}

/** The sites the Sidekick Agent reads behind Okta. */
export const AGENT_LOGIN_SITES: LoginSite[] = ['atlas', 'koho'];

/** Checks every agent site at once; `onUpdate` gets each site's status as it lands. Tabs that
 *  need the user stay open, the first of them brought to the front. */
export async function checkAgentLogins(onUpdate: (site: LoginSite, status: LoginStatus | 'checking' | 'error') => void): Promise<void> {
  AGENT_LOGIN_SITES.forEach((s) => onUpdate(s, 'checking'));
  const results = await Promise.all(AGENT_LOGIN_SITES.map(async (site) => {
    try {
      const r = await checkSiteLogin(site);
      onUpdate(site, r.status);
      return r;
    } catch {
      onUpdate(site, 'error');
      return null;
    }
  }));
  const needsUser = results.find((r) => r && r.status !== 'in' && r.tabId != null);
  if (needsUser?.tabId != null) await focusTab(needsUser.tabId);
}
