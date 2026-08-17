import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  atlasGraphql,
  readIndividualTier,
  readSpendAccountCanonicalId,
  readSpendCustodianAccountNumber,
} from './atlasGraphql';

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(impl: (url: string, init: RequestInit) => Response) {
  const spy = vi.fn((url: unknown, init: unknown) =>
    Promise.resolve(impl(String(url), (init ?? {}) as RequestInit)));
  vi.stubGlobal('fetch', spy);
  return spy;
}

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

// Recorded from graphql/fort_knox, operation WsBankAccount.
const WS_BANK_ACCOUNT_RES = {
  data: {
    funding_methods: [
      {
        account_number: '49671100',
        id: 'funding_method-5ZRGFsJx27JBrJEvuEwdFC5JPuj',
        institution_number: '703',
        transit_number: '00001',
        account_canonical_id: 'ca-cash-msb-i_ma5GMI2g',
        __typename: 'WsBankAccount',
      },
    ],
  },
};

// Shape from the graphql/wealthsimple getAccountDetails document. Both custodian
// ids are real ones observed on the same client.
const ACCOUNT_DETAILS_RES = {
  data: {
    account: {
      id: 'ca-cash-msb-i_ma5GMI2g',
      custodianAccounts: [
        { custodianAccountId: 'C14792J29CAD', __typename: 'CustodianAccount' },
        { custodianAccountId: 'WK6RQDY37CAD', __typename: 'CustodianAccount' },
      ],
      __typename: 'Account',
    },
  },
};

// Recorded from graphql/invest_graphql_api, operation FetchIdentityPackages.
// The entitlements are kept ON PURPOSE: two of them carry category "premium",
// and reading the tier from those instead of the package id is the trap.
const IDENTITY_PACKAGES_RES = {
  data: {
    identity: {
      id: 'identity-eb5RtDzkuCMobA0gGRX6Bgg0IIy',
      packages: [
        {
          id: 'silver',
          entitlements: [
            { feature: 'instant_deposit_trust_level', category: 'premium', __typename: 'CategoryEntitmement' },
            { feature: 'ca_cash_msb_interest_rate', category: 'cash_tier_b', __typename: 'CategoryEntitmement' },
          ],
          __typename: 'Package',
        },
        { id: 'direct-deposit-tier-4k', entitlements: [], __typename: 'Package' },
        {
          id: 'individual-tier-premium',
          entitlements: [
            { feature: 'credit_card_material', category: 'premium', __typename: 'CategoryEntitmement' },
          ],
          __typename: 'Package',
        },
      ],
      __typename: 'Identity',
    },
  },
};

describe('readSpendAccountCanonicalId', () => {
  it('returns the WsBankAccount canonical id', () => {
    expect(readSpendAccountCanonicalId(WS_BANK_ACCOUNT_RES)).toBe('ca-cash-msb-i_ma5GMI2g');
  });

  it('does not confuse the 8-digit bank account number for the canonical id', () => {
    expect(readSpendAccountCanonicalId(WS_BANK_ACCOUNT_RES)).not.toBe('49671100');
  });

  it('returns null when the identity has no funding methods', () => {
    expect(readSpendAccountCanonicalId({ data: { funding_methods: [] } })).toBeNull();
  });

  it('returns null on a shape it does not recognise', () => {
    expect(readSpendAccountCanonicalId({})).toBeNull();
    expect(readSpendAccountCanonicalId(null)).toBeNull();
  });
});

describe('readSpendCustodianAccountNumber', () => {
  it('picks the W…CAD custodian account over the C…CAD sibling', () => {
    expect(readSpendCustodianAccountNumber(ACCOUNT_DETAILS_RES)).toBe('WK6RQDY37CAD');
  });

  it('picks the W…CAD account regardless of array order', () => {
    const reversed = {
      data: {
        account: {
          id: 'ca-cash-msb-i_ma5GMI2g',
          custodianAccounts: [...ACCOUNT_DETAILS_RES.data.account.custodianAccounts].reverse(),
        },
      },
    };
    expect(readSpendCustodianAccountNumber(reversed)).toBe('WK6RQDY37CAD');
  });

  it('uppercases the result', () => {
    const lower = { data: { account: { custodianAccounts: [{ custodianAccountId: 'wk6rqdy37cad' }] } } };
    expect(readSpendCustodianAccountNumber(lower)).toBe('WK6RQDY37CAD');
  });

  it('returns null when no custodian account is a spend account', () => {
    const none = { data: { account: { custodianAccounts: [{ custodianAccountId: 'C14792J29CAD' }] } } };
    expect(readSpendCustodianAccountNumber(none)).toBeNull();
  });

  it('returns null on a shape it does not recognise', () => {
    expect(readSpendCustodianAccountNumber({ data: {} })).toBeNull();
  });
});

describe('readIndividualTier', () => {
  it('reads the tier from the individual-tier package id', () => {
    expect(readIndividualTier(IDENTITY_PACKAGES_RES)).toBe('Premium');
  });

  it('ignores entitlement categories that merely say premium', () => {
    const noTierPackage = {
      data: {
        identity: {
          packages: [IDENTITY_PACKAGES_RES.data.identity.packages[0]],
        },
      },
    };
    expect(readIndividualTier(noTierPackage)).toBeNull();
  });

  it('handles core and generation', () => {
    const mk = (id: string) => ({ data: { identity: { packages: [{ id }] } } });
    expect(readIndividualTier(mk('individual-tier-core'))).toBe('Core');
    expect(readIndividualTier(mk('individual-tier-generation'))).toBe('Generation');
  });

  it('returns null when there is no individual-tier package', () => {
    expect(readIndividualTier({ data: { identity: { packages: [{ id: 'silver' }] } } })).toBeNull();
  });

  it('returns null on a shape it does not recognise', () => {
    expect(readIndividualTier(undefined)).toBeNull();
  });
});

describe('atlasGraphql', () => {
  it('posts to the service path with cookies and the recorded headers', async () => {
    const spy = stubFetch(() => ok({ data: { ping: true } }));

    await atlasGraphql('fort_knox', 'WsBankAccount', 'query WsBankAccount { x }', { identityId: 'identity-1' });

    expect(spy).toHaveBeenCalledTimes(1);
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://cs-tools-satori.wealthsimple.com/api/atlas/graphql/fort_knox');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('include');
    expect(init.headers).toEqual({ accept: '*/*', 'content-type': 'application/json' });
    expect(JSON.parse(String(init.body))).toEqual({
      operationName: 'WsBankAccount',
      query: 'query WsBankAccount { x }',
      variables: { identityId: 'identity-1' },
    });
  });

  it('sends no Authorization header — Atlas authenticates by cookie alone', async () => {
    const spy = stubFetch(() => ok({ data: {} }));
    await atlasGraphql('wealthsimple', 'getAccountDetails', 'q', { id: 'ca-1' });
    const [, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(Object.keys(init.headers as Record<string, string>).map((k) => k.toLowerCase()))
      .not.toContain('authorization');
  });

  it('returns the parsed body on success', async () => {
    stubFetch(() => ok({ data: { identity: { id: 'identity-1' } } }));
    const res = await atlasGraphql('invest_graphql_api', 'FetchIdentityPackages', 'q', { id: 'identity-1' });
    expect(res).toEqual({ data: { identity: { id: 'identity-1' } } });
  });

  it('throws with the status on a non-2xx response', async () => {
    stubFetch(() => new Response('nope', { status: 403 }));
    await expect(atlasGraphql('fort_knox', 'WsBankAccount', 'q', {}))
      .rejects.toThrow(/WsBankAccount.*403/);
  });

  it('throws with the first GraphQL error message', async () => {
    stubFetch(() => ok({ errors: [{ message: 'Field x does not exist' }] }));
    await expect(atlasGraphql('wealthsimple', 'getAccountDetails', 'q', {}))
      .rejects.toThrow(/Field x does not exist/);
  });

  it('does not treat an empty errors array as a failure', async () => {
    stubFetch(() => ok({ data: { account: null }, errors: [] }));
    await expect(atlasGraphql('wealthsimple', 'getAccountDetails', 'q', {})).resolves.toBeTruthy();
  });
});
