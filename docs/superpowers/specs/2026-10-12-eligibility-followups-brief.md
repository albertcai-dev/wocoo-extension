# Eligibility: reply-anyway for follow-up threads + write to CC Ops "previous records"

User (2026-10-12):
1. "if a reply is already made, can you have a button to still push that information/bypass? A lot of times it's just
   the insurance person following up to that email." (screenshot: several Crawford rows ⚠ "Thread already has a reply",
   some with ****????).
2. "can you also make it so that it writes into previous records each time it does create a draft?"
   → CC Ops Automation sheet `1nkUKJw4o56agzPlfTaLq5FDonqoVNVLt3dif9dlw2Fg`, tab "previous records" (gid 175811452).

Branch `feat/eligibility-followups` (from `feat/eligibility-phone-no-last4`). Read the current code first —
eligibilityResolve.ts `preflight`, eligibilityParse.ts, eligibilityRun.ts, eligibilityTypes.ts, eligibilityRunState.ts,
EligibilityTriage.tsx, api/bridge.ts eligibility functions, gas/cc-ops-eligibility/Eligibility.gs + README.md.

## A. Follow-up threads (already replied)

### Apps Script
- `eligRequestShape_`: add `originalBody` = plain body (capped at ELIG_BODY_CAP) of the FIRST non-draft message in the
  thread whose sender is an insurer address (fall back to the first non-draft message); `''` when the thread has one
  message. Add `priorReplyFromUs: boolean` = any non-draft message in the thread sent by the script owner
  (`Session.getEffectiveUser().getEmail()`, lowercased, compared with `eligExtractEmail_(m.getFrom())`).
  Apply to both the request list and the rehydrated drafted list. No other list/selection behaviour changes.

### Extension
- `RawEligibilityEmail`: optional `originalBody?: string; priorReplyFromUs?: boolean` (bridge maps them defensively).
- `eligibilityParse.ts`: add `parseEligibilityThread(raw, excludedDomains)`: if `raw.messageCount > 1 && raw.originalBody`,
  parse the latest message (`parseEligibilityEmail(raw, …)`) and the original (`parseEligibilityEmail({ ...raw, plainBody: raw.originalBody }, …)`)
  separately and merge: each scalar field = latest's value if non-null else original's; `emails` = latest's then
  original's, de-duplicated; `cardholderName` = latest's if present else original's; `warnings` = both; and if both
  have a last4 and they differ, add warning `Follow-up and original email give different last-4 values: X, Y` (last4 =
  latest's). Otherwise return `parseEligibilityEmail(raw, …)`. Use `parseEligibilityThread` everywhere the panel
  currently calls `parseEligibilityEmail`. `isEligibilityRequest` should also accept the email if the original body
  matches (so a terse follow-up isn't skipped as "not an eligibility request").
- Carry `priorReplyFromUs` onto `EligibilityRequest` (optional boolean).
- `eligibilityResolve.ts` `preflight`: no longer returns early for `messageCount > 1` (keep the no-last-4 / other rules
  exactly as they are on this branch). Instead, after resolution (in `resolveBatch`/wherever the final Resolution is
  produced for each request — after warehouse/live/follow-up and name-variant handling), if `req.messageCount > 1` add
  flag `already_replied` (status → `needs_review`) and append to the note: `Follow-up thread` plus, when
  `req.priorReplyFromUs`, ` — creditcardoperations@ has already replied in this thread`. Never drop other flags.
- `TICKABLE_FLAGS`: add `already_replied` (so a matched follow-up is draftable when ticked; still never pre-ticked
  because status is needs_review).
- Panel: for rows whose flags include `already_replied`, the checkbox label is "Reply anyway" (instead of "Include in
  drafts"). FLAG_TEXT `already_replied`: "Follow-up — already has a reply; tick Reply anyway to send".
  `nextLogStatus`: a drafted follow-up logs DRAFTED (existing rule), an un-ticked one keeps ALREADY_HAS_ONE_REPLY.
- Tests (invented data): follow-up latest body without details + original with details → merged fields; conflicting
  last4 → warning; single-message thread unchanged; a matched follow-up → needs_review + already_replied, isDraftable
  true, defaultSelected false; priorReplyFromUs note; already_replied + a non-tickable flag (e.g. multiple_candidates)
  → not draftable; isEligibilityRequest true via originalBody.

## B. Write to CC Ops Automation "previous records"

### Apps Script
- Constant `ELIG_PREVIOUS_RECORDS_TAB = 'previous records'`; the spreadsheet is the one in `INSURERS_SHEET_ID`.
- In `eligCreateAndLog_`, for each item whose draft was created or reused successfully: upsert into that tab, keyed on
  column A (`request_message_id`), the first 9 columns from the item's log row in this order:
  request_message_id, thread_id, insurer_email, client_email, status ('DRAFTED'), last4, is_delinquent,
  activation_date, card_product. New rows append below the last row; existing rows (same request_message_id) are
  overwritten in A:I only (never touch columns beyond I). Set the last4 cell's number format to '@' before writing
  so "0123" stays text; leave other cells' formats alone (the tab's existing rows hold dates/booleans).
  Open the spreadsheet/tab ONCE per batch call. Do it under the same per-item lock already used.
  A failure here must not fail the item: catch it and add `warning: 'previous records not updated: <msg>'` to that
  item's result (`ok` stays true).
- In `eligSendDrafts_`, after a successful send: find the "previous records" row whose column B (`thread_id`) equals the
  sent thread id (the `elig_draft_id_<draftId>` property already maps draft → thread) and set its column E (status) to
  `READ_EMAIL`. Missing row or failure → `warning` on that result, `ok` unchanged. Open the tab once per call.
- Header comment + README: the script now READS the Insurers tab and WRITES the "previous records" tab of the CC Ops
  Automation sheet (only that tab, only columns A–I); still logs the full 12-column audit row to `LOG_SHEET_ID`.
- node --check on a temp .js copy. If feasible, extend the existing node stub harness approach to exercise the upsert
  (append new / overwrite existing A:I / status flip on send).

### Extension
- Bridge result types already carry `warning?`; surface a per-row warning from create/send in the expanded row (small
  soft text), like the existing sendNote.

## Gate
From extension/: `npx tsc -b && npm test && npm run build`; node --check on the .gs. Commit explicit paths (1–2
commits), trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. If 1Password signing errors, don't bypass —
leave staged, report BLOCKED.
