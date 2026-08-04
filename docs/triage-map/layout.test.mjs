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
  assert.ok(decision.anchorY > decision.y + decision.h, 'anchor should sit below the box');
  assert.ok(
    decision.anchorY >= annotation.y + annotation.h,
    'anchor should clear the annotation so edges do not cross it',
  );
});

test('a node without annotations anchors at its own bottom edge', () => {
  const d = layout(load('declined-ppmc'));
  const step = d.boxes.find((b) => b.kind === 'step');
  assert.equal(step.anchorY, step.y + step.h);
});

test('root-level steps are chained to each other, not all to the root', () => {
  const d = layout(load('declined-ppmc'));
  const root = d.boxes[0];
  const fromRoot = d.edges.filter((e) => e.from === root.id);
  assert.equal(fromRoot.length, 1, 'root should link only to the first step');
});
