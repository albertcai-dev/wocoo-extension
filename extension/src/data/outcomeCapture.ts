// Records how the user's reply compared to the agent draft when they answered through Jira's
// own comment box (not the draft card) and then closed the ticket. Pure logic plus an
// orchestrator whose I/O is injected, so it is testable without Chrome or Jira.

import type { AgentDraft, DraftOutcomeRow, ReadyDraftRow } from './agentDraftTypes';
import { buildOutcomeRow, wasPostedThisSession } from './agentDraftView';
import type { JiraCommentDetail } from '../api/jira';

/** Jira's comment endpoint caps one response at this many comments. */
export const COMMENT_PAGE_CAP = 100;

/** Jira stamps offsets without a colon ("-0500"); Date.parse wants "-05:00". NaN when unparseable. */
function parseJiraTime(s: string): number {
  return Date.parse(s.replace(/([+-]\d\d)(\d\d)$/, '$1:$2'));
}

/** Outcome row for a reply made in Jira. `posted_text` is the text of the user's first comment created
 *  after the draft; '' when that comment has no text (mention-only still counts as posted); null when
 *  they never replied. Compared by timestamp, never by text presence. */
export function buildJiraOutcomeRow(
  draft: AgentDraft,
  comments: JiraCommentDetail[],
  myAccountId: string,
  actualStatus: string | null,
  assignedAt: string | null = null,
): DraftOutcomeRow {
  const draftAt = Date.parse(draft.created_at);
  const mine = comments
    .filter((c) => c.authorAccountId === myAccountId)
    .map((c) => ({ c, t: parseJiraTime(c.created) }))
    .filter((x) => !Number.isNaN(x.t) && x.t > draftAt)
    .sort((a, b) => a.t - b.t);
  const posted = mine.length ? mine[0].c.text ?? '' : null;
  return buildOutcomeRow(draft, posted, { id: draft.ticket }, actualStatus, { via: 'jira', assignedAt });
}

/** Union of two comment lists by id, oldest first. */
export function mergeComments(a: JiraCommentDetail[], b: JiraCommentDetail[]): JiraCommentDetail[] {
  const byId = new Map<string, JiraCommentDetail>();
  for (const c of [...a, ...b]) if (!byId.has(c.id)) byId.set(c.id, c);
  return [...byId.values()]
    .map((c, i) => ({ c, i, t: parseJiraTime(c.created) || 0 }))
    .sort((x, y) => x.t - y.t || x.i - y.i)
    .map((x) => x.c);
}

export type CommentFetcher = (key: string, opts?: { newest?: boolean }) => Promise<JiraCommentDetail[]>;

/** All comments we can see: the oldest page, plus the newest page when the first hit the cap
 *  (a long thread's recent replies would otherwise be invisible). */
export async function fetchCommentsForOutcome(key: string, fetcher: CommentFetcher): Promise<JiraCommentDetail[]> {
  const oldest = await fetcher(key);
  if (oldest.length < COMMENT_PAGE_CAP) return oldest;
  const newest = await fetcher(key, { newest: true });
  return mergeComments(oldest, newest);
}

// --- orchestration ----------------------------------------------------------------------

export interface CaptureDeps {
  getDraft: (key: string) => Promise<AgentDraft | null>;
  getComments: (key: string) => Promise<JiraCommentDetail[]>;
  getMyAccountId: () => Promise<string>;
  listReady: () => Promise<ReadyDraftRow[]>;
  record: (row: DraftOutcomeRow) => Promise<void>;
}

export type CaptureResult =
  | 'recorded' | 'no-draft' | 'not-postable' | 'card-recorded' | 'already-recorded' | 'failed';

// The agent's poll can supersede a draft before the user closes the ticket, so the draft the user
// actually saw is kept here from the moment the ticket opened.
const seenDrafts = new Map<string, AgentDraft>();
const captured = new Set<string>();
const capKey = (key: string, createdAt: string) => `${key}\u0000${createdAt}`;

export function rememberDraft(draft: AgentDraft): void {
  seenDrafts.set(draft.ticket, draft);
}

export function resetOutcomeCaptureState(): void {
  seenDrafts.clear();
  captured.clear();
}

/** Called when a ticket moves to Done/Cancelled. Never throws. */
export async function captureJiraOutcome(deps: CaptureDeps, key: string, actualStatus: string): Promise<CaptureResult> {
  try {
    let draft = seenDrafts.get(key) ?? null;
    if (!draft) draft = await deps.getDraft(key);
    if (!draft) return 'no-draft';
    // Only drafts the card could post carry a reply to compare against.
    if (draft.outcome !== 'draft' && draft.outcome !== 'needs_info') return 'not-postable';
    if (wasPostedThisSession(key, draft.created_at)) return 'card-recorded';
    const ck = capKey(key, draft.created_at);
    if (captured.has(ck)) return 'already-recorded';

    const [comments, me] = await Promise.all([deps.getComments(key), deps.getMyAccountId()]);
    let assignedAt: string | null = null;
    try {
      const row = (await deps.listReady()).find((r) => r.key === key);
      if (row?.assigned_at != null) assignedAt = new Date(row.assigned_at * 1000).toISOString();
    } catch { /* assigned_at is optional context */ }

    captured.add(ck);
    try {
      await deps.record(buildJiraOutcomeRow(draft, comments, me, actualStatus, assignedAt));
    } catch (e) {
      captured.delete(ck);
      throw e;
    }
    return 'recorded';
  } catch (e) {
    console.warn('[outcomeCapture] could not record the jira-reply outcome', e);
    return 'failed';
  }
}
