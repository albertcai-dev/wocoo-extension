import { describe, it, expect } from 'vitest';
import {
  ADMIN_CREATE_CREDIT_PAYMENT_MUTATION,
  amountOwed,
  balanceSql,
  buildEstateComment,
  chooseCard,
  extractAccountNumbers,
  FETCH_CREDIT_PAYMENTS_QUERY,
  findTicketPayment,
  formatPaymentAmount,
  idempotencyKeyFor,
  LOG_ROLES_MUTATION,
  readCcAccountRows,
  readCreateResult,
  readCreditPayments,
  readSpendSlug,
  SPEND_CLIENT_QUERY,
  strangerAccountNumbers,
  type CcAccountRow,
} from './estateCcPayment';

// Recorded from Atlas, graphql/fort_knox, operation SpendClient (WOCOO-10001).
const SPEND_CLIENT_RES = {
  data: {
    spendClient: {
      id: 'user-test00000001',
      status: 'registered',
      spendAccount: {
        id: 'spend_account-TEST0000000000000000',
        linkedAccountCanonicalId: 'ca-cash-msb-TESTspend0',
        __typename: 'SpendAccount',
      },
      __typename: 'SpendClient',
    },
  },
};

// Trimmed to the fields the brief specifies, under data.creditPayments.edges[].node.
const FETCH_CREDIT_PAYMENTS_RES = {
  data: {
    creditPayments: {
      edges: [
        {
          node: {
            id: 'credit-payment-TESTpayment000000001',
            amount: '148.03',
            status: 'succeeded',
            sourceExternalId: 'ca-cash-msb-TESTspend0',
            createdAt: '2026-10-28T16:28:17Z',
            balanceModifierIdempotencyKey: 'card-payment-ops-wocoo-10001',
          },
        },
        {
          node: {
            id: 'credit-payment-TESTpayment000000002',
            amount: '142.70',
            status: 'succeeded',
            sourceExternalId: 'ca-cash-msb-TESTspend0',
            createdAt: '2026-10-08T19:35:21Z',
            balanceModifierIdempotencyKey: null,
          },
        },
      ],
    },
  },
};

// Recorded response shape for AdminCreateCreditPayment, WOCOO-10001: 200,
// AdminCreateCreditPaymentInitiated, canonicalId credit-payment-TESTpayment000000001.
const ADMIN_CREATE_CREDIT_PAYMENT_INITIATED_RES = {
  data: {
    adminCreateCreditPayment: {
      __typename: 'AdminCreateCreditPaymentInitiated',
      canonicalId: 'credit-payment-TESTpayment000000001',
      destinationAccountCanonicalId: 'ca-credit-card-TESTCARD01',
      sourceAccountCanonicalId: 'ca-cash-msb-TESTspend0',
      paymentAmount: '148.03',
    },
  },
};

describe('GraphQL documents', () => {
  it('are non-empty strings copied from the spec', () => {
    expect(SPEND_CLIENT_QUERY).toContain('query SpendClient($identityId: ID!)');
    expect(SPEND_CLIENT_QUERY).toContain('linkedAccountCanonicalId');
    expect(LOG_ROLES_MUTATION).toContain('mutation logRolesAndScopes(');
    expect(LOG_ROLES_MUTATION).toContain('logRolesAndScopes(input: $input) { success __typename }');
    expect(FETCH_CREDIT_PAYMENTS_QUERY).toContain('query FetchCreditPaymentsAtlas(');
    expect(FETCH_CREDIT_PAYMENTS_QUERY).toContain('balanceModifierIdempotencyKey');
    expect(ADMIN_CREATE_CREDIT_PAYMENT_MUTATION).toContain('mutation AdminCreateCreditPayment(');
    expect(ADMIN_CREATE_CREDIT_PAYMENT_MUTATION).toContain('AdminCreateCreditPaymentIdempotencyConflictError');
  });
});

describe('chooseCard', () => {
  const open: CcAccountRow = {
    accountCanonicalId: 'ca-credit-card-TESTCARD01',
    asOf: '2026-10-26',
    totalBalance: -148.03,
    isOpen: true,
  };

  it('picks the single open row, not closed', () => {
    expect(chooseCard([open])).toEqual({ kind: 'ok', card: open, closed: false });
  });

  it('flags 2+ open rows as multiple', () => {
    const open2: CcAccountRow = { ...open, accountCanonicalId: 'ca-credit-card-OTHER' };
    expect(chooseCard([open, open2])).toEqual({ kind: 'multiple', count: 2 });
  });

  it('falls back to the single closed owing row when none are open', () => {
    const closedOwing: CcAccountRow = { ...open, isOpen: false, totalBalance: -20 };
    const closedZero: CcAccountRow = { ...open, isOpen: false, totalBalance: 0 };
    expect(chooseCard([closedOwing, closedZero])).toEqual({ kind: 'ok', card: closedOwing, closed: true });
  });

  it('flags 2+ closed owing rows as multiple', () => {
    const closedOwing1: CcAccountRow = { ...open, accountCanonicalId: 'ca-credit-card-A', isOpen: false, totalBalance: -20 };
    const closedOwing2: CcAccountRow = { ...open, accountCanonicalId: 'ca-credit-card-B', isOpen: false, totalBalance: -5 };
    expect(chooseCard([closedOwing1, closedOwing2])).toEqual({ kind: 'multiple', count: 2 });
  });

  it('returns none for an empty list', () => {
    expect(chooseCard([])).toEqual({ kind: 'none' });
  });
});

describe('amountOwed / formatPaymentAmount', () => {
  it('amountOwed is null when not owing, else the positive amount', () => {
    expect(amountOwed(-148.03)).toBe(148.03);
    expect(amountOwed(0)).toBeNull();
    expect(amountOwed(12.5)).toBeNull();
  });

  it('formatPaymentAmount always has 2 decimals', () => {
    expect(formatPaymentAmount(148.03)).toBe('148.03');
    expect(formatPaymentAmount(5)).toBe('5.00');
  });
});

describe('readCcAccountRows', () => {
  it('reads UPPER-case Snowflake keys', () => {
    const rows = readCcAccountRows([
      {
        ACCOUNT_CANONICAL_ID: 'ca-credit-card-TESTCARD01',
        EFFECTIVE_AS_AT_DATE: '2026-10-26',
        TOTAL_BALANCE: -148.03,
        IS_OPEN_ACCOUNT: true,
      },
    ]);
    expect(rows[0].totalBalance).toBe(-148.03);
    expect(rows[0].accountCanonicalId).toBe('ca-credit-card-TESTCARD01');
    expect(rows[0].asOf).toBe('2026-10-26');
    expect(rows[0].isOpen).toBe(true);
  });
});

describe('balanceSql', () => {
  it('rejects an id that does not match the identity pattern', () => {
    expect(() => balanceSql("identity-x' or 1=1 --")).toThrow();
  });

  it('selects from credit.mart_cc_accounts for a valid id', () => {
    const sql = balanceSql('identity-TESTidentity000000000000000');
    expect(sql).toContain('from credit.mart_cc_accounts');
    expect(sql).toContain('identity-TESTidentity000000000000000');
  });
});

describe('readSpendSlug', () => {
  it('reads the recorded SpendClient response', () => {
    expect(readSpendSlug(SPEND_CLIENT_RES)).toBe('ca-cash-msb-TESTspend0');
  });

  it('is null when spendAccount is null', () => {
    expect(readSpendSlug({ data: { spendClient: { id: 'x', spendAccount: null } } })).toBeNull();
  });

  it('is null on garbage input', () => {
    expect(readSpendSlug(null)).toBeNull();
    expect(readSpendSlug({})).toBeNull();
  });
});

describe('idempotency', () => {
  it('idempotencyKeyFor lower-cases the ticket key with the expected prefix', () => {
    expect(idempotencyKeyFor('WOCOO-10001')).toBe('card-payment-ops-wocoo-10001');
  });

  it('findTicketPayment matches by exact idempotency key', () => {
    const payments = readCreditPayments(FETCH_CREDIT_PAYMENTS_RES);
    expect(findTicketPayment(payments, 'WOCOO-10001')?.id).toBe('credit-payment-TESTpayment000000001');
  });

  it('findTicketPayment returns null when no payment matches the ticket', () => {
    const payments = readCreditPayments(FETCH_CREDIT_PAYMENTS_RES);
    expect(findTicketPayment(payments, 'WOCOO-1')).toBeNull();
  });
});

describe('readCreditPayments', () => {
  it('reads both nodes, including a null idempotency key', () => {
    const payments = readCreditPayments(FETCH_CREDIT_PAYMENTS_RES);
    expect(payments).toHaveLength(2);
    expect(payments[1].idempotencyKey).toBeNull();
    expect(payments[0].amount).toBe('148.03');
    expect(payments[0].status).toBe('succeeded');
    expect(payments[0].createdAt).toBe('2026-10-28T16:28:17Z');
  });
});

describe('readCreditPayments fails closed', () => {
  it('throws when creditPayments is missing, so the duplicate check cannot pass by accident', () => {
    expect(() => readCreditPayments({ data: { creditPayments: null } })).toThrow();
    expect(() => readCreditPayments({ data: {} })).toThrow();
    expect(() => readCreditPayments({ data: { creditPayments: { edges: null } } })).toThrow();
  });

  it('accepts an empty edges list as "no payments"', () => {
    expect(readCreditPayments({ data: { creditPayments: { edges: [] } } })).toEqual([]);
  });

  it('throws when a node lacks balanceModifierIdempotencyKey entirely (null is fine)', () => {
    const res = { data: { creditPayments: { edges: [{ node: { id: 'credit-payment-x', amount: '1.00', status: 'succeeded', createdAt: '' } }] } } };
    expect(() => readCreditPayments(res)).toThrow(/idempotency/i);
  });
});

describe('readCreateResult', () => {
  it('reads the recorded Initiated response', () => {
    expect(readCreateResult(ADMIN_CREATE_CREDIT_PAYMENT_INITIATED_RES)).toEqual({
      kind: 'initiated',
      paymentId: 'credit-payment-TESTpayment000000001',
    });
  });

  it('reads an IdempotencyConflictError as conflict', () => {
    const res = {
      data: {
        adminCreateCreditPayment: {
          __typename: 'AdminCreateCreditPaymentIdempotencyConflictError',
          message: 'A payment already exists for this ticket.',
        },
      },
    };
    expect(readCreateResult(res)).toEqual({
      kind: 'conflict',
      message: 'A payment already exists for this ticket.',
    });
  });

  it('reads AccountNotFoundError as error', () => {
    const res = {
      data: {
        adminCreateCreditPayment: {
          __typename: 'AccountNotFoundError',
          message: 'Account not found.',
        },
      },
    };
    expect(readCreateResult(res)).toEqual({ kind: 'error', message: 'Account not found.' });
  });

  it('reads AdminCreateCreditPaymentValidationError as error', () => {
    const res = {
      data: {
        adminCreateCreditPayment: {
          __typename: 'AdminCreateCreditPaymentValidationError',
          message: 'paymentAmount must be greater than 0',
        },
      },
    };
    expect(readCreateResult(res)).toEqual({
      kind: 'error',
      message: 'paymentAmount must be greater than 0',
    });
  });

  it('treats an unknown typename as error', () => {
    const res = { data: { adminCreateCreditPayment: { __typename: 'SomethingElse' } } };
    expect(readCreateResult(res).kind).toBe('error');
  });

  it('treats missing data as error', () => {
    expect(readCreateResult({}).kind).toBe('error');
    expect(readCreateResult(null).kind).toBe('error');
  });
});

describe('extractAccountNumbers / strangerAccountNumbers', () => {
  it('extracts and upper-cases account numbers from a description, de-duplicated', () => {
    expect(
      extractAccountNumbers(
        "Please pay the deceased's credit card ( C1AAAAAA1CAD ) balance from their chequing account ( wa1234567cad )",
      ),
    ).toEqual(['C1AAAAAA1CAD', 'WA1234567CAD']);
  });

  it('extracts a number that starts with a digit or sits inside code formatting', () => {
    expect(extractAccountNumbers('chequing `wa1234567cad`, card {{1A2B3C4D5CAD}}')).toEqual(['WA1234567CAD', '1A2B3C4D5CAD']);
  });

  it('strangerAccountNumbers is empty when every named number is owned', () => {
    expect(
      strangerAccountNumbers(
        ['C1AAAAAA1CAD', 'WA1234567CAD'],
        ['C2BBBBBB2CAD', 'WA1234567CAD', 'C1AAAAAA1CAD'],
      ),
    ).toEqual([]);
  });

  it('strangerAccountNumbers flags a number that belongs to neither account', () => {
    expect(strangerAccountNumbers(['WX9999999CAD'], ['WA1234567CAD'])).toEqual(['WX9999999CAD']);
  });
});

describe('buildEstateComment', () => {
  it('mentions the reporter by name', () => {
    expect(buildEstateComment('Jane Doe')).toBe(
      "Hi @Jane Doe, I've processed the payment from client's chequing account to pay off their balance! You can proceed to close the card now.",
    );
  });

  it('falls back to "Hi team, " when there is no reporter', () => {
    expect(buildEstateComment(undefined).startsWith('Hi team, ')).toBe(true);
  });
});
