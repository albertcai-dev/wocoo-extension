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

/** `''` targets the bare `/api/atlas/graphql` path, which is where getProfileV2 lives. */
export type AtlasGraphqlService = '' | 'fort_knox' | 'wealthsimple' | 'invest_graphql_api';

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
  const url = service ? `${ATLAS_GRAPHQL_BASE}/${service}` : ATLAS_GRAPHQL_BASE;
  const res = await fetch(url, {
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

/**
 * `FetchIdentityPackages` → `Core` | `Premium` | `Generation`, or null.
 *
 * An `individual-tier-<tier>` package names an upgraded tier. Core carries no such
 * package, so a readable packages list with none of them means Core — measured against
 * Atlas itself: a client whose packages are `['default', 'direct-deposit-tier-4k']`
 * renders "INDIVIDUAL TIERS > Status: Core" on Atlas's own page.
 *
 * Null is reserved for "could not read", i.e. the response had no packages array. That
 * distinction matters: the UI can honestly say Core without claiming a failed fetch.
 */
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
  return 'Core';
}

/**
 * The full lookup: identity → spend account → W#, with the tier fetched alongside.
 *
 * Hops 1 and 3 both key off identityId so they run concurrently; hop 2 needs hop 1's
 * canonical id, so the total latency is two round trips, not three.
 */
export async function fetchAtlasAccountIdViaGraphql(
  args: { identityId: string },
): Promise<AtlasLookupResult> {
  const { identityId } = args;
  if (!identityId) throw new Error('identityId is required');

  // Attached immediately so a tier failure can never surface as an unhandled
  // rejection while we are awaiting the account hops. The tier is display-only
  // (SidePanel.tsx), so losing it must not lose the account number.
  const tier = atlasGraphql('invest_graphql_api', 'FetchIdentityPackages', FETCH_IDENTITY_PACKAGES_QUERY, {
    id: identityId,
  })
    .then(readIndividualTier)
    .catch(() => null);

  const bank = await atlasGraphql('fort_knox', 'WsBankAccount', WS_BANK_ACCOUNT_QUERY, { identityId });
  const canonicalId = readSpendAccountCanonicalId(bank);
  if (!canonicalId) {
    throw new Error('Atlas returned no Wealthsimple bank account for this identity');
  }

  const details = await atlasGraphql('wealthsimple', 'getAccountDetails', GET_ACCOUNT_DETAILS_QUERY, {
    id: canonicalId,
  });
  const accountNumber = readSpendCustodianAccountNumber(details);
  if (!accountNumber) {
    throw new Error(`No spend account number (W…CAD) on ${canonicalId}`);
  }

  return { accountNumber, individualTierStatus: await tier };
}

// -----------------------------------------------------------------------------
// Client legal name + mailing address, for the Refund Auth Letter workflow.
// -----------------------------------------------------------------------------

export interface AtlasClientDetailsResult {
  name: string;
  street: string;
  cityProvince: string;
  postal: string;
  /** False when Atlas is missing one of the four fields; the caller keeps them editable. */
  complete: boolean;
}

// Trimmed hard on purpose. Atlas's own getProfileV2 document also selects
// `taxIdentificationNumbers { numberUnobfuscated }` — a SIN in the clear — plus
// dateOfBirth, gender, employment and phone numbers. None of that belongs in a
// letter, so none of it is requested: not asking is the only real guarantee it
// never lands in chrome.storage, a console log, or a screenshot.
export const GET_PROFILE_V2_QUERY = `query getProfileV2($identity_id: ID!) {
  profileV2(identityId: $identity_id) {
    identityId
    person {
      legalName {
        firstName
        middleNames
        lastName
        __typename
      }
      mailingAddress {
        streetNumber
        streetName
        unit
        city
        provinceStateRegion
        postalCode
        __typename
      }
      residentialAddress {
        streetNumber
        streetName
        unit
        city
        provinceStateRegion
        postalCode
        __typename
      }
      __typename
    }
    __typename
  }
}`;

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Mirrors `formatPostal` in content/atlas.ts: `L4C1C6` → `L4C 1C6`, others untouched. */
function formatPostal(raw: string): string {
  const compact = raw.replace(/\s+/g, '').toUpperCase();
  if (/^[A-Z]\d[A-Z]\d[A-Z]\d$/.test(compact)) return `${compact.slice(0, 3)} ${compact.slice(3)}`;
  return raw.trim();
}

/**
 * `getProfileV2` → the four fields the refund letter needs.
 *
 * Mailing address wins over residential, matching what the DOM scraper did — the letter
 * is physically mailed, so a separate mailing address is the whole point of the field.
 */
export function readClientDetails(res: unknown): AtlasClientDetailsResult | null {
  const person = asRecord(asRecord(asRecord(asRecord(res)?.data)?.profileV2)?.person);
  if (!person) return null;

  const legal = asRecord(person.legalName);
  const name = [str(legal?.firstName), str(legal?.middleNames), str(legal?.lastName)]
    .filter(Boolean)
    .join(' ');

  const addr = asRecord(person.mailingAddress) ?? asRecord(person.residentialAddress);
  const streetLine = [str(addr?.streetNumber), str(addr?.streetName)].filter(Boolean).join(' ');
  const street = [str(addr?.unit), streetLine].filter(Boolean).join(', ');
  const cityProvince = [str(addr?.city), str(addr?.provinceStateRegion)].filter(Boolean).join(', ');
  const rawPostal = str(addr?.postalCode);
  const postal = rawPostal ? formatPostal(rawPostal) : '';

  return {
    name,
    street,
    cityProvince,
    postal,
    complete: Boolean(name && street && cityProvince && postal),
  };
}

export async function fetchAtlasClientDetailsViaGraphql(
  args: { identityId: string },
): Promise<AtlasClientDetailsResult> {
  const { identityId } = args;
  if (!identityId) throw new Error('identityId is required');

  const res = await atlasGraphql('', 'getProfileV2', GET_PROFILE_V2_QUERY, { identity_id: identityId });
  const details = readClientDetails(res);
  if (!details) throw new Error('Atlas returned no client details for this identity');
  return details;
}
