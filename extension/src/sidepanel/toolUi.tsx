// Shared presentational pieces for the sidepanel "tool" screens (Wires Pending Posting v2,
// Insurance Eligibility Triage). Moved verbatim from WiresPendingPostingV2 so every tool
// screen looks the same. Presentation only — no behaviour lives here.

export function Pill({ label, tone, wrap }: { label: string; tone: 'positive' | 'warning' | 'highlight' | 'neutral'; wrap?: boolean }) {
  const map: Record<typeof tone, React.CSSProperties> = {
    positive:  { background: 'var(--mint-positive-bg-soft)', color: 'var(--mint-positive-fg-strong)',  border: '1px solid var(--mint-positive-fg-graphic)' },
    warning:   { background: 'var(--mint-warning-bg-soft)',  color: 'var(--mint-warning-fg-strong)',   border: '1px solid var(--mint-warning-fg-graphic)'  },
    highlight: { background: 'var(--mint-highlight-bg-soft)',color: 'var(--mint-highlight-fg-strong)', border: '1px solid var(--mint-highlight-fg-graphic)'},
    neutral:   { background: 'var(--mint-bg-subtle)',        color: 'var(--mint-fg-strong)',           border: 'var(--mint-card-stroke)'                    },
  };
  const wrapStyle: React.CSSProperties = wrap
    ? { display: 'inline-block', whiteSpace: 'normal', wordBreak: 'normal', overflowWrap: 'anywhere', lineHeight: 1.3, textAlign: 'left' }
    : {};
  return <span style={{ ...map[tone], padding: '2px 8px', borderRadius: wrap ? 12 : 9999, fontWeight: 700, ...wrapStyle }}>{label}</span>;
}

export function ToolHeader({ title, onClose, disabled }: { title: string; onClose: () => void; disabled?: boolean }) {
  return (
    <header style={{ position: 'sticky', top: 0, zIndex: 50, background: 'var(--mint-bg-card)', borderBottom: 'var(--mint-card-stroke)', padding: 'var(--mint-sp-3) var(--mint-sp-3) var(--mint-sp-2)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button onClick={onClose} disabled={disabled} title="Back to home" style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--mint-fg-soft)', fontSize: 16, padding: 4 }}>←</button>
        <h2 style={{ margin: 0, fontSize: 'var(--mint-text-h-md)', fontWeight: 700, color: 'var(--mint-fg-strong)' }}>{title}</h2>
      </div>
    </header>
  );
}

export const primaryButton: React.CSSProperties = {
  padding: '12px 16px',
  borderRadius: 'var(--mint-radius-button)',
  fontWeight: 700,
  fontSize: 'var(--mint-text-meta)',
  border: 'none',
  background: 'var(--mint-fg-strong)',
  color: 'var(--mint-fg-inverted)',
  cursor: 'pointer',
};

export const secondaryButton: React.CSSProperties = {
  ...primaryButton,
  padding: '8px 12px',
  fontWeight: 600,
  border: 'var(--mint-card-stroke)',
  background: 'var(--mint-bg-card)',
  color: 'var(--mint-fg-strong)',
};

export const infoCard: React.CSSProperties = {
  padding: 'var(--mint-sp-3)',
  background: 'var(--mint-bg-subtle)',
  border: 'var(--mint-card-stroke)',
  borderRadius: 'var(--mint-radius-card)',
  fontSize: 'var(--mint-text-meta)',
  color: 'var(--mint-fg-strong)',
  textAlign: 'center',
};

export const errorBanner: React.CSSProperties = {
  padding: '8px 12px',
  background: 'var(--mint-negative-bg-soft)',
  color: 'var(--mint-negative-fg-strong)',
  fontSize: 'var(--mint-text-meta)',
  borderRadius: 'var(--mint-radius-button)',
};

/** The `<li>` style of a compact result row (V2 RowItem). */
export const listItemStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 8,
  padding: '6px 10px',
  background: 'var(--mint-bg-card)',
  border: 'var(--mint-card-stroke)',
  borderRadius: 'var(--mint-radius-button)',
};
