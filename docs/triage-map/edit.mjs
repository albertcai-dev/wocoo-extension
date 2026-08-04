// Immutable, uid-addressed tree operations. Every mutating function deep-clones
// its input and returns a new tree, so the caller's undo stack can hold plain
// references without defensive copying.
import { titleProblem } from './serialize.mjs';

const LEAF_KINDS = new Set(['annotation', 'outcome']);

export class EditError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EditError';
  }
}

export function locate(tree, uid) {
  let found = null;
  (function walk(node, parent, index) {
    if (found) return;
    if (node.uid === uid) {
      found = { node, parent, index };
      return;
    }
    node.children.forEach((child, i) => walk(child, node, i));
  })(tree, null, -1);
  return found;
}

export function maxUid(tree) {
  let max = 0;
  (function walk(node) {
    if (node.uid > max) max = node.uid;
    node.children.forEach(walk);
  })(tree);
  return max;
}

export function defaultChildKind(parent) {
  switch (parent.kind) {
    case 'root':
      return parent.children.some((c) => c.kind === 'branch_header') ? 'branch_header' : 'step';
    case 'branch_header':
      return parent.children.length === 0
        ? 'step'
        : parent.children[parent.children.length - 1].kind;
    case 'decision':
      return 'outcome';
    case 'step':
      return 'step';
    default:
      return null;
  }
}

function clone(tree) {
  return structuredClone(tree);
}

function require_(tree, uid) {
  const found = locate(tree, uid);
  if (!found) throw new EditError(`no node with uid ${uid}`);
  return found;
}

function isDescendantOrSelf(node, uid) {
  if (node.uid === uid) return true;
  return node.children.some((c) => isDescendantOrSelf(c, uid));
}

export function setText(tree, uid, { title, subtitle } = {}) {
  const out = clone(tree);
  const { node } = require_(out, uid);

  if (title !== undefined) {
    const problem = titleProblem(title, { isRoot: node.kind === 'root' });
    if (problem) throw new EditError(problem);
    node.title = title;
  }
  if (subtitle !== undefined) {
    const trimmed = String(subtitle).trim();
    node.subtitle = trimmed === '' ? null : trimmed;
  }
  return out;
}

const KIND_TOKENS = {
  branch_header: { kind: 'branch_header', conjoined: false },
  step: { kind: 'step', conjoined: false },
  decision: { kind: 'decision', conjoined: false },
  decision_and: { kind: 'decision', conjoined: true },
  annotation: { kind: 'annotation', conjoined: false },
  outcome: { kind: 'outcome', conjoined: false },
};

export function setKind(tree, uid, kindToken) {
  const spec = KIND_TOKENS[kindToken];
  if (!spec) throw new EditError(`unknown kind token "${kindToken}"`);

  const out = clone(tree);
  const { node } = require_(out, uid);
  if (node.kind === 'root') throw new EditError('the root kind cannot be changed');

  node.kind = spec.kind;
  node.conjoined = spec.conjoined;
  // Only outcomes can carry an edge label in the DSL.
  if (node.kind !== 'outcome') node.edgeLabel = null;
  return out;
}

export function setEdgeLabel(tree, uid, label) {
  const out = clone(tree);
  const { node } = require_(out, uid);
  if (node.kind !== 'outcome') {
    throw new EditError('only an outcome can carry an edge label');
  }
  const trimmed = String(label).trim();
  if (trimmed !== '' && !/^[A-Za-z][\w-]*$/.test(trimmed)) {
    throw new EditError('an edge label must be a single word of letters, digits, - or _');
  }
  node.edgeLabel = trimmed === '' ? null : trimmed;
  return out;
}

// Named newNode rather than mkNode: parse.mjs declares its own mkNode, and the
// bundler flattens every module into one scope where a duplicate function
// declaration would silently shadow the other. bundle.mjs now guards against
// that, but the distinct name keeps the intent obvious.
function newNode(kind, uid) {
  return {
    kind,
    title: `New ${kind.replace('_', ' ')}`,
    subtitle: null,
    edgeLabel: kind === 'outcome' ? 'Yes' : null,
    conjoined: false,
    indent: 0,
    line: 0,
    uid,
    children: [],
  };
}

export function addChild(tree, uid) {
  const out = clone(tree);
  const { node } = require_(out, uid);
  const kind = defaultChildKind(node);
  if (!kind) throw new EditError(`a ${node.kind} cannot have children`);

  const created = newNode(kind, maxUid(out) + 1);
  node.children.push(created);
  return { tree: out, uid: created.uid };
}

export function addSibling(tree, uid) {
  const out = clone(tree);
  const { node, parent, index } = require_(out, uid);
  if (!parent) throw new EditError('the root has no siblings');
  if (LEAF_KINDS.has(parent.kind)) throw new EditError(`a ${parent.kind} cannot have children`);

  const created = newNode(node.kind, maxUid(out) + 1);
  created.conjoined = node.conjoined;
  parent.children.splice(index + 1, 0, created);
  return { tree: out, uid: created.uid };
}

export function deleteNode(tree, uid) {
  const out = clone(tree);
  const { parent, index } = require_(out, uid);
  if (!parent) throw new EditError('the root cannot be deleted');
  parent.children.splice(index, 1);
  return out;
}

export function moveNode(tree, uid, newParentUid, index = null) {
  const out = clone(tree);
  const moving = require_(out, uid);
  if (!moving.parent) throw new EditError('the root cannot be moved');

  const destination = require_(out, newParentUid);
  if (LEAF_KINDS.has(destination.node.kind)) {
    throw new EditError(`a ${destination.node.kind} cannot have children`);
  }
  if (isDescendantOrSelf(moving.node, newParentUid)) {
    throw new EditError('a node cannot be moved inside itself');
  }

  moving.parent.children.splice(moving.index, 1);
  const target = locate(out, newParentUid).node;
  const at = index === null
    ? target.children.length
    : Math.max(0, Math.min(index, target.children.length));
  target.children.splice(at, 0, moving.node);
  return out;
}

export function reparent(tree, uid, newParentUid) {
  return moveNode(tree, uid, newParentUid, null);
}

export function reorderSibling(tree, uid, newParentUid, index) {
  return moveNode(tree, uid, newParentUid, index);
}
