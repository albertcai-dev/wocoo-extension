// Direct Ledge GraphQL access for Wires Pending Posting v2.
//
// The new Ledge SPA (ledge-spa.cac1.pro1.production.w10e.com) is an Apollo client that
// reads its data from a separate GraphQL host. There is no Vaadin grid to scrape any
// more — `accountTransactions` hands back the rows as JSON, so v2 asks for them
// directly instead of driving the page like `content/ledge.ts` does for old Ledge.
//
// The query document below was recorded from the SPA's own network traffic and then
// trimmed to the fields the wire match needs.

export const LEDGE_SPA_URL = 'https://ledge-spa.cac1.pro1.production.w10e.com/account-inquiry';
export const LEDGE_GRAPHQL_URL = 'https://ledge.cac1.pro1.production.w10e.com/graphql';

/** Ledge's own operation name. Kept verbatim so server-side logs stay recognisable. */
export const GET_ACCOUNT_TRANSACTIONS_QUERY = `query GetAccountTransactions($accountId: String!, $startDate: String!, $endDate: String!, $page: Int, $size: Int) {
  accountTransactions(
    accountId: $accountId
    startDate: $startDate
    endDate: $endDate
    page: $page
    size: $size
  ) {
    nodes {
      effectiveDate
      txnType
      description
      debit
      credit
      transactionCurrency
      reference
      externalReference
      __typename
    }
    pageInfo {
      page
      pageSize
      hasNextPage
      pageCount
      totalCount
      __typename
    }
    __typename
  }
}`;

/** One transaction row. Ledge sends the money columns as decimal strings. */
export interface LedgeTransaction {
  effectiveDate: string;
  txnType: string;
  description: string;
  debit: string | number | null;
  credit: string | number | null;
  transactionCurrency: string | null;
  reference: string | null;
  externalReference: string | null;
}

export interface LedgePageInfo {
  page: number;
  pageSize: number;
  hasNextPage: boolean;
  pageCount: number;
  totalCount: number;
}

export interface LedgeTransactionPage {
  nodes: LedgeTransaction[];
  pageInfo: LedgePageInfo;
}

export interface TransactionWindow {
  startDate: string;
  endDate: string;
}

/** Rows we accept as an incoming wire by type code. Normalising away spaces means a
 *  `WIRE IN` rendering would still land. Kept because it costs nothing, but Ledge does
 *  not actually file incoming wires under this code — see `WIRE_IN_DESCRIPTION_RE`. */
const WIRE_IN_TYPES = new Set(['WIREIN']);

/** The real wire marker on a Ledge row. An incoming wire arrives as txnType `DEP` with
 *  sub-type `WIRE`, and the transaction query exposes no sub-type field, so the
 *  description ("Wire In 4094.24 USD", "Client Wire In") is the only wire signal on the
 *  payload. v1's DOM scrape matched the same text. `in` is anchored so a `Wire Out` row
 *  cannot match. */
const WIRE_IN_DESCRIPTION_RE = /(?:client\s+)?wire\s*in\b/i;

/** Ledge's default From-date is only a couple of days back, so a wire from last month
 *  falls outside the window unless we widen it. Wires older than this fall back to a
 *  half-year sweep rather than failing outright. */
const FALLBACK_WINDOW_DAYS = 180;

/** Safety cap on pagination. 40 pages × 25 rows covers any real account's window. */
const MAX_PAGES = 40;

function normalizeType(v: string | null | undefined): string {
  return (v || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

/** Parse a decimal-string money column. Returns null when the cell has no number. */
function parseMoney(v: string | number | null | undefined): number | null {
  if (v == null) return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  const n = Number(String(v).replace(/[,$\s]/g, ''));
  return isFinite(n) ? n : null;
}

/** Some senders (notably RBC Client Services) deduct a fee on the way in, so the Ledge
 *  credit can sit a little under the sheet's amount. Same rule v1 used. */
function toleranceFor(expected: number): number {
  return Math.max(100, Math.abs(expected) * 0.005);
}

/**
 * Find the incoming-wire row matching an expected amount and currency.
 *
 * A row qualifies when its type code or its description marks it a wire-in, its
 * currency matches, and its credit is non-zero and within tolerance of `expected`.
 * When several qualify, the closest wins.
 */
export function matchWireIn(
  nodes: LedgeTransaction[],
  expected: number,
  currency: string,
): LedgeTransaction | null {
  const tolerance = toleranceFor(expected);
  const wantCurrency = (currency || '').toUpperCase();
  let best: { diff: number; node: LedgeTransaction } | null = null;

  for (const node of nodes) {
    const typeMatches = WIRE_IN_TYPES.has(normalizeType(node.txnType));
    if (!typeMatches && !WIRE_IN_DESCRIPTION_RE.test(node.description || '')) continue;
    const rowCurrency = (node.transactionCurrency || '').toUpperCase();
    if (wantCurrency && rowCurrency && rowCurrency !== wantCurrency) continue;
    const credit = parseMoney(node.credit);
    if (credit == null || credit === 0) continue;
    const diff = Math.abs(credit - expected);
    if (diff > tolerance) continue;
    if (!best || diff < best.diff) best = { diff, node };
  }
  return best ? best.node : null;
}

/** sessionStorage key the SPA's Okta client writes its tokens to. */
export const OKTA_TOKEN_STORAGE_KEY = 'okta-token-storage';

/** A three-segment JWT. Loose on purpose — we only need to tell a token apart from
 *  the timestamps and type strings sitting beside it. */
const JWT_RE = /^ey[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/**
 * Pull the Okta access token out of the SPA's `okta-token-storage` entry.
 *
 * okta-auth-js has moved this value between shapes across versions, so rather than
 * pinning one path we walk the parsed object for a JWT that sits under an
 * `accessToken` key. The `idToken` subtree is skipped: it holds a JWT too, and Ledge
 * rejects it.
 */
export function readAccessTokenFromOktaStorage(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const walk = (node: unknown, underAccessToken: boolean): string | null => {
    if (typeof node === 'string') {
      return underAccessToken && JWT_RE.test(node) ? node : null;
    }
    if (typeof node !== 'object' || node === null) return null;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      const lowered = key.toLowerCase();
      if (!underAccessToken && lowered === 'idtoken') continue;
      const found = walk(value, underAccessToken || lowered === 'accesstoken');
      if (found) return found;
    }
    return null;
  };

  return walk(parsed, false);
}

/** Parse a sheet wire_timestamp display value. Accepts `2026-05-29`, `5/29/2026`,
 *  `5/29/26` and anything `Date` itself understands. Returns null on failure. */
export function parseWireDate(s: string): Date | null {
  const trimmed = (s || '').trim();
  if (!trimmed) return null;

  let m = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return isNaN(d.getTime()) ? null : d;
  }
  m = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) {
    let year = Number(m[3]);
    if (year < 100) year += 2000;
    const d = new Date(year, Number(m[1]) - 1, Number(m[2]));
    return isNaN(d.getTime()) ? null : d;
  }
  const parsed = new Date(trimmed);
  return isNaN(parsed.getTime()) ? null : parsed;
}

function formatYMD(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function shiftDays(d: Date, days: number): Date {
  const out = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  out.setDate(out.getDate() + days);
  return out;
}

/**
 * The date range to ask Ledge for: one day either side of the wire so a value-date
 * shift can't push the row out of range, ending today.
 */
export function transactionWindow(wireTimestamp: string, today: Date): TransactionWindow {
  const wireDate = parseWireDate(wireTimestamp);
  const start = wireDate ? shiftDays(wireDate, -1) : shiftDays(today, -FALLBACK_WINDOW_DAYS);
  return { startDate: formatYMD(start), endDate: formatYMD(today) };
}

export interface TransactionVariables {
  accountId: string;
  startDate: string;
  endDate: string;
  page: number;
  size: number;
}

/** Rows per request. Matches what the SPA itself asks for. */
export const PAGE_SIZE = 25;

/**
 * Build the GraphQL request for one page of transactions.
 *
 * Split out from the fetch so the header and body contract is testable without a
 * network round-trip. `x-ledge-surface` mirrors what the SPA sends.
 */
export function buildTransactionsRequest(
  accessToken: string,
  variables: TransactionVariables,
): { url: string; init: RequestInit } {
  return {
    url: LEDGE_GRAPHQL_URL,
    init: {
      method: 'POST',
      headers: {
        accept: '*/*',
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
        'x-ledge-surface': 'SPA',
      },
      body: JSON.stringify({
        operationName: 'GetAccountTransactions',
        variables,
        query: GET_ACCOUNT_TRANSACTIONS_QUERY,
      }),
    },
  };
}

/** Fetch one page. Throws on transport, HTTP and GraphQL-level errors alike so the
 *  caller can surface a single reason string. */
export async function fetchTransactionPage(
  accessToken: string,
  variables: TransactionVariables,
): Promise<LedgeTransactionPage> {
  const { url, init } = buildTransactionsRequest(accessToken, variables);
  const res = await fetch(url, init);
  if (!res.ok) {
    // 401 here almost always means the SPA tab's Okta token expired mid-run.
    throw new Error(`Ledge GraphQL HTTP ${res.status}${res.status === 401 ? ' — reload the Ledge tab to refresh the token' : ''}`);
  }
  const json = (await res.json()) as {
    data?: { accountTransactions?: LedgeTransactionPage };
    errors?: { message?: string }[];
  };
  if (json.errors?.length) {
    throw new Error(`Ledge GraphQL error: ${json.errors.map((e) => e.message || 'unknown').join('; ')}`);
  }
  const page = json.data?.accountTransactions;
  if (!page) throw new Error('Ledge GraphQL returned no accountTransactions payload');
  return page;
}

/**
 * Walk every page of a transaction query. `fetchPage` receives the zero-based page
 * index; pagination stops when Ledge clears `hasNextPage` or the page cap is reached.
 */
export async function fetchAllTransactions(
  fetchPage: (page: number) => Promise<LedgeTransactionPage>,
): Promise<LedgeTransaction[]> {
  const all: LedgeTransaction[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await fetchPage(page);
    all.push(...result.nodes);
    if (!result.pageInfo?.hasNextPage) break;
  }
  return all;
}
