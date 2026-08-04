import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseTree } from './parse.mjs';
import { serialize, titleProblem } from './serialize.mjs';

const fixture = (name) =>
  readFileSync(new URL(`./fixtures/${name}.tree`, import.meta.url), 'utf8');

// uid, indent and line are source-position artifacts: uid is renumbered on every
// parse, and indent/line describe where text sat in the original document. Only
// structure and content need to survive a round trip.
function normalize(node) {
  return {
    kind: node.kind,
    title: node.title,
    subtitle: node.subtitle,
    edgeLabel: node.edgeLabel,
    conjoined: node.conjoined,
    children: node.children.map(normalize),
  };
}

for (const name of ['cc-fee-relief', 'declined-ppmc', 'declined-transaction']) {
  test(`round-trips the ${name} fixture`, () => {
    const original = parseTree(fixture(name));
    const reparsed = parseTree(serialize(original));
    assert.deepEqual(normalize(reparsed), normalize(original));
  });
}

test('emits two-space indentation per depth level', () => {
  const dsl = serialize(parseTree('P\n  # H\n    ? Q?\n      Yes = Done\n'));
  const lines = dsl.split('\n');
  assert.equal(lines[0], 'P');
  assert.equal(lines[1], '  # H');
  assert.equal(lines[2], '    ? Q?');
  assert.equal(lines[3], '      Yes = Done');
});

test('emits ?AND for conjoined decisions', () => {
  const dsl = serialize(parseTree('P\n  ?AND A?\n  ?AND B?\n    Yes = Fine\n'));
  assert.ok(dsl.includes('  ?AND A?'));
  assert.ok(dsl.includes('  ?AND B?'));
});

test('emits an unlabelled outcome with a bare =', () => {
  const dsl = serialize(parseTree('P\n  ? Q?\n    = Done\n'));
  assert.ok(dsl.includes('    = Done'));
});

test('appends a subtitle after a pipe', () => {
  const dsl = serialize(parseTree('P\n  - Open dashboard | Preset 5871\n'));
  assert.ok(dsl.includes('  - Open dashboard | Preset 5871'));
});

test('emits a multi-line title as deeper-indented continuation lines', () => {
  const src = 'P\n  ? Q?\n    ~ Validate by:\n      1. BOR\n      2. NLV\n    Yes = Fine\n';
  const dsl = serialize(parseTree(src));
  const lines = dsl.split('\n');
  assert.ok(lines.includes('    ~ Validate by:'));
  assert.ok(lines.includes('      1. BOR'));
  assert.ok(lines.includes('      2. NLV'));
});

test('keeps the subtitle on the sigil line when the title also wraps', () => {
  const tree = parseTree('P\n  ~ First | Sub\n');
  tree.children[0].title = 'First\nSecond';
  const reparsed = parseTree(serialize(tree));
  assert.equal(reparsed.children[0].title, 'First\nSecond');
  assert.equal(reparsed.children[0].subtitle, 'Sub');
});

test('titleProblem rejects a pipe in a title', () => {
  assert.match(titleProblem('has | pipe', { isRoot: false }), /pipe/);
});

test('titleProblem rejects a title line that looks like a sigil', () => {
  assert.match(titleProblem('- looks like a step', { isRoot: false }), /sigil/);
  assert.match(titleProblem('ok\n? looks like a decision', { isRoot: false }), /sigil/);
  assert.match(titleProblem('Yes = looks like an outcome', { isRoot: false }), /sigil/);
});

test('titleProblem accepts ordinary text', () => {
  assert.equal(titleProblem('Is the posted fee $20 or $220?', { isRoot: false }), null);
  assert.equal(titleProblem('CC Fee Relief', { isRoot: true }), null);
});

test('titleProblem rejects an empty title', () => {
  assert.match(titleProblem('   ', { isRoot: false }), /empty/);
});
