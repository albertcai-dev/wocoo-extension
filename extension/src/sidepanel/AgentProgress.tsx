// Live progress for the Sidekick Agent card in Settings: the ticket being worked and its
// checklist, tickets waiting on Compass, and the queue. Pure render of a CardView; the polling
// and the 1 s clock live in useAgentStatus.

import { useState } from 'react';
import type { CardView, QueueTag, RowState } from '../data/agentStatus';
import {
  QUEUE_PREVIEW, QUEUE_TAG_LABEL, currentMeta, emptyFooterText, formatClock, slowNote, waitingNote,
} from '../data/agentProgressText';

type Current = NonNullable<CardView['current']>;
type IdleLine = NonNullable<CardView['idleLine']>;

/** `now` (epoch seconds) is the clock the view was computed at; timers are already in `view`. */
export function AgentProgress({ view }: { view: CardView; now: number }) {
  // Keyed by name: an index key would remount (and collapse "+N more") when Waiting appears.
  const sections: { name: string; node: React.ReactNode }[] = [];

  if (view.current || view.idleLine || view.finishing) {
    sections.push({ name: 'current', node: (
      <div>
        {view.finishing ? (
          <div style={{ ...nano, marginBottom: view.current ? 6 : 0 }}>
            Finishing <b style={{ color: 'var(--mint-fg-subdued-title)' }}>{view.finishing}</b>, then stopping
          </div>
        ) : null}
        {view.current ? <CurrentTicket c={view.current} /> : null}
        {!view.current && view.idleLine ? <Idle line={view.idleLine} footer={view.emptyFooter} /> : null}
      </div>
    ) });
  }

  if (view.waiting.length > 0) sections.push({ name: 'waiting', node: <Waiting rows={view.waiting} /> });

  if (view.solo) {
    sections.push({ name: 'solo', node: (
      <div style={nano}>
        Solving only <b style={{ color: 'var(--mint-fg-subdued-title)' }}>{view.solo}</b>, then pausing.
      </div>
    ) });
  } else if (view.queue.length > 0) {
    sections.push({ name: 'queue', node: <Queue label={view.queueLabel} rows={view.queue} /> });
  }

  if (sections.length === 0) return null;
  return (
    <>
      <style>{PULSE_CSS}</style>
      {sections.map((s) => (
        <div key={s.name}>
          <div style={divider} />
          {s.node}
        </div>
      ))}
    </>
  );
}

function CurrentTicket({ c }: { c: Current }) {
  const slow = c.slow !== null;
  return (
    <div>
      <div style={{ ...rowStyle, flexWrap: 'wrap', rowGap: 2 }}>
        <span style={keyStyle}>{c.key}</span>
        {c.system ? <span style={systemTag}>{c.system}</span> : null}
        <span style={{ ...meta, marginLeft: 'auto', color: slow ? 'var(--mint-negative-fg-strong)' : meta.color }}>
          {currentMeta(c)}
        </span>
      </div>
      <div style={{ ...summary, marginTop: 3 }} title={c.summary}>{c.summary}</div>
      <div style={barTrack}>
        <div style={{
          height: '100%', borderRadius: 2, width: `${c.barPct}%`,
          background: slow ? 'var(--mint-negative-fg-graphic)' : 'var(--mint-highlight-fg-graphic)',
        }} />
      </div>
      <ul style={{ margin: '8px 0 0', padding: 0, listStyle: 'none' }}>
        {c.rows.map((r) => (
          <StepRow key={r.id} label={r.label} state={r.state} seconds={r.seconds} slow={slow} ifNeeded={r.id === 'compass'} />
        ))}
      </ul>
      {c.slow ? (
        <div style={{ ...note, background: 'var(--mint-negative-bg-soft)', color: 'var(--mint-negative-fg-strong)' }}>
          {slowNote(c.slow)}
        </div>
      ) : null}
    </div>
  );
}

function StepRow({ label, state, seconds, slow, ifNeeded }: {
  label: string; state: RowState; seconds: number | null; slow: boolean; ifNeeded: boolean;
}) {
  const time = seconds === null ? null : formatClock(seconds);
  const li: React.CSSProperties = {
    display: 'flex', gap: 8, alignItems: 'center', fontSize: 'var(--mint-text-meta)', padding: '3px 0',
    color: 'var(--mint-fg-subdued-title)',
  };
  if (state === 'done') {
    return (
      <li style={li}>
        <span style={{ ...dot, background: 'var(--mint-positive-fg-graphic)' }}>✓</span>
        {label}
        {time ? <span style={stepTime}>{time}</span> : null}
      </li>
    );
  }
  if (state === 'now') {
    const red = slow ? 'var(--mint-negative-fg-strong)' : undefined;
    return (
      <li style={li}>
        {slow ? (
          <span style={{ ...dot, background: 'var(--mint-negative-fg-graphic)', boxShadow: '0 0 0 3px var(--mint-negative-bg-soft)' }}>!</span>
        ) : (
          <span className="wocoo-agent-pulse" style={{ ...dot, background: 'var(--mint-highlight-fg-graphic)', boxShadow: '0 0 0 3px var(--mint-highlight-bg-soft)' }} />
        )}
        <span style={{ color: red ?? 'var(--mint-fg-strong)', fontWeight: 700 }}>{label}</span>
        {time ? <span style={{ ...stepTime, color: red ?? stepTime.color }}>{time}</span> : null}
      </li>
    );
  }
  return (
    <li style={li}>
      <span style={{
        ...dot, background: 'var(--mint-bg-card)',
        border: `1.5px ${state === 'skipped' ? 'dashed' : 'solid'} var(--mint-outline)`,
      }} />
      <span style={{ color: 'var(--mint-fg-inactive)' }}>
        {label}
        {state === 'todo' && ifNeeded ? <span style={{ fontSize: 'var(--mint-text-nano)' }}> (if needed)</span> : null}
      </span>
    </li>
  );
}

const IDLE_DOT: Record<IdleLine['tone'], string> = {
  neutral: 'var(--mint-fg-soft)',
  warning: 'var(--mint-warning-fg-graphic)',
  negative: 'var(--mint-negative-fg-graphic)',
};

function Idle({ line, footer }: { line: IdleLine; footer: CardView['emptyFooter'] }) {
  const text = footer ? emptyFooterText(footer) : null;
  return (
    <div>
      <div style={rowStyle}>
        <span style={{ ...dot, width: 10, height: 10, background: IDLE_DOT[line.tone] }} />
        <span style={{
          fontSize: 'var(--mint-text-meta)', fontWeight: 700,
          color: line.tone === 'negative' ? 'var(--mint-negative-fg-strong)'
            : line.tone === 'warning' ? 'var(--mint-warning-fg-strong)' : 'var(--mint-fg-strong)',
        }}>{line.text}</span>
        {line.aside ? <span style={{ ...meta, marginLeft: 'auto' }}>{line.aside}</span> : null}
      </div>
      {text ? (
        <div style={{ ...nano, marginTop: 4 }}>
          {text.key ? <>Last: <b style={{ color: 'var(--mint-fg-subdued-title)' }}>{text.key}</b></> : null}
          {text.tail}
        </div>
      ) : null}
    </div>
  );
}

function Waiting({ rows }: { rows: CardView['waiting'] }) {
  return (
    <div>
      <div style={{ ...label, color: 'var(--mint-warning-fg-strong)' }}>Waiting on Compass · {rows.length}</div>
      {rows.map((w, i) => (
        <div key={w.key}>
          <div style={queueRow}>
            <span style={{
              ...dot, width: 10, height: 10, fontSize: 7, alignSelf: 'center',
              background: 'var(--mint-warning-fg-graphic)', boxShadow: '0 0 0 3px var(--mint-warning-bg-soft)',
            }}>…</span>
            <span style={keyStyle}>{w.key}</span>
            <span style={summary} title={w.summary}>{w.summary}</span>
            <span style={{ ...bump, ...BUMP.compass }}>{w.minutesLeft}m left</span>
          </div>
          {i === 0 ? <div style={{ ...nano, margin: '2px 0 0 18px' }}>{waitingNote(w.askedMinAgo)}</div> : null}
        </div>
      ))}
    </div>
  );
}

function Queue({ label: text, rows }: { label: CardView['queueLabel']; rows: CardView['queue'] }) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? rows : rows.slice(0, QUEUE_PREVIEW);
  const more = rows.length - shown.length;
  return (
    <div>
      <div style={label}>{text} · {rows.length}</div>
      {shown.map((q, i) => (
        <div key={q.key} style={queueRow}>
          <span style={{ fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-inactive)', width: 10, flex: 'none' }}>{i + 1}</span>
          <span style={keyStyle}>{q.key}</span>
          <span style={summary} title={q.summary}>{q.summary}</span>
          {q.tag ? <span style={{ ...bump, ...BUMP[q.tag] }}>{QUEUE_TAG_LABEL[q.tag]}</span> : null}
        </div>
      ))}
      {more > 0 ? (
        <button type="button" onClick={() => setExpanded(true)} style={moreBtn}>+{more} more</button>
      ) : null}
    </div>
  );
}

// The pulse is a class so prefers-reduced-motion can switch it off.
const PULSE_CSS = `@keyframes wocoo-agent-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .55; } }
.wocoo-agent-pulse { animation: wocoo-agent-pulse 1.6s infinite; }
@media (prefers-reduced-motion: reduce) { .wocoo-agent-pulse { animation: none; } }`;

const divider: React.CSSProperties = { height: 1, background: 'var(--mint-outline)', margin: '10px 0' };
const rowStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 6 };
const meta: React.CSSProperties = {
  fontSize: 'var(--mint-text-micro)', color: 'var(--mint-fg-soft)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
};
const nano: React.CSSProperties = { fontSize: 'var(--mint-text-micro)', color: 'var(--mint-fg-soft)', lineHeight: 1.4 };
const keyStyle: React.CSSProperties = {
  fontSize: 'var(--mint-text-micro)', fontWeight: 700, color: 'var(--mint-highlight-fg-strong)',
  fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
};
const summary: React.CSSProperties = {
  fontSize: 'var(--mint-text-meta)', color: 'var(--mint-fg-strong)',
  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0,
};
const label: React.CSSProperties = {
  fontSize: 'var(--mint-text-nano)', fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase',
  color: 'var(--mint-fg-inactive)', marginBottom: 6,
};
const systemTag: React.CSSProperties = {
  fontSize: 'var(--mint-text-nano)', fontWeight: 700, padding: '1px 6px', borderRadius: 'var(--mint-radius-pill)',
  background: 'var(--mint-bg-subtle)', border: 'var(--mint-card-stroke)', color: 'var(--mint-fg-subdued-title)', whiteSpace: 'nowrap',
};
const barTrack: React.CSSProperties = {
  height: 4, background: 'var(--mint-neutral-bg-soft)', borderRadius: 2, marginTop: 8, overflow: 'hidden',
};
const dot: React.CSSProperties = {
  width: 14, height: 14, borderRadius: '50%', flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center',
  fontSize: 9, color: 'var(--mint-fg-inverted)', boxSizing: 'border-box',
};
const stepTime: React.CSSProperties = {
  marginLeft: 'auto', fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-soft)',
  fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
};
const queueRow: React.CSSProperties = { display: 'flex', gap: 8, alignItems: 'baseline', padding: '3px 0' };
const bump: React.CSSProperties = {
  fontSize: 'var(--mint-text-nano)', padding: '1px 5px', borderRadius: 4, marginLeft: 'auto', whiteSpace: 'nowrap', flex: 'none',
};
const BUMP: Record<QueueTag, React.CSSProperties> = {
  solve: { color: 'var(--mint-highlight-fg-strong)', background: 'var(--mint-highlight-bg-soft)' },
  compass: { color: 'var(--mint-warning-fg-strong)', background: 'var(--mint-warning-bg-soft)' },
  compass_timeout: { color: 'var(--mint-warning-fg-strong)', background: 'var(--mint-warning-bg-soft)' },
  reply: { color: 'var(--mint-positive-fg-strong)', background: 'var(--mint-positive-bg-soft)' },
};
const note: React.CSSProperties = {
  marginTop: 8, fontSize: 'var(--mint-text-micro)', lineHeight: 1.4, padding: '6px 8px', borderRadius: 6,
};
const moreBtn: React.CSSProperties = {
  marginTop: 2, padding: 0, border: 'none', background: 'none', cursor: 'pointer',
  fontSize: 'var(--mint-text-micro)', color: 'var(--mint-highlight-fg-strong)', fontFamily: 'inherit',
};
