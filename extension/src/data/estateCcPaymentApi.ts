// Atlas / Pantheon I/O for the Estate CC Payment workflow, plus the pay orchestration.
// Fetch, SQL and storage are injected (EstateDeps) so the money path is unit-tested.
// See docs/superpowers/specs/2026-10-28-estate-cc-payment-design.md.

import { atlasGraphql, GET_ACCOUNT_DETAILS_QUERY, type AtlasGraphqlService } from './atlasGraphql';
import { runPresetSql } from './presetSql';
import {
  ADMIN_CREATE_CREDIT_PAYMENT_MUTATION,
  balanceSql,
  chooseCard,
  FETCH_CREDIT_PAYMENTS_QUERY,
  findTicketPayment,
  formatPaymentAmount,
  LOG_ROLES_MUTATION,
  readCcAccountRows,
  readCreateResult,
  readCreditPayments,
  readSpendSlug,
  SPEND_CLIENT_QUERY,
  type CardChoice,
  type CreditPayment,
} from './estateCcPayment';

export interface EstateDeps {
  gql(service: AtlasGraphqlService, op: string, query: string, vars: Record<string, unknown>): Promise<unknown>;
  sql(sql: string): Promise<Record<string, unknown>[]>;
  storageGet(key: string): Promise<unknown>;
  storageSet(key: string, value: unknown): Promise<void>;
  sleep(ms: number): Promise<void>;
}

export const chromeEstateDeps: EstateDeps = {
  gql: atlasGraphql,
  sql: (sql) => runPresetSql(sql),
  storageGet: async (key) => (await chrome.storage.local.get(key))[key],
  storageSet: (key, value) => chrome.storage.local.set({ [key]: value }),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// --- Stored state: "payment sent for WOCOO-XXXXX" survives closing the tile ---

const stateKey = (ticketKey: string) => `estate_cc_payment:${ticketKey.toUpperCase()}`;

export async function loadEstateState(
  ticketKey: string,
  deps: EstateDeps = chromeEstateDeps,
): Promise<{ paymentId: string; at: string } | null> {
  const v = asRecord(await deps.storageGet(stateKey(ticketKey)));
  return v && typeof v.paymentId === 'string' && typeof v.at === 'string'
    ? { paymentId: v.paymentId, at: v.at }
    : null;
}

export async function saveEstateState(
  ticketKey: string,
  paymentId: string,
  deps: EstateDeps = chromeEstateDeps,
): Promise<void> {
  await deps.storageSet(stateKey(ticketKey), { paymentId, at: new Date().toISOString() });
}

// --- Reads ---

async function fetchPayments(cardId: string, deps: EstateDeps): Promise<CreditPayment[]> {
  const res = await deps.gql('fort_knox', 'FetchCreditPaymentsAtlas', FETCH_CREDIT_PAYMENTS_QUERY, {
    accountCanonicalId: cardId, first: 20, after: null, before: null,
  });
  return readCreditPayments(res);
}

/** Every custodian account number (the "SO -" numbers in Atlas's sidebar), upper-cased. */
async function fetchCustodianIds(accountId: string, deps: EstateDeps): Promise<string[]> {
  const res = await deps.gql('wealthsimple', 'getAccountDetails', GET_ACCOUNT_DETAILS_QUERY, { id: accountId });
  const custodians = asRecord(asRecord(asRecord(res)?.data)?.account)?.custodianAccounts;
  if (!Array.isArray(custodians)) return [];
  return custodians
    .map((c) => asRecord(c)?.custodianAccountId)
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
    .map((id) => id.toUpperCase());
}

export interface EstateLookup {
  card: CardChoice;
  spendSlug: string | null;
  ownedAccountNumbers: string[];
  payments: CreditPayment[];
  existing: CreditPayment | null;
}

/**
 * Everything the tile needs before Pay can unlock. Any failed read rejects the whole
 * lookup — the duplicate check in particular must succeed, so the UI keeps Pay blocked
 * and offers Retry.
 */
export async function loadEstateLookup(
  identityId: string,
  ticketKey: string,
  deps: EstateDeps = chromeEstateDeps,
): Promise<EstateLookup> {
  const [rows, spendRes] = await Promise.all([
    deps.sql(balanceSql(identityId)),
    deps.gql('fort_knox', 'SpendClient', SPEND_CLIENT_QUERY, { identityId }),
  ]);
  const card = chooseCard(readCcAccountRows(rows));
  const spendSlug = readSpendSlug(spendRes);
  const cardId = card.kind === 'ok' ? card.card.accountCanonicalId : null;

  const [slugIds, cardIds, payments] = await Promise.all([
    spendSlug ? fetchCustodianIds(spendSlug, deps) : Promise.resolve([]),
    cardId ? fetchCustodianIds(cardId, deps) : Promise.resolve([]),
    cardId ? fetchPayments(cardId, deps) : Promise.resolve([]),
  ]);
  return {
    card,
    spendSlug,
    ownedAccountNumbers: [...new Set([...slugIds, ...cardIds])],
    payments,
    existing: findTicketPayment(payments, ticketKey),
  };
}

// --- Pay ---

export type PayOutcome =
  | { kind: 'paid'; payment: CreditPayment }
  | { kind: 'sent'; paymentId: string }
  | { kind: 'failed'; message: string };

// One in-flight pay per ticket: a double click or a re-render shares the first promise.
const inFlight = new Map<string, Promise<PayOutcome>>();

export function payEstateCard(
  args: { ticketKey: string; cardId: string; spendSlug: string; amount: number },
  deps: EstateDeps = chromeEstateDeps,
): Promise<PayOutcome> {
  const key = args.ticketKey.toUpperCase();
  const existing = inFlight.get(key);
  if (existing) return existing;
  const p = doPay(args, deps).finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

async function doPay(
  args: { ticketKey: string; cardId: string; spendSlug: string; amount: number },
  deps: EstateDeps,
): Promise<PayOutcome> {
  const { ticketKey, cardId, spendSlug, amount } = args;
  if (!(amount > 0)) return { kind: 'failed', message: 'Nothing to pay: the amount must be greater than 0.' };

  // Atlas logs the role before every manual payment; do the same, and never pay without it.
  try {
    const audit = await deps.gql('fort_knox', 'logRolesAndScopes', LOG_ROLES_MUTATION, {
      input: { roles: ['payment_cards_ops'] },
    });
    if (asRecord(asRecord(asRecord(audit)?.data)?.logRolesAndScopes)?.success !== true) {
      return { kind: 'failed', message: 'Atlas audit call (logRolesAndScopes) did not succeed — payment not sent.' };
    }
  } catch (e) {
    return { kind: 'failed', message: `${errorMessage(e)} — payment not sent.` };
  }

  // After the mutation is sent, a failure may still have landed: the server keys
  // idempotency on the ticket, so re-query before calling it a failure.
  const recover = async (message: string): Promise<PayOutcome> => {
    try {
      const found = findTicketPayment(await fetchPayments(cardId, deps), ticketKey);
      if (found) {
        await saveEstateState(ticketKey, found.id, deps);
        return { kind: 'paid', payment: found };
      }
    } catch (e) {
      return { kind: 'failed', message: `${message} (and re-checking payments failed: ${errorMessage(e)} — check Atlas before retrying)` };
    }
    return { kind: 'failed', message };
  };

  let res: unknown;
  try {
    res = await deps.gql('fort_knox', 'AdminCreateCreditPayment', ADMIN_CREATE_CREDIT_PAYMENT_MUTATION, {
      input: {
        destinationAccountCanonicalId: cardId,
        sourceAccountCanonicalId: spendSlug,
        paymentAmount: formatPaymentAmount(amount),
        ticketId: ticketKey,
      },
    });
  } catch (e) {
    return recover(errorMessage(e));
  }

  const result = readCreateResult(res);
  if (result.kind === 'initiated') {
    await saveEstateState(ticketKey, result.paymentId, deps);
    return { kind: 'sent', paymentId: result.paymentId };
  }
  if (result.kind === 'conflict') return recover(result.message);
  return { kind: 'failed', message: result.message };
}

/**
 * Polls the card's payments for this ticket's payment until it is `succeeded`. Returns
 * the succeeded payment, else the last one seen (e.g. still pending), else null.
 */
export async function waitForSucceeded(
  cardId: string,
  ticketKey: string,
  deps: EstateDeps = chromeEstateDeps,
  opts: { tries?: number; intervalMs?: number } = {},
): Promise<CreditPayment | null> {
  const tries = opts.tries ?? 6;
  const intervalMs = opts.intervalMs ?? 2500;
  let last: CreditPayment | null = null;
  for (let i = 0; i < tries; i++) {
    if (i > 0) await deps.sleep(intervalMs);
    const found = findTicketPayment(await fetchPayments(cardId, deps), ticketKey);
    if (found) {
      last = found;
      if (found.status === 'succeeded') return found;
    }
  }
  return last;
}
