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
