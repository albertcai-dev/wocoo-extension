import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTree } from './parse.mjs';
import { serialize } from './serialize.mjs';
import {
  EditError, locate, maxUid, defaultChildKind,
  setText, setKind, setEdgeLabel,
  addChild, addSibling, deleteNode, reparent, reorderSibling,
  insertOutline, navigate,
} from './edit.mjs';

const tree = () => parseTree([
  'P',
  '  # Alpha | src A',
  '    ? Q1?',
  '      ~ note',
  '      Yes = Win',
  '      No = Lose',
  '  # Beta',
  '    - Step one',
].join('\n'));

test('locate finds a node with its parent and index', () => {
  const t = tree();
  const found = locate(t, 3); // ? Q1?
  assert.equal(found.node.title, 'Q1?');
  assert.equal(found.parent.title, 'Alpha');
  assert.equal(found.index, 0);
});

test('locate returns null for an unknown uid', () => {
  assert.equal(locate(tree(), 999), null);
});

test('maxUid reports the highest uid present', () => {
  assert.equal(maxUid(tree()), 8);
});

test('setText does not mutate its input', () => {
  const t = tree();
  const before = serialize(t);
  setText(t, 3, { title: 'Changed?' });
  assert.equal(serialize(t), before);
});

test('setText updates title and subtitle', () => {
  const out = setText(tree(), 2, { title: 'Renamed', subtitle: 'src B' });
  assert.equal(locate(out, 2).node.title, 'Renamed');
  assert.equal(locate(out, 2).node.subtitle, 'src B');
});

test('setText rejects a title containing a pipe', () => {
  assert.throws(() => setText(tree(), 3, { title: 'a | b' }), EditError);
});

test('setText clears a subtitle when given an empty string', () => {
  const out = setText(tree(), 2, { subtitle: '' });
  assert.equal(locate(out, 2).node.subtitle, null);
});

test('setKind changes kind, and decision_and sets conjoined', () => {
  const asAnd = setKind(tree(), 3, 'decision_and');
  assert.equal(locate(asAnd, 3).node.kind, 'decision');
  assert.equal(locate(asAnd, 3).node.conjoined, true);

  const asPlain = setKind(asAnd, 3, 'decision');
  assert.equal(locate(asPlain, 3).node.conjoined, false);
});

test('setKind rejects changing the root', () => {
  assert.throws(() => setKind(tree(), 1, 'step'), EditError);
});

test('setEdgeLabel sets and clears an outcome label', () => {
  const set = setEdgeLabel(tree(), 5, 'Maybe');
  assert.equal(locate(set, 5).node.edgeLabel, 'Maybe');
  const cleared = setEdgeLabel(set, 5, '');
  assert.equal(locate(cleared, 5).node.edgeLabel, null);
});

test('setEdgeLabel rejects a non-outcome, since the DSL cannot express it', () => {
  assert.throws(() => setEdgeLabel(tree(), 3, 'Yes'), EditError);
});

test('defaultChildKind follows the parent kind', () => {
  const t = tree();
  assert.equal(defaultChildKind(locate(t, 1).node), 'branch_header');
  assert.equal(defaultChildKind(locate(t, 3).node), 'outcome');
  assert.equal(defaultChildKind(locate(t, 8).node), 'step');
  assert.equal(defaultChildKind(locate(t, 4).node), null); // annotation
  assert.equal(defaultChildKind(locate(t, 5).node), null); // outcome
});

test('defaultChildKind on an empty root gives step, matching the checklist shape', () => {
  const t = parseTree('P\n  - only a step\n');
  const emptied = deleteNode(t, 2);
  assert.equal(defaultChildKind(locate(emptied, 1).node), 'step');
});

test('defaultChildKind on a header continues its last child kind', () => {
  assert.equal(defaultChildKind(locate(tree(), 7).node), 'step');
});

test('addChild appends a node and returns its new uid', () => {
  const { tree: out, uid } = addChild(tree(), 3);
  assert.equal(uid, 9);
  const added = locate(out, 9);
  assert.equal(added.node.kind, 'outcome');
  assert.equal(added.parent.title, 'Q1?');
  assert.equal(added.parent.children.length, 4);
});

test('addChild is refused on a leaf kind', () => {
  assert.throws(() => addChild(tree(), 5), EditError);
});

test('addSibling inserts directly below with the same kind', () => {
  const { tree: out, uid } = addSibling(tree(), 8);
  const added = locate(out, uid);
  assert.equal(added.node.kind, 'step');
  assert.equal(added.index, 1);
});

test('addSibling is refused on the root', () => {
  assert.throws(() => addSibling(tree(), 1), EditError);
});

test('deleteNode removes the whole subtree', () => {
  const out = deleteNode(tree(), 3);
  assert.equal(locate(out, 3), null);
  assert.equal(locate(out, 4), null, 'annotation went with it');
  assert.equal(locate(out, 5), null, 'outcome went with it');
  assert.equal(locate(out, 2).node.children.length, 0);
});

test('deleteNode refuses the root', () => {
  assert.throws(() => deleteNode(tree(), 1), EditError);
});

test('reparent moves a node to be the last child of a new parent', () => {
  const out = reparent(tree(), 7, 2); // Beta under Alpha
  assert.equal(locate(out, 7).parent.title, 'Alpha');
  assert.equal(locate(out, 1).node.children.length, 1);
});

test('reparent refuses a descendant of the node, which would cycle', () => {
  assert.throws(() => reparent(tree(), 2, 3), EditError);
});

test('reparent refuses itself as its own parent', () => {
  assert.throws(() => reparent(tree(), 2, 2), EditError);
});

test('reparent refuses leaf kinds as the destination', () => {
  assert.throws(() => reparent(tree(), 7, 5), EditError); // onto an outcome
  assert.throws(() => reparent(tree(), 7, 4), EditError); // onto an annotation
});

test('reparent refuses to move the root', () => {
  assert.throws(() => reparent(tree(), 1, 2), EditError);
});

test('reorderSibling places a node at an explicit index', () => {
  const out = reorderSibling(tree(), 7, 1, 0); // Beta first under root
  assert.equal(locate(out, 1).node.children[0].title, 'Beta');
  assert.equal(locate(out, 1).node.children[1].title, 'Alpha');
});

test('structural operations leave a serializable, parseable tree', () => {
  const ops = {
    setText: (t) => setText(t, 3, { title: 'Reworded?' }),
    addChild: (t) => addChild(t, 3).tree,
    addSibling: (t) => addSibling(t, 8).tree,
    reparent: (t) => reparent(t, 7, 2),
    reorderSibling: (t) => reorderSibling(t, 7, 1, 0),
  };
  for (const [name, op] of Object.entries(ops)) {
    const out = op(tree());
    assert.doesNotThrow(() => parseTree(serialize(out)), `${name} produced an unparseable tree`);
  }
});

// Kind changes are deliberately unconstrained: the spec chooses to flag an
// invalid result rather than block the keystroke, because a tree mid-edit is
// often briefly invalid. Making a lone decision conjoined is the clearest case —
// a ?AND group needs at least two members.
test('setKind may produce a transiently invalid tree, by design', () => {
  const out = setKind(tree(), 3, 'decision_and');
  assert.throws(() => parseTree(serialize(out)), /at least 2/);
});

test('reverting the kind clears the invalid state', () => {
  const broken = setKind(tree(), 3, 'decision_and');
  const fixed = setKind(broken, 3, 'decision');
  assert.doesNotThrow(() => parseTree(serialize(fixed)));
});

// A ?AND group's outcomes must hang off its LAST member — earlier members carry
// only annotations. Completing a pair therefore means moving the outcomes across,
// not just adding a second decision.
test('completing a ?AND pair requires moving outcomes onto the last member', () => {
  let out = setKind(tree(), 3, 'decision_and');
  const added = addSibling(out, 3);
  out = setKind(added.tree, added.uid, 'decision_and');

  assert.throws(
    () => parseTree(serialize(out)),
    /no outgoing branches/,
    'outcomes still on the first member leaves the group invalid',
  );

  out = reparent(out, 5, added.uid);
  out = reparent(out, 6, added.uid);
  assert.doesNotThrow(() => parseTree(serialize(out)));
});

// ---- insertOutline ---------------------------------------------------------

test('insertOutline appends a flat list as children', () => {
  const { tree: out, firstUid } = insertOutline(tree(), 2, [
    { depth: 0, text: 'One' },
    { depth: 0, text: 'Two' },
  ]);
  const alpha = locate(out, 2).node;
  assert.deepEqual(alpha.children.slice(-2).map((c) => c.title), ['One', 'Two']);
  assert.equal(alpha.children[alpha.children.length - 2].uid, firstUid);
});

test('insertOutline nests by depth', () => {
  const { tree: out } = insertOutline(tree(), 7, [
    { depth: 0, text: 'A' },
    { depth: 1, text: 'B' },
    { depth: 2, text: 'C' },
    { depth: 1, text: 'D' },
    { depth: 0, text: 'E' },
  ]);
  const beta = locate(out, 7).node;
  const a = beta.children.find((c) => c.title === 'A');
  assert.equal(a.children.map((c) => c.title).join(','), 'B,D');
  assert.equal(a.children[0].children[0].title, 'C');
  assert.ok(beta.children.some((c) => c.title === 'E'));
});

test('insertOutline creates steps and does not mutate its input', () => {
  const t = tree();
  const before = serialize(t);
  const { tree: out } = insertOutline(t, 7, [{ depth: 0, text: 'X' }]);
  assert.equal(serialize(t), before);
  assert.equal(locate(out, 7).node.children.find((c) => c.title === 'X').kind, 'step');
});

test('insertOutline splits a pasted pipe into title and subtitle', () => {
  const { tree: out } = insertOutline(tree(), 7, [
    { depth: 0, text: 'Open dashboard | Preset 5871' },
  ]);
  const node = locate(out, 7).node.children.find((c) => c.title === 'Open dashboard');
  assert.equal(node.subtitle, 'Preset 5871');
});

test('insertOutline output round-trips through the parser', () => {
  const { tree: out } = insertOutline(tree(), 7, [
    { depth: 0, text: '? looks like a sigil' },
    { depth: 0, text: 'has | a pipe' },
    { depth: 1, text: '= also sigil shaped' },
  ]);
  assert.doesNotThrow(() => parseTree(serialize(out)));
});

test('insertOutline assigns fresh, unique uids', () => {
  const { tree: out } = insertOutline(tree(), 7, [
    { depth: 0, text: 'A' },
    { depth: 1, text: 'B' },
  ]);
  const seen = new Set();
  (function w(n) { assert.ok(!seen.has(n.uid)); seen.add(n.uid); n.children.forEach(w); })(out);
});

test('insertOutline is refused on a leaf kind', () => {
  assert.throws(() => insertOutline(tree(), 5, [{ depth: 0, text: 'X' }]), EditError);
  assert.throws(() => insertOutline(tree(), 4, [{ depth: 0, text: 'X' }]), EditError);
});

test('insertOutline with no items is a no-op returning a null firstUid', () => {
  const t = tree();
  const { tree: out, firstUid } = insertOutline(t, 7, []);
  assert.equal(firstUid, null);
  assert.equal(serialize(out), serialize(t));
});

// ---- navigate --------------------------------------------------------------

test('navigate moves between siblings without wrapping', () => {
  const t = tree();
  assert.equal(navigate(t, 5, 'down'), 6);
  assert.equal(navigate(t, 6, 'up'), 5);
  // Annotations are ordinary entries in children, so navigation walks through
  // them: uid 4 is the annotation sitting before the first outcome.
  assert.equal(navigate(t, 5, 'up'), 4);
  assert.equal(navigate(t, 4, 'up'), null, 'no wrap at the start');
  assert.equal(navigate(t, 6, 'down'), null, 'no wrap at the end');
});

test('navigate left goes to the parent and right to the first child', () => {
  const t = tree();
  assert.equal(navigate(t, 3, 'left'), 2);
  assert.equal(navigate(t, 2, 'right'), 3);
});

test('navigate returns null at the root and at a leaf', () => {
  const t = tree();
  assert.equal(navigate(t, 1, 'left'), null);
  assert.equal(navigate(t, 1, 'up'), null);
  assert.equal(navigate(t, 5, 'right'), null);
});

test('navigate returns null for an unknown uid and throws on a bad direction', () => {
  assert.equal(navigate(tree(), 999, 'up'), null);
  assert.throws(() => navigate(tree(), 3, 'sideways'), EditError);
});
