import { describe, it, expect } from 'vitest';
import {
  loadEstateLookup,
  loadEstateState,
  payEstateCard,
  saveEstateState,
  waitForSucceeded,
  type EstateDeps,
} from './estateCcPaymentApi';

const TICKET = 'WOCOO-10001';
const CARD = 'ca-credit-card-TESTCARD01';
const SLUG = 'ca-cash-msb-TESTspend0';
const PAYMENT_ID = 'credit-payment-TESTpayment000000001';
const IDENTITY = 'identity-TESTidentity000000000000000';

const SPEND_CLIENT_RES = {
  data: { spendClient: { spendAccount: { linkedAccountCanonicalId: SLUG } } },
};

function paymentsRes(nodes: Array<{ id: string; status: string; key: string | null; amount?: string }>) {
  return {
    data: {
      creditPayments: {
        edges: nodes.map((n) => ({
          node: {
            id: n.id,
            amount: n.amount ?? '148.03',
            status: n.status,
            createdAt: '2026-10-28T16:28:17Z',
            balanceModifierIdempotencyKey: n.key,
          },
        })),
      },
    },
  };
}

const OUR_PAYMENT = { id: PAYMENT_ID, status: 'succeeded', key: 'card-payment-ops-wocoo-10001' };
const OLD_PAYMENT = { id: 'credit-payment-TESTpayment000000002', status: 'succeeded', key: null, amount: '142.70' };

const INITIATED_RES = {
  data: {
    adminCreateCreditPayment: {
      __typename: 'AdminCreateCreditPaymentInitiated',
      canonicalId: PAYMENT_ID,
      destinationAccountCanonicalId: CARD,
      sourceAccountCanonicalId: SLUG,
      paymentAmount: '148.03',
    },
  },
};

const CONFLICT_RES = {
  data: {
    adminCreateCreditPayment: {
      __typename: 'AdminCreateCreditPaymentIdempotencyConflictError',
      message: 'Payment already exists for this ticket.',
    },
  },
};

type Handler = (vars: Record<string, unknown>) => unknown | Promise<unknown>;

function fakeDeps(handlers: Record<string, Handler>, sqlRows: Record<string, unknown>[] = []) {
  const calls: Array<{ service: string; op: string; vars: Record<string, unknown> }> = [];
  const store = new Map<string, unknown>();
  const deps: EstateDeps = {
    gql: async (service, op, _query, vars) => {
      calls.push({ service, op, vars });
      const h = handlers[op];
      if (!h) throw new Error(`unexpected op ${op}`);
      return h(vars);
    },
    sql: async () => sqlRows,
    storageGet: async (key) => store.get(key),
    storageSet: async (key, value) => { store.set(key, value); },
    sleep: async () => {},
  };
  return { deps, calls, store };
}

const AUDIT_OK: Handler = () => ({ data: { logRolesAndScopes: { success: true } } });
const ARGS = { ticketKey: TICKET, cardId: CARD, spendSlug: SLUG, amount: 148.03 };

describe('payEstateCard', () => {
  it('audits, then sends the recorded mutation and stores the payment id', async () => {
    const { deps, calls, store } = fakeDeps({
      logRolesAndScopes: AUDIT_OK,
      AdminCreateCreditPayment: () => INITIATED_RES,
    });
    const out = await payEstateCard(ARGS, deps);
    expect(out).toEqual({ kind: 'sent', paymentId: PAYMENT_ID });
    expect(calls.map((c) => c.op)).toEqual(['logRolesAndScopes', 'AdminCreateCreditPayment']);
    expect(calls[0]).toMatchObject({ service: 'fort_knox', vars: { input: { roles: ['payment_cards_ops'] } } });
    expect(calls[1]).toEqual({
      service: 'fort_knox',
      op: 'AdminCreateCreditPayment',
      vars: {
        input: {
          destinationAccountCanonicalId: CARD,
          sourceAccountCanonicalId: SLUG,
          paymentAmount: '148.03',
          ticketId: TICKET,
        },
      },
    });
    expect(store.get(`estate_cc_payment:${TICKET}`)).toMatchObject({ paymentId: PAYMENT_ID });
  });

  it('never sends the mutation when the audit call is not a success', async () => {
    const { deps, calls } = fakeDeps({
      logRolesAndScopes: () => ({ data: { logRolesAndScopes: { success: false } } }),
      AdminCreateCreditPayment: () => INITIATED_RES,
    });
    const out = await payEstateCard(ARGS, deps);
    expect(out.kind).toBe('failed');
    expect(calls.map((c) => c.op)).toEqual(['logRolesAndScopes']);
  });

  it('never sends the mutation when the audit call throws', async () => {
    const { deps, calls } = fakeDeps({
      logRolesAndScopes: () => { throw new Error('Atlas logRolesAndScopes failed: HTTP 500'); },
      AdminCreateCreditPayment: () => INITIATED_RES,
    });
    const out = await payEstateCard(ARGS, deps);
    expect(out.kind).toBe('failed');
    expect(calls.map((c) => c.op)).toEqual(['logRolesAndScopes']);
  });

  it('treats a mutation network error as paid when the requery finds the ticket key', async () => {
    const { deps, store } = fakeDeps({
      logRolesAndScopes: AUDIT_OK,
      AdminCreateCreditPayment: () => { throw new TypeError('Failed to fetch'); },
      FetchCreditPaymentsAtlas: () => paymentsRes([OUR_PAYMENT, OLD_PAYMENT]),
    });
    const out = await payEstateCard(ARGS, deps);
    expect(out).toMatchObject({ kind: 'paid', payment: { id: PAYMENT_ID, status: 'succeeded' } });
    expect(store.get(`estate_cc_payment:${TICKET}`)).toMatchObject({ paymentId: PAYMENT_ID });
  });

  it('fails a mutation network error when the requery finds nothing', async () => {
    const { deps } = fakeDeps({
      logRolesAndScopes: AUDIT_OK,
      AdminCreateCreditPayment: () => { throw new TypeError('Failed to fetch'); },
      FetchCreditPaymentsAtlas: () => paymentsRes([OLD_PAYMENT]),
    });
    const out = await payEstateCard(ARGS, deps);
    expect(out).toMatchObject({ kind: 'failed' });
    expect((out as { message: string }).message).toContain('Failed to fetch');
  });

  it('treats a conflict as paid when the requery finds the ticket key', async () => {
    const { deps } = fakeDeps({
      logRolesAndScopes: AUDIT_OK,
      AdminCreateCreditPayment: () => CONFLICT_RES,
      FetchCreditPaymentsAtlas: () => paymentsRes([OUR_PAYMENT]),
    });
    expect(await payEstateCard(ARGS, deps)).toMatchObject({ kind: 'paid', payment: { id: PAYMENT_ID } });
  });

  it('fails a conflict when no payment is found', async () => {
    const { deps } = fakeDeps({
      logRolesAndScopes: AUDIT_OK,
      AdminCreateCreditPayment: () => CONFLICT_RES,
      FetchCreditPaymentsAtlas: () => paymentsRes([]),
    });
    expect(await payEstateCard(ARGS, deps)).toEqual({
      kind: 'failed',
      message: 'Payment already exists for this ticket.',
    });
  });

  it('fails with the server message on a validation error', async () => {
    const { deps } = fakeDeps({
      logRolesAndScopes: AUDIT_OK,
      AdminCreateCreditPayment: () => ({
        data: { adminCreateCreditPayment: { __typename: 'AdminCreateCreditPaymentValidationError', message: 'Insufficient funds' } },
      }),
    });
    expect(await payEstateCard(ARGS, deps)).toEqual({ kind: 'failed', message: 'Insufficient funds' });
  });

  it('refuses an amount that is not > 0 without calling Atlas', async () => {
    const { deps, calls } = fakeDeps({ logRolesAndScopes: AUDIT_OK, AdminCreateCreditPayment: () => INITIATED_RES });
    expect((await payEstateCard({ ...ARGS, amount: 0 }, deps)).kind).toBe('failed');
    expect(calls).toEqual([]);
  });

  it('sends one mutation for two concurrent calls on the same ticket', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const { deps, calls } = fakeDeps({
      logRolesAndScopes: AUDIT_OK,
      AdminCreateCreditPayment: async () => { await gate; return INITIATED_RES; },
    });
    const a = payEstateCard(ARGS, deps);
    const b = payEstateCard(ARGS, deps);
    release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra).toEqual(rb);
    expect(calls.filter((c) => c.op === 'AdminCreateCreditPayment')).toHaveLength(1);
  });
});

describe('waitForSucceeded', () => {
  it('polls until the ticket payment is succeeded', async () => {
    const statuses = ['pending', 'pending', 'succeeded'];
    let reads = 0;
    const { deps } = fakeDeps({
      FetchCreditPaymentsAtlas: () => paymentsRes([{ ...OUR_PAYMENT, status: statuses[reads++] }]),
    });
    const p = await waitForSucceeded(CARD, TICKET, deps);
    expect(p).toMatchObject({ id: PAYMENT_ID, status: 'succeeded' });
    expect(reads).toBe(3);
  });

  it('returns the last pending payment after `tries` reads', async () => {
    let reads = 0;
    const { deps } = fakeDeps({
      FetchCreditPaymentsAtlas: () => { reads++; return paymentsRes([{ ...OUR_PAYMENT, status: 'pending' }]); },
    });
    const p = await waitForSucceeded(CARD, TICKET, deps, { tries: 4, intervalMs: 1 });
    expect(p).toMatchObject({ id: PAYMENT_ID, status: 'pending' });
    expect(reads).toBe(4);
  });

  it('returns null when the ticket has no payment', async () => {
    const { deps } = fakeDeps({ FetchCreditPaymentsAtlas: () => paymentsRes([OLD_PAYMENT]) });
    expect(await waitForSucceeded(CARD, TICKET, deps, { tries: 2 })).toBeNull();
  });
});

describe('loadEstateLookup', () => {
  const SQL_ROWS = [{
    ACCOUNT_CANONICAL_ID: CARD,
    EFFECTIVE_AS_AT_DATE: '2026-10-26',
    TOTAL_BALANCE: -148.03,
    IS_OPEN_ACCOUNT: true,
  }];
  const custodians = (...ids: string[]) => ({
    data: { account: { custodianAccounts: ids.map((custodianAccountId) => ({ custodianAccountId })) } },
  });

  it('assembles the card, slug, owned account numbers and existing payment', async () => {
    const { deps, calls } = fakeDeps({
      SpendClient: () => SPEND_CLIENT_RES,
      getAccountDetails: (vars) => (vars.id === SLUG ? custodians('c2bbbbbb2cad', 'WA1234567CAD') : custodians('C1AAAAAA1CAD')),
      FetchCreditPaymentsAtlas: () => paymentsRes([OUR_PAYMENT, OLD_PAYMENT]),
    }, SQL_ROWS);
    const lookup = await loadEstateLookup(IDENTITY, TICKET, deps);
    expect(lookup.card).toMatchObject({ kind: 'ok', closed: false, card: { accountCanonicalId: CARD, totalBalance: -148.03 } });
    expect(lookup.spendSlug).toBe(SLUG);
    expect([...lookup.ownedAccountNumbers].sort()).toEqual(['C2BBBBBB2CAD', 'C1AAAAAA1CAD', 'WA1234567CAD']);
    expect(lookup.payments).toHaveLength(2);
    expect(lookup.existing?.id).toBe(PAYMENT_ID);
    const spendCall = calls.find((c) => c.op === 'SpendClient');
    expect(spendCall).toMatchObject({ service: 'fort_knox', vars: { identityId: IDENTITY } });
    expect(calls.find((c) => c.op === 'getAccountDetails')?.service).toBe('wealthsimple');
    expect(calls.find((c) => c.op === 'FetchCreditPaymentsAtlas')).toMatchObject({
      service: 'fort_knox', vars: { accountCanonicalId: CARD, first: 20 },
    });
  });

  it('rejects when SpendClient throws', async () => {
    const { deps } = fakeDeps({
      SpendClient: () => { throw new Error('Atlas SpendClient failed: HTTP 401'); },
      getAccountDetails: () => custodians(),
      FetchCreditPaymentsAtlas: () => paymentsRes([]),
    }, SQL_ROWS);
    await expect(loadEstateLookup(IDENTITY, TICKET, deps)).rejects.toThrow('SpendClient');
  });

  it('rejects when the payments read throws', async () => {
    const { deps } = fakeDeps({
      SpendClient: () => SPEND_CLIENT_RES,
      getAccountDetails: () => custodians('C1AAAAAA1CAD'),
      FetchCreditPaymentsAtlas: () => { throw new Error('Atlas FetchCreditPaymentsAtlas failed: HTTP 502'); },
    }, SQL_ROWS);
    await expect(loadEstateLookup(IDENTITY, TICKET, deps)).rejects.toThrow('FetchCreditPaymentsAtlas');
  });

  it('skips the card reads when no card is chosen', async () => {
    const { deps, calls } = fakeDeps({
      SpendClient: () => SPEND_CLIENT_RES,
      getAccountDetails: () => custodians('WA1234567CAD'),
    }, []);
    const lookup = await loadEstateLookup(IDENTITY, TICKET, deps);
    expect(lookup.card).toEqual({ kind: 'none' });
    expect(lookup.existing).toBeNull();
    expect(calls.some((c) => c.op === 'FetchCreditPaymentsAtlas')).toBe(false);
  });
});

describe('estate state', () => {
  it('round-trips the stored payment id', async () => {
    const { deps } = fakeDeps({});
    expect(await loadEstateState(TICKET, deps)).toBeNull();
    await saveEstateState(TICKET, PAYMENT_ID, deps);
    const state = await loadEstateState(TICKET, deps);
    expect(state?.paymentId).toBe(PAYMENT_ID);
    expect(typeof state?.at).toBe('string');
  });
});
