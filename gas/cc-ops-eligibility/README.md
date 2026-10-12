# CC Ops eligibility bridge (standalone POC)

Run all of this in the **creditcardoperations@wealthsimple.com** Chrome profile. No clasp.

0. This is a standalone project. Do **not** add it to the CC Ops Automation sheet's Apps Script — that project stays unchanged for coworkers.
1. Create the test log sheet: Google Sheets → Blank spreadsheet, name it "Eligibility POC Log"; rename the first tab to `Requests`; in row 1 put the 12 headers
   `request_message_id, thread_id, insurer_email, client_email, status, last4, is_delinquent, activation_date, card_product, match_method, draft_id, notes` (A1:L1). Copy its id from the URL (`/d/<id>/edit`).
2. Go to https://script.google.com → New project; name it "Sidekick Eligibility Bridge (POC)". Replace the default code with `Eligibility.gs` from this folder. Save.
3. Project Settings (gear) → Script Properties → add:
   - `INSURERS_SHEET_ID` = `1nkUKJw4o56agzPlfTaLq5FDonqoVNVLt3dif9dlw2Fg` (CC Ops Automation — reads the Insurers tab; writes only the "previous records" tab, columns A–I)
   - `LOG_SHEET_ID` = the test sheet id from step 1
   - `ELIG_ALLOWED_USERS` = comma-separated emails allowed to use it (e.g. `albert.cai@wealthsimple.com`). Empty = nobody.
4. Select `testListEligibilityRequests` → Run → accept the permission prompts (as creditcardoperations@). Execution log should show `requests=N …`.
5. (Optional — skip for a read-only POC) `testEligibilityIdempotency` creates and deletes one test draft in the shared mailbox.
6. Deploy → New deployment → Web app. Execute as: **Me**. Who has access: **Anyone within Wealthsimple**. Copy the `/exec` URL into `extension/src/api/bridgeTabs.ts` → `ELIGIBILITY_BRIDGE_URL`.
7. After every later edit: Deploy → Manage deployments → Edit → Version: **New version**.

## What it reads and writes

Fetch and Resolve in the panel write nothing (no drafts, labels or sheet rows). Only "Create drafts & log"
and "Send all drafts" have side effects in the shared mailbox.

In the CC Ops Automation sheet (`INSURERS_SHEET_ID`) the script:
- **reads** the `Insurers` tab;
- **writes** the `previous records` tab only, and only columns **A–I**
  (`request_message_id, thread_id, insurer_email, client_email, status, last4, is_delinquent, activation_date,
  card_product`). Each draft created (or reused) by "Create drafts & log" is upserted on column A — a new row
  goes below the last row, an existing row is overwritten in A–I only. The last4 cell is set to plain text so
  leading zeros survive (A and B are plain text too); other cell formats are left alone. "Send all drafts" then
  sets column E to `READ_EMAIL` on that same row only — matched on both its request id (column A, remembered per
  draft in the `elig_prev_req_<draftId>` script property) and thread id (column B), and only while it reads
  `DRAFTED`. Rows written by anyone else for the same thread are never touched.

A failure on that tab (missing tab, no edit access, no row for the thread) never fails a draft or a send — it
comes back as a per-row warning in the panel. The full 12-column audit row is still logged to the
"Eligibility POC Log" sheet (`LOG_SHEET_ID`).

The account that owns the script (creditcardoperations@) needs **edit** access to the CC Ops Automation sheet
for the "previous records" write.

## Follow-up threads

A thread with more than one message is a follow-up. The list returns the original insurer message's body as
`originalBody` (so a terse "just following up" can still be matched) and `priorReplyFromUs` when
creditcardoperations@ already replied in it. The panel flags these for review; they are drafted only when the
user ticks "Reply anyway".
