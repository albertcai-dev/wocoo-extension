// Home view — the user's launchpad. Lists their active WOCOO tickets grouped by
// "Overpayment" vs "Other," with room for additional tooling sections over time.

import { useEffect, useState } from 'react';
import { searchTickets, type TicketRow } from '../api/jira';
import { MobileChequeValidationTile } from './MobileChequeValidation';
import { checkForRepliesViaBridge, backfillI2cViaBridge, type TicketReply } from '../api/bridge';
import { getTicket } from '../api/jira';

type LoadState = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; rows: TicketRow[] };

const ASSIGNED_ACTIVE_JQL =
  'project = WOCOO AND assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC';

const REPLIES_STORAGE_KEY = 'ticket_replies';
const SORT_STORAGE_KEY = 'home_sort_direction';

type SortDirection = 'newest' | 'oldest';

/** Sort by time-in-swimlane (`statusCategoryChangedAt`) then pull replied-to tickets to
 *  the top of the list — replies always win over sort order so nothing gets buried.
 *  'newest' = fewest days first (recently transitioned tickets at top).
 *  'oldest' = most days first (stalest tickets at top). */
/** A reply "counts" as attention-grabbing only when it isn't acknowledged yet. Acked
 *  replies remain in the map so the deeplink pill on the ticket panel can render,
 *  but the home list shouldn't keep coloring those rows red. */
function isUnacked(r: TicketReply | undefined): boolean {
  return !!r && r.acked !== true;
}

function orderRows(rows: TicketRow[], replies: Record<string, TicketReply>, sort: SortDirection): TicketRow[] {
  const withKeys = rows.map((r) => ({
    r,
    hasReply: isUnacked(replies[r.id]),
    ts: new Date(r.statusCategoryChangedAt).getTime() || 0,
  }));
  withKeys.sort((a, b) => {
    if (a.hasReply !== b.hasReply) return a.hasReply ? -1 : 1;
    // newest: bigger ts (more recent) first  →  fewer days in swimlane at top
    // oldest: smaller ts (older) first       →  more days in swimlane at top
    return sort === 'newest' ? b.ts - a.ts : a.ts - b.ts;
  });
  return withKeys.map((x) => x.r);
}

export function HomeView({ onOpenTicket, onOpenWiresPending, header }: { onOpenTicket: (ticketKey: string) => void; onOpenWiresPending: () => void; header: React.ReactNode }) {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [replies, setReplies] = useState<Record<string, TicketReply>>({});
  const [refreshing, setRefreshing] = useState(false);
  // Persist sort preference across side-panel opens so the user doesn't have to
  // re-pick every session. Defaults to 'newest' on first load.
  const [sort, setSort] = useState<SortDirection>('newest');
  useEffect(() => {
    chrome.storage.local.get(SORT_STORAGE_KEY).then((res) => {
      const v = res[SORT_STORAGE_KEY];
      if (v === 'oldest' || v === 'newest') setSort(v);
    });
  }, []);
  const changeSort = (next: SortDirection) => {
    setSort(next);
    void chrome.storage.local.set({ [SORT_STORAGE_KEY]: next });
  };

  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading' });
    searchTickets(ASSIGNED_ACTIVE_JQL)
      .then((rows) => { if (!cancelled) setState({ kind: 'ready', rows }); })
      .catch((e) => { if (!cancelled) setState({ kind: 'error', message: e?.message || String(e) }); });
    return () => { cancelled = true; };
  }, []);

  // Mirror chrome.storage.local[REPLIES_STORAGE_KEY] into React state so red dots
  // + reordering re-render as soon as the background poll updates the map.
  useEffect(() => {
    const read = () => {
      chrome.storage.local.get(REPLIES_STORAGE_KEY).then((res) => {
        const v = res[REPLIES_STORAGE_KEY] as Record<string, TicketReply> | undefined;
        setReplies(v || {});
      });
    };
    read();
    const onChange = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && REPLIES_STORAGE_KEY in changes) read();
    };
    chrome.storage.onChanged.addListener(onChange);
    return () => chrome.storage.onChanged.removeListener(onChange);
  }, []);

  const [backfilling, setBackfilling] = useState(false);
  const backfillI2c = async () => {
    if (backfilling || state.kind !== 'ready') return;
    if (!confirm('Backfill i2c tracking rows for all your assigned tickets that have a client email? (Deduplicates against existing rows — safe to run multiple times.)')) return;
    setBackfilling(true);
    try {
      // TicketRow doesn't carry clientEmail (it's not fetched by the JQL search to
      // keep the payload small). Fetch each ticket individually to pull clientEmail.
      // Only for the Home-loaded list, so ~50 tickets max — acceptable one-shot cost.
      const ninetyDaysAgoIso = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
      const rows = state.rows;
      const entries: Array<{ wocooTicketId: string; clientEmail: string; createdAt: string }> = [];
      // Sequential rather than Promise.all — Atlassian throttles concurrent requests
      // and this only runs on manual button press.
      for (const r of rows) {
        try {
          const t = await getTicket(r.id);
          if (t.clientEmail) {
            entries.push({ wocooTicketId: r.id, clientEmail: t.clientEmail, createdAt: ninetyDaysAgoIso });
          }
        } catch (e) {
          console.warn('[wocoo-backfill-i2c] ticket fetch failed for', r.id, e);
        }
      }
      if (entries.length === 0) {
        alert('No tickets with client emails found — nothing to backfill.');
        return;
      }
      const { added, skipped } = await backfillI2cViaBridge(entries);
      alert(`i2c backfill: added ${added} rows, skipped ${skipped} duplicates. Click Refresh replies to check Gmail.`);
    } catch (e: any) {
      console.warn('[wocoo-backfill-i2c] failed:', e);
      alert('Backfill failed: ' + (e?.message || String(e)));
    } finally {
      setBackfilling(false);
    }
  };

  const refreshReplies = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      // Call the bridge directly from the sidepanel — bounded by the bridge's own
      // 60s timeout. Skips the service-worker sendMessage round-trip that was
      // making the button feel indefinite. Result mirrors into chrome.storage.local
      // so the alarm-driven poll and this button stay in sync.
      const replies = await checkForRepliesViaBridge();
      const map: Record<string, TicketReply> = {};
      for (const r of replies) {
        const prior = map[r.wocooTicketId];
        if (!prior || (r.receivedAt || '') > (prior.receivedAt || '')) {
          map[r.wocooTicketId] = r;
        }
      }
      await chrome.storage.local.set({ [REPLIES_STORAGE_KEY]: map });
    } catch (e) {
      console.warn('[wocoo-refresh-replies] poll failed:', e);
    } finally {
      setRefreshing(false);
    }
  };

  const allAssigned = state.kind === 'ready' ? orderRows(state.rows, replies, sort) : [];

  return (
    <div style={{ minWidth: 280, padding: 'var(--mint-sp-3)', display: 'flex', flexDirection: 'column', gap: 'var(--mint-sp-3)' }}>
      {/* Settings button rides on the same row as the "Home" title so the panel
          doesn't burn a full header row + gap on what's effectively one icon. */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--mint-sp-2)' }}>
        <h1 style={{ margin: 0, fontSize: 'var(--mint-text-h-md)', fontWeight: 700, color: 'var(--mint-fg-strong)' }}>Home</h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <button
            type="button"
            onClick={backfillI2c}
            disabled={backfilling || state.kind !== 'ready'}
            title="One-shot: stub i2c tracking rows for every assigned ticket with a client email. Safe to re-run (deduplicates)."
            style={{
              padding: '4px 8px',
              fontSize: 'var(--mint-text-nano)',
              background: 'var(--mint-bg-subtle)',
              border: 'var(--mint-card-stroke)',
              borderRadius: 'var(--mint-radius-button)',
              color: 'var(--mint-fg-strong)',
              cursor: backfilling ? 'wait' : 'pointer',
              opacity: backfilling ? 0.55 : 1,
              display: 'flex', alignItems: 'center', gap: 4,
            }}
          >
            <span>{backfilling ? '⏳' : '📥'}</span>
            <span>{backfilling ? 'Backfilling…' : 'Backfill i2c'}</span>
          </button>
          <button
            type="button"
            onClick={refreshReplies}
            disabled={refreshing}
            title="Re-poll Gmail for new replies to Koho emails / i2c form submissions"
            style={{
              padding: '4px 8px',
              fontSize: 'var(--mint-text-nano)',
              background: 'var(--mint-bg-subtle)',
              border: 'var(--mint-card-stroke)',
              borderRadius: 'var(--mint-radius-button)',
              color: 'var(--mint-fg-strong)',
              cursor: refreshing ? 'wait' : 'pointer',
              opacity: refreshing ? 0.55 : 1,
              display: 'flex', alignItems: 'center', gap: 4,
            }}
          >
            <span style={{ display: 'inline-block', transformOrigin: 'center', animation: refreshing ? 'wocoo-spin 1s linear infinite' : 'none' }}>🔄</span>
            <span>{refreshing ? 'Refreshing…' : 'Refresh replies'}</span>
          </button>
          {header}
        </div>
      </div>
      <style>{`@keyframes wocoo-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>

      {state.kind === 'loading' ? (
        <div style={{ fontSize: 'var(--mint-text-meta)', color: 'var(--mint-fg-soft)' }}>Loading your tickets…</div>
      ) : null}
      {state.kind === 'error' ? (
        <div role="alert" style={{ padding: '8px 12px', background: 'var(--mint-negative-bg-soft)', color: 'var(--mint-negative-fg-strong)', fontSize: 'var(--mint-text-meta)', borderRadius: 'var(--mint-radius-button)' }}>
          ⚠ {state.message}
        </div>
      ) : null}

      {state.kind === 'ready' ? (
        <>
          <Section
            title="All assigned to you"
            count={allAssigned.length}
            right={<SortToggle value={sort} onChange={changeSort} />}
          >
            {allAssigned.length === 0 ? (
              <EmptyRow text="No active tickets assigned to you." />
            ) : (
              allAssigned.map((r) => <TicketListRow key={r.id} row={r} reply={replies[r.id]} onClick={() => onOpenTicket(r.id)} />)
            )}
          </Section>

          <Section title="Tools" count={null}>
            <ToolTile
              icon="⚡"
              title="Wires Pending Posting"
              subtitle="Auto-verify each Pending Posting wire on Ledge / Atlassian and flip the sheet to Posted."
              onClick={onOpenWiresPending}
            />
            <MobileChequeValidationTile />
          </Section>
        </>
      ) : null}
    </div>
  );
}

function Section({ title, count, children, right }: { title: string; count: number | null; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 'var(--mint-sp-2)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <h2 style={{ margin: 0, fontSize: 'var(--mint-text-h-sm)', fontWeight: 700, color: 'var(--mint-fg-strong)' }}>{title}</h2>
        {count != null ? (
          <span style={{ fontSize: 'var(--mint-text-micro)', color: 'var(--mint-fg-soft)' }}>· {count}</span>
        ) : null}
        {right ? <span style={{ marginLeft: 'auto' }}>{right}</span> : null}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>{children}</div>
    </section>
  );
}

/** Two-button segmented toggle for time-in-swimlane sort direction. Persists to
 *  chrome.storage.local so the user's preference survives side-panel re-opens. */
function SortToggle({ value, onChange }: { value: SortDirection; onChange: (v: SortDirection) => void }) {
  const buttonStyle = (active: boolean): React.CSSProperties => ({
    padding: '3px 8px',
    fontSize: 'var(--mint-text-nano)',
    fontWeight: 600,
    border: 'none',
    background: active ? 'var(--mint-fg-strong)' : 'transparent',
    color: active ? 'var(--mint-fg-inverted)' : 'var(--mint-fg-soft)',
    cursor: 'pointer',
    borderRadius: 9999,
  });
  return (
    <div
      role="group"
      aria-label="Sort by days in swimlane"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 2,
        padding: 2,
        background: 'var(--mint-bg-subtle)',
        border: 'var(--mint-card-stroke)',
        borderRadius: 9999,
      }}
    >
      <button
        type="button"
        onClick={() => onChange('newest')}
        title="Newest first — recently transitioned tickets at top (fewest days)"
        style={buttonStyle(value === 'newest')}
      >↓ Newest</button>
      <button
        type="button"
        onClick={() => onChange('oldest')}
        title="Oldest first — stalest tickets at top (most days)"
        style={buttonStyle(value === 'oldest')}
      >↑ Oldest</button>
    </div>
  );
}

function EmptyRow({ text }: { text: string }) {
  return (
    <div style={{ padding: 'var(--mint-sp-2) var(--mint-sp-3)', background: 'var(--mint-bg-subtle)', borderRadius: 'var(--mint-radius-card)', fontSize: 'var(--mint-text-micro)', color: 'var(--mint-fg-soft)', fontStyle: 'italic' }}>
      {text}
    </div>
  );
}

function TicketListRow({ row, reply, onClick }: { row: TicketRow; reply?: TicketReply; onClick: () => void }) {
  const hasReply = isUnacked(reply);
  return (
    <button
      onClick={onClick}
      style={{
        textAlign: 'left',
        padding: 'var(--mint-sp-2) var(--mint-sp-3)',
        background: hasReply ? 'var(--mint-negative-bg-soft)' : 'var(--mint-bg-card)',
        border: hasReply ? '1px solid var(--mint-negative-fg-graphic)' : 'var(--mint-card-stroke)',
        borderRadius: 'var(--mint-radius-card)',
        cursor: 'pointer',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <PriorityDot priority={row.priority} />
        <span style={{ fontWeight: 700, color: 'var(--mint-highlight-fg-strong)', fontSize: 'var(--mint-text-micro)' }}>{row.id}</span>
        <span style={{ fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-soft)' }}>· {row.status}</span>
        {hasReply ? (
          <span
            title={`New ${reply!.kind === 'koho' ? 'Koho' : 'i2c'} reply — click to open`}
            style={{
              display: 'inline-block',
              width: 8, height: 8, borderRadius: 9999,
              background: 'var(--mint-negative-fg-graphic)',
              flexShrink: 0,
              boxShadow: '0 0 0 3px var(--mint-negative-bg-soft)',
            }}
          />
        ) : null}
        <DaysInSwimlanePill sinceIso={row.statusCategoryChangedAt} />
      </div>
      <div style={{ fontSize: 'var(--mint-text-meta)', color: 'var(--mint-fg-strong)', lineHeight: 1.4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {row.summary || <span style={{ color: 'var(--mint-fg-soft)', fontStyle: 'italic' }}>(no summary)</span>}
      </div>
      {hasReply ? (
        <div style={{ fontSize: 'var(--mint-text-nano)', color: 'var(--mint-negative-fg-strong)', fontWeight: 600 }}>
          📬 New {reply!.kind === 'koho' ? 'Koho' : 'i2c'} reply — {reply!.snippet.slice(0, 80)}{reply!.snippet.length > 80 ? '…' : ''}
        </div>
      ) : (
        <div style={{ fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-soft)' }}>
          {row.issueType}
        </div>
      )}
    </button>
  );
}

function PriorityDot({ priority }: { priority: TicketRow['priority'] }) {
  const map: Record<TicketRow['priority'], string> = {
    Highest: 'var(--mint-negative-fg-graphic)',
    High: 'var(--mint-negative-fg-graphic)',
    Medium: 'var(--mint-warning-fg-graphic)',
    Low: 'var(--mint-fg-soft)',
    Lowest: 'var(--mint-fg-soft)',
  };
  return <span style={{ width: 8, height: 8, borderRadius: 9999, background: map[priority] || 'var(--mint-fg-soft)', flexShrink: 0 }} title={priority} />;
}

function TierPill({ tier }: { tier: TicketRow['tier'] }) {
  return (
    <span style={{ marginLeft: 'auto', padding: '1px 6px', background: 'var(--mint-highlight-bg-soft)', color: 'var(--mint-highlight-fg-strong)', borderRadius: 9999, fontSize: 'var(--mint-text-nano)', fontWeight: 600 }}>
      {tier}
    </span>
  );
}
void TierPill;

/** Days sitting in the current swimlane, computed from Jira's `statusCategoryChangedAt`
 *  (Triage → Back Office → Done). Colours ramp: soft under 3d, warning at 3–6d, negative
 *  at 7d+ so stale tickets pop visually. Tooltip shows the exact transition timestamp. */
function DaysInSwimlanePill({ sinceIso }: { sinceIso: string }) {
  const since = new Date(sinceIso);
  const ms = Date.now() - since.getTime();
  const days = Math.max(0, Math.floor(ms / (1000 * 60 * 60 * 24)));
  const label = days === 0 ? 'today' : `${days}d`;

  let bg = 'var(--mint-bg-subtle)';
  let fg = 'var(--mint-fg-soft)';
  if (days >= 7) { bg = 'var(--mint-negative-bg-soft)'; fg = 'var(--mint-negative-fg-strong)'; }
  else if (days >= 3) { bg = 'var(--mint-warning-bg-soft)'; fg = 'var(--mint-warning-fg-strong)'; }

  const title = isNaN(since.getTime())
    ? 'Days in current swimlane (unknown)'
    : `Entered current swimlane ${since.toLocaleString('en-CA', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })}`;

  return (
    <span title={title} style={{ marginLeft: 'auto', padding: '1px 6px', background: bg, color: fg, borderRadius: 9999, fontSize: 'var(--mint-text-nano)', fontWeight: 600 }}>
      {label}
    </span>
  );
}

function ToolTile({ icon, title, subtitle, onClick }: { icon: string; title: string; subtitle: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'flex-start', gap: 10,
        padding: 'var(--mint-sp-3)',
        background: 'var(--mint-bg-card)',
        border: 'var(--mint-card-stroke)',
        borderRadius: 'var(--mint-radius-card)',
        textAlign: 'left',
        cursor: 'pointer',
        width: '100%',
        boxSizing: 'border-box',
      }}
    >
      <span style={{ fontSize: 22, lineHeight: 1 }}>{icon}</span>
      <span style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
        <span style={{ fontSize: 'var(--mint-text-meta)', fontWeight: 700, color: 'var(--mint-fg-strong)' }}>{title}</span>
        <span style={{ fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-soft)', lineHeight: 1.45 }}>{subtitle}</span>
      </span>
    </button>
  );
}
