// Parses the triage-map tree DSL into a node tree, and fails loudly rather than
// producing a misleading diagram. Indentation is 2 spaces per level.

export class ParseError extends Error {
  constructor(errors) {
    const detail = errors.map((e) => `  line ${e.line}: ${e.message}`).join('\n');
    super(`${errors.length} error(s) in tree DSL:\n${detail}`);
    this.name = 'ParseError';
    this.errors = errors;
  }
}

// Order matters: ?AND must be tried before ?, and the labelled-outcome pattern
// last so it cannot swallow another sigil's line.
const SIGILS = [
  { re: /^#\s+(.*)$/, kind: 'branch_header' },
  { re: /^-\s+(.*)$/, kind: 'step' },
  { re: /^\?AND\s+(.*)$/, kind: 'decision', conjoined: true },
  { re: /^\?\s*(.*)$/, kind: 'decision' },
  { re: /^~\s+(.*)$/, kind: 'annotation' },
  { re: /^=\s+(.*)$/, kind: 'outcome' },
  { re: /^([A-Za-z][\w-]*)\s*=\s+(.*)$/, kind: 'outcome', labelled: true },
];

function matchSigil(text) {
  for (const s of SIGILS) {
    const m = text.match(s.re);
    if (!m) continue;
    if (s.labelled) return { kind: s.kind, edgeLabel: m[1], rest: m[2], conjoined: false };
    return { kind: s.kind, edgeLabel: null, rest: m[1], conjoined: Boolean(s.conjoined) };
  }
  return null;
}

function splitTitle(raw) {
  const i = raw.indexOf('|');
  if (i === -1) return { title: raw.trim(), subtitle: null };
  return { title: raw.slice(0, i).trim(), subtitle: raw.slice(i + 1).trim() };
}

function mkNode(kind, title, subtitle, edgeLabel, conjoined, line, indent) {
  return { kind, title, subtitle, edgeLabel, conjoined, indent, line, children: [] };
}

function walk(node, fn) {
  fn(node);
  for (const c of node.children) walk(c, fn);
}

function outgoing(node) {
  return node.children.filter((c) => c.kind !== 'annotation');
}

function validate(root, errors) {
  walk(root, (node) => {
    if (node.kind === 'outcome' && node.children.length > 0) {
      errors.push({ line: node.line, message: `outcome "${node.title}" has children; outcomes are terminal` });
    }

    const kids = node.children;
    let i = 0;
    while (i < kids.length) {
      const k = kids[i];
      if (k.conjoined) {
        // Consecutive ?AND siblings form one group. Only the last member carries
        // the shared outcomes, so only the last is required to have branches.
        let j = i;
        while (j < kids.length && kids[j].conjoined) j++;
        const group = kids.slice(i, j);
        if (group.length < 2) {
          errors.push({ line: k.line, message: `?AND group has only ${group.length} member; conjoined decisions need at least 2` });
        }
        const last = group[group.length - 1];
        if (outgoing(last).length === 0) {
          errors.push({ line: last.line, message: `?AND group ending at "${last.title}" has no outgoing branches` });
        }
        i = j;
      } else {
        if (k.kind === 'decision' && outgoing(k).length === 0) {
          errors.push({ line: k.line, message: `decision "${k.title}" has no outgoing branches` });
        }
        i++;
      }
    }
  });
}

export function parseTree(text) {
  const errors = [];
  const lines = [];

  String(text).replace(/\r\n/g, '\n').split('\n').forEach((raw, idx) => {
    if (raw.trim() === '') return;
    const lead = raw.length - raw.trimStart().length;
    if (lead % 2 !== 0) {
      errors.push({ line: idx + 1, message: `indent of ${lead} spaces is not a multiple of 2` });
    }
    lines.push({ line: idx + 1, indent: Math.floor(lead / 2), text: raw.trim() });
  });

  if (lines.length === 0) throw new ParseError([{ line: 1, message: 'tree is empty' }]);

  const first = lines[0];
  if (first.indent !== 0) {
    errors.push({ line: first.line, message: 'first line must not be indented' });
  }
  if (matchSigil(first.text)) {
    errors.push({ line: first.line, message: 'first line is the procedure name and must carry no sigil' });
  }

  const t0 = splitTitle(first.text);
  const root = mkNode('root', t0.title, t0.subtitle, null, false, first.line, 0);
  const stack = [root];
  let prev = root;

  for (let i = 1; i < lines.length; i++) {
    const { line, indent, text } = lines[i];

    if (indent === 0) {
      errors.push({ line, message: `only one root is allowed; "${text}" is at indent 0` });
      continue;
    }

    const m = matchSigil(text);

    if (!m) {
      if (indent > prev.indent) {
        prev.title += `\n${text}`;
        continue;
      }
      errors.push({ line, message: `unrecognised line "${text}" — expected one of # - ? ?AND ~ = or a deeper-indented continuation` });
      continue;
    }

    if (indent > prev.indent + 1) {
      errors.push({ line, message: `indent jumps ${indent - prev.indent} levels; only one level deeper is allowed` });
    }

    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
    const parent = stack[stack.length - 1];

    const tt = splitTitle(m.rest);
    const node = mkNode(m.kind, tt.title, tt.subtitle, m.edgeLabel, m.conjoined, line, indent);
    parent.children.push(node);
    stack.push(node);
    prev = node;
  }

  validate(root, errors);
  if (errors.length > 0) throw new ParseError(errors);
  return root;
}
