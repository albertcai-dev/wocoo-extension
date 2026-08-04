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
