import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./atlasGraphql', () => ({ fetchAtlasAccountIdViaGraphql: vi.fn() }));

import { fetchAtlasAccountIdViaGraphql } from './atlasGraphql';
import { fetchAtlasAccountIdHeadless } from './atlasAccountLookup';

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
      local: { set: vi.fn(() => Promise.resolve()), remove: vi.fn(() => Promise.resolve()) },
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

  it('logs which path produced the result', async () => {
    stubChrome();
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.mocked(fetchAtlasAccountIdViaGraphql).mockResolvedValue(GRAPHQL_RESULT);

    await fetchAtlasAccountIdHeadless({ identityId: 'identity-1', sourceTicketId: 'WOCOO-1' });

    expect(info.mock.calls.flat().join(' ')).toMatch(/graphql/i);
  });
});
