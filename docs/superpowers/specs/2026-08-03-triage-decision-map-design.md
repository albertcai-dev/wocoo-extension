# WOCOO Triage Decision Map — Design

**Date:** 2026-08-03
**Status:** Approved, not yet implemented
**Sheet:** https://docs.google.com/spreadsheets/d/1Uc8QcM0zA9Dvv0vVnZ-oD3ueESg1D7ZNXXpRRxFRGto/edit

## Purpose

Map every WOCOO triage procedure and subtype, and how each is handled, as a set of
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

Branch on the **raw summary and description**. The Jira issue type field is *not*
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
validations feel different in kind) is decided during procedure enumeration,
once the real list shows how many distinct investigation shapes exist.

### Layer 2 — Procedure resolution

Within an intent, narrow to procedure and subtype. The leaf specifies owner,
which Jira issue type to set, that type's required fields, whether an extension
workflow automates it, and the resolution tree.

#### Two vocabularies, not one

These are distinct and must not be conflated:

| | **procedure** | **Jira issue type** |
|---|---|---|
| what it is | the unit of triage — the thing you actually do | the tag on the ticket |
| who defines it | Albert; lives only in this artifact | Jira project config; 37 options |
| examples | Reverse Fee, Retention Fee Waiver, Interest Validation, Declined Transaction Investigation, Inquiry Removal | `Credit Card: Other`, `Credit Card: Statements`, `Interest-Related Issues` |
| role in triage | the outcome you're classifying toward | an **output** — set it so the right fields are required |

Almost no procedure maps 1:1 to an issue type. `Credit Card: Overpayment` is
the notable exception. Fee work in particular scatters across `Credit Card:
Other`, `Credit Card: Statements`, and `Interest-Related Issues` — which is
precisely why the tag is useless as a classification input.

Consequence: the Jira issue-type list is an exact enumeration of *tags*, but
enumerates *procedures* not at all. The procedure list has to be authored from
experience.

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

### Tab `Procedures` — one row per procedure × subtype

| column | purpose |
|---|---|
| `intent` | joins to `Intents` |
| `procedure` | the unit of triage, in Albert's vocabulary |
| `subtype` | e.g. `interest` vs `annual`; blank if the procedure has none |
| `must_have` | signal phrases that select this leaf |
| `rule_out` | veto phrases, each naming the sibling it belongs to instead |
| `lookup_first` | external check before deciding, and what each answer implies |
| `owner` | `CXA` or destination board (`EOC`/`DBO`/`CRED`/`FRAUD`/`PRR`/`PFO`) |
| `owner_reason` | why it moves — **required when `owner ≠ CXA`** |
| `jira_issue_type` | which of the 37 WOCOO issue types to set |
| `required_jira_fields` | **derived** from `jira_issue_type` — never hand-authored |
| `automation` | extension workflow name, or blank if manual |
| `gotchas` | short traps |
| `status` | `mapped` / `draft` / `unknown` — tracks coverage honestly |

Data validation on `owner`, `status`, and `jira_issue_type` (the last from the
37-value list).

`required_jira_fields` is generated from `jira_get_project_metadata`, which
returns each issue type's required fields. Notable: `Credit Card: Overpayment`
is the only type requiring `Account ID (W#)` (`customfield_10082`) and `Total
Reimbursement Amount` (`customfield_24151`); every other type carries the looser
optional `Account ID (W#/H#/C#)` (`customfield_14401`). This is the mechanism by
which setting the right issue type enforces the right data.

There is no `volume_90d` column. The search API returns neither a result total
nor the `issuetype` field, so per-type counts would cost ~37 queries — and since
procedures don't map to issue types, issue-type volume is only loosely
informative about which procedures matter. Prioritization comes from Albert's
judgement instead. If a real ranking is wanted later, Preset or fort_knox SQL is
the cheap route.

### Tab `Trees` — one row per procedure

| column | purpose |
|---|---|
| `procedure` | joins to `Procedures.procedure` |
| `tree_dsl` | multiline cell holding the tree (grammar below) |
| `last_reviewed` | date |

**Granularity note:** `Procedures` is per procedure × subtype; `Trees` is per
procedure. Subtypes appear inside a tree as `branch_header` nodes. So a
procedure with three subtypes has three `Procedures` rows and one `Trees` row.

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
| *(none, first line)* | `root` | the procedure |
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
its format only: they root at a procedure and leaf at triage actions. The two
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
- a `procedure` in `Trees` with no matching `Procedures` row, or vice versa
- a `jira_issue_type` value not in the 37-name list

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

1. ~~**Pull the Jira issue-type list**~~ — **done 2026-08-03.** 37 issue types
   across four families: Cash (10), Credit Card (12), Prepaid Card (6), and
   older/uncategorized (9: Trace Request, Write-offs and Rewards,
   Interest-Related Issues, Prepaid Card-related Issues, Cheque Issues, PAD/DD
   Questions, Credit Card Issues, Wires Posting, Other). This populates the
   `jira_issue_type` validation list and the derived `required_jira_fields`, but
   **does not** enumerate procedures.
2. **Enumerate procedures** — Albert brain-dumps the real units of triage;
   Claude clusters them under the six intents, flags thin spots, and asks about
   ambiguous ones. This is the step the Jira pull cannot substitute for, and it
   gates everything downstream.
3. **Create the three tabs** with headers, data validation on `owner`, `status`,
   and `jira_issue_type`, and the DSL legend as a cell note.
4. **Fill `Intents`** — six rows in one pass. Short, and it is the layer that
   kills mistriage.
5. **Build `render.mjs`** and prove it against the Reverse Fee tree above.
6. **Author trees**, highest-judgement-value first, regenerating diagrams as you
   go. `status` reports coverage honestly at any point.

Step 5 precedes bulk authoring so visual feedback arrives on tree #1 rather
than tree #20.

## Decisions deferred to evidence

- Whether `investigation` splits into distinct intents — decided during step 2,
  once the real procedure list shows how many distinct investigation shapes
  exist.
- Which procedures get trees at all. Simple ones may stay as `Procedures` rows
  with no tree; a tree is worth drawing only where branching exists.

## Known stale code, out of scope but worth fixing

`extension/src/data/credRouteDetect.ts:47-49` matches `Credit Card:
Application` and `Credit Card: Decisioning`. Neither exists in the WOCOO
project — only `Credit Card: Onboarding` does — so those two branches can never
fire. Not part of this spec's work; noted so it isn't rediscovered later.
