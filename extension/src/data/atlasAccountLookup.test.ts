import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./atlasGraphql', () => ({
  fetchAtlasAccountIdViaGraphql: vi.fn(),
  fetchAtlasClientDetailsViaGraphql: vi.fn(),
}));

import { fetchAtlasAccountIdViaGraphql, fetchAtlasClientDetailsViaGraphql } from './atlasGraphql';
import { fetchAtlasAccountIdHeadless, fetchAtlasClientDetailsHeadless } from './atlasAccountLookup';

const GRAPHQL_RESULT = { accountNumber: 'WK6RQDY37CAD', individualTierStatus: 'Premium' };
const TAB_RESULT = { accountNumber: 'WTABFALLBACKCAD', individualTierStatus: null };

/**
 * Minimal chrome stub for the tab path. `tabs.create` resolves, then we immediately
 * fire the storage change the content script would have written.
 */
function stubChrome() {
  const listeners: Array<(c: Record<string, { newValue: unknown }>, area: string) => void> = [];
  const chromeStub = {
    storage: {
      local: {
        set: vi.fn((_items: Record<string, unknown>) => Promise.resolve()),
        remove: vi.fn(() => Promise.resolve()),
      },
      onChanged: {
        addListener: vi.fn((fn: (typeof listeners)[number]) => { listeners.push(fn); }),
        removeListener: vi.fn(),
      },
    },
    tabs: {
      create: vi.fn(() => {
        // Deliver the scrape on the next tick, once the listener is registered.
        setTimeout(() => {
          for (const fn of listeners) {
            fn({ atlas_account_number: { newValue: { sourceTicketId: 'WOCOO-1', ...TAB_RESULT } } }, 'local');
          }
        }, 0);
        return Promise.resolve({ id: 42 });
      }),
      remove: vi.fn(() => Promise.resolve()),
    },
  };
  vi.stubGlobal('chrome', chromeStub);
  return chromeStub;
}

beforeEach(() => {
  vi.mocked(fetchAtlasAccountIdViaGraphql).mockReset();
  vi.mocked(fetchAtlasClientDetailsViaGraphql).mockReset();
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('fetchAtlasAccountIdHeadless', () => {
  it('returns the GraphQL result and never opens a tab', async () => {
    const chromeStub = stubChrome();
    vi.mocked(fetchAtlasAccountIdViaGraphql).mockResolvedValue(GRAPHQL_RESULT);

    const result = await fetchAtlasAccountIdHeadless({ identityId: 'identity-1', sourceTicketId: 'WOCOO-1' });

    expect(result).toEqual(GRAPHQL_RESULT);
    expect(chromeStub.tabs.create).not.toHaveBeenCalled();
  });

  it('passes only the identityId to the GraphQL path', async () => {
    stubChrome();
    vi.mocked(fetchAtlasAccountIdViaGraphql).mockResolvedValue(GRAPHQL_RESULT);

    await fetchAtlasAccountIdHeadless({ identityId: 'identity-1', sourceTicketId: 'WOCOO-1' });

    expect(fetchAtlasAccountIdViaGraphql).toHaveBeenCalledWith({ identityId: 'identity-1' });
  });

  it('falls back to the background tab when GraphQL throws', async () => {
    const chromeStub = stubChrome();
    vi.mocked(fetchAtlasAccountIdViaGraphql).mockRejectedValue(new Error('HTTP 403'));

    const result = await fetchAtlasAccountIdHeadless({ identityId: 'identity-1', sourceTicketId: 'WOCOO-1' });

    expect(result.accountNumber).toBe('WTABFALLBACKCAD');
    expect(chromeStub.tabs.create).toHaveBeenCalledTimes(1);
  });

  // SidePanel renders the W# chip from this storage key, not from the return value.
  // Skipping the write made the GraphQL path succeed with no visible UI change.
  it('mirrors the GraphQL result into atlas_account_number so the UI updates', async () => {
    const chromeStub = stubChrome();
    vi.mocked(fetchAtlasAccountIdViaGraphql).mockResolvedValue(GRAPHQL_RESULT);

    await fetchAtlasAccountIdHeadless({ identityId: 'identity-1', sourceTicketId: 'WOCOO-1' });

    expect(chromeStub.storage.local.set).toHaveBeenCalledTimes(1);
    const written = chromeStub.storage.local.set.mock.calls[0][0] as unknown as {
      atlas_account_number: { sourceTicketId: string; accountNumber: string; individualTierStatus: string | null; capturedAt: string };
    };
    expect(written.atlas_account_number.sourceTicketId).toBe('WOCOO-1');
    expect(written.atlas_account_number.accountNumber).toBe('WK6RQDY37CAD');
    expect(written.atlas_account_number.individualTierStatus).toBe('Premium');
    expect(written.atlas_account_number.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('logs which path produced the result', async () => {
    stubChrome();
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.mocked(fetchAtlasAccountIdViaGraphql).mockResolvedValue(GRAPHQL_RESULT);

    await fetchAtlasAccountIdHeadless({ identityId: 'identity-1', sourceTicketId: 'WOCOO-1' });

    expect(info.mock.calls.flat().join(' ')).toMatch(/graphql/i);
  });
});

const DETAILS_RESULT = {
  name: 'Duncan Stevenson',
  street: 'Unit 2, 101 Roseview Avenue',
  cityProvince: 'Richmond Hill, ON',
  postal: 'L4C 1C6',
  complete: true,
};

describe('fetchAtlasClientDetailsHeadless', () => {
  it('returns the GraphQL result and never opens a tab', async () => {
    const chromeStub = stubChrome();
    vi.mocked(fetchAtlasClientDetailsViaGraphql).mockResolvedValue(DETAILS_RESULT);

    const out = await fetchAtlasClientDetailsHeadless({ identityId: 'identity-1', sourceTicketId: 'WOCOO-1' });

    expect(out).toEqual(DETAILS_RESULT);
    expect(chromeStub.tabs.create).not.toHaveBeenCalled();
    expect(fetchAtlasClientDetailsViaGraphql).toHaveBeenCalledWith({ identityId: 'identity-1' });
  });

  // The Refund Auth Letter step reads this key, not the return value.
  it('mirrors the result into atlas_client_details', async () => {
    const chromeStub = stubChrome();
    vi.mocked(fetchAtlasClientDetailsViaGraphql).mockResolvedValue(DETAILS_RESULT);

    await fetchAtlasClientDetailsHeadless({ identityId: 'identity-1', sourceTicketId: 'WOCOO-1' });

    const written = chromeStub.storage.local.set.mock.calls[0][0] as unknown as {
      atlas_client_details: Record<string, unknown>;
    };
    expect(written.atlas_client_details).toMatchObject({
      sourceTicketId: 'WOCOO-1',
      name: 'Duncan Stevenson',
      street: 'Unit 2, 101 Roseview Avenue',
      cityProvince: 'Richmond Hill, ON',
      postal: 'L4C 1C6',
      complete: true,
    });
    expect(String(written.atlas_client_details.capturedAt)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('falls back to the background tab when GraphQL throws', async () => {
    const chromeStub = stubChrome();
    vi.mocked(fetchAtlasClientDetailsViaGraphql).mockRejectedValue(new Error('HTTP 403'));

    // The tab stub only delivers atlas_account_number, so the details tab path never
    // resolves — a short timeout is enough to prove the fallback was entered.
    await expect(
      fetchAtlasClientDetailsHeadless({ identityId: 'identity-1', sourceTicketId: 'WOCOO-1', timeoutMs: 20 }),
    ).rejects.toThrow(/timed out/i);
    expect(chromeStub.tabs.create).toHaveBeenCalledTimes(1);
  });
});
