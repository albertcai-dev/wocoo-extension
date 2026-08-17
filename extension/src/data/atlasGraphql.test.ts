import { describe, expect, it } from 'vitest';
import {
  readIndividualTier,
  readSpendAccountCanonicalId,
  readSpendCustodianAccountNumber,
} from './atlasGraphql';

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
