import { describe, expect, it } from 'vitest';
import {
  CURRENT_TTL_MS,
  STAGED_TTL_MS,
  resolvePresetIdentity,
} from './presetIdentity';

const NOW = 1_700_000_000_000;
const staged = (over: Partial<{ identityId: string; ticketKey: string | null; at: number }> = {}) => ({
  identityId: 'identity-Eiv1UUIOCFJ7BhDteGZdJj1RaUJ',
  ticketKey: 'WOCOO-27705',
  at: NOW,
  ...over,
});
const mirror = (over: Partial<{ identityId: string; ticketKey: string | null; at: number }> = {}) => ({
  identityId: 'identity-MlW6ymnUhQ6lU8G34OAaXPojBN5',
  ticketKey: 'WOCOO-21839',
  at: NOW,
  ...over,
});

describe('resolvePresetIdentity', () => {
  it('prefers a freshly staged identity over the panel mirror', () => {
    expect(resolvePresetIdentity({ staged: staged(), current: mirror(), now: NOW })).toEqual({
      identityId: 'identity-Eiv1UUIOCFJ7BhDteGZdJj1RaUJ',
      ticketKey: 'WOCOO-27705',
      source: 'staged',
    });
  });

  it('falls back to the panel mirror when the staged identity has expired', () => {
    const stale = staged({ at: NOW - STAGED_TTL_MS - 1 });
    expect(resolvePresetIdentity({ staged: stale, current: mirror(), now: NOW })).toEqual({
      identityId: 'identity-MlW6ymnUhQ6lU8G34OAaXPojBN5',
      ticketKey: 'WOCOO-21839',
      source: 'current',
    });
  });

  it('ignores a legacy bare-string staged value — it carries no ticket or timestamp', () => {
    expect(
      resolvePresetIdentity({ staged: 'identity-UjhkqypHqadHFl9VYg', current: mirror(), now: NOW }),
    ).toEqual({
      identityId: 'identity-MlW6ymnUhQ6lU8G34OAaXPojBN5',
      ticketKey: 'WOCOO-21839',
      source: 'current',
    });
  });

  it('returns null when the mirror is older than its own TTL', () => {
    expect(resolvePresetIdentity({ staged: undefined, current: mirror({ at: NOW - CURRENT_TTL_MS - 1 }), now: NOW })).toBeNull();
  });

  it('returns null when nothing is staged or mirrored', () => {
    expect(resolvePresetIdentity({ now: NOW })).toBeNull();
  });

  it('rejects records whose identityId is not an identity string', () => {
    expect(resolvePresetIdentity({ staged: staged({ identityId: 'WOCOO-27705' }), now: NOW })).toBeNull();
    expect(resolvePresetIdentity({ staged: staged({ identityId: '' }), now: NOW })).toBeNull();
  });

  it('rejects records with a missing or non-numeric timestamp', () => {
    expect(resolvePresetIdentity({ staged: { identityId: 'identity-abc', ticketKey: 'WOCOO-1' }, now: NOW })).toBeNull();
    expect(resolvePresetIdentity({ staged: staged({ at: Number.NaN }), now: NOW })).toBeNull();
  });

  it('treats a small clock skew into the future as fresh', () => {
    const skewed = staged({ at: NOW + 30_000 });
    expect(resolvePresetIdentity({ staged: skewed, now: NOW })?.source).toBe('staged');
  });

  it('keeps a null ticketKey — staging without a key is allowed', () => {
    expect(resolvePresetIdentity({ staged: staged({ ticketKey: null }), now: NOW })).toEqual({
      identityId: 'identity-Eiv1UUIOCFJ7BhDteGZdJj1RaUJ',
      ticketKey: null,
      source: 'staged',
    });
  });
});
