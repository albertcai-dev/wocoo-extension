# Triage Map Orientation and Zoom Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-map vertical/horizontal orientation toggle that the layout engine honours, plus zoom controls on the editor canvas.

**Architecture:** The transpose is a parameterisation of the two axes the layout algorithm already has implicitly — a **main axis** (the direction children flow) and a **cross axis** (the direction siblings separate). Layout works internally in `(main, cross)` and converts to `(x, y)` once, at box creation. Boxes never transpose, since they are sized by their wrapped text either way. A golden-file test locks vertical output byte-for-byte so the refactor cannot silently change it.

**Tech Stack:** Plain ESM `.mjs` on Node 24, Node's built-in test runner, vanilla browser JS, `MagicTools` for sheet I/O.

## Global Constraints

- **Zero new npm dependencies.**
- **Tests run with a glob:** `node --test docs/triage-map/*.test.mjs`. A bare directory path fails on Node 24 — it reads the path as a module to execute.
- **All Node-side files are `.mjs` ESM.** `docs/triage-map/` has no `package.json`, so `.js` there would be CommonJS and `export` would throw.
- **Do not modify anything under `extension/`.** Albert has uncommitted work across six files there. Every commit uses explicit paths.
- **Vertical output must not change.** This is the load-bearing constraint. Task 1 exists solely to enforce it.
- **Boxes never transpose.** `boxFor()` is untouched by this work.
- **Sheet writes use `google_sheets_batch_update_values` with `value_input_option: 'RAW'`** — never `google_sheets_update`, which exposes no such option and defaults to `USER_ENTERED`, treating the DSL's `= outcome` lines as formulas.
- **Sheet ID:** `1Uc8QcM0zA9Dvv0vVnZ-oD3ueESg1D7ZNXXpRRxFRGto` · **Site:** `wocoo-triage-map`, owner `albert.cai`
- **Spec:** `docs/superpowers/specs/2026-08-04-triage-map-orientation-and-zoom-design.md`
- **Verify Magic uploads with `magic_file_list` byte sizes, never `curl`** — unauthenticated requests get a `307` to Okta sign-in, so you hash the login page.
- Current suite: **111 tests passing.** Every task states its expected new total.

---

## File Structure

| file | change |
|---|---|
| `fixtures/golden/*.vertical.svg` | **new** — committed byte-exact vertical renders, the regression guard |
| `golden.test.mjs` | **new** — asserts vertical output matches the goldens |
| `style.mjs` | rename `gap.vertical`→`gap.main`, `gap.column`→`gap.cross`, `page.rightAllowance`→`page.railAllowance` |
| `layout.mjs` | axis parameterisation; `anchorY`→`anchor`, `col`→`band`; `layout(root, orientation)` |
| `svg.mjs` | orientation-aware `railFor` and `edgeSvg`; reads `diagram.orientation` |
| `render.mjs` | pass each snapshot row's `orientation` to `layout` |
| `data/trees.json` | entries gain optional `orientation` |
| `web/index.html` | zoom controls, orientation select, `#scaler` wrapper |
| `web/app.js.in` | zoom state, orientation load/save, refit behaviour |

`boxFor`, `parse.mjs`, `serialize.mjs`, `edit.mjs`, `bundle.mjs` are untouched.

---

## Task 1: Golden-file guard

**This must land before any refactor.** It is the only thing that can prove vertical output is unchanged.

**Files:**
- Create: `docs/triage-map/fixtures/golden/cc-fee-relief.vertical.svg`
- Create: `docs/triage-map/fixtures/golden/declined-transaction.vertical.svg`
- Create: `docs/triage-map/golden.test.mjs`

**Interfaces:**
- Consumes: `parseTree`, `layout`, `toSvg` as they exist today.
- Produces: golden files that Tasks 2–4 must not change.

- [ ] **Step 1: Generate the golden files from current output**

```bash
mkdir -p docs/triage-map/fixtures/golden
node -e "
Promise.all([
  import('./docs/triage-map/parse.mjs'),
  import('./docs/triage-map/layout.mjs'),
  import('./docs/triage-map/svg.mjs'),
]).then(([P, L, V]) => {
  const { readFileSync, writeFileSync } = require('fs');
  for (const name of ['cc-fee-relief', 'declined-transaction']) {
    const dsl = readFileSync('docs/triage-map/fixtures/' + name + '.tree', 'utf8');
    const svg = V.toSvg(L.layout(P.parseTree(dsl)), name);
    writeFileSync('docs/triage-map/fixtures/golden/' + name + '.vertical.svg', svg);
    console.log('wrote', name, svg.length, 'chars');
  }
});
"
```

Expected: two `wrote …` lines. `cc-fee-relief` around 11500 chars, `declined-transaction` around 4700.

- [ ] **Step 2: Write the golden test**

Create `docs/triage-map/golden.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseTree } from './parse.mjs';
import { layout } from './layout.mjs';
import { toSvg } from './svg.mjs';

// These files lock VERTICAL rendering byte-for-byte. They exist because the
// orientation refactor touches layout.mjs and svg.mjs, which encode two
// hard-won edge-routing fixes: straight edges must not cross the annotation
// explaining their own decision, and elbow rails must not reach into the
// neighbouring band. If vertical output shifts by one pixel, this fails.
//
// Regenerating a golden is a deliberate act. Only do it when you intend to
// change how vertical diagrams look, and eyeball the diff first.
const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

for (const name of ['cc-fee-relief', 'declined-transaction']) {
  test(`vertical rendering of ${name} matches its golden file`, () => {
    const dsl = read(`./fixtures/${name}.tree`);
    const actual = toSvg(layout(parseTree(dsl), 'vertical'), name);
    const golden = read(`./fixtures/golden/${name}.vertical.svg`);
    assert.equal(actual, golden);
  });
}
```

Note the explicit `'vertical'` argument. `layout` ignores extra arguments today, so this passes now and keeps passing after Task 3 adds the parameter.

- [ ] **Step 3: Run the test to verify it passes**

Run: `node --test docs/triage-map/golden.test.mjs`
Expected: PASS, 2 tests.

- [ ] **Step 4: Prove the guard actually bites**

Temporarily break a gap value, confirm failure, then restore:

```bash
cp docs/triage-map/style.mjs /tmp/style.bak
perl -pi -e 's/vertical: 34,/vertical: 35,/' docs/triage-map/style.mjs
node --test docs/triage-map/golden.test.mjs 2>&1 | grep -E "^ℹ (pass|fail)"
cp /tmp/style.bak docs/triage-map/style.mjs && rm /tmp/style.bak
node --test docs/triage-map/golden.test.mjs 2>&1 | grep -E "^ℹ (pass|fail)"
```

Expected: `fail 2` on the first run, `pass 2` after restoring. A guard you have not seen fail is not a guard.

- [ ] **Step 5: Run the whole suite**

Run: `node --test docs/triage-map/*.test.mjs`
Expected: PASS, 113 tests.

- [ ] **Step 6: Commit**

```bash
git add docs/triage-map/fixtures/golden docs/triage-map/golden.test.mjs
git commit -m "Lock vertical diagram output with golden-file tests"
```

---

## Task 2: Renames

Pure rename, no behaviour change. A reviewer should be able to confirm nothing moved by seeing the golden tests still pass.

**Files:**
- Modify: `docs/triage-map/style.mjs`
- Modify: `docs/triage-map/layout.mjs`
- Modify: `docs/triage-map/svg.mjs`
- Modify: `docs/triage-map/layout.test.mjs`
- Modify: `docs/triage-map/svg.test.mjs`

**Interfaces:**
- Consumes: Task 1's golden files.
- Produces: `S.gap.main`, `S.gap.cross`, `S.page.railAllowance`; boxes carry `anchor` and `band` instead of `anchorY` and `col`.

- [ ] **Step 1: Rename the style tokens**

In `docs/triage-map/style.mjs`, replace the `gap` and `page` blocks:

```js
  gap: {
    // main = the direction children flow. cross = the direction siblings and
    // bands separate. Which physical axis each maps to depends on orientation.
    main: 34,
    // Wide enough that an elbow rail and its edge label sit clear of the next
    // band: the rail lands at bandEnd + elbowClearance, label ends ~30px later.
    cross: 76,
    annotation: 8,
    conjoined: 30,
    headerToFirst: 16,
    rootToHeaders: 52,
  },
  // railAllowance leaves room for an elbow rail and its label hanging off the
  // last band, which layout cannot know about — rails are computed at render
  // time from the boxes an edge passes. Applies to the cross axis: the right
  // edge when vertical, the bottom edge when horizontal.
  page: { padding: 48, railAllowance: 60, background: '#FFFFFF' },
```

- [ ] **Step 2: Apply the renames mechanically**

```bash
cd docs/triage-map
perl -pi -e 's/S\.gap\.vertical/S.gap.main/g; s/S\.gap\.column/S.gap.cross/g; s/S\.page\.rightAllowance/S.page.railAllowance/g' layout.mjs svg.mjs
perl -pi -e 's/\banchorY\b/anchor/g; s/\bctx\.col\b/ctx.band/g' layout.mjs
perl -pi -e 's/\banchorY\b/anchor/g' svg.mjs layout.test.mjs
perl -pi -e 's/\bcol: ctx\.band\b/band: ctx.band/' layout.mjs
perl -pi -e 's/box\.col/box.band/g; s/a\.col/a.band/g; s/\bcolStart\b/bandStart/g; s/box\.col\b/box.band/g' svg.mjs svg.test.mjs
cd -
grep -rn "anchorY\|gap\.vertical\|gap\.column\|rightAllowance" docs/triage-map/*.mjs
```

Expected: the final `grep` prints nothing.

- [ ] **Step 3: Fix the remaining `col` references by hand**

`perl` cannot safely rewrite every `col` (it collides with `colX`, `colRight`, `colIndex`). Open `docs/triage-map/layout.mjs` and confirm:

- `pushBox` builds `band: ctx.band` (not `col: ctx.band`)
- `ctx` is initialised with `band: 0` (not `col: 0`)
- the header loop sets `ctx.band = colIndex`

Then in `docs/triage-map/svg.test.mjs`, the two rail tests must compare `box.band` and `a.band`, and the "next column" test's map should read `bandStart`.

- [ ] **Step 4: Run the whole suite**

Run: `node --test docs/triage-map/*.test.mjs`
Expected: PASS, 113 tests. **The two golden tests passing is the proof this rename changed nothing.**

- [ ] **Step 5: Commit**

```bash
git add docs/triage-map/style.mjs docs/triage-map/layout.mjs docs/triage-map/svg.mjs \
        docs/triage-map/layout.test.mjs docs/triage-map/svg.test.mjs
git commit -m "Rename layout axes to main/cross, anchorY to anchor, col to band"
```

---

## Task 3: Axis parameterisation in `layout.mjs`

**Files:**
- Modify: `docs/triage-map/layout.mjs`
- Modify: `docs/triage-map/layout.test.mjs`

**Interfaces:**
- Consumes: `S.gap.main`, `S.gap.cross`, `S.page.railAllowance` from Task 2.
- Produces: `layout(root, orientation = 'vertical')` returning `{ width, height, orientation, boxes, headers, edges, conjunctions }`. Boxes carry `x`, `y`, `w`, `h`, `anchor`, `band`, `nodeUid`. Internal helpers `placeNode` / `placeSiblings` return `{ id?, mainEnd, crossEnd }`.

- [ ] **Step 1: Write the failing tests**

Append to `docs/triage-map/layout.test.mjs`:

```js
// ---- horizontal orientation ------------------------------------------------

test('layout rejects an unknown orientation', () => {
  assert.throws(() => layout(load('declined-ppmc'), 'diagonal'), /orientation/);
});

test('orientation is reported on the diagram and defaults to vertical', () => {
  assert.equal(layout(load('declined-ppmc')).orientation, 'vertical');
  assert.equal(layout(load('declined-ppmc'), 'horizontal').orientation, 'horizontal');
});

test('horizontal places branch headers as rows, ordered top to bottom', () => {
  const d = layout(load('cc-fee-relief'), 'horizontal');
  assert.equal(d.headers.length, 4);
  const ys = d.headers.map((h) => h.y);
  for (let i = 1; i < ys.length; i++) {
    assert.ok(ys[i] > ys[i - 1], `row ${i} should start below row ${i - 1}`);
  }
  // All rows start at the same x, unlike vertical where each column shifts right.
  assert.equal(new Set(d.headers.map((h) => h.x)).size, 1);
});

test('horizontal advances children along x within a band', () => {
  const d = layout(load('declined-transaction'), 'horizontal');
  const steps = d.boxes.filter((b) => b.kind === 'step');
  assert.equal(steps.length, 3);
  for (let i = 1; i < steps.length; i++) {
    assert.ok(steps[i].x > steps[i - 1].x, 'each step should sit right of the previous');
  }
  assert.equal(new Set(steps.map((s) => s.y)).size, 1, 'chained steps share a y');
});

// Only the chain case reverses orientation outright. A chain stacks its nodes
// along the flow axis, so transposing must trade height for width. A multi-band
// tree only rebalances -- a band's cross extent becomes its tallest single box
// rather than the sum of its nodes -- so it can stay landscape. Asserting
// `height > width` for cc-fee-relief would be wrong.
test('transposing a chain trades its height for width', () => {
  const v = layout(load('declined-ppmc'), 'vertical');
  const h = layout(load('declined-ppmc'), 'horizontal');
  assert.ok(v.height > v.width, 'a chain is tall when vertical');
  assert.ok(h.width > v.width, 'horizontal is wider');
  assert.ok(h.height < v.height, 'and shorter');
});

test('transposing a multi-band tree narrows it and makes it relatively taller', () => {
  const v = layout(load('cc-fee-relief'), 'vertical');
  const h = layout(load('cc-fee-relief'), 'horizontal');
  assert.ok(h.width < v.width, 'bands no longer sit side by side, so width falls');
  assert.ok(h.height > v.height, 'and stacking them adds height');
  assert.ok(h.width / h.height < v.width / v.height, 'aspect ratio moves toward portrait');
});

test('no two boxes overlap in either orientation', () => {
  for (const name of ['cc-fee-relief', 'declined-ppmc', 'declined-transaction']) {
    for (const orientation of ['vertical', 'horizontal']) {
      const d = layout(load(name), orientation);
      for (let i = 0; i < d.boxes.length; i++) {
        for (let j = i + 1; j < d.boxes.length; j++) {
          const a = d.boxes[i];
          const b = d.boxes[j];
          const disjoint =
            a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
          assert.ok(disjoint, `${name}/${orientation}: ${a.id} and ${b.id} overlap`);
        }
      }
    }
  }
});

test('diagram bounds contain every box in either orientation', () => {
  for (const name of ['cc-fee-relief', 'declined-transaction']) {
    for (const orientation of ['vertical', 'horizontal']) {
      const d = layout(load(name), orientation);
      for (const b of d.boxes) {
        assert.ok(b.x >= S.page.padding - 1, `${name}/${orientation}: ${b.id} left of bounds`);
        assert.ok(b.y >= S.page.padding - 1, `${name}/${orientation}: ${b.id} above bounds`);
        assert.ok(b.x + b.w <= d.width, `${name}/${orientation}: ${b.id} right of bounds`);
        assert.ok(b.y + b.h <= d.height, `${name}/${orientation}: ${b.id} below bounds`);
      }
    }
  }
});

test('horizontal anchors outgoing edges past the annotation, on x', () => {
  const d = layout(load('cc-fee-relief'), 'horizontal');
  const decision = d.boxes.find((b) => b.kind === 'decision');
  const annotation = d.boxes.find((b) => b.kind === 'annotation');
  assert.ok(decision.anchor > decision.x + decision.w, 'anchor is past the box on x');
  assert.ok(decision.anchor >= annotation.x + annotation.w, 'anchor clears the annotation');
});

test('horizontal separates ?AND members on y and still emits one AND label', () => {
  const d = layout(load('cc-fee-relief'), 'horizontal');
  assert.equal(d.conjunctions.length, 1);
  const decisions = d.boxes.filter((b) => b.kind === 'decision');
  const qcFirst = decisions[2];
  const sameColumn = decisions.filter((b) => Math.abs(b.x - qcFirst.x) < 1);
  assert.ok(sameColumn.length >= 2, 'conjoined members share an x when horizontal');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test docs/triage-map/layout.test.mjs`
Expected: FAIL — `orientation` is `undefined`, no unknown-orientation throw, headers still laid out as columns.

- [ ] **Step 3: Rewrite `layout.mjs`**

Replace the whole file with:

```js
// Turns a parsed node tree into absolutely-positioned boxes and edges.
//
// The algorithm has two axes:
//   * MAIN  — the direction children flow
//   * CROSS — the direction siblings and bands separate
//
// Vertical puts main on y and cross on x; horizontal swaps them. Everything is
// computed in (main, cross) and converted to (x, y) once, in pushBox.
//
// Boxes never transpose: a box is sized by its wrapped text in both modes. So
// the MAIN-axis size is the box height when vertical and its width when
// horizontal. That asymmetry is the whole mechanism.
//
// Within a band, siblings are placed in one of two modes. 'chain' is for
// sequences that flow into one another (steps under a header, or under the
// root) — each links to the one before it. 'branch' is for alternatives out of
// a decision — each links back to the same parent, the first with a straight
// edge and the rest via elbows.
import { S } from './style.mjs';
import { measure, wrap } from './text.mjs';

const AXES = {
  vertical: {
    mainSize: 'h',
    crossSize: 'w',
    toXY: (main, cross) => ({ x: cross, y: main }),
  },
  horizontal: {
    mainSize: 'w',
    crossSize: 'h',
    toXY: (main, cross) => ({ x: main, y: cross }),
  },
};

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
  const w = Math.ceil(Math.max(...widths) * S.box.widthSafety) + S.box.padX * 2 + extra;

  let h = S.box.padY * 2 + titleLines.length * titleFont * S.box.lineHeight;
  if (subLines.length > 0) {
    h += S.box.gapTitleSub + subLines.length * S.size.subtitle * S.box.lineHeight;
  }
  if (node.kind === 'annotation') h += S.box.annotationHeadroom;

  return {
    kind: node.kind,
    titleLines,
    subLines,
    w,
    h: Math.ceil(h),
    number: node.kind === 'step' ? stepNumber : null,
  };
}

function pushBox(node, main, cross, ctx, stepNumber) {
  const box = boxFor(node, stepNumber);
  const id = `n${++ctx.uid}`;
  const { x, y } = ctx.axis.toXY(main, cross);
  // anchor is where outgoing straight edges begin, on the main axis. It starts
  // at the far edge of the box and is pushed past any annotation stack, so an
  // edge never runs through the annotation explaining its own decision.
  //
  // band scopes elbow routing: a rail clears only boxes in its own band and
  // must not reach into the next one.
  const placed = {
    id,
    ...box,
    x,
    y,
    anchor: main + box[ctx.axis.mainSize],
    band: ctx.band,
    nodeUid: node.uid ?? null,
  };
  ctx.boxes.push(placed);
  ctx.byId.set(id, placed);
  return placed;
}

// Places `nodes` as siblings starting at (main, cross).
// Returns { mainEnd, crossEnd }.
function placeSiblings(nodes, main, cross, ctx, { parentId = null, mode = 'branch' } = {}) {
  if (nodes.length === 0) return { mainEnd: main, crossEnd: cross };

  const A = ctx.axis;
  let cursorMain = main;
  let crossEnd = cross;
  let prevId = parentId;
  let firstEdge = true;
  let i = 0;

  while (i < nodes.length) {
    const node = nodes[i];

    if (node.conjoined) {
      // Consecutive ?AND siblings share a main position and separate on cross.
      // The group's outcomes hang off its last member, so a chain continues
      // from that member.
      let j = i;
      while (j < nodes.length && nodes[j].conjoined) j++;
      const group = nodes.slice(i, j);

      const groupMain = cursorMain;
      let cursorCross = cross;
      let groupMainEnd = groupMain;
      let firstMemberId = null;
      let lastMemberId = null;

      group.forEach((member, gi) => {
        const r = placeNode(member, groupMain, cursorCross, ctx);
        const placed = ctx.byId.get(r.id);
        if (gi === 0) {
          firstMemberId = r.id;
        } else {
          const at = A.toXY(
            groupMain + placed[A.mainSize] / 2,
            cursorCross - S.gap.conjoined / 2,
          );
          // The +4 is a text-baseline nudge, so it always applies to y.
          ctx.conjunctions.push({ x: at.x, y: at.y + 4, text: 'AND' });
        }
        lastMemberId = r.id;
        groupMainEnd = Math.max(groupMainEnd, r.mainEnd);
        crossEnd = Math.max(crossEnd, r.crossEnd);
        cursorCross += placed[A.crossSize] + S.gap.conjoined;
      });

      if (prevId) {
        ctx.edges.push({
          from: prevId,
          to: firstMemberId,
          label: group[0].edgeLabel,
          kind: firstEdge || mode === 'chain' ? 'straight' : 'elbow',
        });
      }
      firstEdge = false;
      if (mode === 'chain') prevId = lastMemberId;
      cursorMain = groupMainEnd + S.gap.main;
      i = j;
      continue;
    }

    const r = placeNode(node, cursorMain, cross, ctx);
    if (prevId) {
      ctx.edges.push({
        from: prevId,
        to: r.id,
        label: node.edgeLabel,
        kind: firstEdge || mode === 'chain' ? 'straight' : 'elbow',
      });
    }
    firstEdge = false;
    if (mode === 'chain') prevId = r.id;
    crossEnd = Math.max(crossEnd, r.crossEnd);
    cursorMain = r.mainEnd + S.gap.main;
    i++;
  }

  return { mainEnd: cursorMain - S.gap.main, crossEnd };
}

// Places `node` and its whole subtree with its near corner at (main, cross).
// Returns { id, mainEnd, crossEnd }.
function placeNode(node, main, cross, ctx) {
  const A = ctx.axis;
  const number = node.kind === 'step' ? ++ctx.stepCount : null;
  const placed = pushBox(node, main, cross, ctx, number);

  let mainEnd = main + placed[A.mainSize];
  let crossEnd = cross + placed[A.crossSize];

  const annotations = node.children.filter((c) => c.kind === 'annotation');
  const rest = node.children.filter((c) => c.kind !== 'annotation');

  for (const a of annotations) {
    mainEnd += S.gap.annotation;
    const ap = pushBox(a, mainEnd, cross, ctx, null);
    mainEnd += ap[A.mainSize];
    crossEnd = Math.max(crossEnd, cross + ap[A.crossSize]);
  }
  placed.anchor = mainEnd;

  const r = placeSiblings(rest, mainEnd + S.gap.main, cross, ctx, {
    parentId: placed.id,
    mode: 'branch',
  });
  if (rest.length > 0) {
    mainEnd = r.mainEnd;
    crossEnd = Math.max(crossEnd, r.crossEnd);
  }

  return { id: placed.id, mainEnd, crossEnd };
}

export function layout(root, orientation = 'vertical') {
  const axis = AXES[orientation];
  if (!axis) {
    throw new Error(`unknown orientation "${orientation}" — expected vertical or horizontal`);
  }

  const ctx = {
    boxes: [],
    headers: [],
    edges: [],
    conjunctions: [],
    byId: new Map(),
    uid: 0,
    stepCount: 0,
    band: 0,
    axis,
  };
  const pad = S.page.padding;

  const rootPlaced = pushBox(root, pad, pad, ctx, null);

  const headers = root.children.filter((c) => c.kind === 'branch_header');
  const direct = root.children.filter((c) => c.kind !== 'branch_header');

  let maxMain = pad + rootPlaced[axis.mainSize];
  let maxCross = pad + rootPlaced[axis.crossSize];

  if (headers.length > 0) {
    let bandCross = pad;
    const headerMain = pad + rootPlaced[axis.mainSize] + S.gap.rootToHeaders;
    const headerTextWidth = S.box.maxTextWidth + 60;

    headers.forEach((h, bandIndex) => {
      ctx.band = bandIndex;
      const titleLines = wrap(h.title, S.size.header, headerTextWidth, true);
      const subLines = h.subtitle ? wrap(h.subtitle, S.size.headerSub, headerTextWidth) : [];

      const textHeight =
        titleLines.length * S.size.header * S.box.lineHeight +
        (subLines.length > 0 ? 2 + subLines.length * S.size.headerSub * S.box.lineHeight : 0);
      const textWidth = Math.ceil(Math.max(
        ...titleLines.map((l) => measure(l, S.size.header, true)),
        ...subLines.map((l) => measure(l, S.size.headerSub)),
        0,
      ));

      // A header sits before its band on the main axis in both modes: above its
      // column when vertical, left of its row when horizontal.
      const headerMainExtent = orientation === 'vertical' ? textHeight : textWidth;
      const headerCrossExtent = orientation === 'vertical' ? textWidth : textHeight;

      const at = axis.toXY(headerMain, bandCross);
      ctx.headers.push({ x: at.x, y: at.y, titleLines, subLines });

      const r = placeSiblings(
        h.children,
        headerMain + headerMainExtent + S.gap.headerToFirst,
        bandCross,
        ctx,
        { parentId: null, mode: 'chain' },
      );

      const bandCrossEnd = Math.max(r.crossEnd, bandCross + headerCrossExtent);

      maxMain = Math.max(maxMain, r.mainEnd, headerMain + headerMainExtent);
      maxCross = Math.max(maxCross, bandCrossEnd);
      bandCross = bandCrossEnd + S.gap.cross;
    });
  } else {
    const r = placeSiblings(direct, pad + rootPlaced[axis.mainSize] + S.gap.main, pad, ctx, {
      parentId: rootPlaced.id,
      mode: 'chain',
    });
    maxMain = Math.max(maxMain, r.mainEnd);
    maxCross = Math.max(maxCross, r.crossEnd);
  }

  // railAllowance goes on the cross axis, where an elbow rail hangs off the
  // last band: the right edge when vertical, the bottom edge when horizontal.
  const size = axis.toXY(
    Math.ceil(maxMain + pad),
    Math.ceil(maxCross + pad + S.page.railAllowance),
  );

  return {
    width: size.x,
    height: size.y,
    orientation,
    boxes: ctx.boxes,
    headers: ctx.headers,
    edges: ctx.edges,
    conjunctions: ctx.conjunctions,
  };
}
```

- [ ] **Step 4: Run the whole suite**

Run: `node --test docs/triage-map/*.test.mjs`
Expected: PASS, 122 tests (113 + 9 new).

**If the golden tests fail, the refactor is wrong.** Do not regenerate the goldens to make them pass — that defeats their purpose. Diff the actual output against the golden and find which arithmetic drifted.

- [ ] **Step 5: Commit**

```bash
git add docs/triage-map/layout.mjs docs/triage-map/layout.test.mjs
git commit -m "Parameterise layout on a main/cross axis pair for horizontal mode"
```

---

## Task 4: Orientation-aware edge geometry in `svg.mjs`

**Files:**
- Modify: `docs/triage-map/svg.mjs`
- Modify: `docs/triage-map/svg.test.mjs`

**Interfaces:**
- Consumes: `diagram.orientation` and `box.band` / `box.anchor` from Task 3.
- Produces: `railFor(a, b, boxes, orientation)`, `edgeSvg(edge, byId, boxes, orientation)`. `toSvg(diagram, title)` signature unchanged.

- [ ] **Step 1: Write the failing tests**

Append to `docs/triage-map/svg.test.mjs`:

```js
// ---- horizontal edge geometry ---------------------------------------------

const horizFor = (name) =>
  layout(parseTree(readFileSync(new URL(`./fixtures/${name}.tree`, import.meta.url), 'utf8')), 'horizontal');

test('a horizontal straight edge runs along x at a fixed y', () => {
  const d = horizFor('declined-transaction');
  const out = toSvg(d, 'dt');
  const straight = [...out.matchAll(/<path d="M ([\d.]+) ([\d.]+) L ([\d.]+) ([\d.]+)"/g)];
  assert.ok(straight.length > 0, 'expected at least one straight edge');
  for (const m of straight) {
    const [, x1, y1, x2, y2] = m.map(Number);
    assert.equal(y1, y2, 'a horizontal straight edge holds y constant');
    assert.ok(x2 > x1, 'and advances along x');
  }
});

test('a horizontal elbow rail runs along y and clears its band', () => {
  const d = horizFor('cc-fee-relief');
  const out = toSvg(d, 'fee');
  const byId = new Map(d.boxes.map((b) => [b.id, b]));
  const elbows = d.edges.filter((e) => e.kind === 'elbow');
  assert.ok(elbows.length > 0, 'fixture should exercise elbow routing');

  // Four-point paths are elbows. In horizontal mode the first leg moves in y.
  const paths = [...out.matchAll(
    /<path d="M ([\d.]+) ([\d.]+) L ([\d.]+) ([\d.]+) L ([\d.]+) ([\d.]+) L ([\d.]+) ([\d.]+)"/g,
  )];
  assert.equal(paths.length, elbows.length);
  for (const m of paths) {
    const [, x1, y1, x2, y2, x3, y3] = m.map(Number);
    assert.equal(x1, x2, 'first leg holds x, moving out in y');
    assert.ok(y2 > y1, 'and moves away from the box');
    assert.equal(y2, y3, 'second leg travels along x at the rail');
  }

  for (const edge of elbows) {
    const a = byId.get(edge.from);
    const deepest = d.boxes
      .filter((b) => b.band === a.band)
      .reduce((m, b) => Math.max(m, b.y + b.h), 0);
    assert.ok(
      d.height >= deepest + S.box.elbowClearance,
      'diagram must leave room for a rail below the last band',
    );
  }
});

test('horizontal still tags every box with its node uid', () => {
  const out = toSvg(horizFor('cc-fee-relief'), 'fee');
  const d = horizFor('cc-fee-relief');
  const uids = [...out.matchAll(/<g data-node-uid="(\d+)">/g)].map((m) => Number(m[1]));
  assert.equal(uids.length, d.boxes.length);
  assert.equal(new Set(uids).size, uids.length);
});

test('horizontal renders the AND label and colours Yes/No the same way', () => {
  const out = toSvg(horizFor('cc-fee-relief'), 'fee');
  assert.ok(out.includes('>AND<'));
  assert.ok(out.includes(S.edgeLabel.yes));
  assert.ok(out.includes(S.edgeLabel.no));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test docs/triage-map/svg.test.mjs`
Expected: FAIL — horizontal edges are still drawn with vertical geometry, so `y1 !== y2`.

- [ ] **Step 3: Replace `railFor`, `edgeSvg`, and the `toSvg` edge loop**

In `docs/triage-map/svg.mjs`, replace `railFor` and `edgeSvg` with:

```js
// A straight edge runs along the MAIN axis from the parent's anchor (past any
// annotation stack) to the child's near edge, held at a fixed inset on the
// cross axis. An elbow leaves the parent's far CROSS edge, runs out to a rail
// clear of every box in its band, travels along MAIN, and enters the child's
// far cross edge.
function railFor(a, b, boxes, orientation) {
  const vertical = orientation !== 'horizontal';
  const mainStart = vertical ? Math.min(a.y, b.y) : Math.min(a.x, b.x);
  const mainStop = vertical
    ? Math.max(a.y + a.h, b.y + b.h)
    : Math.max(a.x + a.w, b.x + b.w);
  let rail = vertical
    ? Math.max(a.x + a.w, b.x + b.w)
    : Math.max(a.y + a.h, b.y + b.h);

  for (const box of boxes) {
    // Only boxes in the same band matter. Scanning the whole diagram would push
    // the rail across into the next band.
    if (box.band !== a.band) continue;
    const start = vertical ? box.y : box.x;
    const stop = vertical ? box.y + box.h : box.x + box.w;
    if (start < mainStop && stop > mainStart) {
      rail = Math.max(rail, vertical ? box.x + box.w : box.y + box.h);
    }
  }
  return rail + S.box.elbowClearance;
}

function edgeSvg(edge, byId, boxes, orientation) {
  const a = byId.get(edge.from);
  const b = byId.get(edge.to);
  if (!a || !b) return '';

  const vertical = orientation !== 'horizontal';
  const stroke = `stroke="${S.stroke.edge}" stroke-width="1" fill="none"`;
  const out = [];
  let labelX;
  let labelY;

  if (edge.kind === 'straight') {
    if (vertical) {
      const x = a.x + 26;
      const startY = a.anchor ?? a.y + a.h;
      out.push(`<path d="M ${x} ${startY} L ${x} ${b.y}" ${stroke}/>`);
      labelX = x + 8;
      labelY = (startY + b.y) / 2 + 4;
    } else {
      const y = a.y + 26;
      const startX = a.anchor ?? a.x + a.w;
      out.push(`<path d="M ${startX} ${y} L ${b.x} ${y}" ${stroke}/>`);
      labelX = (startX + b.x) / 2;
      labelY = y - 8;
    }
  } else {
    const rail = railFor(a, b, boxes, orientation);
    if (vertical) {
      const ay = a.y + a.h / 2;
      const by = b.y + b.h / 2;
      out.push(
        `<path d="M ${a.x + a.w} ${ay} L ${rail} ${ay} L ${rail} ${by} L ${b.x + b.w} ${by}" ${stroke}/>`,
      );
      labelX = rail + 6;
      labelY = (ay + by) / 2 + 4;
    } else {
      const ax = a.x + a.w / 2;
      const bx = b.x + b.w / 2;
      out.push(
        `<path d="M ${ax} ${a.y + a.h} L ${ax} ${rail} L ${bx} ${rail} L ${bx} ${b.y + b.h}" ${stroke}/>`,
      );
      labelX = (ax + bx) / 2;
      labelY = rail + 14;
    }
  }

  if (edge.label) {
    out.push(
      `<text x="${labelX}" y="${labelY}" font-family="${S.font}" font-size="${S.size.edgeLabel}" ` +
      `font-weight="700" fill="${edgeLabelColor(edge.label)}">${esc(edge.label)}</text>`,
    );
  }

  return out.join('\n');
}
```

Then in `toSvg`, pass the orientation through:

```js
  for (const edge of diagram.edges) {
    parts.push(edgeSvg(edge, byId, diagram.boxes, diagram.orientation));
  }
```

- [ ] **Step 4: Run the whole suite**

Run: `node --test docs/triage-map/*.test.mjs`
Expected: PASS, 126 tests (122 + 4 new). Golden tests must still pass — the vertical branches are byte-identical to before.

- [ ] **Step 5: Render both orientations and look at them**

```bash
node -e "
Promise.all([
  import('./docs/triage-map/parse.mjs'),
  import('./docs/triage-map/layout.mjs'),
  import('./docs/triage-map/svg.mjs'),
]).then(([P, L, V]) => {
  const { readFileSync, writeFileSync, mkdirSync } = require('fs');
  mkdirSync('docs/triage-map/out', { recursive: true });
  for (const name of ['cc-fee-relief', 'declined-transaction']) {
    const t = P.parseTree(readFileSync('docs/triage-map/fixtures/' + name + '.tree', 'utf8'));
    for (const o of ['vertical', 'horizontal']) {
      const d = L.layout(t, o);
      writeFileSync('docs/triage-map/out/' + name + '.' + o + '.svg', V.toSvg(d, name));
      console.log(name, o, d.width + 'x' + d.height);
    }
  }
});
"
```

Then rasterise the horizontal ones with headless Chrome sized to the SVG and inspect. `qlmanage` pads to a square and crops wide diagrams, which is misleading:

```bash
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
"$CHROME" --headless --disable-gpu --screenshot=/tmp/fee-h.png --window-size=1200,1600 \
  "file://$PWD/docs/triage-map/out/cc-fee-relief.horizontal.svg"
```

Expect the spec's warning to bite: **every gap value was tuned by eye on vertical output**, so horizontal will need a round of adjustment. Record what looks wrong; tune only `style.mjs`, never the emitter. Any gap change will fail the golden tests, which is correct — vertical must not shift. If a token needs to differ per orientation, split it (e.g. `gap.mainHorizontal`) rather than changing the shared value.

- [ ] **Step 6: Commit**

```bash
git add docs/triage-map/svg.mjs docs/triage-map/svg.test.mjs
git commit -m "Make edge geometry orientation-aware"
```

---

## Task 5: Sheet column D and snapshot passthrough

**Files:**
- Modify: `docs/triage-map/render.mjs`
- Modify: `docs/triage-map/render.test.mjs`
- Modify: `docs/triage-map/data/trees.json`
- Sheet: `Trees` gains column D

**Interfaces:**
- Consumes: `layout(root, orientation)` from Task 3.
- Produces: `renderAll(trees)` honouring each row's `orientation`; `data/trees.json` entries shaped `{ procedure, tree_dsl, orientation? }`.

- [ ] **Step 1: Write the failing tests**

Append to `docs/triage-map/render.test.mjs`:

```js
test('renderAll honours a row orientation', () => {
  const dsl = 'P\n  # A\n    - one\n  # B\n    - two\n';
  const [v] = renderAll([{ procedure: 'V', tree_dsl: dsl, orientation: 'vertical' }]);
  const [h] = renderAll([{ procedure: 'H', tree_dsl: dsl, orientation: 'horizontal' }]);

  const dims = (svg) => svg.match(/width="(\d+)" height="(\d+)"/).slice(1).map(Number);
  const [vw, vh] = dims(v.svg);
  const [hw, hh] = dims(h.svg);
  assert.ok(vw > vh, 'two side-by-side bands are wide when vertical');
  assert.ok(hh > hw, 'and tall when horizontal');
});

test('renderAll defaults a missing orientation to vertical', () => {
  const dsl = 'P\n  # A\n    - one\n  # B\n    - two\n';
  const [none] = renderAll([{ procedure: 'N', tree_dsl: dsl }]);
  const [explicit] = renderAll([{ procedure: 'N', tree_dsl: dsl, orientation: 'vertical' }]);
  assert.equal(none.svg, explicit.svg);
});

test('renderAll reports the procedure when an orientation is invalid', () => {
  assert.throws(
    () => renderAll([{ procedure: 'Bad', tree_dsl: 'P\n  - one\n', orientation: 'sideways' }]),
    /Bad/,
  );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test docs/triage-map/render.test.mjs`
Expected: FAIL — orientation is ignored, so vertical and horizontal produce identical SVG.

- [ ] **Step 3: Pass orientation through `render.mjs`**

In `docs/triage-map/render.mjs`, replace the body of `renderAll`:

```js
export function renderAll(trees) {
  const out = [];
  for (const row of trees) {
    if (!row.tree_dsl || row.tree_dsl.trim() === '') continue;
    const orientation = row.orientation === 'horizontal' ? 'horizontal' : row.orientation || 'vertical';
    try {
      out.push({
        slug: slugify(row.procedure),
        procedure: row.procedure,
        orientation,
        svg: toSvg(layout(parseTree(row.tree_dsl), orientation), row.procedure),
      });
    } catch (err) {
      if (err instanceof ParseError) {
        throw new Error(`Tree for "${row.procedure}" failed to parse:\n${err.message}`);
      }
      throw new Error(`Tree for "${row.procedure}" failed to render: ${err.message}`);
    }
  }
  return out;
}
```

The `catch` now wraps non-parse errors too, so an invalid orientation names the offending procedure instead of surfacing a bare `unknown orientation`.

- [ ] **Step 4: Run the whole suite**

Run: `node --test docs/triage-map/*.test.mjs`
Expected: PASS, 129 tests (126 + 3 new).

- [ ] **Step 5: Add column D to the sheet**

Write the header:

```
mcp__mcplocker__google_sheets_update
  spreadsheet_id: 1Uc8QcM0zA9Dvv0vVnZ-oD3ueESg1D7ZNXXpRRxFRGto
  range: Trees!D1
  values: [["orientation"]]
```

Add validation with `mcp__mcplocker__google_sheets_set_data_validation` on sheet_id `1127549887`, `start_row: 1`, `end_row: 1000`, `start_column: 3`, `end_column: 4`, `condition_type: ONE_OF_LIST`, `condition_values: ["vertical", "horizontal"]`, `show_dropdown: true`, `strict: true`, and this input message:

```
Which way this map flows. vertical = branch headers side by side as columns, children downward. horizontal = headers stacked as rows, children rightward. Blank means vertical. This is a view preference, so changing it does not update last_reviewed.
```

Leave existing rows blank — blank means vertical.

- [ ] **Step 6: Refresh the snapshot and re-render**

Read `Trees!A2:D100` with `mcp__mcplocker__google_sheets_get` and rewrite `docs/triage-map/data/trees.json` as an array of `{ procedure, tree_dsl, orientation }`, preserving newlines in `tree_dsl` and omitting `orientation` when the cell is blank.

Run: `node docs/triage-map/render.mjs`
Expected: `Rendered 1 diagram(s)` (only Declined Transaction remains in the sheet).

- [ ] **Step 7: Commit**

```bash
git add docs/triage-map/render.mjs docs/triage-map/render.test.mjs docs/triage-map/data/trees.json
git commit -m "Thread per-map orientation through the render pipeline"
```

---

## Task 6: Editor zoom and orientation toggle

**Files:**
- Modify: `docs/triage-map/web/index.html`
- Modify: `docs/triage-map/web/app.js.in`

**Interfaces:**
- Consumes: `T.layout(tree, orientation)` from the bundle.
- Produces: the deployable pair `vendor.js` + `app.js`.

No unit tests — this is the DOM-coupled file. Step 6 is a verification checklist.

- [ ] **Step 1: Add the controls and scaler to `index.html`**

Replace the `.bar` block's tail (from `<button id="redo">` through `</div>`) with:

```html
    <button id="redo">Redo</button>
    <span style="width:1px;height:20px;background:#E5E2DC"></span>
    <select id="orient" title="Orientation">
      <option value="vertical">Vertical</option>
      <option value="horizontal">Horizontal</option>
    </select>
    <span style="width:1px;height:20px;background:#E5E2DC"></span>
    <button id="zoomOut">&minus;</button>
    <span id="zoomLabel">100%</span>
    <button id="zoomIn">+</button>
    <button id="zoomFit">Fit</button>
    <button id="zoomReset">Actual</button>
    <span class="spacer"></span>
    <span id="status"></span>
  </div>
```

Replace the canvas block with a scaler wrapper:

```html
  <div class="canvas" id="canvas"><div id="scaler"></div><div id="editor">
    <input id="fTitle" placeholder="title">
    <input id="fSub" placeholder="subtitle (optional)">
    <input id="fLabel" placeholder="edge label (outcomes only)">
    <div class="hint">⏎ save · Esc cancel</div>
  </div></div>
```

Add to the `<style>` block:

```css
  #scaler { transform-origin: top left; }
  #zoomLabel { font-size: 12px; color: #7A756C; min-width: 46px; text-align: center; }
```

- [ ] **Step 2: Add zoom and orientation to `app.js.in`**

Add `zoom: 1` to the `state` object:

```js
var state = {
  rows: [],        // { rowNumber, procedure, dsl, tree, error, remote, orientation }
  active: -1,
  selected: null,  // uid
  undo: {},        // rowNumber -> { stack: [dsl], pos }
  timers: {},      // rowNumber -> timeout id
  readOnly: false,
  zoom: 1,
};
```

In `load`, widen the range and read column D:

```js
  return mcp('google_sheets_get', { spreadsheet_id: SHEET, range: 'Trees!A2:D100' })
```

and inside the row loop, replace the `entry` construction:

```js
        var entry = {
          rowNumber: i + 2, procedure: row[0], dsl: dsl,
          tree: null, error: null, remote: dsl,
          orientation: row[3] === 'horizontal' ? 'horizontal' : 'vertical',
        };
```

Replace `renderCanvas` so it draws into `#scaler` and honours orientation:

```js
function renderCanvas() {
  var row = current();
  var scaler = el('scaler');
  scaler.innerHTML = '';
  hideEditor();
  if (!row) { syncToolbar(); return; }

  if (row.error) {
    var p = document.createElement('div');
    p.style.padding = '12px';
    p.style.color = '#8C2A1A';
    p.style.whiteSpace = 'pre-wrap';
    p.textContent = 'This tree does not parse, so it cannot be edited here:\n\n' + row.error;
    scaler.appendChild(p);
    syncToolbar();
    return;
  }

  var diagram = T.layout(row.tree, row.orientation);
  var holder = document.createElement('div');
  holder.innerHTML = T.toSvg(diagram, row.procedure);
  var svg = holder.firstElementChild;
  scaler.appendChild(svg);

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

  applyZoom();
  validateCurrent();
  syncToolbar();
}
```

Add the zoom functions just above `validateCurrent`:

```js
// ---- zoom -----------------------------------------------------------------
function currentSvg() { return el('scaler').querySelector('svg'); }

function applyZoom() {
  var svg = currentSvg();
  var scaler = el('scaler');
  if (!svg) { scaler.style.transform = ''; scaler.style.width = ''; scaler.style.height = ''; return; }
  var w = Number(svg.getAttribute('width'));
  var h = Number(svg.getAttribute('height'));
  scaler.style.transform = 'scale(' + state.zoom + ')';
  // Reserve laid-out space for the scaled content so the scrollbars behave.
  scaler.style.width = (w * state.zoom) + 'px';
  scaler.style.height = (h * state.zoom) + 'px';
  el('zoomLabel').textContent = Math.round(state.zoom * 100) + '%';
}

function setZoom(z) {
  state.zoom = Math.min(4, Math.max(0.15, z));
  applyZoom();
}

function fitWidth() {
  var svg = currentSvg();
  if (!svg) return;
  var available = el('canvas').clientWidth - 24;
  setZoom(available / Number(svg.getAttribute('width')));
}
```

In `showEditor`, scale the popup position — without this it drifts off its box as you zoom:

```js
  ed.style.left = ((Number(box.getAttribute('x')) + 6) * state.zoom) + 'px';
  ed.style.top = ((Number(box.getAttribute('y')) + 6) * state.zoom) + 'px';
```

Add orientation persistence just above the `// ---- wiring` comment:

```js
// ---- orientation ----------------------------------------------------------
// A view preference, not content: it skips the clobber check (losing a
// concurrent flip is harmless) and does not stamp last_reviewed.
function setOrientation(value) {
  var row = current();
  if (!row || !row.tree || state.readOnly) return;
  if (row.orientation === value) return;
  row.orientation = value;
  renderCanvas();
  fitWidth();
  status('saving…');
  mcp('google_sheets_batch_update_values', {
    spreadsheet_id: SHEET,
    value_input_option: 'RAW',
    data: [{ range: 'Trees!D' + row.rowNumber, values: [[value]] }],
  }).then(function () {
    status('saved');
    setTimeout(function () { if (el('status').textContent === 'saved') status(''); }, 1500);
  }).catch(function (e) {
    status('');
    banner('err', 'Could not save orientation: ' + e.message);
  });
}
```

In `syncToolbar`, add orientation and zoom handling. The orientation select is enabled whenever a valid tree is loaded, independent of selection:

```js
function syncToolbar() {
  var row = current();
  var has = !!(row && row.tree && state.selected);
  ['kind', 'addChild', 'addSib', 'del'].forEach(function (id) {
    el(id).disabled = state.readOnly || !has;
  });

  var loaded = !!(row && row.tree);
  el('orient').disabled = state.readOnly || !loaded;
  if (loaded) el('orient').value = row.orientation;
  ['zoomIn', 'zoomOut', 'zoomFit', 'zoomReset'].forEach(function (id) {
    el(id).disabled = !loaded;
  });

  var u = row ? state.undo[row.rowNumber] : null;
  el('undo').disabled = state.readOnly || !u || u.pos <= 0;
  el('redo').disabled = state.readOnly || !u || u.pos >= u.stack.length - 1;
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
```

Wire the new controls in the wiring section:

```js
el('orient').onchange = function () { setOrientation(el('orient').value); };
el('zoomIn').onclick = function () { setZoom(state.zoom * 1.25); };
el('zoomOut').onclick = function () { setZoom(state.zoom / 1.25); };
el('zoomFit').onclick = fitWidth;
el('zoomReset').onclick = function () { setZoom(1); };
window.addEventListener('resize', fitWidth);
```

Finally, refit when switching procedure. In `renderNav`, replace the nav button's click handler:

```js
    b.onclick = function () {
      state.active = i;
      state.selected = null;
      renderNav();
      renderCanvas();
      fitWidth();
    };
```

and at the end of `load`'s success path, after `renderCanvas()`, add `fitWidth();`.

- [ ] **Step 3: Build and syntax-check**

```bash
node docs/triage-map/bundle.mjs
cp docs/triage-map/web/index.html docs/triage-map/out/web/index.html
node --check docs/triage-map/out/web/vendor.js && echo "vendor.js parses"
node --check docs/triage-map/out/web/app.js && echo "app.js parses"
node --test docs/triage-map/*.test.mjs 2>&1 | grep -E "^ℹ (tests|pass|fail)"
```

Expected: both parse, 129 tests passing.

- [ ] **Step 4: Verify the shell renders locally**

```bash
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
"$CHROME" --headless --disable-gpu --virtual-time-budget=3000 --dump-dom \
  "file://$PWD/docs/triage-map/out/web/index.html" 2>/dev/null > /tmp/dom.html
grep -o 'id="procCount"[^>]*>[^<]*' /tmp/dom.html | head -1
grep -c 'disabled=""' /tmp/dom.html
grep -ci "is not a function\|cannot read" /tmp/dom.html
```

Expected: `0 procedures`, **11** disabled controls (4 node controls + undo + redo + orient + 4 zoom), and `0` errors. A `file://` page has no `MagicTools`, so read-only mode is the correct local behaviour.

- [ ] **Step 5: Commit**

```bash
git add docs/triage-map/web/index.html docs/triage-map/web/app.js.in
git commit -m "Add canvas zoom and a per-map orientation toggle to the editor"
```

- [ ] **Step 6: Manual verification checklist (after Task 7 publishes)**

Deferred to Task 7 Step 3, since these need the live site.

---

## Task 7: Republish and verify

**Files:**
- Modify: `docs/triage-map/README.md`

**Interfaces:**
- Consumes: `out/web/vendor.js`, `out/web/app.js`, `web/index.html`.
- Produces: the updated live editor.

- [ ] **Step 1: Clean rebuild**

```bash
rm -rf docs/triage-map/out
node docs/triage-map/render.mjs
node docs/triage-map/bundle.mjs
cp docs/triage-map/web/index.html docs/triage-map/out/web/index.html
node --test docs/triage-map/*.test.mjs 2>&1 | grep -E "^ℹ (tests|pass|fail)"
wc -c docs/triage-map/out/web/index.html docs/triage-map/out/web/vendor.js docs/triage-map/out/web/app.js
```

Expected: 129 tests passing. Note the three byte sizes for verification.

- [ ] **Step 2: Upload all three files and verify**

`vendor.js` changed this time (style, layout and svg all moved), so unlike the last republish both scripts need pushing. Use `magic_file_write` for each of `index.html`, `vendor.js`, `app.js` on site `wocoo-triage-map`, then call `magic_file_list` and confirm all three sizes match Step 1 exactly.

If a size is off by a byte or two, it is almost certainly a stray blank line at the end of the file — fix with `magic_file_edit` rather than re-uploading, and re-check. Do **not** verify with `curl`: unauthenticated requests get a `307` to Okta sign-in.

- [ ] **Step 3: Manual verification on the live site**

Open <https://magic.w10e.com/albert.cai/wocoo-triage-map> and confirm:

1. Declined Transaction loads and renders vertically, fitted to the pane width
2. `Fit` / `+` / `−` / `Actual` change the zoom, and the label tracks the percentage
3. At 200% zoom, double-clicking a box opens the inline editor **on that box**, not offset from it
4. At 200% zoom, dragging still targets the box under the cursor
5. Switching orientation to Horizontal re-renders with the header left of its row and steps flowing rightward
6. `Trees!D3` in the sheet now reads `horizontal`
7. `Trees!C3` (`last_reviewed`) is **unchanged** by the orientation flip
8. Reloading the page keeps the horizontal orientation
9. Editing a node's text still saves, and stamps `last_reviewed`
10. Creating a new procedure gives a vertical map by default

- [ ] **Step 4: Update the README**

Add after the "Hosted editor" intro paragraph:

```markdown
Each map has an **orientation** — `vertical` (branch headers side by side as
columns, children flowing down) or `horizontal` (headers stacked as rows,
children flowing right), stored per map in `Trees` column D and shared with
everyone. Blank means vertical. Flipping it does not stamp `last_reviewed` and is
exempt from clobber detection, because losing a concurrent view-preference flip
is harmless.

Which orientation reads better depends on the tree's shape: many branch headers
go wide when vertical and tall when horizontal, and a linear checklist does the
opposite. Wide diagrams force horizontal scrolling, so the toggle earns its keep
in both directions.

The canvas has zoom controls (`−` / `+` / `Fit` / `Actual`).
```

Then update the sync runbook range from `Trees!A2:B100` to `Trees!A2:D100`, and note that snapshot entries carry `orientation`.

- [ ] **Step 5: Commit**

```bash
git add docs/triage-map/README.md
git commit -m "Document per-map orientation and canvas zoom"
```

---

## Self-Review

**Spec coverage:**

| spec requirement | task |
|---|---|
| Axis table (main/cross per orientation) | Task 3 `AXES` + `placeSiblings` / `placeNode` |
| Boxes never transpose | Task 3 — `boxFor` copied unchanged |
| Header offset symmetric | Task 3 `headerMainExtent` / `headerCrossExtent` |
| Renames `anchorY`→`anchor`, `col`→`band`, gaps, `railAllowance` | Task 2 |
| `layout(root, orientation)` carrying orientation on the diagram | Task 3 |
| `toSvg` reads `diagram.orientation`, no new parameter | Task 4 |
| `railFor` intersects on main, scans same band | Task 4 |
| Golden-file guard | Task 1, including Step 4 proving it fails |
| Vertical output unchanged | Task 1 guard, re-run in Tasks 2, 3, 4 |
| `Trees` column D, validation, blank = vertical | Task 5 Step 5 |
| Orientation skips `last_reviewed` and clobber detection | Task 6 `setOrientation` |
| Load range `A2:D100` | Task 6 Step 2 |
| Orientation control enabled without a selection | Task 6 `syncToolbar` |
| Zoom controls as CSS transform | Task 6 `applyZoom` |
| Inline editor scales its position | Task 6 Step 2, verified at 200% in Task 7 Step 3 item 3 |
| Zoom refits on procedure change and orientation flip | Task 6 — `fitWidth()` in nav click, `setOrientation`, `load` |
| Snapshot carries orientation; default vertical | Task 5 Steps 3, 6 |
| Both bundles pushed | Task 7 Step 2 |
| Testing table | Tasks 1, 3, 4, 5; manual in Task 7 |

**Gap found and closed:** the spec's testing table asks for "diagram bounds leave room for a rail hanging off the last band" in horizontal mode. Task 4's elbow test asserts `d.height >= deepest + elbowClearance`, which covers it.

**Error found and corrected while writing this plan:** an early draft asserted CC Fee Relief becomes taller than wide when horizontal. That is false. A band's cross extent in horizontal mode is its *tallest single box*, not the sum of its nodes, so four bands is roughly 700px tall rather than 1400 — the diagram narrows and gains some height but stays landscape. Only a linear chain reverses orientation outright. The spec's estimate table has been replaced with the structural claims that actually hold, and Task 3's dimension test now asserts only those. The multi-band assertions (`h.width < v.width`, `h.height > v.height`) are expected to hold for this fixture but are not structurally guaranteed in general; if they fail, Task 4 Step 5 prints the real dimensions — trust those and adjust the test, recording the measured numbers.

**Anticipated failure, deliberately not pre-solved:** horizontal gap tuning. Every value in `S.gap` was tuned by eye on vertical output, so the first horizontal render will need adjustment. Task 4 Step 5 makes that an explicit step with a rule attached — tune `style.mjs` only, and if a token must differ per orientation, split it rather than changing the shared value, because changing a shared value fails the golden tests.

**Placeholder scan:** no TBDs, no "handle errors appropriately", no "similar to Task N". Every code step carries complete code.

**Type consistency:** `layout(root, orientation)` returns `orientation`; `toSvg` reads `diagram.orientation` and passes it to `edgeSvg(edge, byId, boxes, orientation)` and thence `railFor(a, b, boxes, orientation)`. Boxes expose `x`, `y`, `w`, `h`, `anchor`, `band`, `nodeUid` — `anchor` and `band` are established in Task 2 and consumed in Tasks 3 and 4. `placeNode` returns `{ id, mainEnd, crossEnd }` and `placeSiblings` returns `{ mainEnd, crossEnd }`, consumed only within `layout.mjs`. `renderAll` rows are `{ procedure, tree_dsl, orientation? }` in Task 5 and produced by the Task 5 Step 6 snapshot. The glue calls `T.layout(row.tree, row.orientation)` with `row.orientation` set in `load`.
