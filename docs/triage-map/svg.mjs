// Renders a positioned diagram to SVG. Owns edge geometry and XML escaping;
// knows nothing about the DSL.
import { S, edgeLabelColor } from './style.mjs';

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const FILL = {
  root: S.fill.root,
  decision: S.fill.decision,
  outcome: S.fill.outcome,
  step: S.fill.step,
  annotation: S.fill.annotation,
};

function strokeFor(kind) {
  if (kind === 'annotation') return { color: S.stroke.annotation, dash: ' stroke-dasharray="4 3"' };
  return { color: S.stroke.box, dash: '' };
}

function boxSvg(b) {
  const out = [];
  const { color, dash } = strokeFor(b.kind);
  out.push(
    `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="${S.box.radius}" ` +
    `fill="${FILL[b.kind] || S.fill.outcome}" stroke="${color}" stroke-width="1"${dash}/>`,
  );

  const bold = b.kind === 'outcome' || b.kind === 'root';
  const titleFont = b.kind === 'annotation' ? S.size.subtitle : S.size.title;
  const titleColor = b.kind === 'annotation' ? S.text.annotation : S.text.title;
  const indent = b.kind === 'step' ? S.box.stepNumberWidth : 0;

  let y = b.y + S.box.padY + titleFont;

  if (b.number !== null && b.number !== undefined) {
    out.push(
      `<text x="${b.x + S.box.padX}" y="${y}" font-family="${S.font}" font-size="${titleFont}" ` +
      `fill="${S.text.subtitle}">${b.number}.</text>`,
    );
  }

  for (const line of b.titleLines) {
    out.push(
      `<text x="${b.x + S.box.padX + indent}" y="${y}" font-family="${S.font}" font-size="${titleFont}" ` +
      `font-weight="${bold ? 600 : 400}" fill="${titleColor}">${esc(line)}</text>`,
    );
    y += titleFont * S.box.lineHeight;
  }

  if (b.subLines.length > 0) {
    y += S.box.gapTitleSub;
    for (const line of b.subLines) {
      out.push(
        `<text x="${b.x + S.box.padX + indent}" y="${y}" font-family="${S.font}" font-size="${S.size.subtitle}" ` +
        `fill="${S.text.subtitle}">${esc(line)}</text>`,
      );
      y += S.size.subtitle * S.box.lineHeight;
    }
  }

  // Grouping by node uid is what lets the browser editor hit-test a box back to
  // the tree node it came from.
  const body = out.join('\n');
  if (b.nodeUid === null || b.nodeUid === undefined) return body;
  return `<g data-node-uid="${b.nodeUid}">\n${body}\n</g>`;
}

function headerSvg(h) {
  const out = [];
  let y = h.y + S.size.header;
  for (const line of h.titleLines) {
    out.push(
      `<text x="${h.x}" y="${y}" font-family="${S.font}" font-size="${S.size.header}" ` +
      `font-weight="700" fill="${S.text.header}">${esc(line)}</text>`,
    );
    y += S.size.header * S.box.lineHeight;
  }
  for (const line of h.subLines) {
    out.push(
      `<text x="${h.x}" y="${y}" font-family="${S.font}" font-size="${S.size.headerSub}" ` +
      `font-weight="600" fill="${S.text.headerSub}">${esc(line)}</text>`,
    );
    y += S.size.headerSub * S.box.lineHeight;
  }
  return out.join('\n');
}

// A straight edge runs along the MAIN axis from the parent's anchor (past any
// annotation stack) to the child's near edge, held at a fixed inset on the
// cross axis. An elbow leaves the parent's far CROSS edge, runs out to a rail
// clear of every box in its band, travels along MAIN, and enters the child's
// far cross edge.
function railFor(a, b, boxes, orientation) {
  const vertical = orientation !== 'horizontal';
  const mainStart = vertical ? Math.min(a.y, b.y) : Math.min(a.x, b.x);
  const mainStop = vertical
    ? Math.max(a.y + a.h, b.y + b.h)
    : Math.max(a.x + a.w, b.x + b.w);
  let rail = vertical
    ? Math.max(a.x + a.w, b.x + b.w)
    : Math.max(a.y + a.h, b.y + b.h);

  for (const box of boxes) {
    // Only boxes in the same band matter. Scanning the whole diagram would push
    // the rail across into the next band.
    if (box.band !== a.band) continue;
    const start = vertical ? box.y : box.x;
    const stop = vertical ? box.y + box.h : box.x + box.w;
    if (start < mainStop && stop > mainStart) {
      rail = Math.max(rail, vertical ? box.x + box.w : box.y + box.h);
    }
  }
  return rail + S.box.elbowClearance;
}

function edgeSvg(edge, byId, boxes, orientation) {
  const a = byId.get(edge.from);
  const b = byId.get(edge.to);
  if (!a || !b) return '';

  const vertical = orientation !== 'horizontal';
  const stroke = `stroke="${S.stroke.edge}" stroke-width="1" fill="none"`;
  const out = [];
  let labelX;
  let labelY;

  if (edge.kind === 'straight') {
    if (vertical) {
      const x = a.x + 26;
      const startY = a.anchor ?? a.y + a.h;
      out.push(`<path d="M ${x} ${startY} L ${x} ${b.y}" ${stroke}/>`);
      labelX = x + 8;
      labelY = (startY + b.y) / 2 + 4;
    } else {
      const y = a.y + 26;
      const startX = a.anchor ?? a.x + a.w;
      out.push(`<path d="M ${startX} ${y} L ${b.x} ${y}" ${stroke}/>`);
      labelX = (startX + b.x) / 2;
      labelY = y - 8;
    }
  } else {
    const rail = railFor(a, b, boxes, orientation);
    if (vertical) {
      const ay = a.y + a.h / 2;
      const by = b.y + b.h / 2;
      out.push(
        `<path d="M ${a.x + a.w} ${ay} L ${rail} ${ay} L ${rail} ${by} L ${b.x + b.w} ${by}" ${stroke}/>`,
      );
      labelX = rail + 6;
      labelY = (ay + by) / 2 + 4;
    } else {
      const ax = a.x + a.w / 2;
      const bx = b.x + b.w / 2;
      out.push(
        `<path d="M ${ax} ${a.y + a.h} L ${ax} ${rail} L ${bx} ${rail} L ${bx} ${b.y + b.h}" ${stroke}/>`,
      );
      labelX = (ax + bx) / 2;
      labelY = rail + 14;
    }
  }

  if (edge.label) {
    out.push(
      `<text x="${labelX}" y="${labelY}" font-family="${S.font}" font-size="${S.size.edgeLabel}" ` +
      `font-weight="700" fill="${edgeLabelColor(edge.label)}">${esc(edge.label)}</text>`,
    );
  }

  return out.join('\n');
}

export function toSvg(diagram, title) {
  const byId = new Map(diagram.boxes.map((b) => [b.id, b]));
  const parts = [];

  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${diagram.width}" height="${diagram.height}" ` +
    `viewBox="0 0 ${diagram.width} ${diagram.height}">`,
  );
  parts.push(`<title>${esc(title)}</title>`);
  parts.push(`<rect width="100%" height="100%" fill="${S.page.background}"/>`);

  for (const edge of diagram.edges) {
    parts.push(edgeSvg(edge, byId, diagram.boxes, diagram.orientation));
  }
  for (const h of diagram.headers) parts.push(headerSvg(h));
  for (const b of diagram.boxes) parts.push(boxSvg(b));

  for (const c of diagram.conjunctions) {
    parts.push(
      `<text x="${c.x}" y="${c.y}" text-anchor="middle" font-family="${S.font}" ` +
      `font-size="${S.size.and}" font-weight="700" fill="${S.text.title}">${c.text}</text>`,
    );
  }

  parts.push('</svg>');
  return parts.filter(Boolean).join('\n');
}
