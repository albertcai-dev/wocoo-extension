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
  },
  gap: {
    vertical: 34,
    column: 56,
    annotation: 8,
    conjoined: 30,
    headerToFirst: 16,
    rootToHeaders: 52,
  },
  page: { padding: 48, background: '#FFFFFF' },
};

// Yes/No edge labels are colour-coded; anything else is neutral grey.
export function edgeLabelColor(label) {
  if (!label) return S.edgeLabel.other;
  const l = label.trim().toLowerCase();
  if (l === 'yes') return S.edgeLabel.yes;
  if (l === 'no') return S.edgeLabel.no;
  return S.edgeLabel.other;
}
