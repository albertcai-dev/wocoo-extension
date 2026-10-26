import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  DraftStoreUnavailable, getAgentStatus, getDraft, isDraftStoreNotSetUp, listReadyDrafts, recordOutcome, reportI2cActivity,
} from './draftStore';
import type { DraftOutcomeRow } from '../data/agentDraftTypes';

type Reply = unknown;

function mockNative(reply: Reply, lastError?: string) {
  const send = vi.fn((_host: string, _msg: object, cb: (r: Reply) => void) => {
    (globalThis as any).chrome.runtime.lastError = lastError ? { message: lastError } : undefined;
    cb(lastError ? undefined : reply);
  });
  vi.stubGlobal('chrome', { runtime: { sendNativeMessage: send, lastError: undefined } });
  return send;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('getDraft', () => {
  it('asks the host for the key and returns the draft', async () => {
    const send = mockNative({ ok: true, draft: { ticket: 'TEST-1' } });
    expect(await getDraft('TEST-1')).toEqual({ ticket: 'TEST-1' });
    expect(send.mock.calls[0][0]).toBe('com.wealthsimple.wocoo_launcher');
    expect(send.mock.calls[0][1]).toEqual({ action: 'draft_get', key: 'TEST-1' });
  });

  it('returns null when host returns draft null', async () => {
    mockNative({ ok: true, draft: null });
    expect(await getDraft('TEST-1')).toBeNull();
  });

  it('throws DraftStoreUnavailable on chrome.runtime.lastError', async () => {
    mockNative(undefined, 'Specified native messaging host not found.');
    await expect(getDraft('TEST-1')).rejects.toBeInstanceOf(DraftStoreUnavailable);
  });

  it('throws DraftStoreUnavailable with the host error when ok is false', async () => {
    mockNative({ ok: false, error: 'store_cli failed: boom' });
    await expect(getDraft('TEST-1')).rejects.toThrow('store_cli failed: boom');
  });
});

describe('listReadyDrafts', () => {
  it('passes rows through', async () => {
    const rows = [{ key: 'TEST-1', summary: 's', marker: '', kind: 'new', outcome: 'draft',
      url: 'https://example.test/TEST-1', created_at: '2026-01-01T00:00:00Z', assigned_at: 1 }];
    mockNative({ ok: true, items: rows });
    expect(await listReadyDrafts()).toEqual(rows);
  });

  it('treats a missing items list as empty', async () => {
    mockNative({ ok: true });
    expect(await listReadyDrafts()).toEqual([]);
  });
});

describe('recordOutcome / reportI2cActivity', () => {
  it('sends the outcome row to the host', async () => {
    const send = mockNative({ ok: true });
    const row: DraftOutcomeRow = {
      key: 'TEST-1', work_type: 'Task', draft_created_at: '2026-01-01T00:00:00Z',
      recorded_at: '2026-01-01T01:00:00Z', via: 'sidekick', draft_text: 'hi', posted_text: 'hi there',
      suggested_status: 'Done', actual_status: 'Done', flags: [], assigned_at: null,
    };
    await recordOutcome(row);
    expect(send.mock.calls[0][1]).toEqual({ action: 'draft_outcome', row });
  });

  it('sends the i2c activity timestamp', async () => {
    const send = mockNative({ ok: true });
    await reportI2cActivity(1700000000);
    expect(send.mock.calls[0][1]).toEqual({ action: 'i2c_activity', ts: 1700000000 });
  });

  it('throws DraftStoreUnavailable when the host is missing', async () => {
    mockNative(undefined, 'host not found');
    await expect(reportI2cActivity(1)).rejects.toBeInstanceOf(DraftStoreUnavailable);
    await expect(recordOutcome({} as DraftOutcomeRow)).rejects.toBeInstanceOf(DraftStoreUnavailable);
  });
});

describe('isDraftStoreNotSetUp', () => {
  const err = (m: string) => new DraftStoreUnavailable(m);

  it('is true when this machine simply has no draft agent (render nothing)', () => {
    expect(isDraftStoreNotSetUp(err('Specified native messaging host not found.'))).toBe(true);
    expect(isDraftStoreNotSetUp(err('host not found'))).toBe(true);
    expect(isDraftStoreNotSetUp(err('Not found: /Users/someone/projects/wocoo-draft-agent/src/store_cli.py'))).toBe(true);
    // An older launcher (interest tool only) that predates the draft actions.
    expect(isDraftStoreNotSetUp(err("Unknown action: 'draft_get'"))).toBe(true);
    // A launcher from before the progress card.
    expect(isDraftStoreNotSetUp(err("Unknown action: 'agent_status'"))).toBe(true);
    // A new launcher with an agent checkout from before `store_cli status` (argparse rejects it).
    expect(isDraftStoreNotSetUp(err(
      "store_cli failed: usage: store_cli.py [-h] {get,list,next} ...\n"
      + "store_cli.py: error: argument cmd: invalid choice: 'status' (choose from 'get', 'list', 'next')",
    ))).toBe(true);
  });

  it('is false for a real failure worth a one-line message', () => {
    expect(isDraftStoreNotSetUp(err('Access to the specified native messaging host is forbidden.'))).toBe(false);
    expect(isDraftStoreNotSetUp(err('store_cli failed: boom'))).toBe(false);
    expect(isDraftStoreNotSetUp(err('store_cli timed out after 5s'))).toBe(false);
    expect(isDraftStoreNotSetUp(err('The draft store did not respond.'))).toBe(false);
    // Another command missing is a real version mismatch, not "not set up".
    expect(isDraftStoreNotSetUp(err("store_cli failed: store_cli.py: error: argument cmd: invalid choice: 'stage'"))).toBe(false);
  });

  it('is false for anything that is not a DraftStoreUnavailable', () => {
    expect(isDraftStoreNotSetUp(new Error('Specified native messaging host not found.'))).toBe(false);
    expect(isDraftStoreNotSetUp('host not found')).toBe(false);
  });

  it('classifies what getDraft actually throws', async () => {
    mockNative(undefined, 'Specified native messaging host not found.');
    const e = await getDraft('TEST-1').catch((x) => x);
    expect(isDraftStoreNotSetUp(e)).toBe(true);
    mockNative({ ok: false, error: 'Not found: /x/src/store_cli.py' });
    expect(isDraftStoreNotSetUp(await getDraft('TEST-1').catch((x) => x))).toBe(true);
    mockNative(undefined, 'Access to the specified native messaging host is forbidden.');
    expect(isDraftStoreNotSetUp(await getDraft('TEST-1').catch((x) => x))).toBe(false);
  });
});

describe('getAgentStatus', () => {
  it('asks the host for agent_status and normalises the reply', async () => {
    const send = mockNative({ ok: true, mode: 'running', queue: [{ key: 'Q-1', summary: 'One', tag: 'solve' }] });
    const s = await getAgentStatus();
    expect(send.mock.calls[0][1]).toEqual({ action: 'agent_status' });
    expect(s.mode).toBe('running');
    expect(s.queue).toEqual([{ key: 'Q-1', summary: 'One', tag: 'solve' }]);
    expect(s.current).toBeNull();
  });

  it('throws DraftStoreUnavailable when the host fails', async () => {
    mockNative({ ok: false, error: "Unknown action: 'agent_status'" });
    const e = await getAgentStatus().catch((x) => x);
    expect(e).toBeInstanceOf(DraftStoreUnavailable);
    expect(isDraftStoreNotSetUp(e)).toBe(true);
  });
});
