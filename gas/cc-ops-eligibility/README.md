# CC Ops eligibility bridge

Pasted into the **CC Ops Automation** Apps Script project (Extensions → Apps Script from the
sheet), signed in as creditcardoperations@wealthsimple.com. No clasp.

0. Before pasting: search every file in the project for `function doGet`. If one exists, **stop** — the router must be merged into it (two `doGet`s silently override each other).
1. Add a file `Eligibility.gs`, paste `Eligibility.gs` from this folder, Save.
2. Run `testListEligibilityRequests` once and accept the Gmail + Sheets permission prompt.
3. Run `testEligibilityIdempotency` (needs ≥1 unread insurer email). Expect "Idempotency OK".
4. Deploy → New deployment → Web app. Execute as: **Me**. Who has access: **Anyone within Wealthsimple**.
5. Project Settings → Script Properties → add `ELIG_ALLOWED_USERS` = comma-separated Wealthsimple emails allowed to use the tool (e.g. `albert.cai@wealthsimple.com`). Empty = nobody can use it.
6. Copy the `/exec` URL into `extension/src/api/bridgeTabs.ts` → `ELIGIBILITY_BRIDGE_URL`.
6a. In the sheet's `previous records` tab, type `match_method`, `draft_id`, `notes` into J1, K1, L1
    (once). `Requests` gets them automatically on the first logged row.
7. After every later edit: Deploy → Manage deployments → Edit → Version: **New version**.
