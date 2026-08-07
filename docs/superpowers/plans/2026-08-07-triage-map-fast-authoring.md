# Triage Map Fast Authoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make authoring a procedure a burst of typing — `Tab`/`Enter` create nodes straight into a one-line editor, and pasting a numbered list produces a step chain.

**Architecture:** Two pure, tested modules do the thinking — `outline.mjs` parses pasted text, and `edit.mjs` gains `insertOutline` and `navigate`. The browser glue only wires keystrokes and the clipboard to those functions, keeping the untestable surface as thin as it is today. The throwaway debugging harness becomes a committed test so the glue is no longer wholly unverified.

**Tech Stack:** Plain ESM `.mjs` on Node 24, Node's built-in test runner, vanilla browser JS, headless Chrome for the glue harness, `MagicTools` for sheet I/O.

## Global Constraints

- **Zero new npm dependencies.**
- **Tests run with a glob:** `node --test docs/triage-map/*.test.mjs`. A bare directory path fails on Node 24.
- **All Node-side files are `.mjs` ESM.** `docs/triage-map/` has no `package.json`, so `.js` there would be CommonJS and `export` would throw.
- **Do not modify anything under `extension/`.** Albert has uncommitted work there. Every commit uses explicit paths.
- **Layout stays derived. No freeform positioning.** Rejected three times now.
- **Every node created by these features is a `step`.** No kind inference.
- **`bundle.mjs` fails the build on duplicate top-level names.** Any new top-level identifier must be unique across all modules.
- **New exports must be added to `EXPOSED` in `bundle.mjs`** or the glue cannot reach them.
- **Sheet writes use `google_sheets_batch_update_values` with `value_input_option: 'RAW'`.**
- **Sheet ID:** `1Uc8QcM0zA9Dvv0vVnZ-oD3ueESg1D7ZNXXpRRxFRGto` · **Site:** `wocoo-triage-map`, owner `albert.cai`
- **Publishing:** `file_edit` is reliable for `app.js`, not for `vendor.js` — push `vendor.js` whole with `magic_file_write`. Verify with `magic_file_list` byte sizes, never `curl`.
- **Spec:** `docs/superpowers/specs/2026-08-07-triage-map-fast-authoring-design.md`
- Current suite: **130 tests passing.** Every task states its expected new total.

---

## File Structure

| file | change |
|---|---|
| `outline.mjs` | **new** — `parseOutline`, the only place that knows about list markers and indentation |
| `outline.test.mjs` | **new** |
| `edit.mjs` | gains `insertOutline` (mutation) and `navigate` (read, beside `locate`) |
| `edit.test.mjs` | tests for both |
| `bundle.mjs` | `outline.mjs` added to `MODULES`; three names added to `EXPOSED` |
| `web/index.html` | `#fastEdit` input |
| `web/app.js.in` | fast editor, keyboard model, paste handler |
| `web/harness/scenarios.mjs` | **new** — scenario definitions shared by the runner |
| `harness.test.mjs` | **new** — drives the real bundle in headless Chrome, skips if Chrome is absent |

---

## Task 1: `outline.mjs`

**Files:**
- Create: `docs/triage-map/outline.mjs`
- Test: `docs/triage-map/outline.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `export function parseOutline(text): Array<{ depth: number, text: string }>`

- [ ] **Step 1: Write the failing test**

Create `docs/triage-map/outline.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOutline } from './outline.mjs';

test('strips numbered and bulleted markers', () => {
  const out = parseOutline('1. One\n2) Two\n- Three\n* Four\n• Five\n');
  assert.deepEqual(out.map((r) => r.text), ['One', 'Two', 'Three', 'Four', 'Five']);
  assert.deepEqual(out.map((r) => r.depth), [0, 0, 0, 0, 0]);
});

test('nests by leading whitespace', () => {
  const out = parseOutline('1. Open\n2. Input ID\n   - confirm W number\n3. Review\n');
  assert.deepEqual(out.map((r) => r.depth), [0, 0, 1, 0]);
  assert.equal(out[2].text, 'confirm W number');
});

// A Google Doc paste is often uniformly indented. Without normalising, every
// line would nest one level deeper than intended.
test('normalises so the shallowest line is depth 0', () => {
  const out = parseOutline('    1. One\n    2. Two\n        - Sub\n');
  assert.deepEqual(out.map((r) => r.depth), [0, 0, 1]);
});

test('treats a tab as two spaces', () => {
  const out = parseOutline('- One\n\t- Two\n');
  assert.deepEqual(out.map((r) => r.depth), [0, 1]);
});

test('drops blank and marker-only lines', () => {
  const out = parseOutline('1. One\n\n   \n-\n2. Two\n');
  assert.deepEqual(out.map((r) => r.text), ['One', 'Two']);
});

test('clamps an indent jump to one level', () => {
  const out = parseOutline('- One\n        - Way in\n');
  assert.deepEqual(out.map((r) => r.depth), [0, 1]);
});

test('returns to a shallower level correctly', () => {
  const out = parseOutline('- A\n  - B\n    - C\n  - D\n- E\n');
  assert.deepEqual(out.map((r) => r.depth), [0, 1, 2, 1, 0]);
});

test('returns an empty array for empty or whitespace input', () => {
  assert.deepEqual(parseOutline(''), []);
  assert.deepEqual(parseOutline('   \n\n\t\n'), []);
  assert.deepEqual(parseOutline(null), []);
});

test('keeps text that merely contains a marker character', () => {
  const out = parseOutline('1. Check 1-2 business days\n');
  assert.equal(out[0].text, 'Check 1-2 business days');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test docs/triage-map/outline.test.mjs`
Expected: FAIL — `Cannot find module './outline.mjs'`.

- [ ] **Step 3: Write `outline.mjs`**

```js
// Parses pasted text -- typically a numbered list copied out of a Google Doc --
// into flat rows carrying a nesting depth. Knows about list markers and
// indentation, and nothing else: every row becomes a step, and no attempt is
// made to guess node kinds.

// Leading list markers, each with trailing whitespace. Anchored, so "1-2" in
// the middle of a sentence is untouched.
const MARKER = /^(?:\d+[.)]|[-*•])\s+/;

export function parseOutline(text) {
  const rows = [];

  for (const line of String(text ?? '').replace(/\r\n/g, '\n').split('\n')) {
    if (line.trim() === '') continue;
    // A tab counts as two spaces so mixed indentation still nests sensibly.
    const expanded = line.replace(/\t/g, '  ');
    const indent = expanded.length - expanded.trimStart().length;
    const body = expanded.trim().replace(MARKER, '').trim();
    if (body === '') continue;
    rows.push({ indent, text: body });
  }

  if (rows.length === 0) return [];

  // A stack of the indent widths currently open. Walking it converts absolute
  // indents into depths, normalises the shallowest line to 0, and clamps any
  // jump to a single level -- matching how parse.mjs refuses multi-level jumps.
  const open = [rows[0].indent];
  const out = [];

  for (const row of rows) {
    while (open.length > 1 && row.indent < open[open.length - 1]) open.pop();
    if (row.indent > open[open.length - 1]) open.push(row.indent);
    out.push({ depth: open.length - 1, text: row.text });
  }

  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test docs/triage-map/outline.test.mjs`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add docs/triage-map/outline.mjs docs/triage-map/outline.test.mjs
git commit -m "Add outline parser for pasted numbered lists"
```

---

## Task 2: `insertOutline` and `navigate`

**Files:**
- Modify: `docs/triage-map/edit.mjs`
- Test: `docs/triage-map/edit.test.mjs`

**Interfaces:**
- Consumes: `parseOutline` output shape from Task 1.
- Produces:
  - `export function insertOutline(tree, uid, items): { tree, firstUid }`
  - `export function navigate(tree, uid, direction): number | null` — direction is `'up' | 'down' | 'left' | 'right'`

**Design decision forced by round-tripping, not in the spec:** a pasted line containing `|` would be re-read as a subtitle and corrupt the tree. Rather than reject the paste or mangle the text, `insertOutline` **splits on the first `|` into title and subtitle**, exactly as the DSL does everywhere else. Every other character is safe: these are single-line titles on `step` nodes, whose `-` sigil is consumed first, so even a title beginning `?` or `=` round-trips.

- [ ] **Step 1: Write the failing test**

Append to `docs/triage-map/edit.test.mjs`:

```js
// ---- insertOutline ---------------------------------------------------------

test('insertOutline appends a flat list as children', () => {
  const { tree: out, firstUid } = insertOutline(tree(), 2, [
    { depth: 0, text: 'One' },
    { depth: 0, text: 'Two' },
  ]);
  const alpha = locate(out, 2).node;
  assert.deepEqual(alpha.children.slice(-2).map((c) => c.title), ['One', 'Two']);
  assert.equal(alpha.children[alpha.children.length - 2].uid, firstUid);
  assert.ok(alpha.children.every((c) => c.kind === 'decision' || c.kind === 'step'));
});

test('insertOutline nests by depth', () => {
  const { tree: out } = insertOutline(tree(), 7, [
    { depth: 0, text: 'A' },
    { depth: 1, text: 'B' },
    { depth: 2, text: 'C' },
    { depth: 1, text: 'D' },
    { depth: 0, text: 'E' },
  ]);
  const beta = locate(out, 7).node;
  const a = beta.children.find((c) => c.title === 'A');
  assert.equal(a.children.map((c) => c.title).join(','), 'B,D');
  assert.equal(a.children[0].children[0].title, 'C');
  assert.ok(beta.children.some((c) => c.title === 'E'));
});

test('insertOutline creates steps and does not mutate its input', () => {
  const t = tree();
  const before = serialize(t);
  const { tree: out } = insertOutline(t, 7, [{ depth: 0, text: 'X' }]);
  assert.equal(serialize(t), before);
  assert.equal(locate(out, 7).node.children.find((c) => c.title === 'X').kind, 'step');
});

test('insertOutline splits a pasted pipe into title and subtitle', () => {
  const { tree: out } = insertOutline(tree(), 7, [
    { depth: 0, text: 'Open dashboard | Preset 5871' },
  ]);
  const node = locate(out, 7).node.children.find((c) => c.title === 'Open dashboard');
  assert.equal(node.subtitle, 'Preset 5871');
});

test('insertOutline output round-trips through the parser', () => {
  const { tree: out } = insertOutline(tree(), 7, [
    { depth: 0, text: '? looks like a sigil' },
    { depth: 0, text: 'has | a pipe' },
    { depth: 1, text: '= also sigil shaped' },
  ]);
  assert.doesNotThrow(() => parseTree(serialize(out)));
});

test('insertOutline assigns fresh, unique uids', () => {
  const { tree: out } = insertOutline(tree(), 7, [
    { depth: 0, text: 'A' },
    { depth: 1, text: 'B' },
  ]);
  const seen = new Set();
  (function w(n) { assert.ok(!seen.has(n.uid)); seen.add(n.uid); n.children.forEach(w); })(out);
});

test('insertOutline is refused on a leaf kind', () => {
  assert.throws(() => insertOutline(tree(), 5, [{ depth: 0, text: 'X' }]), EditError);
  assert.throws(() => insertOutline(tree(), 4, [{ depth: 0, text: 'X' }]), EditError);
});

test('insertOutline with no items is a no-op returning a null firstUid', () => {
  const t = tree();
  const { tree: out, firstUid } = insertOutline(t, 7, []);
  assert.equal(firstUid, null);
  assert.equal(serialize(out), serialize(t));
});

// ---- navigate --------------------------------------------------------------

test('navigate moves between siblings without wrapping', () => {
  const t = tree();
  assert.equal(navigate(t, 5, 'down'), 6);
  assert.equal(navigate(t, 6, 'up'), 5);
  // Annotations are ordinary entries in children, so navigation walks through
  // them: uid 4 is the annotation sitting before the first outcome.
  assert.equal(navigate(t, 5, 'up'), 4);
  assert.equal(navigate(t, 4, 'up'), null, 'no wrap at the start');
  assert.equal(navigate(t, 6, 'down'), null, 'no wrap at the end');
});

test('navigate left goes to the parent and right to the first child', () => {
  const t = tree();
  assert.equal(navigate(t, 3, 'left'), 2);
  assert.equal(navigate(t, 2, 'right'), 3);
});

test('navigate returns null at the root and at a leaf', () => {
  const t = tree();
  assert.equal(navigate(t, 1, 'left'), null);
  assert.equal(navigate(t, 1, 'up'), null);
  assert.equal(navigate(t, 5, 'right'), null);
});

test('navigate returns null for an unknown uid and throws on a bad direction', () => {
  assert.equal(navigate(tree(), 999, 'up'), null);
  assert.throws(() => navigate(tree(), 3, 'sideways'), EditError);
});
```

Update the import at the top of `docs/triage-map/edit.test.mjs` to include the new functions and `parseTree`:

```js
import { parseTree } from './parse.mjs';
import { serialize } from './serialize.mjs';
import {
  EditError, locate, maxUid, defaultChildKind,
  setText, setKind, setEdgeLabel,
  addChild, addSibling, deleteNode, reparent, reorderSibling,
  insertOutline, navigate,
} from './edit.mjs';
```

Note `navigate(t, 5, 'up')` returns `null`: uid 5 is the first *outcome* under the decision, but uid 4 (the annotation) is its earlier sibling — so this asserts the real array order, which includes annotations.

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test docs/triage-map/edit.test.mjs`
Expected: FAIL — `insertOutline is not a function`.

- [ ] **Step 3: Add both functions to `edit.mjs`**

Add `navigate` immediately after `defaultChildKind`:

```js
const DIRECTIONS = new Set(['up', 'down', 'left', 'right']);

// A read operation, like locate. Returns null rather than wrapping: wrapping is
// disorienting when the whole tree is not on screen.
export function navigate(tree, uid, direction) {
  if (!DIRECTIONS.has(direction)) {
    throw new EditError(`unknown direction "${direction}"`);
  }
  const found = locate(tree, uid);
  if (!found) return null;

  if (direction === 'left') return found.parent ? found.parent.uid : null;
  if (direction === 'right') {
    return found.node.children.length > 0 ? found.node.children[0].uid : null;
  }
  if (!found.parent) return null;

  const siblings = found.parent.children;
  const at = direction === 'up' ? found.index - 1 : found.index + 1;
  if (at < 0 || at >= siblings.length) return null;
  return siblings[at].uid;
}
```

Add `insertOutline` at the end of the file:

```js
// Inserts a parsed outline as a subtree under `uid`, in ONE operation, so a
// pasted twelve-line procedure is a single undo step.
//
// A pasted line containing "|" would be re-read as a subtitle and corrupt the
// tree, so the first pipe splits title from subtitle exactly as the DSL does.
// Nothing else needs escaping: these are single-line titles on step nodes,
// whose "-" sigil is consumed first, so even a title beginning "?" round-trips.
export function insertOutline(tree, uid, items) {
  const out = clone(tree);
  const { node } = require_(out, uid);
  if (LEAF_KINDS.has(node.kind)) {
    throw new EditError(`a ${node.kind} cannot have children`);
  }
  if (!items || items.length === 0) return { tree: out, firstUid: null };

  let nextUid = maxUid(out) + 1;
  // parents[d] is the node a row at depth d attaches to.
  const parents = [node];
  let firstUid = null;

  for (const item of items) {
    const depth = Math.max(0, Math.min(item.depth, parents.length - 1));
    const parent = parents[depth];

    const created = newNode('step', nextUid++);
    const raw = String(item.text);
    const pipe = raw.indexOf('|');
    if (pipe === -1) {
      created.title = raw.trim();
    } else {
      created.title = raw.slice(0, pipe).trim();
      const sub = raw.slice(pipe + 1).trim();
      created.subtitle = sub === '' ? null : sub;
    }
    if (created.title === '') created.title = 'Step';

    parent.children.push(created);
    if (firstUid === null) firstUid = created.uid;

    parents[depth + 1] = created;
    parents.length = depth + 2;
  }

  return { tree: out, firstUid };
}
```

- [ ] **Step 4: Run the whole suite**

Run: `node --test docs/triage-map/*.test.mjs`
Expected: PASS, 151 tests (130 + 9 from Task 1 + 12 here).

- [ ] **Step 5: Commit**

```bash
git add docs/triage-map/edit.mjs docs/triage-map/edit.test.mjs
git commit -m "Add insertOutline and navigate to edit.mjs"
```

---

## Task 3: Expose the new functions in the bundle

**Files:**
- Modify: `docs/triage-map/bundle.mjs`
- Test: `docs/triage-map/bundle.test.mjs`

**Interfaces:**
- Consumes: `parseOutline`, `insertOutline`, `navigate`.
- Produces: those three on `globalThis.TriageMap`.

- [ ] **Step 1: Write the failing test**

Append to `docs/triage-map/bundle.test.mjs`:

```js
test('the pure bundle exposes the fast-authoring functions', () => {
  const globals = {};
  new Function('globalThis', bundlePure()).call(globals, globals);
  const api = globals.TriageMap;
  assert.equal(typeof api.parseOutline, 'function');
  assert.equal(typeof api.insertOutline, 'function');
  assert.equal(typeof api.navigate, 'function');
});

test('the bundled outline pipeline matches the modules', async () => {
  const [{ parseOutline }] = await Promise.all([import('./outline.mjs')]);
  const src = '1. One\n   - Sub\n2. Two\n';
  const globals = {};
  new Function('globalThis', bundlePure()).call(globals, globals);
  assert.deepEqual(globals.TriageMap.parseOutline(src), parseOutline(src));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test docs/triage-map/bundle.test.mjs`
Expected: FAIL — `api.parseOutline` is `undefined`.

- [ ] **Step 3: Register the module and the exports**

In `docs/triage-map/bundle.mjs`, add `outline.mjs` to `MODULES`. It depends on nothing, so it can sit anywhere before `edit.mjs`; place it after `serialize.mjs`:

```js
const MODULES = [
  'style.mjs',
  'text.mjs',
  'parse.mjs',
  'serialize.mjs',
  'outline.mjs',
  'layout.mjs',
  'svg.mjs',
  'edit.mjs',
];
```

Add the three names to `EXPOSED`, after `reorderSibling`:

```js
  'addChild', 'addSibling', 'deleteNode', 'moveNode', 'reparent', 'reorderSibling',
  'parseOutline', 'insertOutline', 'navigate',
];
```

- [ ] **Step 4: Run the whole suite**

Run: `node --test docs/triage-map/*.test.mjs`
Expected: PASS, 153 tests. The collision guard also runs here — if `MARKER` or `DIRECTIONS` clashed with an existing top-level name, `assertNoCollisions` would fail the build with a clear message.

- [ ] **Step 5: Commit**

```bash
git add docs/triage-map/bundle.mjs docs/triage-map/bundle.test.mjs
git commit -m "Expose outline parsing and navigation in the bundle"
```

---

## Task 4: Keyboard-first authoring

**Files:**
- Modify: `docs/triage-map/web/index.html`
- Modify: `docs/triage-map/web/app.js.in`

**Interfaces:**
- Consumes: `T.navigate`, `T.addChild`, `T.addSibling`, `T.reparent`, `T.setText`, `T.deleteNode`, `T.locate`.
- Produces: `#fastEdit` behaviour that Task 6's harness asserts.

No unit tests — this is the DOM-coupled file. Task 5 adds the harness that covers it.

- [ ] **Step 1: Add the input to `index.html`**

Inside the canvas, directly after the `#scaler` div and before `#editor`:

```html
  <div class="canvas" id="canvas"><div id="scaler"></div><input id="fastEdit"><div id="editor">
```

Add to the `<style>` block, after the `#scaler` rule:

```css
  #fastEdit { position: absolute; display: none; font: inherit; font-size: 13px;
              border: 1px solid #1B7F4B; border-radius: 6px; padding: 4px 7px;
              width: 240px; z-index: 6; background: #fff; }
```

- [ ] **Step 2: Add the fast editor to `app.js.in`**

Add just above the `// ---- inline text editor` comment:

```js
// ---- fast inline editor ----------------------------------------------------
// A one-line editor for the common case: type a title and chain onward. The
// three-field popup stays for subtitle and edge label, on Cmd+Enter.
var fast = null;   // { uid, fresh }

function openFast(uid, fresh) {
  var row = current();
  if (!row || !row.tree || state.readOnly) return;
  var found = T.locate(row.tree, uid);
  if (!found) return;

  var g = document.querySelector('#scaler g[data-node-uid="' + uid + '"]');
  if (!g) return;
  var box = g.querySelector('rect');

  fast = { uid: uid, fresh: !!fresh };
  var input = el('fastEdit');
  input.style.display = 'block';
  // Positioned in CSS pixels from SVG user units, so it must track the zoom --
  // the same trap the popup hit.
  input.style.left = ((Number(box.getAttribute('x')) + 6) * state.zoom) + 'px';
  input.style.top = ((Number(box.getAttribute('y')) + 6) * state.zoom) + 'px';
  input.value = fresh ? '' : found.node.title;
  input.focus();
  input.select();

  // A long chain walks off the bottom; without this you type blind.
  if (g.scrollIntoView) g.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function closeFast() {
  fast = null;
  el('fastEdit').style.display = 'none';
}

// Commits the current value. Returns true if the node survived, false if it was
// removed for being an empty fresh node.
function commitFast() {
  if (!fast) return false;
  var uid = fast.uid;
  var fresh = fast.fresh;
  var value = el('fastEdit').value.trim();
  closeFast();

  if (value === '') {
    // An empty fresh node is how a burst ends -- titleProblem rejects an empty
    // title, so leaving it would strand a "New step". An existing node is left
    // untouched instead, since blanking it should not delete your work.
    if (fresh) {
      state.selected = null;
      applyEdit(function (tree) { return T.deleteNode(tree, uid); });
      return false;
    }
    return true;
  }

  applyEdit(function (tree) { return T.setText(tree, uid, { title: value }); });
  return true;
}
```

- [ ] **Step 3: Add the keyboard operations**

Add immediately below `commitFast`:

```js
// Every one of these mirrors a toolbar button. The governing rule is that a
// keystroke does nothing whenever its toolbar equivalent is disabled, so these
// return false rather than surfacing an error banner mid-burst.
function canEditNode(uid) {
  var row = current();
  if (!row || !row.tree || state.readOnly || !uid) return false;
  return !!T.locate(row.tree, uid);
}

function keyAddChild(uid) {
  var row = current();
  if (!canEditNode(uid)) return false;
  var found = T.locate(row.tree, uid);
  if (!T.defaultChildKind(found.node)) return false;   // leaf kinds refuse children
  var created = null;
  applyEdit(function (tree) {
    var r = T.addChild(tree, uid);
    created = r.uid;
    return r.tree;
  });
  if (created === null) return false;
  state.selected = created;
  renderCanvas();
  openFast(created, true);
  return true;
}

function keyAddSibling(uid) {
  var row = current();
  if (!canEditNode(uid)) return false;
  var found = T.locate(row.tree, uid);
  if (!found.parent) return false;                     // the root has no siblings
  var created = null;
  applyEdit(function (tree) {
    var r = T.addSibling(tree, uid);
    created = r.uid;
    return r.tree;
  });
  if (created === null) return false;
  state.selected = created;
  renderCanvas();
  openFast(created, true);
  return true;
}

function keyOutdent(uid) {
  var row = current();
  if (!canEditNode(uid)) return false;
  var found = T.locate(row.tree, uid);
  // Nowhere to outdent to when the parent is already the root.
  if (!found.parent || !T.locate(row.tree, found.parent.uid).parent) return false;
  var grandparent = T.locate(row.tree, found.parent.uid).parent.uid;
  applyEdit(function (tree) { return T.reparent(tree, uid, grandparent); });
  renderCanvas();
  return true;
}
```

- [ ] **Step 4: Replace the document keydown handler**

Replace the existing `document.addEventListener('keydown', ...)` block with:

```js
document.addEventListener('keydown', function (ev) {
  var meta = ev.metaKey || ev.ctrlKey;

  // Undo/redo work in both modes.
  if (meta && ev.key.toLowerCase() === 'z') {
    ev.preventDefault();
    if (fast) closeFast();
    timeTravel(ev.shiftKey ? 1 : -1);
    return;
  }

  if (fast) return;                 // the fastEdit handler owns keys while typing
  if (editingUid !== null) return;  // so does the popup
  if (!state.selected) return;
  var uid = state.selected;

  if (ev.key === 'Tab') {
    // Tab is a browser focus key; every handled path must preventDefault or
    // focus escapes to the toolbar mid-burst.
    ev.preventDefault();
    if (ev.shiftKey) keyOutdent(uid); else keyAddChild(uid);
    return;
  }

  if (ev.key === 'Enter') {
    ev.preventDefault();
    if (meta) { showEditorFor(uid); return; }
    keyAddSibling(uid);
    return;
  }

  if (ev.key === 'ArrowUp' || ev.key === 'ArrowDown'
      || ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') {
    var dir = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' }[ev.key];
    var row = current();
    if (!row || !row.tree) return;
    var next = T.navigate(row.tree, uid, dir);
    if (next === null) return;
    ev.preventDefault();
    state.selected = next;
    renderCanvas();
    var g = document.querySelector('#scaler g[data-node-uid="' + next + '"]');
    if (g && g.scrollIntoView) g.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    return;
  }

  if (ev.key === 'Delete' || ev.key === 'Backspace') {
    ev.preventDefault();
    el('del').click();
  }
});
```

- [ ] **Step 5: Add the fastEdit key handler and a popup helper**

`showEditorFor` exists so `⌘Enter` can open the popup without a DOM event. Add it just above `showEditor`:

```js
function showEditorFor(uid) {
  var g = document.querySelector('#scaler g[data-node-uid="' + uid + '"]');
  if (g) showEditor(uid, g);
}
```

Add the fastEdit handler beside the existing `#editor` keydown wiring:

```js
el('fastEdit').addEventListener('keydown', function (ev) {
  if (ev.key === 'Enter') {
    ev.preventDefault();
    var uid = fast && fast.uid;
    if (commitFast() && uid) keyAddSibling(uid);
    return;
  }
  if (ev.key === 'Tab') {
    ev.preventDefault();
    var t = fast && fast.uid;
    if (commitFast() && t) { if (ev.shiftKey) keyOutdent(t); else keyAddChild(t); }
    return;
  }
  if (ev.key === 'Escape') {
    ev.preventDefault();
    commitFast();
  }
});
```

Finally, make a plain click close the fast editor. Replace the canvas click handler:

```js
el('canvas').addEventListener('click', function () {
  if (fast) commitFast();
  state.selected = null;
  renderCanvas();
});
```

and add a `closeFast()` call at the top of `renderCanvas`, beside the existing `hideEditor()`:

```js
  hideEditor();
  if (!fast) closeFast();
```

The `if (!fast)` guard matters: `openFast` is called *after* `renderCanvas` during a chain, so an unconditional close would immediately hide the editor it just opened.

- [ ] **Step 6: Build and syntax-check**

```bash
node docs/triage-map/bundle.mjs
cp docs/triage-map/web/index.html docs/triage-map/out/web/index.html
node --check docs/triage-map/out/web/app.js && echo "app.js parses"
node --check docs/triage-map/out/web/vendor.js && echo "vendor.js parses"
node --test docs/triage-map/*.test.mjs 2>&1 | grep -E "^ℹ (tests|pass|fail)"
```

Expected: both parse, 153 tests passing.

- [ ] **Step 7: Commit**

```bash
git add docs/triage-map/web/index.html docs/triage-map/web/app.js.in
git commit -m "Add keyboard-first authoring to the triage map editor"
```

---

## Task 5: Paste an outline

**Files:**
- Modify: `docs/triage-map/web/app.js.in`

**Interfaces:**
- Consumes: `T.parseOutline`, `T.insertOutline`.
- Produces: paste behaviour the harness asserts.

- [ ] **Step 1: Add the paste handler**

Add at the end of the wiring section, after the `resize` listener:

```js
// ---- paste an outline ------------------------------------------------------
document.addEventListener('paste', function (ev) {
  var t = ev.target;
  // Pasting into a text field must behave normally.
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
  if (state.readOnly || !state.selected) return;

  var row = current();
  if (!row || !row.tree) return;

  var clip = ev.clipboardData || window.clipboardData;
  if (!clip) return;
  var items = T.parseOutline(clip.getData('text/plain'));
  if (!items.length) return;

  ev.preventDefault();
  var uid = state.selected;
  // One applyEdit, so a pasted twelve-line procedure is a single undo step.
  applyEdit(function (tree) { return T.insertOutline(tree, uid, items).tree; });
});
```

- [ ] **Step 2: Build and syntax-check**

```bash
node docs/triage-map/bundle.mjs
node --check docs/triage-map/out/web/app.js && echo "app.js parses"
```

Expected: `app.js parses`.

- [ ] **Step 3: Commit**

```bash
git add docs/triage-map/web/app.js.in
git commit -m "Paste a numbered list into the triage map as a step chain"
```

---

## Task 6: Promote the harness to a committed test

**Files:**
- Create: `docs/triage-map/web/harness/scenarios.mjs`
- Create: `docs/triage-map/harness.test.mjs`

**Interfaces:**
- Consumes: `out/web/{index.html,vendor.js,app.js}`.
- Produces: browser-level assertions over the glue.

- [ ] **Step 1: Write the scenarios**

Create `docs/triage-map/web/harness/scenarios.mjs`:

```js
// Scenarios for the browser harness. Each supplies the sheet rows MagicTools
// should return, a script that drives the page, and the expected probe lines.
//
// The probe protocol: the driver script appends <div class="probe"> elements;
// the runner scrapes their text and compares.

export const SHEET_ROWS_ROOT_ONLY = [
  ['Balance Statement Inquiry', 'Balance Statement Inquiry\n', '2026-08-07', ''],
];

export const SCENARIOS = [
  {
    name: 'root is auto-selected and only + child is enabled',
    rows: SHEET_ROWS_ROOT_ONLY,
    drive: `
      await ready();
      probe('buttons ' + buttons());
    `,
    expect: ['buttons kind=OFF addChild=on addSib=OFF del=OFF'],
  },
  {
    name: 'Tab then typing then Enter builds a chain',
    rows: SHEET_ROWS_ROOT_ONLY,
    drive: `
      await ready();
      key(document, 'Tab');
      await tick();
      type('Open dashboard');
      key(fastEl(), 'Enter');
      await tick();
      type('Input identity ID');
      key(fastEl(), 'Escape');
      await tick();
      probe('titles ' + titles().join('|'));
    `,
    expect: ['titles Balance Statement Inquiry|Open dashboard|Input identity ID'],
  },
  {
    name: 'Enter on an empty fresh node removes it',
    rows: SHEET_ROWS_ROOT_ONLY,
    drive: `
      await ready();
      key(document, 'Tab');
      await tick();
      type('Only step');
      key(fastEl(), 'Enter');
      await tick();
      key(fastEl(), 'Enter');
      await tick();
      probe('titles ' + titles().join('|'));
    `,
    expect: ['titles Balance Statement Inquiry|Only step'],
  },
  {
    name: 'Tab does not move browser focus',
    rows: SHEET_ROWS_ROOT_ONLY,
    drive: `
      await ready();
      key(document, 'Tab');
      await tick();
      probe('focus ' + (document.activeElement && document.activeElement.id));
    `,
    expect: ['focus fastEdit'],
  },
  {
    name: 'pasting a numbered list creates a step chain',
    rows: SHEET_ROWS_ROOT_ONLY,
    drive: `
      await ready();
      paste('1. Open dashboard\\n2. Input identity ID\\n   - confirm W number\\n');
      await tick();
      probe('titles ' + titles().join('|'));
    `,
    expect: [
      'titles Balance Statement Inquiry|Open dashboard|Input identity ID|confirm W number',
    ],
  },
  {
    name: 'the fast editor tracks zoom',
    rows: SHEET_ROWS_ROOT_ONLY,
    drive: `
      await ready();
      document.getElementById('zoomReset').click();
      document.getElementById('zoomIn').click();
      key(document, 'Tab');
      await tick();
      var left = parseFloat(fastEl().style.left);
      var box = document.querySelector('#scaler g[data-node-uid="2"] rect');
      var want = (Number(box.getAttribute('x')) + 6) * 1.25;
      probe('zoomed ' + (Math.abs(left - want) < 1));
    `,
    expect: ['zoomed true'],
  },
];
```

- [ ] **Step 2: Write the harness test**

Create `docs/triage-map/harness.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { SCENARIOS } from './web/harness/scenarios.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const built = join(here, 'out', 'web');

// The harness drives the REAL bundle in a real browser. Skip rather than fail
// where Chrome or a build is missing, so the rest of the suite still runs.
const runnable = existsSync(CHROME) && existsSync(join(built, 'app.js'));

const PRELUDE = `
function probe(t) {
  var d = document.createElement('div');
  d.className = 'probe';
  d.textContent = t;
  document.body.appendChild(d);
}
function tick() { return new Promise(function (r) { setTimeout(r, 60); }); }
function ready() {
  return new Promise(function (r) {
    var iv = setInterval(function () {
      if (document.querySelector('#scaler g[data-node-uid]')) { clearInterval(iv); r(); }
    }, 30);
  });
}
function fastEl() { return document.getElementById('fastEdit'); }
function buttons() {
  return ['kind', 'addChild', 'addSib', 'del'].map(function (i) {
    var e = document.getElementById(i);
    return i + '=' + (e && e.disabled ? 'OFF' : 'on');
  }).join(' ');
}
function titles() {
  return Array.prototype.map.call(
    document.querySelectorAll('#scaler g[data-node-uid]'),
    function (g) {
      var t = g.querySelector('text[font-weight]');
      return t ? t.textContent : '';
    }
  );
}
function key(target, k) {
  target.dispatchEvent(new KeyboardEvent('keydown', {
    key: k, bubbles: true, cancelable: true,
  }));
}
function type(s) { fastEl().value = s; }
function paste(text) {
  var dt = new DataTransfer();
  dt.setData('text/plain', text);
  document.dispatchEvent(new ClipboardEvent('paste', {
    clipboardData: dt, bubbles: true, cancelable: true,
  }));
}
`;

function runScenario(scenario) {
  const dir = mkdtempSync(join(tmpdir(), 'triage-harness-'));
  cpSync(join(built, 'vendor.js'), join(dir, 'vendor.js'));
  cpSync(join(built, 'app.js'), join(dir, 'app.js'));

  const stub = `<script>
window.MagicTools = { call: function (tool) {
  if (tool === 'google_sheets_get') {
    return Promise.resolve({ content: [{ type: 'text', text: JSON.stringify(
      { values: ${JSON.stringify(scenario.rows)} }
    ) }] });
  }
  return Promise.resolve({ content: [{ type: 'text', text: '{}' }] });
} };
</script>`;

  const driver = `<script>
${PRELUDE}
(async function () {
  try { ${scenario.drive} }
  catch (e) { probe('ERROR ' + e.message); }
})();
</script>`;

  let html = readFileSync(join(here, 'web', 'index.html'), 'utf8');
  html = html.replace('<script src="vendor.js"></script>', stub + '<script src="vendor.js"></script>');
  html = html.replace('<script src="app.js"></script>', '<script src="app.js"></script>' + driver);
  writeFileSync(join(dir, 'index.html'), html);

  const out = execFileSync(CHROME, [
    '--headless', '--disable-gpu', '--virtual-time-budget=8000', '--dump-dom',
    `file://${join(dir, 'index.html')}`,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

  return [...out.matchAll(/class="probe">([^<]*)/g)].map((m) => m[1]);
}

for (const scenario of SCENARIOS) {
  test(`harness: ${scenario.name}`, { skip: runnable ? false : 'Chrome or build missing' }, () => {
    assert.deepEqual(runScenario(scenario), scenario.expect);
  });
}
```

- [ ] **Step 3: Build, then run the harness**

```bash
node docs/triage-map/bundle.mjs
cp docs/triage-map/web/index.html docs/triage-map/out/web/index.html
node --test docs/triage-map/harness.test.mjs 2>&1 | grep -E "^✔|^✖|^ℹ (tests|pass|fail)"
```

Expected: PASS, 6 tests.

If a scenario fails, read its probe output rather than guessing — the whole point of the harness is that it reports the real DOM state. A `ERROR ...` probe line means the driver script threw.

- [ ] **Step 4: Run the whole suite**

Run: `node --test docs/triage-map/*.test.mjs`
Expected: PASS, 159 tests.

- [ ] **Step 5: Commit**

```bash
git add docs/triage-map/web/harness docs/triage-map/harness.test.mjs
git commit -m "Promote the debugging harness to a committed browser test"
```

---

## Task 7: Republish and verify

**Files:**
- Modify: `docs/triage-map/README.md`

- [ ] **Step 1: Clean rebuild**

```bash
rm -rf docs/triage-map/out
node docs/triage-map/render.mjs
node docs/triage-map/bundle.mjs
cp docs/triage-map/web/index.html docs/triage-map/out/web/index.html
node --test docs/triage-map/*.test.mjs 2>&1 | grep -E "^ℹ (tests|pass|fail)"
wc -c docs/triage-map/out/web/index.html docs/triage-map/out/web/vendor.js docs/triage-map/out/web/app.js
```

Expected: 159 tests passing. Note the three byte sizes.

- [ ] **Step 2: Upload**

`vendor.js` changed (`outline.mjs` was added to the bundle) and so did `app.js` and `index.html`, so all three go up. Push `vendor.js` whole with `magic_file_write` — `magic_file_edit` has repeatedly failed on that file with a bogus `site_not_found`. `app.js` and `index.html` may use either.

Then call `magic_file_list` and confirm all three sizes match Step 1 exactly.

- [ ] **Step 3: Manual verification on the live site**

Open <https://magic.w10e.com/albert.cai/wocoo-triage-map> and confirm:

1. Opening a procedure auto-selects the root; only `+ child` is enabled
2. `Tab`, type, `Enter`, type, `Enter`, type, `Esc` builds a three-step chain without touching the mouse
3. `Tab` never moves focus to the toolbar
4. `Enter` on an empty node ends the burst and leaves no stray "New step"
5. Arrow keys move the selection and do not wrap at the ends
6. `⇧Tab` outdents a nested node, and does nothing when its parent is the root
7. `⌘Enter` still opens the three-field popup for subtitle and edge label
8. Zoom to 200%, press `Tab` — the fast editor appears **on** the new box
9. Copy the five numbered steps out of the Declined PPMC Google Doc, select a node, `⌘V` — five steps appear
10. `⌘Z` undoes the whole paste in one step
11. The sheet's `tree_dsl` reflects all of it within about a second

- [ ] **Step 4: Update the README**

Add after the "Hosted editor" section:

```markdown
### Authoring by keyboard

With a node selected: `Tab` adds a child and starts typing, `Enter` adds a
sibling, `⇧Tab` outdents, arrows move the selection (no wrapping), `⌫` deletes,
`⌘Enter` opens the full popup for subtitle and edge label. While typing, `Enter`
commits and chains onward, `Tab` commits and indents, `Esc` commits and stops.
`Enter` or `Esc` on an empty freshly created node removes it — that is how a
burst ends.

A keystroke does nothing whenever its toolbar equivalent is disabled, rather
than raising an error banner mid-burst.

`⌘V` pastes a numbered or bulleted list as a chain of steps under the selection,
nesting by indentation. Every pasted line becomes a step; change kinds afterwards
with the picker. A pasted `|` splits title from subtitle, as it does in the DSL.

### Browser tests

`harness.test.mjs` drives the real built bundle in headless Chrome against a
stubbed `MagicTools`, asserting DOM state. It skips when Chrome or `out/web/` is
missing. Build first, or the scenarios test a stale bundle:

```bash
node docs/triage-map/bundle.mjs && node --test docs/triage-map/harness.test.mjs
```
```

- [ ] **Step 5: Commit**

```bash
git add docs/triage-map/README.md
git commit -m "Document keyboard authoring, paste, and the browser harness"
```

---

## Self-Review

**Spec coverage:**

| spec requirement | task |
|---|---|
| `parseOutline` — markers, normalised depth, tabs, blanks, clamped jumps, `[]` | Task 1 |
| `insertOutline` — one undo step, all steps, refused on leaves | Task 2 |
| `navigate` — four directions, `null` at boundaries, no wrapping | Task 2 |
| `Tab` child / `Enter` sibling / `⇧Tab` outdent | Task 4 |
| Arrow navigation | Task 4 |
| `⌘Enter` opens the popup | Task 4 `showEditorFor` |
| Empty-title deletion ends a burst | Task 4 `commitFast` |
| Refusals silent, mirroring disabled buttons | Task 4 `keyAddChild` / `keyAddSibling` / `keyOutdent` return false |
| `⇧Tab` inert when the parent is the root | Task 4 `keyOutdent` |
| Scroll new node into view | Task 4 `openFast` and the arrow branch |
| `#fastEdit` repositioned and zoom-scaled | Task 4 `openFast`; harness scenario 6 |
| Paste ignored in text fields, one undo step, no-op on zero items | Task 5 |
| Harness committed, four named scenarios | Task 6 — six scenarios, superset |
| `Enter`/`⇧Enter` behaviour change | Task 4 keydown handler; README in Task 7 |

**Gaps closed while writing:**

1. **`showEditorFor` did not exist.** The spec has `⌘Enter` open the popup, but `showEditor` requires a DOM element. Added a small lookup helper in Task 4 Step 5.
2. **`renderCanvas` would have closed the fast editor immediately.** `openFast` runs *after* `renderCanvas` during a chain, so an unconditional `closeFast()` there would hide the editor it had just opened. Guarded with `if (!fast)`.
3. **Pipes in pasted text were unspecified and would corrupt the tree.** A pasted `|` would be re-read as a subtitle separator on the next parse. `insertOutline` now splits on the first pipe, matching the DSL. Documented in Task 2's preamble and the README. Every other character is safe, because these are single-line titles on `step` nodes whose `-` sigil is consumed first — Task 2 has a round-trip test proving `?`- and `=`-leading titles survive.

**Placeholder scan:** no TBDs, no "handle errors appropriately", no "similar to Task N". Every code step carries complete code.

**Type consistency:** `parseOutline` returns `{ depth, text }` in Task 1 and is consumed with those exact fields by `insertOutline` in Task 2 and the paste handler in Task 5. `insertOutline` returns `{ tree, firstUid }`; the glue uses `.tree` only. `navigate` returns a `uid | null` and the arrow branch checks `=== null`. `addChild`/`addSibling` return `{ tree, uid }`, matching how `keyAddChild`/`keyAddSibling` read `r.uid` and `r.tree`. `fast` is `{ uid, fresh }` throughout Task 4. `T.defaultChildKind` and `T.locate` are already exposed in `bundle.mjs`; `parseOutline`, `insertOutline` and `navigate` are added in Task 3, before Tasks 4 and 5 use them.
