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
  for (const name of ['cc-fee-relief', 'declined-ppmc', 'declined-transaction']) {
    const d = layout(load(name));
    for (let i = 0; i < d.boxes.length; i++) {
      for (let j = i + 1; j < d.boxes.length; j++) {
        const a = d.boxes[i];
        const b = d.boxes[j];
        const disjoint =
          a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
        assert.ok(disjoint, `${name}: boxes ${a.id} and ${b.id} overlap`);
      }
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

test('sibling steps under a branch header are chained by edges', () => {
  const d = layout(load('declined-transaction'));
  const steps = d.boxes.filter((b) => b.kind === 'step');
  assert.equal(steps.length, 3);
  // Every step after the first has an incoming edge, and so does the decision.
  for (const s of steps.slice(1)) {
    assert.ok(d.edges.some((e) => e.to === s.id), `step ${s.id} should be chained`);
  }
  const decision = d.boxes.find((b) => b.kind === 'decision');
  assert.ok(d.edges.some((e) => e.to === decision.id), 'decision should be chained to the last step');
});

test('a node with annotations anchors its outgoing edges below the annotation', () => {
  const d = layout(load('cc-fee-relief'));
  const decision = d.boxes.find((b) => b.kind === 'decision');
  const annotation = d.boxes.find((b) => b.kind === 'annotation');
  assert.ok(decision.anchor > decision.y + decision.h, 'anchor should sit below the box');
  assert.ok(
    decision.anchor >= annotation.y + annotation.h,
    'anchor should clear the annotation so edges do not cross it',
  );
});

test('a node without annotations anchors at its own bottom edge', () => {
  const d = layout(load('declined-ppmc'));
  const step = d.boxes.find((b) => b.kind === 'step');
  assert.equal(step.anchor, step.y + step.h);
});

test('root-level steps are chained to each other, not all to the root', () => {
  const d = layout(load('declined-ppmc'));
  const root = d.boxes[0];
  const fromRoot = d.edges.filter((e) => e.from === root.id);
  assert.equal(fromRoot.length, 1, 'root should link only to the first step');
});

test('each box carries the uid of the node it came from', () => {
  const tree = load('declined-ppmc');
  const d = layout(tree);
  const treeUids = [];
  (function walk(n) { treeUids.push(n.uid); n.children.forEach(walk); })(tree);
  const boxUids = d.boxes.map((b) => b.nodeUid);
  assert.equal(boxUids.length, treeUids.length);
  for (const uid of boxUids) {
    assert.equal(typeof uid, 'number', 'every box must carry a numeric uid');
    assert.ok(uid > 0, 'uids are 1-based');
  }
  assert.deepEqual([...boxUids].sort((a, b) => a - b), [...treeUids].sort((a, b) => a - b));
});

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
