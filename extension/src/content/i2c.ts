// Content script on wealthsimplecs.mycardplace.com — fills the i2c login form with
// the credentials stored in the extension's Settings page, and optionally clicks Sign-in.
//
// The login form is a server-rendered JSP, so the inputs exist by document_idle. We
// retry a few times anyway in case the form is replaced after first paint.

export {}; // Module-scoped so helpers don't collide with other content scripts at the TS layer.

interface StoredCreds {
  username: string;
  password: string;
  autoSubmit: boolean;
}

const I2C_KEY = 'i2c_credentials';
const PENDING_EMAIL_KEY = 'pending_i2c_email';

function log(msg: string, ...args: unknown[]) {
  console.log('[wocoo-i2c]', msg, ...args);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function loadCreds(): Promise<StoredCreds | null> {
  try {
    const res = await chrome.storage.local.get(I2C_KEY);
    const v = res[I2C_KEY];
    if (!v || !v.username || !v.password) return null;
    return { username: String(v.username), password: String(v.password), autoSubmit: !!v.autoSubmit };
  } catch {
    return null;
  }
}

function findFields(): { username: HTMLInputElement; password: HTMLInputElement } | null {
  const inputs = Array.from(document.querySelectorAll('input')) as HTMLInputElement[];
  // Password field is the strongest signal — find it first.
  const password = inputs.find((i) => i.type === 'password' && isVisible(i)) || null;
  if (!password) return null;
  // Username = the visible text input nearest to (typically just before) the password.
  // JSP login pages always have userid above password.
  const textInputs = inputs.filter((i) => (i.type === 'text' || i.type === '' || i.type === 'email') && isVisible(i));
  if (textInputs.length === 0) return null;
  // Pick the one in DOM order before the password (or the only visible text input).
  let username: HTMLInputElement | null = null;
  for (const t of textInputs) {
    const pos = t.compareDocumentPosition(password);
    if (pos & Node.DOCUMENT_POSITION_FOLLOWING) { username = t; break; }
  }
  if (!username) username = textInputs[0];
  return { username, password };
}

function isVisible(el: HTMLElement): boolean {
  if (!el) return false;
  if (el.offsetParent === null && getComputedStyle(el).position !== 'fixed') return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

function setValue(el: HTMLInputElement, value: string) {
  // Use the prototype's native setter so React/Vue/Angular bound to the input
  // see the change. Plain `el.value = ...` bypasses framework state.
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function findSubmit(form: HTMLFormElement | null): HTMLElement | null {
  // Prefer a submit inside the same form as the password input.
  if (form) {
    const btn = form.querySelector<HTMLElement>('input[type="submit"], button[type="submit"]');
    if (btn) return btn;
  }
  // Fall back: any submit on the page. The i2c JSP login only has one.
  return document.querySelector<HTMLElement>('input[type="submit"], button[type="submit"]');
}

let filledOnce = false;
async function tryAutofill(): Promise<boolean> {
  if (filledOnce) return true;
  const creds = await loadCreds();
  if (!creds) return false;
  const fields = findFields();
  if (!fields) return false;
  setValue(fields.username, creds.username);
  setValue(fields.password, creds.password);
  filledOnce = true;
  if (creds.autoSubmit) {
    const btn = findSubmit(fields.password.form);
    if (btn) {
      // Defer the click one tick so any synchronous form-validation hooks see the
      // populated values before submit.
      setTimeout(() => btn.click(), 50);
    }
  }
  return true;
}

// ----- Manage Sessions: auto-click "Kill All" -----
// When another user (or our own stale browser tab) is signed in with the same creds, i2c
// shows a "Manage Sessions" intermediate page after login asking us to kill or keep that
// other session. Clicking "Kill All" terminates the others and lets us proceed to
// Customer Search where the email-fill step takes over.

let killSessionRan = false;
async function tryKillSession(): Promise<boolean> {
  if (killSessionRan) return true;
  const body = document.body?.textContent || '';
  if (!/Manage Sessions/i.test(body)) return false;
  if (!/another user.*logged in/i.test(body)) return false;
  const candidates = Array.from(document.querySelectorAll<HTMLElement>('input[type="submit"], input[type="button"], button'));
  let killAll: HTMLElement | null = null;
  for (const b of candidates) {
    const v = ((b as HTMLInputElement).value || b.textContent || '').trim();
    if (/^kill\s*all$/i.test(v)) { killAll = b; break; }
  }
  // Fallback: if "Kill All" isn't present (only a single session listed without a Kill All
  // button), click the per-row "Kill Session" instead.
  if (!killAll) {
    for (const b of candidates) {
      const v = ((b as HTMLInputElement).value || b.textContent || '').trim();
      if (/^kill\s*session$/i.test(v)) { killAll = b; break; }
    }
  }
  if (!killAll) return false;
  killSessionRan = true;
  setTimeout(() => killAll!.click(), 100);
  return true;
}

// ----- Customer Search: fill the email field + click that section's Search -----
// Triggered when the side panel writes the ticket's clientEmail to session storage just
// before opening the i2c link. One-shot: pending_i2c_email is cleared on first use.

// pending_i2c_email doubles as the "chain in progress" flag for the multi-step nav after
// search. We only clear it at the LAST step (Recent Activity date), so each intermediate
// step gates on it being still present. If the chain breaks (page unexpected), Albert just
// clicks i2c again from the side panel and the value is re-written.

// Keys older than this are treated as stale — protects against a half-finished chain
// (closed tab, network hang, etc.) hijacking a later manual visit to i2c.
const CHAIN_MAX_AGE_MS = 5 * 60 * 1000;

const ALL_PENDING_KEYS = [
  PENDING_EMAIL_KEY,
  'pending_i2c_source_ticket_id',
  'pending_i2c_flow',
  'pending_i2c_ticket_url',
  'pending_i2c_admin_debit_amount',
  'pending_i2c_started_at',
  'pending_i2c_interest_stmt_attempted',
  'qc_search_clicked',
];

async function clearAllPendingKeys() {
  try { await chrome.storage.local.remove(ALL_PENDING_KEYS); } catch { /* fine */ }
}

async function chainActive(): Promise<boolean> {
  const res = await chrome.storage.local.get([PENDING_EMAIL_KEY, 'pending_i2c_started_at']);
  if (typeof res[PENDING_EMAIL_KEY] !== 'string') return false;
  const startedAt = typeof res.pending_i2c_started_at === 'number' ? res.pending_i2c_started_at : 0;
  if (Date.now() - startedAt > CHAIN_MAX_AGE_MS) {
    log('chain marker is stale (older than', CHAIN_MAX_AGE_MS / 1000, 's) — clearing');
    await clearAllPendingKeys();
    return false;
  }
  return true;
}

// Which chain variant to run. `reverse_fee` extends past Search → Current Statement →
// click Reverse Fee transaction → paste ticket URL on the Fee Reversal Requests page.
// Anything else (null) is the regular Recent-Activity sign-in.
// Chain variants. null (generic) stops after "Continue with this Customer" so the
// agent can navigate i2c's sidebar manually without the script forcing a navigation.
type Flow = 'reverse_fee' | 'reverse_interest_fee' | 'admin_debit' | 'verify_balance' | 'qc_month_scrape' | 'apply_credit' | null;
async function getFlow(): Promise<Flow> {
  const res = await chrome.storage.local.get('pending_i2c_flow');
  const v = res.pending_i2c_flow;
  return v === 'reverse_fee' || v === 'reverse_interest_fee' || v === 'admin_debit' || v === 'verify_balance'
    || v === 'qc_month_scrape' || v === 'apply_credit' ? v : null;
}

function setTextareaValue(el: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

let emailSearchRan = false;
async function tryEmailSearch(): Promise<boolean> {
  if (emailSearchRan) return true;
  const res = await chrome.storage.local.get(PENDING_EMAIL_KEY);
  const email = res[PENDING_EMAIL_KEY];
  if (!email || typeof email !== 'string') return false;
  const emailInput = findEmailInput();
  if (!emailInput) return false;
  setValue(emailInput, email);
  emailSearchRan = true;
  const btn = findSectionSearchButton(emailInput);
  if (btn) setTimeout(() => btn.click(), 100);
  return true;
}

function findEmailInput(): HTMLInputElement | null {
  // i2c Customer Search is server-rendered table markup: label cell + input cell in the
  // same <tr>. Walk every element whose text is "Email Address" and grab the adjacent input.
  const candidates = Array.from(document.querySelectorAll('td, th, label, div, span'));
  for (const el of candidates) {
    const txt = (el.textContent || '').trim();
    if (!/^Email\s*Address\s*:?$/i.test(txt)) continue;
    const row = el.closest('tr');
    let input: HTMLInputElement | null = null;
    if (row) input = row.querySelector<HTMLInputElement>('input[type="text"], input:not([type])');
    if (!input) input = el.parentElement?.querySelector<HTMLInputElement>('input[type="text"], input:not([type])') || null;
    if (input && input.type !== 'password' && isVisible(input)) return input;
  }
  return null;
}

function findSectionSearchButton(emailInput: HTMLInputElement): HTMLElement | null {
  // Best case: each i2c "Search by …" panel is its own <form>, so the form's submit IS
  // the right Search button for that section.
  if (emailInput.form) {
    const btn = emailInput.form.querySelector<HTMLElement>(
      'input[type="submit"], button[type="submit"], input[type="button"][value*="earch" i]'
    );
    if (btn) return btn;
  }
  // Fallback: walk up the DOM until we find a container with exactly one Search button.
  let node: Element | null = emailInput.parentElement;
  while (node && node !== document.body) {
    const btns = Array.from(node.querySelectorAll<HTMLElement>(
      'input[type="submit"], button[type="submit"], input[type="button"]'
    )).filter((b) => {
      const v = (b as HTMLInputElement).value || b.textContent || '';
      return /search/i.test(v);
    });
    if (btns.length === 1) return btns[0];
    node = node.parentElement;
  }
  return null;
}

// ----- Card Details: click "Continue with this Customer" -----

let continueRan = false;
async function tryContinueWithCustomer(): Promise<boolean> {
  if (continueRan) return true;
  if (!(await chainActive())) return false;
  const buttons = Array.from(document.querySelectorAll<HTMLElement>('input[type="submit"], input[type="button"], button'));
  for (const b of buttons) {
    const v = ((b as HTMLInputElement).value || b.textContent || '').trim();
    if (/^Continue\s+with\s+this\s+Customer$/i.test(v)) {
      if (!isVisible(b)) continue;
      continueRan = true;
      setTimeout(() => b.click(), 100);
      // For the generic (null) flow, Continue is the terminal step — clear pending keys
      // so the agent can navigate i2c's sidebar manually without the chain barging in.
      const flow = await getFlow();
      if (flow === null) {
        log('  → generic flow: Continue is terminal, clearing pending keys');
        try { await chrome.storage.local.remove([PENDING_EMAIL_KEY, 'pending_i2c_source_ticket_id']); } catch { /* fine */ }
      }
      return true;
    }
  }
  return false;
}

// ----- Account Summary: click "Account Transactions" in left sidebar -----

let accountTxRan = false;
async function tryAccountTransactions(): Promise<boolean> {
  if (accountTxRan) return true;
  if (!(await chainActive())) return false;
  // verify_balance, reverse_fee, reverse_interest_fee, qc_month_scrape need Account
  // Transactions. admin_debit and apply_credit use Administrative Services; generic
  // (null) flow stops at the customer page so the agent can navigate the sidebar manually.
  const flow = await getFlow();
  if (flow !== 'verify_balance' && flow !== 'reverse_fee' && flow !== 'reverse_interest_fee' && flow !== 'qc_month_scrape') return false;
  // If we're already on the Account Transactions page, skip the sidebar click — otherwise
  // we navigate back to the default state and lose any Current-Statement filter we set,
  // causing the chain to ping-pong without ever clicking Reverse Fee.
  const body = document.body?.textContent || '';
  if (/Below is the list of transaction/i.test(body) || /Search Transaction/i.test(body)) {
    log('  → already on Account Transactions, skipping sidebar click');
    accountTxRan = true;
    return true;
  }
  // Sidebar items are anchors (or sometimes <span> wrapped in <a>). Match exact text to
  // avoid hitting "Dispute Transactions", "Declined Transactions", "Account Statements".
  const clickables = Array.from(document.querySelectorAll<HTMLElement>('a, button'));
  for (const el of clickables) {
    const t = (el.textContent || '').trim();
    if (/^Account\s+Transactions$/i.test(t) && isVisible(el)) {
      accountTxRan = true;
      setTimeout(() => el.click(), 100);
      return true;
    }
  }
  return false;
}

// ----- admin_debit only: click "Administrative Services" sidebar link -----

let adminServicesRan = false;
async function tryAdminServices(): Promise<boolean> {
  if (adminServicesRan) return true;
  if (!(await chainActive())) return false;
  const flow = await getFlow();
  if (flow !== 'admin_debit' && flow !== 'apply_credit') return false;
  // Skip if we're already on the Admin Services page.
  const body = document.body?.textContent || '';
  if (/Apply desired service to the card account/i.test(body)) {
    adminServicesRan = true;
    return true;
  }
  const clickables = Array.from(document.querySelectorAll<HTMLElement>('a, button'));
  for (const el of clickables) {
    const t = (el.textContent || '').trim();
    if (/^Administrative\s+Services$/i.test(t) && isVisible(el)) {
      log('  → clicking Administrative Services sidebar');
      adminServicesRan = true;
      setTimeout(() => el.click(), 100);
      return true;
    }
  }
  return false;
}

// ----- Account Transactions: switch date dropdown to "… to Present" (Recent Activity) -----

// Generic select-statement helper: picks the option whose <optgroup label> matches.
// Regular flow → "Recent Activity" (… to Present). Reverse-fee flow → "Current Statement"
// (the previously-closed billing period containing the fee to reverse).
function pickStatementOption(s: HTMLSelectElement, group: 'Recent Activity' | 'Current Statement'): HTMLOptionElement | null {
  for (const o of Array.from(s.options)) {
    const parent = o.parentElement;
    if (parent?.tagName !== 'OPTGROUP') continue;
    if (new RegExp(`^${group}$`, 'i').test((parent as HTMLOptGroupElement).label || '')) return o;
  }
  // Fallback by text: "to Present" for Recent Activity, anything-else "to <date>" for Current Statement.
  for (const o of Array.from(s.options)) {
    const txt = (o.textContent || '').trim();
    if (group === 'Recent Activity' && /to\s+Present\b/i.test(txt)) return o;
    if (group === 'Current Statement' && /to\s+\d/.test(txt) && !/Present/i.test(txt)) return o;
  }
  return null;
}

function commitSelectOption(s: HTMLSelectElement, target: HTMLOptionElement) {
  s.focus();
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
  setter?.call(s, target.value);
  for (const o of Array.from(s.options)) o.selected = (o === target);
  s.dispatchEvent(new Event('input', { bubbles: true }));
  s.dispatchEvent(new Event('change', { bubbles: true }));
  s.blur();
}

// Tracks whether we actually mutated a dropdown this content-script instance. If we did,
// we need to click Search to apply. If the dropdown was already at the target value
// (page rendered with the right filter), we skip Search to avoid an unnecessary reload
// loop. Re-clicking Search would trigger a page reload, which restarts the content script
// with all flags reset — causing the chain to ping-pong.
let dropdownChanged = false;

let recentActivityRan = false;
async function tryRecentActivity(): Promise<boolean> {
  if (recentActivityRan) return true;
  if (!(await chainActive())) return false;
  const flow = await getFlow();
  if (flow !== 'verify_balance' && flow !== 'reverse_interest_fee') return false;

  // For the reverse_interest_fee flow, we search Recent Activity FIRST, and if the
  // interest row isn't reachable there, fall back to Current Statement. Track which
  // attempt we're on via chrome.storage so the state survives Search-triggered reloads.
  // - undefined: haven't tried Recent Activity yet → pick it now
  // - 'recent_activity': tried Recent Activity, now on Current Statement fallback → skip
  // - 'done': both attempts exhausted → skip
  if (flow === 'reverse_interest_fee') {
    const res = await chrome.storage.local.get('pending_i2c_interest_stmt_attempted');
    if (res.pending_i2c_interest_stmt_attempted) {
      log('  → Recent Activity already attempted; deferring to Current Statement fallback');
      recentActivityRan = true;
      return true;
    }
  }

  const selects = Array.from(document.querySelectorAll<HTMLSelectElement>('select'));
  let selectHit = false;
  for (const s of selects) {
    if (!isVisible(s)) continue;
    const target = pickStatementOption(s, 'Recent Activity');
    if (!target) continue;
    selectHit = true;
    if (s.value === target.value) {
      log('  → Recent Activity already selected in <select>, skipping change');
    } else {
      log('  → selecting Recent Activity in <select>:', target.textContent?.trim());
      commitSelectOption(s, target);
      dropdownChanged = true;
    }
    break;
  }

  // Fallback for reverse_interest_fee only when the <select> path DID NOT succeed
  // (custom widget page, or Recent Activity optgroup absent). Writing From/To directly
  // gets us a 60-day window covering the last statement close.
  const onAccountTx = /Below is the list of transaction/i.test(document.body?.textContent || '')
    || /Search Transaction/i.test(document.body?.textContent || '');
  if (flow === 'reverse_interest_fee' && !selectHit && onAccountTx) {
    const res = writeRecentActivityDateRange(60);
    if (!res.found) return false;
    if (res.changed) {
      dropdownChanged = true;
      log('  → wrote wide From/To range (no Recent Activity <select> found)');
    }
  } else if (!selectHit) {
    return false;
  }

  recentActivityRan = true;
  return true;
}

/** Fill i2c's Transaction Date From/To inputs with a range spanning `days` back through
 *  today. Returns {found, changed}: `found` iff both inputs existed; `changed` iff a
 *  value differed from the current one. Values already at the target are left alone to
 *  avoid triggering an unnecessary Search reload in the pagination-scan loop. */
function writeRecentActivityDateRange(days: number): { found: boolean; changed: boolean } {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - days);
  const fmt = (d: Date) => `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;
  const fromInput = findInputByLabelText(/^From/i);
  const toInput = findInputByLabelText(/^To/i);
  if (!fromInput || !toInput) return { found: false, changed: false };
  const targetFrom = fmt(from);
  const targetTo = fmt(to);
  let changed = false;
  if (fromInput.value !== targetFrom) { setValue(fromInput, targetFrom); changed = true; }
  if (toInput.value !== targetTo) { setValue(toInput, targetTo); changed = true; }
  return { found: true, changed };
}

// Reverse-fee variant: picks the Current Statement option (the previous billing period)
// so the search returns the fee-bearing transactions. Also runs for reverse_interest_fee
// as the Recent-Activity fallback (once pending_i2c_interest_stmt_attempted is set).
let currentStatementRan = false;
async function tryCurrentStatement(): Promise<boolean> {
  if (currentStatementRan) return true;
  if (!(await chainActive())) return false;
  const flow = await getFlow();
  if (flow !== 'reverse_fee' && flow !== 'reverse_interest_fee') return false;
  // For reverse_interest_fee, only pick Current Statement when Recent Activity was
  // already tried (fallback attempt). On the initial pass, tryRecentActivity handles it.
  if (flow === 'reverse_interest_fee') {
    const res = await chrome.storage.local.get('pending_i2c_interest_stmt_attempted');
    if (!res.pending_i2c_interest_stmt_attempted) return false;
  }
  const selects = Array.from(document.querySelectorAll<HTMLSelectElement>('select'));
  for (const s of selects) {
    if (!isVisible(s)) continue;
    const target = pickStatementOption(s, 'Current Statement');
    if (!target) continue;
    if (s.value === target.value) {
      log('  → Current Statement already selected, skipping change');
      currentStatementRan = true;
      return true;
    }
    log('  → selecting Current Statement:', target.textContent?.trim());
    commitSelectOption(s, target);
    dropdownChanged = true;
    currentStatementRan = true;
    return true;
  }
  return false;
}

// ----- Account Transactions: click "Search" after the date dropdown is set -----
// Without this, the page keeps showing the previous statement because the From/To inputs
// updated but the filter never re-ran. This is the final step of the i2c chain.

let searchClickedRan = false;
let searchActuallyClickedAt = 0;
async function tryClickSearch(): Promise<boolean> {
  if (searchClickedRan) return true;
  if (!recentActivityRan && !currentStatementRan) return false; // wait for either dropdown step
  if (!(await chainActive())) return false;

  // If the dropdown was already at the target value (we didn't mutate it), the page is
  // already showing the right filter — clicking Search would unnecessarily reload and
  // restart this content script, breaking the chain. Mark search as done and move on.
  if (!dropdownChanged) {
    log('  → dropdown already at target, skipping Search click');
    searchClickedRan = true;
    // NOTE: don't clear pending_i2c_email here — tryReadRunningBalance (regular flow)
    // and tryFindAndClickReverseFee (reverse_fee flow) still need it. Each terminal
    // step clears it.
    return true;
  }

  const buttons = Array.from(document.querySelectorAll<HTMLElement>('input[type="submit"], input[type="button"], button'));
  for (const b of buttons) {
    const v = ((b as HTMLInputElement).value || b.textContent || '').trim();
    if (/^Search$/i.test(v) && isVisible(b)) {
      log('  → clicking Search to apply date filter');
      await sleep(250);
      b.click();
      searchClickedRan = true;
      searchActuallyClickedAt = Date.now();
      return true;
    }
  }
  return false;
}

// ----- Regular flow only: scrape the latest transaction's Running Balance + write back -----
// The Verify Balance step of Overpayment Triage shows this value in a "Running Balance"
// box and compares it to the ticket's amount so the agent can confirm at-a-glance.

let runningBalanceReadRan = false;
async function tryReadRunningBalance(): Promise<boolean> {
  if (runningBalanceReadRan) return true;
  if (!searchClickedRan) return false;
  if ((await getFlow()) !== 'verify_balance') return false; // only verify_balance reads the balance

  // If the transactions table is paginated, jump to the last page first — the newest
  // transactions (which carry the current running balance) live at the tail of the
  // ledger, not on page 1. For accounts with < 1 page of data this is a no-op.
  await goToLastPaginationPage();

  // Find the Posted Transactions table by looking for a cell whose text is exactly
  // "Running Balance". Then align data cells by their pixel position (getBoundingClientRect)
  // — index-based alignment kept misfiring on this table, possibly due to colspan or
  // extra wrapper cells that shifted column counts row-to-row.
  // Prefer the LARGEST matching table by data-row count. i2c pages sometimes carry a
  // small "current balance" summary table with the same headers as the ledger — using
  // the first match picked up whichever came earlier in DOM order and produced a bogus
  // value (e.g. an unrelated $132.01 while the true balance was -$2,183.55 on the
  // multi-row ledger further down).
  const tables = Array.from(document.querySelectorAll('table'));
  let bestTable: {
    rbRect: DOMRect;
    idRect: DOMRect | null;
    dateRect: DOMRect;
    dataRows: HTMLTableRowElement[];
  } | null = null;
  for (const table of tables) {
    // Skip wrapper/layout tables that contain other tables. querySelectorAll('th, td')
    // recurses into nested tables, so an outer table "contains" every inner table's cells
    // and rows — which lets it win the largest-by-row-count tiebreak below while its
    // header positions come from whichever inner table appears first in DOM order.
    // The result: rbRect is measured on Pending's header, but the data cells belong to
    // Posted, and pixel alignment snaps to the wrong column (e.g. Review Required "NA").
    if (table.querySelector('table')) continue;
    const allCells = Array.from(table.querySelectorAll<HTMLTableCellElement>('th, td'));
    const rbHeader = allCells.find((c) => /^\s*Running\s*Balance\s*$/i.test((c.textContent || '').trim()));
    const idHeader = allCells.find((c) => /^\s*Trans\.?\s*ID\s*$/i.test((c.textContent || '').trim()));
    const dateHeader = allCells.find((c) => /^\s*Trans\.?\s*Date\s*$/i.test((c.textContent || '').trim()));
    if (!rbHeader || !dateHeader) continue;

    const headerRow = rbHeader.closest('tr');
    const allRows = Array.from(table.querySelectorAll<HTMLTableRowElement>('tr'));
    const dataRows = allRows.filter((r) => r !== headerRow && r.querySelectorAll(':scope > td, :scope > th').length > 1);
    if (dataRows.length === 0) continue;
    if (bestTable && bestTable.dataRows.length >= dataRows.length) continue;

    bestTable = {
      rbRect: rbHeader.getBoundingClientRect(),
      idRect: idHeader ? idHeader.getBoundingClientRect() : null,
      dateRect: dateHeader.getBoundingClientRect(),
      dataRows,
    };
  }

  if (bestTable) {
    const { rbRect, idRect, dateRect, dataRows } = bestTable;
    log(`  → picked table with ${dataRows.length} data rows; rbLeft=${Math.round(rbRect.left)} idLeft=${idRect ? Math.round(idRect.left) : 'n/a'} dateLeft=${Math.round(dateRect.left)}`);

    // Match a header cell to a data cell by bounding-rect.left within tolerance.
    function cellAt(row: HTMLTableRowElement, targetLeft: number): HTMLTableCellElement | null {
      const cells = Array.from(row.querySelectorAll<HTMLTableCellElement>(':scope > td, :scope > th'));
      let best: HTMLTableCellElement | null = null;
      let bestDelta = Infinity;
      for (const c of cells) {
        const left = c.getBoundingClientRect().left;
        const delta = Math.abs(left - targetLeft);
        if (delta < bestDelta && delta < 40) { bestDelta = delta; best = c; }
      }
      return best;
    }

    // Pick latest by Trans. ID (numeric, monotonically increasing).
    let bestRow: HTMLTableRowElement | null = null;
    let bestId = -Infinity;
    let bestTime = -Infinity;
    for (const row of dataRows) {
      if (idRect) {
        const idCell = cellAt(row, idRect.left);
        const id = parseInt((idCell?.textContent || '').trim(), 10);
        if (isFinite(id) && id > bestId) { bestId = id; bestRow = row; continue; }
      }
      if (!idRect) {
        const dCell = cellAt(row, dateRect.left);
        const t = parseI2cDate((dCell?.textContent || '').trim());
        if (t >= bestTime) { bestTime = t; bestRow = row; }
      }
    }
    if (!bestRow) bestRow = dataRows[dataRows.length - 1] || null;
    if (!bestRow) return false;

    const rbCell = cellAt(bestRow, rbRect.left);
    const idCell = idRect ? cellAt(bestRow, idRect.left) : null;
    const dateCell = cellAt(bestRow, dateRect.left);
    log('  → latest row: id=', (idCell?.textContent || '').trim(), 'date=', (dateCell?.textContent || '').trim());
    const rawText = (rbCell?.textContent || '').trim();
    if (!rawText) { log('  → empty Running Balance cell'); return false; }
    // Sanity check: card numbers contain "*" — never a real balance.
    if (rawText.includes('*')) {
      log('  → captured cell looks like a card number, alignment failed:', JSON.stringify(rawText));
      return false;
    }
    // "CA$220.00" → 220.00; "-CA$0.39" → -0.39; "(CA$9,500.00)" → -9500.00
    const sign = /^-/.test(rawText) || /^\(/.test(rawText) ? -1 : 1;
    const numeric = sign * parseFloat(rawText.replace(/[^\d.]/g, ''));
    if (!isFinite(numeric)) { log('  → could not parse balance:', rawText); return false; }
    if (Math.abs(numeric) > 1_000_000) {
      log('  → balance magnitude unrealistic, alignment likely wrong:', rawText, '→', numeric);
      return false;
    }

    const ctx = await chrome.storage.local.get('pending_i2c_source_ticket_id');
    const sourceTicketId = typeof ctx.pending_i2c_source_ticket_id === 'string' ? ctx.pending_i2c_source_ticket_id : '';

    log('  → captured running balance:', rawText, '→', numeric, 'for', sourceTicketId);
    await chrome.storage.local.set({
      i2c_running_balance: {
        sourceTicketId,
        value: numeric,
        valueText: rawText,
        capturedAt: new Date().toISOString(),
      },
    });
    runningBalanceReadRan = true;
    try { await chrome.storage.local.remove([PENDING_EMAIL_KEY, 'pending_i2c_source_ticket_id']); } catch { /* fine */ }
    return true;
  }
  return false;
}

function parseI2cDate(s: string): number {
  // i2c renders dates as MM/DD/YYYY in the Trans. Date column.
  const m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return new Date(parseInt(m[3]), parseInt(m[1]) - 1, parseInt(m[2])).getTime();
  return -Infinity;
}

/** If i2c's Posted Transactions pager shows more than one page, click "Last" so the
 *  newest transactions land in view. i2c orders oldest→newest, and the ledger is
 *  paginated at ~35 rows, so the current running balance is at the tail of the last
 *  page — not on page 1. No-op if there's no visible/enabled "Last" control. */
let lastPageClickedRan = false;
async function goToLastPaginationPage(): Promise<void> {
  if (lastPageClickedRan) return;
  const candidates = Array.from(document.querySelectorAll<HTMLElement>('a, button, span, [role="button"]'));
  for (const el of candidates) {
    const text = (el.textContent || '').trim();
    // Match "Last", "Last >|", "Last »", "Last ›|"
    if (!/^last(\s*[>|›»])?$/i.test(text)) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (el.hasAttribute('disabled')) continue;
    if (el.getAttribute('aria-disabled') === 'true') continue;
    if (el.classList.contains('disabled') || el.classList.contains('ui-state-disabled')) continue;
    log('  → clicking pagination "Last" to jump to newest transactions');
    el.click();
    lastPageClickedRan = true;
    // i2c reloads the transactions table via XHR — 1.8s is comfortable headroom.
    await new Promise((r) => setTimeout(r, 1800));
    return;
  }
}

// ----- admin_debit only: on Administrative Services page, pre-fill the Apply form -----
// Selects "Admin Funds Debit" in the Service dropdown, fills Amount with the overpayment
// amount (positive), and pastes the Jira ticket URL into Comments. Does NOT click Apply.

let adminDebitFilledRan = false;
async function tryFillAdminDebit(): Promise<boolean> {
  if (adminDebitFilledRan) return true;
  if ((await getFlow()) !== 'admin_debit') return false;
  const body = document.body?.textContent || '';
  if (!/Apply desired service to the card account/i.test(body)) return false;

  const ctx = await chrome.storage.local.get(['pending_i2c_admin_debit_amount', 'pending_i2c_ticket_url']);
  const amountText = typeof ctx.pending_i2c_admin_debit_amount === 'string' ? ctx.pending_i2c_admin_debit_amount : '';
  const ticketUrl = typeof ctx.pending_i2c_ticket_url === 'string' ? ctx.pending_i2c_ticket_url : '';
  if (!amountText || !ticketUrl) { log('  → admin_debit context missing'); return false; }

  // Find the Service dropdown — it's the <select> whose options include "Admin Funds Debit".
  const selects = Array.from(document.querySelectorAll<HTMLSelectElement>('select'));
  let serviceSelect: HTMLSelectElement | null = null;
  let targetOpt: HTMLOptionElement | null = null;
  for (const s of selects) {
    if (!isVisible(s)) continue;
    const opt = Array.from(s.options).find((o) => /^Admin\s*Funds?\s*Debit$/i.test((o.textContent || '').trim()));
    if (opt) { serviceSelect = s; targetOpt = opt; break; }
  }
  if (!serviceSelect || !targetOpt) { log('  → Admin Funds Debit option not found yet'); return false; }

  // Set Service to Admin Funds Debit (idempotent — skip if already selected).
  if (serviceSelect.value !== targetOpt.value) {
    log('  → selecting Admin Funds Debit');
    serviceSelect.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
    setter?.call(serviceSelect, targetOpt.value);
    for (const o of Array.from(serviceSelect.options)) o.selected = (o === targetOpt);
    serviceSelect.dispatchEvent(new Event('input', { bubbles: true }));
    serviceSelect.dispatchEvent(new Event('change', { bubbles: true }));
    serviceSelect.blur();
    await sleep(250); // give the page time to react before we touch other fields
  }

  // Find Amount input by proximity to "Amount" label.
  const amountInput = findInputByLabelText(/^Amount/i);
  if (amountInput) {
    if (amountInput.value !== amountText) {
      log('  → filling Amount:', amountText);
      setValue(amountInput, amountText);
    }
  } else {
    log('  → Amount input not found');
  }

  // Find Comments textarea by proximity to "Comments" label.
  const commentsArea = findTextareaByLabelText(/^Comments/i);
  if (commentsArea) {
    if (commentsArea.value !== ticketUrl) {
      log('  → filling Comments with ticket URL');
      setTextareaValue(commentsArea, ticketUrl);
    }
  } else {
    log('  → Comments textarea not found');
  }

  // Both fields filled (or at least attempted) — mark done. Re-runs are safe because of
  // the value-equality short-circuits above.
  if (amountInput && commentsArea) {
    adminDebitFilledRan = true;
    try {
      await chrome.storage.local.remove([
        PENDING_EMAIL_KEY,
        'pending_i2c_source_ticket_id',
        'pending_i2c_flow',
        'pending_i2c_ticket_url',
        'pending_i2c_admin_debit_amount',
      ]);
    } catch { /* fine */ }
    return true;
  }
  return false;
}

function findInputByLabelText(labelRe: RegExp): HTMLInputElement | null {
  // Walk every label-like element; for each that matches `labelRe`, prefer the input
  // that's *adjacent to* it (next sibling or inside the next sibling) over any input in
  // the same row. This disambiguates between e.g. From + To inputs that share a row.
  const inputSel = 'input[type="text"], input[type="number"], input[type="date"], input:not([type])';
  const labelEls = Array.from(document.querySelectorAll<HTMLElement>('td, th, label, div, span'));
  for (const el of labelEls) {
    const t = (el.textContent || '').trim();
    if (!labelRe.test(t)) continue;

    // 1. Walk forward through sibling elements; the input adjacent to the label wins.
    let sibling: Element | null = el.nextElementSibling;
    while (sibling) {
      if (sibling instanceof HTMLInputElement && sibling.matches(inputSel)) {
        if (isVisible(sibling) && sibling.type !== 'password') return sibling;
      }
      const inner = sibling.querySelector?.(inputSel) as HTMLInputElement | null;
      if (inner && isVisible(inner) && inner.type !== 'password') return inner;
      sibling = sibling.nextElementSibling;
    }

    // 2. Fallback: input inside the same row OR parent — last resort, may grab the wrong
    //    one if multiple labels share a row, but better than nothing.
    const row = el.closest('tr');
    let fallback: HTMLInputElement | null = null;
    if (row) fallback = row.querySelector<HTMLInputElement>(inputSel);
    if (!fallback) fallback = el.parentElement?.querySelector<HTMLInputElement>(inputSel) || null;
    if (fallback && isVisible(fallback) && fallback.type !== 'password') return fallback;
  }
  return null;
}

function findTextareaByLabelText(labelRe: RegExp): HTMLTextAreaElement | null {
  const labelEls = Array.from(document.querySelectorAll<HTMLElement>('td, th, label, div, span'));
  for (const el of labelEls) {
    const t = (el.textContent || '').trim();
    if (!labelRe.test(t)) continue;
    const row = el.closest('tr');
    let ta: HTMLTextAreaElement | null = null;
    if (row) ta = row.querySelector<HTMLTextAreaElement>('textarea');
    if (!ta) ta = el.parentElement?.querySelector<HTMLTextAreaElement>('textarea') || null;
    if (ta && isVisible(ta)) return ta;
  }
  return null;
}

// ----- Reverse-fee only: find $20/$220 fee row + click its "Reverse Fee" link -----

let reverseFeeClickedRan = false;
async function tryFindAndClickReverseFee(): Promise<boolean> {
  if (reverseFeeClickedRan) return true;
  if ((await getFlow()) !== 'reverse_fee') return false;
  // Scan for "Reverse Fee" links — only present on rows in i2c's transaction table.
  const links = Array.from(document.querySelectorAll<HTMLElement>('a, input[type="button"], input[type="submit"], button'));
  for (const link of links) {
    const rawTxt = ((link as HTMLInputElement).value || link.textContent || '').trim();
    // Normalize whitespace — i2c's "Reverse Fee" link wraps across two lines in narrow
    // columns, so textContent may contain \n or multiple spaces.
    const normalized = rawTxt.replace(/\s+/g, ' ').trim();
    if (!/^Reverse\s*Fee$/i.test(normalized)) continue;
    if (!isVisible(link)) continue;
    const row = link.closest('tr');
    if (!row) continue;
    const cells = Array.from(row.querySelectorAll('td'));
    const amountMatches = cells.some((c) => {
      // Strip currency prefix (CA, US, $) + commas + whitespace before comparing.
      // i2c renders the amount as "CA$220.00" — my old cleaner left "CA" attached.
      const cleaned = (c.textContent || '').replace(/[A-Za-z$,\s]/g, '');
      return cleaned === '20' || cleaned === '20.00' || cleaned === '220' || cleaned === '220.00';
    });
    if (!amountMatches) continue;
    log('  → clicking Reverse Fee link for row with matching amount');
    reverseFeeClickedRan = true;
    link.click();
    return true;
  }
  return false;
}

// ----- reverse_interest_fee: paginate through Posted Transactions with "Next" until we
//       find a Reverse Fee link on a row whose description contains "Interest" (i.e.
//       "Financial Charges - Interest"), then click it. i2c orders oldest→newest and
//       paginates ~5/page, so the current-cycle interest posting is on the last page.
//       We still walk Next-by-Next rather than jumping to "Last" because agents may want
//       to catch an interest reversal from a mid-ledger cycle.

let interestFeeIterationRan = false;
async function tryFindAndClickInterestReverseFee(): Promise<boolean> {
  if (interestFeeIterationRan) return true;
  if ((await getFlow()) !== 'reverse_interest_fee') return false;
  // Gate on Search having run (Recent Activity filter applied) so we don't scan an empty
  // pre-search page.
  if (!searchClickedRan) return false;
  // If Search was clicked in THIS instance moments ago, a full-page reload is in flight
  // — clicking Next on the current (soon-to-be-replaced) DOM would race the reload and
  // could hijack the navigation. Wait for the reload; the next content-script instance
  // that spawns from the fresh page will re-enter this function.
  if (searchActuallyClickedAt > 0 && Date.now() - searchActuallyClickedAt < 2500) {
    return false;
  }

  interestFeeIterationRan = true;

  const MAX_PAGES = 40; // 40 * ~5 rows = 200 transactions — well past a normal ledger
  const NEXT_WAIT_MS = 1500;

  for (let i = 0; i < MAX_PAGES; i++) {
    if (clickReverseFeeOnInterestRow()) return true;
    const next = findNextPaginationButton();
    if (!next) {
      log('  → no more pages; interest row not found in this statement');
      await maybeSwitchToCurrentStatementFallback();
      return true;
    }
    log(`  → clicking pagination "Next" (page iteration ${i + 1})`);
    next.click();
    await sleep(NEXT_WAIT_MS);
  }
  log(`  → reached MAX_PAGES=${MAX_PAGES} without finding interest Reverse Fee`);
  await maybeSwitchToCurrentStatementFallback();
  return true;
}

/** After we've iterated all pages of the currently-selected statement without finding
 *  the interest row, try Current Statement as a fallback (interest may have posted at
 *  the last statement close, before the Recent Activity window opened). Sets
 *  pending_i2c_interest_stmt_attempted so a subsequent content-script instance knows
 *  we've already tried Recent Activity — tryRecentActivity will defer and
 *  tryCurrentStatement will pick Current Statement. */
async function maybeSwitchToCurrentStatementFallback(): Promise<void> {
  const res = await chrome.storage.local.get('pending_i2c_interest_stmt_attempted');
  if (res.pending_i2c_interest_stmt_attempted) {
    log('  → Current Statement fallback already tried; giving up');
    return;
  }
  log('  → interest not found in Recent Activity — switching to Current Statement');
  await chrome.storage.local.set({ pending_i2c_interest_stmt_attempted: 'recent_activity' });

  // Switch the <select> to Current Statement.
  const selects = Array.from(document.querySelectorAll<HTMLSelectElement>('select'));
  let switched = false;
  for (const s of selects) {
    if (!isVisible(s)) continue;
    const target = pickStatementOption(s, 'Current Statement');
    if (!target) continue;
    if (s.value !== target.value) {
      commitSelectOption(s, target);
    }
    switched = true;
    break;
  }
  if (!switched) {
    log('  → could not find Current Statement in dropdown; fallback aborted');
    return;
  }

  // Click Search to apply the Current Statement filter. This reloads the page and a new
  // content-script instance takes over — tryFindAndClickInterestReverseFee re-fires on
  // the Current Statement data.
  await sleep(300);
  const buttons = Array.from(document.querySelectorAll<HTMLElement>('input[type="submit"], input[type="button"], button'));
  for (const b of buttons) {
    const v = ((b as HTMLInputElement).value || b.textContent || '').trim();
    if (/^Search$/i.test(v) && isVisible(b)) {
      log('  → clicking Search to apply Current Statement filter');
      b.click();
      return;
    }
  }
  log('  → could not find Search button for Current Statement fallback');
}

function clickReverseFeeOnInterestRow(): boolean {
  const links = Array.from(document.querySelectorAll<HTMLElement>('a, input[type="button"], input[type="submit"], button'));
  for (const link of links) {
    const rawTxt = ((link as HTMLInputElement).value || link.textContent || '').trim();
    const normalized = rawTxt.replace(/\s+/g, ' ').trim();
    if (!/^Reverse\s*Fee$/i.test(normalized)) continue;
    if (!isVisible(link)) continue;
    const row = link.closest('tr');
    if (!row) continue;
    // Interest rows carry "Interest" in the Description cell (e.g. "Financial Charges -
    // Interest, CAN"). Match on the row's full text so we don't depend on a specific
    // column layout.
    if (!/interest/i.test(row.textContent || '')) continue;
    log('  → clicking Reverse Fee on interest row');
    link.click();
    return true;
  }
  return false;
}

function findNextPaginationButton(): HTMLElement | null {
  // Anchor the search on the "Showing X to Y of Z" counter — that string is unique to
  // i2c's pagination row on the ledger. Walk up 4 levels from the counter and pick a
  // clickable "Next" element in that container. This is more reliable than scanning the
  // whole document for "Next", which risks matching unrelated navigation elsewhere.
  const SHOWING_RE = /Showing\s+\d+\s+to\s+\d+\s+of\s+\d+/i;
  // "Next" as its own word, followed by end-of-string or a non-alphanumeric char (so
  // "Next", "Next >", "Next >|", "Next ›" all match but "Nextpage" would not).
  const NEXT_RE = /^next(\s|$|[^a-z0-9])/i;

  const showingEls = Array.from(document.querySelectorAll<HTMLElement>('*'))
    .filter((el) => SHOWING_RE.test(el.textContent || ''));
  // Prefer the deepest matches — the leaf element that JUST contains the counter, not
  // its wrapping <div>/<td>/<body>. Iterate in reverse doc order to hit leaves first.
  showingEls.reverse();

  for (const showingEl of showingEls) {
    let container: HTMLElement | null = showingEl.parentElement;
    for (let depth = 0; depth < 5 && container; depth++) {
      const candidates = Array.from(container.querySelectorAll<HTMLElement>(
        'a, button, input[type="button"], input[type="submit"], [role="button"], span'
      ));
      for (const el of candidates) {
        const rawText = ((el as HTMLInputElement).value || el.textContent || '').trim();
        const normalized = rawText.replace(/\s+/g, ' ');
        if (!NEXT_RE.test(normalized)) continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        if ((el as HTMLInputElement).disabled) continue;
        if (el.hasAttribute('disabled')) continue;
        if (el.getAttribute('aria-disabled') === 'true') continue;
        if (el.classList.contains('disabled') || el.classList.contains('ui-state-disabled')) continue;
        return el;
      }
      container = container.parentElement;
    }
  }

  // Fallback: fully-permissive scan of the whole document as a last resort, matching
  // any visible clickable "Next" that isn't disabled.
  const anyCandidates = Array.from(document.querySelectorAll<HTMLElement>(
    'a, button, input[type="button"], input[type="submit"], [role="button"]'
  ));
  for (const el of anyCandidates) {
    const rawText = ((el as HTMLInputElement).value || el.textContent || '').trim();
    const normalized = rawText.replace(/\s+/g, ' ');
    if (!NEXT_RE.test(normalized)) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if ((el as HTMLInputElement).disabled) continue;
    if (el.hasAttribute('disabled')) continue;
    if (el.getAttribute('aria-disabled') === 'true') continue;
    if (el.classList.contains('disabled') || el.classList.contains('ui-state-disabled')) continue;
    return el;
  }
  return null;
}

// ----- Reverse-fee (both variants): paste the Jira ticket URL into Comments on the Fee Reversal page -----

let ticketUrlPastedRan = false;
async function tryPasteTicketUrl(): Promise<boolean> {
  if (ticketUrlPastedRan) return true;
  const flow = await getFlow();
  if (flow !== 'reverse_fee' && flow !== 'reverse_interest_fee') return false;
  // Detect by page heuristic — survives the navigation from Account Transactions →
  // Fee Reversal Requests (content script reloads, so module flags reset).
  const body = document.body?.textContent || '';
  if (!/Fee Reversal Request/i.test(body)) return false;
  const textarea = Array.from(document.querySelectorAll<HTMLTextAreaElement>('textarea')).find((t) => isVisible(t));
  if (!textarea) return false;
  const res = await chrome.storage.local.get('pending_i2c_ticket_url');
  const url = res.pending_i2c_ticket_url;
  if (!url || typeof url !== 'string') return false;
  log('  → pasting ticket URL into Comments:', url);
  textarea.focus();
  setTextareaValue(textarea, url);
  ticketUrlPastedRan = true;
  // Chain truly done — agent reviews and clicks "Reverse Fee" submit manually.
  try {
    await chrome.storage.local.remove([PENDING_EMAIL_KEY, 'pending_i2c_flow', 'pending_i2c_ticket_url']);
  } catch { /* fine */ }
  return true;
}

// ----- qc_month_scrape only: set wide Date Range + count months with transactions -----

let dateRangeScrapeRan = false;

async function tryDateRangeScrape(): Promise<boolean> {
  if (dateRangeScrapeRan) return true;
  if ((await getFlow()) !== 'qc_month_scrape') return false;
  if (!(await chainActive())) return false;

  // Must be on Account Transactions (tryAccountTransactions navigated us here).
  const body = document.body?.textContent || '';
  if (!/Below is the list of transaction/i.test(body)) return false;

  // The Search submit reloads the page, so module-level state is lost. We persist
  // "Search has been clicked once for this chain" to storage so the next instance
  // skips Phase 1 and goes straight to scraping.
  const flag = await chrome.storage.local.get('qc_search_clicked');
  const searchAlreadyClicked = !!flag.qc_search_clicked;

  if (!searchAlreadyClicked) {
    // Phase 1: pick Date Range, fill From/To, click Search.
    const selects = Array.from(document.querySelectorAll<HTMLSelectElement>('select'));
    let target: HTMLSelectElement | null = null;
    let drOption: HTMLOptionElement | null = null;
    for (const s of selects) {
      if (!isVisible(s)) continue;
      const opt = Array.from(s.options).find((o) => /^Date\s*Range$/i.test((o.textContent || '').trim()));
      if (opt) { target = s; drOption = opt; break; }
    }
    if (!target || !drOption) { log('  → Date Range select/option not found yet'); return false; }
    if (target.value !== drOption.value) {
      log('  → selecting Date Range option');
      target.focus();
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
      setter?.call(target, drOption.value);
      for (const o of Array.from(target.options)) o.selected = (o === drOption);
      target.dispatchEvent(new Event('input', { bubbles: true }));
      target.dispatchEvent(new Event('change', { bubbles: true }));
      target.blur();
      await sleep(300);
    }

    const today = new Date();
    const fromDate = new Date(today.getFullYear(), today.getMonth() - 14, today.getDate());
    const fromStr = formatMmDdYyyy(fromDate);
    const toStr = formatMmDdYyyy(today);

    const fromInput = findInputByLabelText(/^From/i);
    const toInput = findInputByLabelText(/^To/i);
    if (!fromInput || !toInput) {
      log('  → From/To not found yet (from=', !!fromInput, 'to=', !!toInput, ')');
      return false;
    }
    if (fromInput === toInput) {
      log('  → From and To resolved to the same element — finder needs more disambiguation');
      return false;
    }
    setValue(fromInput, fromStr);
    setValue(toInput, toStr);
    log('  → set Date Range', fromStr, '→', toStr);

    const searchBtn = Array.from(document.querySelectorAll<HTMLElement>('input[type="submit"], input[type="button"], button'))
      .find((b) => /^Search$/i.test(((b as HTMLInputElement).value || b.textContent || '').trim()) && isVisible(b));
    if (!searchBtn) { log('  → Search button not found'); return false; }
    log('  → clicking Search to apply Date Range');
    await chrome.storage.local.set({ qc_search_clicked: true });
    setTimeout(() => searchBtn.click(), 100);
    return false; // wait for page reload + new content script instance
  }

  // Phase 2: search was clicked previously (we're on the reloaded results page). Scrape.
  const tables = Array.from(document.querySelectorAll('table'));
  log('  → Phase 2: scanning', tables.length, 'tables for Trans. Date column');
  for (const table of tables) {
    const allCells = Array.from(table.querySelectorAll<HTMLTableCellElement>('th, td'));
    const dateHeader = allCells.find((c) => /^\s*Trans\.?\s*Date\s*$/i.test((c.textContent || '').trim()));
    if (!dateHeader) continue;

    const dateLeft = dateHeader.getBoundingClientRect().left;
    const headerRow = dateHeader.closest('tr');
    const allRows = Array.from(table.querySelectorAll<HTMLTableRowElement>('tr'));
    const dataRows = allRows.filter((r) => r !== headerRow && r.querySelectorAll(':scope > td, :scope > th').length > 1);
    log('  → found Trans. Date header at left=', Math.round(dateLeft), 'dataRows=', dataRows.length);
    if (dataRows.length === 0) continue;

    const months = new Set<string>();
    for (const row of dataRows) {
      const cells = Array.from(row.querySelectorAll<HTMLTableCellElement>(':scope > td, :scope > th'));
      let best: HTMLTableCellElement | null = null;
      let bestDelta = Infinity;
      for (const c of cells) {
        const left = c.getBoundingClientRect().left;
        const delta = Math.abs(left - dateLeft);
        if (delta < bestDelta && delta < 40) { bestDelta = delta; best = c; }
      }
      const txt = (best?.textContent || '').trim();
      const m = txt.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
      if (m) months.add(`${m[3]}-${m[1].padStart(2, '0')}`);
    }

    if (months.size === 0) { log('  → no date matches in this table; trying next'); continue; }

    const breakdown = Array.from(months).sort();
    const ctx = await chrome.storage.local.get('pending_i2c_source_ticket_id');
    const sourceTicketId = typeof ctx.pending_i2c_source_ticket_id === 'string' ? ctx.pending_i2c_source_ticket_id : '';

    log('  → captured', months.size, 'distinct months:', breakdown);
    await chrome.storage.local.set({
      qc_month_scrape_result: {
        sourceTicketId,
        monthsUsed: months.size,
        monthsBreakdown: breakdown,
        capturedAt: new Date().toISOString(),
      },
    });
    dateRangeScrapeRan = true;
    await clearAllPendingKeys();
    return true;
  }
  return false;
}

function formatMmDdYyyy(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${mm}/${dd}/${d.getFullYear()}`;
}

// ----- apply_credit only: pre-fill Admin Credit form -----

let applyCreditFilledRan = false;
async function tryFillApplyCredit(): Promise<boolean> {
  if (applyCreditFilledRan) return true;
  if ((await getFlow()) !== 'apply_credit') return false;
  const body = document.body?.textContent || '';
  if (!/Apply desired service to the card account/i.test(body)) return false;

  const ctx = await chrome.storage.local.get(['pending_i2c_admin_credit_amount', 'pending_i2c_ticket_url']);
  const amountText = typeof ctx.pending_i2c_admin_credit_amount === 'string' ? ctx.pending_i2c_admin_credit_amount : '';
  const ticketUrl = typeof ctx.pending_i2c_ticket_url === 'string' ? ctx.pending_i2c_ticket_url : '';
  if (!amountText || !ticketUrl) { log('  → apply_credit context missing'); return false; }

  const selects = Array.from(document.querySelectorAll<HTMLSelectElement>('select'));
  let serviceSelect: HTMLSelectElement | null = null;
  let targetOpt: HTMLOptionElement | null = null;
  for (const s of selects) {
    if (!isVisible(s)) continue;
    const opt = Array.from(s.options).find((o) => /^Admin\s*Funds?\s*Credit$/i.test((o.textContent || '').trim()));
    if (opt) { serviceSelect = s; targetOpt = opt; break; }
  }
  if (!serviceSelect || !targetOpt) { log('  → Admin Funds Credit option not found yet'); return false; }

  if (serviceSelect.value !== targetOpt.value) {
    log('  → selecting Admin Funds Credit');
    serviceSelect.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
    setter?.call(serviceSelect, targetOpt.value);
    for (const o of Array.from(serviceSelect.options)) o.selected = (o === targetOpt);
    serviceSelect.dispatchEvent(new Event('input', { bubbles: true }));
    serviceSelect.dispatchEvent(new Event('change', { bubbles: true }));
    serviceSelect.blur();
    await sleep(250);
  }

  const amountInput = findInputByLabelText(/^Amount/i);
  if (amountInput && amountInput.value !== amountText) {
    log('  → filling Amount:', amountText);
    setValue(amountInput, amountText);
  }

  const commentsArea = findTextareaByLabelText(/^Comments/i);
  if (commentsArea && commentsArea.value !== ticketUrl) {
    log('  → filling Comments with ticket URL');
    setTextareaValue(commentsArea, ticketUrl);
  }

  if (amountInput && commentsArea) {
    applyCreditFilledRan = true;
    await clearAllPendingKeys();
    return true;
  }
  return false;
}

async function bootstrap() {
  // Each pass attempts every step. Most return false immediately because the page in
  // question doesn't have the target element. Keep polling for 30s so slow renders
  // (Account Transactions in particular can take a few seconds to fully load) don't
  // strand the chain.
  async function pass() {
    await tryAutofill();
    await tryKillSession();
    await tryEmailSearch();
    await tryContinueWithCustomer();
    await tryAccountTransactions();
    await tryAdminServices();
    await tryRecentActivity();
    await tryCurrentStatement();
    await tryClickSearch();
    await tryReadRunningBalance();
    await tryFindAndClickReverseFee();
    await tryFindAndClickInterestReverseFee();
    await tryPasteTicketUrl();
    await tryFillAdminDebit();
    await tryDateRangeScrape();
    await tryFillApplyCredit();
  }
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try { await pass(); } catch (e) { console.error('[wocoo-i2c] tick error', e); }
    // Every terminal step (verify_balance → tryReadRunningBalance, reverse_fee →
    // tryPasteTicketUrl, admin_debit → tryFillAdminDebit, null → tryContinueWithCustomer)
    // clears pending_i2c_email. So when chainActive() returns false, we're done.
    if (!(await chainActive())) break;
    await sleep(500);
  }
  // If the 30s budget elapsed without a terminal step clearing the keys, clean them up
  // ourselves so they don't ambush the next manual visit to i2c.
  if (await chainActive()) {
    log('30s deadline reached without completion — clearing leftover pending keys');
    await clearAllPendingKeys();
  }
}

bootstrap();
