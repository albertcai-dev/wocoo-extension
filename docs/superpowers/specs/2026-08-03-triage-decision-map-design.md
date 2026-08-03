# WOCOO Triage Decision Map — Design

**Date:** 2026-08-03
**Status:** Approved, not yet implemented
**Sheet:** https://docs.google.com/spreadsheets/d/1Uc8QcM0zA9Dvv0vVnZ-oD3ueESg1D7ZNXXpRRxFRGto/edit

## Purpose

Map every WOCOO work type and subtype, and how each is triaged, as a set of
decision trees rendered to diagrams.

The eventual goal is grounding context for an AI next-best-action card (the
"brain"). This spec deliberately does **not** build that. It builds the human
artifact that the brain will later consume, because the taxonomy has to exist
and be correct before anything can reason over it.

### Out of scope

- The AI verdict card and any prompt serialization
- Ticket Log capture and the `resolution_note` feedback loop
- The Notion playbook and its sync to a `Playbook` sheet tab
- Ticket Knowledge Loop phases 2 and 3

These remain valid future work; see `2026-07-02-ticket-knowledge-loop-design.md`.
Nothing here contradicts that spec — this adds a new upstream source.

## The triage model

Three layers, evaluated in order.

### Layer 0 — Intake gate

Is the ticket actionable as filed? Are the identifiers present that the eventual
procedure will require?

On failure, bounce to the filing agent. The ticket stays open and re-enters
Layer 0 when they reply. This is a **gate with a back-edge, not a terminal
outcome** — "waiting on agent" is a state, and once the info arrives the ticket
proceeds down the normal path.

### Layer 1 — Intent classifier

Branch on the **raw summary and description**. The Jira work type field is *not*
an input: it is unreliable, and it exists to enforce per-type Jira field
requirements (Client Account ID `W#` for overpayments, etc.). Setting it
correctly is an **output** of triage.

Six intent clusters:

| intent | covers |
|---|---|
| `fee_relief` | make a fee go away — reversal, waiver, retention credit |
| `money_movement` | payments, transfers, overpayments, wires |
| `document_request` | letters, statements, cheques, mailed documents |
| `investigation` | disputes, declined transactions, validations |
| `access_provisioning` | wallet provisioning, card issuance, delivery |
| `info_correction` | wrong data on the account or a document |

This is the shallow, wide, high-value layer. Mistriage concentrates here because
everything inside a cluster looks alike — Reverse Fee, QC Fee Waiver and
Retention Fee Waiver are all "make a fee go away."

Whether `investigation` should split (declined transactions vs. interest
validations feel different in kind) is decided after the Jira volume pull, on
evidence rather than intuition.

### Layer 2 — Procedure resolution

Within an intent, narrow to work type and subtype. The leaf specifies owner,
which Jira work type to set, that type's required fields, whether an extension
workflow automates it, and the resolution tree.

**A leaf is a resolution procedure.** "Has a shipped extension workflow" is an
*attribute* of a procedure, not a category of leaf. Splitting automated from
manual work would encode today's tooling state and rot the moment a new
workflow ships — Reverse Fee and Interest Validation are the same kind of leaf;
one has a button.

**Moves must carry a reason.** `owner = CRED` is not a triage decision on its
own. `owner_reason` is mandatory whenever `owner ≠ CXA`, because the reason is
the reusable knowledge and different reasons may imply different required
fields.

## Sheet schema

Three tabs on the sheet linked above.

### Tab `Intents` — 6 rows

| column | purpose |
|---|---|
| `intent` | cluster key from the table above |
| `discriminating_question` | the one question that decides membership |
| `typical_asks` | 3–5 phrasings clients and agents actually use |
| `rule_out` | signals that push to a **named** sibling intent |

`rule_out` naming its sibling is what makes this layer useful; "not a fee thing"
is worthless, "fee disputed as fraud → `investigation`" is actionable.

### Tab `Procedures` — one row per work type × subtype

| column | purpose |
|---|---|
| `intent` | joins to `Intents` |
| `work_type` | exact Jira issue type name |
| `subtype` | e.g. `interest` vs `annual`; blank if the type has none |
| `must_have` | signal phrases that select this leaf |
| `rule_out` | veto phrases, each naming the sibling it belongs to instead |
| `lookup_first` | external check before deciding, and what each answer implies |
| `owner` | `CXA` or destination board (`EOC`/`DBO`/`CRED`/`FRAUD`/`PRR`/`PFO`) |
| `owner_reason` | why it moves — **required when `owner ≠ CXA`** |
| `required_jira_fields` | fields the work type demands |
| `automation` | extension workflow name, or blank if manual |
| `gotchas` | short traps |
| `volume_90d` | from the Jira pull, for prioritization |
| `status` | `mapped` / `draft` / `unknown` — tracks coverage honestly |

Data validation on `owner` and `status`.

`work_type` is the **Jira issue type name**. Confirmed at
`extension/src/api/jira.ts:1104` (`workType: f.issuetype?.name`) — work type is
not a custom field, so the project's issue-type list is an exact enumeration.

### Tab `Trees` — one row per work type

| column | purpose |
|---|---|
| `work_type` | joins to `Procedures.work_type` |
| `tree_dsl` | multiline cell holding the tree (grammar below) |
| `last_reviewed` | date |

**Granularity note:** `Procedures` is per work type × subtype; `Trees` is per
work type. Subtypes appear inside a tree as `branch_header` nodes. So a work
type with three subtypes has three `Procedures` rows and one `Trees` row.

## Tree DSL

Indentation gives parentage. A leading sigil gives node kind. `|` splits title
from subtitle. A word before `=` is the incoming edge label.

```
Reverse Fee
  # Annual fee | Confirm on i2c Current Statement
    ? Is the fee $20 or $220?
      ~ i2c → Current Statement → match fee amount
      Yes = Run ReverseFeeWorkflow | regular variant
      No  = Bounce to agent | not a known annual fee
  # Interest fee | i2c Recent Activity, paginate Next
    ? Fee found in Recent Activity?
      ~ Fall back to Current Statement if not found
      Yes = Run ReverseFeeWorkflow | interest variant
      No  = Bounce to agent | fee not located
  # Quebec annual fee | Atlas → province
    ?AND Client resides in QC?
    ?AND Cancellation or newly-eligible?
      Yes = Run QCFeeWaiverWorkflow | admin credit + REIMB
      No  = Move to EOC | outside QC waiver policy
```

| sigil | kind | notes |
|---|---|---|
| *(none, first line)* | `root` | the work type |
| `#` | `branch_header` | a subtype; subtitle names where you validate it |
| `?` | `decision` | a yes/no test |
| `?AND` | conjoined decision | two or more consecutive siblings, all must hold |
| `~` | `annotation` | how to validate the decision above it |
| `=` | `outcome` | terminal triage action; subtitle is the reason |

Outcome vocabulary is open, but reads as an action plus reason: `Run
<Workflow>`, `Move to <BOARD>`, `Reply + close`, `Bounce to agent`, `Close — no
action`.

The legend is pinned as a cell note on the `tree_dsl` header.

## Visual grammar

Matches the approved exemplar.

| kind | look |
|---|---|
| `root` | cream `#EDE9E0` pill, bold, centered |
| `branch_header` | bold label + gray subtitle, **no box** |
| `decision` | cream `#EDE9E0` rounded rect; bold on load-bearing values |
| `annotation` | dashed `#C9C5BC` border, no fill, gray text |
| `outcome` | white fill, `#D8D5CE` border, bold title + gray reason line |
| conjunction | bold `AND` between two sibling decisions |

Edges: `Yes` in `#1B7F4B`, `No` in `#C0392B`, both bold. Thin gray elbow
connectors, no arrowheads.

The exemplar that established this grammar is a **front-line agent's** tree —
rooted at a client question, leafing at "Cut WOCOO ticket." These trees borrow
its format only: they root at a work type and leaf at triage actions. The two
layers compose, since a front-line "Cut WOCOO ticket" is the entry to a tree
here.

## Renderer

A `.mjs` script — no build config, run directly with node.

**Parse.** DSL text → node tree. Indentation for parentage, sigil for kind,
pre-`=` word for edge label, `|` for title/subtitle split.

**Layout.** One column per `branch_header`, because that is what makes the
exemplar readable. Within a column nodes stack vertically. `annotation` nodes
sit flush beneath their decision with no connector. `?AND` siblings sit side by
side with the `AND` label between them. Column widths derive from measured text
so there is no manual tuning.

**Style.** All tokens in one object at the top of `style.mjs`, so the palette is
a single edit.

**Validation.** The parser fails loudly rather than rendering something
misleading. Errors on:

- an `outcome` with children
- a `decision` with no outgoing edges
- an orphaned indent level (indent jumps more than one level)
- a `?AND` group with fewer than two members
- a `work_type` in `Trees` with no matching `Procedures` row, or vice versa

## File layout

```
~/projects/wocoo-extension/docs/triage-map/
  render.mjs          parser + layout + SVG emitter
  style.mjs           style token object
  out/
    reverse-fee.svg
    overpayment.svg
    …
    index.html        contact sheet linking every tree
```

Lives in the extension repo because the brain will eventually consume the same
source. `out/` is build output — the sheet stays authoritative and diagrams are
regenerated, never hand-edited.

## Bootstrap sequence

1. **Pull the Jira issue-type list and 90-day volumes** for the WOCOO project.
   Seeds `Procedures` with one row per real work type, `status = unknown`,
   ranked by volume. **Blocked on MCPLocker OAuth** — the endpoint currently
   returns `401 authentication_required`; needs re-auth via `/mcp` after
   re-establishing the Okta session.
2. **Create the three tabs** with headers, data validation on `owner` and
   `status`, and the DSL legend as a cell note.
3. **Fill `Intents`** — six rows in one pass. Short, and it is the layer that
   kills mistriage.
4. **Build `render.mjs`** and prove it against the Reverse Fee tree above.
5. **Author trees top-down by volume**, regenerating diagrams as you go.
   `status` reports coverage honestly at any point.

Step 4 precedes bulk authoring so visual feedback arrives on tree #1 rather
than tree #20.

## Decisions deferred to evidence

- Whether `investigation` splits into distinct intents — decided after step 1,
  based on whether declined-transaction and interest-validation volumes warrant
  it.
- Which work types get trees at all. Low-volume types may stay as
  `Procedures` rows with `status = draft` and no tree; a tree is worth drawing
  only where branching exists.
