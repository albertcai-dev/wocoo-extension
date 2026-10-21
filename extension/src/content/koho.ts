export {}; // Module-scoped so helpers don't collide with other content scripts.

// Content script for admin.koho.ca — pastes the staged client email into the global
// "search Users" bar at the top of the dashboard and submits with Enter.
//
// The side panel writes pending_koho_email to chrome.storage.local just before opening
// admin.koho.ca; this script reads, fills, submits, and clears the key.

console.log('[wocoo-koho] content script loaded on', location.href);

import {
  AGENT_KOHO_CHAIN_KEY, AGENT_KOHO_RESULT_ATTR, AGENT_KOHO_RESULT_KEY, KOHO_TRANSACTIONS_PAGE, kohoUserId,
  parseKohoRequest, readKohoChain, type KohoChain, type SiteResult,
} from '../data/agentSiteChains';

const PENDING_KEY = 'pending_koho_email';

function log(msg: string, ...args: unknown[]) {
  console.log('[wocoo-koho]', msg, ...args);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function isVisible(el: HTMLElement): boolean {
  if (!el) return false;
  if (el.offsetParent === null && getComputedStyle(el).position !== 'fixed') return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

function setValue(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

// Koho admin's search bar at the top has a long placeholder that mentions the supported
// search types ("AccountID, Email, Name, Phone, PRN, or ReferenceID"). Match on that.
function findSearchInput(): HTMLInputElement | null {
  const inputs = Array.from(document.querySelectorAll<HTMLInputElement>('input'));
  for (const i of inputs) {
    const p = (i.placeholder || '').toLowerCase();
    if (!isVisible(i)) continue;
    if (p.includes('accountid') || p.includes('search users') || p.includes('email') ||
        (p.includes('search') && p.includes('user'))) {
      return i;
    }
  }
  // Fallback: any visible search-type input near the top of the page.
  for (const i of inputs) {
    if (!isVisible(i)) continue;
    if (i.type === 'search') return i;
  }
  // Last resort: first visible text input above the fold.
  for (const i of inputs) {
    if (!isVisible(i)) continue;
    if (i.type === 'text' || i.type === '' || i.type === 'search') {
      const r = i.getBoundingClientRect();
      if (r.top < 200) return i;
    }
  }
  return null;
}

function fireEnter(target: EventTarget) {
  const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, charCode: 13, bubbles: true, cancelable: true };
  target.dispatchEvent(new KeyboardEvent('keydown', opts));
  target.dispatchEvent(new KeyboardEvent('keypress', opts));
  target.dispatchEvent(new KeyboardEvent('keyup', opts));
}

function fireFullClick(target: Element) {
  target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
  target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }));
  if (typeof (target as HTMLElement).click === 'function') (target as HTMLElement).click();
  else target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
}

function findNearbySearchButton(input: HTMLElement): HTMLElement | null {
  // Look for a button-like element within the same form / row that probably submits search.
  const container = input.closest('form, [class*="search" i], header, nav, div');
  if (!container) return null;
  const buttons = Array.from(container.querySelectorAll<HTMLElement>('button, [role="button"], a'));
  for (const b of buttons) {
    if (b === input) continue;
    const t = (b.textContent || '').trim().toLowerCase();
    const aria = (b.getAttribute('aria-label') || '').toLowerCase();
    if (t === 'search' || aria === 'search' || aria.includes('submit search')) {
      if (isVisible(b)) return b;
    }
  }
  return null;
}

/** Fills the global search with an email and submits it every way KOHO's React form accepts. */
async function submitSearch(input: HTMLInputElement, email: string): Promise<void> {
  input.focus();
  await sleep(50);
  setValue(input, email);
  input.dispatchEvent(new InputEvent('input', { data: email, inputType: 'insertFromPaste', bubbles: true }));
  log('  → filled search with', email);

  // Let React's onChange settle before keystroke events. Koho's as-you-type may also
  // start querying here on its own, but we still want Enter to confirm.
  await sleep(300);

  log('  → firing Enter on input');
  input.focus();
  fireEnter(input);

  // Backup #1: requestSubmit on the parent form (fires the React submit handler).
  const form = input.closest('form');
  if (form) {
    log('  → calling form.requestSubmit()');
    try {
      if (typeof form.requestSubmit === 'function') form.requestSubmit();
      else form.submit();
    } catch (e) {
      log('  → form submit threw', e);
    }
  }

  // Backup #2: click a nearby Search button if one exists (icon-only search buttons
  // often have aria-label="Search" or "Submit search").
  const btn = findNearbySearchButton(input);
  if (btn) {
    log('  → clicking search button:', btn.tagName, btn.getAttribute('aria-label'));
    fireFullClick(btn);
  }
}

let searchRan = false;
async function tryEmailSearch(): Promise<boolean> {
  if (searchRan) return true;
  const res = await chrome.storage.local.get(PENDING_KEY);
  const email = res[PENDING_KEY];
  if (!email || typeof email !== 'string') return false;
  const input = findSearchInput();
  if (!input) return false;
  await submitSearch(input, email);
  searchRan = true;
  try { await chrome.storage.local.remove(PENDING_KEY); } catch { /* fine */ }
  return true;
}

async function bootstrap() {
  // Poll for up to ~30s — admin.koho.ca is an SPA, the search bar appears post-auth.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && !searchRan) {
    try { await tryEmailSearch(); } catch (e) { log('tick error', e); }
    if (searchRan) break;
    await sleep(500);
  }
}

// ----- The draft agent's "open this user" chain ----------------------------------------
// Started by a window message from the agent's own tab: SSO sign-in if KOHO asks for it, the
// search above, the user, then CST Transactions (Galileo). Carried in that tab's
// sessionStorage (the SSO round trip reloads the page); progress is published on <html>.

function isAgentTab(): boolean {
  try { return sessionStorage.getItem('wocoo-agent') === '1'; } catch { return false; }
}

function publishKoho(result: Omit<SiteResult, 'at'>): void {
  const full = { ...result, at: Date.now() };
  try { sessionStorage.setItem(AGENT_KOHO_RESULT_KEY, JSON.stringify(full)); } catch { /* fine */ }
  document.documentElement.setAttribute(AGENT_KOHO_RESULT_ATTR, JSON.stringify(full));
}

function saveKohoChain(chain: KohoChain | null): void {
  try {
    if (chain) sessionStorage.setItem(AGENT_KOHO_CHAIN_KEY, JSON.stringify({ ...chain }));
    else sessionStorage.removeItem(AGENT_KOHO_CHAIN_KEY);
  } catch { /* fine */ }
}

function setStep(chain: KohoChain, step: KohoChain['step'], extra: Partial<KohoChain> = {}): KohoChain {
  const next = { ...chain, ...extra, step, stepAt: Date.now() };
  saveKohoChain(next);
  publishKoho({ state: 'running', step });
  return next;
}

function stopKoho(reason: string): void {
  saveKohoChain(null);
  publishKoho({ state: 'stopped', reason });
}

/** A clickable element whose own text is exactly `text` (KOHO's sidebar uses role=button divs). */
function findByExactText(text: string): HTMLElement | null {
  const want = text.toLowerCase();
  const hits = Array.from(document.querySelectorAll<HTMLElement>('[role="button"], a, button, li, div, span'))
    .filter((el) => (el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase() === want);
  // The innermost match, preferring something clickable.
  const clickable = hits.find((el) => el.getAttribute('role') === 'button' || el.tagName === 'A' || el.tagName === 'BUTTON');
  return clickable ?? hits[hits.length - 1] ?? null;
}

function ssoButton(): HTMLElement | null {
  return Array.from(document.querySelectorAll<HTMLElement>('button, [role="button"], a'))
    .find((b) => /continue with sso/i.test((b.textContent || '').trim()) && isVisible(b)) ?? null;
}

let kohoStepRunning = false;
async function kohoChainStep(): Promise<'acted' | 'waiting' | 'finished'> {
  if (kohoStepRunning || !isAgentTab()) return 'finished';
  let chain = readKohoChain(sessionStorage.getItem(AGENT_KOHO_CHAIN_KEY), Date.now());
  if (!chain) return 'finished';
  kohoStepRunning = true;
  try {
    const since = Date.now() - (chain.stepAt ?? chain.startedAt);

    // Signed out: KOHO's sign-in screen (email + "Continue with SSO"). A live Okta session
    // brings the tab straight back; Okta asking for a password is the user's to do.
    const sso = ssoButton();
    if (sso) {
      if (!chain.ssoEmail) { stopKoho('KOHO wants SSO sign-in and no ssoEmail was given'); return 'finished'; }
      const tries = (chain.ssoTries ?? 0) + 1;
      if (tries > 2) { stopKoho('KOHO SSO sign-in did not stick (Okta may need a password)'); return 'finished'; }
      const emailInput = Array.from(document.querySelectorAll<HTMLInputElement>('input'))
        .find((i) => isVisible(i) && (i.type === 'email' || /email/i.test(i.name + i.placeholder + (i.getAttribute('aria-label') || ''))));
      if (emailInput) setValue(emailInput, chain.ssoEmail);
      chain = setStep(chain, 'search', { ssoTries: tries });
      await sleep(300);
      fireFullClick(sso);
      return 'acted';
    }

    if (chain.step === 'search' || chain.step === 'sso') {
      const input = findSearchInput();
      if (!input || !/accountid|search users|email/i.test(input.placeholder || '')) {
        if (since > 30_000) { stopKoho('KOHO search bar never appeared'); return 'finished'; }
        return 'waiting';
      }
      chain = setStep(chain, 'after-search');
      await submitSearch(input, chain.email);
      return 'acted';
    }

    if (chain.step === 'after-search') {
      if (kohoUserId(location.pathname)) { chain = setStep(chain, 'page'); return 'acted'; }
      if (since > 12_000) { stopKoho('the search did not open a single user; pick the right one from the results'); return 'finished'; }
      return 'waiting';
    }

    if (chain.step === 'page') {
      const link = findByExactText(KOHO_TRANSACTIONS_PAGE);
      if (link && isVisible(link)) {
        fireFullClick(link);
        await sleep(2_500);
        saveKohoChain(null);
        publishKoho({ state: 'done', step: 'page', reason: KOHO_TRANSACTIONS_PAGE, userId: kohoUserId(location.pathname) });
        return 'finished';
      }
      // The link sits in the collapsed "Transactions" group: open it, then look again.
      const group = findByExactText('Transactions');
      if (group && since < 15_000) { fireFullClick(group); await sleep(600); return 'acted'; }
      if (since > 15_000) {
        saveKohoChain(null);
        publishKoho({ state: 'done', step: 'user', reason: `on the user, but no "${KOHO_TRANSACTIONS_PAGE}" link found; open it from the sidebar`, userId: kohoUserId(location.pathname) });
        return 'finished';
      }
      return 'waiting';
    }
    return 'finished';
  } finally {
    kohoStepRunning = false;
  }
}

/** KOHO is an SPA: the chain moves through its steps without page loads, so keep stepping. */
async function runKohoChain(): Promise<void> {
  const end = Date.now() + 60_000;
  while (Date.now() < end) {
    const r = await kohoChainStep();
    if (r === 'finished') return;
    await sleep(r === 'acted' ? 1_200 : 500);
  }
}

window.addEventListener('message', (ev: MessageEvent) => {
  if (ev.source !== window || !isAgentTab()) return;
  const req = parseKohoRequest(ev.data);
  if (!req) return;
  if ('error' in req) { publishKoho({ state: 'stopped', reason: req.error }); return; }
  const now = Date.now();
  saveKohoChain({ email: req.email, ssoEmail: req.ssoEmail, startedAt: now, step: 'search', stepAt: now, ssoTries: 0 });
  publishKoho({ state: 'running', step: 'search' });
  void runKohoChain();
});

if (isAgentTab()) {
  try {
    const last = sessionStorage.getItem(AGENT_KOHO_RESULT_KEY);
    if (last) document.documentElement.setAttribute(AGENT_KOHO_RESULT_ATTR, last);
  } catch { /* fine */ }
  void runKohoChain();
}

bootstrap();
