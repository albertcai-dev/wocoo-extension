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
