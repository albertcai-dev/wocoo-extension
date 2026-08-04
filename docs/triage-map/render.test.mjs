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

test('indexHtml inlines every diagram rather than linking a file', () => {
  const html = indexHtml([
    { slug: 'a', procedure: 'A', svg: '<svg width="10" height="10"><title>A</title></svg>' },
    { slug: 'b', procedure: 'B', svg: '<svg width="20" height="20"><title>B</title></svg>' },
  ]);
  assert.ok(html.includes('<svg width="10" height="10">'), 'first svg inlined');
  assert.ok(html.includes('<svg width="20" height="20">'), 'second svg inlined');
  assert.ok(!html.includes('.svg"'), 'must not reference external svg files');
  assert.ok(html.includes('<h2>A</h2>'));
});

test('indexHtml marks exactly one nav item and one panel active', () => {
  const html = indexHtml([
    { slug: 'a', procedure: 'A', svg: '<svg width="10" height="10"></svg>' },
    { slug: 'b', procedure: 'B', svg: '<svg width="20" height="20"></svg>' },
  ]);
  assert.equal((html.match(/class="nav-item active"/g) || []).length, 1);
  assert.equal((html.match(/class="panel active"/g) || []).length, 1);
});

test('indexHtml pluralises the procedure count', () => {
  const one = indexHtml([{ slug: 'a', procedure: 'A', svg: '<svg width="1" height="1"></svg>' }]);
  assert.ok(one.includes('1 procedure mapped'));
  const two = indexHtml([
    { slug: 'a', procedure: 'A', svg: '<svg width="1" height="1"></svg>' },
    { slug: 'b', procedure: 'B', svg: '<svg width="1" height="1"></svg>' },
  ]);
  assert.ok(two.includes('2 procedures mapped'));
});

test('indexHtml links back to the sheet as the source of truth', () => {
  const html = indexHtml([{ slug: 'a', procedure: 'A', svg: '<svg width="1" height="1"></svg>' }]);
  assert.ok(html.includes('1Uc8QcM0zA9Dvv0vVnZ-oD3ueESg1D7ZNXXpRRxFRGto'));
});

// Only the RELATIVE change is guaranteed. Transposing two bands stops them
// sitting side by side and stacks them instead, so width must fall and height
// must rise -- but the result need not end up taller than it is wide. Asserting
// `height > width` outright would be wrong.
test('renderAll honours a row orientation', () => {
  const dsl = 'P\n  # A\n    - one\n  # B\n    - two\n';
  const [v] = renderAll([{ procedure: 'V', tree_dsl: dsl, orientation: 'vertical' }]);
  const [h] = renderAll([{ procedure: 'H', tree_dsl: dsl, orientation: 'horizontal' }]);

  const dims = (svg) => svg.match(/width="(\d+)" height="(\d+)"/).slice(1).map(Number);
  const [vw, vh] = dims(v.svg);
  const [hw, hh] = dims(h.svg);
  assert.ok(hw < vw, 'stacking the bands narrows the diagram');
  assert.ok(hh > vh, 'and makes it taller');
  assert.ok(v.orientation === 'vertical' && h.orientation === 'horizontal');
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
