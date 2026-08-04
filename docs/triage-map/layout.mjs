// Turns a parsed node tree into absolutely-positioned boxes and edges.
//
// The algorithm has two axes:
//   * MAIN  — the direction children flow
//   * CROSS — the direction siblings and bands separate
//
// Vertical puts main on y and cross on x; horizontal swaps them. Everything is
// computed in (main, cross) and converted to (x, y) once, in pushBox.
//
// Boxes never transpose: a box is sized by its wrapped text in both modes. So
// the MAIN-axis size is the box height when vertical and its width when
// horizontal. That asymmetry is the whole mechanism.
//
// Within a band, siblings are placed in one of two modes. 'chain' is for
// sequences that flow into one another (steps under a header, or under the
// root) — each links to the one before it. 'branch' is for alternatives out of
// a decision — each links back to the same parent, the first with a straight
// edge and the rest via elbows.
import { S } from './style.mjs';
import { measure, wrap } from './text.mjs';

const AXES = {
  vertical: {
    mainSize: 'h',
    crossSize: 'w',
    toXY: (main, cross) => ({ x: cross, y: main }),
  },
  horizontal: {
    mainSize: 'w',
    crossSize: 'h',
    toXY: (main, cross) => ({ x: main, y: cross }),
  },
};

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

function pushBox(node, main, cross, ctx, stepNumber) {
  const box = boxFor(node, stepNumber);
  const id = `n${++ctx.uid}`;
  const { x, y } = ctx.axis.toXY(main, cross);
  // anchor is where outgoing straight edges begin, on the main axis. It starts
  // at the far edge of the box and is pushed past any annotation stack, so an
  // edge never runs through the annotation explaining its own decision.
  //
  // band scopes elbow routing: a rail clears only boxes in its own band and
  // must not reach into the next one.
  //
  // nodeUid is the tree node's identity, distinct from `id` which addresses this
  // box for edge endpoints. Box ids shift when the tree changes; uids do not.
  const placed = {
    id,
    ...box,
    x,
    y,
    anchor: main + box[ctx.axis.mainSize],
    band: ctx.band,
    nodeUid: node.uid ?? null,
  };
  ctx.boxes.push(placed);
  ctx.byId.set(id, placed);
  return placed;
}

// Places `nodes` as siblings starting at (main, cross).
// Returns { mainEnd, crossEnd }.
function placeSiblings(nodes, main, cross, ctx, { parentId = null, mode = 'branch' } = {}) {
  if (nodes.length === 0) return { mainEnd: main, crossEnd: cross };

  const A = ctx.axis;
  let cursorMain = main;
  let crossEnd = cross;
  let prevId = parentId;
  let firstEdge = true;
  let i = 0;

  while (i < nodes.length) {
    const node = nodes[i];

    if (node.conjoined) {
      // Consecutive ?AND siblings share a main position and separate on cross.
      // The group's outcomes hang off its last member, so a chain continues
      // from that member.
      let j = i;
      while (j < nodes.length && nodes[j].conjoined) j++;
      const group = nodes.slice(i, j);

      const groupMain = cursorMain;
      let cursorCross = cross;
      let groupMainEnd = groupMain;
      let firstMemberId = null;
      let lastMemberId = null;

      group.forEach((member, gi) => {
        const r = placeNode(member, groupMain, cursorCross, ctx);
        const placed = ctx.byId.get(r.id);
        if (gi === 0) {
          firstMemberId = r.id;
        } else {
          const at = A.toXY(
            groupMain + placed[A.mainSize] / 2,
            cursorCross - S.gap.conjoined / 2,
          );
          // The +4 is a text-baseline nudge, so it always applies to y.
          ctx.conjunctions.push({ x: at.x, y: at.y + 4, text: 'AND' });
        }
        lastMemberId = r.id;
        groupMainEnd = Math.max(groupMainEnd, r.mainEnd);
        crossEnd = Math.max(crossEnd, r.crossEnd);
        cursorCross += placed[A.crossSize] + S.gap.conjoined;
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
      cursorMain = groupMainEnd + ctx.gapMain;
      i = j;
      continue;
    }

    const r = placeNode(node, cursorMain, cross, ctx);
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
    crossEnd = Math.max(crossEnd, r.crossEnd);
    cursorMain = r.mainEnd + ctx.gapMain;
    i++;
  }

  return { mainEnd: cursorMain - ctx.gapMain, crossEnd };
}

// Places `node` and its whole subtree with its near corner at (main, cross).
// Returns { id, mainEnd, crossEnd }.
function placeNode(node, main, cross, ctx) {
  const A = ctx.axis;
  const number = node.kind === 'step' ? ++ctx.stepCount : null;
  const placed = pushBox(node, main, cross, ctx, number);

  let mainEnd = main + placed[A.mainSize];
  let crossEnd = cross + placed[A.crossSize];

  const annotations = node.children.filter((c) => c.kind === 'annotation');
  const rest = node.children.filter((c) => c.kind !== 'annotation');

  for (const a of annotations) {
    mainEnd += S.gap.annotation;
    const ap = pushBox(a, mainEnd, cross, ctx, null);
    mainEnd += ap[A.mainSize];
    crossEnd = Math.max(crossEnd, cross + ap[A.crossSize]);
  }
  placed.anchor = mainEnd;

  const r = placeSiblings(rest, mainEnd + ctx.gapMain, cross, ctx, {
    parentId: placed.id,
    mode: 'branch',
  });
  if (rest.length > 0) {
    mainEnd = r.mainEnd;
    crossEnd = Math.max(crossEnd, r.crossEnd);
  }

  return { id: placed.id, mainEnd, crossEnd };
}

export function layout(root, orientation = 'vertical') {
  const axis = AXES[orientation];
  if (!axis) {
    throw new Error(`unknown orientation "${orientation}" — expected vertical or horizontal`);
  }

  const ctx = {
    boxes: [],
    headers: [],
    edges: [],
    conjunctions: [],
    byId: new Map(),
    uid: 0,
    stepCount: 0,
    band: 0,
    axis,
    // Resolved once: horizontal needs a wider main gap (edge labels sit inside
    // the gap) and a tighter cross gap (bands are only as tall as one box).
    gapMain: orientation === 'horizontal' ? S.gap.mainHorizontal : S.gap.main,
    gapCross: orientation === 'horizontal' ? S.gap.crossHorizontal : S.gap.cross,
  };
  const pad = S.page.padding;

  const rootPlaced = pushBox(root, pad, pad, ctx, null);

  const headers = root.children.filter((c) => c.kind === 'branch_header');
  const direct = root.children.filter((c) => c.kind !== 'branch_header');

  let maxMain = pad + rootPlaced[axis.mainSize];
  let maxCross = pad + rootPlaced[axis.crossSize];

  if (headers.length > 0) {
    let bandCross = pad;
    const headerMain = pad + rootPlaced[axis.mainSize] + S.gap.rootToHeaders;
    const headerTextWidth = S.box.maxTextWidth + 60;

    headers.forEach((h, bandIndex) => {
      ctx.band = bandIndex;
      const titleLines = wrap(h.title, S.size.header, headerTextWidth, true);
      const subLines = h.subtitle ? wrap(h.subtitle, S.size.headerSub, headerTextWidth) : [];

      const textHeight =
        titleLines.length * S.size.header * S.box.lineHeight +
        (subLines.length > 0 ? 2 + subLines.length * S.size.headerSub * S.box.lineHeight : 0);
      const textWidth = Math.ceil(Math.max(
        ...titleLines.map((l) => measure(l, S.size.header, true)),
        ...subLines.map((l) => measure(l, S.size.headerSub)),
        0,
      ));

      // A header sits before its band on the main axis in both modes: above its
      // column when vertical, left of its row when horizontal.
      // In horizontal the header's main extent is a measured text width, which
      // carries the same font-fallback risk as a box: the real face is wider
      // than these metrics assume. Apply the same safety margin, horizontal
      // only, so vertical output is untouched.
      const headerMainExtent = orientation === 'vertical'
        ? textHeight
        : Math.ceil(textWidth * S.box.widthSafety);
      const headerCrossExtent = orientation === 'vertical' ? textWidth : textHeight;

      const at = axis.toXY(headerMain, bandCross);
      ctx.headers.push({ x: at.x, y: at.y, titleLines, subLines });

      const r = placeSiblings(
        h.children,
        headerMain + headerMainExtent + S.gap.headerToFirst,
        bandCross,
        ctx,
        { parentId: null, mode: 'chain' },
      );

      const bandCrossEnd = Math.max(r.crossEnd, bandCross + headerCrossExtent);

      maxMain = Math.max(maxMain, r.mainEnd, headerMain + headerMainExtent);
      maxCross = Math.max(maxCross, bandCrossEnd);
      bandCross = bandCrossEnd + ctx.gapCross;
    });
  } else {
    const r = placeSiblings(direct, pad + rootPlaced[axis.mainSize] + ctx.gapMain, pad, ctx, {
      parentId: rootPlaced.id,
      mode: 'chain',
    });
    maxMain = Math.max(maxMain, r.mainEnd);
    maxCross = Math.max(maxCross, r.crossEnd);
  }

  // railAllowance goes on the cross axis, where an elbow rail hangs off the
  // last band: the right edge when vertical, the bottom edge when horizontal.
  const size = axis.toXY(
    Math.ceil(maxMain + pad),
    Math.ceil(maxCross + pad + S.page.railAllowance),
  );

  return {
    width: size.x,
    height: size.y,
    orientation,
    boxes: ctx.boxes,
    headers: ctx.headers,
    edges: ctx.edges,
    conjunctions: ctx.conjunctions,
  };
}
