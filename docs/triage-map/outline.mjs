// Parses pasted text -- typically a numbered list copied out of a Google Doc --
// into flat rows carrying a nesting depth. Knows about list markers and
// indentation, and nothing else: every row becomes a step, and no attempt is
// made to guess node kinds.

// Leading list markers. Anchored, so "1-2" mid-sentence is untouched, and the
// marker must be followed by whitespace or end of line -- that keeps "-Foo" as
// text while still dropping a bare "-" left behind by a copy.
const MARKER = /^(?:\d+[.)]|[-*•])(?:\s+|$)/;

export function parseOutline(text) {
  const rows = [];

  for (const line of String(text ?? '').replace(/\r\n/g, '\n').split('\n')) {
    if (line.trim() === '') continue;
    // A tab counts as two spaces so mixed indentation still nests sensibly.
    const expanded = line.replace(/\t/g, '  ');
    const indent = expanded.length - expanded.trimStart().length;
    const body = expanded.trim().replace(MARKER, '').trim();
    if (body === '') continue;
    rows.push({ indent, text: body });
  }

  if (rows.length === 0) return [];

  // A stack of the indent widths currently open. Walking it converts absolute
  // indents into depths, normalises the shallowest line to 0, and clamps any
  // jump to a single level -- matching how parse.mjs refuses multi-level jumps.
  const open = [rows[0].indent];
  const out = [];

  for (const row of rows) {
    while (open.length > 1 && row.indent < open[open.length - 1]) open.pop();
    if (row.indent > open[open.length - 1]) open.push(row.indent);
    out.push({ depth: open.length - 1, text: row.text });
  }

  return out;
}
