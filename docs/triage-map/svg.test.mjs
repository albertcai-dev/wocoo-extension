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

test('emits one path per edge', () => {
  const diagram = diagramFor('declined-ppmc');
  const out = toSvg(diagram, 'ppmc');
  const paths = out.match(/<path /g) || [];
  assert.equal(paths.length, diagram.edges.length);
});
