import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  DraftStoreUnavailable, getDraft, listReadyDrafts, recordOutcome, reportI2cActivity,
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
