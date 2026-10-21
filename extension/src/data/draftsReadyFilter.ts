// Keeps "Drafts ready" honest between the agent's polls (which can be 20+ minutes apart while it
// drafts): a draft disappears as soon as its ticket is closed, moved, reassigned, or answered.

import type { JiraCommentDetail } from '../api/jira';
import type { ReadyDraftRow } from './agentDraftTypes';
import { parseJiraTime } from './outcomeCapture';

/** One of the user's open WOCOO tickets, fresh from Jira. */
export interface OpenTicket {
  key: string;
  status: string;
  updated: string;
}

const CLOSED_STATUS = /^(done|cancel|closed|resolved)/i;

/** Rows whose ticket is still open, still the user's and still in WOCOO (`open` comes from a
 *  search restricted to exactly that), and `recheck`: the kept rows whose ticket changed after
 *  the draft was written, so a reply may have landed. */
export function splitReadyRows(rows: ReadyDraftRow[], open: OpenTicket[]): { keep: ReadyDraftRow[]; recheck: ReadyDraftRow[] } {
  const byKey = new Map(open.map((t) => [t.key, t]));
  const keep = rows.filter((r) => {
    const t = byKey.get(r.key);
    return !!t && !CLOSED_STATUS.test(t.status.trim());
  });
  const recheck = keep.filter((r) => {
    const updated = parseJiraTime(byKey.get(r.key)!.updated);
    const drafted = parseJiraTime(r.created_at);
    return Number.isNaN(updated) || Number.isNaN(drafted) || updated > drafted;
  });
  return { keep, recheck };
}

/** Whether the user commented on the ticket after the draft was written. */
export function repliedAfterDraft(comments: JiraCommentDetail[], myAccountId: string, draftCreatedAt: string): boolean {
  const drafted = parseJiraTime(draftCreatedAt);
  if (Number.isNaN(drafted)) return false;
  return comments.some((c) => c.authorAccountId === myAccountId && parseJiraTime(c.created) > drafted);
}
