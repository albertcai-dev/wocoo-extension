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
