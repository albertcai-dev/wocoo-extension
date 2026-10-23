// Stats view — full page reached by clicking the 📊 button in any header.
// Shows how solved tickets break down by Sidekick usage, plus per-button click counts.
// Data is local to this browser and starts from when tracking shipped (no backfill).

import { useEffect, useMemo, useState } from 'react';
import { loadUsageEvents, USAGE_STORAGE_KEY } from '../data/usageStore';
import { summarizeUsage, type SolveClass, type UsageEvent, type UsageRange } from '../data/usageStats';

const RANGES: Array<{ id: UsageRange; label: string }> = [
  { id: 'today', label: 'Today' },
  { id: 'week', label: 'This week' },
  { id: 'all', label: 'All time' },
];

const CLASS_ROWS: Array<{ id: SolveClass; label: string; color: string }> = [
  { id: 'sidekick', label: 'Solved through Sidekick', color: 'var(--mint-positive-fg-graphic)' },
  { id: 'assisted', label: 'Assisted by Sidekick', color: 'var(--mint-highlight-fg-graphic)' },
  { id: 'unassisted', label: 'Unassisted', color: 'var(--mint-fg-soft)' },
];

export function StatsView({ onBack }: { onBack: () => void }) {
  const [events, setEvents] = useState<UsageEvent[] | null>(null);
  const [range, setRange] = useState<UsageRange>('today');

  useEffect(() => {
    const read = () => { void loadUsageEvents().then(setEvents); };
    read();
    const onChange = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && USAGE_STORAGE_KEY in changes) read();
    };
    chrome.storage.onChanged.addListener(onChange);
    return () => chrome.storage.onChanged.removeListener(onChange);
  }, []);

  const summary = useMemo(() => (events ? summarizeUsage(events, range) : null), [events, range]);
  const maxClicks = summary ? Math.max(1, ...summary.buttons.map((b) => b.count)) : 1;
  const pct = (n: number) => (summary && summary.solved ? Math.round((n / summary.solved) * 100) : 0);

  return (
    <div style={{ minWidth: 280, padding: 'var(--mint-sp-3)', display: 'flex', flexDirection: 'column', gap: 'var(--mint-sp-3)' }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 'var(--mint-sp-2)' }}>
        <button
          onClick={onBack}
          title="Back"
          aria-label="Back"
          style={{
            width: 32, height: 32, borderRadius: 8,
            border: 'var(--mint-card-stroke)',
            background: 'var(--mint-bg-card)',
            color: 'var(--mint-fg-subdued-title)',
            cursor: 'pointer',
            fontSize: 14,
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          }}
        >
          ←
        </button>
        <span style={{ fontSize: 'var(--mint-text-h-sm)', fontWeight: 700, color: 'var(--mint-fg-strong)' }}>Sidekick Stats</span>
      </header>

      <div role="tablist" style={{ display: 'flex', gap: 4 }}>
        {RANGES.map((r) => (
          <button
            key={r.id}
            role="tab"
            aria-selected={range === r.id}
            onClick={() => setRange(r.id)}
            style={{
              flex: 1, padding: '6px 10px',
              borderRadius: 'var(--mint-radius-button)',
              border: 'var(--mint-card-stroke)',
              background: range === r.id ? 'var(--mint-fg-strong)' : 'var(--mint-bg-card)',
              color: range === r.id ? 'var(--mint-fg-inverted)' : 'var(--mint-fg-strong)',
              fontSize: 'var(--mint-text-micro)', fontWeight: 600, cursor: 'pointer',
            }}
          >
            {r.label}
          </button>
        ))}
      </div>

      {!summary ? (
        <div style={{ color: 'var(--mint-fg-soft)', fontSize: 'var(--mint-text-meta)' }}>Loading…</div>
      ) : (
        <>
          <section style={cardStyle}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <span style={{ fontSize: 28, fontWeight: 700, color: 'var(--mint-fg-strong)' }}>{summary.solved}</span>
              <span style={{ fontSize: 'var(--mint-text-meta)', color: 'var(--mint-fg-subdued-title)' }}>tickets solved</span>
            </div>
            {summary.solved > 0 ? (
              <div style={{ display: 'flex', height: 8, borderRadius: 4, overflow: 'hidden', background: 'var(--mint-bg-subtle)' }}>
                {CLASS_ROWS.map((c) => (
                  <div key={c.id} style={{ width: `${(summary.byClass[c.id] / summary.solved) * 100}%`, background: c.color }} />
                ))}
              </div>
            ) : null}
            {CLASS_ROWS.map((c) => (
              <StatRow
                key={c.id}
                label={<><span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: c.color, marginRight: 6 }} />{c.label}</>}
                value={`${summary.byClass[c.id]}${summary.solved ? ` · ${pct(summary.byClass[c.id])}%` : ''}`}
              />
            ))}
          </section>

          <section style={cardStyle}>
            <StatRow label="Tickets moved" value={String(summary.moved)} />
            <StatRow
              label="Tickets created"
              value={String(summary.created)}
              detail={summary.createdByKind.map((k) => `${k.kind} ${k.count}`).join(' · ')}
            />
          </section>

          <section style={{ display: 'flex', flexDirection: 'column', gap: 'var(--mint-sp-2)' }}>
            <h2 style={{ margin: 0, fontSize: 'var(--mint-text-h-sm)', fontWeight: 700, color: 'var(--mint-fg-strong)' }}>Button clicks</h2>
            <div style={{ ...cardStyle, gap: 6 }}>
              {summary.buttons.map((b) => (
                <div key={b.id} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--mint-text-micro)' }}>
                    <span style={{ color: b.count ? 'var(--mint-fg-strong)' : 'var(--mint-fg-soft)' }}>
                      {b.label}
                      {b.kind === 'lookup' ? <span style={{ color: 'var(--mint-fg-soft)' }}> · lookup</span> : null}
                    </span>
                    <span style={{ fontWeight: 600, color: 'var(--mint-fg-strong)' }}>{b.count}</span>
                  </div>
                  <div style={{ height: 4, borderRadius: 2, background: 'var(--mint-bg-subtle)' }}>
                    <div style={{
                      width: `${(b.count / maxClicks) * 100}%`, height: '100%', borderRadius: 2,
                      background: b.kind === 'workflow' ? 'var(--mint-positive-fg-graphic)' : 'var(--mint-highlight-fg-graphic)',
                    }} />
                  </div>
                </div>
              ))}
            </div>
          </section>

          <div style={{ fontSize: 'var(--mint-text-micro)', color: 'var(--mint-fg-soft)', lineHeight: 1.45 }}>
            Solved = Done, Cancelled or Moved. Lookup buttons (Atlas, Koho, i2c, Fetch) count as "assisted"; any other button counts as "through Sidekick". Stored in this browser only.
          </div>
        </>
      )}
    </div>
  );
}

const cardStyle: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 'var(--mint-sp-2)',
  padding: 'var(--mint-sp-3)',
  background: 'var(--mint-bg-card)',
  border: 'var(--mint-card-stroke)',
  borderRadius: 'var(--mint-radius-card)',
};

function StatRow({ label, value, detail }: { label: React.ReactNode; value: string; detail?: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 'var(--mint-text-meta)' }}>
        <span style={{ color: 'var(--mint-fg-subdued-title)', display: 'inline-flex', alignItems: 'center' }}>{label}</span>
        <span style={{ fontWeight: 700, color: 'var(--mint-fg-strong)' }}>{value}</span>
      </div>
      {detail ? <span style={{ fontSize: 'var(--mint-text-micro)', color: 'var(--mint-fg-soft)' }}>{detail}</span> : null}
    </div>
  );
}
