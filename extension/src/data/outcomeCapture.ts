// Records how the user's reply compared to the agent draft when they answered through Jira's
// own comment box (not the draft card) and then closed the ticket. Pure logic plus an
// orchestrator whose I/O is injected, so it is testable without Chrome or Jira.

import type { AgentDraft, DraftOutcomeRow, ReadyDraftRow } from './agentDraftTypes';
import { buildOutcomeRow, wasPostedThisSession } from './agentDraftView';
import type { JiraCommentDetail } from '../api/jira';
import { createSessionMarks } from './sessionMarks';

/** Jira's comment endpoint caps one response at this many comments. */
export const COMMENT_PAGE_CAP = 100;

/** Jira stamps offsets without a colon ("-0500"); Date.parse wants "-05:00". NaN when unparseable. */
export function parseJiraTime(s: string): number {
  return Date.parse(s.replace(/([+-]\d\d)(\d\d)$/, '$1:$2'));
}

/** The user's first comment created strictly after the draft, or null. Compared by timestamp,
 *  never by text presence (a mention-only reply has empty text but still counts). */
export function firstReplyAfterDraft(
  draft: AgentDraft,
  comments: JiraCommentDetail[],
  myAccountId: string,
): JiraCommentDetail | null {
  const draftAt = Date.parse(draft.created_at);
  const mine = comments
    .filter((c) => c.authorAccountId === myAccountId)
    .map((c) => ({ c, t: parseJiraTime(c.created) }))
    .filter((x) => !Number.isNaN(x.t) && x.t > draftAt)
    .sort((a, b) => a.t - b.t);
  return mine.length ? mine[0].c : null;
}

/** Outcome row for a reply made in Jira. `posted_text` is the text of the user's first comment created
 *  after the draft; '' when that comment has no text (mention-only still counts as posted); null when
 *  they never replied. */
export function buildJiraOutcomeRow(
  draft: AgentDraft,
  comments: JiraCommentDetail[],
  myAccountId: string,
  actualStatus: string | null,
  assignedAt: string | null = null,
): DraftOutcomeRow {
  const reply = firstReplyAfterDraft(draft, comments, myAccountId);
  const posted = reply ? reply.text ?? '' : null;
  // A reply saved with Jira's Reply: whose comment it went under (the person it greets).
  const parent = reply?.parentId ? comments.find((c) => c.id === reply.parentId) : undefined;
  const replyTarget = parent
    ? { commentId: parent.id, parentId: parent.parentId, accountId: parent.authorAccountId, name: parent.authorName }
    : null;
  return buildOutcomeRow(draft, posted, { id: draft.ticket }, actualStatus, { via: 'jira', assignedAt, replyTarget });
}

/** When the ticket was assigned, from the store's ready list (epoch seconds -> ISO). null when
 *  the ticket isn't listed, has no assignment time, or the list can't be read: it is optional context. */
export async function lookupAssignedAt(key: string, listReady: () => Promise<ReadyDraftRow[]>): Promise<string | null> {
  try {
    const row = (await listReady()).find((r) => r.key === key);
    if (row?.assigned_at != null) return new Date(row.assigned_at * 1000).toISOString();
  } catch { /* optional context */ }
  return null;
}

export interface ExistingReply {
  /** The user's first comment after the draft, or null. */
  reply: JiraCommentDetail | null;
  comments: JiraCommentDetail[];
  me: string;
}

/** Whether the user already replied in Jira after the draft was written (e.g. saved the
 *  pre-filled draft themselves). Throws when Jira can't be read; the caller decides. */
export async function checkExistingReply(
  draft: AgentDraft,
  deps: Pick<CaptureDeps, 'getComments' | 'getMyAccountId'>,
): Promise<ExistingReply> {
  const [comments, me] = await Promise.all([deps.getComments(draft.ticket), deps.getMyAccountId()]);
  return { reply: firstReplyAfterDraft(draft, comments, me), comments, me };
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
  | 'recorded' | 'no-draft' | 'not-postable' | 'card-recorded' | 'workflow-handled' | 'already-recorded' | 'failed';

// The agent's poll can supersede a draft before the user closes the ticket, so the draft the user
// actually saw is kept here from the moment the ticket opened.
const seenDrafts = new Map<string, AgentDraft>();
const captured = new Set<string>();
const capKey = (key: string, createdAt: string) => `${key}\u0000${createdAt}`;

// Tickets a Sidekick workflow (Reverse Fee, Overpayment Triage) replied on: that comment is the
// workflow's, not a reply based on the draft, so no outcome row is written for them.
const workflowHandled = createSessionMarks('agentDraftWorkflowHandled');

export function rememberDraft(draft: AgentDraft): void {
  seenDrafts.set(draft.ticket, draft);
}

/** Call when a workflow has posted its own reply on the ticket (before it transitions it). */
export function markWorkflowHandled(key: string): Promise<void> {
  return workflowHandled.mark(key);
}

export function wasWorkflowHandled(key: string): Promise<boolean> {
  return workflowHandled.has(key);
}

export function resetOutcomeCaptureState(): void {
  seenDrafts.clear();
  captured.clear();
  workflowHandled.resetMemory();
}

/** Called when a ticket moves to Done/Cancelled. Never throws. */
export async function captureJiraOutcome(deps: CaptureDeps, key: string, actualStatus: string): Promise<CaptureResult> {
  try {
    if (await wasWorkflowHandled(key)) return 'workflow-handled';
    let draft = seenDrafts.get(key) ?? null;
    if (!draft) draft = await deps.getDraft(key);
    if (!draft) return 'no-draft';
    // Only drafts the card could post carry a reply to compare against.
    if (draft.outcome !== 'draft' && draft.outcome !== 'needs_info') return 'not-postable';
    if (await wasPostedThisSession(key, draft.created_at)) return 'card-recorded';
    const ck = capKey(key, draft.created_at);
    if (captured.has(ck)) return 'already-recorded';

    const [comments, me] = await Promise.all([deps.getComments(key), deps.getMyAccountId()]);
    const assignedAt = await lookupAssignedAt(key, deps.listReady);

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
