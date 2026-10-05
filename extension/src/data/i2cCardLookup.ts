// Headless i2c card lookup.
//
// Opens i2c in a background tab with the `card_details` flow flag set, waits for the
// i2c.ts content script to scrape the customer's card numbers into
// `chrome.storage.local.i2c_card_details`, then closes the tab. Backs the Refund Auth
// Letter workflow's step 2, where the letter needs the closed and new card last 4.
//
// i2c's status column says which is which (ACTIVE vs CLOSED CARD), so the workflow
// auto-assigns when there's exactly one of each and falls back to clickable chips.
//
// openI2cSession() is the batch variant (Insurance Eligibility Resolve): one background
// tab signs in once and is re-pointed at Customer Search for each lookup. i2c allows one
// session per user, so its lookups run strictly one at a time.

import { createSerialQueue } from './serialQueue';

export const I2C_LOGIN_URL = 'https://wealthsimplecs.mycardplace.com/customerservice/wealthsimplelogin.jsp';
/** Customer Search — where a signed-in session starts the next lookup. */
export const I2C_HOME_URL = 'https://wealthsimplecs.mycardplace.com/customerservice/CSHome.do';

export interface FetchI2cCardDetailsArgs {
  clientEmail: string;
  sourceTicketId: string;
  /** i2c's login + search + customer-page chain is slower than Atlas's single page. */
  timeoutMs?: number;
}

export interface I2cCard {
  /** Last 4 digits. */
  last4: string;
  /** i2c's status wording, e.g. 'ACTIVE', 'ACTIVE (Reissued)', 'CLOSED CARD'. */
  status: string;
  /** True when the status reads CLOSED — the card the refund was declined on. */
  closed: boolean;
  /** Accounts table "Program", e.g. 'Wealthsimple Visa Infinite VIP 01 Physical'. */
  program?: string;
  /** Card Details "Delinquency Status". Only set when the page shows exactly one open card. */
  delinquencyStatus?: string;
  /** Card Details "Card Creation Date" (MM/DD/YYYY). Only set when exactly one open card. */
  creationDate?: string;
}

type ChangeListener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => void;

/** The chrome calls the lookups make — injectable so the session is unit-tested. */
export interface I2cChromeDeps {
  storageGet(keys: string[]): Promise<Record<string, unknown>>;
  storageSet(items: Record<string, unknown>): Promise<void>;
  storageRemove(keys: string[]): Promise<void>;
  addChangeListener(fn: ChangeListener): void;
  removeChangeListener(fn: ChangeListener): void;
  tabsCreate(props: { url: string; active: boolean }): Promise<{ id?: number }>;
  tabsUpdate(tabId: number, props: { url: string }): Promise<unknown>;
  tabsRemove(tabId: number): Promise<void>;
  sleep(ms: number): Promise<void>;
}

function chromeDeps(): I2cChromeDeps {
  return {
    storageGet: (keys) => chrome.storage.local.get(keys),
    storageSet: (items) => chrome.storage.local.set(items),
    storageRemove: (keys) => chrome.storage.local.remove(keys),
    addChangeListener: (fn) => chrome.storage.onChanged.addListener(fn),
    removeChangeListener: (fn) => chrome.storage.onChanged.removeListener(fn),
    tabsCreate: (props) => chrome.tabs.create(props),
    tabsUpdate: (tabId, props) => chrome.tabs.update(tabId, props),
    tabsRemove: (tabId) => chrome.tabs.remove(tabId),
    sleep: (ms) => new Promise<void>((r) => setTimeout(r, ms)),
  };
}

/** Arm the i2c.ts content script's card_details chain for one email. */
async function writePendingKeys(deps: I2cChromeDeps, clientEmail: string, sourceTicketId: string): Promise<void> {
  await deps.storageSet({
    pending_i2c_email: clientEmail,
    pending_i2c_flow: 'card_details',
    pending_i2c_source_ticket_id: sourceTicketId,
    pending_i2c_started_at: Date.now(),
  });
  // Leftover keys from an earlier flow would send the chain down the wrong branch.
  await deps.storageRemove(['pending_i2c_ticket_url', 'pending_i2c_admin_debit_amount']);
}

interface CardDetailsWait {
  result: Promise<I2cCard[]>;
  /** Stop waiting: drop the listener and timer, and reject `result` with `reason`. */
  cancel(reason: Error): void;
}

/** Wait for the content script to write `i2c_card_details` for `sourceTicketId`.
 *  `onSettle` runs once, on success, timeout or cancel. */
function awaitCardDetails(
  deps: I2cChromeDeps, sourceTicketId: string, timeoutMs: number, onSettle: () => void = () => {},
): CardDetailsWait {
  let cancel: (reason: Error) => void = () => {};
  const result = new Promise<I2cCard[]>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      settled = true;
      deps.removeChangeListener(onChange);
      clearTimeout(timer);
      onSettle();
    };
    const onChange: ChangeListener = (changes, area) => {
      if (settled || area !== 'local' || !('i2c_card_details' in changes)) return;
      const v = changes.i2c_card_details.newValue as {
        sourceTicketId?: string;
        cards?: I2cCard[];
      } | undefined;
      if (v && v.sourceTicketId === sourceTicketId && Array.isArray(v.cards)) {
        cleanup();
        resolve(v.cards);
      }
    };
    deps.addChangeListener(onChange);
    const timer = setTimeout(() => {
      if (settled) return;
      cleanup();
      reject(new Error('i2c card lookup timed out — the chain may have stopped at login or the customer search'));
    }, timeoutMs);
    cancel = (reason) => {
      if (settled) return;
      cleanup();
      reject(reason);
    };
  });
  return { result, cancel: (reason) => cancel(reason) };
}

export async function fetchI2cCardDetailsHeadless(args: FetchI2cCardDetailsArgs): Promise<I2cCard[]> {
  const { clientEmail, sourceTicketId, timeoutMs = 75_000 } = args;
  if (!clientEmail) throw new Error('clientEmail is required');
  if (!sourceTicketId) throw new Error('sourceTicketId is required');

  const deps = chromeDeps();
  await writePendingKeys(deps, clientEmail, sourceTicketId);

  const tab = await deps.tabsCreate({ url: I2C_LOGIN_URL, active: false });
  const tabId = tab.id ?? null;

  return awaitCardDetails(deps, sourceTicketId, timeoutMs, () => {
    if (tabId != null) {
      void deps.tabsRemove(tabId).catch(() => { /* tab may already be closed */ });
    }
  }).result;
}

export interface I2cSession {
  /** Look up one email's cards. Calls queue FIFO; only one runs at a time. Default timeout
   *  75 s when the lookup has to sign in a fresh tab, 60 s in an already signed-in one. */
  lookup(email: string, sourceTicketId: string, timeoutMs?: number): Promise<I2cCard[]>;
  /** Close the shared tab, clear the pending chain keys and stop any in-flight wait.
   *  Later lookups reject. */
  close(): Promise<void>;
}

/** How long to wait for the previous chain's content script to clear its pending keys
 *  (it does so just after writing the result) before arming the next lookup. */
const CHAIN_IDLE_MAX_MS = 2_000;
const CHAIN_IDLE_POLL_MS = 100;
const FRESH_TAB_TIMEOUT_MS = 75_000;
const SIGNED_IN_TIMEOUT_MS = 60_000;

/** Every key the i2c.ts chain reads — mirrors its ALL_PENDING_KEYS. */
const I2C_PENDING_KEYS = [
  'pending_i2c_email',
  'pending_i2c_source_ticket_id',
  'pending_i2c_flow',
  'pending_i2c_ticket_url',
  'pending_i2c_admin_debit_amount',
  'pending_i2c_started_at',
  'pending_i2c_interest_stmt_attempted',
  'qc_search_clicked',
];

export function openI2cSession(deps: I2cChromeDeps = chromeDeps()): I2cSession {
  const queue = createSerialQueue();
  let tabId: number | null = null;
  let closed = false;
  let current: CardDetailsWait | null = null;
  let seq = 0;

  const closedError = () => new Error('i2c session closed');

  // The content script clears every pending key right after it writes i2c_card_details,
  // so the panel can hear the result first. Writing the next lookup's keys before that
  // remove lands would have them wiped and the next chain would never start.
  // Returns false when the keys are still there at the limit: a chain is still live.
  async function waitForChainIdle(): Promise<boolean> {
    for (let waited = 0; waited < CHAIN_IDLE_MAX_MS; waited += CHAIN_IDLE_POLL_MS) {
      const res = await deps.storageGet(['pending_i2c_email']);
      if (typeof res.pending_i2c_email !== 'string') return true;
      await deps.sleep(CHAIN_IDLE_POLL_MS);
    }
    return false;
  }

  /** Kill the tab and its chain. A chain left running there would scrape its customer
   *  under whatever lookup's keys come next, so the next lookup must start in a new tab. */
  async function resetTab(): Promise<void> {
    if (tabId != null) {
      const id = tabId;
      tabId = null;
      await deps.tabsRemove(id).catch(() => { /* tab may already be closed */ });
    }
    await deps.storageRemove(I2C_PENDING_KEYS).catch(() => { /* fine */ });
  }

  /** Returns true when it had to open a fresh tab at the login page. */
  async function pointTabAtSearch(): Promise<boolean> {
    if (tabId != null) {
      try {
        await deps.tabsUpdate(tabId, { url: I2C_HOME_URL });
        return false;
      } catch {
        tabId = null; // closed by the user — sign in again in a fresh tab
      }
    }
    const tab = await deps.tabsCreate({ url: I2C_LOGIN_URL, active: false });
    tabId = tab.id ?? null;
    return true;
  }

  return {
    lookup(email, sourceTicketId, timeoutMs) {
      return queue.run(async () => {
        if (closed) throw closedError();
        if (!email) throw new Error('clientEmail is required');
        if (!sourceTicketId) throw new Error('sourceTicketId is required');
        // Unique per lookup, so a late result from any earlier lookup (including another
        // email of the same request) can never satisfy this one.
        const routeId = `${sourceTicketId}#${++seq}`;
        if (tabId != null && !(await waitForChainIdle())) await resetTab();
        await writePendingKeys(deps, email, routeId);
        const fresh = await pointTabAtSearch();
        if (closed) {
          // close() ran while the tab was opening and couldn't see its id yet.
          await resetTab();
          throw closedError();
        }
        const wait = awaitCardDetails(
          deps, routeId, timeoutMs ?? (fresh ? FRESH_TAB_TIMEOUT_MS : SIGNED_IN_TIMEOUT_MS), () => { current = null; },
        );
        current = wait;
        try {
          return await wait.result;
        } catch (e) {
          // Timed out: the chain may still be running. Kill it before the queue moves on.
          if (!closed) await resetTab();
          throw e;
        }
      });
    },
    async close() {
      closed = true;
      current?.cancel(closedError());
      current = null;
      // End of the batch: nothing else should pick up this session's chain keys.
      await resetTab();
    },
  };
}
