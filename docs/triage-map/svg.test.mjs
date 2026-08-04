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
      .filter((box) => box.col === a.col && box.y < bottom && box.y + box.h > top)
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
  const colStart = new Map();
  for (const box of diagram.boxes) {
    const cur = colStart.get(box.col);
    if (cur === undefined || box.x < cur) colStart.set(box.col, box.x);
  }

  for (const edge of diagram.edges.filter((e) => e.kind === 'elbow')) {
    const a = byId.get(edge.from);
    const nextStart = colStart.get(a.col + 1);
    if (nextStart === undefined) continue;
    const widest = diagram.boxes
      .filter((box) => box.col === a.col)
      .reduce((m, box) => Math.max(m, box.x + box.w), 0);
    assert.ok(
      widest + S.box.elbowClearance < nextStart,
      `rail for column ${a.col} would cross into column ${a.col + 1}`,
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
