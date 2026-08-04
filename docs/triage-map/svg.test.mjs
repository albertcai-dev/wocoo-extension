import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseTree } from './parse.mjs';
import { layout } from './layout.mjs';
import { toSvg } from './svg.mjs';
import { S } from './style.mjs';

const diagramFor = (name) =>
  layout(parseTree(readFileSync(new URL(`./fixtures/${name}.tree`, import.meta.url), 'utf8')));

const render = (name) => toSvg(diagramFor(name), name);

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
  assert.ok(!out.includes('<Q>'), 'raw angle brackets from content must not survive');
});

test('an elbow rail clears every box in its own column that it passes', () => {
  const diagram = diagramFor('cc-fee-relief');
  const out = toSvg(diagram, 'fee');
  const byId = new Map(diagram.boxes.map((b) => [b.id, b]));
  const rails = [...out.matchAll(/<path d="M [\d.]+ [\d.]+ L ([\d.]+) /g)].map((m) => Number(m[1]));

  const elbows = diagram.edges.filter((e) => e.kind === 'elbow');
  assert.ok(elbows.length > 0, 'fixture should exercise elbow routing');

  for (const edge of elbows) {
    const a = byId.get(edge.from);
    const b = byId.get(edge.to);
    const top = Math.min(a.y, b.y);
    const bottom = Math.max(a.y + a.h, b.y + b.h);
    const widest = diagram.boxes
      .filter((box) => box.band === a.band && box.y < bottom && box.y + box.h > top)
      .reduce((m, box) => Math.max(m, box.x + box.w), 0);
    assert.ok(
      rails.some((r) => r > widest),
      'expected a rail beyond the widest crossed box in the column',
    );
  }
});

test('an elbow rail never reaches into the next column', () => {
  const diagram = diagramFor('cc-fee-relief');
  const byId = new Map(diagram.boxes.map((b) => [b.id, b]));

  // Leftmost box x per column, so we know where each next column begins.
  const bandStart = new Map();
  for (const box of diagram.boxes) {
    const cur = bandStart.get(box.band);
    if (cur === undefined || box.x < cur) bandStart.set(box.band, box.x);
  }

  for (const edge of diagram.edges.filter((e) => e.kind === 'elbow')) {
    const a = byId.get(edge.from);
    const nextStart = bandStart.get(a.band + 1);
    if (nextStart === undefined) continue;
    const widest = diagram.boxes
      .filter((box) => box.band === a.band)
      .reduce((m, box) => Math.max(m, box.x + box.w), 0);
    assert.ok(
      widest + S.box.elbowClearance < nextStart,
      `rail for column ${a.band} would cross into column ${a.band + 1}`,
    );
  }
});

test('diagram width leaves room for a rail hanging off the last column', () => {
  const diagram = diagramFor('cc-fee-relief');
  const rightmost = diagram.boxes.reduce((m, b) => Math.max(m, b.x + b.w), 0);
  assert.ok(
    diagram.width >= rightmost + S.box.elbowClearance + 30,
    'width should accommodate the rail and its edge label',
  );
});

test('emits one path per edge', () => {
  const diagram = diagramFor('declined-ppmc');
  const out = toSvg(diagram, 'ppmc');
  const paths = out.match(/<path /g) || [];
  assert.equal(paths.length, diagram.edges.length);
});

test('every box is wrapped in a g carrying its node uid', () => {
  const diagram = diagramFor('declined-ppmc');
  const out = toSvg(diagram, 'ppmc');
  const uids = [...out.matchAll(/<g data-node-uid="(\d+)">/g)].map((m) => Number(m[1]));
  assert.equal(uids.length, diagram.boxes.length);
  assert.equal(new Set(uids).size, uids.length, 'uids must be unique');
});

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
  const d = horizFor('cc-fee-relief');
  const out = toSvg(d, 'fee');
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
