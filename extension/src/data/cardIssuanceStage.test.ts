import { describe, expect, it } from 'vitest';
import { CARD_ISSUANCE_TTL_MS, resolveCardIssuanceStage } from './cardIssuanceStage';

const NOW = 1_700_000_000_000;
const stage = (over: Partial<{ identityId: string; ticketKey: string | null; at: number }> = {}) => ({
  identityId: 'identity-Eiv1UUIOCFJ7BhDteGZdJj1RaUJ',
  ticketKey: 'WOCOO-27705',
  at: NOW,
  ...over,
});

describe('resolveCardIssuanceStage', () => {
  it('returns a freshly staged identity', () => {
    expect(resolveCardIssuanceStage({ stored: stage(), now: NOW })).toEqual({
      identityId: 'identity-Eiv1UUIOCFJ7BhDteGZdJj1RaUJ',
      ticketKey: 'WOCOO-27705',
    });
  });

  it('returns null once the stage has outlived its TTL', () => {
    expect(resolveCardIssuanceStage({ stored: stage({ at: NOW - CARD_ISSUANCE_TTL_MS - 1 }), now: NOW })).toBeNull();
  });

  it('keeps a stage that is still inside its TTL', () => {
    expect(resolveCardIssuanceStage({ stored: stage({ at: NOW - CARD_ISSUANCE_TTL_MS + 1 }), now: NOW })).not.toBeNull();
  });

  it('treats a small clock skew into the future as fresh', () => {
    expect(resolveCardIssuanceStage({ stored: stage({ at: NOW + 30_000 }), now: NOW })).not.toBeNull();
  });

  it('rejects a stage dated far into the future — that is a bad clock, not a fresh stage', () => {
    expect(resolveCardIssuanceStage({ stored: stage({ at: NOW + 10 * 60_000 }), now: NOW })).toBeNull();
  });

  it('returns null when nothing is staged', () => {
    expect(resolveCardIssuanceStage({ now: NOW })).toBeNull();
    expect(resolveCardIssuanceStage({ stored: null, now: NOW })).toBeNull();
  });

  it('rejects a bare identity string — it carries no ticket or timestamp', () => {
    expect(resolveCardIssuanceStage({ stored: 'identity-UjhkqypHqadHFl9VYg', now: NOW })).toBeNull();
  });

  it('rejects records whose identityId is not an identity string', () => {
    expect(resolveCardIssuanceStage({ stored: stage({ identityId: 'WOCOO-27705' }), now: NOW })).toBeNull();
    expect(resolveCardIssuanceStage({ stored: stage({ identityId: '' }), now: NOW })).toBeNull();
  });

  it('rejects records with a missing or non-numeric timestamp', () => {
    expect(resolveCardIssuanceStage({ stored: { identityId: 'identity-abc', ticketKey: 'WOCOO-1' }, now: NOW })).toBeNull();
    expect(resolveCardIssuanceStage({ stored: stage({ at: Number.NaN }), now: NOW })).toBeNull();
  });

  it('keeps a null ticketKey — staging without a key is allowed', () => {
    expect(resolveCardIssuanceStage({ stored: stage({ ticketKey: null }), now: NOW })).toEqual({
      identityId: 'identity-Eiv1UUIOCFJ7BhDteGZdJj1RaUJ',
      ticketKey: null,
    });
  });
});
