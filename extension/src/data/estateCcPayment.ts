// Pure logic for the Estate CC Payment workflow: documents, parsers and rules.
// Chrome and fetch are passed in by the caller (repo convention); this file has no
// side effects. See docs/superpowers/specs/2026-10-28-estate-cc-payment-design.md.

import { lowerKeys } from './presetSql';

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

// Atlas's own documents, verbatim — recorded 2026-10-28 from a real payment on WOCOO-10001.
// See the spec's "Exact recorded documents" section.

export const SPEND_CLIENT_QUERY = `query SpendClient($identityId: ID!) {
  spendClient(identityId: $identityId) {
    id status registeredAt spendDeactivatedAt spendUserId
    spendAccount { id linkedAccountCanonicalId physicalCardRequestState physicalCardRequestChangedAt canRequestPhysicalCard __typename }
    __typename
  }
}`;

export const LOG_ROLES_MUTATION = `mutation logRolesAndScopes($input: AtlasLogRolesAndScopesMutationInput!) {
  logRolesAndScopes(input: $input) { success __typename }
}`;

// Verbatim from the spec, plus `balanceModifierIdempotencyKey` on `node` (the brief's
// one deliberate addition — the spec notes it was "verified that it works ad hoc").
export const FETCH_CREDIT_PAYMENTS_QUERY = `query FetchCreditPaymentsAtlas($accountCanonicalId: ID!, $first: Int, $after: String, $last: Int, $before: String) {
  creditPayments(accountCanonicalId: $accountCanonicalId, first: $first, after: $after, last: $last, before: $before) {
    edges { cursor node { id amount status sourceExternalId postedAt createdAt scheduledPaymentId balanceModifierIdempotencyKey __typename } __typename }
    totalCount
    pageInfo { hasNextPage hasPreviousPage startCursor endCursor __typename }
    __typename
  }
}`;

export const ADMIN_CREATE_CREDIT_PAYMENT_MUTATION = `mutation AdminCreateCreditPayment($input: AdminCreateCreditPaymentInput!) {
  adminCreateCreditPayment(input: $input) {
    ... on AdminCreateCreditPaymentInitiated { canonicalId destinationAccountCanonicalId sourceAccountCanonicalId paymentAmount __typename }
    ... on AccountNotFoundError { message __typename }
    ... on AdminCreateCreditPaymentValidationError { message __typename }
    ... on AdminCreateCreditPaymentIdempotencyConflictError { message __typename }
    __typename
  }
}`;

// --- Pantheon balance (credit.mart_cc_accounts) ---

export type CcAccountRow = {
  accountCanonicalId: string;
  asOf: string;
  totalBalance: number;
  isOpen: boolean;
};

export type CardChoice =
  | { kind: 'ok'; card: CcAccountRow; closed: boolean }
  | { kind: 'none' }
  | { kind: 'multiple'; count: number };

const IDENTITY_ID_RE = /^identity-[A-Za-z0-9_-]+$/;

/**
 * `credit.mart_cc_accounts` for one identity. The id is interpolated directly into the
 * SQL (Preset SQL Lab, like `eligibilitySql.ts`), so it is validated against a strict
 * pattern first — anything else throws rather than risk injection.
 */
export function balanceSql(identityId: string): string {
  if (!IDENTITY_ID_RE.test(identityId)) {
    throw new Error(`balanceSql: invalid identity id ${JSON.stringify(identityId)}`);
  }
  return `select account_canonical_id, effective_as_at_date, total_balance, is_open_account
from credit.mart_cc_accounts
where identity_canonical_id = '${identityId}'`;
}

function num(v: unknown): number {
  if (typeof v === 'number') return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function str(v: unknown): string {
  return v == null ? '' : String(v);
}

function boolVal(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  const s = str(v).toLowerCase().trim();
  return s === 'true' || s === 't' || s === '1';
}

/** Snowflake returns upper-case column names; lower-case first per repo convention. */
export function readCcAccountRows(rows: Record<string, unknown>[]): CcAccountRow[] {
  return rows.map(lowerKeys).map((r) => ({
    accountCanonicalId: str(r.account_canonical_id),
    asOf: str(r.effective_as_at_date),
    totalBalance: num(r.total_balance),
    isOpen: boolVal(r.is_open_account),
  }));
}

/**
 * Card-selection rule (spec "Stop conditions"). Prefer open rows; among them, 1 is ok,
 * 2+ is "multiple — do this one manually". With no open rows, fall back to the rows that
 * owe money (`totalBalance < 0`): 1 is ok-but-closed, 2+ is still multiple, 0 is none.
 */
export function chooseCard(rows: CcAccountRow[]): CardChoice {
  const open = rows.filter((r) => r.isOpen);
  if (open.length === 1) return { kind: 'ok', card: open[0], closed: false };
  if (open.length >= 2) return { kind: 'multiple', count: open.length };

  const closedOwing = rows.filter((r) => !r.isOpen && r.totalBalance < 0);
  if (closedOwing.length === 1) return { kind: 'ok', card: closedOwing[0], closed: true };
  if (closedOwing.length >= 2) return { kind: 'multiple', count: closedOwing.length };

  return { kind: 'none' };
}

/** Negative `totalBalance` means the client owes. Null when nothing is owed (>= 0). */
export function amountOwed(totalBalance: number): number | null {
  if (totalBalance >= 0) return null;
  return Math.round(-totalBalance * 100) / 100;
}

/** `paymentAmount` for the mutation is a string with exactly 2 decimals. */
export function formatPaymentAmount(n: number): string {
  return n.toFixed(2);
}

// --- SpendClient (chequing slug) ---

/** `SpendClient` → the linked chequing account's canonical id, or null. */
export function readSpendSlug(res: unknown): string | null {
  const spendClient = asRecord(asRecord(asRecord(res)?.data)?.spendClient);
  const spendAccount = asRecord(spendClient?.spendAccount);
  const id = spendAccount?.linkedAccountCanonicalId;
  return typeof id === 'string' && id ? id : null;
}

// --- Credit payments / idempotency ---

export type CreditPayment = {
  id: string;
  amount: string;
  status: string;
  createdAt: string;
  idempotencyKey: string | null;
};

/** Server-side idempotency key: `card-payment-ops-` + the lower-cased ticket key. */
export function idempotencyKeyFor(ticketKey: string): string {
  return `card-payment-ops-${ticketKey.toLowerCase()}`;
}

/** `FetchCreditPaymentsAtlas` → the flat list of payments on the card. */
export function readCreditPayments(res: unknown): CreditPayment[] {
  const edges = asRecord(asRecord(asRecord(res)?.data)?.creditPayments)?.edges;
  if (!Array.isArray(edges)) return [];
  const payments: CreditPayment[] = [];
  for (const edge of edges) {
    const node = asRecord(asRecord(edge)?.node);
    if (!node) continue;
    const id = node.id;
    if (typeof id !== 'string' || !id) continue;
    const key = node.balanceModifierIdempotencyKey;
    payments.push({
      id,
      amount: str(node.amount),
      status: str(node.status),
      createdAt: str(node.createdAt),
      idempotencyKey: typeof key === 'string' ? key : null,
    });
  }
  return payments;
}

/** The payment already made for this ticket, by exact idempotency-key match, or null. */
export function findTicketPayment(payments: CreditPayment[], ticketKey: string): CreditPayment | null {
  const want = idempotencyKeyFor(ticketKey);
  return payments.find((p) => p.idempotencyKey === want) ?? null;
}

// --- AdminCreateCreditPayment result ---

export type CreateResult =
  | { kind: 'initiated'; paymentId: string }
  | { kind: 'conflict'; message: string }
  | { kind: 'error'; message: string };

/** Only these four `__typename`s count as results; anything else is a failure. */
export function readCreateResult(res: unknown): CreateResult {
  const result = asRecord(asRecord(asRecord(res)?.data)?.adminCreateCreditPayment);
  const typename = result?.__typename;
  const message = typeof result?.message === 'string' ? result.message : 'Unknown error from Atlas.';

  if (typename === 'AdminCreateCreditPaymentInitiated') {
    const paymentId = result?.canonicalId;
    if (typeof paymentId === 'string' && paymentId) return { kind: 'initiated', paymentId };
    return { kind: 'error', message: 'AdminCreateCreditPaymentInitiated had no canonicalId.' };
  }
  if (typename === 'AdminCreateCreditPaymentIdempotencyConflictError') {
    return { kind: 'conflict', message };
  }
  if (typename === 'AccountNotFoundError' || typename === 'AdminCreateCreditPaymentValidationError') {
    return { kind: 'error', message };
  }
  return { kind: 'error', message };
}

// --- Account-number mismatch check ---

const ACCOUNT_NUMBER_RE = /\b[A-Z][A-Z0-9]{8,10}CAD\b/gi;

/** Every `…CAD`-style account number named in free text, upper-cased and de-duplicated. */
export function extractAccountNumbers(description: string): string[] {
  const matches = description.match(ACCOUNT_NUMBER_RE) ?? [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of matches) {
    const upper = m.toUpperCase();
    if (!seen.has(upper)) {
      seen.add(upper);
      out.push(upper);
    }
  }
  return out;
}

/** Account numbers named in the ticket that belong to neither the chequing nor the card. */
export function strangerAccountNumbers(named: string[], owned: string[]): string[] {
  const ownedSet = new Set(owned);
  return named.filter((n) => !ownedSet.has(n));
}

// --- Jira comment ---

/** The default wrap-up comment (spec step 7). `@{reporter}` becomes a mention pill. */
export function buildEstateComment(reporter: string | undefined): string {
  const mention = reporter ? `@${reporter}` : 'team';
  return (
    `Hi ${mention}, I've processed the payment from client's chequing account to pay off ` +
    `their balance! You can proceed to close the card now.`
  );
}
