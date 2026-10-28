# Estate CC Payment — Sidekick workflow

Date: 2026-10-28
Status: draft for review

## Why

"Estate Credit Card Payment" WOCOO tickets ask us to pay off a deceased client's credit card
from their chequing account. Today this is all manual. Albert logs into i2c and filters
Account Transactions to read the latest Running Balance. He then opens Atlas → the client's
credit card → Payments → Manual Payment, copies the chequing account's Slug from a different
Atlas page, types in the ticket ID, slug and amount, and clicks Create. Then he comments on
the Jira ticket and marks it Done. The new tile does the lookups and the typing. Albert's
part is to confirm the balance and the payment.

Example ticket: WOCOO-10001. The reporter (Jane Doe) wrote: "Please pay the deceased's
credit card (C1AAAAAA1CAD) balance from their chequing account (WA1234567CAD) … Please close
the card afterward."

## Goals

- A new tile, **Estate CC Payment**, in the fee-remediation row of Quick Actions. It sits next
  to Reverse Fee, Custom CC Statement and Card Issuance Mgr (`SidePanel.tsx` ~989-1020).
- Step 1, **Verify balance**:
  - Show the Pantheon card balance right away, with its "as of" date.
  - Offer the same i2c running-balance capture that Overpayment Triage uses for a live check.
  - Albert clicks **Verified** or **Balance differs** (the second lets him enter a different
    amount).
- Step 2, **Confirm & pay**:
  - Look up the chequing (SPEND) slug and the credit card account ID headlessly.
  - Show an "Are you sure?" confirmation with ticket ID, source slug, destination card,
    amount and client name.
  - On Confirm, create the payment headlessly through Atlas's own GraphQL mutation.
- Step 3, **Wrap up**: post the Jira comment, then mark the ticket Done.

## Non-goals

- Closing the card. The comment hands that back to the reporter.
- Auto-detecting estate tickets or showing a suggestion card. The tile is always available,
  like Reverse Fee. A detect card could come later.
- Partial payments, or payments from any account other than the SPEND chequing.

## Anti-goals (failure even if it "works")

- **A double payment.** Never send the payment twice for one ticket, whether from a retry,
  a re-render or a second click.
- **Paying from the wrong account.** For example, a chequing account that isn't the one the
  ticket names.
- **Paying a stale amount** without Albert having seen the live figure, or knowingly accepted
  the Pantheon one.
- Any write to Atlas without an explicit Confirm click in the same session.

## How Atlas does it (recorded 2026-10-28 from a real payment on WOCOO-10001)

All calls go to `POST https://cs-tools-satori.wealthsimple.com/api/atlas/graphql/fort_knox`.
They use the same cookie-only auth (`credentials: 'include'`) as the existing `atlasGraphql()`
in `data/atlasGraphql.ts`. Service `'fort_knox'` already exists there.

**Payment mutation.** The response was 200, `AdminCreateCreditPaymentInitiated`,
`canonicalId: credit-payment-TESTpayment000000001`.

```graphql
mutation AdminCreateCreditPayment($input: AdminCreateCreditPaymentInput!) {
  adminCreateCreditPayment(input: $input) {
    ... on AdminCreateCreditPaymentInitiated { canonicalId destinationAccountCanonicalId sourceAccountCanonicalId paymentAmount __typename }
    ... on AccountNotFoundError { message __typename }
    ... on AdminCreateCreditPaymentValidationError { message __typename }
    ... on AdminCreateCreditPaymentIdempotencyConflictError { message __typename }
    __typename
  }
}
```

Variables:

```json
{ "input": {
    "destinationAccountCanonicalId": "ca-credit-card-TESTCARD01",
    "sourceAccountCanonicalId": "ca-cash-msb-TESTspend0",
    "paymentAmount": "148.03",
    "ticketId": "WOCOO-10001" } }
```

- `paymentAmount` is a **string** with 2 decimals (schema type `BigDecimal`, "must be greater than 0").
- **Idempotency is server-side and keyed on the ticket** (schema: `ticketId` is "Used to derive the internal idempotency key"). The resulting payment carries `balanceModifierIdempotencyKey = "card-payment-ops-wocoo-10001"` (lower-cased ticket key). So **one admin payment per ticket**: a second attempt on the same ticket returns `AdminCreateCreditPaymentIdempotencyConflictError`. Consequences:
  - A retry after a timeout or network drop is safe. Re-query payments first anyway, then retry once if none exists.
  - There is no "pay anyway" override. A genuine second payment for the same ticket is impossible through this mutation, and that's out of scope.
- Only the four types above count as results. Any other `__typename`, a GraphQL `errors`
  array, or a non-200 is a failure, and the failure screen shows the raw message.

**Audit call Atlas makes first.** Immediately before the mutation, Atlas calls
`logRolesAndScopes` with `{"input":{"roles":["payment_cards_ops"]}}`, which returns
`{success}`. Sidekick makes the same call before the mutation so the audit trail looks the
same. If the audit call fails, stop and do not pay.

**Chequing (SPEND) slug.** `SpendClient(identityId)` returns
`spendClient.spendAccount.linkedAccountCanonicalId`, e.g. `ca-cash-msb-TESTspend0`. This is
the same "SPEND link" rule the WOCOO enrichment uses.

**Verifying the payment landed / duplicate check.** `FetchCreditPaymentsAtlas(accountCanonicalId, first)` →
`creditPayments.edges[].node{ id amount status sourceExternalId createdAt balanceModifierIdempotencyKey }`.
A ticket already has a payment if any node has `balanceModifierIdempotencyKey == "card-payment-ops-" + ticketKey.toLowerCase()`. This is an **exact match**, not a fuzzy amount/date match. `status` is a free String; only `succeeded` has been observed. After the
mutation, re-query it and show the new row's status (`succeeded` on the recording; it can
also be pending).

**Credit card account ID** (`ca-credit-card-…`). Pantheon's `credit.mart_cc_accounts` returns
it in the balance query below, so no extra Atlas call is needed. If Pantheon fails, fall back
to an Atlas read; the builder picks which existing account query (`FetchAccounts` /
`atlasGetIdentityAccounts` were seen in the recording).

## Exact recorded documents for the reads and the audit call

All of these use service `fort_knox` and were taken verbatim from Atlas traffic on 2026-10-28.

```graphql
query SpendClient($identityId: ID!) {
  spendClient(identityId: $identityId) {
    id status registeredAt spendDeactivatedAt spendUserId
    spendAccount { id linkedAccountCanonicalId physicalCardRequestState physicalCardRequestChangedAt canRequestPhysicalCard __typename }
    __typename
  }
}
# variables: {"identityId": "identity-…"}

mutation logRolesAndScopes($input: AtlasLogRolesAndScopesMutationInput!) {
  logRolesAndScopes(input: $input) { success __typename }
}
# variables: {"input": {"roles": ["payment_cards_ops"]}}

query FetchCreditPaymentsAtlas($accountCanonicalId: ID!, $first: Int, $after: String, $last: Int, $before: String) {
  creditPayments(accountCanonicalId: $accountCanonicalId, first: $first, after: $after, last: $last, before: $before) {
    edges { cursor node { id amount status sourceExternalId postedAt createdAt scheduledPaymentId __typename } __typename }
    totalCount
    pageInfo { hasNextPage hasPreviousPage startCursor endCursor __typename }
    __typename
  }
}
# variables: {"accountCanonicalId": "ca-credit-card-…", "first": 10, "after": null, "before": null}
# Add balanceModifierIdempotencyKey to node — verified that it works ad hoc.
```

- The `SpendClient` service path is inferred: it appeared among the `fort_knox` requests, but
  the builder should confirm it on the first call.
- The cs-tools-satori endpoint rejects a body without `operationName`.

## Balance source

Pantheon / Snowflake via the existing `runPresetSql()` (`data/presetSql.ts`). The query was
verified on this client:

```sql
select account_canonical_id, effective_as_at_date, total_balance, status
from credit.mart_cc_accounts
where identity_canonical_id = '<identity>'
```

- For WOCOO-10001 it returned `ca-credit-card-TESTCARD01` with `total_balance = -148.03` as of
  2026-10-26. i2c's running balance on the same day was CA$148.03.
- **Sign:** negative means the client owes. Payment amount = `-total_balance`.
- **It lags about 2 days**, which is why the i2c live check stays.
- Lower-case the keys with `lowerKeys()`, because Snowflake returns upper-case column names.
- **Sign-aware compare.** The shared Verify step must not use `Math.abs`. A card in credit
  (positive `total_balance`) means nothing is owed, so it must not show as a "match".

i2c live check: reuse the Overpayment Triage flow exactly.
- `stageI2cEmail` sets the `pending_i2c_*` keys with flow `'verify_balance'`.
- `content/i2c.ts` reads the balance and writes `i2c_running_balance`.
- The step listens on `chrome.storage.onChanged`, filtered by `sourceTicketId`.

`Step3Body` in `OverpaymentTriage.tsx` (~1037-1167) is file-local. Extract it into a shared
component, e.g. `sidepanel/VerifyBalanceStep.tsx`, that both workflows use, without changing
Overpayment's behaviour.

## Flow and rules

1. **Open the tile.** In parallel, run the Pantheon balance query and `SpendClient`. Read the
   identity ID from the ticket (the "User Identity ID" field, or the title
   `… - identity-…`, whichever Sidekick already uses).
2. **Verify balance** step:
   - Show "Pantheon: $148.03 owed · as of Oct 26", plus the Preset / Atlas / i2c pills from
     Overpayment.
   - The amount comes from the i2c capture if Albert ran it; otherwise from Pantheon.
   - **Verified** and **Balance differs** work as in Overpayment.
   - Pay stays locked until one of them is clicked.
3. **Stop conditions.** Each shows a clear message, and Pay stays disabled:
   - The amount is ≤ 0. Nothing is owed; the card may already be paid off or in credit.
   - No SPEND link is found.
   - **Card selection** (verified 2026-10-28 on all `credit.mart_cc_accounts` rows): the statuses
     are `B` OPEN, `I` INACTIVE, `S` FRAUD BLOCK and `F` CLOSED, and `is_open_account` is true for
     B/I/S rows that aren't closed. The WOCOO-10001 estate card is `I` INACTIVE with
     `is_open_account = true`, so do **not** filter on `status = 'B'`.
     - Take the rows with `is_open_account`.
     - If there are 0, fall back to the single row that has a balance owed, and label it
       "card is closed".
     - If there are still 0, stop: "no credit card found".
     - If there are more than 1, stop: "multiple cards — do this one manually". Only one identity
       in the warehouse has 2.
   - **Account mismatch:**
     - Extract every `[A-Z0-9]{9,10}CAD`-style account number from the ticket description.
     - Collect the account numbers that belong to the SPEND chequing and to the chosen card. In
       Atlas's sidebar these are the "SO -" numbers: the chequing had `C2BBBBBB2CAD` and
       `WA1234567CAD`, the card had `C1AAAAAA1CAD`.
     - Every number named in the ticket must belong to one of those two accounts. Any stranger
       is a stop.
     - Do this by membership, not by guessing card-vs-chequing from the prefix (`C…` is used by
       both).
     - If the ticket names no numbers, skip the check and show a note.
     - The builder finds the read that returns those numbers. `getAccountDetails`
       (custodianAccounts) is already used in `atlasAccountLookup.ts`, and the recorded page also
       called `FetchAccounts` and `atlasGetIdentityAccounts`.
   - **An existing payment for this ticket:** the exact idempotency-key match above. Show that
     payment (amount, status, date) and skip straight to the result screen (step 6). Never
     offer Pay.
   - **The payments read fails:** Pay stays blocked, with a Retry button. The duplicate check
     must succeed before Pay unlocks, and the same goes for `SpendClient` and the audit call.
4. **Confirm dialog**, using the existing overlay pattern (`MoveModal.tsx` `Overlay`). It
   shows ticket, client name, From (slug + account number), To (card ID), Amount, and the
   balance source (i2c live, or Pantheon as-of date). The buttons are Cancel and
   **Pay $148.03**.
5. **Pay:**
   - Call `logRolesAndScopes`, then `AdminCreateCreditPayment`.
   - Lock the Pay button as soon as it is clicked.
   - Persist "payment sent for WOCOO-XXXXX: credit-payment-…" in `chrome.storage.local`, so
     reopening the tile shows the result and never offers Pay again.
   - On `IdempotencyConflictError`, re-query payments, show the existing one, and continue to step 6.
6. **Show the result:** the payment ID and its status from `FetchCreditPaymentsAtlas`.
   - **Albert's call: step 7 is gated on `status == "succeeded"`.** If the status is anything
     else (pending, failed, or the row is missing), poll `FetchCreditPaymentsAtlas` for a short
     while.
   - If it still isn't `succeeded`, do **not** comment or mark Done. Leave the ticket open and
     show "Payment {id} is {status} — check Atlas before closing out". Add a Re-check button
     that re-runs the poll.
   - Reopening the tile later picks up from the stored payment ID and re-checks its status.
7. **Comment + Done.** Use the Reverse Fee pattern: `doPostAndDone`, `postComment`,
   `markWorkflowHandled`, `transitionTicket(…, '251')`, and skip the comment on retry if it was
   already posted. The default comment text is below, and it can be edited before posting:
   > Hi @{reporter}, I've processed the payment from client's chequing account to pay off their balance! You can proceed to close the card now.

   `@{reporter}` is a mention pill, as Reverse Fee does it. Albert said "Hi ___" with the
   first name; existing comments use the full-name mention, which shows as the person's name.
8. **Log usage:** add `estate_cc_payment` to `USAGE_BUTTONS` (`data/usageStats.ts`), and call
   `recordClick` on the tile.

## Constraints

- Everything runs from the side panel, with no visible tab, except the optional i2c check.
  That check opens i2c like Overpayment does today.
- No new host permissions are needed: `cs-tools-satori` and Preset are already granted.
- Pure logic lives in `src/data/estateCcPayment*.ts` with vitest tests, with Chrome and fetch
  passed in as deps (repo convention, node environment, no DOM tests). That logic is:
  building the request bodies, parsing the results, the amount/sign rule, the stop
  conditions, and the duplicate check.
- WOCOO-10001 was already paid manually on 2026-10-28, so it is a good **live read-only
  test**. The tile should show $0 owed (after Pantheon refreshes) or flag the existing
  148.03 payment, and refuse to pay.

## Left to the builder

- The tile label and icon, and where exactly in the row it goes.
- Whether the extraction of `VerifyBalanceStep` takes props or a small hook.
- Which Atlas query gives account numbers for the mismatch check, and the fallback for the
  credit card ID.
- The exact window for the duplicate check.
