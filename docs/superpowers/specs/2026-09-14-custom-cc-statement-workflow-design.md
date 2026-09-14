# Custom CC Statement workflow — design

**Date:** 2026-09-14
**Driver ticket:** [WOCOO-28171](https://wealthsimple.atlassian.net/browse/WOCOO-28171) — "Client claims that the generated credit card statement has their outdated address while their address had already been updated, they would like to get a statement with updated address."
**Replaces:** the `⚖️ QC Fee Waiver` quick action, which is no longer used.

## Problem

When a Wealthsimple credit card statement is generated with stale client data — most
often an outdated mailing address that a profile update failed to propagate to — and the
error is Wealthsimple's fault, CXA issues a **corrected custom statement**. The public
"no custom credit card statements" line does not apply to WS-caused errors.

Today this is a ~10–30 minute manual Google Docs exercise, documented in the operator's
notes: duplicate a template Doc, run a dozen brittle global find-and-replaces, rebuild
the Activity tables by hand, and work around Google Docs MCP quirks (postal codes come
back masked, table cells are addressed positionally, replaced values collide with each
other). The failure modes are silent and client-visible: a wrong Previous Balance, a
duplicated amount, an orphaned footnote marker.

This design replaces the manual exercise with a side-panel workflow that imports the
client's real statement PDF, parses it deterministically, takes the corrected address
from Atlas, and hands a complete field set to Apps Script, which fills a tokenized copy
of the template and exports a PDF.

## Goals

- Import the client's actual statement PDF and extract every field and activity row from
  it, with no re-typing.
- Correct the client-identity block (name, street, city/province, postal) from Atlas.
- Produce a Google Doc that is visually indistinguishable from the existing hand-made
  output, including the Wealthsimple logo, per-page address headers, table column widths
  and header-row bold.
- Attach the resulting PDF to the WOCOO ticket and log the ticket to the Ticket Log
  sheet.

## Non-goals

- Uploading the PDF to Atlas or sending the Atlas access macro. Those stay manual; the
  extension cannot drive Atlas document upload.
- Correcting anything other than the identity block. Amounts, dates and transactions are
  reproduced from the source statement as-is; if those are wrong, this is the wrong tool.
- Handling non-Wealthsimple statement PDFs or scanned/image-only PDFs. Both fail loudly
  and fall back to manual entry.

## Chosen approach

Parse in the side panel with pdf.js; fill the Doc in Apps Script.

Two approaches were rejected:

- **LLM normalization** (pdf.js text → LLM Gateway → structured JSON). Tolerates layout
  drift without a code change, but puts a full statement's PII through the gateway and
  can hallucinate an amount. For a client-facing financial document, a parser that fails
  loudly beats a model that fails plausibly.
- **Parse in Apps Script** (ship the PDF bytes to GAS). Apps Script has no PDF text
  extractor, and a 100 KB PDF is 133 KB of base64 — far past what the bridge's
  query-string GET can carry.

## Architecture

```
  side panel                                bridge (GAS)              Google
  ──────────                                ────────────              ──────
  CustomCcStatementWorkflow.tsx
    │
    ├─ 1. file picker ──► ccStatementPdf.ts (pdf.js) ─► raw page text
    │                         │
    │                         └─► ccStatementParse.ts ─► ParsedStatement
    │
    ├─ 3. atlasAccountLookup.fetchAtlasClientDetailsHeadless ──────────► Atlas
    │
    └─ 4. api/bridge.ts
             ├─ createCcStatement      ──► CustomCcStatement.gs ──► Drive copy + header fill
             ├─ appendCcStatementRows  ──►                      ──► activity page blocks
             └─ finalizeCcStatement    ──►                      ──► PDF export
                                                                     │
         jira.addAttachment ◄── pdfBase64 ────────────────────────────┘
         bridge.logTicketViaBridge
```

### Payload transport

The bridge is query-string GET only (cross-origin POST to a GAS web app is blocked). A
62-row statement is roughly 4 KB once URL-encoded, which is uncomfortably close to the
practical Apps Script URL ceiling and grows with transaction count.

The workflow therefore makes **three kinds of call**:

| Action | Reply | Payload | Returns |
|---|---|---|---|
| `createCcStatement` | `ccStatementCreated` | header + summary + identity fields | `docId`, `docUrl`, `fileName` |
| `appendCcStatementRows` | `ccStatementRowsAppended` | `docId`, `pageIndex`, up to 15 rows | `rowsAppended` |
| `finalizeCcStatement` | `ccStatementFinalized` | `docId`, `includePdfBase64` | `pdfId`, `pdfUrl`, `pdfBase64?` |

`ROWS_PER_CALL = 15` and `ROWS_PER_PAGE = 18` are independent: the extension batches for
URL length, Apps Script batches for pagination. A page's rows may arrive across two
calls, so `appendCcStatementRows` is idempotent per `(docId, pageIndex)` in the sense
that it appends to the page block it has already created rather than creating a new one.

**Partial-failure contract.** Once `createCcStatement` succeeds the Doc exists. Any later
chunk error surfaces as an error *with the `docUrl` still shown*, so the operator can
finish the Doc by hand instead of losing the work and starting over. The workflow never
deletes a partially-built Doc.

### Row encoding

Each activity row is one query param, pipe-delimited, `pageIndex`-scoped:

```
r0=Jul 25|Jul 25|Payment|From chequing account|–$2,714.06
r1=Aug 3|Aug 4|Purchase|SIXT RENT BOOKING⏎345.84 EUR • 1.620981 exchange rate|$560.60
```

A literal `⏎` (U+23CE) stands in for the newline inside a DETAILS cell — the FX
sub-line. Apps Script splits on it and inserts a real line break. `|` and `⏎` are
stripped from field values before encoding; neither appears in real statement text.

## Components

### `data/ccStatementParse.ts` — pure parser

No DOM, no pdf.js import. Input is the per-page text lines that `ccStatementPdf.ts`
produces; output is `ParsedStatement`. This split is what makes the parser unit-testable.

```ts
export interface StatementActivityRow {
  transDate: string;    // "Jul 25"
  postedDate: string;   // "Jul 26"
  type: string;         // "Purchase" | "Payment" | "Refund settled" | …
  details: string;      // may contain "\n" for the FX sub-line
  amount: string;       // "$560.60" | "–$2,714.06" — en-dash preserved
}

export interface ParsedStatement {
  cardMasked: string;         // "4126 50** **** 5666"
  nameOnStatement: string;    // "LOUIS-PHILIPPE HUBERT" — as printed
  addressLines: string[];     // stale address, shown for contrast only
  statementDate: string;      // "August 25, 2026"
  openingDate: string;        // "Jul 25, 2026"  — derived from the period line
  closingDate: string;        // "Aug 24, 2026"  — derived from the period line
  paymentDueDate: string;     // "Sep 15, 2026"
  creditLimit: string;        // "$25,000.00"
  minimumPayment: string;     // "$360.47"
  statementBalance: string;   // "$7,209.36"
  previousBalance: string;
  payments: string;
  otherCredits: string;
  purchases: string;
  fees: string;
  interest: string;
  cashAdvances: string;
  totalCharges: string;
  totalPaymentsCredits: string;
  newBalance: string;
  annualInterestRate: string;     // "20.99%"
  cashAdvanceInterestRate: string; // "22.99%"
  rows: StatementActivityRow[];
  warnings: string[];             // non-fatal: missing field, arithmetic mismatch
}
```

**Repair pass.** The statement PDF's font kerning splits glyph runs, so pdf.js text
extraction yields artifacts that must be repaired before matching:

| Artifact | Repair |
|---|---|
| `Aug 1 1`, `$320.1 1` | collapse a space between two digits |
| `BAL ANCE`, `payments :` | collapse a space before a colon, and inside known labels |
| `– ` vs `-` | normalize to en-dash `–` for negatives, matching real statements |

The digit-space collapse runs **only inside date and amount captures**, never across a
whole line — `RONA LE QUINCAILLIER $44.90` must not become `RONALE…`.

**Row detection.** A line is an activity row when it matches
`^<MMM D> <MMM D> <Type> <details…> <±$amount>$`. The line immediately following a row
is folded into that row's `details` when it matches an FX sub-line
(`^<amount> <CCY> • <rate> exchange rate$`) rather than starting a new row.

**Arithmetic check.** `sum(rows) ≠ totalCharges − totalPaymentsCredits` pushes a warning.
It does not block generation — the operator decides.

### `data/ccStatementPdf.ts` — pdf.js adapter

Owns the only pdf.js import. `extractStatementText(file: File): Promise<string[][]>`
returns, per page, the lines reconstructed by grouping text items on rounded
`transform[5]` (y) with a ±3 tolerance and sorting each group by `transform[4]` (x).

**MV3 risk.** pdf.js wants a Web Worker. MV3's CSP forbids `eval` but does allow a worker
created from an extension URL, so `GlobalWorkerOptions.workerSrc` is set to
`chrome.runtime.getURL('pdf.worker.min.mjs')` with the worker file emitted by Vite as a
static asset. If that proves unworkable the fallback is the legacy build's main-thread
"fake worker" path; a 6-page statement parses fast enough that blocking the panel briefly
is acceptable. **This is the first implementation task, verified before anything else is
built.**

### `sidepanel/CustomCcStatementWorkflow.tsx` — 5 steps

Visual vocabulary is lifted from `RefundAuthLetterWorkflow.tsx`: sticky `Header` with
progress dots, `ExpandedCard` / `FutureStub` / `Summary` step chrome, `Field`,
`ErrorLine`, and the shared `primaryButton` / `secondaryButton` styles.

1. **Import statement** — file picker plus drag-and-drop, `.pdf` only. Parses in-panel;
   the file never leaves the machine. A parse failure shows the extracted raw text and
   offers "enter fields manually".
2. **Verify parse** — every header and summary field editable; a row-count badge and a
   collapsible table of parsed rows; parser warnings rendered as amber lines.
3. **Corrected address** — Atlas auto-fetch on step open, editable, with the stale
   address from the PDF shown beside the new one. Applies the template's formatting
   conventions: title-case name, city spelled out (`Oakville, Ontario`, not `ON`),
   postal with a space.
4. **Generate** — chunked bridge calls with per-chunk progress, then `addAttachment` and
   `logTicketViaBridge`. Both follow-ups are warnings, never fatal.
5. **Success** — Doc and PDF links, plus the reminder that the manual tail is still
   manual: eyeball pagination, download the PDF, upload to Atlas as document type
   "Other", send the Atlas access macro.

### Template Doc

A one-time tokenized copy of `1dS5BsRFGF4g-ktHHtdkdVvhMWrP75sx3Siw7diVPNlI`
("Brian Sinclair | Credit Card Statement March 2026"). Copying rather than rebuilding is
what preserves the logo image, the page breaks, the table column widths and the
header-row bold — none of which the Docs API sets well from scratch.

Changes made to the copy:

- Every literal value becomes a `{{TOKEN}}`, matching `RefundLetter.gs`'s
  `clientName → {{CLIENT_NAME}}` derivation. Because tokens are derived from parameter
  names, adding a field later is an extension-side change only.
- The two Activity tables collapse to **one** table holding just its header row. It
  becomes the prototype that `CustomCcStatement.gs` copies per activity page.
- The identity block that repeats on each activity page is likewise reduced to one
  prototype block (heading paragraph, name, street, city/province, postal).
- The `Penalty annual interest rate 25.99%` row stays **static template text**. The
  current statement format does not print it, but the disclosure page's footnote 3 states
  the same 25.99% figure, so it is correct and constant.

Reading this template through MCPLocker returns postal codes and phone numbers masked
(`*****`); Apps Script reads the real characters, which is why the masking workaround
that the manual flow needed disappears entirely.

### `CustomCcStatement.gs` — new bridge module

Lives in `~/projects/wocoo-gas-bridge/`, modelled on `RefundLetter.gs`, and must be
**pasted into the shared Apps Script project by hand** — every programmatic write route
to GAS source is blocked by policy. It also needs three router lines added to the main
bridge file's `doGet`. Bridge edits are additive; nothing existing is modified.

Page-block construction, per activity page:

1. Copy the prototype identity block and the prototype activity table with
   `element.copy()`, so column widths, borders and header bold come along.
2. `body.appendPageBreak()` before each block after the first.
3. Append rows with `table.appendTableRow()`, copying the header row's cell styling and
   then overwriting text, so added rows inherit the template's formatting.

`finalizeCcStatement` does `saveAndClose` before `getAs('application/pdf')` — the PDF
blob only reflects saved content.

Script properties, both optional:
`cc_statement_template_id`, `cc_statement_folder_id`.

### Quick-action swap

- `🧾 Custom CC Statement` replaces `⚖️ QC Fee Waiver` in `QuickActions`.
- `QCFeeWaiverWorkflow.tsx`, `QCFeeWaiverCard.tsx` and `data/qcFeeWaiverDetect.ts` are
  deleted along with their `SidePanel.tsx` wiring.
- `data/retentionFeeWaiverDetect.ts` keeps its QC veto. It only reads QC *signals* from
  ticket text; it does not import the deleted detector, so the veto behaviour is
  unchanged and its test stays green.
- The new button is enabled unconditionally. Unlike the QC flow it does not require
  `ticket.clientEmail`, because its inputs are a PDF and an identity ID.

## Error handling

| Failure | Behaviour |
|---|---|
| Not a PDF / pdf.js throws | Step 1 error line; file cleared; picker stays open |
| PDF has no extractable text (scanned) | "No text found — this looks like a scan"; offer manual entry |
| Parser finds 0 activity rows | Blocks Continue; shows raw text so the operator can see why |
| Parser misses a header field | Warning only; the field is editable and blank |
| Arithmetic mismatch | Amber warning on step 2; does not block |
| Atlas fetch fails | Step 3 error line; fields stay editable and empty |
| `createCcStatement` fails | Step 4 error; nothing created; retry is safe |
| `appendCcStatementRows` / `finalizeCcStatement` fails | Step 4 error **with `docUrl`**; operator finishes by hand |
| `addAttachment` or `logTicket` fails | Step 5 warning; links still shown |

## Testing

- `data/ccStatementParse.test.ts` (vitest) against a fixture captured from the
  WOCOO-28171 statement: asserts 62 rows, `newBalance === '$7,209.36'`,
  `statementBalance === '$7,209.36'`, the two FX rows carry their sub-line, the payment
  row keeps its en-dash, and every `Aug 1 1`-style artifact is repaired.
- Targeted cases: a row whose merchant name contains digits (`DOLLARAMA #1496`,
  `00103 MACS CONV. STORES`) must not be damaged by the digit-space repair.
- `npm run build` for the MV3 bundle, which is also what proves the pdf.js worker asset
  is emitted.
- Apps Script side is verified by one live run against WOCOO-28171, checked in the Docs
  UI for pagination and column widths.

## Risks

- **pdf.js under MV3 CSP** — unproven; spiked first, main-thread fallback available.
- **Statement format drift** — a future layout change breaks the parser. It fails loudly
  (0 rows, missing fields) rather than silently, and the manual-entry escape hatch keeps
  the workflow usable in the meantime.
- **Hand-pasted GAS module** — the extension ships before the bridge does, so the
  workflow's step 4 fails until the paste happens. The step-4 error surfaces the bridge
  error text verbatim so the cause is obvious.
