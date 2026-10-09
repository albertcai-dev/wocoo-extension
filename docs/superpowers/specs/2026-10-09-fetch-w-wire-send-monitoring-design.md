# Fetch W# Wire Send Monitoring — design

**Date:** 2026-10-09 · **Status:** approved in chat, awaiting spec review

## Problem

Rows in the RBC incoming wires tracker sometimes have no receiver external account (W#). These
are returns of wires we sent: `txdetail_rmtinfo_ustrd` carries the original send's reference,
e.g.

```
/BNF/RETURN WIRE DATED 10 07 26 //REF AVJJXHZEBVIA53DF CAD56,295.89//. //LESS CHGS AS //8 00362 LESS CHG
```

Today that is five manual hops: copy the REF → paste it into the search box of "ALL wire sends
created" on the Wire Send Monitoring dashboard (Preset 5783) → copy `source_id`
(`ca-cash-msb-…`) → search it in Atlas → read the W# under that CHEQUING account → paste into
the tracker.

## Goal

A Sidekick Home → Tools tile, **Fetch W# Wire Send Monitoring**, that takes the pasted cell (or
the bare REF) and returns a copy-pastable W#, like the side panel's "Fetch Account Number,
Email, Client Status" chip. One wire at a time.

**Success:** pasting the cell above yields `WK5LGP131CAD` with no manual Preset or Atlas step.

**Out of scope:** writing to the tracker sheet; batches of wires.

## Facts established

- The dashboard search matches the **`e2e_identifier`** column of chart 86733 "ALL wire sends
  created" (dataset **62667**, raw table mode). Values are 16-char uppercase alphanumerics
  (`AVMYYSJRTII6TJTV`).
- The same row has `source_id` (`ca-cash-msb-…`, sometimes `ca-cash-corporate-…`),
  `actor_identity_id`, `FI canonical id`, `requested_amount_value`, `currency`, `created_at`,
  `Wire Send status`.
- The chart's own time filter is `created_at` "last month : tomorrow"; the tool applies **no**
  time filter, so older sends still resolve.
- Atlas `getAccountDetails(id: <source_id>)` on the `wealthsimple` GraphQL service returns
  `account.custodianAccounts[].custodianAccountId` — the W#. Already used as hop 2 of
  `fetchSpendAccountNumberViaChain` (`extension/src/data/atlasGraphql.ts`).
- Preset rejects API calls from the extension origin (Flask-WTF referrer check), so requests run
  inside a hidden Preset tab (`extension/src/data/presetSql.ts`, spike S1 of
  `2026-10-05-insurance-eligibility-spikes.md`).

## Design

### Flow

1. **Parse** — `parseWireRef(input): string | null` in `extension/src/data/wireRef.ts`.
   - Upper-cases and trims the input.
   - If it contains `REF` followed by optional spaces/slashes and a 16-char `[A-Z0-9]` token,
     returns that token.
   - Else if the whole input is a 16-char `[A-Z0-9]` token, returns it.
   - Else `null` → "Couldn't find a REF in that text."
2. **Preset** — `fetchWireSendsByRef(ref): Promise<WireSendRow[]>` in
   `extension/src/data/presetChartData.ts`.
   - Opens the hidden Preset tab on `/api/v1/security/csrf_token/` and runs a self-contained
     page function in the MAIN world: fetch the CSRF token, then `POST /api/v1/chart/data` with
     `datasource {id: 62667, type: 'table'}`, `result_type: 'full'`, one query in raw mode with
     the columns listed above, filter `{col: 'e2e_identifier', op: '==', val: ref}`, no time
     range, `row_limit: 10`.
   - The tab open / wait / same-origin check / close / overall-timeout code in `presetSql.ts` is
     extracted into a shared `runInPresetTab(func, args, deps)` helper that both `runPresetSql`
     and the new module use. Behaviour of `runPresetSql` is unchanged; its tests keep passing.
   - Auth failures throw the existing `PresetAuthError`.
   - The ref is validated by `parseWireRef` before it reaches the request, and is sent as a JSON
     filter value, never interpolated into SQL.
3. **Atlas** — for a single matched row, call `getAccountDetails` with its `source_id` via the
   existing `atlasGraphql`. New reader `readCustodianAccountNumber(res)` returns
   `{ accountNumber, isCadSpend }`: the first `W…CAD` custodian id if any (`isCadSpend: true`),
   otherwise the first W-prefixed id (`isCadSpend: false`), otherwise `null`. It never returns
   a `C…` id — that is the custodian sibling listed next to the W# (e.g. `C13BVPP28CAD` beside
   `WK5LGP131CAD`), not the client's account number.

### UI — `extension/src/sidepanel/FetchWireSendW.tsx`

Inline tile in Home → Tools, between **Wires Pending Posting** and **Mobile Cheque Validation**
(`HomeView.tsx`). One textarea ("Paste txdetail_rmtinfo_ustrd or the REF") and a **Fetch W#**
button; busy label "Fetching…".

Result card, styled like the side panel's captured-from-Atlas card:

- **W#:** monospace, `user-select: all`, Copy button.
- Context lines for a sanity check: identity id, amount + currency, send `created_at`,
  `source_id`, ↗ Atlas link
  (`https://atlas.wealthsimple.com/identity/<actor_identity_id>/transfers/<FI canonical id>`).
- Warning pill when `isCadSpend` is false: "Not a CAD chequing account — check before pasting."

### Error states

| Case | Message |
| --- | --- |
| No REF in input | Couldn't find a REF in that text. |
| Not signed in to Preset | Sign in to Preset, then press Fetch again. |
| Zero rows | No wire send with e2e_identifier `<ref>` — this may not be a returned send. |
| More than one row | Lists every match (ref, identity, amount, date, source_id); no auto-pick, no Atlas call. |
| Atlas error / no custodian id | Atlas didn't return an account number for `<source_id>`, plus the ↗ Atlas link. |
| Preset timeout / other error | The error text. |

## Testing

vitest, fakes for `fetch` and Chrome tab deps (pattern: `presetSql.test.ts`).

- `parseWireRef`: the cell above → `AVJJXHZEBVIA53DF`; a bare ref; lowercase input; `//REF`
  without a space; junk → `null`; a 15-char token → `null`.
- Chart-data page function: request body (datasource, filter, no time range, CSRF header);
  rows parsed; 401/403 → auth; non-OK → error message.
- Shared tab helper: existing `runPresetSql` tests unchanged and green.
- `readCustodianAccountNumber`: CAD W#, USD-only, mixed (CAD preferred), empty → `null`.
- **Live check (user):** the AVJJXHZEBVIA53DF wire returns `WK5LGP131CAD`.

## Risk and first task

Unverified: that `/api/v1/chart/data` accepts the hidden-tab request the way
`/api/v1/sqllab/execute/` does (same CSRF + cookie path, but a different endpoint and
permission check). **Task 1 is a live spike** of exactly that request for the example ref. If
it fails, fall back to approach B (hand-written SQL Lab query via `runPresetSql`) and update
this spec before continuing.

## Spike result (2026-10-09)

Verified live through the shipped tile rather than a console snippet (ledger ruling):
`POST /api/v1/chart/data` from the hidden Preset tab returns the wire send for
AVJJXHZEBVIA53DF — `source_id` ca-cash-msb-icIMc1DLuA, 56295.89 CAD — and Atlas
`getAccountDetails` resolves it to `WK5LGP131CAD`. `created_at` arrives as epoch ms
(rendered `2026-10-07 01:58:55 UTC`).
