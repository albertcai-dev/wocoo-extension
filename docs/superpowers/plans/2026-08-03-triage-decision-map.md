# WOCOO Triage Decision Map Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the three-tab authoring sheet and a dependency-free SVG renderer that turns an indented tree DSL into per-procedure decision-map diagrams.

**Architecture:** The Google Sheet is the authoring surface. A committed JSON snapshot (`data/trees.json`) is refreshed from the sheet by a Claude session via MCPLocker, and `render.mjs` reads only that snapshot — so the renderer is offline, deterministic, and testable, while the sheet stays authoritative. The pipeline is four pure modules: `parse` (DSL text → node tree + validation), `text` (measurement + wrapping), `layout` (node tree → absolutely-positioned boxes and edges), `svg` (boxes → SVG string). `render.mjs` is a thin CLI wiring them together.

**Tech Stack:** Plain ESM `.mjs` on Node 24. Node's built-in test runner (`node --test`) and `node:assert/strict`. No npm dependencies, no build step, no bundler.

## Global Constraints

- **Zero new npm dependencies.** Nothing is added to `extension/package.json`. This tool lives outside the extension build entirely.
- **Node 24 built-in test runner only.** `node --test <path>`; tests use `node:test` and `node:assert/strict`.
- **All files are `.mjs` ESM.** No TypeScript, no transpilation — `docs/triage-map/` is not part of `tsc -b`.
- **Do not modify anything under `extension/`.** Including `credRouteDetect.ts`, whose dead branches are noted in the spec as explicitly out of scope.
- **No clasp.** Apps Script is not involved in this work at all.
- **Spec is authoritative:** `docs/superpowers/specs/2026-08-03-triage-decision-map-design.md`.
- **Sheet ID:** `1Uc8QcM0zA9Dvv0vVnZ-oD3ueESg1D7ZNXXpRRxFRGto`
- **Style tokens are exact:** cream `#EDE9E0`, box border `#D8D5CE`, annotation border `#C9C5BC`, edge `#B5B1A8`, Yes `#1B7F4B`, No `#C0392B`, title text `#1F2421`, subtitle text `#7A756C`.
- **`out/` is build output.** Add it to `.gitignore`; never hand-edit generated SVG.
- **Pixel-matching the reference exemplar is not the goal.** Grammar fidelity is: the six node kinds must be visually distinguishable and the routing legible. Aesthetic refinement is expected after seeing the first real diagram.

---

## File Structure

| file | responsibility |
|---|---|
| `docs/triage-map/style.mjs` | style tokens + `edgeLabelColor()`. Data only, no logic beyond the colour lookup. |
| `docs/triage-map/text.mjs` | `charWidth`, `measure`, `wrap`. Font metrics approximation; the only module that knows about glyph widths. |
| `docs/triage-map/parse.mjs` | `parseTree()`, `ParseError`. DSL text → node tree. Owns all validation. |
| `docs/triage-map/layout.mjs` | `layout()`. Node tree → `{width, height, boxes, headers, edges, conjunctions}` in absolute coords. |
| `docs/triage-map/svg.mjs` | `toSvg()`. Positioned layout → SVG string. Owns edge geometry and escaping. |
| `docs/triage-map/render.mjs` | CLI entry. Reads `data/trees.json`, writes `out/*.svg` + `out/index.html`. |
| `docs/triage-map/README.md` | how to sync from the sheet and how to render. |
| `docs/triage-map/fixtures/*.tree` | committed DSL fixtures; make tests independent of the sheet. |
| `docs/triage-map/data/trees.json` | snapshot of the `Trees` tab, refreshed via MCPLocker. |

Split by responsibility so each module is independently testable and small enough to hold in context. `parse` knows nothing about pixels; `layout` knows nothing about SVG syntax; `svg` knows nothing about the DSL.

---

## Task 1: Create and seed the three sheet tabs

This task is executed with MCPLocker tools, not code. There is no test cycle; verification is reading the sheet back.

**Files:** none — all changes are to the Google Sheet `1Uc8QcM0zA9Dvv0vVnZ-oD3ueESg1D7ZNXXpRRxFRGto`.

**Interfaces:**
- Consumes: nothing.
- Produces: the `Trees` tab whose `procedure` / `tree_dsl` columns Task 6 snapshots into `data/trees.json`.

- [ ] **Step 1: Inspect the existing sheet before touching it**

```
mcp__mcplocker__google_sheets_get_metadata
  spreadsheet_id: 1Uc8QcM0zA9Dvv0vVnZ-oD3ueESg1D7ZNXXpRRxFRGto
```

If tabs already contain content, stop and report what's there rather than overwriting. The sheet was described as newly created and near-empty, but confirm.

- [ ] **Step 2: Create the three tabs**

Use `mcp__mcplocker__google_sheets_add_tab` three times with `title` = `Intents`, `Procedures`, `Trees`.

- [ ] **Step 3: Write the `Intents` headers and six rows**

`mcp__mcplocker__google_sheets_update`, range `Intents!A1:D7`:

| intent | discriminating_question | typical_asks | rule_out |
|---|---|---|---|
| fee_relief | Is the client asking for a fee already charged to be undone, or pre-empted? | waive my annual fee; reverse this interest charge; I was charged $20; cancel and refund the fee; I'm Premium, why the fee | fee is disputed as unauthorised → investigation; client wants the fee explained but not removed → info_correction |
| money_movement | Is money in the wrong place, missing, or needing to be moved? | my payment didn't post; I overpaid my card; e-transfer failed; wire hasn't arrived; bill payment went twice | money moved due to an unauthorised transaction → investigation; client only wants a receipt or letter → document_request |
| document_request | Does resolving this mean producing or mailing a document? | send me a letter; I need a statement copy; mail me a cheque; need proof for my lender; stop payment on a cheque | the document exists but is wrong → info_correction |
| investigation | Do we need to find out what happened before we can answer? | why was my card declined; I didn't make this charge; my interest looks wrong; where did this transaction go | cause is already known and the ask is remediation → fee_relief or money_movement |
| access_provisioning | Is the client blocked from using a product or credential? | can't add to Apple Pay; card never arrived; PIN not working; need a new card; increase my limit | card works but a transaction failed → investigation |
| info_correction | Is data we hold or produced wrong and needs fixing? | statement shows the wrong amount; name spelled wrong; wrong address on file; bureau shows an inquiry I didn't make | data is right and the client disagrees with the outcome → fee_relief or investigation |

- [ ] **Step 4: Write the `Procedures` headers**

`mcp__mcplocker__google_sheets_update`, range `Procedures!A1:M1`, values in this exact order:

`intent`, `procedure`, `subtype`, `must_have`, `rule_out`, `lookup_first`, `owner`, `owner_reason`, `jira_issue_type`, `required_jira_fields`, `automation`, `gotchas`, `status`

- [ ] **Step 5: Seed `Procedures` with the two known procedures**

Six rows — five fee-relief subtypes plus Declined PPMC. All `status = draft`, because `jira_issue_type` values below are inferred and unverified.

Range `Procedures!A2:M7`:

| intent | procedure | subtype | must_have | rule_out | lookup_first | owner | owner_reason | jira_issue_type | required_jira_fields | automation | gotchas | status |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| fee_relief | CC Fee Relief | annual | annual fee; $20; $220; yearly fee | interest fee → interest; Fee Credit Offer → retention | i2c → Current Statement → match $20 or $220 | CXA | | Credit Card: Statements | | ReverseFeeWorkflow (reverse_fee) | " month" singular substring-matches " monthly" — require plural or "a/per month" | draft |
| fee_relief | CC Fee Relief | interest | interest fee; cc interest; interest charge | annual fee → annual | i2c → Recent Activity, paginate Next; fall back to Current Statement | CXA | | Interest-Related Issues | | ReverseFeeWorkflow (reverse_interest_fee) | often filed as "Credit Card: Other"; content match is what catches it | draft |
| fee_relief | CC Fee Relief | qc_cancellation | Quebec; QC; cancelled card annual fee refund | not resident in QC → annual | Atlas → province = QC | CXA | | Credit Card: Statements | | QCFeeWaiverWorkflow | | draft |
| fee_relief | CC Fee Relief | qc_newly_eligible | newly eligible; QC eligibility | | Atlas → province = QC | CXA | | Credit Card: Statements | | QCFeeWaiverWorkflow | | draft |
| fee_relief | CC Fee Relief | retention | Fee Credit Offer; retention tracker | no offer on record → annual | Retention tracker | CXA | | Credit Card: Statements | | RetentionFeeWaiverWorkflow | credit is $20 × months | draft |
| investigation | Declined Prepaid Mastercard Transaction | | declined; decline; prepaid mastercard; PPMC; NSF | credit card decline → separate procedure; client disputes the transaction → dispute | Preset 5871 CXO-KOHO NSF Declines → input identity ID | CXA | | Prepaid Card: Transactions | | | read the FIRST code in verified_decline_codes — later codes mislead; strip native_filters_key from the dashboard URL before the extension drives it | draft |

- [ ] **Step 6: Write the `Trees` tab**

Headers at `Trees!A1:C1`: `procedure`, `tree_dsl`, `last_reviewed`.

Two rows. `tree_dsl` cells are multiline — pass the newlines literally in the update value.

`Trees!A2` = `CC Fee Relief`, `Trees!B2` =

```
CC Fee Relief
  # Annual fee | i2c → Current Statement
    ? Is the posted fee $20 or $220?
      ~ Match the fee amount on the current statement
      Yes = Run ReverseFeeWorkflow (reverse_fee) | known annual fee amount
      No  = Escalate to team for further triage | unrecognised fee amount
  # Interest fee | i2c → Recent Activity, paginate Next
    ? Is the interest charge found in Recent Activity?
      ~ If not found, fall back to Current Statement and re-iterate
      Yes = Run ReverseFeeWorkflow (reverse_interest_fee) | charge located
      No  = Escalate to team for further triage | charge not located
  # Quebec annual fee | Atlas → province
    ?AND Does the client reside in Quebec?
    ?AND Is this a cancellation or newly-eligible case?
      Yes = Run QCFeeWaiverWorkflow | QC admin credit + REIMB
      No  = Escalate to team for further triage | outside QC waiver policy
  # Retention credit | Retention tracker + "Fee Credit Offer" summary
    ? Is there a Fee Credit Offer on the ticket?
      ~ Credit is $20 × months; plural "months" or "a/per month" only
      Yes = Run RetentionFeeWaiverWorkflow | offer confirmed
      No  = Escalate to team for further triage | no offer on record
```

`Trees!A3` = `Declined Prepaid Mastercard Transaction`, `Trees!B3` =

```
Declined Prepaid Mastercard Transaction
  - Open CXO-KOHO NSF Declines dashboard | Preset 5871
  - Input client's identity ID
  - Review decline transaction date + merchant
  - Read the FIRST code in verified_decline_codes | later codes mislead
  ? Verified decline code present?
    Yes = Reply with decline reason from Guru | code is the true reason
    No  = Escalate to team for further triage | no verified code on dashboard
```

Both trees together exercise all six node kinds: `root`, `branch_header`, `step`, `decision`, `?AND`, `annotation`, `outcome`.

- [ ] **Step 7: Freeze header rows**

`mcp__mcplocker__google_sheets_freeze` with `rows: 1` on each of the three tabs.

- [ ] **Step 8: Add data validation**

`mcp__mcplocker__google_sheets_set_data_validation` on `Procedures`:

- `owner` (column G, rows 2:1000) — allow-list: `CXA`, `EOC`, `DBO`, `CRED`, `FRAUD`, `PRR`, `PFO`. Set the rule to warn rather than reject, because the column may hold multiple values (Credit Limit Inc/Dec is shared between WOCOO and DBO).
- `status` (column M, rows 2:1000) — strict allow-list: `mapped`, `draft`, `unknown`.
- `jira_issue_type` (column I, rows 2:1000) — strict allow-list of all 37 WOCOO issue types: Cash: Onboarding, Cash: Interest, Cash: DD/PAD, Cash: Bill Payment, Cash: E-transfers, Cash: Cross-border/Wise, Cash: Cheques, Cash: Bank Drafts & Wires, Cash: Delinquency & Overdraft, Cash: Other, Credit Card: Onboarding, Credit Card: Transactions, Credit Card: Rewards, Credit Card: Statements, Credit Card: Physical Card, Credit Card: Digital Wallet, Credit Card: Overpayment, Credit Card: PIN Issues, Credit Card: External Funding Reports, Credit Card: Limit Increase, Credit Card: Limit Decrease, Credit Card: Other, Prepaid Card: Onboarding, Prepaid Card: Transactions, Prepaid Card: Rewards, Prepaid Card: Physical Card, Prepaid Card: Digital Wallet, Prepaid Card: Other, Trace Request, Write-offs and Rewards, Interest-Related Issues, Prepaid Card-related Issues, Cheque Issues, PAD/DD Questions, Credit Card Issues, Wires Posting, Other

- [ ] **Step 9: Pin the DSL legend as a note on the `tree_dsl` header**

Set a cell note on `Trees!B1`:

```
DSL legend — indentation (2 spaces per level) gives parentage.
  (first line)  the procedure name
  #   branch header — a subtype; text after | is where you validate it
  -   step — an ordered action taken every time
  ?   decision — a yes/no test
  ?AND  conjoined decision — 2+ consecutive siblings, all must hold
  ~   annotation — how to validate the step/decision above it
  =   outcome — terminal action; text after | is the reason
  Word before = is the edge label (Yes renders green, No renders red).
  A deeper-indented line with no sigil continues the line above it.
```

- [ ] **Step 10: Verify by reading back**

```
mcp__mcplocker__google_sheets_batch_get_values
  spreadsheet_id: 1Uc8QcM0zA9Dvv0vVnZ-oD3ueESg1D7ZNXXpRRxFRGto
  ranges: ["Intents!A1:D7", "Procedures!A1:M7", "Trees!A1:C3"]
```

Expected: 7 rows on `Intents`, 7 on `Procedures`, 3 on `Trees`, and both `tree_dsl` cells containing embedded newlines. Report the row counts.

---

## Task 2: Style tokens and text metrics

**Files:**
- Create: `docs/triage-map/style.mjs`
- Create: `docs/triage-map/text.mjs`
- Test: `docs/triage-map/text.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `style.mjs`: `export const S` (nested token object, keys as written below) and `export function edgeLabelColor(label: string|null): string`
  - `text.mjs`: `export function charWidth(ch: string, fontSize: number): number`, `export function measure(text: string, fontSize: number, bold?: boolean): number`, `export function wrap(text: string, fontSize: number, maxWidth: number, bold?: boolean): string[]`

- [ ] **Step 1: Write the failing test**

Create `docs/triage-map/text.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { measure, wrap } from './text.mjs';

test('measure grows with text length', () => {
  assert.ok(measure('ab', 14) > measure('a', 14));
});

test('measure grows with font size', () => {
  assert.ok(measure('hello', 20) > measure('hello', 14));
});

test('measure treats narrow glyphs as narrower than wide ones', () => {
  assert.ok(measure('iii', 14) < measure('mmm', 14));
});

test('wrap keeps every line within maxWidth', () => {
  const text = 'Did AUM drop below one hundred thousand dollars three days before the statement date';
  const lines = wrap(text, 14, 200);
  assert.ok(lines.length > 1, 'expected the text to wrap');
  for (const line of lines) {
    assert.ok(measure(line, 14) <= 200, `line exceeded maxWidth: ${line}`);
  }
});

test('wrap preserves hard newlines as separate lines', () => {
  const lines = wrap('first\nsecond', 14, 500);
  assert.deepEqual(lines, ['first', 'second']);
});

test('wrap does not drop a word that alone exceeds maxWidth', () => {
  const lines = wrap('short enormouslylongsingleword', 14, 40);
  assert.ok(lines.join(' ').includes('enormouslylongsingleword'));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test docs/triage-map/text.test.mjs`

Expected: FAIL — `Cannot find module` for `./text.mjs`.

- [ ] **Step 3: Write `style.mjs`**

```js
// Style tokens for triage-map diagrams. Single source of truth for the palette:
// changing the look means editing only this file.
export const S = {
  font: "Inter, -apple-system, 'Helvetica Neue', Arial, sans-serif",
  fill: {
    root: '#EDE9E0',
    decision: '#EDE9E0',
    outcome: '#FFFFFF',
    step: '#FFFFFF',
    annotation: 'none',
  },
  stroke: {
    box: '#D8D5CE',
    annotation: '#C9C5BC',
    edge: '#B5B1A8',
    none: 'none',
  },
  text: {
    title: '#1F2421',
    subtitle: '#7A756C',
    annotation: '#7A756C',
    header: '#1F2421',
    headerSub: '#7A756C',
  },
  edgeLabel: {
    yes: '#1B7F4B',
    no: '#C0392B',
    other: '#7A756C',
  },
  size: {
    title: 14,
    subtitle: 11.5,
    header: 13,
    headerSub: 11,
    edgeLabel: 11.5,
    and: 12,
  },
  box: {
    maxTextWidth: 230,
    padX: 14,
    padY: 10,
    radius: 10,
    lineHeight: 1.35,
    gapTitleSub: 4,
    stepNumberWidth: 22,
  },
  gap: {
    vertical: 34,
    column: 56,
    annotation: 8,
    conjoined: 30,
    headerToFirst: 16,
    rootToHeaders: 52,
  },
  page: { padding: 48, background: '#FFFFFF' },
};

// Yes/No edge labels are colour-coded; anything else is neutral grey.
export function edgeLabelColor(label) {
  if (!label) return S.edgeLabel.other;
  const l = label.trim().toLowerCase();
  if (l === 'yes') return S.edgeLabel.yes;
  if (l === 'no') return S.edgeLabel.no;
  return S.edgeLabel.other;
}
```

- [ ] **Step 4: Write `text.mjs`**

```js
// Font metrics approximation. There is no canvas in plain Node, so glyph widths
// are estimated from a small character-class table. Boxes carry generous padding,
// so a few percent of error is invisible.
const NARROW = new Set("iljtfrI.,;:'|!()[]{}-");
const WIDE = new Set('mwMW@%');

export function charWidth(ch, fontSize) {
  if (ch === ' ') return fontSize * 0.27;
  if (NARROW.has(ch)) return fontSize * 0.30;
  if (WIDE.has(ch)) return fontSize * 0.85;
  if (ch >= 'A' && ch <= 'Z') return fontSize * 0.63;
  if (ch >= '0' && ch <= '9') return fontSize * 0.56;
  return fontSize * 0.53;
}

export function measure(text, fontSize, bold = false) {
  let w = 0;
  for (const ch of text) w += charWidth(ch, fontSize);
  return bold ? w * 1.06 : w;
}

// Greedy word wrap. Hard newlines in the source are preserved as line breaks so
// authors can force list layout inside an annotation.
export function wrap(text, fontSize, maxWidth, bold = false) {
  const out = [];
  for (const hard of String(text).split('\n')) {
    const words = hard.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      out.push('');
      continue;
    }
    let line = words[0];
    for (let i = 1; i < words.length; i++) {
      const candidate = `${line} ${words[i]}`;
      if (measure(candidate, fontSize, bold) <= maxWidth) {
        line = candidate;
      } else {
        out.push(line);
        line = words[i];
      }
    }
    out.push(line);
  }
  return out;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test docs/triage-map/text.test.mjs`

Expected: PASS, 6 tests.

- [ ] **Step 6: Commit**

```bash
git add docs/triage-map/style.mjs docs/triage-map/text.mjs docs/triage-map/text.test.mjs
git commit -m "Add triage-map style tokens and text metrics"
```

---

## Task 3: DSL parser

**Files:**
- Create: `docs/triage-map/parse.mjs`
- Create: `docs/triage-map/fixtures/cc-fee-relief.tree`
- Create: `docs/triage-map/fixtures/declined-ppmc.tree`
- Test: `docs/triage-map/parse.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `export class ParseError extends Error` with `.errors: Array<{line: number, message: string}>`
  - `export function parseTree(text: string): Node`

  where `Node` is:
  ```js
  {
    kind: 'root'|'branch_header'|'step'|'decision'|'annotation'|'outcome',
    title: string,
    subtitle: string|null,
    edgeLabel: string|null,   // label on the edge from this node's parent
    conjoined: boolean,       // true for ?AND members
    indent: number,           // 0-based nesting level
    line: number,             // 1-based source line, for error messages
    children: Node[],
  }
  ```

- [ ] **Step 1: Write the fixture files**

Create `docs/triage-map/fixtures/cc-fee-relief.tree` with exactly the CC Fee Relief DSL from Task 1 Step 6.

Create `docs/triage-map/fixtures/declined-ppmc.tree` with exactly the Declined PPMC DSL from Task 1 Step 6.

- [ ] **Step 2: Write the failing test**

Create `docs/triage-map/parse.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseTree, ParseError } from './parse.mjs';

const fixture = (name) =>
  readFileSync(new URL(`./fixtures/${name}.tree`, import.meta.url), 'utf8');

test('root is the first line with no sigil', () => {
  const root = parseTree('My Procedure\n  - do a thing\n');
  assert.equal(root.kind, 'root');
  assert.equal(root.title, 'My Procedure');
  assert.equal(root.children.length, 1);
});

test('pipe splits title from subtitle', () => {
  const root = parseTree('P\n  - Open dashboard | Preset 5871\n');
  const step = root.children[0];
  assert.equal(step.kind, 'step');
  assert.equal(step.title, 'Open dashboard');
  assert.equal(step.subtitle, 'Preset 5871');
});

test('every sigil maps to its kind', () => {
  const root = parseTree([
    'P',
    '  # Header',
    '    ? Question?',
    '      ~ Note',
    '      Yes = Good',
    '      No = Bad',
  ].join('\n'));
  const header = root.children[0];
  assert.equal(header.kind, 'branch_header');
  const decision = header.children[0];
  assert.equal(decision.kind, 'decision');
  assert.deepEqual(decision.children.map((c) => c.kind), ['annotation', 'outcome', 'outcome']);
  assert.equal(decision.children[1].edgeLabel, 'Yes');
  assert.equal(decision.children[2].edgeLabel, 'No');
});

test('?AND marks members conjoined and is not read as a plain decision', () => {
  const root = parseTree([
    'P',
    '  ?AND First?',
    '  ?AND Second?',
    '    Yes = Fine',
  ].join('\n'));
  assert.deepEqual(root.children.map((c) => c.conjoined), [true, true]);
  assert.equal(root.children[0].kind, 'decision');
});

test('a sigil-less deeper line continues the line above it', () => {
  const root = parseTree([
    'P',
    '  ? Q?',
    '    ~ Validate by:',
    '      1. BOR',
    '      2. Net Liquidation Value',
    '    Yes = Fine',
  ].join('\n'));
  const note = root.children[0].children[0];
  assert.equal(note.kind, 'annotation');
  assert.equal(note.title, 'Validate by:\n1. BOR\n2. Net Liquidation Value');
});

test('rejects an outcome with children', () => {
  assert.throws(
    () => parseTree('P\n  ? Q?\n    Yes = Done\n      - extra\n'),
    (err) => err instanceof ParseError && /terminal/.test(err.message),
  );
});

test('rejects a decision with no outgoing branches', () => {
  assert.throws(
    () => parseTree('P\n  ? Q?\n    ~ only a note\n'),
    (err) => err instanceof ParseError && /no outgoing branches/.test(err.message),
  );
});

test('rejects a ?AND group with a single member', () => {
  assert.throws(
    () => parseTree('P\n  ?AND Alone?\n    Yes = Fine\n'),
    (err) => err instanceof ParseError && /at least 2/.test(err.message),
  );
});

test('rejects an indent jump of more than one level', () => {
  assert.throws(
    () => parseTree('P\n      - too deep\n'),
    (err) => err instanceof ParseError && /indent jumps/.test(err.message),
  );
});

test('rejects odd indentation', () => {
  assert.throws(
    () => parseTree('P\n   - three spaces\n'),
    (err) => err instanceof ParseError && /multiple of 2/.test(err.message),
  );
});

test('rejects a second root-level node', () => {
  assert.throws(
    () => parseTree('P\n  - fine\nSecond Root\n'),
    (err) => err instanceof ParseError && /only one root/.test(err.message),
  );
});

test('errors report their source line number', () => {
  try {
    parseTree('P\n  ? Q?\n    ~ note only\n');
    assert.fail('expected a ParseError');
  } catch (err) {
    assert.ok(err instanceof ParseError);
    assert.equal(err.errors[0].line, 2);
  }
});

test('parses the CC Fee Relief fixture into four branch headers', () => {
  const root = parseTree(fixture('cc-fee-relief'));
  const headers = root.children.filter((c) => c.kind === 'branch_header');
  assert.equal(headers.length, 4);
  const qc = headers[2];
  assert.deepEqual(qc.children.map((c) => c.conjoined), [true, true]);
});

test('parses the Declined PPMC fixture as four steps plus one decision', () => {
  const root = parseTree(fixture('declined-ppmc'));
  const kinds = root.children.map((c) => c.kind);
  assert.deepEqual(kinds, ['step', 'step', 'step', 'step', 'decision']);
  assert.equal(root.children[4].children.length, 2);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --test docs/triage-map/parse.test.mjs`

Expected: FAIL — `Cannot find module` for `./parse.mjs`.

- [ ] **Step 4: Write `parse.mjs`**

```js
// Parses the triage-map tree DSL into a node tree, and fails loudly rather than
// producing a misleading diagram. Indentation is 2 spaces per level.

export class ParseError extends Error {
  constructor(errors) {
    const detail = errors.map((e) => `  line ${e.line}: ${e.message}`).join('\n');
    super(`${errors.length} error(s) in tree DSL:\n${detail}`);
    this.name = 'ParseError';
    this.errors = errors;
  }
}

// Order matters: ?AND must be tried before ?, and the labelled-outcome pattern
// last so it cannot swallow another sigil's line.
const SIGILS = [
  { re: /^#\s+(.*)$/, kind: 'branch_header' },
  { re: /^-\s+(.*)$/, kind: 'step' },
  { re: /^\?AND\s+(.*)$/, kind: 'decision', conjoined: true },
  { re: /^\?\s*(.*)$/, kind: 'decision' },
  { re: /^~\s+(.*)$/, kind: 'annotation' },
  { re: /^=\s+(.*)$/, kind: 'outcome' },
  { re: /^([A-Za-z][\w-]*)\s*=\s+(.*)$/, kind: 'outcome', labelled: true },
];

function matchSigil(text) {
  for (const s of SIGILS) {
    const m = text.match(s.re);
    if (!m) continue;
    if (s.labelled) return { kind: s.kind, edgeLabel: m[1], rest: m[2], conjoined: false };
    return { kind: s.kind, edgeLabel: null, rest: m[1], conjoined: Boolean(s.conjoined) };
  }
  return null;
}

function splitTitle(raw) {
  const i = raw.indexOf('|');
  if (i === -1) return { title: raw.trim(), subtitle: null };
  return { title: raw.slice(0, i).trim(), subtitle: raw.slice(i + 1).trim() };
}

function mkNode(kind, title, subtitle, edgeLabel, conjoined, line, indent) {
  return { kind, title, subtitle, edgeLabel, conjoined, indent, line, children: [] };
}

function walk(node, fn) {
  fn(node);
  for (const c of node.children) walk(c, fn);
}

function outgoing(node) {
  return node.children.filter((c) => c.kind !== 'annotation');
}

function validate(root, errors) {
  walk(root, (node) => {
    if (node.kind === 'outcome' && node.children.length > 0) {
      errors.push({ line: node.line, message: `outcome "${node.title}" has children; outcomes are terminal` });
    }

    const kids = node.children;
    let i = 0;
    while (i < kids.length) {
      const k = kids[i];
      if (k.conjoined) {
        // Consecutive ?AND siblings form one group. Only the last member carries
        // the shared outcomes, so only the last is required to have branches.
        let j = i;
        while (j < kids.length && kids[j].conjoined) j++;
        const group = kids.slice(i, j);
        if (group.length < 2) {
          errors.push({ line: k.line, message: `?AND group has only ${group.length} member; conjoined decisions need at least 2` });
        }
        const last = group[group.length - 1];
        if (outgoing(last).length === 0) {
          errors.push({ line: last.line, message: `?AND group ending at "${last.title}" has no outgoing branches` });
        }
        i = j;
      } else {
        if (k.kind === 'decision' && outgoing(k).length === 0) {
          errors.push({ line: k.line, message: `decision "${k.title}" has no outgoing branches` });
        }
        i++;
      }
    }
  });
}

export function parseTree(text) {
  const errors = [];
  const lines = [];

  String(text).replace(/\r\n/g, '\n').split('\n').forEach((raw, idx) => {
    if (raw.trim() === '') return;
    const lead = raw.length - raw.trimStart().length;
    if (lead % 2 !== 0) {
      errors.push({ line: idx + 1, message: `indent of ${lead} spaces is not a multiple of 2` });
    }
    lines.push({ line: idx + 1, indent: Math.floor(lead / 2), text: raw.trim() });
  });

  if (lines.length === 0) throw new ParseError([{ line: 1, message: 'tree is empty' }]);

  const first = lines[0];
  if (first.indent !== 0) {
    errors.push({ line: first.line, message: 'first line must not be indented' });
  }
  if (matchSigil(first.text)) {
    errors.push({ line: first.line, message: 'first line is the procedure name and must carry no sigil' });
  }

  const t0 = splitTitle(first.text);
  const root = mkNode('root', t0.title, t0.subtitle, null, false, first.line, 0);
  const stack = [root];
  let prev = root;

  for (let i = 1; i < lines.length; i++) {
    const { line, indent, text } = lines[i];

    if (indent === 0) {
      errors.push({ line, message: `only one root is allowed; "${text}" is at indent 0` });
      continue;
    }

    const m = matchSigil(text);

    if (!m) {
      if (indent > prev.indent) {
        prev.title += `\n${text}`;
        continue;
      }
      errors.push({ line, message: `unrecognised line "${text}" — expected one of # - ? ?AND ~ = or a deeper-indented continuation` });
      continue;
    }

    if (indent > prev.indent + 1) {
      errors.push({ line, message: `indent jumps ${indent - prev.indent} levels; only one level deeper is allowed` });
    }

    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
    const parent = stack[stack.length - 1];

    const tt = splitTitle(m.rest);
    const node = mkNode(m.kind, tt.title, tt.subtitle, m.edgeLabel, m.conjoined, line, indent);
    parent.children.push(node);
    stack.push(node);
    prev = node;
  }

  validate(root, errors);
  if (errors.length > 0) throw new ParseError(errors);
  return root;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test docs/triage-map/parse.test.mjs`

Expected: PASS, 14 tests.

- [ ] **Step 6: Commit**

```bash
git add docs/triage-map/parse.mjs docs/triage-map/parse.test.mjs docs/triage-map/fixtures/
git commit -m "Add triage-map tree DSL parser with validation"
```

---

## Task 4: Layout

**Files:**
- Create: `docs/triage-map/layout.mjs`
- Test: `docs/triage-map/layout.test.mjs`

**Interfaces:**
- Consumes: `parseTree` from `./parse.mjs`; `S` from `./style.mjs`; `measure`, `wrap` from `./text.mjs`.
- Produces: `export function layout(root: Node): Diagram` where

```js
Diagram = {
  width: number,
  height: number,
  boxes: Array<{
    id: string,            // 'n1', 'n2', …
    kind: string,          // node kind
    x: number, y: number, w: number, h: number,
    titleLines: string[],
    subLines: string[],
    number: number|null,   // 1-based step number, only for kind 'step'
  }>,
  headers: Array<{ x: number, y: number, titleLines: string[], subLines: string[] }>,
  edges: Array<{ from: string, to: string, label: string|null, kind: 'straight'|'elbow' }>,
  conjunctions: Array<{ x: number, y: number, text: 'AND' }>,
}
```

All coordinates are absolute and already include page padding.

- [ ] **Step 1: Write the failing test**

Create `docs/triage-map/layout.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseTree } from './parse.mjs';
import { layout } from './layout.mjs';
import { S } from './style.mjs';

const load = (name) =>
  parseTree(readFileSync(new URL(`./fixtures/${name}.tree`, import.meta.url), 'utf8'));

test('every node except branch headers becomes a box', () => {
  const d = layout(load('declined-ppmc'));
  // root + 4 steps + 1 decision + 2 outcomes = 8
  assert.equal(d.boxes.length, 8);
  assert.equal(d.headers.length, 0);
});

test('steps are numbered in source order', () => {
  const d = layout(load('declined-ppmc'));
  const steps = d.boxes.filter((b) => b.kind === 'step');
  assert.deepEqual(steps.map((s) => s.number), [1, 2, 3, 4]);
});

test('branch headers become headers, not boxes', () => {
  const d = layout(load('cc-fee-relief'));
  assert.equal(d.headers.length, 4);
  assert.ok(!d.boxes.some((b) => b.kind === 'branch_header'));
});

test('branch headers are laid out in separate columns, left to right', () => {
  const d = layout(load('cc-fee-relief'));
  const xs = d.headers.map((h) => h.x);
  for (let i = 1; i < xs.length; i++) {
    assert.ok(xs[i] > xs[i - 1], `column ${i} should start right of column ${i - 1}`);
  }
});

test('a ?AND group is placed side by side and emits a conjunction label', () => {
  const d = layout(load('cc-fee-relief'));
  assert.equal(d.conjunctions.length, 1);
  const decisions = d.boxes.filter((b) => b.kind === 'decision');
  const sameRow = decisions.filter((b) => Math.abs(b.y - decisions[2].y) < 1);
  assert.ok(sameRow.length >= 2, 'conjoined decisions should share a y coordinate');
});

test('no two boxes overlap', () => {
  const d = layout(load('cc-fee-relief'));
  for (let i = 0; i < d.boxes.length; i++) {
    for (let j = i + 1; j < d.boxes.length; j++) {
      const a = d.boxes[i];
      const b = d.boxes[j];
      const disjoint =
        a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
      assert.ok(disjoint, `boxes ${a.id} and ${b.id} overlap`);
    }
  }
});

test('the first child of a decision gets a straight edge, later ones elbows', () => {
  const d = layout(load('declined-ppmc'));
  const decision = d.boxes.find((b) => b.kind === 'decision');
  const out = d.edges.filter((e) => e.from === decision.id);
  assert.equal(out.length, 2);
  assert.equal(out[0].kind, 'straight');
  assert.equal(out[1].kind, 'elbow');
  assert.deepEqual(out.map((e) => e.label), ['Yes', 'No']);
});

test('annotations get no incoming edge', () => {
  const d = layout(load('cc-fee-relief'));
  const annotations = d.boxes.filter((b) => b.kind === 'annotation');
  assert.ok(annotations.length > 0);
  for (const a of annotations) {
    assert.ok(!d.edges.some((e) => e.to === a.id), `annotation ${a.id} should have no edge`);
  }
});

test('diagram bounds contain every box plus page padding', () => {
  const d = layout(load('cc-fee-relief'));
  for (const b of d.boxes) {
    assert.ok(b.x >= S.page.padding - 1);
    assert.ok(b.y >= S.page.padding - 1);
    assert.ok(b.x + b.w <= d.width - S.page.padding + 1);
    assert.ok(b.y + b.h <= d.height - S.page.padding + 1);
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test docs/triage-map/layout.test.mjs`

Expected: FAIL — `Cannot find module` for `./layout.mjs`.

- [ ] **Step 3: Write `layout.mjs`**

```js
// Turns a parsed node tree into absolutely-positioned boxes and edges.
//
// Layout model, deliberately simple rather than a general graph layout:
//   * the root sits at the top left of the content area
//   * each branch_header starts a new column, left to right
//   * within a column, nodes stack vertically in source order
//   * annotations sit flush beneath their parent with no connector
//   * consecutive ?AND siblings sit side by side, sharing one y
import { S } from './style.mjs';
import { measure, wrap } from './text.mjs';

function boxFor(node, stepNumber) {
  const bold = node.kind === 'outcome' || node.kind === 'root';
  const titleFont = node.kind === 'annotation' ? S.size.subtitle : S.size.title;
  const titleLines = wrap(node.title, titleFont, S.box.maxTextWidth, bold);
  const subLines = node.subtitle ? wrap(node.subtitle, S.size.subtitle, S.box.maxTextWidth) : [];

  const widths = [
    ...titleLines.map((l) => measure(l, titleFont, bold)),
    ...subLines.map((l) => measure(l, S.size.subtitle)),
    0,
  ];
  const extra = node.kind === 'step' ? S.box.stepNumberWidth : 0;
  const w = Math.ceil(Math.max(...widths)) + S.box.padX * 2 + extra;

  let h = S.box.padY * 2 + titleLines.length * titleFont * S.box.lineHeight;
  if (subLines.length > 0) {
    h += S.box.gapTitleSub + subLines.length * S.size.subtitle * S.box.lineHeight;
  }

  return {
    kind: node.kind,
    titleLines,
    subLines,
    w,
    h: Math.ceil(h),
    number: node.kind === 'step' ? stepNumber : null,
  };
}

// Places `node` and its whole subtree with its top-left at (x, y).
// Returns { id, bottom, right }.
function placeNode(node, x, y, ctx) {
  const number = node.kind === 'step' ? ++ctx.stepCount : null;
  const box = boxFor(node, number);
  const id = `n${++ctx.uid}`;
  ctx.boxes.push({ id, ...box, x, y });

  let bottom = y + box.h;
  let right = x + box.w;

  const annotations = node.children.filter((c) => c.kind === 'annotation');
  const rest = node.children.filter((c) => c.kind !== 'annotation');

  for (const a of annotations) {
    const ab = boxFor(a, null);
    bottom += S.gap.annotation;
    ctx.boxes.push({ id: `n${++ctx.uid}`, ...ab, x, y: bottom });
    bottom += ab.h;
    right = Math.max(right, x + ab.w);
  }

  let i = 0;
  let firstEdge = true;
  while (i < rest.length) {
    const child = rest[i];

    if (child.conjoined) {
      // Group of side-by-side decisions sharing one y.
      let j = i;
      while (j < rest.length && rest[j].conjoined) j++;
      const group = rest.slice(i, j);
      const rowY = bottom + S.gap.vertical;
      let cursorX = x;
      let rowBottom = rowY;

      group.forEach((member, gi) => {
        const r = placeNode(member, cursorX, rowY, ctx);
        if (gi === 0) {
          ctx.edges.push({ from: id, to: r.id, label: member.edgeLabel, kind: firstEdge ? 'straight' : 'elbow' });
          firstEdge = false;
        } else {
          const memberBox = ctx.boxes.find((b) => b.id === r.id);
          ctx.conjunctions.push({
            x: cursorX - S.gap.conjoined / 2,
            y: rowY + memberBox.h / 2,
            text: 'AND',
          });
        }
        rowBottom = Math.max(rowBottom, r.bottom);
        right = Math.max(right, r.right);
        const placed = ctx.boxes.find((b) => b.id === r.id);
        cursorX = placed.x + placed.w + S.gap.conjoined;
      });

      bottom = rowBottom;
      i = j;
      continue;
    }

    const childY = bottom + S.gap.vertical;
    const r = placeNode(child, x, childY, ctx);
    ctx.edges.push({ from: id, to: r.id, label: child.edgeLabel, kind: firstEdge ? 'straight' : 'elbow' });
    firstEdge = false;
    bottom = r.bottom;
    right = Math.max(right, r.right);
    i++;
  }

  return { id, bottom, right };
}

export function layout(root) {
  const ctx = { boxes: [], headers: [], edges: [], conjunctions: [], uid: 0, stepCount: 0 };
  const pad = S.page.padding;

  const rootBox = boxFor(root, null);
  const rootId = `n${++ctx.uid}`;
  ctx.boxes.push({ id: rootId, ...rootBox, x: pad, y: pad });

  const headers = root.children.filter((c) => c.kind === 'branch_header');
  const direct = root.children.filter((c) => c.kind !== 'branch_header');

  let maxRight = pad + rootBox.w;
  let maxBottom = pad + rootBox.h;

  if (headers.length > 0) {
    let colX = pad;
    const headerY = pad + rootBox.h + S.gap.rootToHeaders;

    for (const h of headers) {
      const titleLines = wrap(h.title, S.size.header, S.box.maxTextWidth + 60, true);
      const subLines = h.subtitle ? wrap(h.subtitle, S.size.headerSub, S.box.maxTextWidth + 60) : [];
      const headerH =
        titleLines.length * S.size.header * S.box.lineHeight +
        (subLines.length > 0 ? 2 + subLines.length * S.size.headerSub * S.box.lineHeight : 0);

      ctx.headers.push({ x: colX, y: headerY, titleLines, subLines });

      let y = headerY + headerH + S.gap.headerToFirst;
      let colRight = colX;
      for (const child of h.children) {
        const r = placeNode(child, colX, y, ctx);
        y = r.bottom + S.gap.vertical;
        colRight = Math.max(colRight, r.right);
      }

      const titleRight = colX + Math.ceil(Math.max(
        ...titleLines.map((l) => measure(l, S.size.header, true)),
        ...subLines.map((l) => measure(l, S.size.headerSub)),
        0,
      ));
      colRight = Math.max(colRight, titleRight);

      maxRight = Math.max(maxRight, colRight);
      maxBottom = Math.max(maxBottom, y);
      colX = colRight + S.gap.column;
    }
  } else {
    // Checklist shape: steps chain vertically off the root, each linked to the
    // one before it.
    let y = pad + rootBox.h + S.gap.vertical;
    let prevId = rootId;
    for (const child of direct) {
      const r = placeNode(child, pad, y, ctx);
      ctx.edges.push({ from: prevId, to: r.id, label: child.edgeLabel, kind: 'straight' });
      prevId = r.id;
      y = r.bottom + S.gap.vertical;
      maxRight = Math.max(maxRight, r.right);
      maxBottom = Math.max(maxBottom, r.bottom);
    }
  }

  return {
    width: Math.ceil(maxRight + pad),
    height: Math.ceil(maxBottom + pad),
    boxes: ctx.boxes,
    headers: ctx.headers,
    edges: ctx.edges,
    conjunctions: ctx.conjunctions,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test docs/triage-map/layout.test.mjs`

Expected: PASS, 9 tests.

If the no-overlap test fails, the fix is to increase `S.gap.vertical` or `S.gap.column` in `style.mjs` — not to weaken the assertion. Overlapping boxes are the single most likely defect in this module.

- [ ] **Step 5: Commit**

```bash
git add docs/triage-map/layout.mjs docs/triage-map/layout.test.mjs
git commit -m "Add triage-map layout engine"
```

---

## Task 5: SVG emitter

**Files:**
- Create: `docs/triage-map/svg.mjs`
- Test: `docs/triage-map/svg.test.mjs`

**Interfaces:**
- Consumes: `layout()` output (the `Diagram` shape from Task 4); `S`, `edgeLabelColor` from `./style.mjs`.
- Produces: `export function toSvg(diagram: Diagram, title: string): string`

- [ ] **Step 1: Write the failing test**

Create `docs/triage-map/svg.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseTree } from './parse.mjs';
import { layout } from './layout.mjs';
import { toSvg } from './svg.mjs';
import { S } from './style.mjs';

const render = (name) =>
  toSvg(layout(parseTree(readFileSync(new URL(`./fixtures/${name}.tree`, import.meta.url), 'utf8'))), name);

test('emits a well-formed svg root with explicit dimensions', () => {
  const out = render('declined-ppmc');
  assert.match(out, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(out, /width="\d+" height="\d+"/);
  assert.match(out, /<\/svg>$/);
});

test('uses the cream token for decisions and white for outcomes', () => {
  const out = render('declined-ppmc');
  assert.ok(out.includes(S.fill.decision));
  assert.ok(out.includes(S.fill.outcome));
});

test('colours Yes green and No red', () => {
  const out = render('declined-ppmc');
  assert.ok(out.includes(S.edgeLabel.yes));
  assert.ok(out.includes(S.edgeLabel.no));
});

test('draws annotations with a dashed stroke and no fill', () => {
  const out = render('cc-fee-relief');
  assert.match(out, /stroke-dasharray/);
});

test('renders the AND conjunction label', () => {
  const out = render('cc-fee-relief');
  assert.ok(out.includes('>AND<'));
});

test('numbers step boxes', () => {
  const out = render('declined-ppmc');
  assert.ok(out.includes('>1.<'));
  assert.ok(out.includes('>4.<'));
});

test('escapes XML-significant characters in content', () => {
  const diagram = layout(parseTree('P & <Q>\n  - a "b" & \'c\'\n'));
  const out = toSvg(diagram, 'esc');
  assert.ok(out.includes('&amp;'));
  assert.ok(out.includes('&lt;'));
  assert.ok(!/[^&]<Q>/.test(out), 'raw angle brackets from content must not survive');
});

test('emits one path per edge', () => {
  const diagram = layout(parseTree(readFileSync(new URL('./fixtures/declined-ppmc.tree', import.meta.url), 'utf8')));
  const out = toSvg(diagram, 'ppmc');
  const paths = out.match(/<path /g) || [];
  assert.equal(paths.length, diagram.edges.length);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test docs/triage-map/svg.test.mjs`

Expected: FAIL — `Cannot find module` for `./svg.mjs`.

- [ ] **Step 3: Write `svg.mjs`**

```js
// Renders a positioned diagram to SVG. Owns edge geometry and XML escaping;
// knows nothing about the DSL.
import { S, edgeLabelColor } from './style.mjs';

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const FILL = {
  root: S.fill.root,
  decision: S.fill.decision,
  outcome: S.fill.outcome,
  step: S.fill.step,
  annotation: S.fill.annotation,
};

function strokeFor(kind) {
  if (kind === 'annotation') return { color: S.stroke.annotation, dash: ' stroke-dasharray="4 3"' };
  return { color: S.stroke.box, dash: '' };
}

function boxSvg(b) {
  const out = [];
  const { color, dash } = strokeFor(b.kind);
  out.push(
    `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="${S.box.radius}" ` +
    `fill="${FILL[b.kind] || S.fill.outcome}" stroke="${color}" stroke-width="1"${dash}/>`,
  );

  const bold = b.kind === 'outcome' || b.kind === 'root';
  const titleFont = b.kind === 'annotation' ? S.size.subtitle : S.size.title;
  const titleColor = b.kind === 'annotation' ? S.text.annotation : S.text.title;
  const indent = b.kind === 'step' ? S.box.stepNumberWidth : 0;

  let y = b.y + S.box.padY + titleFont;

  if (b.number !== null && b.number !== undefined) {
    out.push(
      `<text x="${b.x + S.box.padX}" y="${y}" font-family="${S.font}" font-size="${titleFont}" ` +
      `fill="${S.text.subtitle}">${b.number}.</text>`,
    );
  }

  for (const line of b.titleLines) {
    out.push(
      `<text x="${b.x + S.box.padX + indent}" y="${y}" font-family="${S.font}" font-size="${titleFont}" ` +
      `font-weight="${bold ? 600 : 400}" fill="${titleColor}">${esc(line)}</text>`,
    );
    y += titleFont * S.box.lineHeight;
  }

  if (b.subLines.length > 0) {
    y += S.box.gapTitleSub;
    for (const line of b.subLines) {
      out.push(
        `<text x="${b.x + S.box.padX + indent}" y="${y}" font-family="${S.font}" font-size="${S.size.subtitle}" ` +
        `fill="${S.text.subtitle}">${esc(line)}</text>`,
      );
      y += S.size.subtitle * S.box.lineHeight;
    }
  }

  return out.join('\n');
}

function headerSvg(h) {
  const out = [];
  let y = h.y + S.size.header;
  for (const line of h.titleLines) {
    out.push(
      `<text x="${h.x}" y="${y}" font-family="${S.font}" font-size="${S.size.header}" ` +
      `font-weight="700" fill="${S.text.header}">${esc(line)}</text>`,
    );
    y += S.size.header * S.box.lineHeight;
  }
  for (const line of h.subLines) {
    out.push(
      `<text x="${h.x}" y="${y}" font-family="${S.font}" font-size="${S.size.headerSub}" ` +
      `font-weight="600" fill="${S.text.headerSub}">${esc(line)}</text>`,
    );
    y += S.size.headerSub * S.box.lineHeight;
  }
  return out.join('\n');
}

// A straight edge drops vertically from a fixed inset on the parent's bottom
// edge. An elbow leaves the parent's right side, runs down a rail clear of both
// boxes, and enters the child's right side.
function edgeSvg(edge, byId) {
  const a = byId.get(edge.from);
  const b = byId.get(edge.to);
  if (!a || !b) return '';

  const stroke = `stroke="${S.stroke.edge}" stroke-width="1" fill="none"`;
  const out = [];
  let labelX;
  let labelY;

  if (edge.kind === 'straight') {
    const x = a.x + 26;
    out.push(`<path d="M ${x} ${a.y + a.h} L ${x} ${b.y}" ${stroke}/>`);
    labelX = x + 8;
    labelY = (a.y + a.h + b.y) / 2 + 4;
  } else {
    const rail = Math.max(a.x + a.w, b.x + b.w) + 20;
    const ay = a.y + a.h / 2;
    const by = b.y + b.h / 2;
    out.push(
      `<path d="M ${a.x + a.w} ${ay} L ${rail} ${ay} L ${rail} ${by} L ${b.x + b.w} ${by}" ${stroke}/>`,
    );
    labelX = rail + 6;
    labelY = (ay + by) / 2 + 4;
  }

  if (edge.label) {
    out.push(
      `<text x="${labelX}" y="${labelY}" font-family="${S.font}" font-size="${S.size.edgeLabel}" ` +
      `font-weight="700" fill="${edgeLabelColor(edge.label)}">${esc(edge.label)}</text>`,
    );
  }

  return out.join('\n');
}

export function toSvg(diagram, title) {
  const byId = new Map(diagram.boxes.map((b) => [b.id, b]));
  const parts = [];

  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${diagram.width}" height="${diagram.height}" ` +
    `viewBox="0 0 ${diagram.width} ${diagram.height}">`,
  );
  parts.push(`<title>${esc(title)}</title>`);
  parts.push(`<rect width="100%" height="100%" fill="${S.page.background}"/>`);

  for (const edge of diagram.edges) parts.push(edgeSvg(edge, byId));
  for (const h of diagram.headers) parts.push(headerSvg(h));
  for (const b of diagram.boxes) parts.push(boxSvg(b));

  for (const c of diagram.conjunctions) {
    parts.push(
      `<text x="${c.x}" y="${c.y}" text-anchor="middle" font-family="${S.font}" ` +
      `font-size="${S.size.and}" font-weight="700" fill="${S.text.title}">${c.text}</text>`,
    );
  }

  parts.push('</svg>');
  return parts.filter(Boolean).join('\n');
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test docs/triage-map/svg.test.mjs`

Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add docs/triage-map/svg.mjs docs/triage-map/svg.test.mjs
git commit -m "Add triage-map SVG emitter"
```

---

## Task 6: CLI, data snapshot, and contact sheet

**Files:**
- Create: `docs/triage-map/render.mjs`
- Create: `docs/triage-map/data/trees.json`
- Create: `docs/triage-map/README.md`
- Modify: `.gitignore` (append `docs/triage-map/out/`)
- Test: `docs/triage-map/render.test.mjs`

**Interfaces:**
- Consumes: `parseTree`, `layout`, `toSvg`.
- Produces: `export function slugify(name: string): string`, `export function renderAll(trees: Array<{procedure: string, tree_dsl: string}>): Array<{slug: string, procedure: string, svg: string}>`, `export function indexHtml(rendered: Array<{slug: string, procedure: string}>): string`. Running the file as a script writes `out/`.

**Design note:** `render.mjs` reads a committed JSON snapshot rather than calling Google directly. MCPLocker is a Claude-side tool with no Node client, so a script cannot reach the sheet. The snapshot keeps the sheet authoritative while making rendering offline, deterministic, and testable. Refreshing it is a documented Claude runbook, not code.

- [ ] **Step 1: Write the failing test**

Create `docs/triage-map/render.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugify, renderAll, indexHtml } from './render.mjs';

test('slugify lowercases and hyphenates', () => {
  assert.equal(slugify('CC Fee Relief'), 'cc-fee-relief');
  assert.equal(slugify('Declined Prepaid Mastercard Transaction'), 'declined-prepaid-mastercard-transaction');
});

test('slugify strips characters that are unsafe in filenames', () => {
  assert.equal(slugify('Cash: Bank Drafts & Wires'), 'cash-bank-drafts-wires');
});

test('renderAll produces one svg per tree', () => {
  const out = renderAll([
    { procedure: 'A', tree_dsl: 'A\n  - step one\n' },
    { procedure: 'B', tree_dsl: 'B\n  - step one\n' },
  ]);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((r) => r.slug), ['a', 'b']);
  for (const r of out) assert.match(r.svg, /^<svg /);
});

test('renderAll reports the procedure name when a tree fails to parse', () => {
  assert.throws(
    () => renderAll([{ procedure: 'Broken', tree_dsl: 'Broken\n  ? Q?\n    ~ note only\n' }]),
    /Broken/,
  );
});

test('renderAll skips rows with an empty tree_dsl', () => {
  const out = renderAll([
    { procedure: 'Empty', tree_dsl: '' },
    { procedure: 'Real', tree_dsl: 'Real\n  - step\n' },
  ]);
  assert.deepEqual(out.map((r) => r.procedure), ['Real']);
});

test('indexHtml links every rendered diagram', () => {
  const html = indexHtml([{ slug: 'a', procedure: 'A' }, { slug: 'b', procedure: 'B' }]);
  assert.ok(html.includes('a.svg'));
  assert.ok(html.includes('b.svg'));
  assert.ok(html.includes('<h2>A</h2>'));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test docs/triage-map/render.test.mjs`

Expected: FAIL — `Cannot find module` for `./render.mjs`.

- [ ] **Step 3: Write `render.mjs`**

```js
// CLI entry point: reads the committed snapshot of the sheet's Trees tab and
// writes one SVG per procedure plus an index contact sheet.
//
//   node docs/triage-map/render.mjs
//
// Refresh data/trees.json from the sheet first — see README.md.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseTree, ParseError } from './parse.mjs';
import { layout } from './layout.mjs';
import { toSvg } from './svg.mjs';

const here = dirname(fileURLToPath(import.meta.url));

export function slugify(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function renderAll(trees) {
  const out = [];
  for (const row of trees) {
    if (!row.tree_dsl || row.tree_dsl.trim() === '') continue;
    try {
      out.push({
        slug: slugify(row.procedure),
        procedure: row.procedure,
        svg: toSvg(layout(parseTree(row.tree_dsl)), row.procedure),
      });
    } catch (err) {
      if (err instanceof ParseError) {
        throw new Error(`Tree for "${row.procedure}" failed to parse:\n${err.message}`);
      }
      throw err;
    }
  }
  return out;
}

export function indexHtml(rendered) {
  const items = rendered
    .map(
      (r) => `  <section>
    <h2>${r.procedure}</h2>
    <img src="${r.slug}.svg" alt="${r.procedure} decision map">
  </section>`,
    )
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>WOCOO Triage Decision Maps</title>
<style>
  body { font-family: Inter, -apple-system, sans-serif; margin: 0; padding: 40px; background: #FAF9F7; color: #1F2421; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  p.meta { color: #7A756C; font-size: 13px; margin: 0 0 32px; }
  section { margin-bottom: 48px; }
  h2 { font-size: 16px; margin: 0 0 12px; }
  img { max-width: 100%; border: 1px solid #E5E2DC; border-radius: 8px; background: #fff; }
</style>
</head>
<body>
<h1>WOCOO Triage Decision Maps</h1>
<p class="meta">Generated from the Trees tab. Do not edit these files by hand.</p>
${items}
</body>
</html>
`;
}

function main() {
  const dataPath = join(here, 'data', 'trees.json');
  const trees = JSON.parse(readFileSync(dataPath, 'utf8'));
  const rendered = renderAll(trees);

  const outDir = join(here, 'out');
  mkdirSync(outDir, { recursive: true });
  for (const r of rendered) {
    writeFileSync(join(outDir, `${r.slug}.svg`), r.svg, 'utf8');
  }
  writeFileSync(join(outDir, 'index.html'), indexHtml(rendered), 'utf8');

  console.log(`Rendered ${rendered.length} diagram(s) to ${outDir}`);
  for (const r of rendered) console.log(`  ${r.slug}.svg  ${r.procedure}`);
}

if (process.argv[1] && process.argv[1].endsWith('render.mjs')) main();
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test docs/triage-map/render.test.mjs`

Expected: PASS, 6 tests.

- [ ] **Step 5: Create the data snapshot from the fixtures**

`data/trees.json` is the snapshot the CLI reads. Seed it from the two fixture files so the tool runs before any sheet sync:

```bash
mkdir -p docs/triage-map/data
node -e "
const { readFileSync, writeFileSync } = require('fs');
const rows = [
  { procedure: 'CC Fee Relief', tree_dsl: readFileSync('docs/triage-map/fixtures/cc-fee-relief.tree', 'utf8') },
  { procedure: 'Declined Prepaid Mastercard Transaction', tree_dsl: readFileSync('docs/triage-map/fixtures/declined-ppmc.tree', 'utf8') },
];
writeFileSync('docs/triage-map/data/trees.json', JSON.stringify(rows, null, 2) + '\n');
"
```

- [ ] **Step 6: Run the renderer and confirm output**

Run: `node docs/triage-map/render.mjs`

Expected output:

```
Rendered 2 diagram(s) to <repo>/docs/triage-map/out
  cc-fee-relief.svg  CC Fee Relief
  declined-prepaid-mastercard-transaction.svg  Declined Prepaid Mastercard Transaction
```

Then confirm both files are non-trivial:

```bash
wc -c docs/triage-map/out/*.svg
```

Expected: each SVG over 2,000 bytes.

- [ ] **Step 7: Open the contact sheet and inspect it**

```bash
open docs/triage-map/out/index.html
```

Check against the reference grammar: cream decision boxes, white outcome boxes with a bold title and grey reason line, dashed borderless annotations, green `Yes` and red `No` labels, four side-by-side columns on CC Fee Relief with an `AND` between the two Quebec decisions, and numbered steps on Declined PPMC. Report what looks wrong; tuning belongs in `style.mjs` gaps and sizes, not in the emitter.

- [ ] **Step 8: Ignore build output**

Append to `.gitignore`:

```
docs/triage-map/out/
```

- [ ] **Step 9: Write the README**

Create `docs/triage-map/README.md`:

```markdown
# Triage decision map renderer

Generates one SVG decision map per triage procedure from the DSL authored in the
[triage map sheet](https://docs.google.com/spreadsheets/d/1Uc8QcM0zA9Dvv0vVnZ-oD3ueESg1D7ZNXXpRRxFRGto/edit).

Design: `../superpowers/specs/2026-08-03-triage-decision-map-design.md`

## Render

```bash
node docs/triage-map/render.mjs
open docs/triage-map/out/index.html
```

`out/` is build output and is gitignored. Never edit the SVGs by hand.

## Sync from the sheet

`render.mjs` reads `data/trees.json`, a committed snapshot of the sheet's
`Trees` tab. MCPLocker has no Node client, so refreshing is a Claude runbook:

> Read `Trees!A2:B100` from sheet `1Uc8QcM0zA9Dvv0vVnZ-oD3ueESg1D7ZNXXpRRxFRGto`
> and rewrite `docs/triage-map/data/trees.json` as an array of
> `{ procedure, tree_dsl }`, preserving newlines inside `tree_dsl`.

Then re-run the renderer and commit both the snapshot and any style changes.

## Tests

```bash
node --test docs/triage-map/
```

## DSL

See the legend note on `Trees!B1` in the sheet, or the Tree DSL section of the
spec. Indentation is two spaces per level.

| sigil | kind |
|---|---|
| *(first line)* | the procedure name |
| `#` | branch header (a subtype) |
| `-` | step |
| `?` | decision |
| `?AND` | conjoined decision, 2+ consecutive siblings |
| `~` | annotation |
| `=` | outcome, optionally prefixed with an edge label |

The parser refuses to render an invalid tree — an outcome with children, a
decision with no branches, a one-member `?AND` group, or a bad indent all fail
loudly with line numbers.
```

- [ ] **Step 10: Run the whole suite**

Run: `node --test docs/triage-map/`

Expected: PASS, 43 tests across 5 files (text 6, parse 14, layout 9, svg 8, render 6).

- [ ] **Step 11: Commit**

```bash
git add docs/triage-map/render.mjs docs/triage-map/render.test.mjs docs/triage-map/data/trees.json docs/triage-map/README.md .gitignore
git commit -m "Add triage-map renderer CLI, data snapshot, and contact sheet"
```

---

## Self-Review

**Spec coverage:**

| spec section | task |
|---|---|
| Sheet schema — `Intents` | Task 1 Step 3 |
| Sheet schema — `Procedures` (13 columns, validation) | Task 1 Steps 4, 5, 8 |
| Sheet schema — `Trees` + granularity | Task 1 Step 6 |
| Tree DSL grammar, all six kinds + `step` | Task 3 (parser), fixtures exercise all kinds |
| Checklist-shaped procedures | Task 3 fixture `declined-ppmc`, Task 4 no-header branch |
| DSL legend pinned in the sheet | Task 1 Step 9 |
| Visual grammar / style tokens | Task 2 `style.mjs`, Task 5 emitter |
| Renderer: parse / layout / style / validation | Tasks 3, 4, 5 |
| Validation rules (5 listed in spec) | Task 3 Step 2 tests + `validate()` |
| File layout `render.mjs`, `style.mjs`, `out/`, `index.html` | Task 6 |
| Seeded content: CC Fee Relief merge, Declined PPMC | Task 1 Steps 5, 6 |
| `required_jira_fields` derived | Task 1 leaves the column blank; derivation is a follow-up, see gap below |

**Known gaps, deliberately deferred:**

1. **`required_jira_fields` is not auto-populated.** The spec says it is derived from `jira_get_project_metadata`. Task 1 leaves the column empty because the mapping is only useful once `jira_issue_type` values are verified (all six seeded rows are `status = draft`). Populating it is a one-call follow-up after Albert confirms the issue types, not a blocker for the renderer.
2. **The `Intents`/`Procedures` tabs are not consumed by any code.** Only `Trees` feeds the renderer. Cross-tab validation from the spec ("a `procedure` in `Trees` with no matching `Procedures` row") needs a `procedures.json` snapshot; deferred until the tabs have real content, since it would only ever report the two seeded rows.

**Placeholder scan:** no TBDs, no "handle errors appropriately", no "similar to Task N". All code blocks are complete and runnable.

**Type consistency:** `Node` shape from Task 3 is consumed by `layout()` in Task 4 using exactly `kind`, `title`, `subtitle`, `edgeLabel`, `conjoined`, `children`. `Diagram` shape from Task 4 is consumed by `toSvg()` in Task 5 using exactly `width`, `height`, `boxes`, `headers`, `edges`, `conjunctions`; box fields `id`, `kind`, `x`, `y`, `w`, `h`, `titleLines`, `subLines`, `number`. `renderAll` in Task 6 calls `parseTree` → `layout` → `toSvg` in that order with those signatures. `ParseError.errors` is used in Task 3's line-number test and caught by name in Task 6.
