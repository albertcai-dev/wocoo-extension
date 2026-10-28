# Estate CC Payment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Sidekick tile that pays off a deceased client's credit card from their SPEND chequing. It verifies the balance, confirms with Albert, sends Atlas's own `AdminCreateCreditPayment` mutation, waits for `succeeded`, then comments on the ticket and marks it Done.

**Architecture:**
- Pure logic lives in `src/data/estateCcPayment.ts`: GraphQL documents, parsers, amount and sign rule, card choice, account-number check, idempotency-key match, comment text.
- I/O lives in `src/data/estateCcPaymentApi.ts`: Atlas calls through the existing `atlasGraphql()`, the Pantheon balance through `runPresetSql()`, plus the pay/poll orchestration. Fetch, SQL and storage are injected as deps.
- The UI lives in `src/sidepanel/EstateCcPaymentWorkflow.tsx`, and reuses a Verify Balance step extracted from Overpayment Triage.

**Tech Stack:** React + TypeScript, Chrome MV3 side panel, Vite, Vitest 2 (`npm test`, node environment, `src/**/*.test.ts` only, no DOM tests).

**Spec:** `docs/superpowers/specs/2026-10-28-estate-cc-payment-design.md`. Read it before starting. It holds the verbatim GraphQL documents that Task 1 copies.

## Global Constraints

All paths below are relative to `extension/`. Run commands from `extension/`.

- Every Atlas call goes through `atlasGraphql(service, operationName, query, variables)` in `src/data/atlasGraphql.ts`.
  - It uses cookie auth.
  - The endpoint rejects a body without `operationName`.
- Services:
  - `SpendClient`, `logRolesAndScopes`, `FetchCreditPaymentsAtlas` and `AdminCreateCreditPayment` use `'fort_knox'`.
  - `getAccountDetails` uses `'wealthsimple'`, as the existing `GET_ACCOUNT_DETAILS_QUERY` does.
- Mutation input:
  - `paymentAmount` is a string with exactly 2 decimals, and must be > 0.
  - `ticketId` is the Jira key, e.g. `WOCOO-10001`.
- Idempotency key on a created payment: `"card-payment-ops-" + ticketKey.toLowerCase()`.
- Warehouse sign: `total_balance < 0` means the client owes. Payment amount is `-total_balance`.
- Snowflake returns UPPER-case columns, so lower-case them with `lowerKeys()` from `src/data/presetSql.ts`.
- Jira:
  - Done is `transitionTicket(key, '251')`.
  - Post the comment with `postComment(key, segments)`, then call `markWorkflowHandled(ticket.id)`, as `ReverseFeeWorkflow.tsx` `doPostAndDone` does.
- Default comment, exact text: `Hi @{reporter}, I've processed the payment from client's chequing account to pay off their balance! You can proceed to close the card now.`
  - `@{reporter}` is `'@' + ticket.reporter`, rendered as a mention pill using `ticket.reporterAccountId`.
  - If there is no reporter, use `team`.
- Never send the mutation without a Confirm click in the same session.
- Never offer Pay when this ticket already has a payment.
- Never comment or mark Done unless the payment status is `succeeded`.
- Overpayment Triage behaviour must not change.

## Review Focus

1. **A double click on Pay, or a re-render while paying, sends only one mutation.** The Pay handler is guarded by an in-flight ref. Test: `payEstateCard` called twice at once sends the mutation once (Task 2).
2. **A timeout after the mutation was sent.** Re-query payments before reporting a failure. If the payment landed, show it and don't call it an error. Test: a mutation that rejects with a network error while the requery finds the key resolves to `{kind:'paid'}` (Task 2).
3. **A card in credit (`total_balance > 0`) or at zero.** Show "nothing owed" and keep Pay disabled. It must never show as an i2c "match". Tests in Tasks 1 and 3.
4. **Reopening the tile after paying.** The stored payment ID resumes at the result step and never re-offers Pay. Test: `loadEstateState` round-trip (Task 2).
5. **Account numbers in the description are written in lower case or wrapped in code formatting.** They are extracted case-insensitively. Test in Task 1.

---

### Task 1: Pure logic — documents, parsers, rules

**Files:**
- Create: `src/data/estateCcPayment.ts`
- Test: `src/data/estateCcPayment.test.ts`

**Interfaces:**
- Produces:
  - `SPEND_CLIENT_QUERY`, `LOG_ROLES_MUTATION`, `FETCH_CREDIT_PAYMENTS_QUERY`, `ADMIN_CREATE_CREDIT_PAYMENT_MUTATION` (strings).
    - All are copied verbatim from the spec.
    - `FETCH_CREDIT_PAYMENTS_QUERY` additionally selects `balanceModifierIdempotencyKey` on `node`.
  - `type CcAccountRow = { accountCanonicalId: string; asOf: string; totalBalance: number; isOpen: boolean }`
  - `type CardChoice = { kind: 'ok'; card: CcAccountRow; closed: boolean } | { kind: 'none' } | { kind: 'multiple'; count: number }`
  - `type CreditPayment = { id: string; amount: string; status: string; createdAt: string; idempotencyKey: string | null }`
  - `type CreateResult = { kind: 'initiated'; paymentId: string } | { kind: 'conflict'; message: string } | { kind: 'error'; message: string }`
  - `function balanceSql(identityId: string): string`. It must reject an id that doesn't match `/^identity-[A-Za-z0-9_-]+$/`, because the id is interpolated into SQL.
  - `function readCcAccountRows(rows: Record<string, unknown>[]): CcAccountRow[]`
  - `function chooseCard(rows: CcAccountRow[]): CardChoice`
  - `function amountOwed(totalBalance: number): number | null`. Returns `null` when `>= 0`, otherwise `-totalBalance` rounded to cents.
  - `function formatPaymentAmount(n: number): string`
  - `function readSpendSlug(res: unknown): string | null`
  - `function readCreditPayments(res: unknown): CreditPayment[]`
  - `function idempotencyKeyFor(ticketKey: string): string`
  - `function findTicketPayment(payments: CreditPayment[], ticketKey: string): CreditPayment | null`
  - `function readCreateResult(res: unknown): CreateResult`
  - `function extractAccountNumbers(description: string): string[]`. Upper-cased and de-duplicated.
  - `function strangerAccountNumbers(named: string[], owned: string[]): string[]`
  - `function buildEstateComment(reporter: string | undefined): string`

- [ ] **Step 1: Write the failing tests.** Use these assertions (values from WOCOO-10001):

```ts
// chooseCard
chooseCard([{accountCanonicalId:'ca-credit-card-TESTCARD01',asOf:'2026-10-26',totalBalance:-148.03,isOpen:true}])
  // → {kind:'ok', card:{...}, closed:false}   (status I/INACTIVE rows have isOpen true)
chooseCard([open1, open2])                     // → {kind:'multiple', count:2}
chooseCard([{...closedOwing, isOpen:false, totalBalance:-20}, {...closedZero, isOpen:false, totalBalance:0}])
  // → {kind:'ok', card: closedOwing, closed:true}
chooseCard([])                                 // → {kind:'none'}

// amountOwed / formatPaymentAmount
amountOwed(-148.03) === 148.03; amountOwed(0) === null; amountOwed(12.5) === null
formatPaymentAmount(148.03) === '148.03'; formatPaymentAmount(5) === '5.00'

// readCcAccountRows takes UPPER-case Snowflake keys
readCcAccountRows([{ACCOUNT_CANONICAL_ID:'ca-credit-card-TESTCARD01',EFFECTIVE_AS_AT_DATE:'2026-10-26',TOTAL_BALANCE:-148.03,IS_OPEN_ACCOUNT:true}])[0].totalBalance === -148.03

// balanceSql
expect(() => balanceSql("identity-x' or 1=1 --")).toThrow()
balanceSql('identity-TESTidentity000000000000000') contains "from credit.mart_cc_accounts" and the id

// readSpendSlug on the recorded SpendClient response
// → 'ca-cash-msb-TESTspend0' (spendClient.spendAccount.linkedAccountCanonicalId); null when spendAccount is null

// idempotency
idempotencyKeyFor('WOCOO-10001') === 'card-payment-ops-wocoo-10001'
findTicketPayment(readCreditPayments(recordedPayments), 'WOCOO-10001')?.id === 'credit-payment-TESTpayment000000001'
findTicketPayment(readCreditPayments(recordedPayments), 'WOCOO-1') === null

// readCreateResult, using the recorded response
// → {kind:'initiated', paymentId:'credit-payment-TESTpayment000000001'}
// __typename AdminCreateCreditPaymentIdempotencyConflictError → {kind:'conflict', message}
// AccountNotFoundError / AdminCreateCreditPaymentValidationError / unknown typename / missing data → {kind:'error', message}

// account numbers
extractAccountNumbers("Please pay the deceased's credit card ( C1AAAAAA1CAD ) balance from their chequing account ( wa1234567cad )")
  // → ['C1AAAAAA1CAD','WA1234567CAD']
strangerAccountNumbers(['C1AAAAAA1CAD','WA1234567CAD'], ['C2BBBBBB2CAD','WA1234567CAD','C1AAAAAA1CAD']) // → []
strangerAccountNumbers(['WX9999999CAD'], ['WA1234567CAD'])  // → ['WX9999999CAD']

// comment
buildEstateComment('Jane Doe') === "Hi @Jane Doe, I've processed the payment from client's chequing account to pay off their balance! You can proceed to close the card now."
buildEstateComment(undefined).startsWith('Hi team, ')
```

  Use the recorded responses from the spec as fixtures, inline in the test file.

- [ ] **Step 2: Run them and confirm they fail.** Run `npm test -- estateCcPayment`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement `src/data/estateCcPayment.ts`.**
  - Account-number regex: `/\b[A-Z][A-Z0-9]{8,10}CAD\b/gi`, upper-cased.
  - `balanceSql` selects `account_canonical_id, effective_as_at_date, total_balance, is_open_account` for the identity.
  - Use an `asRecord` helper like the one in `atlasGraphql.ts`.
- [ ] **Step 4: Run them and confirm they pass.** Run `npm test -- estateCcPayment`. Expected: PASS.
- [ ] **Step 5: Commit** with message `feat(estate-cc): pure payment logic + recorded Atlas documents`.

---

### Task 2: Atlas / Pantheon I/O and pay orchestration

**Files:**
- Create: `src/data/estateCcPaymentApi.ts`
- Test: `src/data/estateCcPaymentApi.test.ts`

**Interfaces:**
- Consumes: everything from Task 1; `atlasGraphql`, `GET_ACCOUNT_DETAILS_QUERY` and `readCustodianAccountNumber`'s pattern from `src/data/atlasGraphql.ts`; `runPresetSql` from `src/data/presetSql.ts`.
- Produces:
  - `interface EstateDeps`:
    - `gql(service: AtlasGraphqlService, op: string, query: string, vars: Record<string, unknown>): Promise<unknown>`
    - `sql(sql: string): Promise<Record<string, unknown>[]>`
    - `storageGet(key: string): Promise<unknown>`
    - `storageSet(key: string, value: unknown): Promise<void>`
    - `sleep(ms: number): Promise<void>`
  - `const chromeEstateDeps: EstateDeps`, which wires the real `atlasGraphql`, `runPresetSql`, `chrome.storage.local` and `setTimeout`.
  - `interface EstateLookup { card: CardChoice; spendSlug: string | null; ownedAccountNumbers: string[]; payments: CreditPayment[]; existing: CreditPayment | null }`
  - `function loadEstateLookup(identityId: string, ticketKey: string, deps?: EstateDeps): Promise<EstateLookup>`
    1. Run the balance SQL and `SpendClient` in parallel.
    2. Then run `getAccountDetails` for the slug and for the card, plus `FetchCreditPaymentsAtlas` (`first: 20`) for the card.
    3. `ownedAccountNumbers` is every `custodianAccountId` from both, upper-cased.
    4. Any rejected read rejects the whole lookup, so the UI keeps Pay blocked and offers Retry.
  - `type PayOutcome = { kind: 'paid'; payment: CreditPayment } | { kind: 'sent'; paymentId: string } | { kind: 'failed'; message: string }`
  - `function payEstateCard(args: { ticketKey: string; cardId: string; spendSlug: string; amount: number }, deps?: EstateDeps): Promise<PayOutcome>`
    1. Call `logRolesAndScopes` with `{input:{roles:['payment_cards_ops']}}`. If `success` isn't `true`, return `failed` without calling the mutation.
    2. Call the mutation.
    3. On `initiated`, store and return `{kind:'sent', paymentId}`.
    4. On `conflict`, or when the mutation throws, re-query payments. If `findTicketPayment` finds one, store and return `paid`. Otherwise return `failed` with the message.
    5. An `error` result returns `failed` with the server message.
    - Two calls in flight for the same `ticketKey` share one promise (a module-level `Map<string, Promise<PayOutcome>>`, cleared when settled).
  - `function waitForSucceeded(cardId: string, ticketKey: string, deps?: EstateDeps, opts?: { tries?: number; intervalMs?: number }): Promise<CreditPayment | null>`. Defaults are 6 tries and 2500 ms. Returns the payment once `status === 'succeeded'`, otherwise the last-seen payment, or `null` when none is found.
  - `function loadEstateState(ticketKey: string, deps?): Promise<{ paymentId: string; at: string } | null>` and `saveEstateState(ticketKey, paymentId, deps?)`, using storage key `estate_cc_payment:<TICKETKEY>`.

- [ ] **Step 1: Write the failing tests.** Use a fake `EstateDeps` that records `gql` calls and returns canned responses.
  - `payEstateCard`:
    - Happy path calls `logRolesAndScopes`, then `AdminCreateCreditPayment` with variables `{input:{destinationAccountCanonicalId:'ca-credit-card-TESTCARD01',sourceAccountCanonicalId:'ca-cash-msb-TESTspend0',paymentAmount:'148.03',ticketId:'WOCOO-10001'}}` on `'fort_knox'`, and returns `{kind:'sent', paymentId:'credit-payment-TESTpayment000000001'}`. Storage then holds that id under `estate_cc_payment:WOCOO-10001`.
    - Audit `success:false` means no mutation call, and the result is `failed`.
    - A mutation that throws while the requery finds the key returns `paid` (Review Focus 2).
    - A conflict while the requery finds the key returns `paid`.
    - A conflict with no payment found returns `failed`.
    - Two concurrent calls produce exactly one mutation call (Review Focus 1).
  - `waitForSucceeded`: a status sequence of `pending`, `pending`, `succeeded` resolves to the succeeded payment after 3 reads. All `pending` resolves to the last pending payment after `tries` reads. `sleep` is faked, so the test is instant.
  - `loadEstateLookup`:
    - Assembles the card, slug, owned numbers (`C1AAAAAA1CAD`, `C2BBBBBB2CAD`, `WA1234567CAD`) and `existing`.
    - Rejects when the `SpendClient` gql call throws.
  - `loadEstateState` / `saveEstateState` round-trip (Review Focus 4).
- [ ] **Step 2: Run them and confirm they fail.** Run `npm test -- estateCcPaymentApi`. Expected: FAIL.
- [ ] **Step 3: Implement `src/data/estateCcPaymentApi.ts`.**
- [ ] **Step 4: Run them and confirm they pass.** Run `npm test -- estateCcPaymentApi`. Expected: PASS.
- [ ] **Step 5: Commit** with message `feat(estate-cc): Atlas/Pantheon I/O and idempotent pay orchestration`.

---

### Task 3: Extract the shared Verify Balance step (sign-aware)

**Files:**
- Create: `src/data/balanceCompare.ts`, `src/data/balanceCompare.test.ts`, `src/sidepanel/VerifyBalanceStep.tsx`
- Modify: `src/sidepanel/OverpaymentTriage.tsx`. Replace the file-local `Step3Body` (~1037-1167) with `VerifyBalanceStep`, and its call site (~514).

**Interfaces:**
- Produces:
  - `type CompareMode = 'abs' | 'owed'`
  - `function compareBalance(runningBalance: number, amount: number | null, mode: CompareMode): { matches: boolean; diff: number | null; nothingOwed: boolean }`
    - `'abs'` keeps Overpayment's current rule: `|abs(running) − amount| < 0.01`.
    - `'owed'` treats a positive i2c running balance as owed. i2c shows `CA$148.03` for the estate card. It matches when `|running − amount| < 0.01`, and returns `nothingOwed: true` when `running <= 0`.
  - The `VerifyBalanceStep` props are the current `Step3Body` props plus `compareMode: CompareMode` and an optional `extraInfo?: React.ReactNode`, rendered above the pills, which is where Estate shows the Pantheon line.
  - It exports the existing i2c storage contract unchanged: the `pending_i2c_*` keys with flow `'verify_balance'`, read back from `i2c_running_balance` filtered by `sourceTicketId`.

- [ ] **Step 1: Write the failing tests.**
  - `compareBalance(-500, 500, 'abs').matches === true`, as in Overpayment today.
  - `compareBalance(148.03, 148.03, 'owed').matches === true`.
  - `compareBalance(-148.03, 148.03, 'owed')` gives `matches === false` and `nothingOwed === true` (Review Focus 3).
  - `compareBalance(0, null, 'owed').nothingOwed === true`.
  - `compareBalance(150, 148.03, 'owed').diff` is about `1.97`.
- [ ] **Step 2: Run them and confirm they fail.** Run `npm test -- balanceCompare`. Expected: FAIL.
- [ ] **Step 3: Implement `compareBalance`.** Move `Step3Body` into `VerifyBalanceStep.tsx` with `compareBalance` replacing the inline `Math.abs` compare. Then use it from `OverpaymentTriage.tsx` with `compareMode="abs"`.
- [ ] **Step 4: Run the whole suite and the build.** Run `npm test && npm run build`. Expected: all tests pass and `tsc` plus `vite build` succeed.
- [ ] **Step 5: Commit** with message `refactor: share Verify Balance step; add sign-aware owed mode`.

---

### Task 4: Estate CC Payment workflow UI and tile wiring

**Files:**
- Create: `src/sidepanel/EstateCcPaymentWorkflow.tsx`
- Modify:
  - `src/sidepanel/SidePanel.tsx`: a state flag and render branch in `TicketView` (~243-300); an `onStartEstateCcPayment` prop through `TicketViewInner` (~318) and `QuickActions` (~858, call site ~586); and the button in the fee-remediation row (~989-1020), after Card Issuance Mgr.
  - `src/data/usageStats.ts`: `estate_cc_payment: { label: '🪦 Estate CC Payment', kind: 'workflow' }`. The builder may swap the icon.

**Interfaces:**
- Consumes: Task 2's `loadEstateLookup`, `payEstateCard`, `waitForSucceeded`, `loadEstateState`; Task 1's `amountOwed`, `extractAccountNumbers`, `strangerAccountNumbers`, `buildEstateComment`, `formatPaymentAmount`; Task 3's `VerifyBalanceStep` with `compareMode="owed"`; and `postComment`, `transitionTicket`, `markWorkflowHandled`, plus the `buildCommentSegments` pattern from `ReverseFeeWorkflow.tsx`. Copy or lift the helper; don't import a private one.
- Props: `{ ticket: WocooTicket; onClose: () => void; onTicketUpdate: (t: WocooTicket) => void }`, matching the other workflows.

The steps, in order:

1. **Mount.**
   - Call `loadEstateState(ticket.id)`. If a payment ID is stored, jump to step 4 and run `waitForSucceeded`.
   - Otherwise call `loadEstateLookup(ticket.identityId, ticket.id)`.
   - If `lookup.existing` is set, jump to step 4 with that payment.
   - If the lookup fails, show the error and a Retry button. Pay stays unreachable.
2. **Verify balance.**
   - `extraInfo` shows "Pantheon: ${owed} owed · as of {Mon D}", or "Nothing owed (as of …)".
   - The amount comes from the i2c capture if one exists, otherwise from Pantheon. "Balance differs" overrides it.
   - Continue unlocks only after Verified, or after a differs-amount is applied.
3. **Confirm.** Before the dialog opens, these stops block it, each with its own message:
   - `amount == null || amount <= 0`.
   - `!spendSlug`.
   - `card.kind !== 'ok'`. For `multiple`, the message is "do this one manually".
   - `strangerAccountNumbers(...)` is non-empty, listing the strangers.

   If the ticket names no account numbers, show the note "Ticket names no account numbers — not cross-checked."

   The dialog uses the overlay pattern from `MoveModal.tsx`. It shows the ticket, client (`ticket.clientName` if present), From (slug + the W…CAD owned number), To (card ID, plus "card is closed" when `closed`), Amount, and the balance source. The buttons are Cancel and `Pay $148.03`.
   - The Pay click is guarded by a `useRef` in-flight flag.
   - It calls `payEstateCard` and then `waitForSucceeded`.
4. **Result.**
   - Show the payment ID, amount and status.
   - If the status is not `succeeded`, show "Payment {id} is {status} — check Atlas before closing out" and a Re-check button. Steps 5 and later stay hidden.
5. **Comment + Done.** This is a copy of `doPostAndDone`: an editable comment pre-filled by `buildEstateComment(ticket.reporter)`, and a retry that skips an already-posted comment. On success, call `onTicketUpdate({...ticket, status:'Done'})`.

- [ ] **Step 1: Implement `EstateCcPaymentWorkflow.tsx`** as described above. Use the existing styles from `toolUi.tsx`/the Reverse Fee workflow, and call `recordClick(ticket.id, 'estate_cc_payment')` on the tile button.
- [ ] **Step 2: Wire it into `SidePanel.tsx` and `usageStats.ts`.**
- [ ] **Step 3: Run the whole suite and the build.** Run `npm test && npm run build`. Expected: all tests pass and the build succeeds.
- [ ] **Step 4: Commit** with message `feat(estate-cc): Estate CC Payment tile and workflow`.

---

### Task 5: Live read-only check on WOCOO-10001

WOCOO-10001 was already paid on 2026-10-28 (`credit-payment-TESTpayment000000001`, succeeded), so this test cannot send money: the duplicate check skips Pay.

- [ ] **Step 1:** Albert reloads the unpacked extension from `extension/dist` and opens WOCOO-10001 in Sidekick.
- [ ] **Step 2:** Click **Estate CC Payment**. Expected:
  - The tile jumps straight to the result step.
  - It shows `credit-payment-TESTpayment000000001`, $148.03, succeeded.
  - No Pay button appears anywhere.
  - The Comment + Done step is offered.
- [ ] **Step 3:** Don't post. Albert decides whether to use this to close out WOCOO-10001.
- [ ] **Step 4:** The first real unpaid estate ticket is a supervised run. Albert watches it, with the side panel's DevTools Network tab open on the first Pay click.
