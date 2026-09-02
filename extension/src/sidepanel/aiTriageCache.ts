// In-memory verdict cache for the AI triage card.
//
// Deliberately NOT chrome.storage.session or .local: closing the side panel drops the
// cache and the next open pays for a fresh gateway call. That is the accepted trade for
// having no persistence or eviction logic to maintain. Revisit if the call volume ever
// becomes annoying in daily use.

import type { TriageVerdict } from '../data/aiTriageTypes';

export const TRIAGE_CACHE_TTL_MS = 30 * 60 * 1000;

interface Entry {
  verdict: TriageVerdict;
  storedAt: number;
}

const entries = new Map<string, Entry>();
const inFlight = new Map<string, Promise<TriageVerdict>>();

function keyOf(ticketId: string, versionTag: string): string {
  return `${ticketId}::${versionTag}`;
}

export function getOrCompute(
  ticketId: string,
  versionTag: string,
  compute: () => Promise<TriageVerdict>,
): Promise<TriageVerdict> {
  const key = keyOf(ticketId, versionTag);

  const hit = entries.get(key);
  if (hit && Date.now() - hit.storedAt < TRIAGE_CACHE_TTL_MS) {
    return Promise.resolve(hit.verdict);
  }
  if (hit) entries.delete(key);

  // Rapid open/close of the side panel would otherwise fan out into duplicate calls.
  const running = inFlight.get(key);
  if (running) return running;

  const p = compute()
    .then((verdict) => {
      entries.set(key, { verdict, storedAt: Date.now() });
      return verdict;
    })
    .finally(() => {
      inFlight.delete(key);
    });

  inFlight.set(key, p);
  return p;
}

/** Drop the cached verdict for one ticket state. Used by the card's Regenerate button. */
export function invalidate(ticketId: string, versionTag: string): void {
  entries.delete(keyOf(ticketId, versionTag));
}

export function clearAll(): void {
  entries.clear();
  inFlight.clear();
}
