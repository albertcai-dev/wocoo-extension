# Atlas Account Lookup Without a Tab — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the background-tab DOM scrape behind "Fetch Account Number (W#) and Client Status" with three direct Atlas GraphQL calls, keeping the tab as an automatic fallback.

**Architecture:** A new `data/atlasGraphql.ts` holds one `fetch` transport plus three pure response readers, so all parsing is unit-testable without a network. `data/atlasAccountLookup.ts` keeps its exported name `fetchAtlasAccountIdHeadless` and gains a try-GraphQL-then-tab body, which means the five existing call sites do not change at all.

**Tech Stack:** TypeScript 5.6, Vite 5, MV3 Chrome extension, Vitest 2 (added by this plan — the extension currently has no test runner).

**Spec:** `docs/superpowers/specs/2026-08-17-atlas-graphql-account-lookup-design.md`

## Global Constraints

- All GraphQL POSTs go to `https://cs-tools-satori.wealthsimple.com/api/atlas/graphql/<service>` where `<service>` is one of `fort_knox`, `wealthsimple`, `invest_graphql_api`.
- Every request sends exactly these headers: `accept: '*/*'` and `content-type: 'application/json'`. **No Authorization header, no CSRF token.** Auth is cookies, so every request sets `credentials: 'include'`.
- The spend account number regex is `/^W[A-Z0-9]+CAD$/i` — the same one already in `extension/src/content/atlas.ts` as `SPEND_ACCOUNT_RE`. Returned values are uppercased.
- The individual tier comes from `packages[].id` matching `/^individual-tier-(core|premium|generation)$/i`. **Never** read it from `entitlements[].category` — real responses contain `category: "premium"` on unrelated features.
- `fetchAtlasAccountIdHeadless` must keep its exported name, its `FetchAtlasAccountIdArgs` parameter shape, and its `AtlasLookupResult` return shape. Do not touch its five call sites.
- A tier failure must never fail the whole lookup; it degrades to `individualTierStatus: null`. An account-number failure must fail (and therefore trigger the tab fallback).
- `fetchAtlasClientEmailHeadless` and `fetchAtlasClientDetailsHeadless` are out of scope. Do not modify them.
- Run all commands from `extension/` unless a path says otherwise.

---

### Task 1: Test runner and the three pure response readers

The readers are pure functions of a parsed JSON response, so they carry the real tests. Vitest is added here because this is the task whose deliverable needs it.

**Files:**
- Create: `extension/vitest.config.ts`
- Create: `extension/src/data/atlasGraphql.ts`
- Test: `extension/src/data/atlasGraphql.test.ts`
- Modify: `extension/package.json` (devDependency + `test` script)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type AtlasLookupResult = { accountNumber: string; individualTierStatus: string | null }`
  - `readSpendAccountCanonicalId(res: unknown): string | null`
  - `readSpendCustodianAccountNumber(res: unknown): string | null`
  - `readIndividualTier(res: unknown): string | null`
  - `SPEND_ACCOUNT_RE: RegExp`

- [ ] **Step 1: Install Vitest**

```bash
npm install -D vitest@^2
```

Vitest 2 is the major that pairs with Vite 5, which is what `package.json` pins.

- [ ] **Step 2: Add the test script**

In `extension/package.json`, add to `"scripts"`:

```json
"test": "vitest run"
```

- [ ] **Step 3: Give Vitest its own config**

Create `extension/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

// Deliberately NOT reusing vite.config.ts. That config loads @crxjs/vite-plugin,
// which rewrites the module graph for an MV3 build and has no business running
// during unit tests. The tests here are plain functions — no DOM, no bundler.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
```

- [ ] **Step 4: Write the failing tests**

Create `extension/src/data/atlasGraphql.test.ts`. Every fixture below is a real recorded Atlas response, trimmed to the fields the readers touch.

```ts
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
```

- [ ] **Step 5: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Failed to resolve import "./atlasGraphql"`.

- [ ] **Step 6: Write the readers**

Create `extension/src/data/atlasGraphql.ts`:

```ts
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
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS, 15 tests.

- [ ] **Step 8: Confirm the build still typechecks**

Run: `npx tsc -b`
Expected: no output, exit 0.

- [ ] **Step 9: Commit**

```bash
git add extension/package.json extension/package-lock.json extension/vitest.config.ts \
        extension/src/data/atlasGraphql.ts extension/src/data/atlasGraphql.test.ts
git commit -m "Add Vitest and pure readers for Atlas GraphQL responses"
```

If the commit hangs, SSH signing is failing — see "Known environment issue" at the bottom of this plan.

---

### Task 2: The GraphQL transport and the host permission

**Files:**
- Modify: `extension/src/data/atlasGraphql.ts`
- Modify: `extension/src/data/atlasGraphql.test.ts`
- Modify: `extension/manifest.json` (`host_permissions`)

**Interfaces:**
- Consumes: `asRecord` (module-private, from Task 1).
- Produces:
  - `type AtlasGraphqlService = 'fort_knox' | 'wealthsimple' | 'invest_graphql_api'`
  - `atlasGraphql(service: AtlasGraphqlService, operationName: string, query: string, variables: Record<string, unknown>): Promise<unknown>`
  - `WS_BANK_ACCOUNT_QUERY`, `GET_ACCOUNT_DETAILS_QUERY`, `FETCH_IDENTITY_PACKAGES_QUERY` — exported query strings.

- [ ] **Step 1: Add the host permission**

In `extension/manifest.json`, add to the `host_permissions` array (it already contains `https://atlas.wealthsimple.com/*`):

```json
"https://cs-tools-satori.wealthsimple.com/*"
```

This host is new to the extension. Adding a host permission makes Chrome re-prompt on reload — expected.

- [ ] **Step 2: Write the failing transport tests**

Append to `extension/src/data/atlasGraphql.test.ts`:

```ts
import { afterEach, vi } from 'vitest';
import { atlasGraphql } from './atlasGraphql';

afterEach(() => { vi.unstubAllGlobals(); });

function stubFetch(impl: (url: string, init: RequestInit) => Response) {
  const spy = vi.fn((url: unknown, init: unknown) =>
    Promise.resolve(impl(String(url), (init ?? {}) as RequestInit)));
  vi.stubGlobal('fetch', spy);
  return spy;
}

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

describe('atlasGraphql', () => {
  it('posts to the service path with cookies and the recorded headers', async () => {
    const spy = stubFetch(() => ok({ data: { ping: true } }));

    await atlasGraphql('fort_knox', 'WsBankAccount', 'query WsBankAccount { x }', { identityId: 'identity-1' });

    expect(spy).toHaveBeenCalledTimes(1);
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://cs-tools-satori.wealthsimple.com/api/atlas/graphql/fort_knox');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('include');
    expect(init.headers).toEqual({ accept: '*/*', 'content-type': 'application/json' });
    expect(JSON.parse(String(init.body))).toEqual({
      operationName: 'WsBankAccount',
      query: 'query WsBankAccount { x }',
      variables: { identityId: 'identity-1' },
    });
  });

  it('sends no Authorization header — Atlas authenticates by cookie alone', async () => {
    const spy = stubFetch(() => ok({ data: {} }));
    await atlasGraphql('wealthsimple', 'getAccountDetails', 'q', { id: 'ca-1' });
    const [, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(Object.keys(init.headers as Record<string, string>).map((k) => k.toLowerCase()))
      .not.toContain('authorization');
  });

  it('returns the parsed body on success', async () => {
    stubFetch(() => ok({ data: { identity: { id: 'identity-1' } } }));
    const res = await atlasGraphql('invest_graphql_api', 'FetchIdentityPackages', 'q', { id: 'identity-1' });
    expect(res).toEqual({ data: { identity: { id: 'identity-1' } } });
  });

  it('throws with the status on a non-2xx response', async () => {
    stubFetch(() => new Response('nope', { status: 403 }));
    await expect(atlasGraphql('fort_knox', 'WsBankAccount', 'q', {}))
      .rejects.toThrow(/WsBankAccount.*403/);
  });

  it('throws with the first GraphQL error message', async () => {
    stubFetch(() => ok({ errors: [{ message: 'Field x does not exist' }] }));
    await expect(atlasGraphql('wealthsimple', 'getAccountDetails', 'q', {}))
      .rejects.toThrow(/Field x does not exist/);
  });

  it('does not treat an empty errors array as a failure', async () => {
    stubFetch(() => ok({ data: { account: null }, errors: [] }));
    await expect(atlasGraphql('wealthsimple', 'getAccountDetails', 'q', {})).resolves.toBeTruthy();
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `atlasGraphql is not a function` / no such export.

- [ ] **Step 4: Implement the transport and the query documents**

Add to `extension/src/data/atlasGraphql.ts`:

```ts
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
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS, 21 tests.

- [ ] **Step 6: Typecheck**

Run: `npx tsc -b`
Expected: no output, exit 0.

- [ ] **Step 7: Commit**

```bash
git add extension/manifest.json extension/src/data/atlasGraphql.ts extension/src/data/atlasGraphql.test.ts
git commit -m "Add Atlas GraphQL transport and the cs-tools-satori host permission"
```

---

### Task 3: Orchestrate the three hops

**Files:**
- Modify: `extension/src/data/atlasGraphql.ts`
- Modify: `extension/src/data/atlasGraphql.test.ts`

**Interfaces:**
- Consumes: `atlasGraphql`, the three query constants, the three readers, `AtlasLookupResult` (all from Tasks 1–2).
- Produces: `fetchAtlasAccountIdViaGraphql(args: { identityId: string }): Promise<AtlasLookupResult>`

- [ ] **Step 1: Write the failing orchestration tests**

Append to `extension/src/data/atlasGraphql.test.ts`:

```ts
import { fetchAtlasAccountIdViaGraphql } from './atlasGraphql';

/** Routes a stubbed fetch by the operationName in the request body. */
function stubByOperation(handlers: Record<string, () => Response>) {
  const seen: string[] = [];
  const spy = vi.fn((url: unknown, init: unknown) => {
    const body = JSON.parse(String((init as RequestInit).body));
    seen.push(body.operationName);
    const handler = handlers[body.operationName];
    if (!handler) throw new Error(`unexpected operation ${body.operationName}`);
    return Promise.resolve(handler());
  });
  vi.stubGlobal('fetch', spy);
  return { spy, seen };
}

const BANK_OK = () => ok({ data: { funding_methods: [{ account_canonical_id: 'ca-cash-msb-i_ma5GMI2g' }] } });
const DETAILS_OK = () => ok({
  data: { account: { custodianAccounts: [{ custodianAccountId: 'C14792J29CAD' }, { custodianAccountId: 'WK6RQDY37CAD' }] } },
});
const PACKAGES_OK = () => ok({ data: { identity: { packages: [{ id: 'silver' }, { id: 'individual-tier-premium' }] } } });

describe('fetchAtlasAccountIdViaGraphql', () => {
  it('returns the W# and the tier', async () => {
    stubByOperation({
      WsBankAccount: BANK_OK,
      getAccountDetails: DETAILS_OK,
      FetchIdentityPackages: PACKAGES_OK,
    });

    const result = await fetchAtlasAccountIdViaGraphql({ identityId: 'identity-1' });

    expect(result).toEqual({ accountNumber: 'WK6RQDY37CAD', individualTierStatus: 'Premium' });
  });

  it('passes the canonical id from hop 1 into hop 2', async () => {
    const calls: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn((_url: unknown, init: unknown) => {
      const body = JSON.parse(String((init as RequestInit).body));
      calls.push(body.variables);
      if (body.operationName === 'WsBankAccount') return Promise.resolve(BANK_OK());
      if (body.operationName === 'getAccountDetails') return Promise.resolve(DETAILS_OK());
      return Promise.resolve(PACKAGES_OK());
    }));

    await fetchAtlasAccountIdViaGraphql({ identityId: 'identity-1' });

    expect(calls).toContainEqual({ id: 'ca-cash-msb-i_ma5GMI2g' });
  });

  it('still returns the W# when the tier operation fails', async () => {
    stubByOperation({
      WsBankAccount: BANK_OK,
      getAccountDetails: DETAILS_OK,
      FetchIdentityPackages: () => new Response('boom', { status: 500 }),
    });

    const result = await fetchAtlasAccountIdViaGraphql({ identityId: 'identity-1' });

    expect(result).toEqual({ accountNumber: 'WK6RQDY37CAD', individualTierStatus: null });
  });

  it('throws when the identity has no WsBankAccount funding method', async () => {
    stubByOperation({
      WsBankAccount: () => ok({ data: { funding_methods: [] } }),
      FetchIdentityPackages: PACKAGES_OK,
    });

    await expect(fetchAtlasAccountIdViaGraphql({ identityId: 'identity-1' }))
      .rejects.toThrow(/no Wealthsimple bank account/i);
  });

  it('throws when no custodian account is a spend account', async () => {
    stubByOperation({
      WsBankAccount: BANK_OK,
      getAccountDetails: () => ok({ data: { account: { custodianAccounts: [{ custodianAccountId: 'C14792J29CAD' }] } } }),
      FetchIdentityPackages: PACKAGES_OK,
    });

    await expect(fetchAtlasAccountIdViaGraphql({ identityId: 'identity-1' }))
      .rejects.toThrow(/spend account number/i);
  });

  it('rejects an empty identityId without calling the network', async () => {
    const { spy } = stubByOperation({});
    await expect(fetchAtlasAccountIdViaGraphql({ identityId: '' })).rejects.toThrow(/identityId is required/);
    expect(spy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `fetchAtlasAccountIdViaGraphql is not a function`.

- [ ] **Step 3: Implement the orchestration**

Add to the end of `extension/src/data/atlasGraphql.ts`:

```ts
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS, 27 tests.

- [ ] **Step 5: Typecheck**

Run: `npx tsc -b`
Expected: no output, exit 0.

- [ ] **Step 6: Commit**

```bash
git add extension/src/data/atlasGraphql.ts extension/src/data/atlasGraphql.test.ts
git commit -m "Chain the three Atlas GraphQL hops into one account lookup"
```

---

### Task 4: Wire GraphQL first, background tab as fallback

**Files:**
- Modify: `extension/src/data/atlasAccountLookup.ts`
- Test: `extension/src/data/atlasAccountLookup.test.ts`

**Interfaces:**
- Consumes: `fetchAtlasAccountIdViaGraphql`, `AtlasLookupResult` (Tasks 1 and 3).
- Produces:
  - `fetchAtlasAccountIdViaTab(args: FetchAtlasAccountIdArgs): Promise<AtlasLookupResult>` — the old body, renamed.
  - `fetchAtlasAccountIdHeadless(args: FetchAtlasAccountIdArgs): Promise<AtlasLookupResult>` — unchanged signature, new body.

- [ ] **Step 1: Write the failing wiring tests**

Create `extension/src/data/atlasAccountLookup.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./atlasGraphql', () => ({ fetchAtlasAccountIdViaGraphql: vi.fn() }));

import { fetchAtlasAccountIdViaGraphql } from './atlasGraphql';
import { fetchAtlasAccountIdHeadless } from './atlasAccountLookup';

const GRAPHQL_RESULT = { accountNumber: 'WK6RQDY37CAD', individualTierStatus: 'Premium' };
const TAB_RESULT = { accountNumber: 'WTABFALLBACKCAD', individualTierStatus: null };

/**
 * Minimal chrome stub for the tab path. `tabs.create` resolves, then we immediately
 * fire the storage change the content script would have written.
 */
function stubChrome() {
  const listeners: Array<(c: Record<string, { newValue: unknown }>, area: string) => void> = [];
  const chromeStub = {
    storage: {
      local: { set: vi.fn(() => Promise.resolve()), remove: vi.fn(() => Promise.resolve()) },
      onChanged: {
        addListener: vi.fn((fn: (typeof listeners)[number]) => { listeners.push(fn); }),
        removeListener: vi.fn(),
      },
    },
    tabs: {
      create: vi.fn(() => {
        // Deliver the scrape on the next tick, once the listener is registered.
        setTimeout(() => {
          for (const fn of listeners) {
            fn({ atlas_account_number: { newValue: { sourceTicketId: 'WOCOO-1', ...TAB_RESULT } } }, 'local');
          }
        }, 0);
        return Promise.resolve({ id: 42 });
      }),
      remove: vi.fn(() => Promise.resolve()),
    },
  };
  vi.stubGlobal('chrome', chromeStub);
  return chromeStub;
}

beforeEach(() => {
  vi.mocked(fetchAtlasAccountIdViaGraphql).mockReset();
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('fetchAtlasAccountIdHeadless', () => {
  it('returns the GraphQL result and never opens a tab', async () => {
    const chromeStub = stubChrome();
    vi.mocked(fetchAtlasAccountIdViaGraphql).mockResolvedValue(GRAPHQL_RESULT);

    const result = await fetchAtlasAccountIdHeadless({ identityId: 'identity-1', sourceTicketId: 'WOCOO-1' });

    expect(result).toEqual(GRAPHQL_RESULT);
    expect(chromeStub.tabs.create).not.toHaveBeenCalled();
  });

  it('passes only the identityId to the GraphQL path', async () => {
    stubChrome();
    vi.mocked(fetchAtlasAccountIdViaGraphql).mockResolvedValue(GRAPHQL_RESULT);

    await fetchAtlasAccountIdHeadless({ identityId: 'identity-1', sourceTicketId: 'WOCOO-1' });

    expect(fetchAtlasAccountIdViaGraphql).toHaveBeenCalledWith({ identityId: 'identity-1' });
  });

  it('falls back to the background tab when GraphQL throws', async () => {
    const chromeStub = stubChrome();
    vi.mocked(fetchAtlasAccountIdViaGraphql).mockRejectedValue(new Error('HTTP 403'));

    const result = await fetchAtlasAccountIdHeadless({ identityId: 'identity-1', sourceTicketId: 'WOCOO-1' });

    expect(result.accountNumber).toBe('WTABFALLBACKCAD');
    expect(chromeStub.tabs.create).toHaveBeenCalledTimes(1);
  });

  it('logs which path produced the result', async () => {
    stubChrome();
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.mocked(fetchAtlasAccountIdViaGraphql).mockResolvedValue(GRAPHQL_RESULT);

    await fetchAtlasAccountIdHeadless({ identityId: 'identity-1', sourceTicketId: 'WOCOO-1' });

    expect(info.mock.calls.flat().join(' ')).toMatch(/graphql/i);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- atlasAccountLookup`
Expected: FAIL. Two distinct reasons, both real: `fetchAtlasAccountIdViaGraphql` is not imported by the module under test, and the tab path calls `window.setTimeout` while the Vitest environment is `node`, where `window` is undefined.

- [ ] **Step 3: Make the tab path independent of `window`**

In `extension/src/data/atlasAccountLookup.ts`, inside the existing account-number lookup only, replace `window.setTimeout(` with `setTimeout(` and `window.clearTimeout(` with `clearTimeout(`.

Also change the timer's declared type so TypeScript accepts either platform's return value:

```ts
const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
```

This is not cosmetic. `window` does not exist in an MV3 service worker, so the bare globals are the portable choice — and they are what makes this function testable at all.

Leave `fetchAtlasClientEmailHeadless` and `fetchAtlasClientDetailsHeadless` alone; they are out of scope.

- [ ] **Step 4: Rename the existing function and add the wrapper**

In `extension/src/data/atlasAccountLookup.ts`:

Add the import at the top:

```ts
import { fetchAtlasAccountIdViaGraphql } from './atlasGraphql';
export type { AtlasLookupResult } from './atlasGraphql';
```

Delete the local `export interface AtlasLookupResult { ... }` block — it now lives in `atlasGraphql.ts` and is re-exported above, so any existing importer keeps working.

Rename the existing declaration:

```ts
export async function fetchAtlasAccountIdViaTab(args: FetchAtlasAccountIdArgs): Promise<AtlasLookupResult> {
```

Then add the wrapper immediately after it:

```ts
/**
 * Tries Atlas's GraphQL API first and falls back to the background-tab scrape.
 *
 * The one thing that cannot be verified outside a loaded extension is whether Atlas's
 * cookies ride a fetch initiated from a chrome-extension:// origin — SameSite=Lax
 * cookies are not sent cross-site. If they do not, GraphQL returns 401/403 and this
 * silently uses the old path, so the button behaves exactly as it did before.
 *
 * The fallback also covers an operation being renamed or a service moving.
 */
export async function fetchAtlasAccountIdHeadless(
  args: FetchAtlasAccountIdArgs,
): Promise<AtlasLookupResult> {
  try {
    const result = await fetchAtlasAccountIdViaGraphql({ identityId: args.identityId });
    console.info('[atlas] account lookup via GraphQL:', result.accountNumber);
    return result;
  } catch (err) {
    console.warn('[atlas] GraphQL lookup failed, falling back to a background tab:', err);
    const result = await fetchAtlasAccountIdViaTab(args);
    console.info('[atlas] account lookup via background tab:', result.accountNumber);
    return result;
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS, 31 tests.

- [ ] **Step 6: Confirm the five call sites did not need changes**

Run: `npx tsc -b`
Expected: no output, exit 0. That is the proof — `SidePanel.tsx:658`, `MoveModal.tsx:213`, `QCFeeWaiverWorkflow.tsx:82`, `OverpaymentTriage.tsx:170` and `CreateReimbModal.tsx:386` all still compile untouched.

Then confirm no diff leaked into them:

```bash
git diff --name-only extension/src/sidepanel/
```

Expected: no output from this task's changes. (Files already modified on the branch before this plan started will still be listed — compare against `git stash list`/your starting state rather than assuming.)

- [ ] **Step 7: Commit**

```bash
git add extension/src/data/atlasAccountLookup.ts extension/src/data/atlasAccountLookup.test.ts
git commit -m "Use Atlas GraphQL for account lookup, keeping the tab as fallback"
```

---

### Task 5: Prove it in Chrome and record the outcome

The acceptance gate. Everything before this is green tests against stubs; the cookie question can only be answered by a loaded extension.

**Files:**
- Modify: `extension/README.md`
- Modify: `docs/superpowers/specs/2026-08-17-atlas-graphql-account-lookup-design.md` (status line)

- [ ] **Step 1: Build**

Run: `npm run build`
Expected: exit 0, `dist/` refreshed.

- [ ] **Step 2: Reload the extension**

Open `chrome://extensions`, find the WOCOO extension, click Reload. Accept the new host permission prompt for `cs-tools-satori.wealthsimple.com`.

- [ ] **Step 3: Open the service worker console**

On `chrome://extensions`, click the extension's "service worker" link. Keep this console visible — it is where the path is reported.

- [ ] **Step 4: Sign in to Atlas in a normal tab**

Visit `https://atlas.wealthsimple.com` and confirm you are past Okta. Without this, no cookies exist to test.

- [ ] **Step 5: Run the lookup**

Open a WOCOO ticket that carries an `identityId`, open the side panel, click **Fetch Account Number (W#) and Client Status**.

- [ ] **Step 6: Read the outcome**

Expected on success:

```
[atlas] account lookup via GraphQL: WK6RQDY37CAD
```

If instead you see:

```
[atlas] GraphQL lookup failed, falling back to a background tab: Error: Atlas WsBankAccount failed: HTTP 403
[atlas] account lookup via background tab: WK6RQDY37CAD
```

then extension-origin requests do not carry Atlas's cookies. **This is a real possible outcome, not a bug to grind on.** The button still works. Record it in Step 8 and stop — reaching cookies from the extension origin would need a different design (relaying the fetch through a content script in an Atlas tab), which is out of scope here.

- [ ] **Step 7: Check the displayed values**

Confirm the side panel shows the same W# and the same tier as Atlas's own page for that client — the tier under "INDIVIDUAL TIERS > Status", not the "TIERS" row above it.

- [ ] **Step 8: Record what happened**

In `extension/README.md`, add to the Atlas section:

```markdown
### Atlas account-number lookup

`fetchAtlasAccountIdHeadless` calls Atlas's GraphQL API directly
(`cs-tools-satori.wealthsimple.com/api/atlas/graphql/*`, cookie auth) and falls back to
the old background-tab DOM scrape if that fails. Which path ran is logged to the service
worker console as `[atlas] account lookup via …`.

Verified on 2026-08-17: <GraphQL path | tab fallback — write the one you observed>.
```

Replace the angle-bracket placeholder with what Step 6 actually printed. Then set the spec's `**Status:**` line to `Implemented` and note the same outcome.

- [ ] **Step 9: Commit**

```bash
git add extension/README.md docs/superpowers/specs/2026-08-17-atlas-graphql-account-lookup-design.md
git commit -m "Record the verified Atlas lookup path"
```

---

## Known environment issue

`git commit` in this repo signs with SSH (`commit.gpgsign=true`, `gpg.format=ssh`) and the
signing key lives in 1Password. `ssh-keygen -Y sign` reads `SSH_AUTH_SOCK`, which on this
machine points at Apple's agent — and that agent holds no identities, so commits hang until
they time out.

If a commit step hangs, either unlock 1Password and export its socket:

```bash
export SSH_AUTH_SOCK="$HOME/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock"
```

or commit unsigned and re-sign later:

```bash
git -c commit.gpgsign=false commit -m "…"
# later, once the agent answers:
git commit --amend -S --no-edit
```
