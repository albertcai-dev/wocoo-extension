import { describe, it, expect, vi, afterEach } from 'vitest';
import { createSessionMarks } from './sessionMarks';

function fakeSessionStorage() {
  const data: Record<string, unknown> = {};
  const session = {
    get: vi.fn(async (k: string) => (k in data ? { [k]: data[k] } : {})),
    set: vi.fn(async (items: Record<string, unknown>) => { Object.assign(data, items); }),
  };
  vi.stubGlobal('chrome', { storage: { session } });
  return { data, session };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('createSessionMarks', () => {
  it('works from memory when chrome.storage is unavailable (tests, non-extension contexts)', async () => {
    const m = createSessionMarks('t-mem');
    expect(await m.has('a')).toBe(false);
    await m.mark('a');
    expect(m.hasInMemory('a')).toBe(true);
    expect(await m.has('a')).toBe(true);
  });

  it('marks memory synchronously, before the storage write settles', () => {
    fakeSessionStorage();
    const m = createSessionMarks('t-sync');
    void m.mark('a');
    expect(m.hasInMemory('a')).toBe(true);
  });

  it('mirrors marks to chrome.storage.session under one key per mark', async () => {
    const { data } = fakeSessionStorage();
    const m = createSessionMarks('t-store');
    await m.mark('WOCOO-1\u0000t1');
    expect(data).toEqual({ 't-store:WOCOO-1\u0000t1': true });
  });

  it('finds a mark that only exists in storage (a reloaded side panel)', async () => {
    const { data } = fakeSessionStorage();
    data['t-reload:WOCOO-2'] = true;
    const m = createSessionMarks('t-reload');
    expect(m.hasInMemory('WOCOO-2')).toBe(false);
    expect(await m.has('WOCOO-2')).toBe(true);
    expect(m.hasInMemory('WOCOO-2')).toBe(true);
    expect(await m.has('WOCOO-3')).toBe(false);
  });

  it('treats a storage failure as "not marked" and never throws', async () => {
    vi.stubGlobal('chrome', { storage: { session: {
      get: vi.fn(async () => { throw new Error('boom'); }),
      set: vi.fn(async () => { throw new Error('boom'); }),
    } } });
    const m = createSessionMarks('t-fail');
    expect(await m.has('x')).toBe(false);
    await expect(m.mark('x')).resolves.toBeUndefined();
    expect(await m.has('x')).toBe(true);
  });

  it('resetMemory forgets in-memory marks only', async () => {
    const { data } = fakeSessionStorage();
    const m = createSessionMarks('t-reset');
    await m.mark('a');
    m.resetMemory();
    expect(m.hasInMemory('a')).toBe(false);
    expect(data['t-reset:a']).toBe(true);
  });
});
