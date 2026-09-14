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
