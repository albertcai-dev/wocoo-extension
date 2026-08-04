// Tree -> DSL text. The exact inverse of parse.mjs, so that
// parse(serialize(tree)) reproduces the tree's structure and content.

const SIGIL = {
  branch_header: '#',
  step: '-',
  annotation: '~',
};

// A line that would be re-read as a sigil, breaking the round trip.
const LOOKS_LIKE_SIGIL = /^(#|-|\?|~|=)(\s|$)|^\?AND(\s|$)|^[A-Za-z][\w-]*\s*=\s/;

export function titleProblem(title, { isRoot } = {}) {
  const text = String(title ?? '');
  if (text.trim() === '') return 'title cannot be empty';
  if (text.includes('|')) return 'title cannot contain a pipe — the pipe separates title from subtitle';

  const lines = text.split('\n');
  for (const line of lines) {
    if (LOOKS_LIKE_SIGIL.test(line.trim())) {
      return `line "${line.trim()}" starts with a sigil and would be re-read as a node`;
    }
  }
  // The root's first line carries no sigil of its own, so anything sigil-shaped
  // there is doubly ambiguous. Already covered above; kept explicit for clarity.
  if (isRoot && LOOKS_LIKE_SIGIL.test(lines[0].trim())) {
    return 'the procedure name cannot start with a sigil';
  }
  return null;
}

function prefixFor(node) {
  if (node.kind === 'root') return '';
  if (node.kind === 'decision') return node.conjoined ? '?AND ' : '? ';
  if (node.kind === 'outcome') return node.edgeLabel ? `${node.edgeLabel} = ` : '= ';
  return `${SIGIL[node.kind]} `;
}

function linesFor(node, depth) {
  const pad = '  '.repeat(depth);
  const titleLines = String(node.title).split('\n');

  // The subtitle belongs on the sigil line: parse splits title from subtitle on
  // that line only, then appends continuation lines to the title.
  let head = pad + prefixFor(node) + titleLines[0];
  if (node.subtitle) head += ` | ${node.subtitle}`;

  const out = [head];
  const contPad = '  '.repeat(depth + 1);
  for (const extra of titleLines.slice(1)) out.push(contPad + extra);
  return out;
}

export function serialize(tree) {
  const lines = [];
  (function walk(node, depth) {
    lines.push(...linesFor(node, depth));
    for (const child of node.children) walk(child, depth + 1);
  })(tree, 0);
  return `${lines.join('\n')}\n`;
}
