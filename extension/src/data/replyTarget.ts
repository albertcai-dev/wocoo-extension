// Who an agent draft replies under, and the greeting that goes with it. Pure, so Post, the
// Jira-tab prefill and outcome recording all apply the same rule.
//
// The rule (Albert's): walk comments newest to oldest, skip his team and automation accounts,
// reply under the first comment left. No such comment → a normal top-level comment.

import type { JiraCommentDetail } from '../api/jira';
import type { DraftSegment } from './agentDraftTypes';

export interface ReplyTarget {
  commentId: string;
  /** The target's own parent when it is itself a threaded reply. */
  parentId: string | null;
  accountId: string;
  name: string;
}

/** `comments` oldest first (as getIssueCommentsDetailed returns them). */
export function pickReplyTarget(comments: JiraCommentDetail[], team: ReadonlySet<string>): ReplyTarget | null {
  for (let i = comments.length - 1; i >= 0; i--) {
    const c = comments[i];
    if (team.has(c.authorAccountId) || c.authorAccountType === 'app' || !c.authorAccountId) continue;
    return { commentId: c.id, parentId: c.parentId, accountId: c.authorAccountId, name: c.authorName };
  }
  return null;
}

/** The `parentId` to send when replying under `target`. Jira threads are one level deep, so a
 *  target that is itself a reply is answered under its thread root; sending the reply's own id
 *  400s with "Parent comment not found, and no child comments exist" (WOCOO-29976, 2026-10-26). */
export function replyParentId(target: ReplyTarget): string {
  return target.parentId ?? target.commentId;
}

const GREETING_PREFIX = /^\s*(hi|hey|hello)?\s*$/i;

/** Index of the draft's greeting mention: the first mention, if only a greeting word precedes it. */
function greetingMentionIndex(segments: DraftSegment[]): number {
  let before = '';
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    if (s.type === 'mention') return GREETING_PREFIX.test(before) ? i : -1;
    if (s.type !== 'text') return -1;
    before += s.text;
  }
  return -1;
}

/** The draft, greeting the target: an existing greeting mention is pointed at the target, and a
 *  draft with no greeting mention gets "Hi @<target>, " in front. Later mentions are untouched. */
export function greetTarget(segments: DraftSegment[], target: ReplyTarget): DraftSegment[] {
  const pill: DraftSegment = { type: 'mention', text: `@${target.name}`, accountId: target.accountId };
  const i = greetingMentionIndex(segments);
  if (i === -1) return [{ type: 'text', text: 'Hi ' }, pill, { type: 'text', text: ', ' }, ...segments];
  const out = segments.slice();
  out[i] = pill;
  return out;
}

/** For comparing posted text with the draft only: drops one leading "@<targetName>" (the tag
 *  Jira's Reply inserts) so the reply greeting never counts as an edit. */
export function stripReplyGreeting(text: string, targetName: string | null): string {
  if (!targetName) return text;
  const tag = `@${targetName}`;
  const t = text.replace(/^[\s ​]+/, '');
  if (!t.startsWith(tag)) return text;
  return t.slice(tag.length).replace(/^[\s ​,]+/, '');
}
