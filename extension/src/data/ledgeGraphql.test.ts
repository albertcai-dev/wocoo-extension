import { describe, expect, test } from 'vitest';
import {
  matchWireIn,
  transactionWindow,
  fetchAllTransactions,
  readAccessTokenFromOktaStorage,
  buildTransactionsRequest,
  type LedgeTransaction,
  type LedgeTransactionPage,
} from './ledgeGraphql';

const JWT = 'eyJraWQiOiJhIn0.eyJzdWIiOiJiIn0.c2ln';

function txn(over: Partial<LedgeTransaction>): LedgeTransaction {
  return {
    effectiveDate: '2026-08-31',
    txnType: 'WIREIN',
    description: 'Client Wire In',
    debit: '0.00',
    credit: '700.00',
    transactionCurrency: 'CAD',
    reference: null,
    externalReference: null,
    ...over,
  };
}

describe('matchWireIn', () => {
  test('matches a WIREIN row whose credit equals the expected amount', () => {
    const found = matchWireIn([txn({})], 700, 'CAD');
    expect(found?.credit).toBe('700.00');
  });

  test('ignores a same-amount row whose txnType is not WIREIN', () => {
    const rows = [txn({ txnType: 'TRFIN', description: 'Transfer from TFSA' })];
    expect(matchWireIn(rows, 700, 'CAD')).toBeNull();
  });

  test('accepts a credit short of expected by a sending-bank fee', () => {
    const rows = [txn({ credit: '685.00' })];
    expect(matchWireIn(rows, 700, 'CAD')?.credit).toBe('685.00');
  });

  test('rejects a credit outside the tolerance window', () => {
    const rows = [txn({ credit: '540.00' })];
    expect(matchWireIn(rows, 700, 'CAD')).toBeNull();
  });

  test('scales tolerance to 0.5% for large wires', () => {
    // 0.5% of 100_000 is 500, so 99_600 is inside and 99_400 is outside.
    expect(matchWireIn([txn({ credit: '99600.00' })], 100_000, 'CAD')).not.toBeNull();
    expect(matchWireIn([txn({ credit: '99400.00' })], 100_000, 'CAD')).toBeNull();
  });

  test('rejects a matching amount in the wrong currency', () => {
    const rows = [txn({ transactionCurrency: 'USD' })];
    expect(matchWireIn(rows, 700, 'CAD')).toBeNull();
  });

  test('picks the closest candidate when several are within tolerance', () => {
    const rows = [txn({ credit: '650.00' }), txn({ credit: '695.00' })];
    expect(matchWireIn(rows, 700, 'CAD')?.credit).toBe('695.00');
  });

  test('ignores a zero credit on a debit-side row', () => {
    const rows = [txn({ credit: '0.00', debit: '700.00' })];
    expect(matchWireIn(rows, 700, 'CAD')).toBeNull();
  });

  test('returns null for an empty transaction list', () => {
    expect(matchWireIn([], 700, 'CAD')).toBeNull();
  });
});

describe('transactionWindow', () => {
  const today = new Date(2026, 8, 3); // 2026-09-03

  test('starts one day before an ISO wire timestamp', () => {
    expect(transactionWindow('2026-05-29', today)).toEqual({
      startDate: '2026-05-28',
      endDate: '2026-09-03',
    });
  });

  test('parses a US-style wire timestamp', () => {
    expect(transactionWindow('5/29/2026', today).startDate).toBe('2026-05-28');
  });

  test('falls back to a 180-day window when the timestamp is unparseable', () => {
    expect(transactionWindow('sometime last spring', today).startDate).toBe('2026-03-07');
  });

  test('falls back to a 180-day window when the timestamp is empty', () => {
    expect(transactionWindow('', today).startDate).toBe('2026-03-07');
  });
});

describe('fetchAllTransactions', () => {
  function page(nodes: LedgeTransaction[], pageNum: number, hasNextPage: boolean): LedgeTransactionPage {
    return {
      nodes,
      pageInfo: { page: pageNum, pageSize: 25, hasNextPage, pageCount: 2, totalCount: nodes.length },
    };
  }

  test('returns the nodes of a single page', async () => {
    const nodes = await fetchAllTransactions(async () => page([txn({})], 0, false));
    expect(nodes).toHaveLength(1);
  });

  test('follows hasNextPage and concatenates every page', async () => {
    const pages = [
      page([txn({ credit: '1.00' })], 0, true),
      page([txn({ credit: '2.00' })], 1, false),
    ];
    const seen: number[] = [];
    const nodes = await fetchAllTransactions(async (p) => {
      seen.push(p);
      return pages[p];
    });
    expect(seen).toEqual([0, 1]);
    expect(nodes.map((n) => n.credit)).toEqual(['1.00', '2.00']);
  });

  test('stops at the page cap when hasNextPage never goes false', async () => {
    let calls = 0;
    const nodes = await fetchAllTransactions(async (p) => {
      calls++;
      return page([txn({})], p, true);
    });
    expect(calls).toBe(40);
    expect(nodes).toHaveLength(40);
  });
});

describe('readAccessTokenFromOktaStorage', () => {
  test('reads the nested accessToken of the okta-auth-js shape', () => {
    const raw = JSON.stringify({
      idToken: { idToken: 'not-this-one', expiresAt: 1 },
      accessToken: { accessToken: JWT, tokenType: 'Bearer', expiresAt: 2 },
    });
    expect(readAccessTokenFromOktaStorage(raw)).toBe(JWT);
  });

  test('reads a flat accessToken string', () => {
    expect(readAccessTokenFromOktaStorage(JSON.stringify({ accessToken: JWT }))).toBe(JWT);
  });

  test('finds the token when okta nests it under an extra wrapper', () => {
    const raw = JSON.stringify({ token: { accessToken: { value: JWT } } });
    expect(readAccessTokenFromOktaStorage(raw)).toBe(JWT);
  });

  test('ignores an id token when no access token is present', () => {
    const raw = JSON.stringify({ idToken: { idToken: JWT } });
    expect(readAccessTokenFromOktaStorage(raw)).toBeNull();
  });

  test('returns null for a missing or unparseable entry', () => {
    expect(readAccessTokenFromOktaStorage(null)).toBeNull();
    expect(readAccessTokenFromOktaStorage('')).toBeNull();
    expect(readAccessTokenFromOktaStorage('not json')).toBeNull();
  });
})

describe('buildTransactionsRequest', () => {
  const vars = { accountId: 'HQCN4YX08CAD', startDate: '2026-08-30', endDate: '2026-09-03', page: 1, size: 25 };

  test('posts to the Ledge GraphQL host', () => {
    const req = buildTransactionsRequest(JWT, vars);
    expect(req.url).toBe('https://ledge.cac1.pro1.production.w10e.com/graphql');
    expect(req.init.method).toBe('POST');
  });

  test('sends the token as a Bearer authorization header', () => {
    const headers = buildTransactionsRequest(JWT, vars).init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${JWT}`);
    expect(headers['content-type']).toBe('application/json');
  });

  test('identifies itself with the SPA surface header Ledge expects', () => {
    const headers = buildTransactionsRequest(JWT, vars).init.headers as Record<string, string>;
    expect(headers['x-ledge-surface']).toBe('SPA');
  });

  test('carries the operation name and every variable', () => {
    const body = JSON.parse(String(buildTransactionsRequest(JWT, vars).init.body));
    expect(body.operationName).toBe('GetAccountTransactions');
    expect(body.variables).toEqual(vars);
    expect(body.query).toContain('accountTransactions(');
  });
});
