// Tickets the draft agent has a reply waiting for, keyed by ticket, so Home can badge them in
// "All assigned to you". Empty when the store is unreachable: Home should not carry error noise
// for an optional integration.

import { useEffect, useState } from 'react';
import { listReadyDrafts } from '../api/draftStore';
import { getIssueCommentsDetailed, searchTickets } from '../api/jira';
import { repliedAfterDraft, splitReadyRows } from '../data/draftsReadyFilter';
import { getMyAccountId } from '../data/outcomeCaptureLive';
import type { ReadyDraftRow } from '../data/agentDraftTypes';
import { openTicketInJiraTab, ticketUrlFor } from '../data/jiraTab';
import { createLatestRefresher } from '../data/latestRefresh';

/** Opens a Home ticket in a new Jira tab (the panel switches to it separately). For a drafted
 *  ticket this also gives the draft card's automatic prefill the ticket's comment box to fill. */
export async function openTicketInNewJiraTab(row: { key: string; url?: string | null }): Promise<void> {
  try {
    await openTicketInJiraTab(ticketUrlFor(row), row.key, chrome.tabs as never, { newTab: true });
  } catch (e) {
    console.debug('[useReadyDrafts] could not open the Jira tab', e);
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
    console.debug('[useReadyDrafts] Jira check skipped', e);
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

export function useReadyDrafts(): Map<string, ReadyDraftRow> {
  const [rows, setRows] = useState<ReadyDraftRow[]>([]);

  // Load on mount, and (debounced) whenever the panel regains focus or becomes visible again.
  // Only the newest response is applied. Any failure (DraftStoreUnavailable or else): no badges.
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

  return new Map(rows.map((r) => [r.key, r]));
}
