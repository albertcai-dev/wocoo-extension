# QC Fee Waiver — Design

**Date:** 2026-06-12
**Status:** Approved (verbal); spec pending review

## Goal

Add a "QC Fee Waiver" button to the WOCOO Triage Chrome extension's QuickActions area that launches a multi-step workflow modal, matching the policy in [Quebec Credit Card Fee Waiver (Notion)](https://app.notion.com/p/wealthsimple/Quebec-Credit-Card-Fee-Waiver-32641167bd9680ac935ec99cedd46017). The workflow walks the agent through prorating an annual-fee refund for a Quebec credit card client, applying the Admin Credit in i2c, creating a REIMB ticket when appropriate, posting a comment, and closing the ticket.

The button covers two scenarios in one workflow:

- **Cancellation** — client wants to close the card. Refund = `$220 − $20 × months_used`.
- **Newly fee-waiver eligible** — client became eligible (Core → Premium, qualifying direct deposits) after paying the annual fee. Refund = `$20 × months_until_anniversary`.

## Non-goals (v1)

- Auto-detect which scenario applies. Agent picks in Step 1.
- Historical audit log of past waivers.
- Auto-query Preset for the eligibility-flip month. Agent enters it manually.
- Multi-ticket batch processing.

## Architecture

Three things change:

**1. New file `src/sidepanel/QCFeeWaiverWorkflow.tsx`** — the workflow modal. Mirrors the existing `OverpaymentTriage.tsx` / `ReverseFeeWorkflow.tsx` pattern: stacked step cards with completed (green ✓) / active (white) / future (gray) states; sticky header with progress dots; success panel at the end.

**2. `SidePanel.tsx` edits** — add `qcFeeWaiverActive` state in `TicketView`, route to `<QCFeeWaiverWorkflow>` when true. Plumb a new `onStartQCFeeWaiver` callback through `TicketViewInner` → `QuickActions`. Add the new button to the right of Reverse Fee so QuickActions row 2 becomes `[Reverse Fee] [QC Fee Waiver]`, each `flex: 1`.

**3. `src/content/i2c.ts` edits** — two new flow variants joining the existing `verify_balance` / `reverse_fee` / `admin_debit` / `null` set:

- **`qc_month_scrape`** — terminal chain on Account Transactions: switch the date dropdown to "Date Range", fill From/To with a wide window (default: 14 months ago → today), click Search, scrape the Posted Transactions table, count distinct `YYYY-MM` values in the Trans. Date column, write back `{ sourceTicketId, monthsUsed, monthsBreakdown[], capturedAt }` to `chrome.storage.local.qc_month_scrape_result`.
- **`apply_credit`** — terminal chain on Administrative Services: select "Admin Funds Credit" (or whatever the live service-dropdown label turns out to be — see Known Unknowns), fill Amount, paste ticket URL into Comments. Mirrors the existing `admin_debit` flow but uses the credit service option.

## Steps in detail

7 steps plus a success state. Scenario B (Newly eligible) skips Step 5.

### Step 1 — Pick scenario

UI: two radio cards.
- "Cancellation — client wants to close the card"
- "Newly fee-waiver eligible — client became eligible after paying"

Action button: **Continue →**.

### Step 2 — Collect inputs

Different bodies per scenario.

**Cancellation:**
- `monthsUsed: number` — input with **Scrape from i2c ↗** button beside it. The button stages `pending_i2c_flow: 'qc_month_scrape'` + a wide date range hint, opens i2c. The content script writes back the count + a per-month breakdown (e.g., `["2026-03", "2026-04"]`). When the storage event arrives, the input auto-populates and the breakdown is shown beneath as helper text. Agent can always override with a typed number.
- `clientPaidAnnualFee: boolean` toggle — "Has the client already paid the annual fee?" (drives whether Step 5 is visible).

**Newly eligible:**
- `anniversaryMonth: YYYY-MM` — when the client received their Visa CC. Plain month input.
- `eligibilityFlipMonth: YYYY-MM` — when the client became fee-waiver eligible.

Action button: **Continue →** (disabled until required fields are valid).

### Step 3 — Confirm refund

Auto-calculated from Step 2 inputs, with the formula shown as helper text:

- *Cancellation*: `$220 − ($20 × monthsUsed) = $X`
- *Newly eligible*: `$20 × monthsLeft = $X` where `monthsLeft` is computed from `(anniversaryMonth + 12) − eligibilityFlipMonth`.

The amount is editable in case the agent wants to override (rare but possible per policy edge cases).

Action button: **Continue →**.

### Step 4 — Apply Admin Credit in i2c

Numbered instructions + **Apply Admin Credit ↗** pill (warning/amber, full-width). Clicking it stages:

```ts
{
  pending_i2c_email,
  pending_i2c_flow: 'apply_credit',
  pending_i2c_ticket_url: 'https://wealthsimple.atlassian.net/browse/<TICKET>',
  pending_i2c_admin_credit_amount: '<refund as positive 2-dp number>',
  pending_i2c_started_at: Date.now(),
}
```

And opens the i2c login URL. The i2c content script's new `apply_credit` flow signs in (if needed), navigates to Administrative Services, selects the credit Service option, fills Amount + Comments. Agent reviews and clicks Apply in i2c manually.

Action button (in extension): **✓ Credit Applied** to advance to the next step.

### Step 5 — Submit REIMB ticket *(Cancellation + clientPaidAnnualFee = true only)*

Hidden in any other case.

Calls the existing `createReimbTicket` (in `src/api/jira.ts`) with:
- `amount`: the calculated refund
- `accountId`: same resolution as Overpayment Triage
- `approver`: `'amanda'` if refund ≥ $5K else `'luke'` (same rule as overpayment, even though QC refunds rarely cross that threshold)
- `tier`: from ticket (or override)
- `wocooTicketId`: current ticket id
- **REIMB summary** (proposed): `Quebec fee waiver prorated refund for WOCOO-<KEY>` — confirm wording with Albert during implementation.

Step body shows the created REIMB key + link once successful.

Action button: **Create REIMB ticket**, then **Continue →** once created.

### Step 6 — Post comment

Templated comment to the WOCOO ticket via the existing `postComment` ADF API. Editable textarea.

**Cancellation template** (proposed):
```
Hi @{reporter}, the client's annual fee has been prorated based on {monthsUsed} months of card usage.
Refund: $220 − ($20 × {monthsUsed}) = ${refund}. Admin credit applied in i2c.
{If REIMB created: REIMB ticket {key} created to transfer the refund to the chequing account.}
You can proceed with account closure.
```

**Newly eligible template** (proposed):
```
Hi @{reporter}, the client became fee-waiver eligible in {eligibilityFlipMonth} ({monthsLeft} months remaining until their card anniversary).
Refund: $20 × {monthsLeft} = ${refund}. Admin credit applied in i2c.
```

Action button: **Post Comment**.

### Step 7 — Move to Done

Brief instructional text + **✓ Move to Done** button. Uses `transitionTicket(ticketId, '251')`.

### Step 8 — Success

Green success card: summary of what was done (credit amount, REIMB key if any, comment posted, ticket closed). Same visual style as the existing workflow success panels.

## Storage keys

New keys added to `chrome.storage.local`:

- `pending_i2c_flow: 'qc_month_scrape' | 'apply_credit'` — joins the existing flow values.
- `pending_i2c_admin_credit_amount: string` — positive decimal, like `pending_i2c_admin_debit_amount`.
- `qc_month_scrape_result: { sourceTicketId, monthsUsed, monthsBreakdown: string[], capturedAt }` — written by the content script after a successful scrape.

The existing `pending_i2c_started_at` staleness-expiry (5 min) applies to both new flows.

## i2c content script changes

### `tryAccountTransactions` gating
Add `'qc_month_scrape'` to the list of flows that need to click into the Account Transactions sidebar (currently `'verify_balance' | 'reverse_fee'`).

### `tryAdminServices` gating
Add `'apply_credit'` alongside `'admin_debit'`.

### New step `tryDateRangeScrape`
Runs only when `flow === 'qc_month_scrape'`:
1. On the Account Transactions page, set the date dropdown to "Date Range".
2. Set From = (today − 14 months), To = today.
3. Click Search.
4. Wait for the table to render. Use the same pixel-position alignment trick as `tryReadRunningBalance` to find the Trans. Date column.
5. Extract `YYYY-MM` from each row's date.
6. Deduplicate the month set; that's `monthsUsed`. Write `qc_month_scrape_result` to storage; clear pending keys.

### New step `tryFillApplyCredit`
Mirrors `tryFillAdminDebit`. Selects the credit Service option, fills Amount input + Comments textarea. Does NOT click Apply.

## Known unknowns

Flagged for implementation:

1. **Exact i2c Admin Service name for credit.** Best guess: "Admin Funds Credit" (counterpart to "Admin Funds Debit"). Will verify by inspecting the dropdown on a live i2c session before shipping `tryFillApplyCredit`'s option-finder.
2. **REIMB summary wording.** Proposed: `Quebec fee waiver prorated refund for WOCOO-<KEY>`. Confirm with Albert.
3. **Newly eligible inputs.** Proposed: manual month/year inputs (HTML `type="month"`). Could be enhanced to query Preset's tier-change-events dashboard, but that's v2.
4. **Edge case: months_used = 0.** Per policy, no transactions → full $220 refund. Calculation `$220 − $20 × 0 = $220` is correct, but the "did the client even pay the fee?" toggle still gates whether Step 5 fires.
5. **Approver rule for QC refunds.** Reusing Overpayment Triage's `≥ $5K = Amanda, else Luke` since QC refunds rarely exceed $220. Confirm this is appropriate.

## Out-of-scope (deferred)

- Auto-detect scenario from ticket description.
- Audit log of past QC waivers (could go to the same Apps Script bridge sheet).
- Preset query for the eligibility-flip month (manual input for v1).
- Multi-ticket batch processing.
- Validation that the entered "anniversary month" matches when the $220 charge actually posted in i2c. Could cross-check via the `qc_month_scrape` data but adds complexity.

## Implementation order

1. Add new flow values + storage keys to `i2c.ts`. Stub `tryDateRangeScrape` + `tryFillApplyCredit` with placeholders + heavy console logging.
2. Build the `QCFeeWaiverWorkflow.tsx` shell — header, progress dots, step cards. Hard-code dummy values to validate the visual.
3. Wire `SidePanel.tsx` — new button + state route. Test that clicking the button opens the modal and clicking Back returns.
4. Implement Step 1 (scenario picker) and Step 2 (inputs). For the Cancellation path, wire the Scrape-from-i2c button + storage listener.
5. Implement `tryDateRangeScrape` in the content script. Verify months-used capture works end-to-end on a real i2c session.
6. Implement Steps 3 (calculation), 4 (apply credit launch), and `tryFillApplyCredit`.
7. Implement Step 5 (REIMB) — reuse `createReimbTicket`.
8. Implement Steps 6 (comment) and 7 (Done) — reuse `postComment` / `transitionTicket`.
9. Implement Step 8 (success panel).
10. Polish, error handling, edge cases.

## Open questions for review

- Button color in QuickActions — current palette has `highlight`/`special`/`warning`/`positive` taken. Suggesting `neutral` (black) for QC Fee Waiver so it reads as distinct, but happy to swap.
- Scrape date range — 14 months is a guess. Should it be calendar-year-to-date, or rolling 12 months, or since CC creation date (would need an extra Atlas lookup)?
