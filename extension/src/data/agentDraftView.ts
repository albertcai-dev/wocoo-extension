// Pure helpers for the agent draft card: turning the agent's segments into editable text and
// back, deciding whether Post is allowed, and resolving @mentions to Jira accounts.

import type { AgentDraft, DraftFlag, DraftSegment } from './agentDraftTypes';

/** Text a segment shows in the editor. Mention text already carries its "@"; smartcards may lack text. */
function segmentText(s: DraftSegment): string {
  if (s.type === 'smartcard') return s.text || s.href || '';
  return s.text ?? '';
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
    const at = edited.indexOf(token, pos);
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

const postedThisSession = new Set<string>();
const sessionKey = (key: string, createdAt: string) => `${key}\u0000${createdAt}`;

/** Remembers that a draft was posted from the card, so the later Jira-comment outcome sweep can skip it. */
export function markPostedThisSession(key: string, createdAt: string): void {
  postedThisSession.add(sessionKey(key, createdAt));
}

export function wasPostedThisSession(key: string, createdAt: string): boolean {
  return postedThisSession.has(sessionKey(key, createdAt));
}
