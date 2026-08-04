import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseTree, ParseError } from './parse.mjs';

const fixture = (name) =>
  readFileSync(new URL(`./fixtures/${name}.tree`, import.meta.url), 'utf8');

test('root is the first line with no sigil', () => {
  const root = parseTree('My Procedure\n  - do a thing\n');
  assert.equal(root.kind, 'root');
  assert.equal(root.title, 'My Procedure');
  assert.equal(root.children.length, 1);
});

test('pipe splits title from subtitle', () => {
  const root = parseTree('P\n  - Open dashboard | Preset 5871\n');
  const step = root.children[0];
  assert.equal(step.kind, 'step');
  assert.equal(step.title, 'Open dashboard');
  assert.equal(step.subtitle, 'Preset 5871');
});

test('every sigil maps to its kind', () => {
  const root = parseTree([
    'P',
    '  # Header',
    '    ? Question?',
    '      ~ Note',
    '      Yes = Good',
    '      No = Bad',
  ].join('\n'));
  const header = root.children[0];
  assert.equal(header.kind, 'branch_header');
  const decision = header.children[0];
  assert.equal(decision.kind, 'decision');
  assert.deepEqual(decision.children.map((c) => c.kind), ['annotation', 'outcome', 'outcome']);
  assert.equal(decision.children[1].edgeLabel, 'Yes');
  assert.equal(decision.children[2].edgeLabel, 'No');
});

test('?AND marks members conjoined and is not read as a plain decision', () => {
  const root = parseTree([
    'P',
    '  ?AND First?',
    '  ?AND Second?',
    '    Yes = Fine',
  ].join('\n'));
  assert.deepEqual(root.children.map((c) => c.conjoined), [true, true]);
  assert.equal(root.children[0].kind, 'decision');
});

test('a sigil-less deeper line continues the line above it', () => {
  const root = parseTree([
    'P',
    '  ? Q?',
    '    ~ Validate by:',
    '      1. BOR',
    '      2. Net Liquidation Value',
    '    Yes = Fine',
  ].join('\n'));
  const note = root.children[0].children[0];
  assert.equal(note.kind, 'annotation');
  assert.equal(note.title, 'Validate by:\n1. BOR\n2. Net Liquidation Value');
});

test('rejects an outcome with children', () => {
  assert.throws(
    () => parseTree('P\n  ? Q?\n    Yes = Done\n      - extra\n'),
    (err) => err instanceof ParseError && /terminal/.test(err.message),
  );
});

test('rejects a decision with no outgoing branches', () => {
  assert.throws(
    () => parseTree('P\n  ? Q?\n    ~ only a note\n'),
    (err) => err instanceof ParseError && /no outgoing branches/.test(err.message),
  );
});

test('rejects a ?AND group with a single member', () => {
  assert.throws(
    () => parseTree('P\n  ?AND Alone?\n    Yes = Fine\n'),
    (err) => err instanceof ParseError && /at least 2/.test(err.message),
  );
});

test('rejects an indent jump of more than one level', () => {
  assert.throws(
    () => parseTree('P\n      - too deep\n'),
    (err) => err instanceof ParseError && /indent jumps/.test(err.message),
  );
});

test('rejects odd indentation', () => {
  assert.throws(
    () => parseTree('P\n   - three spaces\n'),
    (err) => err instanceof ParseError && /multiple of 2/.test(err.message),
  );
});

test('rejects a second root-level node', () => {
  assert.throws(
    () => parseTree('P\n  - fine\nSecond Root\n'),
    (err) => err instanceof ParseError && /only one root/.test(err.message),
  );
});

test('errors report their source line number', () => {
  try {
    parseTree('P\n  ? Q?\n    ~ note only\n');
    assert.fail('expected a ParseError');
  } catch (err) {
    assert.ok(err instanceof ParseError);
    assert.equal(err.errors[0].line, 2);
  }
});

test('parses the CC Fee Relief fixture into four branch headers', () => {
  const root = parseTree(fixture('cc-fee-relief'));
  const headers = root.children.filter((c) => c.kind === 'branch_header');
  assert.equal(headers.length, 4);
  const qc = headers[2];
  assert.deepEqual(qc.children.map((c) => c.conjoined), [true, true]);
});

test('parses the Declined PPMC fixture as four steps plus one decision', () => {
  const root = parseTree(fixture('declined-ppmc'));
  const kinds = root.children.map((c) => c.kind);
  assert.deepEqual(kinds, ['step', 'step', 'step', 'step', 'decision']);
  assert.equal(root.children[4].children.length, 2);
});

test('assigns depth-first sequential uids starting at 1', () => {
  const root = parseTree('P\n  # H\n    ? Q?\n      Yes = Done\n');
  assert.equal(root.uid, 1);
  assert.equal(root.children[0].uid, 2);
  assert.equal(root.children[0].children[0].uid, 3);
  assert.equal(root.children[0].children[0].children[0].uid, 4);
});

test('uids are unique across a whole fixture', () => {
  const root = parseTree(fixture('cc-fee-relief'));
  const seen = new Set();
  (function walk(n) {
    assert.ok(!seen.has(n.uid), `duplicate uid ${n.uid}`);
    seen.add(n.uid);
    n.children.forEach(walk);
  })(root);
  assert.equal(seen.size, 21);
});

test('parses steps nested under a branch header', () => {
  const root = parseTree(fixture('declined-transaction'));
  assert.equal(root.children.length, 1);
  const header = root.children[0];
  assert.equal(header.kind, 'branch_header');
  assert.deepEqual(header.children.map((c) => c.kind), ['step', 'step', 'step', 'decision']);
});
