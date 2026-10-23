import { describe, expect, it } from 'vitest';
import { PRESET_BASE, PresetAuthError } from './presetSql';
import { fetchWireSendsByRef, pageFetchWireSends, toWireSendRows, WIRE_SENDS_DATASET_ID, type WireSendDeps } from './presetChartData';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
const noSleep = async () => {};
const ROW = {
  source_id: 'ca-cash-msb-icIMc1DLuA', actor_identity_id: 'identity-abc', 'FI canonical id': 'funding_intent-xyz',
  requested_amount_value: 56295.89, currency: 'CAD', created_at: 1791338335000, 'Wire Send status': 'ACCEPTED',
};

describe('pageFetchWireSends', () => {
  it('posts a raw, untimed, e2e_identifier-filtered query on the dataset with the csrf token', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fake = async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith('/csrf_token/')) return json({ result: 'tok' });
      return json({ result: [{ data: [ROW] }] });
    };
    expect(await pageFetchWireSends('https://p', 62667, 'AVJJXHZEBVIA53DF', fake, noSleep)).toEqual({ kind: 'rows', rows: [ROW] });
    expect(calls[1].url).toBe('https://p/api/v1/chart/data');
    expect((calls[1].init?.headers as Record<string, string>)['X-CSRFToken']).toBe('tok');
    const body = JSON.parse(calls[1].init?.body as string);
    expect(body.datasource).toEqual({ id: 62667, type: 'table' });
    expect(body.queries[0].filters).toEqual([{ col: 'e2e_identifier', op: '==', val: 'AVJJXHZEBVIA53DF' }]);
    expect(body.queries[0].time_range).toBe('No filter');
    expect(body.queries[0].row_limit).toBe(10);
    expect(body.queries[0].columns).toContain('source_id');
  });

  it('polls result_url after a 202 until the data is ready', async () => {
    let polls = 0;
    const fake = async (url: string) => {
      if (url.endsWith('/csrf_token/')) return json({ result: 'tok' });
      if (url.endsWith('/api/v1/chart/data')) return json({ result_url: '/api/v1/chart/data/key1' }, 202);
      polls++;
      return polls < 2 ? json({}, 404) : json({ result: [{ data: [ROW] }] });
    };
    expect(await pageFetchWireSends('https://p', 1, 'R', fake, noSleep)).toEqual({ kind: 'rows', rows: [ROW] });
    expect(polls).toBe(2);
  });

  it('returns auth on 401/403 from csrf and 401 from chart data', async () => {
    expect(await pageFetchWireSends('https://p', 1, 'R', async () => json({}, 401), noSleep)).toEqual({ kind: 'auth' });
    expect(await pageFetchWireSends('https://p', 1, 'R', async () => json({}, 403), noSleep)).toEqual({ kind: 'auth' });
    const fake = async (url: string) => (url.endsWith('/csrf_token/') ? json({ result: 'tok' }) : json({}, 401));
    expect(await pageFetchWireSends('https://p', 1, 'R', fake, noSleep)).toEqual({ kind: 'auth' });
  });

  it("reports a chart-data 403 as Preset's own message, not as signed out", async () => {
    const denied = { message: 'This endpoint requires the datasource wire_sends, database or `all_datasource_access` permission' };
    const sync = async (url: string) => (url.endsWith('/csrf_token/') ? json({ result: 'tok' }) : json(denied, 403));
    expect(await pageFetchWireSends('https://p', 1, 'R', sync, noSleep)).toEqual({ kind: 'error', message: denied.message });
    const queued = async (url: string) => {
      if (url.endsWith('/csrf_token/')) return json({ result: 'tok' });
      if (url.endsWith('/api/v1/chart/data')) return json({ result_url: '/api/v1/chart/data/k' }, 202);
      return json(denied, 403);
    };
    expect(await pageFetchWireSends('https://p', 1, 'R', queued, noSleep)).toEqual({ kind: 'error', message: denied.message });
  });

  it('surfaces a query error and an HTTP error', async () => {
    const qErr = async (url: string) => (url.endsWith('/csrf_token/') ? json({ result: 'tok' }) : json({ result: [{ error: 'column missing', data: [] }] }));
    expect(await pageFetchWireSends('https://p', 1, 'R', qErr, noSleep)).toEqual({ kind: 'error', message: 'column missing' });
    const http = async (url: string) => (url.endsWith('/csrf_token/') ? json({ result: 'tok' }) : json({ message: 'Datasource does not exist' }, 404));
    expect(await pageFetchWireSends('https://p', 1, 'R', http, noSleep)).toEqual({ kind: 'error', message: 'Datasource does not exist' });
  });

  it('never throws when fetch throws', async () => {
    expect(await pageFetchWireSends('https://p', 1, 'R', async () => { throw new Error('offline'); }, noSleep)).toEqual({ kind: 'error', message: 'offline' });
  });

  it('is self-contained (executeScript serialises its source)', () => {
    const src = pageFetchWireSends.toString();
    expect(src).not.toContain('PRESET_BASE');
    expect(src).not.toContain('WIRE_SENDS_DATASET_ID');
  });
});

describe('toWireSendRows', () => {
  it('maps the dashboard columns and formats an epoch-ms created_at as UTC', () => {
    expect(toWireSendRows([ROW])).toEqual([{
      sourceId: 'ca-cash-msb-icIMc1DLuA', identityId: 'identity-abc', fundingIntentId: 'funding_intent-xyz',
      amount: '56295.89', currency: 'CAD', createdAt: '2026-10-07 01:58:55 UTC', status: 'ACCEPTED',
    }]);
  });
  it('reads Snowflake-style UPPERCASE column names', () => {
    const upper = Object.fromEntries(Object.entries(ROW).map(([k, v]) => [k.toUpperCase(), v]));
    expect(toWireSendRows([upper])).toEqual(toWireSendRows([ROW]));
    expect(toWireSendRows([upper])[0].status).toBe('ACCEPTED');
  });
  it('keeps a string created_at and blanks missing fields', () => {
    expect(toWireSendRows([{ created_at: '2026-10-07 01:58:55.123', source_id: null }])[0]).toMatchObject({
      createdAt: '2026-10-07 01:58:55', sourceId: '', currency: '',
    });
  });
});

describe('fetchWireSendsByRef', () => {
  it('runs the page function in a hidden Preset tab with the dataset id and ref', async () => {
    const executed: unknown[] = [];
    const deps: WireSendDeps = {
      createTab: async () => 4, waitForComplete: async () => {}, removeTab: async () => {},
      getTabUrl: async () => `${PRESET_BASE}/api/v1/security/csrf_token/`,
      executeScript: async (_id, args) => { executed.push(args); return { kind: 'rows', rows: [ROW] }; },
    };
    const rows = await fetchWireSendsByRef('AVJJXHZEBVIA53DF', deps);
    expect(rows[0].sourceId).toBe('ca-cash-msb-icIMc1DLuA');
    expect(executed[0]).toEqual([PRESET_BASE, WIRE_SENDS_DATASET_ID, 'AVJJXHZEBVIA53DF']);
  });
  it('throws PresetAuthError when not signed in', async () => {
    const deps: WireSendDeps = {
      createTab: async () => 4, waitForComplete: async () => {}, removeTab: async () => {},
      getTabUrl: async () => `${PRESET_BASE}/`, executeScript: async () => ({ kind: 'auth' }),
    };
    await expect(fetchWireSendsByRef('R', deps)).rejects.toBeInstanceOf(PresetAuthError);
  });
});
