// Style tokens for triage-map diagrams. Single source of truth for the palette:
// changing the look means editing only this file.
export const S = {
  font: "Inter, -apple-system, 'Helvetica Neue', Arial, sans-serif",
  fill: {
    root: '#EDE9E0',
    decision: '#EDE9E0',
    outcome: '#FFFFFF',
    step: '#FFFFFF',
    annotation: 'none',
  },
  stroke: {
    box: '#D8D5CE',
    annotation: '#C9C5BC',
    edge: '#B5B1A8',
    none: 'none',
  },
  text: {
    title: '#1F2421',
    subtitle: '#7A756C',
    annotation: '#7A756C',
    header: '#1F2421',
    headerSub: '#7A756C',
  },
  edgeLabel: {
    yes: '#1B7F4B',
    no: '#C0392B',
    other: '#7A756C',
  },
  size: {
    title: 14,
    subtitle: 11.5,
    header: 13,
    headerSub: 11,
    edgeLabel: 11.5,
    and: 12,
  },
  box: {
    maxTextWidth: 230,
    padX: 14,
    padY: 10,
    radius: 10,
    lineHeight: 1.35,
    gapTitleSub: 4,
    stepNumberWidth: 22,
    // Metrics are approximated for Inter. Viewers without it fall back to a
    // wider face, so boxes carry a margin rather than clipping their text.
    widthSafety: 1.05,
    annotationHeadroom: 6,
    elbowClearance: 20,
  },
  gap: {
    // main = the direction children flow. cross = the direction siblings and
    // bands separate. Which physical axis each maps to depends on orientation.
    main: 34,
    // Horizontal needs a wider main gap: an edge label sits *inside* the gap
    // along the flow axis, whereas vertically it sits beside the line. 34px left
    // "Yes" overlapping the box it points at.
    mainHorizontal: 58,
    // Wide enough that an elbow rail and its edge label sit clear of the next
    // band: the rail lands at bandEnd + elbowClearance, label ends ~30px later.
    cross: 76,
    // Stacked horizontal bands are only as tall as their tallest box, so a 76px
    // gap between them is nearly as tall as the content. Tighter reads better.
    crossHorizontal: 44,
    annotation: 8,
    conjoined: 30,
    headerToFirst: 16,
    rootToHeaders: 52,
  },
  // railAllowance leaves room for an elbow rail and its label hanging off the
  // last band, which layout cannot know about — rails are computed at render
  // time from the boxes an edge passes. Applies to the cross axis: the right
  // edge when vertical, the bottom edge when horizontal.
  page: { padding: 48, railAllowance: 60, background: '#FFFFFF' },
};

// Yes/No edge labels are colour-coded; anything else is neutral grey.
export function edgeLabelColor(label) {
  if (!label) return S.edgeLabel.other;
  const l = label.trim().toLowerCase();
  if (l === 'yes') return S.edgeLabel.yes;
  if (l === 'no') return S.edgeLabel.no;
  return S.edgeLabel.other;
}
