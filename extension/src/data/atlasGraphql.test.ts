import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  atlasGraphql,
  fetchAtlasAccountIdViaGraphql,
  fetchAtlasClientDetailsViaGraphql,
  GET_PROFILE_V2_QUERY,
  readClientDetails,
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
    // The `silver` package alone carries category: "premium" entitlements. Reading the
    // tier from those would wrongly report Premium for a Core client.
    const noTierPackage = {
      data: {
        identity: {
          packages: [IDENTITY_PACKAGES_RES.data.identity.packages[0]],
        },
      },
    };
    expect(readIndividualTier(noTierPackage)).not.toBe('Premium');
  });

  it('handles core and generation', () => {
    const mk = (id: string) => ({ data: { identity: { packages: [{ id }] } } });
    expect(readIndividualTier(mk('individual-tier-core'))).toBe('Core');
    expect(readIndividualTier(mk('individual-tier-generation'))).toBe('Generation');
  });

  // Recorded: identity-v6Qd0IOcskEZanejmCah0X4tIqX has exactly these packages and
  // Atlas's own page shows "INDIVIDUAL TIERS > Status: Core".
  it('defaults to Core when no individual-tier package is present', () => {
    const coreClient = { data: { identity: { packages: [{ id: 'default' }, { id: 'direct-deposit-tier-4k' }] } } };
    expect(readIndividualTier(coreClient)).toBe('Core');
  });

  it('treats an empty packages array as Core, not unknown', () => {
    expect(readIndividualTier({ data: { identity: { packages: [] } } })).toBe('Core');
  });

  // Null means "could not read", which is a different claim from "Core".
  it('returns null on a shape it does not recognise', () => {
    expect(readIndividualTier(undefined)).toBeNull();
    expect(readIndividualTier({ data: { identity: {} } })).toBeNull();
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

/** Routes a stubbed fetch by the operationName in the request body. */
function stubByOperation(handlers: Record<string, () => Response>) {
  const seen: string[] = [];
  const spy = vi.fn((_url: unknown, init: unknown) => {
    const body = JSON.parse(String((init as RequestInit).body));
    seen.push(body.operationName);
    const handler = handlers[body.operationName];
    if (!handler) throw new Error(`unexpected operation ${body.operationName}`);
    return Promise.resolve(handler());
  });
  vi.stubGlobal('fetch', spy);
  return { spy, seen };
}

const BANK_OK = () => ok({ data: { funding_methods: [{ account_canonical_id: 'ca-cash-msb-i_ma5GMI2g' }] } });
const DETAILS_OK = () => ok({
  data: { account: { custodianAccounts: [{ custodianAccountId: 'C14792J29CAD' }, { custodianAccountId: 'WK6RQDY37CAD' }] } },
});
const PACKAGES_OK = () => ok({ data: { identity: { packages: [{ id: 'silver' }, { id: 'individual-tier-premium' }] } } });

describe('fetchAtlasAccountIdViaGraphql', () => {
  it('returns the W# and the tier', async () => {
    stubByOperation({
      WsBankAccount: BANK_OK,
      getAccountDetails: DETAILS_OK,
      FetchIdentityPackages: PACKAGES_OK,
    });

    const result = await fetchAtlasAccountIdViaGraphql({ identityId: 'identity-1' });

    expect(result).toEqual({ accountNumber: 'WK6RQDY37CAD', individualTierStatus: 'Premium' });
  });

  it('passes the canonical id from hop 1 into hop 2', async () => {
    const calls: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn((_url: unknown, init: unknown) => {
      const body = JSON.parse(String((init as RequestInit).body));
      calls.push(body.variables);
      if (body.operationName === 'WsBankAccount') return Promise.resolve(BANK_OK());
      if (body.operationName === 'getAccountDetails') return Promise.resolve(DETAILS_OK());
      return Promise.resolve(PACKAGES_OK());
    }));

    await fetchAtlasAccountIdViaGraphql({ identityId: 'identity-1' });

    expect(calls).toContainEqual({ id: 'ca-cash-msb-i_ma5GMI2g' });
  });

  it('still returns the W# when the tier operation fails', async () => {
    stubByOperation({
      WsBankAccount: BANK_OK,
      getAccountDetails: DETAILS_OK,
      FetchIdentityPackages: () => new Response('boom', { status: 500 }),
    });

    const result = await fetchAtlasAccountIdViaGraphql({ identityId: 'identity-1' });

    expect(result).toEqual({ accountNumber: 'WK6RQDY37CAD', individualTierStatus: null });
  });

  it('throws when the identity has no WsBankAccount funding method', async () => {
    stubByOperation({
      WsBankAccount: () => ok({ data: { funding_methods: [] } }),
      FetchIdentityPackages: PACKAGES_OK,
    });

    await expect(fetchAtlasAccountIdViaGraphql({ identityId: 'identity-1' }))
      .rejects.toThrow(/no Wealthsimple bank account/i);
  });

  it('throws when no custodian account is a spend account', async () => {
    stubByOperation({
      WsBankAccount: BANK_OK,
      getAccountDetails: () => ok({ data: { account: { custodianAccounts: [{ custodianAccountId: 'C14792J29CAD' }] } } }),
      FetchIdentityPackages: PACKAGES_OK,
    });

    await expect(fetchAtlasAccountIdViaGraphql({ identityId: 'identity-1' }))
      .rejects.toThrow(/spend account number/i);
  });

  it('rejects an empty identityId without calling the network', async () => {
    const { spy } = stubByOperation({});
    await expect(fetchAtlasAccountIdViaGraphql({ identityId: '' })).rejects.toThrow(/identityId is required/);
    expect(spy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// getProfileV2 — client legal name + mailing address for the Refund Auth Letter.
// ---------------------------------------------------------------------------

// Field names recorded from Atlas's own getProfileV2 document. Values here are
// invented, not a real client. Note what is deliberately ABSENT: getProfileV2 also
// returns taxIdentificationNumbers.numberUnobfuscated (a SIN in the clear), DOB,
// gender and employment. Our query must never ask for those.
const PROFILE_RES = {
  data: {
    profileV2: {
      identityId: 'identity-1',
      person: {
        legalName: { firstName: 'Duncan', middleNames: null, lastName: 'Stevenson', __typename: 'LegalName' },
        mailingAddress: {
          streetNumber: '101', streetName: 'Roseview Avenue', unit: 'Unit 2',
          city: 'Richmond Hill', provinceStateRegion: 'ON', country: 'CA',
          postalCode: 'L4C1C6', __typename: 'ClientAddressType',
        },
        residentialAddress: {
          streetNumber: '900', streetName: 'Bay Street', unit: null,
          city: 'Toronto', provinceStateRegion: 'ON', country: 'CA',
          postalCode: 'M5S1A1', __typename: 'ClientAddressType',
        },
        __typename: 'Person',
      },
      __typename: 'ProfileV2',
    },
  },
};

// structuredClone infers the fixture's literal types (middleNames: null, unit: string),
// so mutating a field to exercise a variant needs a loosely-typed clone.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const cloneProfile = (): any => structuredClone(PROFILE_RES);

describe('readClientDetails', () => {
  it('builds the four letter fields from the mailing address', () => {
    expect(readClientDetails(PROFILE_RES)).toEqual({
      name: 'Duncan Stevenson',
      street: 'Unit 2, 101 Roseview Avenue',
      cityProvince: 'Richmond Hill, ON',
      postal: 'L4C 1C6',
      complete: true,
    });
  });

  it('includes middle names in the legal name when present', () => {
    const withMiddle = cloneProfile();
    withMiddle.data.profileV2.person.legalName.middleNames = 'James Robert';
    expect(readClientDetails(withMiddle)?.name).toBe('Duncan James Robert Stevenson');
  });

  it('omits the unit when there is none', () => {
    const noUnit = cloneProfile();
    noUnit.data.profileV2.person.mailingAddress.unit = null;
    expect(readClientDetails(noUnit)?.street).toBe('101 Roseview Avenue');
  });

  it('falls back to the residential address when mailing is absent', () => {
    const noMailing = cloneProfile();
    noMailing.data.profileV2.person.mailingAddress = null;
    const out = readClientDetails(noMailing);
    expect(out?.street).toBe('900 Bay Street');
    expect(out?.cityProvince).toBe('Toronto, ON');
    expect(out?.postal).toBe('M5S 1A1');
  });

  it('spaces a 6-character postal code and leaves other formats alone', () => {
    const spaced = cloneProfile();
    spaced.data.profileV2.person.mailingAddress.postalCode = 'l4c 1c6';
    expect(readClientDetails(spaced)?.postal).toBe('L4C 1C6');

    const zip = cloneProfile();
    zip.data.profileV2.person.mailingAddress.postalCode = '90210';
    expect(readClientDetails(zip)?.postal).toBe('90210');
  });

  it('reports complete: false when a field is missing but still returns the rest', () => {
    const noPostal = cloneProfile();
    noPostal.data.profileV2.person.mailingAddress.postalCode = null;
    const out = readClientDetails(noPostal);
    expect(out?.complete).toBe(false);
    expect(out?.street).toBe('Unit 2, 101 Roseview Avenue');
  });

  it('returns null when there is no person to read', () => {
    expect(readClientDetails({ data: { profileV2: null } })).toBeNull();
    expect(readClientDetails(undefined)).toBeNull();
  });
});

describe('GET_PROFILE_V2_QUERY', () => {
  // getProfileV2 can return an unobfuscated SIN. Asking for less is the only
  // guarantee it never reaches storage, a log, or a screenshot.
  it('requests no tax, birth, gender or employment fields', () => {
    for (const forbidden of [
      'taxIdentificationNumbers', 'numberUnobfuscated', 'numberEncrypted',
      'dateOfBirth', 'gender', 'employmentV2', 'phoneNumbers',
    ]) {
      expect(GET_PROFILE_V2_QUERY).not.toContain(forbidden);
    }
  });

  it('requests exactly the name and address fields it needs', () => {
    for (const needed of ['legalName', 'mailingAddress', 'residentialAddress', 'postalCode', 'provinceStateRegion']) {
      expect(GET_PROFILE_V2_QUERY).toContain(needed);
    }
  });
});

describe('fetchAtlasClientDetailsViaGraphql', () => {
  it('reads the profile in one call', async () => {
    const spy = stubFetch(() => ok(PROFILE_RES));

    const out = await fetchAtlasClientDetailsViaGraphql({ identityId: 'identity-1' });

    expect(out.name).toBe('Duncan Stevenson');
    expect(spy).toHaveBeenCalledTimes(1);
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    // Bare /graphql — getProfileV2 has no service suffix, unlike the account hops.
    expect(url).toBe('https://cs-tools-satori.wealthsimple.com/api/atlas/graphql');
    expect(JSON.parse(String(init.body)).variables).toEqual({ identity_id: 'identity-1' });
  });

  it('throws when the profile has no readable person', async () => {
    stubFetch(() => ok({ data: { profileV2: null } }));
    await expect(fetchAtlasClientDetailsViaGraphql({ identityId: 'identity-1' }))
      .rejects.toThrow(/no client details/i);
  });

  it('rejects an empty identityId without calling the network', async () => {
    const spy = stubFetch(() => ok(PROFILE_RES));
    await expect(fetchAtlasClientDetailsViaGraphql({ identityId: '' })).rejects.toThrow(/identityId is required/);
    expect(spy).not.toHaveBeenCalled();
  });
});
