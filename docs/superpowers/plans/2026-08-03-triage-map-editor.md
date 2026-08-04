# Triage Map Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the hosted triage-map viewer into a structural visual editor that reads and writes the `Trees` tab live.

**Architecture:** The five existing pure modules run unchanged in the browser. Two new pure modules are added — `serialize.mjs` (tree → DSL, the inverse of `parse`) and `edit.mjs` (immutable tree operations). Nodes gain a stable `uid` at parse time so the renderer can tag each box and the editor can address it. `bundle.mjs` concatenates the pure modules plus a thin browser glue file into one `app.js`, avoiding any question about how Magic serves `.mjs`.

**Tech Stack:** Plain ESM `.mjs` on Node 24, Node's built-in test runner, `structuredClone` for immutability. Browser side is vanilla JS — no framework, no build tooling beyond `bundle.mjs`. `MagicTools` for sheet I/O.

## Global Constraints

- **Zero new npm dependencies.** Nothing added to any `package.json`.
- **Node 24 built-in test runner only**, invoked with a glob: `node --test docs/triage-map/*.test.mjs`. A bare directory path fails — Node reads it as a module to execute.
- **All Node-side files are `.mjs` ESM.** `docs/triage-map/` has no `package.json`, so `.js` there would be treated as CommonJS and `export` would throw.
- **Do not modify anything under `extension/`.**
- **Layout stays derived.** No coordinate ever persists. Dragging restructures.
- **Writes use `google_sheets_batch_update_values` with `value_input_option: 'RAW'`** — never `google_sheets_update`, which exposes no such option and defaults to `USER_ENTERED`, treating the DSL's `= outcome` lines as formulas.
- **Sheet ID:** `1Uc8QcM0zA9Dvv0vVnZ-oD3ueESg1D7ZNXXpRRxFRGto`
- **Site:** `wocoo-triage-map`, owner slug `albert.cai`
- **Spec:** `docs/superpowers/specs/2026-08-03-triage-map-editor-design.md`
- **`out/` is gitignored build output.** Never hand-edit generated files.

### Deviation from the spec, deliberate

The spec says boxes carry `data-node-id="n7"`. The plan uses **`data-node-uid`** carrying a *tree-node* uid assigned at parse time, distinct from the existing per-box `id` used for edge endpoints. Reason: box `id`s are assigned during layout traversal and shift when the tree changes, so they cannot address a node across an edit. A parse-time node uid can. The two identifiers coexist — `id` for edges, `nodeUid` for editing.

---

## File Structure

| file | responsibility |
|---|---|
| `parse.mjs` *(modify)* | gains `uid` on every node, numbered depth-first after validation |
| `layout.mjs` *(modify)* | copies `node.uid` onto each box as `nodeUid` |
| `svg.mjs` *(modify)* | wraps each box in `<g data-node-uid="N">` |
| `serialize.mjs` *(new)* | `serialize(tree)`; `titleProblem(title, opts)` guards round-trip safety |
| `edit.mjs` *(new)* | immutable tree operations, uid-addressed |
| `bundle.mjs` *(new)* | concatenates pure modules + glue into `out/web/app.js` |
| `web/index.html` *(new)* | browser shell: sidebar, toolbar, canvas |
| `web/app.js.in` *(new)* | browser glue: state, rendering, drag, sheet I/O, undo |

---

## Task 1: Stable node uids through the render pipeline

**Files:**
- Modify: `docs/triage-map/parse.mjs`
- Modify: `docs/triage-map/layout.mjs`
- Modify: `docs/triage-map/svg.mjs`
- Test: `docs/triage-map/parse.test.mjs`, `docs/triage-map/layout.test.mjs`, `docs/triage-map/svg.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: every node from `parseTree` has `uid: number`, unique and depth-first sequential starting at 1. Every box from `layout()` has `nodeUid: number|null`. Every box in `toSvg()` output is wrapped in `<g data-node-uid="N">`.

- [ ] **Step 1: Write the failing tests**

Append to `docs/triage-map/parse.test.mjs`:

```js
test('assigns depth-first sequential uids starting at 1', () => {
  const root = parseTree('P\n  # H\n    ? Q?\n      Yes = Done\n');
  assert.equal(root.uid, 1);
  assert.equal(root.children[0].uid, 2);
  assert.equal(root.children[0].children[0].uid, 3);
  assert.equal(root.children[0].children[0].children[0].uid, 4);
});

test('uids are unique across a whole fixture', () => {
  const root = parseTree(fixture('cc-fee-relief'));
  const seen = new Set();
  (function walk(n) {
    assert.ok(!seen.has(n.uid), `duplicate uid ${n.uid}`);
    seen.add(n.uid);
    n.children.forEach(walk);
  })(root);
  assert.equal(seen.size, 21);
});
```

Append to `docs/triage-map/layout.test.mjs`:

```js
test('each box carries the uid of the node it came from', () => {
  const tree = load('declined-ppmc');
  const d = layout(tree);
  const treeUids = [];
  (function walk(n) { treeUids.push(n.uid); n.children.forEach(walk); })(tree);
  const boxUids = d.boxes.map((b) => b.nodeUid);
  assert.equal(boxUids.length, treeUids.length);
  assert.deepEqual([...boxUids].sort((a, b) => a - b), [...treeUids].sort((a, b) => a - b));
});
```

Append to `docs/triage-map/svg.test.mjs`:

```js
test('every box is wrapped in a g carrying its node uid', () => {
  const diagram = diagramFor('declined-ppmc');
  const out = toSvg(diagram, 'ppmc');
  const uids = [...out.matchAll(/<g data-node-uid="(\d+)">/g)].map((m) => Number(m[1]));
  assert.equal(uids.length, diagram.boxes.length);
  assert.equal(new Set(uids).size, uids.length, 'uids must be unique');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test docs/triage-map/*.test.mjs`
Expected: FAIL — uids are `undefined`, and no `<g data-node-uid=` appears.

- [ ] **Step 3: Add uid numbering to `parse.mjs`**

In `mkNode`, add `uid: 0` to the returned object:

```js
function mkNode(kind, title, subtitle, edgeLabel, conjoined, line, indent) {
  return { kind, title, subtitle, edgeLabel, conjoined, indent, line, uid: 0, children: [] };
}
```

Add this function next to `walk`:

```js
// Stable, deterministic node identity. Assigned after validation so callers can
// address a node across edits; box ids from layout shift when the tree changes.
function numberNodes(root) {
  let n = 0;
  walk(root, (node) => {
    node.uid = ++n;
  });
}
```

At the end of `parseTree`, number the nodes before returning:

```js
  validate(root, errors);
  if (errors.length > 0) throw new ParseError(errors);
  numberNodes(root);
  return root;
}
```

- [ ] **Step 4: Copy the uid onto boxes in `layout.mjs`**

In `pushBox`, add `nodeUid` to the placed object:

```js
  const placed = {
    id,
    ...box,
    x,
    y,
    anchorY: y + box.h,
    col: ctx.col,
    nodeUid: node.uid ?? null,
  };
```

- [ ] **Step 5: Wrap boxes in a `g` in `svg.mjs`**

In `boxSvg`, change the final return so the box is grouped and tagged:

```js
  const body = out.join('\n');
  if (b.nodeUid === null || b.nodeUid === undefined) return body;
  return `<g data-node-uid="${b.nodeUid}">\n${body}\n</g>`;
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test docs/triage-map/*.test.mjs`
Expected: PASS, 58 tests (54 existing + 4 new).

- [ ] **Step 7: Confirm the local pipeline still renders**

Run: `node docs/triage-map/render.mjs`
Expected: `Rendered 2 diagram(s)` and both SVGs regenerate without error.

- [ ] **Step 8: Commit**

```bash
git add docs/triage-map/parse.mjs docs/triage-map/layout.mjs docs/triage-map/svg.mjs \
        docs/triage-map/parse.test.mjs docs/triage-map/layout.test.mjs docs/triage-map/svg.test.mjs
git commit -m "Thread stable node uids from parse through to rendered SVG"
```

---

## Task 2: `serialize.mjs`

**Files:**
- Create: `docs/triage-map/serialize.mjs`
- Test: `docs/triage-map/serialize.test.mjs`

**Interfaces:**
- Consumes: `parseTree` from `./parse.mjs` (tests only).
- Produces:
  - `export function serialize(tree): string` — DSL text, newline-terminated.
  - `export function titleProblem(title, { isRoot }): string|null` — a human-readable reason the title would not survive a round trip, or `null` if safe.

- [ ] **Step 1: Write the failing test**

Create `docs/triage-map/serialize.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseTree } from './parse.mjs';
import { serialize, titleProblem } from './serialize.mjs';

const fixture = (name) =>
  readFileSync(new URL(`./fixtures/${name}.tree`, import.meta.url), 'utf8');

// uid, indent and line are source-position artifacts: uid is renumbered on every
// parse, and indent/line describe where text sat in the original document. Only
// structure and content need to survive a round trip.
function normalize(node) {
  return {
    kind: node.kind,
    title: node.title,
    subtitle: node.subtitle,
    edgeLabel: node.edgeLabel,
    conjoined: node.conjoined,
    children: node.children.map(normalize),
  };
}

for (const name of ['cc-fee-relief', 'declined-ppmc', 'declined-transaction']) {
  test(`round-trips the ${name} fixture`, () => {
    const original = parseTree(fixture(name));
    const reparsed = parseTree(serialize(original));
    assert.deepEqual(normalize(reparsed), normalize(original));
  });
}

test('emits two-space indentation per depth level', () => {
  const dsl = serialize(parseTree('P\n  # H\n    ? Q?\n      Yes = Done\n'));
  const lines = dsl.split('\n');
  assert.equal(lines[0], 'P');
  assert.equal(lines[1], '  # H');
  assert.equal(lines[2], '    ? Q?');
  assert.equal(lines[3], '      Yes = Done');
});

test('emits ?AND for conjoined decisions', () => {
  const dsl = serialize(parseTree('P\n  ?AND A?\n  ?AND B?\n    Yes = Fine\n'));
  assert.ok(dsl.includes('  ?AND A?'));
  assert.ok(dsl.includes('  ?AND B?'));
});

test('emits an unlabelled outcome with a bare =', () => {
  const dsl = serialize(parseTree('P\n  ? Q?\n    = Done\n'));
  assert.ok(dsl.includes('    = Done'));
});

test('appends a subtitle after a pipe', () => {
  const dsl = serialize(parseTree('P\n  - Open dashboard | Preset 5871\n'));
  assert.ok(dsl.includes('  - Open dashboard | Preset 5871'));
});

test('emits a multi-line title as deeper-indented continuation lines', () => {
  const src = 'P\n  ? Q?\n    ~ Validate by:\n      1. BOR\n      2. NLV\n    Yes = Fine\n';
  const dsl = serialize(parseTree(src));
  const lines = dsl.split('\n');
  assert.ok(lines.includes('    ~ Validate by:'));
  assert.ok(lines.includes('      1. BOR'));
  assert.ok(lines.includes('      2. NLV'));
});

test('keeps the subtitle on the sigil line when the title also wraps', () => {
  const tree = parseTree('P\n  ~ First | Sub\n');
  tree.children[0].title = 'First\nSecond';
  const reparsed = parseTree(serialize(tree));
  assert.equal(reparsed.children[0].title, 'First\nSecond');
  assert.equal(reparsed.children[0].subtitle, 'Sub');
});

test('titleProblem rejects a pipe in a title', () => {
  assert.match(titleProblem('has | pipe', { isRoot: false }), /pipe/);
});

test('titleProblem rejects a title line that looks like a sigil', () => {
  assert.match(titleProblem('- looks like a step', { isRoot: false }), /sigil/);
  assert.match(titleProblem('ok\n? looks like a decision', { isRoot: false }), /sigil/);
  assert.match(titleProblem('Yes = looks like an outcome', { isRoot: false }), /sigil/);
});

test('titleProblem accepts ordinary text', () => {
  assert.equal(titleProblem('Is the posted fee $20 or $220?', { isRoot: false }), null);
  assert.equal(titleProblem('CC Fee Relief', { isRoot: true }), null);
});

test('titleProblem rejects an empty title', () => {
  assert.match(titleProblem('   ', { isRoot: false }), /empty/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test docs/triage-map/serialize.test.mjs`
Expected: FAIL — `Cannot find module './serialize.mjs'`.

- [ ] **Step 3: Write `serialize.mjs`**

```js
// Tree -> DSL text. The exact inverse of parse.mjs, so that
// parse(serialize(tree)) reproduces the tree's structure and content.

const SIGIL = {
  branch_header: '#',
  step: '-',
  annotation: '~',
};

// A line that would be re-read as a sigil, breaking the round trip.
const LOOKS_LIKE_SIGIL = /^(#|-|\?|~|=)(\s|$)|^\?AND(\s|$)|^[A-Za-z][\w-]*\s*=\s/;

export function titleProblem(title, { isRoot } = {}) {
  const text = String(title ?? '');
  if (text.trim() === '') return 'title cannot be empty';
  if (text.includes('|')) return 'title cannot contain a pipe — the pipe separates title from subtitle';

  const lines = text.split('\n');
  for (const line of lines) {
    if (LOOKS_LIKE_SIGIL.test(line.trim())) {
      return `line "${line.trim()}" starts with a sigil and would be re-read as a node`;
    }
  }
  // The root's first line carries no sigil of its own, so anything sigil-shaped
  // there is doubly ambiguous. Already covered above; kept explicit for clarity.
  if (isRoot && LOOKS_LIKE_SIGIL.test(lines[0].trim())) {
    return 'the procedure name cannot start with a sigil';
  }
  return null;
}

function prefixFor(node) {
  if (node.kind === 'root') return '';
  if (node.kind === 'decision') return node.conjoined ? '?AND ' : '? ';
  if (node.kind === 'outcome') return node.edgeLabel ? `${node.edgeLabel} = ` : '= ';
  return `${SIGIL[node.kind]} `;
}

function linesFor(node, depth) {
  const pad = '  '.repeat(depth);
  const titleLines = String(node.title).split('\n');

  // The subtitle belongs on the sigil line: parse splits title from subtitle on
  // that line only, then appends continuation lines to the title.
  let head = pad + prefixFor(node) + titleLines[0];
  if (node.subtitle) head += ` | ${node.subtitle}`;

  const out = [head];
  const contPad = '  '.repeat(depth + 1);
  for (const extra of titleLines.slice(1)) out.push(contPad + extra);
  return out;
}

export function serialize(tree) {
  const lines = [];
  (function walk(node, depth) {
    lines.push(...linesFor(node, depth));
    for (const child of node.children) walk(child, depth + 1);
  })(tree, 0);
  return `${lines.join('\n')}\n`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test docs/triage-map/serialize.test.mjs`
Expected: PASS, 13 tests.

- [ ] **Step 5: Commit**

```bash
git add docs/triage-map/serialize.mjs docs/triage-map/serialize.test.mjs
git commit -m "Add triage-map DSL serializer with round-trip tests"
```

---

## Task 3: `edit.mjs`

**Files:**
- Create: `docs/triage-map/edit.mjs`
- Test: `docs/triage-map/edit.test.mjs`

**Interfaces:**
- Consumes: `titleProblem` from `./serialize.mjs`.
- Produces:
  - `export class EditError extends Error`
  - `export function locate(tree, uid): { node, parent, index } | null`
  - `export function maxUid(tree): number`
  - `export function defaultChildKind(parent): string|null` — `null` means children are refused
  - `export function setText(tree, uid, { title, subtitle }): tree`
  - `export function setKind(tree, uid, kindToken): tree` — token is one of `branch_header`, `step`, `decision`, `decision_and`, `annotation`, `outcome`
  - `export function setEdgeLabel(tree, uid, label): tree`
  - `export function addChild(tree, uid): { tree, uid }`
  - `export function addSibling(tree, uid): { tree, uid }`
  - `export function deleteNode(tree, uid): tree`
  - `export function moveNode(tree, uid, newParentUid, index = null): tree`
  - `export function reparent(tree, uid, newParentUid): tree`
  - `export function reorderSibling(tree, uid, newParentUid, index): tree`

  Every mutating function returns a **new** tree and leaves its input untouched.

- [ ] **Step 1: Write the failing test**

Create `docs/triage-map/edit.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTree } from './parse.mjs';
import { serialize } from './serialize.mjs';
import {
  EditError, locate, maxUid, defaultChildKind,
  setText, setKind, setEdgeLabel,
  addChild, addSibling, deleteNode, reparent, reorderSibling,
} from './edit.mjs';

const tree = () => parseTree([
  'P',
  '  # Alpha | src A',
  '    ? Q1?',
  '      ~ note',
  '      Yes = Win',
  '      No = Lose',
  '  # Beta',
  '    - Step one',
].join('\n'));

test('locate finds a node with its parent and index', () => {
  const t = tree();
  const found = locate(t, 3); // ? Q1?
  assert.equal(found.node.title, 'Q1?');
  assert.equal(found.parent.title, 'Alpha');
  assert.equal(found.index, 0);
});

test('locate returns null for an unknown uid', () => {
  assert.equal(locate(tree(), 999), null);
});

test('maxUid reports the highest uid present', () => {
  assert.equal(maxUid(tree()), 8);
});

test('setText does not mutate its input', () => {
  const t = tree();
  const before = serialize(t);
  setText(t, 3, { title: 'Changed?' });
  assert.equal(serialize(t), before);
});

test('setText updates title and subtitle', () => {
  const out = setText(tree(), 2, { title: 'Renamed', subtitle: 'src B' });
  assert.equal(locate(out, 2).node.title, 'Renamed');
  assert.equal(locate(out, 2).node.subtitle, 'src B');
});

test('setText rejects a title containing a pipe', () => {
  assert.throws(() => setText(tree(), 3, { title: 'a | b' }), EditError);
});

test('setText clears a subtitle when given an empty string', () => {
  const out = setText(tree(), 2, { subtitle: '' });
  assert.equal(locate(out, 2).node.subtitle, null);
});

test('setKind changes kind, and decision_and sets conjoined', () => {
  const asAnd = setKind(tree(), 3, 'decision_and');
  assert.equal(locate(asAnd, 3).node.kind, 'decision');
  assert.equal(locate(asAnd, 3).node.conjoined, true);

  const asPlain = setKind(asAnd, 3, 'decision');
  assert.equal(locate(asPlain, 3).node.conjoined, false);
});

test('setKind rejects changing the root', () => {
  assert.throws(() => setKind(tree(), 1, 'step'), EditError);
});

test('setEdgeLabel sets and clears an outcome label', () => {
  const set = setEdgeLabel(tree(), 5, 'Maybe');
  assert.equal(locate(set, 5).node.edgeLabel, 'Maybe');
  const cleared = setEdgeLabel(set, 5, '');
  assert.equal(locate(cleared, 5).node.edgeLabel, null);
});

test('setEdgeLabel rejects a non-outcome, since the DSL cannot express it', () => {
  assert.throws(() => setEdgeLabel(tree(), 3, 'Yes'), EditError);
});

test('defaultChildKind follows the parent kind', () => {
  const t = tree();
  assert.equal(defaultChildKind(locate(t, 1).node), 'branch_header');
  assert.equal(defaultChildKind(locate(t, 3).node), 'outcome');
  assert.equal(defaultChildKind(locate(t, 8).node), 'step');
  assert.equal(defaultChildKind(locate(t, 4).node), null); // annotation
  assert.equal(defaultChildKind(locate(t, 5).node), null); // outcome
});

test('defaultChildKind on an empty root gives step, matching the checklist shape', () => {
  const t = parseTree('P\n  - only a step\n');
  const emptied = deleteNode(t, 2);
  assert.equal(defaultChildKind(locate(emptied, 1).node), 'step');
});

test('defaultChildKind on a header continues its last child kind', () => {
  assert.equal(defaultChildKind(locate(tree(), 7).node), 'step');
});

test('addChild appends a node and returns its new uid', () => {
  const { tree: out, uid } = addChild(tree(), 3);
  assert.equal(uid, 9);
  const added = locate(out, 9);
  assert.equal(added.node.kind, 'outcome');
  assert.equal(added.parent.title, 'Q1?');
  assert.equal(added.parent.children.length, 4);
});

test('addChild is refused on a leaf kind', () => {
  assert.throws(() => addChild(tree(), 5), EditError);
});

test('addSibling inserts directly below with the same kind', () => {
  const { tree: out, uid } = addSibling(tree(), 8);
  const added = locate(out, uid);
  assert.equal(added.node.kind, 'step');
  assert.equal(added.index, 1);
});

test('addSibling is refused on the root', () => {
  assert.throws(() => addSibling(tree(), 1), EditError);
});

test('deleteNode removes the whole subtree', () => {
  const out = deleteNode(tree(), 3);
  assert.equal(locate(out, 3), null);
  assert.equal(locate(out, 4), null, 'annotation went with it');
  assert.equal(locate(out, 5), null, 'outcome went with it');
  assert.equal(locate(out, 2).node.children.length, 0);
});

test('deleteNode refuses the root', () => {
  assert.throws(() => deleteNode(tree(), 1), EditError);
});

test('reparent moves a node to be the last child of a new parent', () => {
  const out = reparent(tree(), 7, 2); // Beta under Alpha
  assert.equal(locate(out, 7).parent.title, 'Alpha');
  assert.equal(locate(out, 1).node.children.length, 1);
});

test('reparent refuses a descendant of the node, which would cycle', () => {
  assert.throws(() => reparent(tree(), 2, 3), EditError);
});

test('reparent refuses itself as its own parent', () => {
  assert.throws(() => reparent(tree(), 2, 2), EditError);
});

test('reparent refuses leaf kinds as the destination', () => {
  assert.throws(() => reparent(tree(), 7, 5), EditError); // onto an outcome
  assert.throws(() => reparent(tree(), 7, 4), EditError); // onto an annotation
});

test('reparent refuses to move the root', () => {
  assert.throws(() => reparent(tree(), 1, 2), EditError);
});

test('reorderSibling places a node at an explicit index', () => {
  const out = reorderSibling(tree(), 7, 1, 0); // Beta first under root
  assert.equal(locate(out, 1).node.children[0].title, 'Beta');
  assert.equal(locate(out, 1).node.children[1].title, 'Alpha');
});

test('every operation leaves a serializable, parseable tree', () => {
  const ops = [
    (t) => setText(t, 3, { title: 'Reworded?' }),
    (t) => setKind(t, 3, 'decision_and'),
    (t) => addChild(t, 3).tree,
    (t) => addSibling(t, 8).tree,
    (t) => reparent(t, 7, 2),
    (t) => reorderSibling(t, 7, 1, 0),
  ];
  for (const op of ops) {
    const out = op(tree());
    assert.doesNotThrow(() => parseTree(serialize(out)));
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test docs/triage-map/edit.test.mjs`
Expected: FAIL — `Cannot find module './edit.mjs'`.

- [ ] **Step 3: Write `edit.mjs`**

```js
// Immutable, uid-addressed tree operations. Every mutating function deep-clones
// its input and returns a new tree, so the caller's undo stack can hold plain
// references without defensive copying.
import { titleProblem } from './serialize.mjs';

const LEAF_KINDS = new Set(['annotation', 'outcome']);

export class EditError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EditError';
  }
}

export function locate(tree, uid) {
  let found = null;
  (function walk(node, parent, index) {
    if (found) return;
    if (node.uid === uid) {
      found = { node, parent, index };
      return;
    }
    node.children.forEach((child, i) => walk(child, node, i));
  })(tree, null, -1);
  return found;
}

export function maxUid(tree) {
  let max = 0;
  (function walk(node) {
    if (node.uid > max) max = node.uid;
    node.children.forEach(walk);
  })(tree);
  return max;
}

export function defaultChildKind(parent) {
  switch (parent.kind) {
    case 'root':
      return parent.children.some((c) => c.kind === 'branch_header') ? 'branch_header' : 'step';
    case 'branch_header':
      return parent.children.length === 0
        ? 'step'
        : parent.children[parent.children.length - 1].kind;
    case 'decision':
      return 'outcome';
    case 'step':
      return 'step';
    default:
      return null;
  }
}

function clone(tree) {
  return structuredClone(tree);
}

function require_(tree, uid) {
  const found = locate(tree, uid);
  if (!found) throw new EditError(`no node with uid ${uid}`);
  return found;
}

function isDescendantOrSelf(node, uid) {
  if (node.uid === uid) return true;
  return node.children.some((c) => isDescendantOrSelf(c, uid));
}

export function setText(tree, uid, { title, subtitle } = {}) {
  const out = clone(tree);
  const { node } = require_(out, uid);

  if (title !== undefined) {
    const problem = titleProblem(title, { isRoot: node.kind === 'root' });
    if (problem) throw new EditError(problem);
    node.title = title;
  }
  if (subtitle !== undefined) {
    const trimmed = String(subtitle).trim();
    node.subtitle = trimmed === '' ? null : trimmed;
  }
  return out;
}

const KIND_TOKENS = {
  branch_header: { kind: 'branch_header', conjoined: false },
  step: { kind: 'step', conjoined: false },
  decision: { kind: 'decision', conjoined: false },
  decision_and: { kind: 'decision', conjoined: true },
  annotation: { kind: 'annotation', conjoined: false },
  outcome: { kind: 'outcome', conjoined: false },
};

export function setKind(tree, uid, kindToken) {
  const spec = KIND_TOKENS[kindToken];
  if (!spec) throw new EditError(`unknown kind token "${kindToken}"`);

  const out = clone(tree);
  const { node } = require_(out, uid);
  if (node.kind === 'root') throw new EditError('the root kind cannot be changed');

  node.kind = spec.kind;
  node.conjoined = spec.conjoined;
  // Only outcomes can carry an edge label in the DSL.
  if (node.kind !== 'outcome') node.edgeLabel = null;
  return out;
}

export function setEdgeLabel(tree, uid, label) {
  const out = clone(tree);
  const { node } = require_(out, uid);
  if (node.kind !== 'outcome') {
    throw new EditError('only an outcome can carry an edge label');
  }
  const trimmed = String(label).trim();
  if (trimmed !== '' && !/^[A-Za-z][\w-]*$/.test(trimmed)) {
    throw new EditError('an edge label must be a single word of letters, digits, - or _');
  }
  node.edgeLabel = trimmed === '' ? null : trimmed;
  return out;
}

function mkNode(kind, uid) {
  return {
    kind,
    title: `New ${kind.replace('_', ' ')}`,
    subtitle: null,
    edgeLabel: kind === 'outcome' ? 'Yes' : null,
    conjoined: false,
    indent: 0,
    line: 0,
    uid,
    children: [],
  };
}

export function addChild(tree, uid) {
  const out = clone(tree);
  const { node } = require_(out, uid);
  const kind = defaultChildKind(node);
  if (!kind) throw new EditError(`a ${node.kind} cannot have children`);

  const created = mkNode(kind, maxUid(out) + 1);
  node.children.push(created);
  return { tree: out, uid: created.uid };
}

export function addSibling(tree, uid) {
  const out = clone(tree);
  const { node, parent, index } = require_(out, uid);
  if (!parent) throw new EditError('the root has no siblings');
  if (LEAF_KINDS.has(parent.kind)) throw new EditError(`a ${parent.kind} cannot have children`);

  const created = mkNode(node.kind, maxUid(out) + 1);
  created.conjoined = node.conjoined;
  parent.children.splice(index + 1, 0, created);
  return { tree: out, uid: created.uid };
}

export function deleteNode(tree, uid) {
  const out = clone(tree);
  const { parent, index } = require_(out, uid);
  if (!parent) throw new EditError('the root cannot be deleted');
  parent.children.splice(index, 1);
  return out;
}

export function moveNode(tree, uid, newParentUid, index = null) {
  const out = clone(tree);
  const moving = require_(out, uid);
  if (!moving.parent) throw new EditError('the root cannot be moved');

  const destination = require_(out, newParentUid);
  if (LEAF_KINDS.has(destination.node.kind)) {
    throw new EditError(`a ${destination.node.kind} cannot have children`);
  }
  if (isDescendantOrSelf(moving.node, newParentUid)) {
    throw new EditError('a node cannot be moved inside itself');
  }

  moving.parent.children.splice(moving.index, 1);
  const target = locate(out, newParentUid).node;
  const at = index === null ? target.children.length : Math.max(0, Math.min(index, target.children.length));
  target.children.splice(at, 0, moving.node);
  return out;
}

export function reparent(tree, uid, newParentUid) {
  return moveNode(tree, uid, newParentUid, null);
}

export function reorderSibling(tree, uid, newParentUid, index) {
  return moveNode(tree, uid, newParentUid, index);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test docs/triage-map/edit.test.mjs`
Expected: PASS, 27 tests.

- [ ] **Step 5: Run the whole suite**

Run: `node --test docs/triage-map/*.test.mjs`
Expected: PASS, 98 tests, 0 failures.

- [ ] **Step 6: Commit**

```bash
git add docs/triage-map/edit.mjs docs/triage-map/edit.test.mjs
git commit -m "Add immutable uid-addressed tree edit operations"
```

---

## Task 4: `bundle.mjs`

**Files:**
- Create: `docs/triage-map/bundle.mjs`
- Test: `docs/triage-map/bundle.test.mjs`

**Interfaces:**
- Consumes: all pure modules by file path; `web/app.js.in` when present.
- Produces:
  - `export function stripModuleSyntax(source): string`
  - `export function bundlePure(): string` — pure modules only, exposing `globalThis.TriageMap`
  - `export function bundleAll(): string` — pure modules plus the browser glue
  - Running the file writes `out/web/app.js`.

**Note:** `web/app.js.in` is created in Task 5. `bundleAll()` must tolerate its absence so this task is testable on its own.

- [ ] **Step 1: Write the failing test**

Create `docs/triage-map/bundle.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripModuleSyntax, bundlePure } from './bundle.mjs';

test('stripModuleSyntax drops import lines', () => {
  const out = stripModuleSyntax("import { S } from './style.mjs';\nconst a = 1;\n");
  assert.ok(!out.includes('import'));
  assert.ok(out.includes('const a = 1;'));
});

test('stripModuleSyntax unwraps export declarations', () => {
  const out = stripModuleSyntax('export function f() {}\nexport const c = 2;\nexport class K {}\n');
  assert.ok(out.includes('function f() {}'));
  assert.ok(out.includes('const c = 2;'));
  assert.ok(out.includes('class K {}'));
  assert.ok(!/^export /m.test(out));
});

test('stripModuleSyntax drops bare export lists', () => {
  const out = stripModuleSyntax('const a = 1;\nexport { a };\n');
  assert.ok(!out.includes('export'));
});

test('the pure bundle contains no module syntax', () => {
  const code = bundlePure();
  assert.ok(!/^\s*import\s/m.test(code), 'no import statements');
  assert.ok(!/^\s*export\s/m.test(code), 'no export statements');
});

test('the pure bundle evaluates and exposes the pipeline', () => {
  const code = bundlePure();
  const globals = {};
  new Function('globalThis', code).call(globals, globals);
  const api = globals.TriageMap;
  assert.equal(typeof api.parseTree, 'function');
  assert.equal(typeof api.serialize, 'function');
  assert.equal(typeof api.layout, 'function');
  assert.equal(typeof api.toSvg, 'function');
  assert.equal(typeof api.setText, 'function');
});

test('the bundled pipeline renders the same way as the modules do', async () => {
  const [{ parseTree }, { layout }, { toSvg }] = await Promise.all([
    import('./parse.mjs'), import('./layout.mjs'), import('./svg.mjs'),
  ]);
  const src = 'P\n  - one\n  ? Q?\n    Yes = Done\n';
  const expected = toSvg(layout(parseTree(src)), 'P');

  const globals = {};
  new Function('globalThis', bundlePure()).call(globals, globals);
  const api = globals.TriageMap;
  const actual = api.toSvg(api.layout(api.parseTree(src)), 'P');

  assert.equal(actual, expected);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test docs/triage-map/bundle.test.mjs`
Expected: FAIL — `Cannot find module './bundle.mjs'`.

- [ ] **Step 3: Write `bundle.mjs`**

```js
// Concatenates the pure modules (and the browser glue, when present) into a
// single classic script. Magic's MIME handling for .mjs is unverified, and a
// wrong Content-Type breaks ES module imports outright — one .js file sidesteps
// the question entirely.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

// Dependency order: a module may only reference ones above it.
const MODULES = [
  'style.mjs',
  'text.mjs',
  'parse.mjs',
  'serialize.mjs',
  'layout.mjs',
  'svg.mjs',
  'edit.mjs',
];

const EXPOSED = [
  'S', 'edgeLabelColor',
  'measure', 'wrap',
  'parseTree', 'ParseError',
  'serialize', 'titleProblem',
  'layout',
  'toSvg',
  'EditError', 'locate', 'maxUid', 'defaultChildKind',
  'setText', 'setKind', 'setEdgeLabel',
  'addChild', 'addSibling', 'deleteNode', 'moveNode', 'reparent', 'reorderSibling',
];

export function stripModuleSyntax(source) {
  return source
    .split('\n')
    .filter((line) => !/^\s*import\s/.test(line))
    .filter((line) => !/^\s*export\s*\{[^}]*\}\s*;?\s*$/.test(line))
    .map((line) => line.replace(/^(\s*)export\s+/, '$1'))
    .join('\n');
}

function readModule(name) {
  return stripModuleSyntax(readFileSync(join(here, name), 'utf8'));
}

function assemble(extra) {
  const parts = MODULES.map((name) => `// ---- ${name} ----\n${readModule(name)}`);
  parts.push(`globalThis.TriageMap = { ${EXPOSED.join(', ')} };`);
  if (extra) parts.push(`// ---- glue ----\n${extra}`);
  return `(function () {\n'use strict';\n${parts.join('\n')}\n})();\n`;
}

export function bundlePure() {
  return assemble(null);
}

export function bundleAll() {
  const gluePath = join(here, 'web', 'app.js.in');
  const glue = existsSync(gluePath) ? readFileSync(gluePath, 'utf8') : null;
  return assemble(glue);
}

function main() {
  const outDir = join(here, 'out', 'web');
  mkdirSync(outDir, { recursive: true });
  const code = bundleAll();
  writeFileSync(join(outDir, 'app.js'), code, 'utf8');
  console.log(`Wrote ${join(outDir, 'app.js')} (${code.length} bytes)`);
}

if (process.argv[1] && process.argv[1].endsWith('bundle.mjs')) main();
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test docs/triage-map/bundle.test.mjs`
Expected: PASS, 6 tests. The last test is the important one: the bundled pipeline must produce byte-identical SVG to the modules.

- [ ] **Step 5: Produce the bundle**

Run: `node docs/triage-map/bundle.mjs`
Expected: `Wrote .../out/web/app.js (NNNNN bytes)` with a size above 25000.

- [ ] **Step 6: Commit**

```bash
git add docs/triage-map/bundle.mjs docs/triage-map/bundle.test.mjs
git commit -m "Add bundler that flattens the pure modules into one classic script"
```

---

## Task 5: Browser shell and glue

**Files:**
- Create: `docs/triage-map/web/index.html`
- Create: `docs/triage-map/web/app.js.in`
- Modify: `.gitignore` (no change needed — `docs/triage-map/out/` already covers `out/web/`)

**Interfaces:**
- Consumes: `globalThis.TriageMap` from the bundle — specifically `parseTree`, `ParseError`, `serialize`, `layout`, `toSvg`, `locate`, `defaultChildKind`, `setText`, `setKind`, `setEdgeLabel`, `addChild`, `addSibling`, `deleteNode`, `reparent`, `reorderSibling`, `EditError`.
- Produces: the deployable pair `index.html` + `out/web/app.js`.

There is no unit test for this task by design — it is the only DOM-coupled code. Step 4 is a manual verification checklist.

- [ ] **Step 1: Write `web/index.html`**

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>WOCOO Triage Map Editor</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: Inter, -apple-system, 'Helvetica Neue', Arial, sans-serif;
         margin: 0; background: #FAF9F7; color: #1F2421; display: flex; min-height: 100vh; }
  aside { width: 258px; flex: 0 0 258px; background: #fff; border-right: 1px solid #E5E2DC;
          padding: 24px 16px; height: 100vh; overflow-y: auto; }
  h1 { font-size: 15px; margin: 0 0 2px; font-weight: 700; }
  .sub { color: #7A756C; font-size: 12px; margin: 0 0 18px; }
  .nav-item { display: flex; justify-content: space-between; align-items: center; width: 100%;
              text-align: left; border: 0; background: none; font: inherit; font-size: 13px;
              color: #1F2421; padding: 8px 10px; border-radius: 6px; cursor: pointer; margin-bottom: 2px; }
  .nav-item:hover { background: #F2F0EB; }
  .nav-item.active { background: #EDE9E0; font-weight: 600; }
  .nav-item .bad { color: #C0392B; font-size: 11px; }
  .nav-item .kill { visibility: hidden; color: #7A756C; }
  .nav-item:hover .kill { visibility: visible; }
  #newProc { margin-top: 10px; font: inherit; font-size: 12px; border: 1px dashed #D8D5CE;
             background: none; border-radius: 6px; padding: 6px 10px; cursor: pointer; width: 100%; }
  main { flex: 1; padding: 20px 28px 56px; min-width: 0; }
  .bar { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; flex-wrap: wrap; }
  .bar button, .bar select { font: inherit; font-size: 12px; border: 1px solid #E5E2DC;
                             background: #fff; border-radius: 6px; padding: 5px 10px;
                             cursor: pointer; color: #1F2421; }
  .bar button:hover { background: #F2F0EB; }
  .bar button[disabled] { opacity: .4; cursor: default; }
  .spacer { flex: 1; }
  #status { font-size: 12px; color: #7A756C; }
  #banner { display: none; margin-bottom: 12px; padding: 10px 12px; border-radius: 8px;
            font-size: 13px; border: 1px solid; }
  #banner.warn { display: block; background: #FDF6E3; border-color: #E4D9B0; color: #6B5A16; }
  #banner.err  { display: block; background: #FDEDEA; border-color: #F0C4BC; color: #8C2A1A; }
  #banner button { font: inherit; font-size: 12px; margin-left: 8px; padding: 3px 8px;
                   border-radius: 5px; border: 1px solid currentColor; background: none;
                   color: inherit; cursor: pointer; }
  .canvas { border: 1px solid #E5E2DC; border-radius: 10px; background: #fff; padding: 10px;
            overflow: auto; max-height: calc(100vh - 170px); position: relative; }
  .canvas svg { display: block; }
  .canvas g[data-node-uid] { cursor: pointer; }
  .canvas g[data-node-uid].sel > rect { stroke: #1B7F4B; stroke-width: 2; }
  .canvas g[data-node-uid].drop > rect { stroke: #1B7F4B; stroke-width: 2; stroke-dasharray: 3 2; }
  #editor { position: absolute; display: none; background: #fff; border: 1px solid #1B7F4B;
            border-radius: 8px; padding: 8px; box-shadow: 0 4px 14px rgba(0,0,0,.12); z-index: 5; }
  #editor input { display: block; font: inherit; font-size: 13px; width: 260px; margin-bottom: 6px;
                  border: 1px solid #E5E2DC; border-radius: 5px; padding: 5px 7px; }
  #editor .hint { font-size: 11px; color: #7A756C; }
</style>
</head>
<body>
<aside>
  <h1>Triage Map Editor</h1>
  <p class="sub" id="procCount">loading…</p>
  <div id="nav"></div>
  <button id="newProc">+ New procedure</button>
</aside>
<main>
  <div id="banner"></div>
  <div class="bar">
    <select id="kind" title="Node kind">
      <option value="">kind…</option>
      <option value="branch_header">#  branch header</option>
      <option value="step">-  step</option>
      <option value="decision">?  decision</option>
      <option value="decision_and">?AND  conjoined</option>
      <option value="annotation">~  annotation</option>
      <option value="outcome">=  outcome</option>
    </select>
    <button id="addChild">+ child</button>
    <button id="addSib">+ sibling</button>
    <button id="del">Delete</button>
    <button id="undo">Undo</button>
    <button id="redo">Redo</button>
    <span class="spacer"></span>
    <span id="status"></span>
  </div>
  <div class="canvas" id="canvas"><div id="editor">
    <input id="fTitle" placeholder="title">
    <input id="fSub" placeholder="subtitle (optional)">
    <input id="fLabel" placeholder="edge label (outcomes only)">
    <div class="hint">⏎ save · Esc cancel</div>
  </div></div>
</main>
<script src="app.js"></script>
</body>
</html>
```

- [ ] **Step 2: Write `web/app.js.in`**

```js
// ---------------------------------------------------------------------------
// Browser glue. The only DOM-coupled file; all logic lives in the pure modules
// exposed on globalThis.TriageMap by the bundler.
// ---------------------------------------------------------------------------
var T = globalThis.TriageMap;
var SHEET = '1Uc8QcM0zA9Dvv0vVnZ-oD3ueESg1D7ZNXXpRRxFRGto';
var SAVE_DELAY = 800;

var state = {
  rows: [],        // { rowNumber, procedure, dsl, tree, error, remote }
  active: -1,
  selected: null,  // uid
  undo: {},        // rowNumber -> { stack: [dsl], pos }
  timers: {},      // rowNumber -> timeout id
  readOnly: false,
};

var el = function (id) { return document.getElementById(id); };

// ---- MCP helper -----------------------------------------------------------
function mcp(tool, args) {
  if (!window.MagicTools) return Promise.reject(new Error('no-magictools'));
  return window.MagicTools.call(tool, args).then(function (res) {
    var part = (res.content || []).find(function (p) { return p.type === 'text'; });
    return part ? JSON.parse(part.text) : {};
  });
}

function banner(kind, html) {
  var b = el('banner');
  b.className = kind || '';
  b.innerHTML = html || '';
}

function status(text) { el('status').textContent = text || ''; }

// ---- load -----------------------------------------------------------------
function load() {
  if (!window.MagicTools) {
    state.readOnly = true;
    banner('err', 'Read-only: the MCPLocker browser extension is not available. ' +
      'Connect it at <a href="https://mcplocker.w10external.com">mcplocker.w10external.com</a>, then reload.');
    return;
  }
  status('loading…');
  return mcp('google_sheets_get', { spreadsheet_id: SHEET, range: 'Trees!A2:C100' })
    .then(function (data) {
      var values = data.values || [];
      state.rows = [];
      values.forEach(function (row, i) {
        if (!row || !row[0]) return;
        var dsl = row[1] || '';
        var entry = {
          rowNumber: i + 2, procedure: row[0], dsl: dsl,
          tree: null, error: null, remote: dsl,
        };
        try { entry.tree = T.parseTree(dsl); }
        catch (e) { entry.error = e.message; }
        state.rows.push(entry);
      });
      state.active = state.rows.length ? 0 : -1;
      renderNav();
      renderCanvas();
      status('');
    })
    .catch(function (e) {
      banner('err', 'Could not read the sheet: ' + e.message);
      status('');
    });
}

// ---- sidebar --------------------------------------------------------------
function renderNav() {
  var n = state.rows.length;
  el('procCount').textContent = n + (n === 1 ? ' procedure' : ' procedures');
  var nav = el('nav');
  nav.innerHTML = '';
  state.rows.forEach(function (row, i) {
    var b = document.createElement('button');
    b.className = 'nav-item' + (i === state.active ? ' active' : '');
    var name = document.createElement('span');
    name.textContent = row.procedure;
    b.appendChild(name);
    if (row.error) {
      var bad = document.createElement('span');
      bad.className = 'bad';
      bad.textContent = 'invalid';
      b.appendChild(bad);
    } else {
      var kill = document.createElement('span');
      kill.className = 'kill';
      kill.textContent = '⌫';
      kill.onclick = function (ev) { ev.stopPropagation(); deleteProcedure(i); };
      b.appendChild(kill);
    }
    b.onclick = function () { state.active = i; state.selected = null; renderNav(); renderCanvas(); };
    nav.appendChild(b);
  });
}

// ---- canvas ---------------------------------------------------------------
function current() { return state.active < 0 ? null : state.rows[state.active]; }

function renderCanvas() {
  var row = current();
  var canvas = el('canvas');
  Array.prototype.slice.call(canvas.querySelectorAll('svg,.msg')).forEach(function (n) { n.remove(); });
  hideEditor();
  if (!row) return;

  if (row.error) {
    var p = document.createElement('div');
    p.className = 'msg';
    p.style.padding = '12px';
    p.style.color = '#8C2A1A';
    p.style.whiteSpace = 'pre-wrap';
    p.textContent = 'This tree does not parse, so it cannot be edited here:\n\n' + row.error;
    canvas.appendChild(p);
    return;
  }

  var diagram = T.layout(row.tree);
  var holder = document.createElement('div');
  holder.innerHTML = T.toSvg(diagram, row.procedure);
  var svg = holder.firstElementChild;
  canvas.appendChild(svg);

  Array.prototype.forEach.call(svg.querySelectorAll('g[data-node-uid]'), function (g) {
    var uid = Number(g.getAttribute('data-node-uid'));
    if (uid === state.selected) g.classList.add('sel');
    g.addEventListener('click', function (ev) {
      ev.stopPropagation();
      state.selected = uid;
      renderCanvas();
    });
    g.addEventListener('dblclick', function (ev) {
      ev.stopPropagation();
      state.selected = uid;
      showEditor(uid, g);
    });
    g.addEventListener('pointerdown', function (ev) { beginDrag(ev, uid, svg); });
  });

  validateCurrent();
  syncToolbar();
}

function validateCurrent() {
  var row = current();
  if (!row || !row.tree) return;
  try {
    T.parseTree(T.serialize(row.tree));
    if (!/changed in the sheet/.test(el('banner').innerHTML)) banner('', '');
  } catch (e) {
    banner('warn', '<strong>This tree is currently invalid.</strong> It is still being saved, ' +
      'but <code>render.mjs</code> will refuse it until fixed.<br>' + e.message.replace(/\n/g, '<br>'));
  }
}

function syncToolbar() {
  var row = current();
  var has = !!(row && row.tree && state.selected);
  ['kind', 'addChild', 'addSib', 'del'].forEach(function (id) {
    el(id).disabled = state.readOnly || !has;
  });
  var u = row ? state.undo[row.rowNumber] : null;
  el('undo').disabled = !u || u.pos <= 0;
  el('redo').disabled = !u || u.pos >= u.stack.length - 1;
  if (has) {
    var found = T.locate(row.tree, state.selected);
    if (found) {
      el('kind').value = found.node.kind === 'decision' && found.node.conjoined
        ? 'decision_and' : found.node.kind;
    }
  } else {
    el('kind').value = '';
  }
}

// ---- edits ----------------------------------------------------------------
function applyEdit(fn) {
  var row = current();
  if (!row || !row.tree || state.readOnly) return;
  var next;
  try { next = fn(row.tree); }
  catch (e) {
    banner('err', e.name === 'EditError' ? e.message : 'Edit failed: ' + e.message);
    return;
  }
  banner('', '');
  row.tree = next;
  row.dsl = T.serialize(next);
  pushUndo(row);
  renderCanvas();
  scheduleSave(row);
}

function pushUndo(row) {
  var u = state.undo[row.rowNumber];
  if (!u) {
    u = { stack: [], pos: -1 };
    state.undo[row.rowNumber] = u;
  }
  u.stack = u.stack.slice(0, u.pos + 1);
  u.stack.push(row.dsl);
  if (u.stack.length > 50) u.stack.shift();
  u.pos = u.stack.length - 1;
}

function timeTravel(delta) {
  var row = current();
  if (!row) return;
  var u = state.undo[row.rowNumber];
  if (!u) return;
  var pos = u.pos + delta;
  if (pos < 0 || pos >= u.stack.length) return;
  u.pos = pos;
  row.dsl = u.stack[pos];
  try { row.tree = T.parseTree(row.dsl); row.error = null; }
  catch (e) { row.error = e.message; }
  renderCanvas();
  scheduleSave(row);
}

// ---- save -----------------------------------------------------------------
function scheduleSave(row) {
  if (state.readOnly) return;
  status('unsaved…');
  clearTimeout(state.timers[row.rowNumber]);
  state.timers[row.rowNumber] = setTimeout(function () { saveNow(row); }, SAVE_DELAY);
}

function saveNow(row) {
  status('saving…');
  return mcp('google_sheets_get', { spreadsheet_id: SHEET, range: 'Trees!B' + row.rowNumber })
    .then(function (data) {
      var remote = (data.values && data.values[0] && data.values[0][0]) || '';
      if (remote !== row.remote) {
        status('');
        banner('warn', '<strong>' + row.procedure + ' changed in the sheet</strong> since you ' +
          'loaded it. Saving now would overwrite that change.' +
          '<button id="ovr">Overwrite</button><button id="rel">Reload from sheet</button>');
        el('ovr').onclick = function () { row.remote = remote; banner('', ''); saveNow(row); };
        el('rel').onclick = function () { banner('', ''); load(); };
        return null;
      }
      var today = new Date().toISOString().slice(0, 10);
      return mcp('google_sheets_batch_update_values', {
        spreadsheet_id: SHEET,
        value_input_option: 'RAW',
        data: [
          { range: 'Trees!B' + row.rowNumber, values: [[row.dsl]] },
          { range: 'Trees!C' + row.rowNumber, values: [[today]] },
        ],
      }).then(function () {
        row.remote = row.dsl;
        status('saved');
        setTimeout(function () { if (el('status').textContent === 'saved') status(''); }, 1500);
      });
    })
    .catch(function (e) {
      status('');
      banner('err', 'Save failed: ' + e.message);
    });
}

// ---- inline text editor ---------------------------------------------------
var editingUid = null;

function showEditor(uid, g) {
  var row = current();
  var found = T.locate(row.tree, uid);
  if (!found || state.readOnly) return;
  editingUid = uid;
  var box = g.querySelector('rect');
  var ed = el('editor');
  ed.style.display = 'block';
  ed.style.left = (Number(box.getAttribute('x')) + 6) + 'px';
  ed.style.top = (Number(box.getAttribute('y')) + 6) + 'px';
  el('fTitle').value = found.node.title;
  el('fSub').value = found.node.subtitle || '';
  el('fLabel').value = found.node.edgeLabel || '';
  el('fLabel').style.display = found.node.kind === 'outcome' ? 'block' : 'none';
  el('fTitle').focus();
  el('fTitle').select();
}

function hideEditor() { editingUid = null; el('editor').style.display = 'none'; }

function commitEditor() {
  if (editingUid === null) return;
  var uid = editingUid;
  var title = el('fTitle').value;
  var sub = el('fSub').value;
  var label = el('fLabel').value;
  var wasOutcome = el('fLabel').style.display !== 'none';
  hideEditor();
  applyEdit(function (tree) {
    var next = T.setText(tree, uid, { title: title, subtitle: sub });
    if (wasOutcome) next = T.setEdgeLabel(next, uid, label);
    return next;
  });
}

// ---- drag -----------------------------------------------------------------
var drag = null;

function beginDrag(ev, uid, svg) {
  if (state.readOnly || ev.button !== 0) return;
  var row = current();
  var found = T.locate(row.tree, uid);
  if (!found || !found.parent) return; // root is not draggable
  drag = { uid: uid, svg: svg, startX: ev.clientX, startY: ev.clientY, active: false, target: null };
  ev.preventDefault();
}

document.addEventListener('pointermove', function (ev) {
  if (!drag) return;
  if (!drag.active) {
    if (Math.abs(ev.clientX - drag.startX) + Math.abs(ev.clientY - drag.startY) < 5) return;
    drag.active = true;
  }
  clearDropMarks();
  var g = groupUnder(ev, drag.svg);
  drag.target = null;
  if (!g) return;
  var uid = Number(g.getAttribute('data-node-uid'));
  if (uid === drag.uid) return;
  var rect = g.querySelector('rect').getBoundingClientRect();
  var edge = (ev.clientY - rect.top) / rect.height;
  drag.target = { uid: uid, mode: edge < 0.25 || edge > 0.75 ? 'between' : 'onto' };
  g.classList.add('drop');
});

document.addEventListener('pointerup', function () {
  if (!drag) return;
  var d = drag;
  drag = null;
  clearDropMarks();
  if (!d.active || !d.target) return;

  var row = current();
  var uid = d.uid;
  var target = d.target;
  applyEdit(function (tree) {
    if (target.mode === 'onto') return T.reparent(tree, uid, target.uid);
    var found = T.locate(tree, target.uid);
    if (!found.parent) return T.reparent(tree, uid, target.uid);
    return T.reorderSibling(tree, uid, found.parent.uid, found.index + 1);
  });
});

function groupUnder(ev, svg) {
  var stack = document.elementsFromPoint(ev.clientX, ev.clientY);
  for (var i = 0; i < stack.length; i++) {
    var g = stack[i].closest ? stack[i].closest('g[data-node-uid]') : null;
    if (g && svg.contains(g)) return g;
  }
  return null;
}

function clearDropMarks() {
  Array.prototype.forEach.call(document.querySelectorAll('g.drop'), function (g) {
    g.classList.remove('drop');
  });
}

// ---- procedure lifecycle --------------------------------------------------
function newProcedure() {
  if (state.readOnly) return;
  var name = window.prompt('Procedure name');
  if (!name) return;
  name = name.trim();
  if (!name) return;
  if (T.titleProblem(name, { isRoot: true })) {
    banner('err', 'That name cannot be a procedure name: ' + T.titleProblem(name, { isRoot: true }));
    return;
  }
  var rowNumber = state.rows.reduce(function (m, r) { return Math.max(m, r.rowNumber); }, 1) + 1;
  var today = new Date().toISOString().slice(0, 10);
  status('creating…');
  mcp('google_sheets_batch_update_values', {
    spreadsheet_id: SHEET,
    value_input_option: 'RAW',
    data: [{ range: 'Trees!A' + rowNumber + ':C' + rowNumber, values: [[name, name + '\n', today]] }],
  }).then(function () { return load(); })
    .then(function () {
      var idx = state.rows.findIndex(function (r) { return r.procedure === name; });
      if (idx >= 0) { state.active = idx; renderNav(); renderCanvas(); }
    })
    .catch(function (e) { status(''); banner('err', 'Could not create: ' + e.message); });
}

function deleteProcedure(index) {
  var row = state.rows[index];
  if (state.readOnly) return;
  var typed = window.prompt('Type the procedure name to delete it from the sheet:\n' + row.procedure);
  if (typed !== row.procedure) return;
  status('deleting…');
  mcp('google_sheets_batch_update_values', {
    spreadsheet_id: SHEET,
    value_input_option: 'RAW',
    data: [{ range: 'Trees!A' + row.rowNumber + ':C' + row.rowNumber, values: [['', '', '']] }],
  }).then(function () { return load(); })
    .catch(function (e) { status(''); banner('err', 'Could not delete: ' + e.message); });
}

// ---- wiring ---------------------------------------------------------------
el('addChild').onclick = function () {
  var uid = state.selected;
  applyEdit(function (tree) { return T.addChild(tree, uid).tree; });
};
el('addSib').onclick = function () {
  var uid = state.selected;
  applyEdit(function (tree) { return T.addSibling(tree, uid).tree; });
};
el('del').onclick = function () {
  var row = current();
  var uid = state.selected;
  var found = row && row.tree ? T.locate(row.tree, uid) : null;
  if (!found) return;
  if (found.node.children.length && !window.confirm('Delete this node and its ' +
      found.node.children.length + ' child node(s)?')) return;
  state.selected = null;
  applyEdit(function (tree) { return T.deleteNode(tree, uid); });
};
el('kind').onchange = function () {
  var token = el('kind').value;
  var uid = state.selected;
  if (!token) return;
  applyEdit(function (tree) { return T.setKind(tree, uid, token); });
};
el('undo').onclick = function () { timeTravel(-1); };
el('redo').onclick = function () { timeTravel(1); };
el('newProc').onclick = newProcedure;

el('editor').addEventListener('keydown', function (ev) {
  if (ev.key === 'Enter') { ev.preventDefault(); commitEditor(); }
  if (ev.key === 'Escape') { ev.preventDefault(); hideEditor(); }
});

document.addEventListener('keydown', function (ev) {
  if (editingUid !== null) return;
  var meta = ev.metaKey || ev.ctrlKey;
  if (meta && ev.key.toLowerCase() === 'z') {
    ev.preventDefault();
    timeTravel(ev.shiftKey ? 1 : -1);
    return;
  }
  if (!state.selected) return;
  if (ev.key === 'Enter') { ev.preventDefault(); el(ev.shiftKey ? 'addSib' : 'addChild').click(); }
  if (ev.key === 'Delete' || ev.key === 'Backspace') { ev.preventDefault(); el('del').click(); }
});

el('canvas').addEventListener('click', function () { state.selected = null; renderCanvas(); });

load();
```

- [ ] **Step 3: Build the bundle and open it locally**

```bash
node docs/triage-map/bundle.mjs
cp docs/triage-map/web/index.html docs/triage-map/out/web/index.html
open docs/triage-map/out/web/index.html
```

Expected: the page loads and shows the read-only banner — `window.MagicTools` is injected only on Magic sites, so a `file://` page cannot reach the sheet. That banner appearing *is* the correct local behaviour and confirms the bundle parses and runs.

- [ ] **Step 4: Confirm the bundle has no syntax errors**

```bash
node --check docs/triage-map/out/web/app.js && echo "app.js parses"
```

Expected: `app.js parses`.

- [ ] **Step 5: Commit**

```bash
git add docs/triage-map/web/index.html docs/triage-map/web/app.js.in
git commit -m "Add triage map editor browser shell and glue"
```

---

## Task 6: Publish and verify on the Magic site

**Files:**
- Modify: `docs/triage-map/README.md`

**Interfaces:**
- Consumes: `out/web/app.js` and `web/index.html` from Task 5.
- Produces: the live editor at `https://magic.w10e.com/albert.cai/wocoo-triage-map`.

- [ ] **Step 1: Rebuild from a clean state**

```bash
rm -rf docs/triage-map/out
node docs/triage-map/render.mjs
node docs/triage-map/bundle.mjs
node --test docs/triage-map/*.test.mjs 2>&1 | grep -E "^ℹ (tests|pass|fail)"
wc -c docs/triage-map/out/web/app.js
```

Expected: 104 tests passing, 0 failures, and `app.js` over 25000 bytes.

- [ ] **Step 2: Upload `index.html` and `app.js`**

Use `magic_site_upload` with `siteName: 'wocoo-triage-map'` and exactly two files:
- `index.html` — the contents of `docs/triage-map/web/index.html`
- `app.js` — the contents of `docs/triage-map/out/web/app.js`

`magic_site_upload` replaces the site wholesale, so the two stale `.svg` files are removed by the upload itself. No separate delete is needed.

- [ ] **Step 3: Verify the upload byte-for-byte**

Call `magic_file_list` with `owner: 'albert.cai'`, `siteName: 'wocoo-triage-map'`, and compare each reported `size` against local:

```bash
wc -c docs/triage-map/web/index.html docs/triage-map/out/web/app.js
```

Expected: exactly two files listed, sizes matching, and **no `.svg` files remaining**.

Do **not** verify with `curl` — unauthenticated requests get a `307` to Okta sign-in, so you would be hashing the login page rather than the upload.

- [ ] **Step 4: Manual verification checklist in the browser**

Open `https://magic.w10e.com/albert.cai/wocoo-triage-map` and confirm each item:

1. Both procedures list in the sidebar; CC Fee Relief renders with four columns and the `AND`.
2. Clicking a box outlines it green; clicking empty canvas clears the selection.
3. Double-clicking a box opens the inline editor; changing the title and pressing ⏎ re-renders with the new text.
4. Within ~1s the status shows `saved`, and the `Trees` tab in the sheet holds the new text with indentation intact.
5. `+ child` on a decision adds an outcome; `+ sibling` on a step adds a step below.
6. Dragging a branch header onto another header nests it and the columns recompute.
7. Dragging onto an outcome shows no drop indicator and does nothing on release.
8. ⌘Z reverts the last edit and re-saves.
9. Deleting a node with children prompts for confirmation.
10. Editing `Trees!B2` directly in the sheet, then making an edit in the site, produces the conflict banner rather than silently overwriting.
11. `+ New procedure` creates a sheet row and selects it; the new tree is just a root and renders as a single pill.

- [ ] **Step 5: Update the README**

Replace the "Hosted viewer" section of `docs/triage-map/README.md` with:

```markdown
## Hosted editor

<https://magic.w10e.com/albert.cai/wocoo-triage-map> — Okta-gated. Reads the
`Trees` tab at runtime and writes edits back, so **content changes never require
a re-push**; only code changes do.

Editing is *structural*: dragging reparents or reorders, and layout is always
re-derived. There is no way to nudge a box for aesthetics — that is the trade for
never maintaining coordinates. Adjust `style.mjs` gaps instead, which affects
every diagram at once.

Autosave is debounced 800ms with local undo (⌘Z) and clobber detection: if a tree
changed in the sheet since load, the site refuses to overwrite and asks.

### Republish after a code change

```bash
node docs/triage-map/bundle.mjs
```

Then upload `web/index.html` as `index.html` and `out/web/app.js` as `app.js` via
`magic_site_upload` to site `wocoo-triage-map`. Verify with `magic_file_list` and
compare byte sizes — **not** with `curl`, which gets a `307` to Okta sign-in.
```

- [ ] **Step 6: Commit**

```bash
git add docs/triage-map/README.md
git commit -m "Document the hosted triage map editor and its republish flow"
```

---

## Self-Review

**Spec coverage:**

| spec requirement | task |
|---|---|
| Existing modules run unchanged in browser | Task 4 (bundling proves it; test asserts byte-identical SVG) |
| `serialize.mjs` with round-trip guarantee | Task 2 |
| `edit.mjs` immutable operations | Task 3 |
| `bundle.mjs` | Task 4 |
| `svg.mjs` node tagging | Task 1 |
| Site stops serving pre-rendered SVGs | Task 6 Step 2 (wholesale replace removes them) |
| Interactions: select, edit text, edge label, kind, add child/sibling, delete, reparent, reorder, undo/redo | Task 5 glue; Task 6 Step 4 checklist |
| Default-child-kind table | Task 3 `defaultChildKind` + tests |
| Illegal drops refused | Task 3 `moveNode` guards + Task 6 checklist item 7 |
| New / delete procedure | Task 5 `newProcedure` / `deleteProcedure` |
| Load from `Trees!A2:C100`, per-tree parse errors isolated | Task 5 `load` |
| Debounced 800ms autosave | Task 5 `scheduleSave` |
| Clobber detection with Overwrite / Reload | Task 5 `saveNow` |
| `batch_update_values` + `RAW` | Task 5 `saveNow`, `newProcedure`, `deleteProcedure` |
| Validation reuses parser, autosave still proceeds | Task 5 `validateCurrent` |
| Read-only when `MagicTools` missing | Task 5 `load` |
| Known DSL limitation: edge labels on outcomes only | Task 3 `setEdgeLabel` throws; Task 5 hides the field |
| No `MagicStorage` draft | Not implemented, by design |
| Testing table | Tasks 1–4 tests; Task 6 Step 4 for the glue |

**Gap found and closed:** the spec's testing table asks for a test that "every box emits a `data-node-id`, and ids are unique." Task 1 Step 1 covers it, renamed to `data-node-uid` per the documented deviation.

**Deliberate omission:** the spec lists `⌘Z` capped at 50 per procedure. Implemented in `pushUndo`. Note that `timeTravel` re-parses from stored DSL rather than storing trees, so undo also recovers from a state that had become invalid — a small bonus, not a spec deviation.

**Placeholder scan:** no TBDs, no "handle errors appropriately", no "similar to Task N". Every code step contains complete runnable code.

**Type consistency:** `parseTree` produces nodes with `uid`; `layout` reads `node.uid` and writes `box.nodeUid`; `svg` reads `b.nodeUid` and emits `data-node-uid`; the glue reads that attribute back into a number and passes it to `edit.mjs` functions, all of which take `(tree, uid, …)`. `addChild`/`addSibling` return `{ tree, uid }` and the glue uses `.tree` at both call sites. `titleProblem(title, { isRoot })` is defined in Task 2 and consumed in Task 3 `setText` and Task 5 `newProcedure` with the same signature. `EditError` is thrown in Task 3 and matched by `e.name === 'EditError'` in Task 5.
