// Turns a parsed node tree into absolutely-positioned boxes and edges.
//
// Layout model, deliberately simple rather than a general graph layout:
//   * the root sits at the top left of the content area
//   * each branch_header starts a new column, left to right
//   * within a column, nodes stack vertically in source order
//   * annotations sit flush beneath their parent with no connector
//   * consecutive ?AND siblings sit side by side, sharing one y
//
// Siblings are placed in one of two modes. 'chain' is for sequences that flow
// into one another (steps under a header, or under the root) — each links to the
// one before it. 'branch' is for alternatives out of a decision — each links
// back to the same parent, the first straight and the rest via elbows.
import { S } from './style.mjs';
import { measure, wrap } from './text.mjs';

function boxFor(node, stepNumber) {
  const bold = node.kind === 'outcome' || node.kind === 'root';
  const titleFont = node.kind === 'annotation' ? S.size.subtitle : S.size.title;
  const titleLines = wrap(node.title, titleFont, S.box.maxTextWidth, bold);
  const subLines = node.subtitle ? wrap(node.subtitle, S.size.subtitle, S.box.maxTextWidth) : [];

  const widths = [
    ...titleLines.map((l) => measure(l, titleFont, bold)),
    ...subLines.map((l) => measure(l, S.size.subtitle)),
    0,
  ];
  const extra = node.kind === 'step' ? S.box.stepNumberWidth : 0;
  const w = Math.ceil(Math.max(...widths) * S.box.widthSafety) + S.box.padX * 2 + extra;

  let h = S.box.padY * 2 + titleLines.length * titleFont * S.box.lineHeight;
  if (subLines.length > 0) {
    h += S.box.gapTitleSub + subLines.length * S.size.subtitle * S.box.lineHeight;
  }
  if (node.kind === 'annotation') h += S.box.annotationHeadroom;

  return {
    kind: node.kind,
    titleLines,
    subLines,
    w,
    h: Math.ceil(h),
    number: node.kind === 'step' ? stepNumber : null,
  };
}

function pushBox(node, x, y, ctx, stepNumber) {
  const box = boxFor(node, stepNumber);
  const id = `n${++ctx.uid}`;
  // anchorY is where outgoing straight edges begin. It defaults to the box's
  // bottom and is pushed below any annotation stack, so an edge never runs
  // through the annotation that explains its own decision.
  //
  // col scopes elbow routing: a rail only needs to clear boxes in its own
  // column, and must not reach across into the next one.
  const placed = { id, ...box, x, y, anchorY: y + box.h, col: ctx.col };
  ctx.boxes.push(placed);
  ctx.byId.set(id, placed);
  return placed;
}

// Places `nodes` as siblings starting at (x, y). Returns { bottom, right }.
function placeSiblings(nodes, x, y, ctx, { parentId = null, mode = 'branch' } = {}) {
  if (nodes.length === 0) return { bottom: y, right: x };

  let cursorY = y;
  let right = x;
  let prevId = parentId;
  let firstEdge = true;
  let i = 0;

  while (i < nodes.length) {
    const node = nodes[i];

    if (node.conjoined) {
      // Consecutive ?AND siblings share a row. The group's outcomes hang off its
      // last member, so a chain continues from that member.
      let j = i;
      while (j < nodes.length && nodes[j].conjoined) j++;
      const group = nodes.slice(i, j);

      const rowY = cursorY;
      let cursorX = x;
      let rowBottom = rowY;
      let firstMemberId = null;
      let lastMemberId = null;

      group.forEach((member, gi) => {
        const r = placeNode(member, cursorX, rowY, ctx);
        const placed = ctx.byId.get(r.id);
        if (gi === 0) {
          firstMemberId = r.id;
        } else {
          ctx.conjunctions.push({
            x: cursorX - S.gap.conjoined / 2,
            y: rowY + placed.h / 2 + 4,
            text: 'AND',
          });
        }
        lastMemberId = r.id;
        rowBottom = Math.max(rowBottom, r.bottom);
        right = Math.max(right, r.right);
        cursorX = placed.x + placed.w + S.gap.conjoined;
      });

      if (prevId) {
        ctx.edges.push({
          from: prevId,
          to: firstMemberId,
          label: group[0].edgeLabel,
          kind: firstEdge || mode === 'chain' ? 'straight' : 'elbow',
        });
      }
      firstEdge = false;
      if (mode === 'chain') prevId = lastMemberId;
      cursorY = rowBottom + S.gap.vertical;
      i = j;
      continue;
    }

    const r = placeNode(node, x, cursorY, ctx);
    if (prevId) {
      ctx.edges.push({
        from: prevId,
        to: r.id,
        label: node.edgeLabel,
        kind: firstEdge || mode === 'chain' ? 'straight' : 'elbow',
      });
    }
    firstEdge = false;
    if (mode === 'chain') prevId = r.id;
    right = Math.max(right, r.right);
    cursorY = r.bottom + S.gap.vertical;
    i++;
  }

  return { bottom: cursorY - S.gap.vertical, right };
}

// Places `node` and its whole subtree with its top-left at (x, y).
// Returns { id, bottom, right }.
function placeNode(node, x, y, ctx) {
  const number = node.kind === 'step' ? ++ctx.stepCount : null;
  const placed = pushBox(node, x, y, ctx, number);

  let bottom = y + placed.h;
  let right = x + placed.w;

  const annotations = node.children.filter((c) => c.kind === 'annotation');
  const rest = node.children.filter((c) => c.kind !== 'annotation');

  for (const a of annotations) {
    bottom += S.gap.annotation;
    const ap = pushBox(a, x, bottom, ctx, null);
    bottom += ap.h;
    right = Math.max(right, x + ap.w);
  }
  placed.anchorY = bottom;

  const r = placeSiblings(rest, x, bottom + S.gap.vertical, ctx, {
    parentId: placed.id,
    mode: 'branch',
  });
  if (rest.length > 0) {
    bottom = r.bottom;
    right = Math.max(right, r.right);
  }

  return { id: placed.id, bottom, right };
}

export function layout(root) {
  const ctx = {
    boxes: [],
    headers: [],
    edges: [],
    conjunctions: [],
    byId: new Map(),
    uid: 0,
    stepCount: 0,
    col: 0,
  };
  const pad = S.page.padding;

  const rootPlaced = pushBox(root, pad, pad, ctx, null);

  const headers = root.children.filter((c) => c.kind === 'branch_header');
  const direct = root.children.filter((c) => c.kind !== 'branch_header');

  let maxRight = pad + rootPlaced.w;
  let maxBottom = pad + rootPlaced.h;

  if (headers.length > 0) {
    let colX = pad;
    const headerY = pad + rootPlaced.h + S.gap.rootToHeaders;
    const headerTextWidth = S.box.maxTextWidth + 60;

    headers.forEach((h, colIndex) => {
      ctx.col = colIndex;
      const titleLines = wrap(h.title, S.size.header, headerTextWidth, true);
      const subLines = h.subtitle ? wrap(h.subtitle, S.size.headerSub, headerTextWidth) : [];
      const headerH =
        titleLines.length * S.size.header * S.box.lineHeight +
        (subLines.length > 0 ? 2 + subLines.length * S.size.headerSub * S.box.lineHeight : 0);

      ctx.headers.push({ x: colX, y: headerY, titleLines, subLines });

      const r = placeSiblings(
        h.children,
        colX,
        headerY + headerH + S.gap.headerToFirst,
        ctx,
        { parentId: null, mode: 'chain' },
      );

      const titleRight =
        colX +
        Math.ceil(Math.max(
          ...titleLines.map((l) => measure(l, S.size.header, true)),
          ...subLines.map((l) => measure(l, S.size.headerSub)),
          0,
        ));
      const colRight = Math.max(r.right, titleRight);

      maxRight = Math.max(maxRight, colRight);
      maxBottom = Math.max(maxBottom, r.bottom, headerY + headerH);
      colX = colRight + S.gap.column;
    });
  } else {
    const r = placeSiblings(direct, pad, pad + rootPlaced.h + S.gap.vertical, ctx, {
      parentId: rootPlaced.id,
      mode: 'chain',
    });
    maxRight = Math.max(maxRight, r.right);
    maxBottom = Math.max(maxBottom, r.bottom);
  }

  return {
    width: Math.ceil(maxRight + pad + S.page.rightAllowance),
    height: Math.ceil(maxBottom + pad),
    boxes: ctx.boxes,
    headers: ctx.headers,
    edges: ctx.edges,
    conjunctions: ctx.conjunctions,
  };
}
