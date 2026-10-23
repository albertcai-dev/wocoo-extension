// Pure helpers for the agent draft card: turning the agent's segments into editable text and
// back, deciding whether Post is allowed, and resolving @mentions to Jira accounts.

import type { AgentDraft, DraftFlag, DraftOutcomeRow, DraftSegment } from './agentDraftTypes';
import type { WocooTicket } from './mockTicket';
import { createSessionMarks } from './sessionMarks';
import { greetTarget, stripReplyGreeting, type ReplyTarget } from './replyTarget';

/** Text a segment shows in the editor. Mention text already carries its "@". A smartcard shows its
 *  href (that is what gets posted as the block card), falling back to text only when it has none. */
function segmentText(s: DraftSegment): string {
  if (s.type === 'smartcard') return s.href || s.text || '';
  return s.text ?? '';
}

const isWordChar = (c: string | undefined) => !!c && /[A-Za-z0-9_]/.test(c);

/** indexOf that refuses a hit sitting inside a longer word (e.g. "here" inside "there"). */
function indexOfBounded(hay: string, token: string, from: number): number {
  let at = hay.indexOf(token, from);
  while (at >= 0) {
    const beforeOk = !isWordChar(token[0]) || !isWordChar(hay[at - 1]);
    const afterOk = !isWordChar(token[token.length - 1]) || !isWordChar(hay[at + token.length]);
    if (beforeOk && afterOk) return at;
    at = hay.indexOf(token, at + 1);
  }
  return -1;
}

export function segmentsToPlain(segments: DraftSegment[]): string {
  return segments.map(segmentText).join('');
}

/** Turns edited text back into segments. Mention, link and smartcard segments from the original
 *  are re-attached, in order, wherever their text still appears; removed ones fall away. */
export function plainToSegments(edited: string, original: DraftSegment[]): DraftSegment[] {
  const out: DraftSegment[] = [];
  let pos = 0;
  const pushText = (t: string) => { if (t) out.push({ type: 'text', text: t }); };
  for (const seg of original) {
    if (seg.type === 'text') continue;
    const token = segmentText(seg);
    if (!token) continue;
    const at = indexOfBounded(edited, token, pos);
    if (at < 0) continue;
    pushText(edited.slice(pos, at));
    out.push({ ...seg, text: token });
    pos = at + token.length;
  }
  pushText(edited.slice(pos));
  return out;
}

/** Whether Post may be pressed. `text` is the current editor text (defaults to the draft's own). */
export function canPost(draft: AgentDraft, actionDone: boolean, text: string = segmentsToPlain(draft.segments)): boolean {
  if (draft.outcome !== 'draft' && draft.outcome !== 'needs_info') return false;
  if (!text.trim()) return false;
  if (draft.action_needed && !actionDone) return false;
  return true;
}

/** Button label: no suggested status means a plain post with no transition. */
export function postLabel(draft: AgentDraft): string {
  return draft.suggested_status ? `Post + mark ${draft.suggested_status}` : 'Post';
}

/** Whether a transition is still needed: not when none is suggested or the ticket already sits in it. */
export function shouldTransition(suggestedStatus: string | null, currentStatus: string): boolean {
  if (!suggestedStatus) return false;
  return suggestedStatus.trim().toLowerCase() !== currentStatus.trim().toLowerCase();
}

/** The ticket's status as Jira names it, for comparing with a suggested status: the raw Jira
 *  name while it still matches the panel's status bucket, else the bucket (an update such as
 *  `{ ...ticket, status: 'Done' }` changes the bucket but leaves the raw name stale). */
export function currentStatusName(ticket: Pick<WocooTicket, 'status' | 'jiraStatus'>): string {
  const raw = ticket.jiraStatus;
  return raw && raw.name && raw.bucket === ticket.status ? raw.name : ticket.status;
}

/** The outcome row Sidekick records after a post. `actualStatus` is the ticket's status as it
 *  really is once the post (and any transition) has settled. */
export function buildOutcomeRow(
  draft: AgentDraft,
  postedText: string | null,
  ticket: { id: string },
  actualStatus: string | null,
  opts: { via?: DraftOutcomeRow['via']; assignedAt?: string | null; replyTarget?: ReplyTarget | null } = {},
): DraftOutcomeRow {
  // A threaded reply: compare against the draft as greeted for that person, and without the tag
  // Jira's Reply puts in front, so neither counts as the user's edit.
  const target = opts.replyTarget ?? null;
  const segments = target ? greetTarget(draft.segments, target) : draft.segments;
  return {
    key: ticket.id,
    work_type: draft.work_type,
    draft_created_at: draft.created_at,
    recorded_at: new Date().toISOString(),
    via: opts.via ?? 'sidekick',
    draft_text: segmentsToPlain(segments),
    posted_text: postedText == null ? null : stripReplyGreeting(postedText, target?.name ?? null),
    suggested_status: draft.suggested_status,
    actual_status: actualStatus,
    flags: draft.flags,
    assigned_at: opts.assignedAt ?? null,
  };
}

const FLAG_LABELS: Record<DraftFlag, string> = {
  thin_precedent: 'Thin precedent',
  docs_silent: "Docs don't cover this",
  guide_vs_precedent: 'Guide differs from recent precedent',
  cxo_differs: 'CXO doc differs from ops practice',
  no_new_angle: 'No new angle found',
  compass_no_reply: "Compass didn't answer",
  i2c_deferred: 'i2c not checked yet',
  amount_mismatch: "Amounts don't match the description",
};

export function flagLabel(flag: DraftFlag): string {
  return FLAG_LABELS[flag] ?? flag;
}

export function isHttpUrl(url: string | null | undefined): url is string {
  return !!url && /^https?:\/\//i.test(url);
}

// --- mention resolution -----------------------------------------------------------------

export interface MentionCandidate { accountId: string; displayName?: string }

const bareName = (mentionText: string) => mentionText.replace(/^@/, '').trim();

/** Distinct names (no leading "@") of mentions that still need an accountId. */
export function unresolvedMentionNames(segments: DraftSegment[]): string[] {
  const names = new Set<string>();
  for (const s of segments) {
    if (s.type === 'mention' && !s.accountId) names.add(bareName(s.text));
  }
  return [...names];
}

/** People on the ticket whose display name is exactly `name` (case and spacing ignored). */
export function matchPeopleByName(people: MentionCandidate[], name: string): MentionCandidate[] {
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
  const want = norm(bareName(name));
  return people.filter((p) => !!p.displayName && norm(p.displayName) === want);
}

/** Applies user-search results (keyed by the bare name) to the mention segments. Exactly one
 *  match gives the mention its accountId; none or several downgrade it to plain text and
 *  report it so the card can warn. A name with no entry (failed lookup) counts as none. */
export function applyMentionResolution(
  segments: DraftSegment[],
  results: Record<string, MentionCandidate[]>,
): { segments: DraftSegment[]; unresolved: string[] } {
  const unresolved: string[] = [];
  const out = segments.map((s): DraftSegment => {
    if (s.type !== 'mention' || s.accountId) return s;
    const matches = results[bareName(s.text)] ?? [];
    if (matches.length === 1) return { ...s, accountId: matches[0].accountId };
    if (!unresolved.includes(s.text)) unresolved.push(s.text);
    return { type: 'text', text: s.text };
  });
  return { segments: out, unresolved };
}

// --- posted-this-session ----------------------------------------------------------------
// Kept in memory and in chrome.storage.session, so a reloaded side panel neither offers the
// draft again nor lets the Jira-comment outcome sweep write a second row for it.

const postedMarks = createSessionMarks('agentDraftPosted');
const sessionKey = (key: string, createdAt: string) => `${key}\u0000${createdAt}`;

/** Remembers that the card handled a draft (posted it, or marked the status after a Jira reply).
 *  Memory updates synchronously, so a check that starts after this call returns sees it. */
export function markPostedThisSession(key: string, createdAt: string): Promise<void> {
  return postedMarks.mark(sessionKey(key, createdAt));
}

export function wasPostedThisSession(key: string, createdAt: string): Promise<boolean> {
  return postedMarks.has(sessionKey(key, createdAt));
}

export function resetPostedMemoryForTests(): void {
  postedMarks.resetMemory();
}
