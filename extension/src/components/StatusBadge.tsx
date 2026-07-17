// StatusBadge — Mint-tokens-based pill. One of the few "custom" components in v1
// because Mint DS Web 1.0 doesn't ship a Tag/Badge primitive of equivalent maturity.

import type { WocooTicket } from '../data/mockTicket';

const PALETTE: Record<WocooTicket['status'], { bg: string; fg: string; dot: string }> = {
  Triage:       { bg: 'var(--mint-negative-bg-soft)',  fg: 'var(--mint-negative-fg-strong)',  dot: 'var(--mint-negative-fg-graphic)' },
  'Back Office':{ bg: 'var(--mint-warning-bg-soft)',   fg: 'var(--mint-warning-fg-strong)',   dot: 'var(--mint-warning-fg-graphic)' },
  Pending:      { bg: 'var(--mint-highlight-bg-soft)', fg: 'var(--mint-highlight-fg-strong)', dot: 'var(--mint-highlight-fg-graphic)' },
  Done:         { bg: 'var(--mint-positive-bg-soft)',  fg: 'var(--mint-positive-fg-strong)',  dot: 'var(--mint-positive-fg-graphic)' },
  Cancelled:    { bg: 'var(--mint-neutral-bg-soft)',   fg: 'var(--mint-fg-subdued-title)',    dot: 'var(--mint-fg-inactive)' },
  Other:        { bg: 'var(--mint-highlight-bg-soft)', fg: 'var(--mint-fg-subdued-title)',    dot: 'var(--mint-fg-inactive)' },
};

export function StatusBadge({ status }: { status: WocooTicket['status'] }) {
  const c = PALETTE[status];
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '2px 8px',
        background: c.bg,
        color: c.fg,
        borderRadius: 'var(--mint-radius-pill)',
        fontSize: 'var(--mint-text-micro)',
        fontWeight: 600,
        lineHeight: 1.4,
      }}
    >
      <span style={{ width: 6, height: 6, background: c.dot, borderRadius: '50%' }} />
      {status}
    </span>
  );
}

const PRIORITY_COLOR: Record<WocooTicket['priority'], string> = {
  Highest: 'var(--mint-negative-fg-strong)',
  High:    'var(--mint-negative-fg-graphic)',
  Medium:  'var(--mint-warning-fg-strong)',
  Low:     'var(--mint-positive-fg-strong)',
  Lowest:  'var(--mint-fg-soft)',
};

const PRIORITY_GLYPH: Record<WocooTicket['priority'], string> = {
  Highest: '↑↑',
  High:    '↑',
  Medium:  '↓',
  Low:     '↓↓',
  Lowest:  '↓↓↓',
};

export function PriorityIndicator({ priority }: { priority: WocooTicket['priority'] }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, color: PRIORITY_COLOR[priority], fontSize: 'var(--mint-text-micro)', fontWeight: 700 }}>
      <span aria-hidden="true">{PRIORITY_GLYPH[priority]}</span>
      {priority}
    </span>
  );
}

const TIER_PALETTE: Record<WocooTicket['tier'], { bg: string; fg: string }> = {
  Core:       { bg: 'var(--mint-highlight-bg-soft)', fg: 'var(--mint-highlight-fg-strong)' },
  Premium:    { bg: 'var(--mint-warning-bg-soft)',   fg: 'var(--mint-warning-fg-strong)' },
  Generation: { bg: 'var(--mint-positive-bg-soft)',  fg: 'var(--mint-positive-fg-strong)' },
};

export function TierBadge({ tier }: { tier: WocooTicket['tier'] }) {
  const c = TIER_PALETTE[tier];
  return (
    <span style={{ padding: '2px 8px', background: c.bg, color: c.fg, borderRadius: 'var(--mint-radius-pill)', fontSize: 'var(--mint-text-micro)', fontWeight: 600 }}>
      {tier}
    </span>
  );
}
