# Email Thread Linking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an agent link any Gmail thread to a WOCOO ticket by pasting its URL, and surface that thread's new replies — plus a new "you haven't answered yet" state — in the ticket panel cards and the Home list.

**Architecture:** The extension already polls Gmail through an Apps Script bridge every 5 minutes and mirrors the result into `chrome.storage.local['ticket_replies']`, which the ticket panel and Home both read. This work widens that pipeline from one tracked thread per ticket to a list, adds a third thread kind (`'email'`) that is created by an explicit link action, and adds a second reason a thread is flagged red (the last message is not from the agent). All the subtle logic is extracted into pure functions in `src/data/emailLink.ts` so it can be unit-tested; the React and Apps Script layers stay thin.

**Tech Stack:** TypeScript, React 18, Chrome MV3 (`chrome.storage.local`, `chrome.alarms`), Vitest (node environment), Google Apps Script (`GmailApp`, `SpreadsheetApp`) reached through the existing background-tab bridge.

**Spec:** `docs/superpowers/specs/2026-09-14-email-thread-linking-design.md`

## Global Constraints

- Test runner is Vitest, node environment, `include: ['src/**/*.test.ts']`. Run with `npm test` from `extension/`. Tests are plain functions — no DOM, no bundler, no React rendering.
- All Gmail reads happen in Apps Script, never in the extension and never through Gmail MCP tools. MCP masks email addresses (`iansantos1*****`) and sender identity is what the unreplied check depends on.
- Apps Script source cannot be read or written programmatically. Every GAS change ships as an **additive** patch file under `docs/gas-patches/` that the user pastes into the web editor. Never rewrite an existing GAS function; add new ones.
- Gmail deeplinks use `#all/<id>`, not `#inbox/<id>`, so archived threads still open. This matches `i2cThreadUrl` in `src/api/bridge.ts`.
- Hex Gmail thread ids match `/^[0-9a-f]{12,20}$/i`. The `FMfcgz…` form in permalinks is **not** usable by `GmailApp.getThreadById` and is never stored.
- New bridge actions must degrade silently on an older GAS deployment: `callBridge` times out, the caller catches and falls back. Mirror how `listTrackedTicketsViaBridge` is handled in `runReplyPollNow`.
- Never auto-delete a tracking sheet row. Rows are removed only by an explicit unlink.
- Automated senders matching `noreply|no-reply|donotreply|do-not-reply|survey` never set `awaitingMyReply`.
- Per-poll Gmail work is capped at 60 rows, newest first.
- Existing CSS custom properties only (`--mint-*`). No new colors.

---

### Task 1: `parseGmailLink`

Turns whatever the agent pastes into either a thread id we can use directly or a search query we have to resolve. This is the entry point of the whole link flow.

**Files:**
- Create: `extension/src/data/emailLink.ts`
- Test: `extension/src/data/emailLink.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type GmailLinkTarget = { kind: 'thread'; threadId: string } | { kind: 'query'; query: string }`
  - `function parseGmailLink(input: string): GmailLinkTarget | null`
  - `const HEX_THREAD_ID = /^[0-9a-f]{12,20}$/i`

- [ ] **Step 1: Write the failing test**

Create `extension/src/data/emailLink.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseGmailLink } from './emailLink';

describe('parseGmailLink', () => {
  it('reads a hex thread id straight out of an #inbox permalink', () => {
    expect(parseGmailLink('https://mail.google.com/mail/u/0/#inbox/1a0055a25a5b3bc0'))
      .toEqual({ kind: 'thread', threadId: '1a0055a25a5b3bc0' });
  });

  it('reads a hex thread id out of an #all permalink', () => {
    expect(parseGmailLink('https://mail.google.com/mail/u/0/#all/1a0055a25a5b3bc0'))
      .toEqual({ kind: 'thread', threadId: '1a0055a25a5b3bc0' });
  });

  it('reads a hex thread id out of a nested #label permalink', () => {
    expect(parseGmailLink('https://mail.google.com/mail/u/0/#label/Partners/1a0055a25a5b3bc0'))
      .toEqual({ kind: 'thread', threadId: '1a0055a25a5b3bc0' });
  });

  it('accepts a bare hex thread id', () => {
    expect(parseGmailLink('1a0055a25a5b3bc0'))
      .toEqual({ kind: 'thread', threadId: '1a0055a25a5b3bc0' });
  });

  it('seeds a query from a #search permalink, ignoring the unusable FMfcgz id', () => {
    expect(parseGmailLink('https://mail.google.com/mail/u/0/#search/dailypay/FMfcgzQhVrHLjkPQTgMVgbwnKQgwJChL'))
      .toEqual({ kind: 'query', query: 'dailypay' });
  });

  it('decodes a URL-encoded search query', () => {
    expect(parseGmailLink('https://mail.google.com/mail/u/0/#search/from%3Adailypay.com'))
      .toEqual({ kind: 'query', query: 'from:dailypay.com' });
  });

  it('prefers a hex last segment over the search term when the URL has one', () => {
    expect(parseGmailLink('https://mail.google.com/mail/u/0/#search/dailypay/1a0055a25a5b3bc0'))
      .toEqual({ kind: 'thread', threadId: '1a0055a25a5b3bc0' });
  });

  it('treats plain text as a search query', () => {
    expect(parseGmailLink('subject:dailypay OR from:dailypay'))
      .toEqual({ kind: 'query', query: 'subject:dailypay OR from:dailypay' });
  });

  it('trims surrounding whitespace before deciding', () => {
    expect(parseGmailLink('  1a0055a25a5b3bc0  '))
      .toEqual({ kind: 'thread', threadId: '1a0055a25a5b3bc0' });
  });

  it('returns null for empty input', () => {
    expect(parseGmailLink('')).toBeNull();
    expect(parseGmailLink('   ')).toBeNull();
  });

  it('returns null for a permalink whose only id is the unusable FMfcgz form', () => {
    // No search term to fall back on, and the FMfcgz id cannot be resolved by GmailApp.
    expect(parseGmailLink('https://mail.google.com/mail/u/0/#inbox/FMfcgzQhVrHLjkPQTgMVgbwnKQgwJChL'))
      .toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extension && npx vitest run src/data/emailLink.test.ts`
Expected: FAIL — `Failed to resolve import "./emailLink"`.

- [ ] **Step 3: Write minimal implementation**

Create `extension/src/data/emailLink.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd extension && npx vitest run src/data/emailLink.test.ts`
Expected: PASS — 11 tests.

- [ ] **Step 5: Commit**

```bash
git add extension/src/data/emailLink.ts extension/src/data/emailLink.test.ts
git commit -m "Parse pasted Gmail links into a thread id or a search seed"
```

---

### Task 2: Storage shape helpers — `normalizeRepliesMap` and `entryKey`

`ticket_replies` currently holds one `TicketReply` per ticket. It becomes a list. These two helpers are what make that change safe without a migration script.

**Files:**
- Modify: `extension/src/data/emailLink.ts`
- Test: `extension/src/data/emailLink.test.ts`

**Interfaces:**
- Consumes: Task 1's module.
- Produces:
  - `function entryKey(r: TicketReply): string`
  - `function normalizeRepliesMap(raw: unknown): Record<string, TicketReply[]>`

Note the import: `TicketReply` lives in `src/api/bridge.ts` and gains its new fields in Task 5. Import it as a type now; the new fields are optional so nothing breaks in between.

- [ ] **Step 1: Write the failing test**

Append to `extension/src/data/emailLink.test.ts`:

```ts
import { entryKey, normalizeRepliesMap } from './emailLink';
import type { TicketReply } from '../api/bridge';

function reply(over: Partial<TicketReply> = {}): TicketReply {
  return {
    wocooTicketId: 'WOCOO-26316',
    kind: 'koho',
    messageId: 'msg-1',
    trackKey: 'client@example.com',
    from: 'Client <client@example.com>',
    snippet: 'hello',
    receivedAt: '2026-09-01T10:00:00Z',
    ...over,
  } as TicketReply;
}

describe('entryKey', () => {
  it('prefers the thread id, which is what linked email rows carry', () => {
    expect(entryKey(reply({ kind: 'email', threadId: '1a0055a25a5b3bc0' })))
      .toBe('email::1a0055a25a5b3bc0');
  });

  it('falls back to the track key for koho and i2c rows', () => {
    expect(entryKey(reply({ kind: 'i2c', trackKey: 'PO-420974' }))).toBe('i2c::PO-420974');
  });

  it('falls back to the message id when there is no track key', () => {
    expect(entryKey(reply({ trackKey: undefined, messageId: 'msg-9' }))).toBe('koho::msg-9');
  });

  it('distinguishes two kinds that share a track key', () => {
    const a = entryKey(reply({ kind: 'koho', trackKey: 'x@y.com' }));
    const b = entryKey(reply({ kind: 'i2c', trackKey: 'x@y.com' }));
    expect(a).not.toBe(b);
  });
});

describe('normalizeRepliesMap', () => {
  it('wraps the old single-entry shape in an array', () => {
    const old = { 'WOCOO-1': reply({ wocooTicketId: 'WOCOO-1' }) };
    const out = normalizeRepliesMap(old);
    expect(out['WOCOO-1']).toHaveLength(1);
    expect(out['WOCOO-1'][0].messageId).toBe('msg-1');
  });

  it('passes the new list shape through untouched', () => {
    const next = { 'WOCOO-1': [reply(), reply({ messageId: 'msg-2' })] };
    expect(normalizeRepliesMap(next)['WOCOO-1']).toHaveLength(2);
  });

  it('handles a map holding both shapes at once', () => {
    const mixed = { 'WOCOO-1': reply(), 'WOCOO-2': [reply({ wocooTicketId: 'WOCOO-2' })] };
    const out = normalizeRepliesMap(mixed);
    expect(out['WOCOO-1']).toHaveLength(1);
    expect(out['WOCOO-2']).toHaveLength(1);
  });

  it('drops entries that are not objects rather than throwing', () => {
    const junk = { 'WOCOO-1': null, 'WOCOO-2': 'nope', 'WOCOO-3': 7, 'WOCOO-4': [reply()] };
    const out = normalizeRepliesMap(junk);
    expect(Object.keys(out)).toEqual(['WOCOO-4']);
  });

  it('returns an empty map for null, undefined, and non-objects', () => {
    expect(normalizeRepliesMap(null)).toEqual({});
    expect(normalizeRepliesMap(undefined)).toEqual({});
    expect(normalizeRepliesMap('x')).toEqual({});
    expect(normalizeRepliesMap([])).toEqual({});
  });

  it('drops a ticket whose list contains only junk', () => {
    expect(normalizeRepliesMap({ 'WOCOO-1': [null, 'x'] })).toEqual({});
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extension && npx vitest run src/data/emailLink.test.ts`
Expected: FAIL — `entryKey is not a function` / `normalizeRepliesMap is not a function`.

- [ ] **Step 3: Write minimal implementation**

Append to `extension/src/data/emailLink.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd extension && npx vitest run src/data/emailLink.test.ts`
Expected: PASS — 22 tests total.

- [ ] **Step 5: Commit**

```bash
git add extension/src/data/emailLink.ts extension/src/data/emailLink.test.ts
git commit -m "Add entry keys and a self-healing reader for list-shaped reply storage"
```

---

### Task 3: Sender identity — `isSelfSender` and `isAutomatedSender`

These decide whether the last message in a thread means "they are waiting on me." They are also the one piece of logic that gets ported into Apps Script, so the TypeScript version is the specification and must be exact.

**Files:**
- Modify: `extension/src/data/emailLink.ts`
- Test: `extension/src/data/emailLink.test.ts`

**Interfaces:**
- Consumes: Task 2's module.
- Produces:
  - `function extractEmailAddress(from: string): string`
  - `function isSelfSender(from: string, me: string): boolean`
  - `function isAutomatedSender(from: string): boolean`
  - `const AUTOMATED_SENDER = /(noreply|no-reply|donotreply|do-not-reply|survey)/i`

- [ ] **Step 1: Write the failing test**

Append to `extension/src/data/emailLink.test.ts`:

```ts
import { extractEmailAddress, isAutomatedSender, isSelfSender } from './emailLink';

describe('extractEmailAddress', () => {
  it('pulls the address out of a display-name header', () => {
    expect(extractEmailAddress('"Juan (DailyPay Support)" <support@dailypay.com>'))
      .toBe('support@dailypay.com');
  });

  it('returns a bare address unchanged', () => {
    expect(extractEmailAddress('support@dailypay.com')).toBe('support@dailypay.com');
  });

  it('lowercases so comparison is case-insensitive', () => {
    expect(extractEmailAddress('Albert Cai <Albert.Cai@Wealthsimple.com>'))
      .toBe('albert.cai@wealthsimple.com');
  });

  it('returns an empty string for junk', () => {
    expect(extractEmailAddress('')).toBe('');
    expect(extractEmailAddress('Nobody')).toBe('');
  });
});

describe('isSelfSender', () => {
  it('matches on the address, not the display name', () => {
    expect(isSelfSender('Albert Cai <albert.cai@wealthsimple.com>', 'albert.cai@wealthsimple.com'))
      .toBe(true);
  });

  it('ignores case on both sides', () => {
    expect(isSelfSender('<ALBERT.CAI@WEALTHSIMPLE.COM>', 'albert.cai@wealthsimple.com')).toBe(true);
  });

  it('is false for the other party', () => {
    expect(isSelfSender('"Juan (DailyPay Support)" <support@dailypay.com>', 'albert.cai@wealthsimple.com'))
      .toBe(false);
  });

  it('is false when we do not know who we are, rather than matching everything', () => {
    expect(isSelfSender('support@dailypay.com', '')).toBe(false);
  });
});

describe('isAutomatedSender', () => {
  it('flags the Kustomer survey address that would otherwise pin tickets red', () => {
    expect(isAutomatedSender('KOHO <survey@koho.kustomer.help>')).toBe(true);
  });

  it('flags the usual no-reply spellings', () => {
    expect(isAutomatedSender('noreply@koho.ca')).toBe(true);
    expect(isAutomatedSender('no-reply@koho.ca')).toBe(true);
    expect(isAutomatedSender('donotreply@koho.ca')).toBe(true);
    expect(isAutomatedSender('do-not-reply@koho.ca')).toBe(true);
  });

  it('does not flag a human agent', () => {
    expect(isAutomatedSender('"Juan (DailyPay Support)" <support@dailypay.com>')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extension && npx vitest run src/data/emailLink.test.ts`
Expected: FAIL — `extractEmailAddress is not a function`.

- [ ] **Step 3: Write minimal implementation**

Append to `extension/src/data/emailLink.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd extension && npx vitest run src/data/emailLink.test.ts`
Expected: PASS — 33 tests total.

- [ ] **Step 5: Commit**

```bash
git add extension/src/data/emailLink.ts extension/src/data/emailLink.test.ts
git commit -m "Add sender-identity rules for the awaiting-reply state"
```

---

### Task 4: `mergeEntries`, `sortEntries`, and the attention predicates

`runReplyPollNow` currently carries roughly 70 lines of untested merge logic inline. Extracting it is a precondition for making it handle lists, not optional cleanup — the four-source precedence is exactly where a list-shaped bug would hide.

**Files:**
- Modify: `extension/src/data/emailLink.ts`
- Test: `extension/src/data/emailLink.test.ts`

**Interfaces:**
- Consumes: Task 3's module.
- Produces:
  - `interface MergeSources { polled: TicketReply[]; prior: TicketReply[]; archived: TicketReply[]; tracked: TicketReply[] }`
  - `function mergeEntries(sources: MergeSources): TicketReply[]`
  - `function sortEntries(entries: TicketReply[]): TicketReply[]`
  - `function isNewReply(r: TicketReply): boolean`
  - `function isAwaiting(r: TicketReply): boolean`
  - `function needsAttention(entries: TicketReply[] | undefined): boolean`
  - `function attentionKind(entries: TicketReply[] | undefined): 'new-reply' | 'awaiting' | null`
  - `function attentionCount(entries: TicketReply[] | undefined): number`

- [ ] **Step 1: Write the failing test**

Append to `extension/src/data/emailLink.test.ts`:

```ts
import {
  attentionCount, attentionKind, isAwaiting, isNewReply,
  mergeEntries, needsAttention, sortEntries,
} from './emailLink';

function sources(over: Partial<Parameters<typeof mergeEntries>[0]> = {}) {
  return { polled: [], prior: [], archived: [], tracked: [], ...over };
}

describe('isNewReply / isAwaiting', () => {
  it('counts an unacked entry with a matched message as a new reply', () => {
    expect(isNewReply(reply({ acked: false, messageId: 'm1' }))).toBe(true);
  });

  it('does not count an acked entry', () => {
    expect(isNewReply(reply({ acked: true, messageId: 'm1' }))).toBe(false);
  });

  it('does not count a tracked row that never matched a message', () => {
    expect(isNewReply(reply({ acked: false, messageId: '' }))).toBe(false);
  });

  it('reads awaiting straight off the flag, treating undefined as unknown not false', () => {
    expect(isAwaiting(reply({ awaitingMyReply: true }))).toBe(true);
    expect(isAwaiting(reply({ awaitingMyReply: false }))).toBe(false);
    expect(isAwaiting(reply({ awaitingMyReply: undefined }))).toBe(false);
  });
});

describe('mergeEntries', () => {
  it('keeps a polled entry as-is', () => {
    const out = mergeEntries(sources({ polled: [reply({ acked: false })] }));
    expect(out).toHaveLength(1);
    expect(out[0].acked).toBe(false);
  });

  it('keeps every distinct thread on the same ticket', () => {
    const out = mergeEntries(sources({
      polled: [
        reply({ kind: 'koho', trackKey: 'c@x.com' }),
        reply({ kind: 'email', threadId: '1a0055a25a5b3bc0' }),
        reply({ kind: 'email', threadId: '1a000dc53f41b82d' }),
      ],
    }));
    expect(out).toHaveLength(3);
  });

  it('dedups a repeated thread within the polled list, newest receivedAt winning', () => {
    const out = mergeEntries(sources({
      polled: [
        reply({ kind: 'email', threadId: 't1', receivedAt: '2026-09-01T00:00:00Z', snippet: 'old' }),
        reply({ kind: 'email', threadId: 't1', receivedAt: '2026-09-05T00:00:00Z', snippet: 'new' }),
      ],
    }));
    expect(out).toHaveLength(1);
    expect(out[0].snippet).toBe('new');
  });

  it('carries forward a prior entry the poll no longer returned, forced to acked', () => {
    const out = mergeEntries(sources({
      prior: [reply({ kind: 'email', threadId: 't9', acked: false })],
    }));
    expect(out).toHaveLength(1);
    expect(out[0].acked).toBe(true);
  });

  it('lets the poll win over prior and archive for the same thread', () => {
    const out = mergeEntries(sources({
      polled: [reply({ kind: 'email', threadId: 't1', acked: false, snippet: 'fresh' })],
      prior: [reply({ kind: 'email', threadId: 't1', acked: true, snippet: 'stale' })],
      archived: [reply({ kind: 'email', threadId: 't1', acked: true, snippet: 'ancient' })],
    }));
    expect(out).toHaveLength(1);
    expect(out[0].snippet).toBe('fresh');
    expect(out[0].acked).toBe(false);
  });

  it('recovers a thread only the archive still remembers', () => {
    const out = mergeEntries(sources({ archived: [reply({ kind: 'email', threadId: 'gone' })] }));
    expect(out).toHaveLength(1);
    expect(out[0].acked).toBe(true);
  });

  it('gives a sheet-only tracked row an entry so it still earns a chip', () => {
    const out = mergeEntries(sources({
      tracked: [reply({ kind: 'i2c', trackKey: 'PO-420974', messageId: '', receivedAt: '' })],
    }));
    expect(out).toHaveLength(1);
    expect(out[0].acked).toBe(true);
    expect(isNewReply(out[0])).toBe(false);
  });

  it('returns an empty list when every source is empty', () => {
    expect(mergeEntries(sources())).toEqual([]);
  });
});

describe('sortEntries', () => {
  it('puts new replies first, then awaiting, then muted', () => {
    const out = sortEntries([
      reply({ kind: 'email', threadId: 'muted', acked: true }),
      reply({ kind: 'email', threadId: 'await', acked: true, awaitingMyReply: true }),
      reply({ kind: 'email', threadId: 'fresh', acked: false, messageId: 'm1' }),
    ]);
    expect(out.map((e) => e.threadId)).toEqual(['fresh', 'await', 'muted']);
  });

  it('breaks ties on receivedAt, newest first', () => {
    const out = sortEntries([
      reply({ kind: 'email', threadId: 'older', acked: true, receivedAt: '2026-09-01T00:00:00Z' }),
      reply({ kind: 'email', threadId: 'newer', acked: true, receivedAt: '2026-09-09T00:00:00Z' }),
    ]);
    expect(out.map((e) => e.threadId)).toEqual(['newer', 'older']);
  });
});

describe('needsAttention / attentionKind / attentionCount', () => {
  it('is true on a new reply', () => {
    expect(needsAttention([reply({ acked: false, messageId: 'm1' })])).toBe(true);
  });

  it('is true on an awaiting thread even though it is acked', () => {
    expect(needsAttention([reply({ acked: true, awaitingMyReply: true })])).toBe(true);
  });

  it('is false for muted entries, empty lists, and undefined', () => {
    expect(needsAttention([reply({ acked: true })])).toBe(false);
    expect(needsAttention([])).toBe(false);
    expect(needsAttention(undefined)).toBe(false);
  });

  it('reports new-reply as the kind when both causes are present', () => {
    expect(attentionKind([
      reply({ kind: 'email', threadId: 'a', acked: true, awaitingMyReply: true }),
      reply({ kind: 'email', threadId: 'b', acked: false, messageId: 'm1' }),
    ])).toBe('new-reply');
  });

  it('reports awaiting when that is the only cause, and null when there is none', () => {
    expect(attentionKind([reply({ acked: true, awaitingMyReply: true })])).toBe('awaiting');
    expect(attentionKind([reply({ acked: true })])).toBeNull();
    expect(attentionKind(undefined)).toBeNull();
  });

  it('counts every flagged entry once, even when one entry has both causes', () => {
    expect(attentionCount([
      reply({ kind: 'email', threadId: 'a', acked: false, messageId: 'm1', awaitingMyReply: true }),
      reply({ kind: 'email', threadId: 'b', acked: true, awaitingMyReply: true }),
      reply({ kind: 'email', threadId: 'c', acked: true }),
    ])).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extension && npx vitest run src/data/emailLink.test.ts`
Expected: FAIL — `mergeEntries is not a function`.

- [ ] **Step 3: Write minimal implementation**

Append to `extension/src/data/emailLink.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd extension && npm test`
Expected: PASS — the whole suite, including the pre-existing tests.

- [ ] **Step 5: Commit**

```bash
git add extension/src/data/emailLink.ts extension/src/data/emailLink.test.ts
git commit -m "Extract reply merge, ordering, and attention predicates from the poll"
```

---

### Task 5: Bridge types and the three new actions

**Files:**
- Modify: `extension/src/api/bridge.ts:396-420` (widen `TicketReply`), then append a new section after `listTrackedTicketsViaBridge` (currently ends at line 465)

**Interfaces:**
- Consumes: `callBridge(action, params, expectedReply, timeoutMs, openInBackground)` — private to `bridge.ts`.
- Produces:
  - `TicketReply` with `kind: 'koho' | 'i2c' | 'email'`, `threadId?: string`, `subject?: string`, `awaitingMyReply?: boolean`
  - `interface EmailThreadCandidate { threadId: string; subject: string; from: string; lastFrom: string; lastDate: string; messageCount: number; linkedTo?: string }`
  - `function searchEmailThreadsViaBridge(query: string, limit?: number): Promise<EmailThreadCandidate[]>`
  - `function linkEmailThreadViaBridge(wocooTicketId: string, threadId: string): Promise<void>`
  - `function unlinkEmailThreadViaBridge(wocooTicketId: string, threadId: string): Promise<void>`
  - `function emailThreadUrl(threadId: string): string`
  - `acknowledgeReplyViaBridge(wocooTicketId, messageId, trackKey?)` — third parameter added

There is no unit test for this task: it is type widening plus thin `callBridge` wrappers with no branching worth asserting. Verification is `tsc`.

- [ ] **Step 1: Widen `TicketReply`**

In `extension/src/api/bridge.ts`, change the interface (around line 396) to:

```ts
export interface TicketReply {
  wocooTicketId: string;
  kind: 'koho' | 'i2c' | 'email';
  /** Empty when the tracking row exists but no inbound reply has been matched yet —
   *  the pill then falls back to a Gmail search on `trackKey`. */
  messageId: string;
  /** The tracking sheet's trackKey: ticket id or client email for Koho, client email
   *  for i2c, hex Gmail thread id for a linked email thread. */
  trackKey?: string;
  /** Hex Gmail thread id. Set for `kind='email'` rows, and for Koho/i2c rows once the
   *  poll has resolved their thread. This — never the `FMfcgz…` permalink id — is what
   *  `GmailApp.getThreadById` accepts. */
  threadId?: string;
  /** Thread subject, used to name the card when there is no sender display name. */
  subject?: string;
  /** The last message in the thread is not from the agent, so the other side is
   *  waiting. `undefined` means undetermined (no thread handle yet) — not `false`. */
  awaitingMyReply?: boolean;
  from: string;
  snippet: string;
  receivedAt: string;
  /** True when the tracking-sheet row has `acknowledged=TRUE`. Missing on old bridge
   *  deployments — treat undefined as false. */
  acked?: boolean;
}
```

- [ ] **Step 2: Map the new fields in both readers**

In `checkForRepliesViaBridge`, add these three lines to the returned object literal, after the `trackKey` line:

```ts
      threadId: o.threadId != null ? String(o.threadId) : undefined,
      subject: o.subject != null ? String(o.subject) : undefined,
      awaitingMyReply: o.awaitingMyReply === true || o.awaitingMyReply === 'TRUE' || o.awaitingMyReply === 'true'
        ? true
        : o.awaitingMyReply === false || o.awaitingMyReply === 'FALSE' || o.awaitingMyReply === 'false'
          ? false
          : undefined,
```

In `listTrackedTicketsViaBridge`, add only the handle and subject after its `trackKey` line — that action does no Gmail work, so it can never know the awaiting state:

```ts
      threadId: o.threadId != null ? String(o.threadId) : undefined,
      subject: o.subject != null ? String(o.subject) : undefined,
```

- [ ] **Step 3: Add the optional `trackKey` argument to acknowledge**

A ticket can now hold several rows, so acknowledging one needs to say which. Replace `acknowledgeReplyViaBridge` with:

```ts
/** Flip a tracking row's `acknowledged` flag so the red card goes away.
 *
 *  `trackKey` disambiguates when a ticket has several tracked threads. It is optional so
 *  an older GAS deployment — which matches on ticket id alone — keeps working; that
 *  deployment simply ignores the extra parameter. */
export async function acknowledgeReplyViaBridge(
  wocooTicketId: string,
  messageId: string,
  trackKey?: string,
): Promise<void> {
  await callBridge(
    'acknowledgeReply',
    { wocooTicketId, messageId, trackKey: trackKey || '' },
    'replyAcknowledged',
    30_000,
    true,
  );
}
```

- [ ] **Step 4: Append the new section**

Add after `listTrackedTicketsViaBridge`:

```ts
// ============ Manual email-thread linking ============
// Koho and i2c rows appear as a side effect of sending mail. These actions let the agent
// attach any Gmail thread to a ticket by hand, so partner and escalation threads join
// the same notification machinery.

export interface EmailThreadCandidate {
  /** Hex Gmail thread id. */
  threadId: string;
  subject: string;
  /** Sender of the first message — who the thread is with. */
  from: string;
  /** Sender of the most recent message — who spoke last. */
  lastFrom: string;
  /** ISO timestamp of the most recent message. */
  lastDate: string;
  messageCount: number;
  /** WOCOO id this thread is already linked to, if any. A warning, not a blocker. */
  linkedTo?: string;
}

/** Search Gmail for link candidates. Runs in GAS because the extension has no Gmail
 *  access and MCP masks addresses. The caller shows the results for the agent to pick
 *  from rather than auto-taking the top hit: a bare term like `dailypay` reliably
 *  returns unrelated Jira digests. */
export async function searchEmailThreadsViaBridge(query: string, limit = 8): Promise<EmailThreadCandidate[]> {
  const res = await callBridge(
    'searchEmailThreads',
    { query, limit: String(limit) },
    'emailThreadsSearched',
    60_000,
    true,
  );
  const raw = (res.threads as unknown) ?? [];
  if (!Array.isArray(raw)) return [];
  return raw.map((t) => {
    const o = t as Record<string, unknown>;
    return {
      threadId: String(o.threadId ?? ''),
      subject: String(o.subject ?? ''),
      from: String(o.from ?? ''),
      lastFrom: String(o.lastFrom ?? ''),
      lastDate: String(o.lastDate ?? ''),
      messageCount: Number(o.messageCount ?? 0),
      linkedTo: o.linkedTo ? String(o.linkedTo) : undefined,
    };
  }).filter((t) => t.threadId);
}

/** Write a `kind='email'` tracking row. GAS sets `lastSeenMsgId` to the thread's current
 *  last message and `acknowledged=TRUE`, so linking a thread you are looking at cannot
 *  manufacture a "new reply" alert. An unanswered thread still turns red immediately —
 *  through `awaitingMyReply`, which is the accurate reason. */
export async function linkEmailThreadViaBridge(wocooTicketId: string, threadId: string): Promise<void> {
  await callBridge('linkEmailThread', { wocooTicketId, threadId }, 'emailThreadLinked', 45_000, true);
  try { await chrome.storage.local.set({ has_tracked_replies: true }); } catch { /* fine */ }
}

/** Remove a linked row. Required, not a nicety: the archive is deliberately sticky so a
 *  deeplink survives a poll that drops its row, which means without an explicit unlink a
 *  misclick in the picker would be permanent. */
export async function unlinkEmailThreadViaBridge(wocooTicketId: string, threadId: string): Promise<void> {
  await callBridge('unlinkEmailThread', { wocooTicketId, threadId }, 'emailThreadUnlinked', 30_000, true);
}

/** `#all/` rather than `#inbox/` so an archived thread still opens. Same choice as
 *  `i2cThreadUrl`. */
export function emailThreadUrl(threadId: string): string {
  return threadId ? `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(threadId)}` : '';
}
```

- [ ] **Step 5: Verify the types compile**

Run: `cd extension && npx tsc -b`
Expected: errors only in `replyPollScheduler.ts`, `SidePanel.tsx`, and `HomeView.tsx`, all of the form "Type `TicketReply[]` is not assignable to type `TicketReply`". Those are the three consumers, converted in Tasks 6–9. No errors in `bridge.ts` or `emailLink.ts`.

- [ ] **Step 6: Commit**

```bash
git add extension/src/api/bridge.ts
git commit -m "Add email-thread link actions and widen TicketReply"
```

---

### Task 6: Convert the poll to list-shaped storage

**Files:**
- Modify: `extension/src/background/replyPollScheduler.ts`

**Interfaces:**
- Consumes: `mergeEntries`, `normalizeRepliesMap`, `entryKey`, `sortEntries` from `../data/emailLink`; `checkForRepliesViaBridge`, `listTrackedTicketsViaBridge`, `TicketReply` from `../api/bridge`.
- Produces:
  - `type TicketRepliesMap = Record<string, TicketReply[]>` (shape changed)
  - `function removeReplyLocally(wocooTicketId: string, key?: string): Promise<void>` (second parameter added)

- [ ] **Step 1: Change the map type**

Replace the `TicketRepliesMap` declaration with:

```ts
/** Storage shape we mirror the bridge result into. Keyed by wocooTicketId, holding every
 *  tracked thread for that ticket: a Koho thread, an i2c thread, and any number of
 *  manually linked email threads can coexist. */
export type TicketRepliesMap = Record<string, TicketReply[]>;
```

- [ ] **Step 2: Replace the body of `runReplyPollNow`**

Replace everything inside the `try` block, from `if (reason !== 'sidepanel-trigger')` down to the `return map;`, with:

```ts
    if (reason !== 'sidepanel-trigger') {
      const st = await chrome.storage.local.get(HAS_TRACKED_STORAGE_KEY);
      if (!st[HAS_TRACKED_STORAGE_KEY]) {
        log('skipping (' + reason + ') — no tracked rows yet');
        return {};
      }
    }
    log('polling (' + reason + ')');
    const replies = await checkForRepliesViaBridge();

    // Presence in the sheet is what guarantees a ticket a chip, even when Gmail matched
    // nothing. Tolerate the action missing on older deployments.
    let tracked: TicketReply[] = [];
    try {
      tracked = await listTrackedTicketsViaBridge();
    } catch (e) {
      log('listTrackedTickets unavailable — falling back to replies only', e);
    }

    const stored = await chrome.storage.local.get([REPLIES_STORAGE_KEY, REPLIES_ARCHIVE_KEY]);
    const priorMap = normalizeRepliesMap(stored[REPLIES_STORAGE_KEY]);
    const archive = normalizeRepliesMap(stored[REPLIES_ARCHIVE_KEY]);

    const byTicket = (list: TicketReply[]): Record<string, TicketReply[]> => {
      const out: Record<string, TicketReply[]> = {};
      for (const r of list) (out[r.wocooTicketId] ||= []).push(r);
      return out;
    };
    const polledByTicket = byTicket(replies);
    const trackedByTicket = byTicket(tracked);

    const ticketIds = new Set([
      ...Object.keys(polledByTicket),
      ...Object.keys(priorMap),
      ...Object.keys(archive),
      ...Object.keys(trackedByTicket),
    ]);

    const map: TicketRepliesMap = {};
    for (const id of ticketIds) {
      const entries = mergeEntries({
        polled: polledByTicket[id] || [],
        prior: priorMap[id] || [],
        archived: archive[id] || [],
        tracked: trackedByTicket[id] || [],
      });
      if (entries.length) map[id] = entries;
    }

    // Archive is append-only per entry: keep whichever copy of a thread is newest, but
    // never drop a thread that was in it.
    const nextArchive: TicketRepliesMap = {};
    for (const id of new Set([...Object.keys(archive), ...Object.keys(map)])) {
      const merged = new Map<string, TicketReply>();
      for (const r of archive[id] || []) merged.set(entryKey(r), r);
      for (const r of map[id] || []) {
        const k = entryKey(r);
        const cur = merged.get(k);
        if (!cur || (r.receivedAt || '') >= (cur.receivedAt || '')) merged.set(k, r);
      }
      if (merged.size) nextArchive[id] = sortEntries([...merged.values()]);
    }

    await chrome.storage.local.set({ [REPLIES_STORAGE_KEY]: map, [REPLIES_ARCHIVE_KEY]: nextArchive });
    log('poll complete —', replies.length, 'replies across', Object.keys(map).length, 'tickets',
        '(' + Object.keys(nextArchive).length + ' archived)');
    return map;
```

- [ ] **Step 3: Fix the imports and the catch block**

Set the imports at the top of the file to:

```ts
import { checkForRepliesViaBridge, listTrackedTicketsViaBridge, type TicketReply } from '../api/bridge';
import { entryKey, mergeEntries, normalizeRepliesMap, sortEntries } from '../data/emailLink';
```

and change the `catch` block's final read to normalize as well:

```ts
    const cur = await chrome.storage.local.get(REPLIES_STORAGE_KEY);
    return normalizeRepliesMap(cur[REPLIES_STORAGE_KEY]);
```

- [ ] **Step 4: Make `removeReplyLocally` entry-aware**

Replace the function with:

```ts
/** Locally clear tracked threads so the badge/card disappears immediately. Only hides
 *  them until the next poll — the archive isn't touched, by design, so the ticket's
 *  Gmail deeplink comes back rather than being lost.
 *
 *  `key` is an `entryKey`; omit it to clear every thread on the ticket. */
export async function removeReplyLocally(wocooTicketId: string, key?: string): Promise<void> {
  const cur = await chrome.storage.local.get(REPLIES_STORAGE_KEY);
  const map = normalizeRepliesMap(cur[REPLIES_STORAGE_KEY]);
  const entries = map[wocooTicketId];
  if (!entries) return;
  if (key) {
    const next = entries.filter((r) => entryKey(r) !== key);
    if (next.length === entries.length) return;
    if (next.length) map[wocooTicketId] = next;
    else delete map[wocooTicketId];
  } else {
    delete map[wocooTicketId];
  }
  await chrome.storage.local.set({ [REPLIES_STORAGE_KEY]: map });
}
```

- [ ] **Step 5: Update the file's header comment**

Replace the closing sentence of the top-of-file comment so it describes the new shape:

```ts
// Ticket-reply polling — checks Gmail every 5 min (via the Apps Script bridge) for new
// inbound replies to outbound Koho emails, i2c form submissions, and manually linked
// email threads, and mirrors the result into chrome.storage.local as a list of tracked
// threads per ticket, so the sidepanel can render red cards / reordered Home + deep-link
// chips on the ticket panel.
```

- [ ] **Step 6: Verify**

Run: `cd extension && npm test && npx tsc -b`
Expected: tests PASS. `tsc` errors now only in `SidePanel.tsx` and `HomeView.tsx`.

- [ ] **Step 7: Commit**

```bash
git add extension/src/background/replyPollScheduler.ts
git commit -m "Poll into a list of tracked threads per ticket"
```

---

### Task 7: Home list — attention predicate and mailbox badges

**Files:**
- Modify: `extension/src/sidepanel/HomeView.tsx:21-51` (state and ordering), `:347-396` (`TicketListRow`)

**Interfaces:**
- Consumes: `needsAttention`, `attentionKind`, `attentionCount`, `normalizeRepliesMap`, `isNewReply`, `isAwaiting` from `../data/emailLink`.
- Produces: nothing other tasks depend on.

- [ ] **Step 1: Swap the predicate and the state type**

Delete the local `isUnacked` function (lines 30–36) and add the import:

```ts
import {
  attentionCount, attentionKind, isAwaiting, isNewReply,
  needsAttention, normalizeRepliesMap,
} from '../data/emailLink';
```

Change `orderRows` to:

```ts
function orderRows(rows: TicketRow[], replies: Record<string, TicketReply[]>, sort: SortDirection): TicketRow[] {
  const withKeys = rows.map((r) => ({
    r,
    hasReply: needsAttention(replies[r.id]),
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
```

Change the state declaration to `useState<Record<string, TicketReply[]>>({})` and the storage read (around line 84) to:

```ts
      chrome.storage.local.get(REPLIES_STORAGE_KEY).then((res) => {
        setReplies(normalizeRepliesMap(res[REPLIES_STORAGE_KEY]));
      });
```

- [ ] **Step 2: Change the row's prop from one entry to a list**

Update the call site (around line 256) and every other `TicketListRow` usage in the file from `reply={replies[r.id]}` to `entries={replies[r.id]}`.

- [ ] **Step 3: Rewrite `TicketListRow`'s attention rendering**

Replace the function's signature, first line, and the two `hasReply` blocks:

```tsx
function TicketListRow({ row, entries, onClick }: { row: TicketRow; entries?: TicketReply[]; onClick: () => void }) {
  const hasReply = needsAttention(entries);
  const kind = attentionKind(entries);
  const count = attentionCount(entries);
  // The flagged entry driving the summary line: a new reply if there is one, otherwise
  // the thread waiting on us.
  const lead = (entries || []).find(isNewReply) || (entries || []).find(isAwaiting);
  const leadLabel = lead ? threadLabel(lead) : '';
  const glyph = kind === 'awaiting' ? '📮' : '📬';
  const suffix = count > 1 ? ` (+${count - 1} more)` : '';
```

The dot's `title` becomes:

```tsx
            title={kind === 'awaiting'
              ? `You haven't replied to ${leadLabel} — click to open`
              : `New reply from ${leadLabel} — click to open`}
```

and the summary line becomes:

```tsx
      {hasReply ? (
        <div style={{ fontSize: 'var(--mint-text-nano)', color: 'var(--mint-negative-fg-strong)', fontWeight: 600 }}>
          {glyph}{' '}
          {kind === 'awaiting'
            ? `Awaiting your reply — ${leadLabel}${suffix}`
            : `New reply from ${leadLabel} — ${(lead?.snippet || '').slice(0, 80)}${(lead?.snippet || '').length > 80 ? '…' : ''}${suffix}`}
        </div>
      ) : (
        <div style={{ fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-soft)' }}>
          {row.issueType}
        </div>
      )}
```

- [ ] **Step 4: Add the shared label helper**

`threadLabel` names a thread in both Home and the ticket panel. Add it to `extension/src/data/emailLink.ts` so both import it, and append its test to `emailLink.test.ts`:

```ts
// in src/data/emailLink.ts
/** How a tracked thread is named in the UI. Koho and i2c keep their short fixed labels;
 *  a linked thread is named after whoever the agent is actually talking to, falling back
 *  to the subject and then to a generic word — never to a raw thread id. */
export function threadLabel(r: TicketReply): string {
  if (r.kind === 'koho') return 'Koho';
  if (r.kind === 'i2c') return 'i2c';
  const display = displayName(r.from);
  if (display) return display;
  if (r.subject) return r.subject.length > 40 ? r.subject.slice(0, 40) + '…' : r.subject;
  return 'email';
}

function displayName(from: string): string {
  const s = (from || '').trim();
  const angled = s.indexOf('<');
  const name = (angled > 0 ? s.slice(0, angled) : '').trim().replace(/^"|"$/g, '').trim();
  if (name) return name;
  // No display name — use the address's local part rather than the whole address.
  const addr = extractEmailAddress(s);
  return addr ? addr.split('@')[0] : '';
}
```

```ts
// in src/data/emailLink.test.ts
import { threadLabel } from './emailLink';

describe('threadLabel', () => {
  it('keeps the fixed labels for koho and i2c', () => {
    expect(threadLabel(reply({ kind: 'koho' }))).toBe('Koho');
    expect(threadLabel(reply({ kind: 'i2c' }))).toBe('i2c');
  });

  it('names a linked thread after the sender display name', () => {
    expect(threadLabel(reply({ kind: 'email', from: '"Juan (DailyPay Support)" <support@dailypay.com>' })))
      .toBe('Juan (DailyPay Support)');
  });

  it('falls back to the address local part when there is no display name', () => {
    expect(threadLabel(reply({ kind: 'email', from: '<support@dailypay.com>' }))).toBe('support');
  });

  it('falls back to the subject when there is no sender at all', () => {
    expect(threadLabel(reply({ kind: 'email', from: '', subject: 'Direct deposit setup' })))
      .toBe('Direct deposit setup');
  });

  it('truncates a long subject', () => {
    const long = 'x'.repeat(60);
    expect(threadLabel(reply({ kind: 'email', from: '', subject: long }))).toHaveLength(41);
  });

  it('never falls back to a raw thread id', () => {
    expect(threadLabel(reply({ kind: 'email', from: '', subject: '', threadId: '1a0055a25a5b3bc0' })))
      .toBe('email');
  });
});
```

- [ ] **Step 5: Verify**

Run: `cd extension && npm test && npx tsc -b`
Expected: tests PASS. `tsc` errors now only in `SidePanel.tsx`.

- [ ] **Step 6: Commit**

```bash
git add extension/src/sidepanel/HomeView.tsx extension/src/data/emailLink.ts extension/src/data/emailLink.test.ts
git commit -m "Flag Home rows for awaiting replies as well as new ones"
```

---

### Task 8: Ticket panel — render one card per tracked thread

**Files:**
- Modify: `extension/src/sidepanel/SidePanel.tsx:454-455` (call site), `:1123-1390` (`ReplyPill`)

**Interfaces:**
- Consumes: `entryKey`, `isAwaiting`, `isNewReply`, `normalizeRepliesMap`, `sortEntries`, `threadLabel` from `../data/emailLink`; `emailThreadUrl` from `../api/bridge`.
- Produces: `<ReplyPills ticketId clientEmail i2cTicketRef />` replacing `<ReplyPill … />`.

- [ ] **Step 1: Split the component in two**

`ReplyPill` currently both reads storage and renders. Rename the rendering half to `ReplyCard`, taking one entry as a prop, and make `ReplyPills` the storage-reading half that maps over the list. Change the call site at line 455 to:

```tsx
      <ReplyPills ticketId={ticket.id} clientEmail={ticket.clientEmail} i2cTicketRef={ticket.i2cTicketRef} />
```

- [ ] **Step 2: Write `ReplyPills`**

Replace the `ReplyPill` function's storage effect and `effective` computation with this new component, placed just above `ReplyCard`:

```tsx
function ReplyPills({ ticketId, clientEmail, i2cTicketRef }: { ticketId: string; clientEmail?: string; i2cTicketRef?: string }) {
  const [entries, setEntries] = useState<TicketReply[]>([]);

  useEffect(() => {
    const read = () => {
      chrome.storage.local.get([REPLIES_STORAGE_KEY, REPLIES_ARCHIVE_KEY]).then((res) => {
        const live = normalizeRepliesMap(res[REPLIES_STORAGE_KEY])[ticketId] || [];
        const archived = normalizeRepliesMap(res[REPLIES_ARCHIVE_KEY])[ticketId] || [];
        // Archive-only hits are by definition already-seen, so render them muted.
        const byKey = new Map<string, TicketReply>();
        for (const r of archived) byKey.set(entryKey(r), { ...r, acked: true });
        for (const r of live) byKey.set(entryKey(r), r);
        setEntries(sortEntries([...byKey.values()]));
      });
    };
    read();
    const onChange = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && (REPLIES_STORAGE_KEY in changes || REPLIES_ARCHIVE_KEY in changes)) read();
    };
    chrome.storage.onChanged.addListener(onChange);
    return () => chrome.storage.onChanged.removeListener(onChange);
  }, [ticketId]);

  // A tracking row only exists when the extension itself sent the Koho email or opened
  // the i2c form. An i2c ticket raised by hand — pasted into a Jira comment, the common
  // case — has no row, so synthesise a reply-less entry and let the muted chip handle it.
  const synthetic: TicketReply[] =
    !entries.length && i2cTicketRef
      ? [{ wocooTicketId: ticketId, kind: 'i2c', messageId: '', trackKey: i2cTicketRef, from: '', snippet: '', receivedAt: '', acked: true }]
      : [];

  const all = entries.length ? entries : synthetic;
  if (!all.length) return null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {all.map((entry) => (
        <ReplyCard
          key={entryKey(entry)}
          entry={entry}
          ticketId={ticketId}
          clientEmail={clientEmail}
          i2cTicketRef={i2cTicketRef}
        />
      ))}
    </div>
  );
}
```

- [ ] **Step 3: Convert the renderer to `ReplyCard`**

Change the remaining function's signature to:

```tsx
function ReplyCard({ entry, ticketId, clientEmail, i2cTicketRef }: {
  entry: TicketReply;
  ticketId: string;
  clientEmail?: string;
  i2cTicketRef?: string;
}) {
  const [resolving, setResolving] = useState(false);
  const effective = entry;
```

Keep the rest of the body, then make these four edits inside it:

1. `openEmail` gains a linked-thread branch as its **first** case, because a hex thread id is a better anchor than a single message id:

```tsx
  const openEmail = () => {
    if (effective.kind === 'email' && effective.threadId) {
      window.open(emailThreadUrl(effective.threadId), '_blank', 'noopener,noreferrer');
      return;
    }
    if (effective.messageId) {
```

2. `markAsRead`'s storage write becomes entry-scoped:

```tsx
    void chrome.storage.local.get(REPLIES_STORAGE_KEY).then((res) => {
      const map = normalizeRepliesMap(res[REPLIES_STORAGE_KEY]);
      const list = map[ticketId];
      if (list) {
        const k = entryKey(effective);
        map[ticketId] = list.map((r) => (entryKey(r) === k ? { ...r, acked: true } : r));
        void chrome.storage.local.set({ [REPLIES_STORAGE_KEY]: map });
      }
    });
    void acknowledgeReplyViaBridge(ticketId, effective.messageId, effective.trackKey).catch((err) => {
      console.warn('[wocoo-reply-card] ack failed:', err);
    });
```

3. The label and state computation replaces the current three lines:

```tsx
  const label = threadLabel(effective);
  const truncated = effective.snippet.length > 140 ? effective.snippet.slice(0, 140) + '…' : effective.snippet;
  // A linked thread always has an anchor, so it is never in the "search for it" state
  // that a Koho row with no matched message is.
  const awaiting = !effective.messageId && !(effective.kind === 'email' && effective.threadId);
  const newReply = isNewReply(effective);
  const awaitingMyReply = !newReply && isAwaiting(effective);
  const acked = !newReply && !awaitingMyReply;
  const seenDate = fmtReplyDate(effective.receivedAt, { month: 'short', day: 'numeric' });
```

4. Change the muted-branch condition from `if (acked)` to `if (acked)` unchanged — it now also covers a linked thread with nothing outstanding — and add the awaiting branch described in Step 4.

- [ ] **Step 4: Add the awaiting-reply card**

Insert this immediately before the `if (acked)` block:

```tsx
  if (awaitingMyReply) {
    // Same red treatment as a new reply, different claim: the message has been seen, it
    // just hasn't been answered. No ✕ — dismissing it would defeat the point, and the
    // only thing that clears it is actually replying, which the next poll notices.
    return (
      <button
        type="button"
        onClick={openEmail}
        title={`The last message in the ${label} thread isn't from you. Click to open it in Gmail and reply.`}
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 8,
          padding: '8px 12px',
          margin: '0 var(--mint-sp-3)',
          background: 'var(--mint-negative-bg-soft)',
          border: '1px solid var(--mint-negative-fg-graphic)',
          borderRadius: 'var(--mint-radius-card)',
          width: 'calc(100% - 2 * var(--mint-sp-3))',
          boxSizing: 'border-box',
          cursor: 'pointer',
          textAlign: 'left',
          font: 'inherit',
          color: 'inherit',
        }}
      >
        <span style={{ fontSize: 16, lineHeight: 1.2, flexShrink: 0 }}>📮</span>
        <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 }}>
          <span style={{ fontSize: 'var(--mint-text-micro)', fontWeight: 700, color: 'var(--mint-negative-fg-strong)' }}>
            Awaiting your reply — {label}
            {seenDate ? ` · ${seenDate}` : ''}
          </span>
          <span style={{ fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-strong)', lineHeight: 1.4 }}>
            {truncated || <em style={{ color: 'var(--mint-fg-soft)' }}>(no preview)</em>}
          </span>
          <span style={{ fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-soft)', fontStyle: 'italic' }}>
            Last message isn't from you · click to reply in Gmail
          </span>
        </span>
      </button>
    );
  }
```

- [ ] **Step 5: Handle a thread the bridge could not read**

A linked thread can become unreadable (deleted, or out of scope). GAS reports that as `subject: ''` with a blank `messageId` but a present `threadId`; the deeplink still works, so only the title changes. In the muted branch, extend the `title` expression's final fallback:

```tsx
        title={effective.kind === 'email' && !effective.receivedAt
          ? `Open the linked Gmail thread. If it doesn't open, the thread may have been deleted or moved out of reach — the link stays here either way.`
          : !awaiting
          ? `Reopen the ${label} reply in Gmail`
```

- [ ] **Step 6: Fix imports and update the header comment**

Add to the imports at the top of `SidePanel.tsx`:

```tsx
import { entryKey, isAwaiting, isNewReply, normalizeRepliesMap, sortEntries, threadLabel } from '../data/emailLink';
```

and add `emailThreadUrl` to the existing `../api/bridge` import. Update the `// ---------- reply pill` header comment to describe three states and a list:

```tsx
// ---------- reply cards (Koho / i2c / linked email threads) ----------
//
// `ReplyPills` subscribes to chrome.storage.local[`ticket_replies`] — a map of
// wocooTicketId → tracked threads, updated by the background poll every 5 min — and
// renders one `ReplyCard` per thread.
//
// Each card renders in one of three states:
//   • new reply (red): "New reply from …" — inbound message the agent hasn't seen
//   • awaiting (red): "Awaiting your reply — …" — seen, but the last message isn't ours
//   • muted: a compact "Reopen …" chip whose deeplink stays reachable forever
//
// Cards are deliberately sticky: once a thread is tracked it keeps its chip. Reading a
// reply only downgrades red → muted, and the lookup falls back to the append-only
// archive so a poll that no longer returns the row can't make the deeplink vanish.
```

- [ ] **Step 7: Verify**

Run: `cd extension && npm test && npx tsc -b`
Expected: tests PASS, `tsc -b` clean.

- [ ] **Step 8: Commit**

```bash
git add extension/src/sidepanel/SidePanel.tsx
git commit -m "Render one reply card per tracked thread, with an awaiting state"
```

---

### Task 9: The link button and candidate picker

**Files:**
- Create: `extension/src/sidepanel/LinkEmailCard.tsx`
- Modify: `extension/src/sidepanel/SidePanel.tsx` (render it under `ReplyPills`)

**Interfaces:**
- Consumes: `parseGmailLink` from `../data/emailLink`; `searchEmailThreadsViaBridge`, `linkEmailThreadViaBridge`, `unlinkEmailThreadViaBridge`, `EmailThreadCandidate` from `../api/bridge`; `runReplyPollNow` from `../background/replyPollScheduler`.
- Produces: `<LinkEmailCard ticketId />`.

A separate file rather than more lines in `SidePanel.tsx`, which is already ~1400 lines.

- [ ] **Step 1: Create the component**

Create `extension/src/sidepanel/LinkEmailCard.tsx`:

```tsx
// Manual email-thread linking. The agent pastes a Gmail URL (or a search term), picks
// the thread from a short candidate list, and it joins the ticket's tracked threads.
//
// Two stages because the id in a Gmail permalink can't be used directly: `#search/…`
// URLs carry an `FMfcgz…` id that GmailApp won't accept, so the thread has to be found
// by search. `#inbox/<hex>` URLs skip straight to confirmation.

import { useState } from 'react';
import {
  linkEmailThreadViaBridge,
  searchEmailThreadsViaBridge,
  type EmailThreadCandidate,
} from '../api/bridge';
import { parseGmailLink } from '../data/emailLink';
import { runReplyPollNow } from '../background/replyPollScheduler';

type Stage =
  | { kind: 'closed' }
  | { kind: 'input'; value: string; error?: string }
  | { kind: 'searching'; query: string }
  | { kind: 'picking'; query: string; candidates: EmailThreadCandidate[] }
  | { kind: 'linking' }
  | { kind: 'linked'; subject: string };

export function LinkEmailCard({ ticketId }: { ticketId: string }) {
  const [stage, setStage] = useState<Stage>({ kind: 'closed' });

  const search = async (raw: string) => {
    const target = parseGmailLink(raw);
    if (!target) {
      setStage({
        kind: 'input',
        value: raw,
        error: "Couldn't read that. Paste a Gmail thread URL, or type a search term like "
          + '"subject:dailypay".',
      });
      return;
    }
    // A hex thread id needs no search — confirm it directly so the agent still sees what
    // they're about to link.
    const query = target.kind === 'thread' ? `threadId:${target.threadId}` : target.query;
    setStage({ kind: 'searching', query });
    try {
      const candidates = target.kind === 'thread'
        ? await searchEmailThreadsViaBridge(`threadId:${target.threadId}`, 1)
        : await searchEmailThreadsViaBridge(target.query, 8);
      if (!candidates.length) {
        setStage({
          kind: 'input',
          value: target.kind === 'thread' ? target.threadId : target.query,
          error: 'No threads matched. Edit the query and try again — a bare word often '
            + 'matches Jira digests instead of the thread you want.',
        });
        return;
      }
      setStage({ kind: 'picking', query, candidates });
    } catch (e) {
      setStage({
        kind: 'input',
        value: raw,
        error: 'Gmail search failed through the bridge. ' + (e instanceof Error ? e.message : String(e)),
      });
    }
  };

  const link = async (c: EmailThreadCandidate) => {
    setStage({ kind: 'linking' });
    try {
      await linkEmailThreadViaBridge(ticketId, c.threadId);
      // Poll straight away so the new card appears without waiting up to 5 min.
      await runReplyPollNow('sidepanel-trigger');
      setStage({ kind: 'linked', subject: c.subject });
    } catch (e) {
      setStage({
        kind: 'input',
        value: c.threadId,
        error: 'Linking failed. ' + (e instanceof Error ? e.message : String(e)),
      });
    }
  };

  if (stage.kind === 'closed') {
    return (
      <button
        type="button"
        onClick={() => setStage({ kind: 'input', value: '' })}
        title="Attach a Gmail thread to this ticket so its replies show up here and on Home"
        style={chipStyle}
      >
        🔗 Link an email
      </button>
    );
  }

  if (stage.kind === 'linked') {
    return (
      <div style={{ ...panelStyle, color: 'var(--mint-fg-soft)' }}>
        <div style={{ fontSize: 'var(--mint-text-nano)' }}>
          Linked · {stage.subject || 'thread'}
        </div>
        <button type="button" onClick={() => setStage({ kind: 'closed' })} style={linkBtnStyle}>
          Link another
        </button>
      </div>
    );
  }

  if (stage.kind === 'searching' || stage.kind === 'linking') {
    return (
      <div style={panelStyle}>
        <div style={{ fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-soft)' }}>
          {stage.kind === 'searching' ? `Searching Gmail for "${stage.query}"…` : 'Linking…'}
        </div>
      </div>
    );
  }

  if (stage.kind === 'picking') {
    return (
      <div style={panelStyle}>
        <div style={{ fontSize: 'var(--mint-text-nano)', fontWeight: 700 }}>
          Pick the thread to link
        </div>
        {stage.candidates.map((c) => (
          <button
            key={c.threadId}
            type="button"
            onClick={() => void link(c)}
            style={{ ...candidateStyle, cursor: 'pointer' }}
            title={`Link ${c.threadId} to ${ticketId}`}
          >
            <span style={{ fontWeight: 600, fontSize: 'var(--mint-text-nano)' }}>
              {c.subject || '(no subject)'}
            </span>
            <span style={{ fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-soft)' }}>
              {c.lastFrom || c.from} · {c.messageCount} msg{c.messageCount === 1 ? '' : 's'}
              {c.lastDate ? ` · ${new Date(c.lastDate).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' })}` : ''}
            </span>
            {c.linkedTo && c.linkedTo !== ticketId ? (
              <span style={{ fontSize: 'var(--mint-text-nano)', color: 'var(--mint-negative-fg-strong)' }}>
                ⚠ already linked to {c.linkedTo} — linking here as well is allowed
              </span>
            ) : null}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setStage({ kind: 'input', value: stage.query })}
          style={linkBtnStyle}
        >
          Edit the query
        </button>
      </div>
    );
  }

  return (
    <div style={panelStyle}>
      <label style={{ fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-soft)' }}>
        Paste the Gmail URL, or a search term
      </label>
      <input
        autoFocus
        value={stage.value}
        onChange={(e) => setStage({ kind: 'input', value: e.target.value })}
        onKeyDown={(e) => { if (e.key === 'Enter') void search(stage.value); }}
        placeholder="https://mail.google.com/… or subject:dailypay"
        style={{
          font: 'inherit',
          fontSize: 'var(--mint-text-nano)',
          padding: '4px 6px',
          border: 'var(--mint-card-stroke)',
          borderRadius: 4,
          background: 'var(--mint-bg-card)',
          color: 'var(--mint-fg-strong)',
        }}
      />
      {stage.error ? (
        <div style={{ fontSize: 'var(--mint-text-nano)', color: 'var(--mint-negative-fg-strong)' }}>
          {stage.error}
        </div>
      ) : null}
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" onClick={() => void search(stage.value)} style={linkBtnStyle}>
          Search
        </button>
        <button type="button" onClick={() => setStage({ kind: 'closed' })} style={linkBtnStyle}>
          Cancel
        </button>
      </div>
    </div>
  );
}

const chipStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '4px 10px',
  margin: '0 var(--mint-sp-3)',
  background: 'var(--mint-bg-subtle)',
  border: 'var(--mint-card-stroke)',
  borderRadius: 'var(--mint-radius-card)',
  cursor: 'pointer',
  textAlign: 'left',
  width: 'calc(100% - 2 * var(--mint-sp-3))',
  boxSizing: 'border-box',
  font: 'inherit',
  fontSize: 'var(--mint-text-nano)',
  fontWeight: 600,
  color: 'var(--mint-fg-soft)',
};

const panelStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  padding: '8px 12px',
  margin: '0 var(--mint-sp-3)',
  background: 'var(--mint-bg-subtle)',
  border: 'var(--mint-card-stroke)',
  borderRadius: 'var(--mint-radius-card)',
  width: 'calc(100% - 2 * var(--mint-sp-3))',
  boxSizing: 'border-box',
};

const candidateStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  padding: '6px 8px',
  background: 'var(--mint-bg-card)',
  border: 'var(--mint-card-stroke)',
  borderRadius: 4,
  textAlign: 'left',
  font: 'inherit',
  color: 'var(--mint-fg-strong)',
};

const linkBtnStyle: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  padding: 0,
  font: 'inherit',
  fontSize: 'var(--mint-text-nano)',
  fontWeight: 600,
  color: 'var(--mint-highlight-fg-strong)',
  cursor: 'pointer',
  textAlign: 'left',
};
```

- [ ] **Step 2: Render it on the ticket panel**

In `SidePanel.tsx`, import it and add it directly under `ReplyPills` (around line 455):

```tsx
import { LinkEmailCard } from './LinkEmailCard';
```

```tsx
      <ReplyPills ticketId={ticket.id} clientEmail={ticket.clientEmail} i2cTicketRef={ticket.i2cTicketRef} />
      <LinkEmailCard ticketId={ticket.id} />
```

- [ ] **Step 3: Verify**

Run: `cd extension && npm test && npx tsc -b`
Expected: tests PASS, `tsc -b` clean.

- [ ] **Step 4: Commit**

```bash
git add extension/src/sidepanel/LinkEmailCard.tsx extension/src/sidepanel/SidePanel.tsx
git commit -m "Add the link-an-email card with a Gmail candidate picker"
```

---

### Task 10: The Apps Script patch

Everything above is inert until GAS answers the new actions. This task produces the paste-in patch and the runbook note.

**Files:**
- Create: `docs/gas-patches/2026-09-14-email-thread-linking.gs`

**Interfaces:**
- Consumes: the extension's expected action names and reply names from Task 5: `searchEmailThreads`/`emailThreadsSearched`, `linkEmailThread`/`emailThreadLinked`, `unlinkEmailThread`/`emailThreadUnlinked`.
- Produces: nothing for later tasks — this is the last one.

**Before writing any code, settle the spec's open item.** Open the reply-tracking sheet and record the real column layout in a comment at the top of the patch file. The design assumes `kind='email'` rows can reuse the `trackKey` column for a hex thread id. If that column has validation, a formula, or a consumer that assumes an `@`, add a `threadId` column instead and use it throughout the patch. Everything else here is unaffected.

- [ ] **Step 1: Write the patch file**

Create `docs/gas-patches/2026-09-14-email-thread-linking.gs`:

```javascript
/**
 * Email thread linking — ADDITIVE patch, 2026-09-14.
 *
 * Paste these functions into the WOCOO bridge Apps Script project as a new file and
 * redeploy. Nothing here modifies an existing function; the only change to existing
 * behaviour is the `awaitingMyReply` field that `checkForReplies` starts returning,
 * which older extension builds ignore.
 *
 * VERIFY BEFORE PASTING: this assumes the tracking sheet's `trackKey` column can hold a
 * hex Gmail thread id for `kind='email'` rows. Confirm against the live sheet.
 *
 * Deployment caches at deploy time — redeploy after pasting, or the extension keeps
 * hitting the old code.
 */

/** Senders whose mail must never mean "they are waiting on you." Ported verbatim from
 *  AUTOMATED_SENDER in extension/src/data/emailLink.ts — keep the two in step. */
var AUTOMATED_SENDER_RE = /(noreply|no-reply|donotreply|do-not-reply|survey)/i;

function emailLink_extractAddress_(from) {
  var s = String(from || '');
  var m = s.match(/<([^>]+)>/);
  var candidate = (m ? m[1] : s).trim().toLowerCase();
  return candidate.indexOf('@') >= 0 ? candidate : '';
}

function emailLink_isSelfSender_(from, me) {
  var mine = emailLink_extractAddress_(me) || String(me || '').trim().toLowerCase();
  if (!mine) return false;
  return emailLink_extractAddress_(from) === mine;
}

function emailLink_me_() {
  var me = '';
  try { me = Session.getActiveUser().getEmail(); } catch (e) { me = ''; }
  if (!me) {
    try { me = Session.getEffectiveUser().getEmail(); } catch (e2) { me = ''; }
  }
  return me;
}

/** Inspect a thread and describe its last message. Returns null when the thread can't be
 *  read — deleted, or out of scope. Callers keep the row either way; an unreadable
 *  thread is far more likely to be transient than genuinely gone. */
function emailLink_describeThread_(threadId, me) {
  var thread = null;
  try { thread = GmailApp.getThreadById(threadId); } catch (e) { thread = null; }
  if (!thread) return null;

  var messages = thread.getMessages();
  if (!messages.length) return null;
  var last = messages[messages.length - 1];
  var from = last.getFrom();

  return {
    threadId: threadId,
    subject: thread.getFirstMessageSubject(),
    messageId: last.getId(),
    from: from,
    snippet: String(last.getPlainBody() || '').slice(0, 200),
    receivedAt: last.getDate().toISOString(),
    messageCount: messages.length,
    // An automated sender still counts as a new reply, but never as someone waiting.
    awaitingMyReply: !emailLink_isSelfSender_(from, me) && !AUTOMATED_SENDER_RE.test(from),
  };
}

/** action=searchEmailThreads&query=…&limit=…  →  reply=emailThreadsSearched
 *
 *  `threadId:<hex>` is handled specially: it isn't Gmail search syntax, it's how the
 *  extension asks "describe exactly this thread so the agent can confirm it." */
function handleSearchEmailThreads(params) {
  var query = String(params.query || '').trim();
  var limit = Math.min(Number(params.limit || 8) || 8, 20);
  var me = emailLink_me_();
  var out = [];

  var direct = query.match(/^threadId:([0-9a-f]{12,20})$/i);
  if (direct) {
    var one = emailLink_describeThread_(direct[1].toLowerCase(), me);
    if (one) out.push(one);
  } else if (query) {
    var threads = GmailApp.search(query, 0, limit);
    for (var i = 0; i < threads.length; i++) {
      var d = emailLink_describeThread_(threads[i].getId(), me);
      if (d) out.push(d);
    }
  }

  var linked = emailLink_linkedThreadIndex_();
  return {
    reply: 'emailThreadsSearched',
    threads: out.map(function (d) {
      return {
        threadId: d.threadId,
        subject: d.subject,
        from: d.from,
        lastFrom: d.from,
        lastDate: d.receivedAt,
        messageCount: d.messageCount,
        linkedTo: linked[d.threadId] || '',
      };
    }),
  };
}

/** threadId → wocooTicketId for every existing kind='email' row, so the picker can warn
 *  that a candidate is already attached elsewhere. */
function emailLink_linkedThreadIndex_() {
  var sheet = getReplyTrackingSheet_();   // existing helper in the bridge project
  var rows = sheet.getDataRange().getValues();
  var header = rows[0];
  var cKind = header.indexOf('kind');
  var cKey = header.indexOf('trackKey');
  var cTicket = header.indexOf('wocooTicketId');
  var index = {};
  for (var r = 1; r < rows.length; r++) {
    if (String(rows[r][cKind]) === 'email') index[String(rows[r][cKey])] = String(rows[r][cTicket]);
  }
  return index;
}

/** action=linkEmailThread&wocooTicketId=…&threadId=…  →  reply=emailThreadLinked
 *
 *  acknowledged=TRUE and lastSeenMsgId=<current last> on purpose: linking a thread you
 *  are looking at must not manufacture a "new reply". An unanswered thread still goes
 *  red immediately, via awaitingMyReply. */
function handleLinkEmailThread(params) {
  var ticketId = String(params.wocooTicketId || '').trim();
  var threadId = String(params.threadId || '').trim().toLowerCase();
  if (!ticketId || !threadId) throw new Error('linkEmailThread needs wocooTicketId and threadId');

  var described = emailLink_describeThread_(threadId, emailLink_me_());
  if (!described) throw new Error('Could not read Gmail thread ' + threadId);

  var sheet = getReplyTrackingSheet_();
  var rows = sheet.getDataRange().getValues();
  var header = rows[0];
  var cKind = header.indexOf('kind');
  var cKey = header.indexOf('trackKey');
  var cTicket = header.indexOf('wocooTicketId');

  // Idempotent: re-linking the same thread to the same ticket updates rather than
  // appends, so a double-click can't create a duplicate card.
  for (var r = 1; r < rows.length; r++) {
    if (String(rows[r][cTicket]) === ticketId
      && String(rows[r][cKind]) === 'email'
      && String(rows[r][cKey]) === threadId) {
      setReplyTrackingRow_(sheet, r + 1, described.messageId, true);   // existing helper
      return { reply: 'emailThreadLinked', threadId: threadId, updated: true };
    }
  }

  appendReplyTrackingRow_(sheet, {                                     // existing helper
    wocooTicketId: ticketId,
    kind: 'email',
    trackKey: threadId,
    lastSeenMsgId: described.messageId,
    acknowledged: true,
  });
  return { reply: 'emailThreadLinked', threadId: threadId, updated: false };
}

/** action=unlinkEmailThread&wocooTicketId=…&threadId=…  →  reply=emailThreadUnlinked
 *
 *  The only path that deletes a tracking row. The extension's archive is sticky by
 *  design, so without this a misclick in the picker would be permanent. */
function handleUnlinkEmailThread(params) {
  var ticketId = String(params.wocooTicketId || '').trim();
  var threadId = String(params.threadId || '').trim().toLowerCase();
  var sheet = getReplyTrackingSheet_();
  var rows = sheet.getDataRange().getValues();
  var header = rows[0];
  var cKind = header.indexOf('kind');
  var cKey = header.indexOf('trackKey');
  var cTicket = header.indexOf('wocooTicketId');

  for (var r = rows.length - 1; r >= 1; r--) {
    if (String(rows[r][cTicket]) === ticketId
      && String(rows[r][cKind]) === 'email'
      && String(rows[r][cKey]) === threadId) {
      sheet.deleteRow(r + 1);
      return { reply: 'emailThreadUnlinked', threadId: threadId, deleted: true };
    }
  }
  return { reply: 'emailThreadUnlinked', threadId: threadId, deleted: false };
}
```

- [ ] **Step 2: Document the three edits to existing GAS functions**

These cannot be additive — they change `checkForReplies` and the router. Append to the same patch file, as a clearly-marked instruction block rather than pasteable code, because the surrounding source can't be read from here:

```javascript
/**
 * ===== THREE EDITS TO EXISTING FUNCTIONS =====
 *
 * (1) Router (doGet's action switch) — add three cases:
 *       case 'searchEmailThreads': return reply_(handleSearchEmailThreads(params));
 *       case 'linkEmailThread':    return reply_(handleLinkEmailThread(params));
 *       case 'unlinkEmailThread':  return reply_(handleUnlinkEmailThread(params));
 *
 * (2) checkForReplies — per tracking row, after the existing Koho/i2c matching:
 *       • kind === 'email': resolve via emailLink_describeThread_(trackKey, me).
 *         New reply when described.messageId !== row.lastSeenMsgId AND the sender is not
 *         self. A new reply writes acknowledged=FALSE. Write lastSeenMsgId back every
 *         poll either way. Return threadId, subject, awaitingMyReply alongside the
 *         existing fields.
 *       • kind === 'koho' or 'i2c' with a non-empty lastSeenMsgId: reach the thread via
 *         GmailApp.getMessageById(lastSeenMsgId).getThread().getId(), then the same
 *         emailLink_describeThread_ call, and return only its awaitingMyReply (do not
 *         overwrite the existing matching logic). A blank lastSeenMsgId means no thread
 *         to inspect: omit awaitingMyReply entirely so the extension reads it as
 *         undetermined rather than false.
 *       • Cap the Gmail work at 60 rows per invocation, newest row first. Uncapped, a
 *         long-lived sheet eventually exceeds the execution limit and the poll returns
 *         nothing at all — worse than returning the 60 freshest.
 *
 * (3) acknowledgeReply — it now receives an optional `trackKey` param. When present,
 *     match the row on wocooTicketId AND trackKey; when absent, keep matching on
 *     wocooTicketId alone. A ticket can hold several rows now, so without this an ack
 *     can clear the wrong one.
 */
```

- [ ] **Step 3: Commit the patch**

```bash
git add docs/gas-patches/2026-09-14-email-thread-linking.gs
git commit -m "Add the Apps Script patch for email thread linking"
```

- [ ] **Step 4: Paste, redeploy, and verify end to end**

This step is manual — the agent cannot do it. Hand these instructions to the user:

1. Open the WOCOO bridge Apps Script project in the web editor. No clasp.
2. Confirm the tracking sheet's column names match the patch's `header.indexOf(...)` lookups, and that `trackKey` can hold a hex thread id. Adjust the patch if not.
3. Paste the new file, apply the three edits from Step 2, and **redeploy** — deployment caches at deploy time.
4. Reload the extension, open WOCOO-26316, click `🔗 Link an email`, paste
   `https://mail.google.com/mail/u/0/#search/dailypay/FMfcgzQhVrHLjkPQTgMVgbwnKQgwJChL`,
   and search. Expect candidates including
   `[DailyPay] Re: DailyPay Support Ticket #21085316 General Product Inquiry`
   (thread `1a0055a25a5b3bc0`, 3 messages, last from Juan on 2026-08-18).
5. Link it. Expect an `Awaiting your reply — Juan (DailyPay Support)` card on the panel,
   and WOCOO-26316 red with 📮 on Home. The last message is from DailyPay and was never
   answered, so both are correct.
6. Reply in Gmail, click Refresh on Home, and confirm the card drops to the muted
   `↗ Reopen` chip and the Home row loses its red.

---

## Self-Review

**Spec coverage.** Every section maps to a task: data model → Tasks 2, 4, 5; link flow → Tasks 1, 9, 10; poll and unreplied detection → Tasks 6, 10; rendering → Tasks 7, 8; error handling → spread across Tasks 1 (null parse), 8 (unreadable thread), 9 (empty search, bridge failure), 10 (null thread); testing → Tasks 1–4 plus Task 10 Step 4. The spec's open item is the gate on Task 10.

**Gap accepted deliberately.** `unlinkEmailThreadViaBridge` ships in Task 5 and the GAS handler in Task 10, but no UI calls it. Unlinking is reachable only by re-running the action by hand until a later change adds a control to the muted card. The wrapper and handler exist so a misclick is recoverable today; the button is not in this plan's scope.

**Type consistency.** `TicketReply` gains `threadId`, `subject`, `awaitingMyReply` in Task 5 and is consumed under those exact names in Tasks 4, 6, 7, 8. `entryKey`, `normalizeRepliesMap`, `mergeEntries`, `sortEntries`, `needsAttention`, `attentionKind`, `attentionCount`, `isNewReply`, `isAwaiting`, `threadLabel`, `parseGmailLink`, `isSelfSender`, `isAutomatedSender`, `extractEmailAddress` are each defined once and referenced consistently. `EmailThreadCandidate.lastFrom` and `lastDate` are populated by the GAS `handleSearchEmailThreads` mapping in Task 10.

**Ordering note.** Task 5 leaves `tsc -b` failing on three files by design; Tasks 6, 7, and 8 clear them one at a time. Do not reorder 6–8 ahead of 5.
