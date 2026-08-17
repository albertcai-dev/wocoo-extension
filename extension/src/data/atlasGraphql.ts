// Direct Atlas GraphQL access, replacing the background-tab DOM scrape for the
// account-number + client-status lookup.
//
// Atlas is a client-rendered SPA whose identity routes 404 server-side, so there is
// no HTML to parse; the data all arrives over GraphQL. Everything below was recorded
// from Atlas's own network traffic — see
// docs/superpowers/specs/2026-08-17-atlas-graphql-account-lookup-design.md.

/** Matches the shape `content/atlas.ts` looks for: W-prefixed, CAD-suffixed. */
export const SPEND_ACCOUNT_RE = /^W[A-Z0-9]+CAD$/i;

/** Atlas's "INDIVIDUAL TIERS > Status" cell is a package id, not an entitlement. */
const INDIVIDUAL_TIER_RE = /^individual-tier-(core|premium|generation)$/i;

export interface AtlasLookupResult {
  accountNumber: string;
  /** Atlas's "INDIVIDUAL TIERS > Status". Null when the identity has no such package. */
  individualTierStatus: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

const ATLAS_GRAPHQL_BASE = 'https://cs-tools-satori.wealthsimple.com/api/atlas/graphql';

export type AtlasGraphqlService = 'fort_knox' | 'wealthsimple' | 'invest_graphql_api';

// Atlas's own document, verbatim — the only operation of the three where we need a
// field (`account_canonical_id`) that sits behind an inline fragment.
export const WS_BANK_ACCOUNT_QUERY = `query WsBankAccount($identityId: ID!) {
  funding_methods(fundable_type: WsBankAccount, identity_id: $identityId) {
    ... on WsBankAccount {
      account_canonical_id
      __typename
    }
    __typename
  }
}`;

// Trimmed from Atlas's document, which requests ~60 fields. We use one.
export const GET_ACCOUNT_DETAILS_QUERY = `query getAccountDetails($id: ID!) {
  account(id: $id) {
    id
    custodianAccounts {
      custodianAccountId
      __typename
    }
    __typename
  }
}`;

// Trimmed: Atlas also pulls every entitlement, which we deliberately ignore.
export const FETCH_IDENTITY_PACKAGES_QUERY = `query FetchIdentityPackages($id: ID!) {
  identity(id: $id) {
    id
    packages {
      id
      __typename
    }
    __typename
  }
}`;

export async function atlasGraphql(
  service: AtlasGraphqlService,
  operationName: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<unknown> {
  const res = await fetch(`${ATLAS_GRAPHQL_BASE}/${service}`, {
    method: 'POST',
    // Atlas authenticates by cookie only — no Authorization header, no CSRF token.
    credentials: 'include',
    headers: { accept: '*/*', 'content-type': 'application/json' },
    body: JSON.stringify({ operationName, query, variables }),
  });
  if (!res.ok) {
    // A 401/403 here is the expected outcome if extension-origin requests do not
    // carry Atlas's cookies. The caller falls back to the background tab.
    throw new Error(`Atlas ${operationName} failed: HTTP ${res.status}`);
  }
  const body = (await res.json()) as unknown;
  const errors = asRecord(body)?.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    const message = asRecord(errors[0])?.message;
    throw new Error(
      `Atlas ${operationName} failed: ${typeof message === 'string' ? message : 'GraphQL error'}`,
    );
  }
  return body;
}

/** `WsBankAccount` → the spend account's canonical id, e.g. `ca-cash-msb-i_ma5GMI2g`. */
export function readSpendAccountCanonicalId(res: unknown): string | null {
  const methods = asRecord(asRecord(res)?.data)?.funding_methods;
  if (!Array.isArray(methods)) return null;
  for (const method of methods) {
    // Note: `account_number` on this node is the 8-digit bank number, NOT the W#.
    const id = asRecord(method)?.account_canonical_id;
    if (typeof id === 'string' && id) return id;
  }
  return null;
}

/** `getAccountDetails` → the W…CAD custodian account number, uppercased. */
export function readSpendCustodianAccountNumber(res: unknown): string | null {
  const account = asRecord(asRecord(asRecord(res)?.data)?.account);
  const custodians = account?.custodianAccounts;
  if (!Array.isArray(custodians)) return null;
  for (const custodian of custodians) {
    const id = asRecord(custodian)?.custodianAccountId;
    if (typeof id === 'string' && SPEND_ACCOUNT_RE.test(id)) return id.toUpperCase();
  }
  return null;
}

/** `FetchIdentityPackages` → `Core` | `Premium` | `Generation`, or null. */
export function readIndividualTier(res: unknown): string | null {
  const packages = asRecord(asRecord(asRecord(res)?.data)?.identity)?.packages;
  if (!Array.isArray(packages)) return null;
  for (const pkg of packages) {
    const id = asRecord(pkg)?.id;
    if (typeof id !== 'string') continue;
    const match = INDIVIDUAL_TIER_RE.exec(id);
    if (match) {
      const tier = match[1].toLowerCase();
      return tier.charAt(0).toUpperCase() + tier.slice(1);
    }
  }
  return null;
}
