// Headless i2c card lookup.
//
// Opens i2c in a background tab with the `card_details` flow flag set, waits for the
// i2c.ts content script to scrape the customer's card numbers into
// `chrome.storage.local.i2c_card_details`, then closes the tab. Backs the Refund Auth
// Letter workflow's step 2, where the letter needs the closed and new card last 4.
//
// i2c's status column says which is which (ACTIVE vs CLOSED CARD), so the workflow
// auto-assigns when there's exactly one of each and falls back to clickable chips.

export const I2C_LOGIN_URL = 'https://wealthsimplecs.mycardplace.com/customerservice/wealthsimplelogin.jsp';

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
}

export async function fetchI2cCardDetailsHeadless(args: FetchI2cCardDetailsArgs): Promise<I2cCard[]> {
  const { clientEmail, sourceTicketId, timeoutMs = 75_000 } = args;
  if (!clientEmail) throw new Error('clientEmail is required');
  if (!sourceTicketId) throw new Error('sourceTicketId is required');

  await chrome.storage.local.set({
    pending_i2c_email: clientEmail,
    pending_i2c_flow: 'card_details',
    pending_i2c_source_ticket_id: sourceTicketId,
    pending_i2c_started_at: Date.now(),
  });
  // Leftover keys from an earlier flow would send the chain down the wrong branch.
  await chrome.storage.local.remove(['pending_i2c_ticket_url', 'pending_i2c_admin_debit_amount']);

  const tab = await chrome.tabs.create({ url: I2C_LOGIN_URL, active: false });
  const tabId = tab.id ?? null;

  return new Promise<I2cCard[]>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      settled = true;
      chrome.storage.onChanged.removeListener(onChange);
      window.clearTimeout(timer);
      if (tabId != null) {
        void chrome.tabs.remove(tabId).catch(() => { /* tab may already be closed */ });
      }
    };
    const onChange = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
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
    chrome.storage.onChanged.addListener(onChange);
    const timer = window.setTimeout(() => {
      if (settled) return;
      cleanup();
      reject(new Error('i2c card lookup timed out — the chain may have stopped at login or the customer search'));
    }, timeoutMs);
  });
}
