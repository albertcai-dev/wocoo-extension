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
