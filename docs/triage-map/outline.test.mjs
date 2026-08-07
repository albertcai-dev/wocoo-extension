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
