# Atlas Account Lookup Without a Tab — Design

**Date:** 2026-08-17
**Status:** Implemented and verified 2026-08-17 — the GraphQL path runs in Chrome, so
extension-origin fetches do carry Atlas's cookies and the tab fallback stays dormant.

Two things the design got wrong, both fixed during implementation:

1. **"Zero diff at the call sites" was true but insufficient.** `SidePanel.tsx` renders the
   W# chip from a `chrome.storage.local.atlas_account_number` storage listener, not from the
   return value — a side effect only the content script used to produce. The GraphQL path
   now writes the same key, or the lookup succeeds invisibly.
2. **Core has no `individual-tier-*` package.** The design treated a missing package as
   "no individual tier → null", which showed "not detected" for every base-tier client while
   Atlas's own page said Core. A readable packages list with no `individual-tier-*` now
   reads as Core; null is reserved for an unreadable response.
**Replaces the fast path of:** `extension/src/data/atlasAccountLookup.ts`
**Touches:** `extension/manifest.json`, `extension/src/data/atlasAccountLookup.ts`, `extension/src/data/atlasGraphql.ts` *(new)*

## Purpose

"Fetch Account Number (W#) and Client Status" currently opens a background Atlas tab, waits
for `content/atlas.ts` to click "CHEQUING (SPEND)" and scrape the rendered DOM, then closes
the tab. The content script's polling deadline is 30s and the caller waits 35s before giving
up. Every one of the five call sites pays that cost, and a tab flickers into existence each
time.

Atlas's own data comes from GraphQL. Calling those operations directly removes the tab, the
click choreography, and the 35s ceiling.

### What was ruled out first

- **Fetching the Atlas page HTML and parsing it.** Measured: the identity overview route
  returns 404 server-side, and the shell that does return is 2185 bytes with no account
  number and no tier. Atlas is a client-rendered SPA; there is no server-rendered DOM to
  scrape without a browser.
- **Reusing an already-open Atlas tab.** Viable, but strictly worse than no tab at all once
  the GraphQL path was found, and it makes behaviour depend on what the user happens to have
  open.

## The operations

All three are POSTs to `https://cs-tools-satori.wealthsimple.com/api/atlas/graphql/<service>`
with body `{ operationName, query, variables }`. Captured request headers were only
`accept: */*` and `content-type: application/json` — **no Authorization, no CSRF token**.
Auth is cookies alone.

### 1. identityId → account canonical id

Service `fort_knox`, operation `WsBankAccount`.

```graphql
query WsBankAccount($identityId: ID!) {
  funding_methods(fundable_type: WsBankAccount, identity_id: $identityId) {
    ... on WsBankAccount {
      account_number
      id
      institution_number
      transit_number
      account_canonical_id
      __typename
    }
    __typename
  }
}
```

Take `data.funding_methods[0].account_canonical_id` — e.g. `ca-cash-msb-i_ma5GMI2g`. This is
the WS bank (spend) account, which is why it corresponds to the "CHEQUING (SPEND)" sidebar
item the DOM scraper had to click.

Note `account_number` here is the 8-digit bank account number (`49671100`), **not** the W#.
Do not confuse the two.

### 2. account canonical id → W# and status

Service `wealthsimple`, operation `getAccountDetails`. Atlas's own document requests a very
large selection set; we send a trimmed one asking only for what we use:

```graphql
query getAccountDetails($id: ID!) {
  account(id: $id) {
    id
    custodianAccounts {
      custodianAccountId
      __typename
    }
    __typename
  }
}
```

The response also carries `account.status` and `custodianAccounts[].status`. Neither is
requested: the "Client Status" half of the button label means the **individual tier**, which
comes from hop 3. Nothing in the extension consumes a custodian account's status today.

From `data.account.custodianAccounts`, pick the entry whose `custodianAccountId` matches
`/^W[A-Z0-9]+CAD$/i` — the same regex `content/atlas.ts` already uses (`SPEND_ACCOUNT_RE`).
A client can have several custodian accounts; the observed non-matching sibling was
`C14792J29CAD`.

Return `custodianAccountId` uppercased, matching today's behaviour.

### 3. identityId → individual tier

Service `invest_graphql_api`, operation `FetchIdentityPackages`. Trimmed:

```graphql
query FetchIdentityPackages($id: ID!) {
  identity(id: $id) {
    id
    packages { id __typename }
    __typename
  }
}
```

From `data.identity.packages[]`, find an `id` matching
`/^individual-tier-(core|premium|generation)$/i` and capitalize the captured word.

This mapping is measured, not inferred: the client whose Atlas page renders
"INDIVIDUAL TIERS > Status: Premium" returns a package with `id: "individual-tier-premium"`.

**Do not read the tier from `entitlements`.** The same response contains
`{ feature: "instant_deposit_trust_level", category: "premium" }` and
`{ feature: "credit_card_material", category: "premium" }`, which are per-feature
entitlements that happen to share the word. The package id is the tier.

`null` when no `individual-tier-*` package exists — the existing contract already allows
null for clients without an Individual Tiers row.

## Architecture

### `data/atlasGraphql.ts` (new)

One transport function plus three thin readers. Each reader is a pure function of a response
object, so the parsing is unit-testable without a network.

| export | signature |
|---|---|
| `atlasGraphql` | `(service, operationName, query, variables) => Promise<unknown>` |
| `readSpendAccountCanonicalId` | `(res: unknown) => string \| null` |
| `readSpendCustodianAccountNumber` | `(res: unknown) => string \| null` |
| `readIndividualTier` | `(res: unknown) => string \| null` |
| `fetchAtlasAccountIdViaGraphql` | `({ identityId }) => Promise<AtlasLookupResult>` |

`atlasGraphql` sets `credentials: 'include'`, the two observed headers, and throws on a
non-2xx status or a non-empty `errors[]`. The error message carries the status and the first
GraphQL error message so a failure is diagnosable from the banner.

`fetchAtlasAccountIdViaGraphql` runs hop 1 and hop 3 concurrently (both key off
`identityId`), then hop 2 once hop 1 resolves. Two round trips of latency, not three.

### `data/atlasAccountLookup.ts` (changed)

- Rename the existing `fetchAtlasAccountIdHeadless` body to `fetchAtlasAccountIdViaTab`.
  Nothing about it changes.
- `fetchAtlasAccountIdHeadless` keeps its exported name, argument shape, and
  `AtlasLookupResult` return type. It now tries GraphQL and falls back to the tab.

```
fetchAtlasAccountIdHeadless(args)
  └─ try  fetchAtlasAccountIdViaGraphql({ identityId })
      └─ catch → fetchAtlasAccountIdViaTab(args)
```

Keeping the name means **zero diff at the five call sites**: `SidePanel.tsx:658`,
`MoveModal.tsx:213`, `QCFeeWaiverWorkflow.tsx:82`, `OverpaymentTriage.tsx:170`,
`CreateReimbModal.tsx:386`.

`fetchAtlasClientEmailHeadless` and `fetchAtlasClientDetailsHeadless` are **out of scope**
and untouched. They scrape different fields and can move later if this lands well.

### Why a fallback rather than a cutover

The one thing that cannot be verified from a page console is whether cookies ride a fetch
whose initiator is `chrome-extension://`. `SameSite=Lax` cookies are not sent on cross-site
requests, and the extension origin is cross-site to `cs-tools-satori.wealthsimple.com`.

If cookies do not ride, the GraphQL call returns 401/403 and the tab path runs — the button
behaves exactly as it does today. The fallback is what makes shipping this safe without
first proving the cookie question.

The fallback also covers the durable risks: an operation being renamed, a service being
moved, or the identity having no `WsBankAccount` funding method.

### manifest.json

Add one entry to `host_permissions`:

```
"https://cs-tools-satori.wealthsimple.com/*"
```

This host is new to the extension. Adding a host permission re-prompts on reload; that is
expected and worth calling out when the branch is picked up.

## Error handling

| condition | behaviour |
|---|---|
| non-2xx from any hop | throw → fall back to tab |
| `errors[]` non-empty | throw → fall back to tab |
| `funding_methods` empty | throw → fall back to tab |
| no `W…CAD` custodian account | throw → fall back to tab |
| tier op fails or has no `individual-tier-*` | `individualTierStatus: null`, W# still returned |

The tier is display-only, at `SidePanel.tsx:738` — the other four callers destructure
`accountNumber` alone. So a tier failure must never fail the whole lookup. An account-number
failure must, because that is what the callers consume.

## Testing

Response parsing is pure, so it gets real tests from the captured payloads:

- `readSpendAccountCanonicalId` — the recorded `WsBankAccount` response; plus empty
  `funding_methods`.
- `readSpendCustodianAccountNumber` — a `custodianAccounts` array holding both `WK…CAD` and
  `C…CAD`, asserting the W# wins regardless of array order; plus an array with neither.
- `readIndividualTier` — the recorded `FetchIdentityPackages` response asserting `Premium`
  from `individual-tier-premium`, **not** from the `category: "premium"` entitlements; plus
  a packages array with no `individual-tier-*`.

The network path and the cookie question are manual: load the unpacked extension, click
"Fetch Account Number (W#) and Client Status", and confirm from the service worker console
whether the GraphQL path or the tab fallback ran. That check is the acceptance gate — this
is not "done" until the log line says GraphQL.

## Out of scope

- Migrating the client-email and client-details lookups.
- Removing the tab path or the `content/atlas.ts` scraper. Both stay as the fallback.
- Caching lookups across tickets.
