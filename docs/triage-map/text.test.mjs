import { test } from 'node:test';
import assert from 'node:assert/strict';
import { measure, wrap } from './text.mjs';

test('measure grows with text length', () => {
  assert.ok(measure('ab', 14) > measure('a', 14));
});

test('measure grows with font size', () => {
  assert.ok(measure('hello', 20) > measure('hello', 14));
});

test('measure treats narrow glyphs as narrower than wide ones', () => {
  assert.ok(measure('iii', 14) < measure('mmm', 14));
});

test('wrap keeps every line within maxWidth', () => {
  const text = 'Did AUM drop below one hundred thousand dollars three days before the statement date';
  const lines = wrap(text, 14, 200);
  assert.ok(lines.length > 1, 'expected the text to wrap');
  for (const line of lines) {
    assert.ok(measure(line, 14) <= 200, `line exceeded maxWidth: ${line}`);
  }
});

test('wrap preserves hard newlines as separate lines', () => {
  const lines = wrap('first\nsecond', 14, 500);
  assert.deepEqual(lines, ['first', 'second']);
});

test('wrap does not drop a word that alone exceeds maxWidth', () => {
  const lines = wrap('short enormouslylongsingleword', 14, 40);
  assert.ok(lines.join(' ').includes('enormouslylongsingleword'));
});
