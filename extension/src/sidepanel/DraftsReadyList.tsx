// Home section listing tickets the draft agent has a reply waiting for. Renders nothing when the
// store is unreachable or empty: Home should not carry error noise for an optional integration.

import { useEffect, useState } from 'react';
import { listReadyDrafts } from '../api/draftStore';
import { getIssueCommentsDetailed, searchTickets } from '../api/jira';
import { repliedAfterDraft, splitReadyRows } from '../data/draftsReadyFilter';
import { getMyAccountId } from '../data/outcomeCaptureLive';
import type { ReadyDraftRow } from '../data/agentDraftTypes';
import { openTicketInJiraTab, ticketUrlFor } from '../data/jiraTab';
import { createLatestRefresher } from '../data/latestRefresh';

/** Opening a row switches the panel to the ticket AND shows it in the Jira tab, so the draft card's
 *  automatic prefill has the ticket's comment box to fill. */
async function openInJira(row: ReadyDraftRow): Promise<void> {
  try {
    await openTicketInJiraTab(ticketUrlFor(row), row.key, chrome.tabs as never);
  } catch (e) {
    console.debug('[DraftsReadyList] could not open the Jira tab', e);
  }
}

/** The store's ready drafts, minus tickets that are closed, moved, reassigned or already answered
 *  (the store only learns those at the agent's next poll). If Jira can't be reached, the store's
 *  list is shown as is; a ticket whose reply check fails is kept. */
async function loadReady(): Promise<ReadyDraftRow[]> {
  const rows = await listReadyDrafts();
  if (rows.length === 0) return rows;
  let open;
  try {
    const found = await searchTickets('project = WOCOO AND assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC', 100);
    open = found.map((t) => ({ key: t.id, status: t.status, updated: t.updated }));
  } catch (e) {
    console.debug('[DraftsReadyList] Jira check skipped', e);
    return rows;
  }
  const { keep, recheck } = splitReadyRows(rows, open);
  if (recheck.length === 0) return keep;
  const me = await getMyAccountId().catch(() => null);
  if (!me) return keep;
  const answered = new Set<string>();
  await Promise.all(recheck.map(async (r) => {
    try {
      if (repliedAfterDraft(await getIssueCommentsDetailed(r.key, { newest: true }), me, r.created_at)) answered.add(r.key);
    } catch { /* keep it */ }
  }));
  return keep.filter((r) => !answered.has(r.key));
}

export function DraftsReadyList({ onOpenTicket }: { onOpenTicket: (ticketKey: string) => void }) {
  const [rows, setRows] = useState<ReadyDraftRow[]>([]);

  // Load on mount, and (debounced) whenever the panel regains focus or becomes visible again.
  // Only the newest response is applied. Any failure (DraftStoreUnavailable or else): show nothing.
  useEffect(() => {
    const r = createLatestRefresher(loadReady, setRows, () => setRows([]), 1000);
    r.now();
    const onFocus = () => r.soon();
    const onVisible = () => { if (document.visibilityState === 'visible') r.soon(); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      r.dispose();
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  if (rows.length === 0) return null;

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 'var(--mint-sp-2)' }}>
      <h2 style={{ margin: 0, fontSize: 'var(--mint-text-h-sm)', fontWeight: 700, color: 'var(--mint-fg-strong)' }}>
        Drafts ready ({rows.length})
      </h2>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {rows.map((r) => (
          <button
            key={r.key}
            type="button"
            onClick={() => { onOpenTicket(r.key); void openInJira(r); }}
            style={{
              textAlign: 'left',
              padding: 'var(--mint-sp-2) var(--mint-sp-3)',
              background: 'var(--mint-bg-card)',
              border: 'var(--mint-card-stroke)',
              borderRadius: 'var(--mint-radius-card)',
              cursor: 'pointer',
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontWeight: 700, color: 'var(--mint-highlight-fg-strong)', fontSize: 'var(--mint-text-micro)' }}>{r.key}</span>
              {r.marker ? (
                <span style={{ fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-soft)' }}>{r.marker}</span>
              ) : null}
            </div>
            <div style={{ fontSize: 'var(--mint-text-meta)', color: 'var(--mint-fg-strong)', lineHeight: 1.4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {r.summary || <span style={{ color: 'var(--mint-fg-soft)', fontStyle: 'italic' }}>(no summary)</span>}
            </div>
          </button>
        ))}
      </div>
    </section>
  );
}
