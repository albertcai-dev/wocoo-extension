export {}; // Module-scoped so helpers don't collide with other content scripts.

// Content script for admin.koho.ca — pastes the staged client email into the global
// "search Users" bar at the top of the dashboard and submits with Enter.
//
// The side panel writes pending_koho_email to chrome.storage.local just before opening
// admin.koho.ca; this script reads, fills, submits, and clears the key.

console.log('[wocoo-koho] content script loaded on', location.href);

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

let searchRan = false;
async function tryEmailSearch(): Promise<boolean> {
  if (searchRan) return true;
  const res = await chrome.storage.local.get(PENDING_KEY);
  const email = res[PENDING_KEY];
  if (!email || typeof email !== 'string') return false;
  const input = findSearchInput();
  if (!input) return false;

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

bootstrap();
