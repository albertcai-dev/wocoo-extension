// Headless Atlas account-number lookup.
//
// Opens Atlas in a background tab (`chrome.tabs.create({ active: false })`), waits for
// the atlas.ts content script to scrape the CHEQUING (SPEND) account number into
// `chrome.storage.local.atlas_account_number`, then closes the tab and resolves with the
// captured value. Used by every "Fetch Account Number / Fetch Account ID" button in the
// extension so we don't duplicate the open/listen/close pattern.
//
// The atlas content script's polling deadline is 30s; we wait 35s before giving up and
// closing the tab.

import { fetchAtlasAccountIdViaGraphql, fetchAtlasClientDetailsViaGraphql } from './atlasGraphql';
import type { AtlasLookupResult } from './atlasGraphql';

// Re-exported so importers of this module keep working after the type moved to
// atlasGraphql.ts (moved to avoid an import cycle between the two).
export type { AtlasLookupResult } from './atlasGraphql';

export interface FetchAtlasAccountIdArgs {
  identityId: string;
  sourceTicketId: string;
  /** Override the default 35s timeout. */
  timeoutMs?: number;
}

/**
 * Tries Atlas's GraphQL API first and falls back to the background-tab scrape.
 *
 * The one thing that cannot be verified outside a loaded extension is whether Atlas's
 * cookies ride a fetch initiated from a chrome-extension:// origin — SameSite=Lax
 * cookies are not sent cross-site. If they do not, GraphQL returns 401/403 and this
 * silently uses the old path, so the button behaves exactly as it did before.
 *
 * The fallback also covers an operation being renamed or a service moving.
 */
export async function fetchAtlasAccountIdHeadless(
  args: FetchAtlasAccountIdArgs,
): Promise<AtlasLookupResult> {
  try {
    const result = await fetchAtlasAccountIdViaGraphql({ identityId: args.identityId });
    // The tab path's real output is this storage key, not its return value: SidePanel
    // renders the W# chip from `atlas_account_number` via a storage listener. Writing it
    // here is what makes the GraphQL path visible in the UI — without it the lookup
    // succeeds silently and the card stays empty.
    await chrome.storage.local.set({
      atlas_account_number: {
        sourceTicketId: args.sourceTicketId || '',
        accountNumber: result.accountNumber,
        individualTierStatus: result.individualTierStatus,
        capturedAt: new Date().toISOString(),
      },
    });
    console.info('[atlas] account lookup via GraphQL:', result.accountNumber);
    return result;
  } catch (err) {
    console.warn('[atlas] GraphQL lookup failed, falling back to a background tab:', err);
    const result = await fetchAtlasAccountIdViaTab(args);
    console.info('[atlas] account lookup via background tab:', result.accountNumber);
    return result;
  }
}

export async function fetchAtlasAccountIdViaTab(args: FetchAtlasAccountIdArgs): Promise<AtlasLookupResult> {
  const { identityId, sourceTicketId, timeoutMs = 35_000 } = args;
  if (!identityId) throw new Error('identityId is required');
  if (!sourceTicketId) throw new Error('sourceTicketId is required');

  await chrome.storage.local.set({ pending_atlas_account_lookup: { sourceTicketId } });
  const url = `https://atlas.wealthsimple.com/identity/${identityId}/overview/?ticketId=${sourceTicketId}`;
  const tab = await chrome.tabs.create({ url, active: false });
  const tabId = tab.id ?? null;

  return new Promise<AtlasLookupResult>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      settled = true;
      chrome.storage.onChanged.removeListener(onChange);
      clearTimeout(timer);
      if (tabId != null) {
        void chrome.tabs.remove(tabId).catch(() => { /* tab may already be closed */ });
      }
    };
    const onChange = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (settled || area !== 'local' || !('atlas_account_number' in changes)) return;
      const v = changes.atlas_account_number.newValue as {
        sourceTicketId?: string;
        accountNumber?: string;
        individualTierStatus?: string | null;
      } | undefined;
      if (v && v.sourceTicketId === sourceTicketId && typeof v.accountNumber === 'string' && v.accountNumber) {
        cleanup();
        resolve({
          accountNumber: v.accountNumber.toUpperCase(),
          individualTierStatus: typeof v.individualTierStatus === 'string' ? v.individualTierStatus : null,
        });
      }
    };
    chrome.storage.onChanged.addListener(onChange);
    // Bare setTimeout, not window.setTimeout: `window` does not exist in an MV3
    // service worker, and the bare global is what makes this testable under Node.
    const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
      if (settled) return;
      cleanup();
      reject(new Error('Atlas account lookup timed out'));
    }, timeoutMs);
  });
}

// -----------------------------------------------------------------------------
// Headless Atlas client-email lookup.
//
// Opens Atlas in a background tab, waits for the atlas.ts email IIFE to scrape the
// "Email" field from the identity homepage sidebar into
// `chrome.storage.local.atlas_client_email`, then closes the tab. Used by Reverse Fee
// on Interest-Related Issues tickets, where the ticket doesn't carry a clientEmail.
// -----------------------------------------------------------------------------

export interface FetchAtlasClientEmailArgs {
  identityId: string;
  sourceTicketId: string;
  timeoutMs?: number;
}

export async function fetchAtlasClientEmailHeadless(args: FetchAtlasClientEmailArgs): Promise<string> {
  const { identityId, sourceTicketId, timeoutMs = 35_000 } = args;
  if (!identityId) throw new Error('identityId is required');
  if (!sourceTicketId) throw new Error('sourceTicketId is required');

  await chrome.storage.local.set({ pending_atlas_client_email_lookup: { sourceTicketId } });
  const url = `https://atlas.wealthsimple.com/identity/${identityId}/overview/?ticketId=${sourceTicketId}`;
  const tab = await chrome.tabs.create({ url, active: false });
  const tabId = tab.id ?? null;

  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      settled = true;
      chrome.storage.onChanged.removeListener(onChange);
      clearTimeout(timer);
      if (tabId != null) {
        void chrome.tabs.remove(tabId).catch(() => { /* tab may already be closed */ });
      }
    };
    const onChange = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (settled || area !== 'local' || !('atlas_client_email' in changes)) return;
      const v = changes.atlas_client_email.newValue as {
        sourceTicketId?: string;
        email?: string;
      } | undefined;
      if (v && v.sourceTicketId === sourceTicketId && typeof v.email === 'string' && v.email) {
        cleanup();
        resolve(v.email);
      }
    };
    chrome.storage.onChanged.addListener(onChange);
    const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
      if (settled) return;
      cleanup();
      reject(new Error('Atlas client email lookup timed out'));
    }, timeoutMs);
  });
}

// -----------------------------------------------------------------------------
// Headless Atlas client-details lookup (name + mailing address).
//
// Backs the Refund Auth Letter workflow's "Fetch from Atlas" step. Opens Atlas in a
// background tab, waits for the atlas.ts clientDetailsLookup IIFE to scrape the Full
// Client Details grid into `chrome.storage.local.atlas_client_details`, then closes it.
//
// `complete: false` means Atlas rendered without one of city/postal — the values still
// come back and the workflow leaves them editable.
// -----------------------------------------------------------------------------

export interface FetchAtlasClientDetailsArgs {
  identityId: string;
  sourceTicketId: string;
  timeoutMs?: number;
}

export interface AtlasClientDetails {
  name: string;
  street: string;
  cityProvince: string;
  postal: string;
  complete: boolean;
}

/**
 * Tries getProfileV2 first and falls back to the background-tab scrape.
 *
 * Same shape as fetchAtlasAccountIdHeadless: on success it mirrors the result into
 * `atlas_client_details`, because that storage key — not the return value — is what the
 * Refund Auth Letter step reads through its storage listener.
 */
export async function fetchAtlasClientDetailsHeadless(
  args: FetchAtlasClientDetailsArgs,
): Promise<AtlasClientDetails> {
  try {
    const details = await fetchAtlasClientDetailsViaGraphql({ identityId: args.identityId });
    await chrome.storage.local.set({
      atlas_client_details: {
        sourceTicketId: args.sourceTicketId || '',
        ...details,
        capturedAt: new Date().toISOString(),
      },
    });
    console.info('[atlas] client details via GraphQL; complete:', details.complete);
    return details;
  } catch (err) {
    console.warn('[atlas] GraphQL client details failed, falling back to a background tab:', err);
    const details = await fetchAtlasClientDetailsViaTab(args);
    console.info('[atlas] client details via background tab; complete:', details.complete);
    return details;
  }
}

export async function fetchAtlasClientDetailsViaTab(args: FetchAtlasClientDetailsArgs): Promise<AtlasClientDetails> {
  const { identityId, sourceTicketId, timeoutMs = 35_000 } = args;
  if (!identityId) throw new Error('identityId is required');
  if (!sourceTicketId) throw new Error('sourceTicketId is required');

  await chrome.storage.local.set({ pending_atlas_client_details_lookup: { sourceTicketId } });
  const url = `https://atlas.wealthsimple.com/identity/${identityId}/overview/?ticketId=${sourceTicketId}`;
  const tab = await chrome.tabs.create({ url, active: false });
  const tabId = tab.id ?? null;

  return new Promise<AtlasClientDetails>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      settled = true;
      chrome.storage.onChanged.removeListener(onChange);
      clearTimeout(timer);
      if (tabId != null) {
        void chrome.tabs.remove(tabId).catch(() => { /* tab may already be closed */ });
      }
    };
    const onChange = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (settled || area !== 'local' || !('atlas_client_details' in changes)) return;
      const v = changes.atlas_client_details.newValue as {
        sourceTicketId?: string;
        name?: string;
        street?: string;
        cityProvince?: string;
        postal?: string;
        complete?: boolean;
      } | undefined;
      if (v && v.sourceTicketId === sourceTicketId && (v.name || v.street)) {
        cleanup();
        resolve({
          name: v.name || '',
          street: v.street || '',
          cityProvince: v.cityProvince || '',
          postal: v.postal || '',
          complete: Boolean(v.complete),
        });
      }
    };
    chrome.storage.onChanged.addListener(onChange);
    const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
      if (settled) return;
      cleanup();
      reject(new Error('Atlas client details lookup timed out — check the Full Client Details section rendered'));
    }, timeoutMs);
  });
}
