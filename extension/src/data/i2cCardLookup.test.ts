import { describe, expect, it, vi } from 'vitest';
import { I2C_HOME_URL, I2C_LOGIN_URL, openI2cSession, type I2cChromeDeps } from './i2cCardLookup';

type Listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => void;

/** In-memory chrome stand-in. `scrape(id, cards)` plays the content script's role. */
function fakeChrome() {
  const store: Record<string, unknown> = {};
  const listeners = new Set<Listener>();
  const tabs = new Set<number>();
  const calls: string[] = [];
  let nextTab = 100;
  const deps: I2cChromeDeps = {
    storageGet: async (keys) => Object.fromEntries(keys.filter((k) => k in store).map((k) => [k, store[k]])),
    storageSet: async (items) => {
      const changes: Record<string, chrome.storage.StorageChange> = {};
      for (const [k, v] of Object.entries(items)) { changes[k] = { oldValue: store[k], newValue: v }; store[k] = v; }
      for (const l of [...listeners]) l(changes, 'local');
    },
    storageRemove: async (keys) => { for (const k of keys) delete store[k]; },
    addChangeListener: (fn) => { listeners.add(fn); },
    removeChangeListener: (fn) => { listeners.delete(fn); },
    tabsCreate: async ({ url }) => { const id = nextTab++; tabs.add(id); calls.push(`create:${id}:${url}`); return { id }; },
    tabsUpdate: async (id, { url }) => {
      if (!tabs.has(id)) throw new Error('No tab with id: ' + id);
      calls.push(`update:${id}:${url}`);
    },
    tabsRemove: async (id) => { calls.push(`remove:${id}`); if (!tabs.delete(id)) throw new Error('No tab'); },
    sleep: async () => {},
  };
  /** Wait for the lookup to have written its keys + listener, then report cards like i2c.ts does. */
  //  The session stamps its own per-lookup routing id (`<sourceTicketId>#<n>`) into the keys;
  //  like i2c.ts, the scrape echoes whatever id is stored.
  const armedFor = (sourceTicketId: string) =>
    String(store.pending_i2c_source_ticket_id ?? '').startsWith(sourceTicketId + '#') && listeners.size > 0;
  async function armed(sourceTicketId: string) {
    for (let i = 0; i < 50 && !armedFor(sourceTicketId); i++) await new Promise((r) => setTimeout(r, 0));
    return String(store.pending_i2c_source_ticket_id);
  }
  async function scrape(sourceTicketId: string, cards: unknown[]) {
    const routeId = await armed(sourceTicketId);
    await deps.storageSet({ i2c_card_details: { sourceTicketId: routeId, cards, capturedAt: String(Math.random()) } });
    await deps.storageRemove(['pending_i2c_email', 'pending_i2c_source_ticket_id', 'pending_i2c_flow', 'pending_i2c_started_at']);
  }
  return { deps, store, listeners, tabs, calls, armed, scrape, closeTab: (id: number) => tabs.delete(id) };
}

const card = (last4: string) => ({ last4, status: 'ACTIVE', closed: false });

describe('openI2cSession', () => {
  it('writes the same pending keys as the headless lookup and clears leftovers', async () => {
    const f = fakeChrome();
    f.store.pending_i2c_ticket_url = 'x';
    f.store.pending_i2c_admin_debit_amount = '5';
    const s = openI2cSession(f.deps);
    const p = s.lookup('a@example.com', 'elig-1');
    for (let i = 0; i < 20 && f.listeners.size === 0; i++) await new Promise((r) => setTimeout(r, 0));
    expect(f.store.pending_i2c_email).toBe('a@example.com');
    expect(f.store.pending_i2c_flow).toBe('card_details');
    expect(f.store.pending_i2c_source_ticket_id).toBe('elig-1#1');
    expect(typeof f.store.pending_i2c_started_at).toBe('number');
    expect('pending_i2c_ticket_url' in f.store).toBe(false);
    expect('pending_i2c_admin_debit_amount' in f.store).toBe(false);
    await f.scrape('elig-1', [card('1111')]);
    await expect(p).resolves.toEqual([card('1111')]);
  });

  it('two lookups share one tab: one create at the login URL, then one update to Customer Search', async () => {
    const f = fakeChrome();
    const s = openI2cSession(f.deps);
    const a = s.lookup('a@example.com', 'elig-1');
    await f.scrape('elig-1', [card('1111')]);
    expect(await a).toEqual([card('1111')]);
    const b = s.lookup('b@example.com', 'elig-2');
    await f.scrape('elig-2', [card('2222')]);
    expect(await b).toEqual([card('2222')]);
    expect(f.calls).toEqual([`create:100:${I2C_LOGIN_URL}`, `update:100:${I2C_HOME_URL}`]);
    expect(f.tabs.has(100)).toBe(true); // not closed between lookups
  });

  it('recreates the tab at the login URL when the user closed it', async () => {
    const f = fakeChrome();
    const s = openI2cSession(f.deps);
    const a = s.lookup('a@example.com', 'elig-1');
    await f.scrape('elig-1', []);
    await a;
    f.closeTab(100);
    const b = s.lookup('b@example.com', 'elig-2');
    await f.scrape('elig-2', [card('2222')]);
    expect(await b).toEqual([card('2222')]);
    expect(f.calls).toEqual([`create:100:${I2C_LOGIN_URL}`, `create:101:${I2C_LOGIN_URL}`]);
  });

  it('routes results by sourceTicketId and ignores other ids', async () => {
    const f = fakeChrome();
    const s = openI2cSession(f.deps);
    let settled = false;
    const p = s.lookup('a@example.com', 'elig-1').then((c) => { settled = true; return c; });
    for (let i = 0; i < 20 && f.listeners.size === 0; i++) await new Promise((r) => setTimeout(r, 0));
    await f.deps.storageSet({ i2c_card_details: { sourceTicketId: 'refund-9', cards: [card('9999')] } });
    await new Promise((r) => setTimeout(r, 0));
    expect(settled).toBe(false);
    await f.scrape('elig-1', [card('1111')]);
    expect(await p).toEqual([card('1111')]);
  });

  it('serialises lookups (FIFO) — the second does not start until the first settles', async () => {
    const f = fakeChrome();
    const s = openI2cSession(f.deps);
    const a = s.lookup('a@example.com', 'elig-1');
    const b = s.lookup('b@example.com', 'elig-2');
    await new Promise((r) => setTimeout(r, 0));
    expect(f.store.pending_i2c_source_ticket_id).toBe('elig-1#1');
    await f.scrape('elig-1', [card('1111')]);
    await f.scrape('elig-2', [card('2222')]);
    expect(await a).toEqual([card('1111')]);
    expect(await b).toEqual([card('2222')]);
  });

  it('a timed-out lookup kills its tab and chain keys; the next one signs in a fresh tab', async () => {
    const f = fakeChrome();
    const s = openI2cSession(f.deps);
    await expect(s.lookup('a@example.com', 'elig-1', 5)).rejects.toThrow(/timed out/);
    expect(f.listeners.size).toBe(0);
    expect(f.tabs.size).toBe(0);
    expect(f.store.pending_i2c_email).toBeUndefined();
    expect(f.store.pending_i2c_source_ticket_id).toBeUndefined();
    const b = s.lookup('b@example.com', 'elig-2');
    await f.scrape('elig-2', [card('2222')]);
    expect(await b).toEqual([card('2222')]);
    expect(f.calls).toEqual([`create:100:${I2C_LOGIN_URL}`, 'remove:100', `create:101:${I2C_LOGIN_URL}`]);
  });

  it('a chain that never clears its keys (stale/live) gets its tab killed instead of overwritten', async () => {
    const f = fakeChrome();
    const s = openI2cSession(f.deps);
    const a = s.lookup('a@example.com', 'elig-1');
    const route1 = await f.armed('elig-1');
    // Result arrives but the chain keeps its keys for good (still running).
    await f.deps.storageSet({ i2c_card_details: { sourceTicketId: route1, cards: [] } });
    await a;
    const b = s.lookup('b@example.com', 'elig-2');
    await f.scrape('elig-2', [card('2222')]);
    expect(await b).toEqual([card('2222')]);
    expect(f.calls).toEqual([`create:100:${I2C_LOGIN_URL}`, 'remove:100', `create:101:${I2C_LOGIN_URL}`]);
  });

  it('writes a different routing id per lookup, even for the same sourceTicketId', async () => {
    const f = fakeChrome();
    const s = openI2cSession(f.deps);
    const a = s.lookup('first@example.com', 'elig-1');
    const route1 = await f.armed('elig-1');
    await f.scrape('elig-1', []);
    expect(await a).toEqual([]);

    let settled = false;
    const b = s.lookup('second@example.com', 'elig-1').then((c) => { settled = true; return c; });
    const route2 = await f.armed('elig-1');
    expect(route2).not.toBe(route1);
    expect(f.store.pending_i2c_email).toBe('second@example.com');
    // A late scrape from the first email's chain must not satisfy the second.
    await f.deps.storageSet({ i2c_card_details: { sourceTicketId: route1, cards: [card('1111')] } });
    await new Promise((r) => setTimeout(r, 0));
    expect(settled).toBe(false);
    await f.scrape('elig-1', [card('2222')]);
    expect(await b).toEqual([card('2222')]);
  });

  it('defaults to 75 s in a fresh tab and 60 s in a signed-in one', async () => {
    const f = fakeChrome();
    const s = openI2cSession(f.deps);
    // The lookup timers are cleared once each result lands, so real setTimeout is fine here.
    const spy = vi.spyOn(globalThis, 'setTimeout');
    try {
      const a = s.lookup('a@example.com', 'elig-1');
      await f.scrape('elig-1', []);
      await a;
      const b = s.lookup('b@example.com', 'elig-2');
      await f.scrape('elig-2', []);
      await b;
      const delays = spy.mock.calls.map((c) => c[1]).filter((ms): ms is number => typeof ms === 'number' && ms >= 1000);
      expect(delays).toEqual([75_000, 60_000]);
    } finally {
      spy.mockRestore();
    }
  });

  it('close() removes the tab and the listener, and rejects an in-flight lookup', async () => {
    const f = fakeChrome();
    const s = openI2cSession(f.deps);
    const p = s.lookup('a@example.com', 'elig-1');
    for (let i = 0; i < 20 && f.listeners.size === 0; i++) await new Promise((r) => setTimeout(r, 0));
    await s.close();
    await expect(p).rejects.toThrow(/closed/);
    expect(f.calls).toContain('remove:100');
    expect(f.tabs.size).toBe(0);
    expect(f.listeners.size).toBe(0);
    await expect(s.lookup('b@example.com', 'elig-2')).rejects.toThrow(/closed/);
  });

  it('close() during tab creation still removes the tab once its id arrives', async () => {
    const f = fakeChrome();
    let release!: () => void;
    const create = f.deps.tabsCreate;
    f.deps.tabsCreate = async (props) => { await new Promise<void>((r) => { release = r; }); return create(props); };
    const s = openI2cSession(f.deps);
    const p = s.lookup('a@example.com', 'elig-1');
    for (let i = 0; i < 20 && !release; i++) await new Promise((r) => setTimeout(r, 0));
    await s.close();
    release();
    await expect(p).rejects.toThrow(/closed/);
    await new Promise((r) => setTimeout(r, 0));
    expect(f.tabs.size).toBe(0);
    expect(f.listeners.size).toBe(0);
  });

  it('close() with no lookup, or after the tab is gone, does not throw', async () => {
    const f = fakeChrome();
    await expect(openI2cSession(f.deps).close()).resolves.toBeUndefined();
    const s = openI2cSession(f.deps);
    const a = s.lookup('a@example.com', 'elig-1');
    await f.scrape('elig-1', []);
    await a;
    f.closeTab(100);
    await expect(s.close()).resolves.toBeUndefined();
  });

  it('waits for the previous chain to clear its pending keys before writing the next', async () => {
    const f = fakeChrome();
    const s = openI2cSession(f.deps);
    const a = s.lookup('a@example.com', 'elig-1');
    const route1 = await f.armed('elig-1');
    // Report the result but leave the keys behind, as i2c.ts does for a moment before its remove lands.
    await f.deps.storageSet({ i2c_card_details: { sourceTicketId: route1, cards: [] } });
    await a;
    let sleeps = 0;
    f.deps.sleep = async () => {
      sleeps++;
      if (sleeps === 2) await f.deps.storageRemove(['pending_i2c_email', 'pending_i2c_source_ticket_id', 'pending_i2c_flow', 'pending_i2c_started_at']);
    };
    const b = s.lookup('b@example.com', 'elig-2');
    await f.scrape('elig-2', [card('2222')]);
    expect(await b).toEqual([card('2222')]);
    expect(sleeps).toBe(2);
    // Same tab: the chain went idle in time, so nothing was killed.
    expect(f.calls).toEqual([`create:100:${I2C_LOGIN_URL}`, `update:100:${I2C_HOME_URL}`]);
  });

  it('close() clears the pending chain keys', async () => {
    const f = fakeChrome();
    const s = openI2cSession(f.deps);
    const p = s.lookup('a@example.com', 'elig-1');
    await f.armed('elig-1');
    f.store.qc_search_clicked = true;
    await s.close();
    await expect(p).rejects.toThrow(/closed/);
    for (const k of ['pending_i2c_email', 'pending_i2c_source_ticket_id', 'pending_i2c_flow', 'pending_i2c_started_at', 'qc_search_clicked']) {
      expect(k in f.store).toBe(false);
    }
  });
});
