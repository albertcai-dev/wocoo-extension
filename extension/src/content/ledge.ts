// Ledge content script — drives ledge.wealthsimple.com/account-inquiry for the Wires
// Pending Posting assistant. Queue-driven: the side panel writes one verify job at a
// time to chrome.storage.local; this script picks it up, drives the DOM (New Search →
// Search by Account Number → Transactions tab → scan rows), and writes the result back.
//
// Selectors are intentionally text-based (label/button text) rather than CSS classes —
// Ledge's class names look like build hashes and would break on every redeploy. If the
// page DOM changes, log() output is the first place to look.

export {}; // module scope

// Tab role is encoded in the URL hash so the side panel can run two Ledge tabs in
// parallel (one top→bottom, one bottom→top). Each tab uses its own storage-key
// namespace. Defaults to 'top' for backward compat / manually-opened tabs.
const ROLE = /(^|#)wocoo-bottom\b/i.test(location.hash) ? 'bottom' : 'top';
const PENDING_KEY  = `pending_ledge_verify_${ROLE}`;
const RESULT_KEY   = `ledge_verify_result_${ROLE}`;
const PROGRESS_KEY = `ledge_in_progress_${ROLE}`;

interface VerifyJob {
  jobId: string;
  accountNumber: string;  // e.g. "WK4ZPQ832USD" — the W# we look up directly
  amount: number;         // expected wire-in amount, e.g. 39986.49
  currency: string;       // "USD" / "CAD" — informational; main check is amount
  expectedSource?: string; // optional: original sheet row number, just echoed back
  /** Sheet column A wire_timestamp (display text). Used to widen Ledge's From-date
   *  filter when the wire predates the default window. Empty string = skip widening. */
  wireTimestamp?: string;
}

interface VerifyResult {
  jobId: string;
  matched: boolean;
  reason?: string;
  matchedTransaction?: { effectiveDate: string; description: string; amount: number };
  accountNumberSeen?: string;
}

function log(msg: string, ...args: unknown[]) {
  console.log('[wocoo-ledge]', msg, ...args);
}

// ----- DOM utilities -----

function isVisible(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return false;
  const cs = window.getComputedStyle(el);
  return cs.visibility !== 'hidden' && cs.display !== 'none';
}

/** Find a visible clickable element whose visible text matches `text`. Searches in
 *  three passes, widening the candidate set each time so common cases (buttons) are
 *  cheap but tab-like elements (role="tab", styled divs) are still reachable. */
function findClickableByText(text: string): HTMLElement | null {
  const target = text.trim().toLowerCase();

  // Pass 1: standard clickable roles, exact match.
  const standard = Array.from(document.querySelectorAll<HTMLElement>(
    'button, a, [role="button"], [role="tab"], [role="link"], [role="menuitem"], input[type="button"], input[type="submit"]',
  ));
  for (const el of standard) {
    if (!isVisible(el)) continue;
    const txt = (el.innerText || el.getAttribute('value') || '').trim().toLowerCase();
    if (txt === target) return el;
  }
  // Pass 2: substring match on the same set.
  for (const el of standard) {
    if (!isVisible(el)) continue;
    const txt = (el.innerText || '').trim().toLowerCase();
    if (txt && txt.includes(target)) return el;
  }
  // Pass 3: any visible element with exact text whose computed cursor is "pointer" —
  // catches tab-ish things rendered as plain <div>/<span> with onClick (cursor:pointer
  // is the conventional signal that something is clickable).
  const all = Array.from(document.querySelectorAll<HTMLElement>('*'));
  for (const el of all) {
    if (!isVisible(el)) continue;
    const txt = (el.innerText || '').trim().toLowerCase();
    if (txt !== target) continue;
    const cs = window.getComputedStyle(el);
    if (cs.cursor === 'pointer') return el;
  }
  return null;
}

/** Click an element with a full mouse-event sequence — some libraries (Mantine, MUI,
 *  Headless UI tabs) listen on mousedown/pointerdown rather than click. */
function robustClick(el: HTMLElement) {
  const opts: MouseEventInit = { bubbles: true, cancelable: true, view: window };
  try { el.dispatchEvent(new PointerEvent('pointerdown', opts as PointerEventInit)); } catch { /* fine */ }
  el.dispatchEvent(new MouseEvent('mousedown', opts));
  try { el.dispatchEvent(new PointerEvent('pointerup', opts as PointerEventInit)); } catch { /* fine */ }
  el.dispatchEvent(new MouseEvent('mouseup', opts));
  el.click();
}

/** Find a visible input near a label whose text matches. Searches by `<label for>` first,
 *  then by walking up the label parent and finding the next input. */
function findInputByLabel(labelText: string): HTMLInputElement | null {
  const target = labelText.trim().toLowerCase();
  const labels = Array.from(document.querySelectorAll<HTMLElement>('label'));
  for (const lbl of labels) {
    const txt = (lbl.innerText || '').trim().toLowerCase();
    if (txt !== target && !txt.includes(target)) continue;
    if (!isVisible(lbl)) continue;
    const forAttr = lbl.getAttribute('for');
    if (forAttr) {
      const byFor = document.getElementById(forAttr) as HTMLInputElement | null;
      if (byFor && isVisible(byFor)) return byFor;
    }
    // Walk up to a sensible container, then find the next input.
    let container: HTMLElement | null = lbl;
    for (let i = 0; i < 5 && container; i++) {
      const input = container.querySelector<HTMLInputElement>('input[type="text"], input:not([type])');
      if (input && isVisible(input)) return input;
      container = container.parentElement;
    }
  }
  return null;
}

function setInputValue(el: HTMLInputElement, value: string) {
  // React-controlled inputs: setting .value directly doesn't trigger onChange. Use the
  // native setter and dispatch an input event, same trick we use in i2c.ts.
  const proto = Object.getPrototypeOf(el);
  const desc = Object.getOwnPropertyDescriptor(proto, 'value');
  if (desc && desc.set) desc.set.call(el, value); else el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Poll until predicate returns a truthy value, or timeout. */
async function waitFor<T>(predicate: () => T | null | false, timeoutMs = 10_000, intervalMs = 200): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = predicate();
    if (v) return v as T;
    await delay(intervalMs);
  }
  return null;
}

// ----- domain ops -----

/** Look for the toolbar search icon (the magnifying glass next to the hamburger menu).
 *  No reliable text label, so we look for buttons whose only visible child is an SVG
 *  and whose aria-label/title hints at search. */
function findSearchIconButton(): HTMLElement | null {
  const candidates = Array.from(document.querySelectorAll<HTMLElement>('button, [role="button"]'));
  for (const btn of candidates) {
    if (!isVisible(btn)) continue;
    const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
    const title = (btn.getAttribute('title') || '').toLowerCase();
    if (aria.includes('search') || title.includes('search')) return btn;
    // Heuristic: an icon-only button (no text, has an SVG child).
    const text = (btn.innerText || '').trim();
    const hasSvg = !!btn.querySelector('svg');
    if (text === '' && hasSvg) {
      // Use position — search icon is typically in the top-left of the toolbar.
      const r = btn.getBoundingClientRect();
      if (r.top < 80 && r.left < 250) return btn;
    }
  }
  return null;
}

/** Open the search modal. Tries (in order): already open → "New Search" button →
 *  toolbar magnifying-glass icon → "/" keyboard shortcut.
 *
 *  Waits up to 20s for an entry-point to appear before attempting a click — on a
 *  fresh tab, Ledge takes a few seconds to hydrate and the first job in the batch
 *  used to lose the race and fail with "Search modal could not be opened". */
async function ensureSearchModalOpen(): Promise<boolean> {
  const modalCanary = () => findClickableByText('Search by Account Number');
  if (modalCanary()) { log('Search modal already open'); return true; }

  const entryReady = await waitFor(
    () => findClickableByText('New Search') || findSearchIconButton(),
    20_000,
  );
  if (!entryReady) log('No search entry-point (New Search / icon) appeared within 20s — falling through to keyboard shortcut');

  const newSearch = findClickableByText('New Search');
  if (newSearch) {
    log('Clicking New Search button');
    robustClick(newSearch);
    const open = await waitFor(modalCanary, 5_000);
    if (open) return true;
  }

  const searchIcon = findSearchIconButton();
  if (searchIcon) {
    log('Clicking search-icon button', { aria: searchIcon.getAttribute('aria-label'), pos: searchIcon.getBoundingClientRect() });
    robustClick(searchIcon);
    const open = await waitFor(modalCanary, 5_000);
    if (open) return true;
  }

  log('Trying "/" keyboard shortcut');
  document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '/', code: 'Slash', bubbles: true }));
  const open = await waitFor(modalCanary, 3_000);
  return !!open;
}

/** Has the Account view loaded? */
function isAccountViewLoaded(accountNumber: string): boolean | 'not_found' {
  // Modal still open → not done yet.
  if (findClickableByText('Search by Account Number')) {
    const text = (document.body.innerText || '').toLowerCase();
    if (/no.{0,5}(account|results|matching)\s+found/i.test(text) ||
        /account\s+number\s+not\s+found/i.test(text)) {
      return 'not_found';
    }
    return false;
  }
  // Substring check on the full body text — covers any rendering of the W# (dropdown
  // with caret suffix, breadcrumb, field value, etc.). Much more robust than exact
  // innerText matching on individual elements.
  const bodyText = (document.body.innerText || '').toUpperCase();
  if (bodyText.includes(accountNumber.toUpperCase())) return true;
  // Fallback: page transitioned to an Account view with the Transactions tab visible.
  if (/\bTransactions\b/.test(document.body.innerText || '')) return true;
  return false;
}

/** Fill the Account Number input and click "Search by Account Number". */
async function searchByAccountNumber(accountNumber: string): Promise<boolean> {
  const ok = await ensureSearchModalOpen();
  if (!ok) throw new Error('Search modal could not be opened');

  const input = findInputByLabel('Account Number');
  if (!input) throw new Error('Account Number input not found');
  log('Filling Account Number input', accountNumber);
  setInputValue(input, accountNumber);
  // Give React/the controlled-input wrapper a tick to register the value before submit.
  await delay(300);
  // Press Enter as a fallback path.
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));

  const btn = findClickableByText('Search by Account Number');
  if (btn) {
    log('Clicking Search by Account Number');
    robustClick(btn);
  } else log('Note: Search-by-Account-Number button not found, relying on Enter-key.');

  // Wait for the search modal to close + the Account view to render. 25s gives Ledge
  // ample time on a slow connection.
  const result = await waitFor(() => {
    const r = isAccountViewLoaded(accountNumber);
    return r === false ? null : r; // truthy values returned, false → keep polling
  }, 25_000);
  if (result === 'not_found') throw new Error(`Ledge reports account "${accountNumber}" not found`);
  return result === true;
}

/** Normalize header text — collapses internal whitespace (Ledge wraps "Effective Date"
 *  across two lines, which makes innerText "Effective\nDate"). */
function normalizeHeader(s: string): string {
  return (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Click the Transactions tab and wait for the "N Transaction(s) loaded" status text
 *  Ledge shows after the table renders. Returns:
 *    - { kind: 'empty' }   when N === 0 (legitimate "wire not yet posted")
 *    - { kind: 'table', table }   when N > 0 and a table-shaped element is found
 *    - null when the tab click never produced the status text
 */
type TableResult =
  | { kind: 'empty' }
  | { kind: 'table'; totalCount: number };

async function openTransactionsTab(expectedAccount: string): Promise<TableResult | null> {
  const tab = findClickableByText('Transactions');
  if (!tab) throw new Error('Transactions tab not found');
  log('Clicking Transactions tab', { tag: tab.tagName, role: tab.getAttribute('role') });
  robustClick(tab);

  const expected = expectedAccount.toUpperCase();
  const displayedMatchesExpected = () => {
    const bodyText = (document.body.innerText || '').toUpperCase();
    if (bodyText.includes(expected)) return true;
    const inputs = Array.from(document.querySelectorAll<HTMLInputElement>('input'));
    for (const input of inputs) {
      if (input.value && input.value.toUpperCase().includes(expected)) return true;
    }
    return false;
  };
  // Small grace delay after the tab click — covers the ~500ms transition window where
  // Ledge tears down the previous account's render before drawing the new one.
  await delay(800);

  // Wait for Ledge's own "N Transaction(s) loaded" status text AND for the displayed
  // account to match the expected W#. Once we have both, we know which row count to
  // trust. (We don't try to parse a table container — Ledge uses Vaadin Grid, which
  // doesn't expose anything queryable. The body text scan in findMatchingWireInBodyText
  // handles row scanning instead.)
  const statusRe = /([\d,]+)\s+Transaction(?:\(s\)|s)?\s+loaded/i;
  let polls = 0;
  return await waitFor((): TableResult | null => {
    polls++;
    const text = document.body.innerText || '';
    const m = text.match(statusRe);
    const acctMatch = displayedMatchesExpected();
    if (polls % 15 === 1) log('Polling', { polls, acctMatch, statusFound: !!m, statusText: m ? m[0] : null });
    if (!acctMatch) return null;
    if (!m) return null;
    const n = parseInt(m[1].replace(/,/g, ''), 10);
    if (!isFinite(n)) return null;
    if (n === 0) return { kind: 'empty' };
    return { kind: 'table', totalCount: n };
  }, 35_000);
}

// ----- date helpers (used by the From-date widening logic) -----

/** Parse a sheet's wire_timestamp display text into a Date. Accepts common formats:
 *  "5/29/2026", "5/29/26", "May 29, 2026", "2026-05-29". Returns null on failure. */
function parseWireDate(s: string): Date | null {
  if (!s) return null;
  const trimmed = s.trim();
  // ISO "YYYY-MM-DD"
  let m = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return isNaN(d.getTime()) ? null : d;
  }
  // "M/D/YYYY" or "M/D/YY"
  m = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) {
    let year = Number(m[3]);
    if (year < 100) year += 2000;
    const d = new Date(year, Number(m[1]) - 1, Number(m[2]));
    return isNaN(d.getTime()) ? null : d;
  }
  // Fall back to Date.parse (handles "May 29, 2026" etc.)
  const parsed = new Date(trimmed);
  return isNaN(parsed.getTime()) ? null : parsed;
}

/** Format a Date as "YYYY-MM-DD" (the format Ledge's date input accepts). */
function formatYMD(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Find Ledge's "From" date input by label proximity. Vaadin date pickers expose an
 *  inner <input> in the light DOM; we target that. */
function findFromDateInput(): HTMLInputElement | null {
  // Prefer findInputByLabel (already covers <label>-based pairings).
  const byLabel = findInputByLabel('From');
  if (byLabel) return byLabel;
  // Fallback: any vaadin-date-picker on the page whose inner input value is YYYY-MM-DD.
  const pickers = Array.from(document.querySelectorAll<HTMLElement>('vaadin-date-picker'));
  for (const p of pickers) {
    const input = p.querySelector<HTMLInputElement>('input');
    if (input && isVisible(input) && /^\d{4}-\d{2}-\d{2}$/.test(input.value || '')) return input;
  }
  return null;
}

/** If the wire's date predates Ledge's current From-date filter, widen the filter to
 *  one day before the wire and click Refresh. After Refresh, the "Data Refreshed at"
 *  timestamp changes, so we wait on that as the readiness signal. No-op if the wire
 *  is already within range. */
async function maybeWidenFromDate(wireTimestamp: string | undefined): Promise<void> {
  if (!wireTimestamp) return;
  const wireDate = parseWireDate(wireTimestamp);
  if (!wireDate) {
    log('Could not parse wire_timestamp', wireTimestamp);
    return;
  }
  const fromInput = findFromDateInput();
  if (!fromInput) {
    log('From-date input not found — skipping widening');
    return;
  }
  const currentFromStr = (fromInput.value || '').trim();
  const currentFrom = parseWireDate(currentFromStr);
  if (!currentFrom) {
    log('Could not parse current From value', currentFromStr);
    return;
  }
  // Compare days at local midnight to ignore time-of-day noise.
  const wireMidnight = new Date(wireDate.getFullYear(), wireDate.getMonth(), wireDate.getDate());
  if (wireMidnight >= currentFrom) {
    log('Wire is within current From range, no widening needed', { wireTimestamp, currentFromStr });
    return;
  }
  // Set From = wire_date - 1 day.
  const newFrom = new Date(wireMidnight);
  newFrom.setDate(newFrom.getDate() - 1);
  const newFromStr = formatYMD(newFrom);
  log('Widening From date', { currentFromStr, newFromStr });

  // Capture the current "Data Refreshed at" stamp so we can detect when the new data lands.
  const refreshStampRe = /Data\s+Refreshed\s+at\s+([\w :,-]+)/i;
  const prevStamp = (document.body.innerText || '').match(refreshStampRe)?.[1] ?? null;

  setInputValue(fromInput, newFromStr);
  // Also commit via Enter — some Vaadin date pickers only persist on Enter/blur.
  fromInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
  fromInput.dispatchEvent(new Event('change', { bubbles: true }));
  fromInput.blur();

  const refresh = findClickableByText('Refresh');
  if (refresh) {
    log('Clicking Refresh');
    robustClick(refresh);
  } else {
    log('Refresh button not found — relying on date input commit');
  }

  // Wait for the "Data Refreshed at" timestamp to change.
  const updated = await waitFor(() => {
    const cur = (document.body.innerText || '').match(refreshStampRe)?.[1] ?? null;
    return cur && cur !== prevStamp ? cur : null;
  }, 20_000);
  if (updated) log('Data refreshed at', updated);
  else log('No "Data Refreshed at" timestamp change detected within 20s');
}

/** Account-number pattern. Ledge uses several prefixes:
 *   - Wealthsimple W-accounts: WK..., WH..., WX...   (8+ alnum chars)
 *   - Apex: AP... (8+ alnum chars)
 *   - Holding-co: HQ...
 *  Conservative: 2-letter prefix followed by 6+ alphanumeric chars. */
const ACCOUNT_NUMBER_RE = /^[A-Z]{2}[0-9A-Z]{6,}$/i;

/** Read the currently-displayed account number from the top-of-page dropdown, if any. */
function readDisplayedAccountNumber(): string | null {
  const all = Array.from(document.querySelectorAll<HTMLElement>('button, div, span'));
  for (const el of all) {
    if (!isVisible(el)) continue;
    const txt = (el.innerText || '').trim();
    if (ACCOUNT_NUMBER_RE.test(txt)) return txt;
  }
  return null;
}

// ----- queue loop -----

async function processJob(job: VerifyJob): Promise<VerifyResult> {
  log('processJob', job);
  try {
    const ready = await searchByAccountNumber(job.accountNumber);
    if (!ready) {
      return { jobId: job.jobId, matched: false, reason: 'Account search did not surface Transactions tab in time' };
    }
    let result = await openTransactionsTab(job.accountNumber);
    const accountSeen = readDisplayedAccountNumber() || undefined;

    if (!result) {
      return { jobId: job.jobId, matched: false, reason: 'Transactions tab opened but "N Transaction(s) loaded" status never appeared' };
    }

    // If the wire predates Ledge's default From-date, widen the filter + Refresh, then
    // re-poll for the updated status text. Skip on 'empty' too — an empty default may
    // become non-empty after widening.
    await maybeWidenFromDate(job.wireTimestamp);
    // Re-read the count (no-op if From wasn't changed; updated if it was).
    const statusRe = /([\d,]+)\s+Transaction(?:\(s\)|s)?\s+loaded/i;
    const afterText = document.body.innerText || '';
    const afterMatch = afterText.match(statusRe);
    if (afterMatch) {
      const n2 = parseInt(afterMatch[1].replace(/,/g, ''), 10);
      if (isFinite(n2)) {
        result = n2 === 0 ? { kind: 'empty' } : { kind: 'table', totalCount: n2 };
      }
    }

    // 0 transactions loaded → clean "wire not yet posted" outcome. Sheet stays Pending.
    if (result.kind === 'empty') {
      const amtTxt = isFinite(job.amount) ? '$' + job.amount.toFixed(2) : 'expected amount';
      return {
        jobId: job.jobId,
        matched: false,
        reason: `Wire not yet posted (0 transactions loaded for ${amtTxt} ${job.currency || ''}) — sheet stays Pending posting`,
        accountNumberSeen: accountSeen,
      };
    }

    // Transactions present — Ledge uses Vaadin Grid (custom elements + slotted cells),
    // which is virtualized: only currently-visible rows are in the DOM. Drive the grid
    // through its full range, collecting innerText chunks, then scan the aggregate for
    // a matching "Wire In <amount>" entry.
    await delay(400);
    const totalCount = result.totalCount ?? 0;
    const aggregatedText = await scrollGridAndCollectText(totalCount);
    // Diagnostic: helps future-us tell "no rows captured" from "rows captured but no
    // amount within tolerance" without needing DOM inspection.
    const markerMatches = aggregatedText.match(/(?:Client\s+)?Wire\s*In\b/gi) || [];
    const amountRe = new RegExp(`\\b${Math.floor(job.amount)}(?:[.,]\\d{2})?\\b`);
    // Sample a handful of cell texts so we can see what individual cells report.
    const cellSample = Array.from(document.querySelectorAll('vaadin-grid-cell-content'))
      .slice(0, 20)
      .map((c, idx) => {
        const slot = (c as HTMLElement).getAttribute('slot') || '';
        const txt = collectTextIncludingShadowRoots(c).slice(0, 60);
        return `#${idx} slot=${slot} text=${JSON.stringify(txt)}`;
      });
    log('aggregate-scan', {
      textLen: aggregatedText.length,
      markerCount: markerMatches.length,
      expectedAmountAppears: amountRe.test(aggregatedText),
      containsClientWireIn: /client\s+wire\s+in/i.test(aggregatedText),
      containsWirein: /\bwirein\b/i.test(aggregatedText),
      expected: job.amount,
      // DOM structure fingerprint — tells us where the table content is hiding.
      iframeCount: document.querySelectorAll('iframe').length,
      tdCount: document.querySelectorAll('td').length,
      gridcellCount: document.querySelectorAll('[role="gridcell"], [role="cell"]').length,
      vaadinGridPresent: !!document.querySelector('vaadin-grid'),
      vaadinGridCellCount: document.querySelectorAll('vaadin-grid-cell-content').length,
      textStart: aggregatedText.slice(0, 500),
      textEnd: aggregatedText.slice(-500),
      cellSample,
    });
    const found = findMatchingWireInBodyText(job.amount, job.currency, aggregatedText);
    if (found) {
      return { jobId: job.jobId, matched: true, matchedTransaction: found, accountNumberSeen: accountSeen };
    }
    const amtTxt = isFinite(job.amount) ? '$' + job.amount.toFixed(2) : 'expected amount';
    return {
      jobId: job.jobId,
      matched: false,
      reason: `Wire not yet posted (no ${amtTxt} ${job.currency || ''} Wire-In in ${totalCount} transactions) — sheet stays Pending posting`,
      accountNumberSeen: accountSeen,
    };
  } catch (e: any) {
    return { jobId: job.jobId, matched: false, reason: e?.message || String(e) };
  }
}

/** Find the scrollable ancestor that owns the transactions list. Walks up from
 *  `start` until finding an element whose scrollHeight > clientHeight + an overflow-y
 *  setting that allows scrolling. Falls back to `documentElement` if nothing matches. */
function findScrollableAncestor(start: Element | null): HTMLElement | null {
  let node: Element | null = start;
  while (node && node !== document.body) {
    const el = node as HTMLElement;
    const cs = window.getComputedStyle(el);
    const oy = cs.overflowY;
    if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight - el.clientHeight > 4) {
      return el;
    }
    node = el.parentElement;
  }
  if (document.documentElement.scrollHeight > window.innerHeight + 4) {
    return document.documentElement;
  }
  return null;
}

/** Take a text snapshot of the currently-rendered grid rows.
 *
 *  Three collectors, all concatenated:
 *    1. `<vaadin-grid-cell-content>` — Vaadin's slotted cell mount points.
 *    2. Standard-role table cells — `<td>`, `[role="gridcell"]`, `[role="cell"]`.
 *       Some Ledge builds ship a plain HTML/ARIA table rather than vaadin-grid.
 *    3. Shadow-DOM-aware tree walk over the main document AND any same-origin
 *       iframes. Catches text inside any open shadow root that plain
 *       `document.body.innerText` skips. */
function snapshotGridText(): string {
  const parts: string[] = [];
  const cells = document.querySelectorAll('vaadin-grid-cell-content');
  // Walk each cell with the shadow-DOM-aware collector in case Vaadin nests text
  // inside a per-cell open shadow root that plain innerText/textContent misses.
  for (const c of Array.from(cells)) parts.push(collectTextIncludingShadowRoots(c));
  const tableCells = document.querySelectorAll('td, [role="gridcell"], [role="cell"]');
  for (const c of Array.from(tableCells)) parts.push(collectTextIncludingShadowRoots(c));
  parts.push(collectTextIncludingShadowRoots(document.body));
  // Same-origin iframes only — cross-origin access throws and is silently skipped.
  const iframes = document.querySelectorAll('iframe');
  for (const f of Array.from(iframes)) {
    try {
      const doc = (f as HTMLIFrameElement).contentDocument;
      if (doc && doc.body) parts.push(collectTextIncludingShadowRoots(doc.body));
    } catch { /* cross-origin — nothing we can do from here */ }
  }
  return parts.join('\n');
}

/** Walk the DOM tree including any open shadow roots, collecting textContent from
 *  every text node. Standard `element.innerText` / `body.innerText` do not descend
 *  into shadow roots — but many Vaadin/Lit components render their visible content
 *  inside a shadow root. Walking manually is the safest way to see everything. */
function collectTextIncludingShadowRoots(root: Node): string {
  const parts: string[] = [];
  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      const t = (node.textContent || '').trim();
      if (t) parts.push(t);
      return;
    }
    if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as HTMLElement;
      const tag = el.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return;
      const sr = (el as any).shadowRoot as ShadowRoot | null;
      if (sr) walk(sr);
    }
    for (const child of Array.from(node.childNodes)) walk(child);
  };
  walk(root);
  return parts.join('\n');
}

/** Pick the vaadin-grid that actually holds the Transactions table. Ledge renders
 *  one grid per tab (Clients / Accounts / Portfolio / Transactions / ...) and they
 *  all coexist in the DOM. `document.querySelector('vaadin-grid')` returns the
 *  first in document order — usually the tiny Clients grid — so scrolling it
 *  never touches the transactions data.
 *
 *  Strategy:
 *    1. Prefer a grid whose `size` / `_effectiveSize` matches the row count we
 *       parsed from the "N Transaction(s) loaded" status text.
 *    2. Fall back to the largest visible grid by bounding-rect area. */
function findTransactionsGrid(expectedSize: number): HTMLElement | null {
  const grids = Array.from(document.querySelectorAll<HTMLElement>('vaadin-grid'));
  if (grids.length === 0) return null;
  if (grids.length === 1) return grids[0];

  for (const g of grids) {
    const g2 = g as any;
    const size = g2.size ?? g2._effectiveSize ?? g2._cache?.size;
    if (typeof size === 'number' && size === expectedSize) return g;
  }

  let best: HTMLElement | null = null;
  let bestArea = 0;
  for (const g of grids) {
    const r = g.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const area = r.width * r.height;
    if (area > bestArea) { bestArea = area; best = g; }
  }
  return best || grids[0];
}

/** Try to read the Vaadin Grid's underlying data directly, avoiding DOM scraping.
 *  Vaadin Grid keeps items in one of a few well-known places depending on version:
 *   - `grid.items` when items are set as an array
 *   - `grid._dataProviderController.rootCache.items` in newer Lit-based builds
 *   - `grid._cache.items` / `grid._cache.itemsByKey` in older builds
 *  Only accepts arrays whose length matches the expected size to avoid picking up
 *  a different tab's grid data by accident. */
function tryReadGridItemsDirectly(grid: HTMLElement, expectedSize: number): unknown[] | null {
  const g = grid as any;
  const candidates: unknown[] = [
    g.items,
    g._dataProviderController?.rootCache?.items,
    g._cache?.items,
    Object.values(g._cache?.itemsByKey ?? {}),
  ];
  for (const c of candidates) {
    if (Array.isArray(c) && c.length >= expectedSize) return c;
  }
  return null;
}

/** Serialize an arbitrary row object into a flat string so the existing
 *  regex-based marker/amount scanner still works. Skips deeply-nested / cyclic
 *  fields defensively. */
function serializeItem(item: unknown): string {
  if (item == null) return '';
  if (typeof item !== 'object') return String(item);
  const parts: string[] = [];
  for (const v of Object.values(item as Record<string, unknown>)) {
    if (v == null) continue;
    if (typeof v === 'object') continue; // skip nested — rows are usually flat
    parts.push(String(v));
  }
  return parts.join(' ');
}

/** Drive the (virtualized) Vaadin Grid through its full range, capturing text
 *  at each step. Returns one concatenated string covering every row that rendered.
 *  Strategy:
 *    1. Try reading the grid's data model directly — fastest, DOM-independent.
 *    2. If a `<vaadin-grid>` element exposes `scrollToIndex`, step through indices
 *       and capture between steps.
 *    3. Else walk up from the grid to its scrollable ancestor and scroll it manually.
 *    4. Always include the initial snapshot as the first chunk. */
async function scrollGridAndCollectText(totalCount: number): Promise<string> {
  const chunks: string[] = [];
  chunks.push(snapshotGridText());

  // Inventory ALL grids on the page and log a full fingerprint of each so we can
  // see which one holds the transactions. Also try direct-read on every one, not
  // just the "picked" one — cheap and immune to grid-selection mistakes.
  const allGrids = Array.from(document.querySelectorAll<HTMLElement>('vaadin-grid'));
  const inventory = allGrids.map((g, idx) => {
    const g2 = g as any;
    const r = g.getBoundingClientRect();
    // Every enumerable property on the grid element — filtered to primitives and
    // arrays so the log is readable.
    const propsSummary: Record<string, unknown> = {};
    for (const key of Object.keys(g2)) {
      const v = g2[key];
      if (v == null) continue;
      if (Array.isArray(v)) propsSummary[key] = `[array len=${v.length}]`;
      else if (typeof v === 'object') propsSummary[key] = '[object]';
      else if (typeof v === 'function') continue;
      else propsSummary[key] = v;
    }
    return {
      idx,
      area: Math.round(r.width * r.height),
      x: Math.round(r.left), y: Math.round(r.top),
      width: Math.round(r.width), height: Math.round(r.height),
      isVisible: r.width > 0 && r.height > 0,
      itemsIsArray: Array.isArray(g2.items),
      itemsLen: Array.isArray(g2.items) ? g2.items.length : null,
      size: g2.size ?? null,
      _effectiveSize: g2._effectiveSize ?? null,
      _cache_size: g2._cache?.size ?? null,
      _cache_items_len: Array.isArray(g2._cache?.items) ? g2._cache.items.length : null,
      hasDataProvider: typeof g2.dataProvider === 'function',
      hasScrollToIndex: typeof g2.scrollToIndex === 'function',
      ownProps: propsSummary,
    };
  });
  log('grids-inventory', { count: allGrids.length, expectedSize: totalCount, inventory });

  // Try direct-read on every grid, not just the picked one.
  for (const g of allGrids) {
    const direct = tryReadGridItemsDirectly(g, totalCount);
    if (direct) {
      log('Read grid items directly', { itemCount: direct.length, source: 'grid-inventory' });
      for (const item of direct) chunks.push(serializeItem(item));
      return chunks.join('\n');
    }
  }

  const grid = findTransactionsGrid(totalCount);
  const gridShadow: any = { hasShadowRoot: false };
  if (grid) {
    const sr = (grid as any).shadowRoot as ShadowRoot | null;
    if (sr) {
      gridShadow.hasShadowRoot = true;
      gridShadow.childTags = Array.from(sr.children).map((c) => (c as Element).tagName);
      const scroller = findScrollerInGrid(grid);
      if (scroller) {
        gridShadow.scroller = {
          tag: scroller.tagName,
          part: scroller.getAttribute('part'),
          scrollHeight: scroller.scrollHeight,
          clientHeight: scroller.clientHeight,
        };
      }
    }
  }
  log('picked-grid', {
    picked: grid ? {
      area: Math.round(grid.getBoundingClientRect().width * grid.getBoundingClientRect().height),
      size: (grid as any).size ?? (grid as any)._effectiveSize ?? null,
    } : null,
    gridShadow,
  });
  if (!grid || totalCount <= 0) return chunks.join('\n');

  // Path 1: Vaadin's public scrollToIndex API. Rarely present in Vaadin Flow
  // (server-rendered) builds like Ledge, but cheap to try.
  const scrollToIndex = (grid as any).scrollToIndex;
  if (typeof scrollToIndex === 'function') {
    const step = 5;
    for (let i = step; i < totalCount; i += step) {
      try { scrollToIndex.call(grid, i); } catch { /* tolerated */ }
      await delay(350);
      chunks.push(snapshotGridText());
    }
    try { scrollToIndex.call(grid, totalCount - 1); } catch { /* tolerated */ }
    await delay(350);
    chunks.push(snapshotGridText());
    return chunks.join('\n');
  }

  // Path 2: reach INTO the grid's shadow root for its internal scroller.
  // Vaadin Grid's scroll happens inside `<div part="scroller">` in its shadow
  // DOM — the previous `findScrollableAncestor` walked outward from the grid
  // and only found the page body, which scrolls the page, not the grid.
  const innerScroller = findScrollerInGrid(grid);
  if (innerScroller) {
    innerScroller.scrollTop = 0;
    await delay(500);
    chunks.push(snapshotGridText());
    const step = Math.max(80, Math.floor(innerScroller.clientHeight * 0.5));
    for (let y = step; y <= innerScroller.scrollHeight; y += step) {
      innerScroller.scrollTop = y;
      await delay(400);
      chunks.push(snapshotGridText());
    }
    innerScroller.scrollTop = innerScroller.scrollHeight;
    await delay(400);
    chunks.push(snapshotGridText());
    return chunks.join('\n');
  }

  // Path 3: manual scrollTop on the nearest OUTER scrollable ancestor. Fallback
  // only — this scrolls the page, not the grid, in Vaadin Flow builds.
  const scroller = findScrollableAncestor(grid);
  if (!scroller) return chunks.join('\n');
  const total = scroller.scrollHeight;
  const stepPx = Math.max(200, scroller.clientHeight * 0.5);
  for (let y = stepPx; y < total; y += stepPx) {
    scroller.scrollTop = y;
    await delay(300);
    chunks.push(snapshotGridText());
  }
  scroller.scrollTop = total;
  await delay(300);
  chunks.push(snapshotGridText());
  return chunks.join('\n');
}

/** Reach into a Vaadin Grid's shadow root to find its internal scroll container.
 *  Vaadin renders row content inside `<div part="scroller">` (or in older builds,
 *  `<vaadin-grid-scroller>`) — that's what needs to scroll to bring new rows into
 *  the DOM. Returns null when no such element exists (e.g. closed shadow root). */
function findScrollerInGrid(grid: HTMLElement): HTMLElement | null {
  const sr = (grid as any).shadowRoot as ShadowRoot | null;
  if (!sr) return null;
  // Direct part selectors (works for open shadow roots in Vaadin 22+).
  const parts = ['[part="scroller"]', '[part="table"]', 'vaadin-grid-scroller'];
  for (const selector of parts) {
    const el = sr.querySelector(selector) as HTMLElement | null;
    if (el && el.scrollHeight > el.clientHeight + 2) return el;
  }
  // Fallback: any descendant whose overflow allows scrolling.
  const all = sr.querySelectorAll('*');
  for (const el of Array.from(all)) {
    const e = el as HTMLElement;
    const cs = window.getComputedStyle(e);
    const oy = cs.overflowY;
    if ((oy === 'auto' || oy === 'scroll') && e.scrollHeight > e.clientHeight + 2) {
      return e;
    }
  }
  // Last resort: return the first descendant even without a scroll signal — for
  // very short grids where scrollHeight === clientHeight, this is still the
  // element we'd want to scroll if new rows appear later.
  const anyPart = sr.querySelector('[part="scroller"]') as HTMLElement | null;
  return anyPart;
}

/** Scan visible body text for a "Wire In <amount> <currency>" entry matching the
 *  expected amount and currency. DOM-structure-independent — works for Vaadin
 *  Grid, real tables, or any other layout because innerText sees them all the same.
 *
 *  Two row formats are supported:
 *    Old Ledge UI:  "Wire In 700.00 CAD"            (amount inline in description)
 *    New Ledge UI:  "Client Wire In   0.00 700.00 CAD" (amount in a separate Credit cell;
 *                                                       Debit shows 0.00 to the left)
 *
 *  For each "Wire In" / "Client Wire In" marker we scan the next ~200 chars for
 *  decimal numbers, skip zeros (Debit column on a Wire In is always 0.00), and pick
 *  the closest non-zero amount within tolerance.
 *
 *  Tolerance: max($100, 0.5% of expected). Some senders (notably RBC Client Services)
 *  deduct a fee on the way in, so the Ledge amount can differ from the sheet by a few
 *  dollars to ~$50. If multiple wire-ins land within tolerance, we return the closest.
 *
 *  `sourceText` defaults to `document.body.innerText` — callers who pre-aggregated
 *  scrolled-grid text (see `scrollGridAndCollectText`) pass it in directly. */
function findMatchingWireInBodyText(expected: number, currency: string, sourceText?: string): VerifyResult['matchedTransaction'] | null {
  const text = sourceText ?? (document.body.innerText || '');
  const markerRe = /(?:Client\s+)?Wire\s*In\b/gi;
  const tolerance = Math.max(100, Math.abs(expected) * 0.005);
  let best: { diff: number; match: VerifyResult['matchedTransaction'] } | null = null;

  // Collect all marker positions up-front so each per-marker window can be bounded at
  // the NEXT marker. New Ledge UI puts ~10 columns between the "Client Wire In"
  // description and the Credit column, and innerText separates each cell with
  // whitespace/newlines — so the amount can be well over 240 chars past the marker.
  // Bounding at the next marker gives natural row-boundary safety without a hard
  // char cap that might still miss wide rows.
  const positions: { index: number; text: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = markerRe.exec(text)) !== null) {
    positions.push({ index: m.index, text: m[0] });
  }

  for (let i = 0; i < positions.length; i++) {
    const { index: start, text: markerText } = positions[i];
    const nextCap = i + 1 < positions.length ? positions[i + 1].index : text.length;
    // 2000-char safety cap for the tail marker (no next-marker boundary).
    const end = Math.min(nextCap, start + 2000);
    const window = text.slice(start, end);
    const numRe = /(\d[\d,]*\.\d{1,2})(?:\s*([A-Z]{3}))?/g;
    let n: RegExpExecArray | null;
    while ((n = numRe.exec(window)) !== null) {
      const amt = Number(n[1].replace(/,/g, ''));
      if (!isFinite(amt) || amt === 0) continue;
      const desCur = (n[2] || '').toUpperCase();
      if (currency && desCur && desCur !== currency.toUpperCase()) continue;
      const diff = Math.abs(amt - expected);
      if (diff > tolerance) continue;
      if (!best || diff < best.diff) {
        best = {
          diff,
          match: {
            effectiveDate: '',
            description: `${markerText} ${amt}${desCur ? ' ' + desCur : ''}`.trim(),
            amount: amt,
          },
        };
      }
    }
  }
  return best ? best.match : null;
}

async function pickUpAndProcess(): Promise<void> {
  try {
    const res = await chrome.storage.local.get([PENDING_KEY, PROGRESS_KEY]);
    if (res[PROGRESS_KEY]) return; // already running
    const job = res[PENDING_KEY] as VerifyJob | undefined;
    if (!job || !job.jobId || !job.accountNumber) return;

    await chrome.storage.local.set({ [PROGRESS_KEY]: job.jobId });
    await chrome.storage.local.remove([PENDING_KEY]);

    const result = await processJob(job);
    log('result', result);
    await chrome.storage.local.set({ [RESULT_KEY]: result });
    await chrome.storage.local.remove([PROGRESS_KEY]);
  } catch (e: any) {
    // Most common cause: the extension was reloaded while this content script kept
    // running on the page. The old script's chrome.* calls reject with
    // "Extension context invalidated" — swallow that quietly; the user just needs to
    // refresh the Ledge tab to re-attach the new content script.
    if (e?.message?.includes('Extension context invalidated')) {
      log('Extension reloaded — close + reopen this tab to re-attach.');
      return;
    }
    log('pickUpAndProcess error:', e?.message || e);
  }
}

// Trigger on initial load + on every storage change to `pending_ledge_verify`.
async function bootstrap() {
  log('Ledge content script loaded on', location.href, '— role:', ROLE);
  if (!/\/account-inquiry/.test(location.pathname)) {
    log('Not on /account-inquiry — idle.');
    return;
  }
  // Clear any stale "in progress" flag from a previous run that didn't finish (e.g.
  // tab was closed mid-job). Without this, the next pickUpAndProcess would silently
  // return because of the flag and the side panel would just time out.
  const cur = await chrome.storage.local.get(PROGRESS_KEY);
  if (cur[PROGRESS_KEY]) {
    log('Clearing stale in-progress flag:', cur[PROGRESS_KEY]);
    await chrome.storage.local.remove([PROGRESS_KEY]);
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (PENDING_KEY in changes) void pickUpAndProcess();
  });
  log('Ready. Listening for', PENDING_KEY);
  // Also poll once on load in case a job was queued before the script attached.
  await delay(500);
  void pickUpAndProcess();
}

void bootstrap();
