// Atlas auto-Submit content script.
//
// Atlas (`atlas.wealthsimple.com`) shows an access-reason dialog every time an associate
// opens a client profile. When the URL contains a `?ticketId=WOCOO-NNNNN` parameter, Atlas
// pre-fills the Ticket # input from that param. This script auto-clicks the Submit button
// in that case, removing the manual confirmation step.
//
// SAFETY GATES (all must be true before we click):
//   1. URL has a `ticketId=WOCOO-N` query parameter — signals a context-driven nav from the
//      WOCOO extension/site (not an ad-hoc Atlas browse).
//   2. The "Please log the reason" dialog is actually in the DOM.
//   3. The Ticket # input has a non-empty value matching our ticketId.
//   4. A Submit button is present and not disabled.
//   5. We've only clicked ONCE per page load (no loops).
//
// If any gate fails, we leave the dialog alone so the agent can interact manually.

(function () {
  const url = new URL(location.href);
  const ticketId = url.searchParams.get('ticketId');
  if (!ticketId || !/^WOCOO-\d+$/.test(ticketId)) {
    // No WOCOO context → don't touch the dialog.
    return;
  }

  let fired = false;
  let givenUp = false;

  // Title text on the dialog. Substring-tolerant so minor copy edits don't break us.
  const DIALOG_TITLE_FRAGMENT = 'log the reason';

  function tryAutoSubmit(): boolean {
    if (fired) return true;

    // Find the dialog by its identifying title text.
    const dialogTitle = Array.from(document.querySelectorAll('*')).find((el) => {
      // Only look at direct text content of element (not deep descendants) to avoid
      // matching the wrapper that contains everything on the page.
      const text = (el.textContent || '').trim();
      if (!text.includes(DIALOG_TITLE_FRAGMENT)) return false;
      // Filter to elements that are short — long matches are usually outer wrappers.
      return text.length < 500;
    });
    if (!dialogTitle) return false;

    // The dialog's "scope" is the dialog root — climb up until we find a dialog-like ancestor
    // (role=dialog or class containing 'modal'/'dialog'), or just use the immediate parent area.
    let dialogRoot: HTMLElement = dialogTitle as HTMLElement;
    for (let i = 0; i < 10 && dialogRoot.parentElement; i++) {
      const role = dialogRoot.getAttribute('role') || '';
      const cls = dialogRoot.className || '';
      if (role === 'dialog' || /modal|dialog/i.test(typeof cls === 'string' ? cls : '')) break;
      dialogRoot = dialogRoot.parentElement;
    }

    // Find the Ticket # input within the dialog and confirm it's populated with the same ticket.
    const inputs = Array.from(dialogRoot.querySelectorAll<HTMLInputElement>('input'));
    const ticketInput = inputs.find((i) => (i.value || '').trim() === ticketId);
    if (!ticketInput) return false;

    // Find the Submit button. Try clear semantics first; fall back to text-content match.
    const buttons = Array.from(dialogRoot.querySelectorAll<HTMLButtonElement>('button'));
    const submitBtn = buttons.find((b) => {
      if (b.disabled) return false;
      const t = (b.textContent || '').trim().toLowerCase();
      return t === 'submit';
    });
    if (!submitBtn) return false;

    fired = true;
    // Give the form a beat to settle (some forms react to focus/blur on submit-eligible state).
    setTimeout(() => {
      submitBtn.click();
      console.debug('[WOCOO Triager] auto-submitted Atlas reason for', ticketId);
    }, 250);
    return true;
  }

  // First, try once immediately in case the dialog is already in the DOM.
  if (tryAutoSubmit()) return;

  // Otherwise, observe for the dialog appearing.
  const observer = new MutationObserver(() => {
    if (fired || givenUp) {
      observer.disconnect();
      return;
    }
    tryAutoSubmit();
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // Give up after 10 seconds — if the dialog hasn't appeared by then it probably isn't going to.
  setTimeout(() => {
    givenUp = true;
    observer.disconnect();
  }, 10_000);
})();

// =============================================================================
// Account-number lookup (W#)
//
// Triggered when the side panel writes `pending_atlas_account_lookup: {sourceTicketId}`
// to chrome.storage.local just before opening Atlas. The chain:
//   1. Wait for the identity page to render (sidebar with account list).
//   2. Find and click the "CHEQUING (SPEND)" item in the sidebar.
//   3. Wait for Portfolio Details to update with that account's Account Number.
//   4. Read the value (e.g. "WK5FB2Q33CAD") and write it to `atlas_account_number`.
//   5. Clear the pending lookup flag.
// =============================================================================

(function accountNumberLookup() {
  const isVisible = (el: HTMLElement) => {
    if (!el) return false;
    if (el.offsetParent === null && getComputedStyle(el).position !== 'fixed') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  const log = (msg: string, ...args: unknown[]) => console.log('[wocoo-atlas]', msg, ...args);

  let spendClickedRan = false;
  let accountNumberWrittenRan = false;
  let spendClickedAt = 0;

  function findSpendSidebarItem(): HTMLElement | null {
    // Look for any element whose own (direct) text content includes "CHEQUING (SPEND)".
    // Atlas renders the sidebar item title in one span and the friendly name "(Personal
    // Main )" below it, both inside a clickable parent.
    const candidates = Array.from(document.querySelectorAll<HTMLElement>('*'));
    for (const el of candidates) {
      const ownText = Array.from(el.childNodes)
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => (n as Text).textContent || '')
        .join(' ')
        .trim();
      if (!/CHEQUING\s*\(\s*SPEND\s*\)/i.test(ownText)) continue;
      if (!isVisible(el)) continue;
      // Climb up to the nearest clickable ancestor (button, a, role=button, or li).
      let target: HTMLElement | null = el;
      while (target && target !== document.body) {
        if (
          target.tagName === 'A' ||
          target.tagName === 'BUTTON' ||
          target.tagName === 'LI' ||
          target.getAttribute('role') === 'button'
        ) {
          return target;
        }
        target = target.parentElement;
      }
      // Fallback: just click the element itself (its click handler may bubble).
      return el;
    }
    return null;
  }

  // SPEND account numbers on Atlas are always W-prefixed and CAD-suffixed (e.g.
  // WK7NGMW38CAD). The customer's main account is C-prefixed (C14YKGL23CAD) and shows
  // up in other sections of the page — we must NOT capture that one even if it appears
  // adjacent to an "Account Number" label.
  const SPEND_ACCOUNT_RE = /^W[A-Z0-9]+CAD$/i;

  function readAccountNumberFromPortfolioDetails(): string | null {
    const labels = Array.from(document.querySelectorAll<HTMLElement>('*'));
    for (const el of labels) {
      const own = Array.from(el.childNodes)
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => (n as Text).textContent || '')
        .join(' ')
        .trim();
      if (!/^Account\s*Number\s*:?\s*$/i.test(own)) continue;
      const parent = el.parentElement;
      if (!parent) continue;
      for (const sib of Array.from(parent.children)) {
        if (sib === el) continue;
        const t = (sib.textContent || '').trim();
        if (SPEND_ACCOUNT_RE.test(t)) return t;
      }
      let next = el.nextElementSibling;
      while (next) {
        const t = (next.textContent || '').trim();
        if (SPEND_ACCOUNT_RE.test(t)) return t;
        next = next.nextElementSibling;
      }
    }
    return null;
  }

  // Tier values we recognize. Atlas's "INDIVIDUAL TIERS > Status" cell uses these exact
  // strings (matching the REIMB tier IDs the rest of the extension uses).
  const TIER_VALUE_RE = /^(Core|Premium|Generation)$/i;

  // The page has two adjacent sections: "TIERS" and "INDIVIDUAL TIERS", each with a
  // "Status" row. We specifically want the INDIVIDUAL TIERS one (per request), so we
  // walk the DOM in document order, ignore everything until we hit the "INDIVIDUAL
  // TIERS" header, then capture the next "Status: <tier>" pair after it.
  function readIndividualTierStatus(): string | null {
    const all = Array.from(document.querySelectorAll<HTMLElement>('*'));
    let pastIndividualTiersHeader = false;
    for (const el of all) {
      const own = Array.from(el.childNodes)
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => (n as Text).textContent || '')
        .join(' ')
        .trim();
      if (!pastIndividualTiersHeader) {
        if (/^INDIVIDUAL\s+TIERS\s*$/i.test(own)) pastIndividualTiersHeader = true;
        continue;
      }
      if (!/^Status\s*:?\s*$/i.test(own)) continue;
      // Found the Status label inside INDIVIDUAL TIERS. Walk siblings for the value.
      const parent = el.parentElement;
      if (parent) {
        for (const sib of Array.from(parent.children)) {
          if (sib === el) continue;
          const t = (sib.textContent || '').trim();
          if (TIER_VALUE_RE.test(t)) return capitalizeFirst(t);
        }
      }
      let next = el.nextElementSibling;
      while (next) {
        const t = (next.textContent || '').trim();
        if (TIER_VALUE_RE.test(t)) return capitalizeFirst(t);
        next = next.nextElementSibling;
      }
      // Status row found but no recognizable tier value adjacent — stop, don't keep
      // scanning forward (we'd risk picking up a tier value from a later section).
      return null;
    }
    return null;
  }

  function capitalizeFirst(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
  }

  async function tick() {
    if (accountNumberWrittenRan) return;
    const res = await chrome.storage.local.get('pending_atlas_account_lookup');
    const ctx = res.pending_atlas_account_lookup as { sourceTicketId?: string } | undefined;
    if (!ctx) return;

    // Step 1: click "CHEQUING (SPEND)" if we haven't yet.
    if (!spendClickedRan) {
      const item = findSpendSidebarItem();
      if (!item) return;
      log('clicking CHEQUING (SPEND) sidebar item');
      spendClickedRan = true;
      spendClickedAt = Date.now();
      try { item.click(); } catch { /* fine */ }
      return;
    }

    // Step 2: after the click, wait a beat for Portfolio Details to render, then read.
    // Allow some retries — the value may appear a few hundred ms after the click.
    if (Date.now() - spendClickedAt < 250) return; // brief settle
    const value = readAccountNumberFromPortfolioDetails();
    if (!value) return;

    // Best-effort: also scrape the INDIVIDUAL TIERS > Status field while we're on the
    // page. May be null for clients without an Individual Tiers row — that's fine,
    // we still emit the account number.
    const individualTierStatus = readIndividualTierStatus();

    log('captured Account Number:', value, 'tier:', individualTierStatus, 'for', ctx.sourceTicketId);
    await chrome.storage.local.set({
      atlas_account_number: {
        sourceTicketId: ctx.sourceTicketId || '',
        accountNumber: value,
        individualTierStatus,
        capturedAt: new Date().toISOString(),
      },
    });
    try { await chrome.storage.local.remove('pending_atlas_account_lookup'); } catch { /* fine */ }
    accountNumberWrittenRan = true;
  }

  // Poll every 400ms for up to ~30s. Identity page sidebar can take a couple seconds
  // to render after the access dialog is dismissed.
  const deadline = Date.now() + 30_000;
  const interval = window.setInterval(() => {
    if (Date.now() > deadline || accountNumberWrittenRan) {
      window.clearInterval(interval);
      return;
    }
    void tick();
  }, 400);
  // Also try once immediately in case the page is already in the right state.
  void tick();
})();

// =============================================================================
// Client-email lookup — scrape the "Email" row from the identity homepage sidebar.
// Triggered when the side panel writes `pending_atlas_client_email_lookup:
// {sourceTicketId}` to chrome.storage.local. Unlike the account-number lookup, no
// click is required — the email is rendered directly on the overview page.
// =============================================================================

(function clientEmailLookup() {
  const isVisible = (el: HTMLElement) => {
    if (!el) return false;
    if (el.offsetParent === null && getComputedStyle(el).position !== 'fixed') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  const log = (msg: string, ...args: unknown[]) => console.log('[wocoo-atlas-email]', msg, ...args);

  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  let emailWrittenRan = false;

  function readEmailFromSidebar(): string | null {
    const all = Array.from(document.querySelectorAll<HTMLElement>('*'));
    for (const el of all) {
      const own = Array.from(el.childNodes)
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => (n as Text).textContent || '')
        .join(' ')
        .trim();
      if (!/^Email\s*:?\s*$/i.test(own)) continue;
      if (!isVisible(el)) continue;
      const parent = el.parentElement;
      if (parent) {
        for (const sib of Array.from(parent.children)) {
          if (sib === el) continue;
          const t = (sib.textContent || '').trim();
          if (EMAIL_RE.test(t)) return t;
        }
      }
      let next = el.nextElementSibling;
      while (next) {
        const t = (next.textContent || '').trim();
        if (EMAIL_RE.test(t)) return t;
        next = next.nextElementSibling;
      }
    }
    return null;
  }

  async function tick() {
    if (emailWrittenRan) return;
    const res = await chrome.storage.local.get('pending_atlas_client_email_lookup');
    const ctx = res.pending_atlas_client_email_lookup as { sourceTicketId?: string } | undefined;
    if (!ctx) return;

    const email = readEmailFromSidebar();
    if (!email) return;

    log('captured Email:', email, 'for', ctx.sourceTicketId);
    await chrome.storage.local.set({
      atlas_client_email: {
        sourceTicketId: ctx.sourceTicketId || '',
        email,
        capturedAt: new Date().toISOString(),
      },
    });
    try { await chrome.storage.local.remove('pending_atlas_client_email_lookup'); } catch { /* fine */ }
    emailWrittenRan = true;
  }

  // Poll every 400ms for up to ~30s. Identity page sidebar can take a couple seconds
  // to render after the access dialog is dismissed.
  const deadline = Date.now() + 30_000;
  const interval = window.setInterval(() => {
    if (Date.now() > deadline || emailWrittenRan) {
      window.clearInterval(interval);
      return;
    }
    void tick();
  }, 400);
  void tick();
})();

// =============================================================================
// Login auto-click — when the user lands on atlas.wealthsimple.com/login (typically
// because the extension opened Atlas after their Okta session expired), find the
// "Login With Okta" button and click it. Clicking only initiates SSO; the only path
// to auth from /login is this button, so auto-clicking saves the manual click without
// taking any destructive action.
//
// SAFETY GATES (all must be true):
//   1. Pathname starts with /login.
//   2. A visible, non-disabled button whose own text reads "Login With Okta" (case-
//      insensitive, substring-tolerant) is present.
//   3. We click ONCE per page load.
// =============================================================================

(function loginAutoClick() {
  if (!/^\/login(\/|$)/.test(location.pathname)) return;

  let loginFired = false;
  let loginGivenUp = false;

  const BUTTON_TEXT_FRAGMENT = 'login with okta';

  function isElementVisible(el: HTMLElement): boolean {
    if (!el) return false;
    if (el.offsetParent === null && getComputedStyle(el).position !== 'fixed') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function normalize(s: string): string {
    return s.replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function findLoginButton(): HTMLElement | null {
    // Cast wider than just <button>: some auth-pages wrap their CTAs in <div role="button">
    // or even plain <div>s with click handlers. Match on element OWN text (not bubbled)
    // to avoid matching the page-level wrapper that contains the heading + everything.
    const candidates = Array.from(document.querySelectorAll<HTMLElement>(
      'button, a, [role="button"], [tabindex], div, span',
    ));
    for (const el of candidates) {
      if ((el as HTMLButtonElement).disabled) continue;
      if (!isElementVisible(el)) continue;
      const ownText = Array.from(el.childNodes)
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => (n as Text).textContent || '')
        .join(' ');
      const direct = normalize(ownText);
      if (direct.includes(BUTTON_TEXT_FRAGMENT)) return el;
      // Also accept elements whose full bubbled text exactly matches the fragment —
      // catches cases like <button><span>Login With Okta</span></button>.
      const bubbled = normalize(el.textContent || '');
      if (bubbled === BUTTON_TEXT_FRAGMENT && (el.tagName === 'BUTTON' || el.tagName === 'A' || el.getAttribute('role') === 'button')) {
        return el;
      }
    }
    return null;
  }

  function tryClickLogin(): boolean {
    if (loginFired) return true;
    const target = findLoginButton();
    if (!target) return false;
    loginFired = true;
    console.debug('[wocoo-atlas] found Login With Okta button:', target.tagName, target.className);
    // Brief settle so any focus/blur form state lands first.
    setTimeout(() => {
      target.click();
      console.debug('[wocoo-atlas] auto-clicked Login With Okta');
    }, 150);
    return true;
  }

  if (tryClickLogin()) return;

  const observer = new MutationObserver(() => {
    if (loginFired || loginGivenUp) {
      observer.disconnect();
      return;
    }
    tryClickLogin();
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // Give up after 10s — if the button hasn't rendered by then it isn't going to.
  setTimeout(() => {
    loginGivenUp = true;
    observer.disconnect();
  }, 10_000);
})();
