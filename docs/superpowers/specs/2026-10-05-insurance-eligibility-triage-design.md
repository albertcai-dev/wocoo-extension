# Insurance Eligibility Confirmation Triage — design

**Date:** 2026-10-05
**Replaces:** the `CC Ops Automation` Google Sheet workflow (menu-driven Apps Script owned by
`creditcardoperations@wealthsimple.com`).
**Lives in:** Sidekick, Home view → Tools, as a new tile "Insurance Eligibility Confirmation
Triage" next to Wires Pending Posting and Mobile Cheque Validation.

## Problem

Every day, insurers and claims adjusters email `creditcardoperations@wealthsimple.com` asking us
to confirm a Wealthsimple Visa Infinite cardholder. A typical request gives some of: cardholder
name, one or more email addresses, a phone number, the card's last 4 digits, date of loss, and a
claim number. It asks for each card's product name and activation date, the coverages opted into
if the card is Visa Infinite 1%, and whether the card has been in good standing.

The current process is eight manual menu steps in the `CC Ops Automation` sheet:

1. Archive `Requests` → `previous records`
2. Ingest unread requests (Apps Script reads the inbox, writes one row per request)
3. Fix `NEEDS_REVIEW` rows by hand ("manually update client_email")
4. Clear `preset_data`, run a Preset SQL query by hand with the batch's emails, paste results
5. Populate `Requests` from `preset_data` (joined on `client_email`)
6. Mark `PENDING` rows as `READY_TO_REPLY`
7. Send auto replies (replies in-thread, marks the thread read, sets `READ_EMAIL`)
8. Archive again

Step 3 is the toil: when the insurer's email is wrong, nothing downstream matches and an
associate has to search Atlas by hand for a client with that phone number and last 4.

The current automation also has accuracy gaps that this design fixes on purpose:

| # | Current behaviour | Consequence |
|---|---|---|
| G1 | `findClientEmailInBody_` keeps only the **first** non-insurer email in the body | A request listing two emails fails if the first is wrong, even when the second is right |
| G2 | The `populateFromPresetData` lookup keys on email and keeps the **last** row per email | Clients with several open cards get one card reported; the insurer asks for each |
| G3 | Ingest skips any request whose `client_email` is already in `Requests` | A second claim for the same client in one batch is silently dropped |
| G4 | Matching is email-only | Name, phone and last 4 are never used to find the right client |

## Goals

- One button handles every unread eligibility request, whether the insurer's email is right or
  wrong.
- Match on every identifier the email provides, in a fixed precedence, and always require the
  card's last 4 to agree.
- Produce reply drafts in `creditcardoperations@` in the existing reply format, one block per
  open card.
- Send all Sidekick drafts in one confirmed action, after the associate has reviewed (and
  optionally edited) them in Gmail.
- Keep an audit row per request in the existing `Requests` sheet, including how it matched.

## Non-goals

- Answering the "Visa Infinite 1% coverages opted for" question. Not answered today; 1% cards
  are flagged for manual handling (see Matching outcomes).
- Changing the activation-date definition. It stays **card creation date** (`cc.created_at`,
  shown in i2c as "Card Creation Date"), matching every reply sent to date. A future change to
  `physical_card_activated_at` is a one-line SQL edit.
- Ingesting the special "First" follow-up threads (`ingestFollowUpEmails`). Those threads already
  have a reply and surface as ⚠️ "already replied" for manual handling.
- Unattended / scheduled runs. Every run starts from the button.
- Retiring the `CC Ops Automation` menu. It stays installed as a fallback until the new tool has
  run clean for two weeks; the two must not be run on the same batch (see Coexistence).

## Architecture

Three components, one data flow.

```
 creditcardoperations@ inbox
          │  (Apps Script web app, executes as creditcardoperations@)
          ▼
 ┌─────────────────────┐   listEligibilityRequests   ┌──────────────────────────────┐
 │ Eligibility bridge  │ ──────────────────────────▶ │ Sidekick: EligibilityTriage  │
 │ (CC Ops Automation  │ ◀── createEligibilityDraft ─│  1. parse   (pure, tested)   │
 │  Apps Script)       │ ◀── sendEligibilityDrafts ──│  2. resolve (Preset → Atlas  │
 │                     │ ◀── logEligibilityResult ───│             → i2c)           │
 └─────────────────────┘                             │  3. render drafts + panel    │
          │                                          └──────────────────────────────┘
          ▼                                                 │          │        │
 Requests sheet (audit)                          Preset SQL Lab   Atlas     i2c
                                                 (user session)  (session) (session)
```

### 1. Eligibility bridge (Apps Script)

New `.gs` file added to the **CC Ops Automation** Apps Script project (container-bound to the
sheet, owned by `creditcardoperations@`). Deployed as a **separate web app** from the shared
WOCOO bridge:

- Execute as: **Me** (`creditcardoperations@`). This makes `GmailApp` read and draft in that
  mailbox no matter who calls it.
- Who has access: **Anyone within Wealthsimple**.
- Pasted and deployed through the web editor while signed in as `creditcardoperations@` (no
  clasp). Every code change needs **Deploy → New version**.

It follows the existing bridge protocol: a `doGet` router keyed on `?action=`, an `HtmlOutput`
reply that posts `{action: '<replyAction>', ...}` to **`window.top`** (not `window.parent`), and
the extension's existing `gasBridge.ts` relay. Sidekick calls it through `callBridge` with a new
base URL constant (`ELIGIBILITY_BRIDGE_URL`) and the existing headless-tab handling.

Actions:

| Action | Input | Does | Returns (`replyAction`) |
|---|---|---|---|
| `listEligibilityRequests` | — | `GmailApp.search('in:inbox is:unread')`; keeps threads whose latest message is from a sender on the `Insurers` tab (same normalisation as `loadInsurers_`) and that do **not** carry `Sidekick/Drafted`. | `eligibilityRequestsListed`: `[{threadId, messageId, from, subject, date, messageCount, plainBody}]` (body capped at 20 KB) |
| `createEligibilityDraft` | `messageId`, `body` | `GmailApp.getMessageById(id).createDraftReply(body, {name: 'Cash and Card Operations'})`; adds label `Sidekick/Drafted` to the thread. Idempotent: if the thread already has `Sidekick/Drafted`, returns the existing draft id. | `eligibilityDraftCreated`: `{messageId, draftId}` |
| `sendEligibilityDrafts` | `draftIds[]` | For each id: `GmailApp.getDraft(id).send()`, mark thread read, swap label `Sidekick/Drafted` → `Sidekick/Sent`. Continues past individual failures. Only acts on the ids passed in, which Sidekick reads from its own `Requests` rows, so other drafts in the mailbox are never touched. | `eligibilityDraftsSent`: `[{draftId, ok, error?}]` |
| `logEligibilityResult` | one result object | Appends or updates (keyed on `request_message_id`) a row in `Requests`. | `eligibilityResultLogged` |

`Requests` keeps its nine existing columns in order (`request_message_id`, `thread_id`,
`insurer_email`, `client_email`, `status`, `last4`, `is_delinquent`, `activation_date`,
`card_product`) and gains three to the right: `match_method`, `draft_id`, `notes`. Existing
`archiveRequestsToPreviousRecords` keeps working because it copies by column count.
`previous records` gets the same three header cells added once by hand.

Statuses written by the new tool: `DRAFTED`, `READ_EMAIL` (sent — the existing "replied"
value), `NEEDS_REVIEW` (⚠️), `NO_MATCH` (❌), `ALREADY_HAS_ONE_REPLY` (existing value).

### 2. Parser (`src/data/eligibilityParse.ts`, pure)

Input: subject + plain-text body + sender. Output:

```ts
interface EligibilityRequest {
  threadId: string; messageId: string;
  insurerEmail: string; insurerName: string;
  cardholderName: { first: string; last: string; raw: string } | null;
  emails: string[];        // every non-insurer address, in order, de-duplicated, lowercased
  phone: string | null;    // digits only, 10 digits (leading 1 stripped)
  last4: string | null;    // from "last 4 digits - 1763", "ending in 1763", "****1763", etc.
  claimNumber: string | null;
  dateOfLoss: string | null;
  warnings: string[];      // e.g. "two different last-4 values found"
}
```

Rules:

- Labelled fields first (`Cardholder:`, `Name:`, `Email:`, `Phone:`, `Tel:`, `DOL:`), then
  fall back to scanning the body (and the subject, which often carries the cardholder name and
  claim number).
- `emails` excludes the sender and any address whose domain matches an `Insurers` domain or
  `wealthsimple.com` (fixes G1 by keeping all candidates).
- Name split: last whitespace-separated token is `last`, the rest is `first`. Matching compares
  normalised forms (lowercase, accents stripped, punctuation removed).
- If more than one distinct last-4 value appears, `last4` is the labelled one and a warning is
  added.

### 3. Resolver (`src/data/eligibilityResolve.ts` + lookups)

Runs per batch, in this order. **Every rule requires the card's last 4 to equal the request's
`last4`.** A request with no `last4` is never auto-matched.

**Step 1 — warehouse (one query per batch).** Sidekick builds one SQL statement for all requests
and runs it through Preset SQL Lab using the user's logged-in Preset session (see Spike S1). The
query is the current Preset query, extended to:

- take the batch as an inline `UNION ALL` table of `(request_id, email, first_name_norm,
  last_name_norm, last4)` rows (one row per candidate email);
- return, for each request, every identity that matches **either** (any listed email **and** an
  open card with that last 4) **or** (first + last name **and** an open card with that last 4),
  tagging which rule matched;
- for each matched identity, return **all** open non-prepaid credit cards (fixes G2):
  `last4`, `card_product_id`, `created_at` (formatted `MM/DD/YYYY`, America/New_York, as today),
  and the identity's latest `is_delinquent_account`.

Values in the SQL are escaped (single quotes doubled) and validated against strict patterns
(email regex, `^\d{4}$`, letters/spaces/hyphens/apostrophes for names) before interpolation.

**Step 2 — live fallback (only requests with no Step 1 match).** The warehouse is roughly a day
behind, so a card opened yesterday can miss Step 1 even when every detail is right.

1. **i2c by listed email.** For each email the insurer gave, run the existing i2c `card_details`
   chain, extended to also read **Program**, **Delinquency Status** and **Card Creation Date**
   from the Card Details tab. Stop at the first email whose customer has a card with the
   request's last 4.
2. **Atlas by phone** (only if 2.1 found nothing and the request has a phone; see Spike S2).
   Keep identities whose profile name matches the request's name, read each one's client email
   from Atlas (existing `clientDetailsLookup` / sidebar email read), then run the same i2c chain
   on that email and confirm the last 4.

Step 2 runs one request at a time because the i2c chain uses global `pending_i2c_*` keys. The
panel shows progress per row.

i2c reports the product as a **Program** name (e.g. "Wealthsimple Visa Infinite VIP 01
Physical"), not a `card_product_id`. Step 2 maps Program → `card_product_id` with a small table
(`src/data/eligibilityProducts.ts`) seeded from the first live run. An unmapped Program makes the
row ⚠️ `unknown_product`, never a guessed product. Only cards that i2c shows as open are
reported, matching Step 1's `i2c_card_status = 'open'`.

**Matching outcomes**

| Outcome | Condition | Draft? |
|---|---|---|
| ✅ `email_last4` | Exactly one identity matched on a listed email + last 4 | Yes |
| ✅ `name_last4` | No email match; exactly one identity matched on name + last 4 | Yes |
| ✅ `i2c_email` | Step 2.1: i2c found a card with the last 4 under a listed email | Yes |
| ✅ `atlas_phone_i2c` | Step 2.2: exactly one name-matched Atlas identity, and i2c confirmed the last 4 | Yes |
| ⚠️ `multiple_candidates` | More than one identity matched at the winning step | No, candidates listed |
| ⚠️ `delinquent` | Matched, but the matched card's identity is delinquent | Only if ticked |
| ⚠️ `vi_1pct` | Matched card's product is the 1% product | Only if ticked (coverages must be added by hand) |
| ⚠️ `no_last4` / `parse_warning` | Parser found no last 4, or added warnings | No |
| ⚠️ `unknown_product` | Step 2 matched, but the i2c Program isn't in the product map | No |
| ⚠️ `already_replied` | Thread has more than one message | No |
| ❌ `no_match` | Nothing matched at any step | No |

The 1% product id is read from the results (`card_product` values seen so far are all
`ws_visa_infinite_privilege`); the exact id is confirmed during the first live run and stored as
a constant.

### 4. Draft rendering (`src/data/eligibilityDraft.ts`, pure)

Same format as current replies (`sendAutoRepliescheck2`):

```
Hi,

Here are the requested details for client {email}:

• Last 4 digits of card: {last4}
• Status: the card is in good standing
• Activation date: {MM/DD/YYYY}
• Product: {card_product}

Best,
Cash and Card Operations
```

- `{email}` and the space before it are included **only** when the matched client email is one
  the insurer supplied. Otherwise the line reads "Here are the requested details for client:" so
  that a client's real email is never disclosed to an insurer that did not have it.
- One `• Last 4 / Status / Activation date / Product` block per open card, the requested last 4
  first, blocks separated by a blank line.
- Status text: `the card is in good standing` / `the card is not in good standing`, from
  `is_delinquent` as today.
- `last4` is zero-padded to 4 digits as today.

## Panel UX

New `src/sidepanel/EligibilityTriage.tsx`, opened from a new `ToolTile` in `HomeView`'s Tools
section and wired in `SidePanel` the same way as `WiresPendingPosting` (state flag, early-return
render, reset when a ticket arrives).

1. **Fetch requests**: calls `listEligibilityRequests`, parses each, and lists them with the
   parsed fields so the associate can see what was extracted.
2. **Resolve**: runs Step 1, then Step 2 for the rows that need it. Each row turns ✅ / ⚠️ / ❌
   with its match method and a read-only draft preview.
3. **Create drafts**: creates drafts for ✅ rows plus any ⚠️ rows the associate ticked, then logs
   every row (including ⚠️ and ❌) to `Requests`.
4. **Send all drafts**: two-step confirm ("Send N drafts?" → **Confirm send**), calls
   `sendEligibilityDrafts` with the draft ids from this batch, and shows per-draft results.
   Drafts edited in Gmail are sent as edited.

The run's state is kept in `chrome.storage.session` so closing and reopening the panel mid-run
does not lose it. Client data is not written to `chrome.storage.local`.

## Error handling

- **Not signed in** to Preset, Atlas or i2c: the step stops and the panel says "Sign in to X and
  press Retry". No draft is created from a partially resolved row.
- **Bridge timeout / error**: the action's error is shown with a Retry button. Bridge calls are
  idempotent (`createEligibilityDraft` checks the label; `logEligibilityResult` upserts).
- **Preset query error**: the panel shows the engine error and offers **Copy SQL** so the
  associate can run it in SQL Lab and paste the result table back into the panel (manual
  fallback; same parse path).
- **i2c chain timeout** (customer not found or page change): that row becomes ❌ with
  "i2c lookup timed out"; the rest of the batch continues.

## Coexistence with CC Ops Automation

Both read the same inbox. The new tool never marks a thread read until it sends, and the old
`ingestUnreadRequests` would still pick up threads Sidekick has drafted. So: **do not run the old
menu on a batch the new tool has drafted.** The old menu stays only as a fallback for days the new
tool is unavailable. After two weeks of clean runs, its menu items are removed.

## Spikes before building (throwaway code)

- **S1 — Preset SQL from the extension.** Can the extension execute SQL through Preset SQL Lab
  with the user's session (`/api/v1/sqllab/execute/` + CSRF token, database = Pantheon) and poll
  the results? Try a direct `fetch` from the extension first (needs a Preset `host_permissions`
  entry), and a content script on a background Preset tab second. If neither works, Step 1 ships
  as **Copy SQL → paste results** in the panel.
- **S2 — Atlas search by phone.** Does Atlas have a phone search (search page or GraphQL
  operation) that returns identities? Captured from Atlas's own network traffic. If not, Step 2
  is dropped and phone-only requests end as ❌ for manual handling.

Results of both spikes are reported before the plan's dependent tasks start.

## Testing

- Vitest unit tests (existing `npm test` setup, node environment):
  - `eligibilityParse.test.ts`: synthetic fixtures modelled on real formats (labelled block with
    two emails; subject-only name; "ending in" phrasing; missing last 4; two last-4 values).
    Fixtures use invented names and addresses only.
  - `eligibilitySql.test.ts`: batch SQL builder escapes and rejects bad values; snapshot of the
    generated SQL for a three-request batch.
  - `eligibilityResolve.test.ts`: precedence and outcome table above, from canned query rows.
  - `eligibilityDraft.test.ts`: email-line privacy rule, multi-card blocks, padding, status text.
- Apps Script: `testListEligibilityRequests()` and `testCreateEligibilityDraft()` editor
  functions that run against the live mailbox and log results, for use after each deploy.
- First live run: draft-only on the current unread batch. The associate compares drafts with what
  the old process would have sent before using **Send all drafts**.
