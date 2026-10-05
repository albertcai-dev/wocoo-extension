// callBridge's headless path, exercised through createEligibilityDraftViaBridge (callBridge
// itself isn't exported). Concurrent headless calls all hear every forwarded GAS reply, so a
// call must only accept the reply from its own tab.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./bridgeTabs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./bridgeTabs')>()),
  registerBridgeTab: vi.fn(async () => {}),
  unregisterBridgeTab: vi.fn(async () => {}),
  sweepExpiredBridgeTabs: vi.fn(async () => 0),
}));

import { createEligibilityDraftViaBridge } from './bridge';
import { registerBridgeTab, unregisterBridgeTab } from './bridgeTabs';

type MsgListener = (msg: unknown, sender?: { tab?: { id?: number } }) => void;

function stubChrome() {
  const listeners = new Set<MsgListener>();
  let releaseCreate: (tab: { id?: number }) => void = () => {};
  const chromeStub = {
    runtime: {
      onMessage: {
        addListener: vi.fn((fn: MsgListener) => { listeners.add(fn); }),
        removeListener: vi.fn((fn: MsgListener) => { listeners.delete(fn); }),
      },
    },
    tabs: {
      create: vi.fn(() => new Promise<{ id?: number }>((r) => { releaseCreate = r; })),
      remove: vi.fn(() => Promise.resolve()),
    },
  };
  vi.stubGlobal('chrome', chromeStub);
  return {
    chromeStub,
    listeners,
    /** Resolve the pending chrome.tabs.create with this tab id. */
    tabOpened: async (id: number) => { releaseCreate({ id }); await flush(); },
    /** What the gasBridge content script forwards from a GAS reply page. */
    reply: (fromTab: number, payload: Record<string, unknown>) => {
      for (const fn of [...listeners]) fn({ source: 'wocoo-gas-bridge', payload }, { tab: { id: fromTab } });
    },
  };
}

const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

beforeEach(() => {
  vi.mocked(registerBridgeTab).mockClear();
  vi.mocked(unregisterBridgeTab).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('callBridge (headless)', () => {
  it('resolves on the expected reply from its own tab, then closes and unregisters the tab', async () => {
    const c = stubChrome();
    const p = createEligibilityDraftViaBridge('msg-1', 'body');
    await c.tabOpened(7);
    expect(registerBridgeTab).toHaveBeenCalledWith(7, 'createEligibilityDraft', 60_000);
    c.reply(7, { action: 'eligibilityDraftCreated', draftId: 'd-7' });
    await expect(p).resolves.toBe('d-7');
    expect(c.chromeStub.tabs.remove).toHaveBeenCalledWith(7);
    expect(unregisterBridgeTab).toHaveBeenCalledWith(7);
    expect(c.listeners.size).toBe(0);
  });

  it("ignores another tab's reply, including its {error}", async () => {
    const c = stubChrome();
    let settled = false;
    const p = createEligibilityDraftViaBridge('msg-1', 'body').finally(() => { settled = true; });
    await c.tabOpened(7);
    c.reply(8, { action: 'eligibilityDraftCreated', draftId: 'd-8' });
    c.reply(8, { error: 'other call failed' });
    await flush();
    expect(settled).toBe(false);
    expect(c.listeners.size).toBe(1);
    c.reply(7, { action: 'eligibilityDraftCreated', draftId: 'd-7' });
    await expect(p).resolves.toBe('d-7');
  });

  it('rejects on an {error} from its own tab', async () => {
    const c = stubChrome();
    const p = createEligibilityDraftViaBridge('msg-1', 'body');
    await c.tabOpened(7);
    c.reply(7, { error: 'Draft quota exceeded' });
    await expect(p).rejects.toThrow('Draft quota exceeded');
    expect(c.listeners.size).toBe(0);
  });

  it('buffers a reply that arrives before tabs.create resolves and accepts it once the tab id is known', async () => {
    const c = stubChrome();
    let settled = false;
    const p = createEligibilityDraftViaBridge('msg-1', 'body').finally(() => { settled = true; });
    await flush();
    c.reply(8, { action: 'eligibilityDraftCreated', draftId: 'd-8' }); // another call's tab
    c.reply(7, { action: 'eligibilityDraftCreated', draftId: 'd-7' }); // ours, early
    await flush();
    expect(settled).toBe(false);
    await c.tabOpened(7);
    await expect(p).resolves.toBe('d-7');
    expect(c.chromeStub.tabs.remove).toHaveBeenCalledWith(7);
  });

  it('times out, rejects, removes the listener and closes the tab', async () => {
    vi.useFakeTimers();
    const c = stubChrome();
    const p = createEligibilityDraftViaBridge('msg-1', 'body');
    const caught = p.catch((e: Error) => e);
    await c.tabOpened(7);
    await vi.advanceTimersByTimeAsync(60_000);
    const err = await caught;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/timed out after 60s/);
    expect(c.listeners.size).toBe(0);
    expect(c.chromeStub.runtime.onMessage.removeListener).toHaveBeenCalled();
    expect(c.chromeStub.tabs.remove).toHaveBeenCalledWith(7);
  });
});
