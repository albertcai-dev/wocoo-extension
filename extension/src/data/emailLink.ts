// Pure helpers behind email-thread linking. Everything here is deliberately free of
// chrome.* and React so it can be unit-tested, and so the sender-identity rules can be
// ported verbatim into the Apps Script patch (GAS cannot be tested locally, so the
// TypeScript copy is the specification).

/** Gmail's own thread ids are hex. The `FMfcgz…` ids that appear in permalinks are a
 *  different encoding that `GmailApp.getThreadById` will not accept, and there is no
 *  public conversion — which is the whole reason linking needs a resolve step. */
export const HEX_THREAD_ID = /^[0-9a-f]{12,20}$/i;

export type GmailLinkTarget =
  | { kind: 'thread'; threadId: string }
  | { kind: 'query'; query: string };

/** Interpret whatever the agent pasted.
 *
 *  A hex id anywhere usable wins, because it skips the search entirely. Otherwise a
 *  `#search/<term>` fragment seeds the query box. `null` means "we cannot get anywhere
 *  from this" — the caller shows an inline error rather than searching for junk. */
export function parseGmailLink(input: string): GmailLinkTarget | null {
  const trimmed = (input || '').trim();
  if (!trimmed) return null;

  if (HEX_THREAD_ID.test(trimmed)) return { kind: 'thread', threadId: trimmed.toLowerCase() };

  const hashAt = trimmed.indexOf('#');
  if (hashAt === -1) return { kind: 'query', query: trimmed };

  const segments = trimmed.slice(hashAt + 1).split('/').filter(Boolean);
  if (segments.length === 0) return null;

  // A hex id in the final position is the best outcome regardless of which view the
  // URL came from (#inbox, #all, #label/Foo, even #search/term).
  const last = segments[segments.length - 1];
  if (HEX_THREAD_ID.test(last)) return { kind: 'thread', threadId: last.toLowerCase() };

  if (segments[0] === 'search' && segments[1]) {
    const query = safeDecode(segments[1]);
    return query ? { kind: 'query', query } : null;
  }

  // A view fragment whose only id is the FMfcgz form, with no search term to fall back
  // on. Nothing here can reach a thread.
  return null;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s).trim();
  } catch {
    // A stray '%' makes decodeURIComponent throw; the raw text is still a usable query.
    return s.trim();
  }
}

import type { TicketReply } from '../api/bridge';

/** Identity of one tracked thread inside a ticket's list. A ticket can now hold a Koho
 *  thread, an i2c thread, and several linked email threads, so merge and dedup need a
 *  key that is stable across polls. The thread id is the strongest handle; Koho and i2c
 *  rows have none, so they fall back to the sheet's trackKey. */
export function entryKey(r: TicketReply): string {
  return `${r.kind}::${r.threadId || r.trackKey || r.messageId || ''}`;
}

function isReplyLike(v: unknown): v is TicketReply {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Read `ticket_replies` / `ticket_replies_archive` in either shape.
 *
 *  This is the entire migration. Storage written by an older build holds one object per
 *  ticket; wrapping it here means the first read self-heals and no one-shot migration
 *  job is needed. Every read site must go through this — a direct `map[ticketId]` read
 *  will hand back an array to code expecting an object. */
export function normalizeRepliesMap(raw: unknown): Record<string, TicketReply[]> {
  const out: Record<string, TicketReply[]> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [ticketId, value] of Object.entries(raw as Record<string, unknown>)) {
    const list = (Array.isArray(value) ? value : [value]).filter(isReplyLike);
    if (list.length) out[ticketId] = list;
  }
  return out;
}

/** Senders whose mail must never mean "they are waiting on you."
 *
 *  The Koho flow ends in a Kustomer satisfaction survey. Without this guard every
 *  completed Koho ticket would go red forever, with the survey as its unanswered
 *  message. Such mail still counts as a *new reply* if it is genuinely new — that is
 *  today's behaviour and is what the agent expects to see. */
export const AUTOMATED_SENDER = /(noreply|no-reply|donotreply|do-not-reply|survey)/i;

/** `"Juan (DailyPay Support)" <support@dailypay.com>` → `support@dailypay.com`.
 *  Lowercased, because header casing is not meaningful. */
export function extractEmailAddress(from: string): string {
  const s = from || '';
  const angled = s.match(/<([^>]+)>/);
  const candidate = (angled ? angled[1] : s).trim().toLowerCase();
  return candidate.includes('@') ? candidate : '';
}

/** Did the agent send this message? Compared on address only — display names differ
 *  between Gmail, Zendesk quoting, and mailing lists.
 *
 *  An unknown `me` returns false rather than true: claiming every message is yours
 *  would silently disable the whole awaiting-reply feature. */
export function isSelfSender(from: string, me: string): boolean {
  const mine = extractEmailAddress(me) || (me || '').trim().toLowerCase();
  if (!mine) return false;
  return extractEmailAddress(from) === mine;
}

export function isAutomatedSender(from: string): boolean {
  return AUTOMATED_SENDER.test(from || '');
}

/** An entry is worth shouting about only when the poll actually matched an inbound
 *  message and the agent has not dismissed it. A tracking row that has never matched
 *  anything has a blank messageId and must stay quiet. */
export function isNewReply(r: TicketReply): boolean {
  return r.acked !== true && !!r.messageId;
}

/** The last message in the thread is not from the agent. Set by the poll, so an
 *  `undefined` here means "not determined" — a row with no thread handle yet — and is
 *  deliberately not treated as `false`-with-confidence anywhere user-visible. */
export function isAwaiting(r: TicketReply): boolean {
  return r.awaitingMyReply === true;
}

export interface MergeSources {
  /** Fresh from `checkForReplies` — authoritative. */
  polled: TicketReply[];
  /** The previous live map for this ticket. */
  prior: TicketReply[];
  /** The append-only archive for this ticket. */
  archived: TicketReply[];
  /** Rows from `listTrackedTickets` — presence in the sheet, nothing more. */
  tracked: TicketReply[];
}

/** Fold four sources into one list per ticket.
 *
 *  Precedence is polled > prior > archived > tracked. Rebuilding from the poll alone can
 *  only ever *lose* an entry (the bridge filters acked rows, an ack races the write, a
 *  deployment predates an action), so the weaker sources fill gaps and are forced to
 *  `acked: true`: only `checkForReplies` detects a genuinely new reply, so a row known
 *  only from storage or the sheet has nothing to alert about. */
export function mergeEntries(sources: MergeSources): TicketReply[] {
  const byKey = new Map<string, TicketReply>();

  for (const r of sources.polled) {
    const k = entryKey(r);
    const cur = byKey.get(k);
    if (!cur || (r.receivedAt || '') > (cur.receivedAt || '')) byKey.set(k, r);
  }

  for (const source of [sources.prior, sources.archived, sources.tracked]) {
    for (const r of source) {
      const k = entryKey(r);
      if (!byKey.has(k)) byKey.set(k, { ...r, acked: true });
    }
  }

  return sortEntries([...byKey.values()]);
}

/** Render order: what needs doing, then what is waiting on you, then history. */
export function sortEntries(entries: TicketReply[]): TicketReply[] {
  const rank = (r: TicketReply) => (isNewReply(r) ? 0 : isAwaiting(r) ? 1 : 2);
  return [...entries].sort((a, b) => {
    const d = rank(a) - rank(b);
    if (d !== 0) return d;
    return (b.receivedAt || '').localeCompare(a.receivedAt || '');
  });
}

export function needsAttention(entries: TicketReply[] | undefined): boolean {
  return !!entries && entries.some((r) => isNewReply(r) || isAwaiting(r));
}

/** Which glyph Home shows. A new reply outranks an awaiting thread — it is the newer
 *  fact and the one the agent has not seen yet. */
export function attentionKind(entries: TicketReply[] | undefined): 'new-reply' | 'awaiting' | null {
  if (!entries || !entries.length) return null;
  if (entries.some(isNewReply)) return 'new-reply';
  if (entries.some(isAwaiting)) return 'awaiting';
  return null;
}

/** Flagged threads, counted once each even when one thread is both new and awaiting. */
export function attentionCount(entries: TicketReply[] | undefined): number {
  if (!entries) return 0;
  return entries.filter((r) => isNewReply(r) || isAwaiting(r)).length;
}
