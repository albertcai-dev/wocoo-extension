# CC Ops eligibility bridge (standalone POC)

Run all of this in the **creditcardoperations@wealthsimple.com** Chrome profile. No clasp.

0. This is a standalone project. Do **not** add it to the CC Ops Automation sheet's Apps Script — that project stays unchanged for coworkers.
1. Create the test log sheet: Google Sheets → Blank spreadsheet, name it "Eligibility POC Log"; rename the first tab to `Requests`; in row 1 put the 12 headers
   `request_message_id, thread_id, insurer_email, client_email, status, last4, is_delinquent, activation_date, card_product, match_method, draft_id, notes` (A1:L1). Copy its id from the URL (`/d/<id>/edit`).
2. Go to https://script.google.com → New project; name it "Sidekick Eligibility Bridge (POC)". Replace the default code with `Eligibility.gs` from this folder. Save.
3. Project Settings (gear) → Script Properties → add:
   - `INSURERS_SHEET_ID` = `1nkUKJw4o56agzPlfTaLq5FDonqoVNVLt3dif9dlw2Fg` (CC Ops Automation — read only)
   - `LOG_SHEET_ID` = the test sheet id from step 1
   - `ELIG_ALLOWED_USERS` = comma-separated emails allowed to use it (e.g. `albert.cai@wealthsimple.com`). Empty = nobody.
4. Select `testListEligibilityRequests` → Run → accept the permission prompts (as creditcardoperations@). Execution log should show `requests=N …`.
5. (Optional — skip for a read-only POC) `testEligibilityIdempotency` creates and deletes one test draft in the shared mailbox.
6. Deploy → New deployment → Web app. Execute as: **Me**. Who has access: **Anyone within Wealthsimple**. Copy the `/exec` URL into `extension/src/api/bridgeTabs.ts` → `ELIGIBILITY_BRIDGE_URL`.
7. After every later edit: Deploy → Manage deployments → Edit → Version: **New version**.

## Read-only POC

Fetch and Resolve in the panel write nothing (no drafts, labels or sheet rows). Only "Create drafts & log"
and "Send all drafts" have side effects in the shared mailbox. The CC Ops Automation sheet is only ever read
(Insurers tab); logging goes to the "Eligibility POC Log" sheet.
