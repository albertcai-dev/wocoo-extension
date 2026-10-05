import { describe, expect, it } from 'vitest';
import { PRESET_BASE, PresetAuthError, pageRunSql, parsePastedResults, runPresetSql, type PresetSqlDeps } from './presetSql';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const noSleep = async () => {};

describe('pageRunSql', () => {
  it('returns rows from a synchronous execute', async () => {
    const calls: string[] = [];
    const fake = async (url: string) => {
      calls.push(url);
      if (url.endsWith('/csrf_token/')) return json({ result: 'tok' });
      return json({ status: 'success', data: [{ ok: 1 }] });
    };
    expect(await pageRunSql('https://p', 3, 'SELECT 1', fake, noSleep)).toEqual({ kind: 'rows', rows: [{ ok: 1 }] });
    expect(calls[0]).toBe('https://p/api/v1/security/csrf_token/');
    expect(calls[1]).toBe('https://p/api/v1/sqllab/execute/');
  });

  it('sends csrf token, database id and sql in the execute request', async () => {
    let init: RequestInit | undefined;
    const fake = async (url: string, i?: RequestInit) => {
      if (url.endsWith('/csrf_token/')) return json({ result: 'tok' });
      init = i;
      return json({ data: [] });
    };
    await pageRunSql('https://p', 3, 'SELECT 1', fake, noSleep);
    expect((init?.headers as Record<string, string>)['X-CSRFToken']).toBe('tok');
    expect(JSON.parse(init?.body as string)).toMatchObject({ database_id: 3, sql: 'SELECT 1', runAsync: false, json: true });
  });

  it('polls the results endpoint when execute returns a results key', async () => {
    let polls = 0;
    const fake = async (url: string) => {
      if (url.endsWith('/csrf_token/')) return json({ result: 'tok' });
      if (url.includes('/execute/')) return json({ status: 'pending', query: { resultsKey: 'k1' } });
      polls++;
      return polls < 2 ? json({ status: 'running' }) : json({ status: 'success', data: [{ n: 2 }] });
    };
    expect(await pageRunSql('https://p', 3, 'SELECT 2', fake, noSleep)).toEqual({ kind: 'rows', rows: [{ n: 2 }] });
    expect(polls).toBe(2);
  });

  it('keeps polling through 404/410 and reports a failed query', async () => {
    let polls = 0;
    const fake = async (url: string) => {
      if (url.endsWith('/csrf_token/')) return json({ result: 'tok' });
      if (url.includes('/execute/')) return json({ query: { resultsKey: 'k1' } });
      polls++;
      if (polls === 1) return json({}, 410);
      return json({ status: 'failed', errors: [{ message: 'boom' }] });
    };
    expect(await pageRunSql('https://p', 3, 'x', fake, noSleep)).toEqual({ kind: 'error', message: 'boom' });
  });

  it('gives up after 60 polls', async () => {
    const fake = async (url: string) => {
      if (url.endsWith('/csrf_token/')) return json({ result: 'tok' });
      if (url.includes('/execute/')) return json({ query: { resultsKey: 'k1' } });
      return json({ status: 'running' });
    };
    const r = await pageRunSql('https://p', 3, 'x', fake, noSleep);
    expect(r).toMatchObject({ kind: 'error' });
    expect((r as { message: string }).message).toMatch(/did not finish within 2 minutes/);
  });

  it('returns auth on 401 from csrf', async () => {
    const fake = async () => json({ msg: 'no' }, 401);
    expect(await pageRunSql('https://p', 3, 'x', fake, noSleep)).toEqual({ kind: 'auth' });
  });

  it('returns auth on 403 from execute', async () => {
    const fake = async (url: string) => (url.endsWith('/csrf_token/') ? json({ result: 'tok' }) : json({}, 403));
    expect(await pageRunSql('https://p', 3, 'x', fake, noSleep)).toEqual({ kind: 'auth' });
  });

  it('returns auth when the csrf body has no result', async () => {
    const fake = async () => json({});
    expect(await pageRunSql('https://p', 3, 'x', fake, noSleep)).toEqual({ kind: 'auth' });
  });

  it('surfaces the engine error message on 400', async () => {
    const fake = async (url: string) =>
      url.endsWith('/csrf_token/') ? json({ result: 'tok' }) : json({ errors: [{ message: 'column "x" does not exist' }] }, 400);
    expect(await pageRunSql('https://p', 3, 'x', fake, noSleep)).toEqual({ kind: 'error', message: 'column "x" does not exist' });
  });

  it('falls back to an HTTP status message', async () => {
    const fake = async (url: string) => (url.endsWith('/csrf_token/') ? json({ result: 'tok' }) : json({}, 500));
    expect(await pageRunSql('https://p', 3, 'x', fake, noSleep)).toEqual({ kind: 'error', message: 'Preset returned HTTP 500' });
  });

  it('returns an error (never throws) when fetch throws', async () => {
    const fake = async () => { throw new Error('network down'); };
    expect(await pageRunSql('https://p', 3, 'x', fake, noSleep)).toEqual({ kind: 'error', message: 'network down' });
  });

  it('is self-contained (executeScript serialises its source)', () => {
    const src = pageRunSql.toString();
    expect(src).not.toContain('PRESET_BASE');
    expect(src).not.toContain('PANTHEON_DATABASE_ID');
    expect(src).not.toContain('PresetAuthError');
  });
});

describe('runPresetSql', () => {
  function makeDeps(over: Partial<PresetSqlDeps> = {}) {
    const removed: number[] = [];
    const executed: unknown[][] = [];
    const deps: PresetSqlDeps = {
      createTab: async () => 7,
      waitForComplete: async () => {},
      getTabUrl: async () => `${PRESET_BASE}/api/v1/security/csrf_token/`,
      executeScript: async (_tabId, args) => { executed.push(args); return { kind: 'rows', rows: [{ ok: 1 }] }; },
      removeTab: async (id) => { removed.push(id); },
      ...over,
    };
    return { deps, removed, executed };
  }

  it('returns rows and closes the tab', async () => {
    const { deps, removed, executed } = makeDeps();
    expect(await runPresetSql('SELECT 1', deps)).toEqual([{ ok: 1 }]);
    expect(removed).toEqual([7]);
    expect(executed[0]).toEqual([PRESET_BASE, 3, 'SELECT 1']);
  });

  it('throws PresetAuthError on an auth result and closes the tab', async () => {
    const { deps, removed } = makeDeps({ executeScript: async () => ({ kind: 'auth' }) });
    await expect(runPresetSql('x', deps)).rejects.toBeInstanceOf(PresetAuthError);
    expect(removed).toEqual([7]);
  });

  it('throws the message on an error result and closes the tab', async () => {
    const { deps, removed } = makeDeps({ executeScript: async () => ({ kind: 'error', message: 'bad sql' }) });
    await expect(runPresetSql('x', deps)).rejects.toThrow('bad sql');
    expect(removed).toEqual([7]);
  });

  it('throws when the tab returns no result', async () => {
    const { deps, removed } = makeDeps({ executeScript: async () => undefined });
    await expect(runPresetSql('x', deps)).rejects.toThrow('Preset tab returned no result.');
    expect(removed).toEqual([7]);
  });

  it('closes the tab when executeScript throws', async () => {
    const { deps, removed } = makeDeps({ executeScript: async () => { throw new Error('inject failed'); } });
    await expect(runPresetSql('x', deps)).rejects.toThrow('inject failed');
    expect(removed).toEqual([7]);
  });

  it('throws PresetAuthError when the tab landed off Preset, without running the query', async () => {
    const { deps, removed, executed } = makeDeps({ getTabUrl: async () => 'https://login.okta.com/signin' });
    await expect(runPresetSql('x', deps)).rejects.toBeInstanceOf(PresetAuthError);
    expect(removed).toEqual([7]);
    expect(executed).toEqual([]);
  });

  it('rejects a look-alike host that merely starts with the Preset base', async () => {
    const { deps, removed, executed } = makeDeps({ getTabUrl: async () => `${PRESET_BASE}.evil.com/api/v1/security/csrf_token/` });
    await expect(runPresetSql('x', deps)).rejects.toBeInstanceOf(PresetAuthError);
    expect(removed).toEqual([7]);
    expect(executed).toEqual([]);
  });

  it('treats an unparseable tab URL as not signed in', async () => {
    const { deps, removed, executed } = makeDeps({ getTabUrl: async () => '' });
    await expect(runPresetSql('x', deps)).rejects.toBeInstanceOf(PresetAuthError);
    expect(removed).toEqual([7]);
    expect(executed).toEqual([]);
  });

  it('ignores errors from removing the tab', async () => {
    const { deps } = makeDeps({ removeTab: async () => { throw new Error('gone'); } });
    expect(await runPresetSql('x', deps)).toEqual([{ ok: 1 }]);
  });
});

describe('parsePastedResults', () => {
  it('parses tab-separated results with a header row', () => {
    const text = 'request_id\tlast4\nm1\t1763\nm2\t0042\n';
    expect(parsePastedResults(text)).toEqual([{ request_id: 'm1', last4: '1763' }, { request_id: 'm2', last4: '0042' }]);
  });
  it('parses comma-separated results when there are no tabs', () => {
    expect(parsePastedResults('a,b\n1,2')).toEqual([{ a: '1', b: '2' }]);
  });
  it('returns [] for empty input', () => {
    expect(parsePastedResults('  ')).toEqual([]);
  });
  it('handles quoted CSV fields with embedded commas', () => {
    expect(parsePastedResults('a,b\n"Smith, John",2')).toEqual([{ a: 'Smith, John', b: '2' }]);
  });
  it('handles escaped quotes in CSV fields (RFC 4180)', () => {
    expect(parsePastedResults('a,b\n"say ""hi""",2')).toEqual([{ a: 'say "hi"', b: '2' }]);
  });
  it('strips surrounding quotes from tab-separated cells', () => {
    expect(parsePastedResults('a\tb\n"1763"\t2')).toEqual([{ a: '1763', b: '2' }]);
  });
  it('throws when CSV row has too many columns', () => {
    expect(() => parsePastedResults('a,b\n1,2,3')).toThrow(/row 1/);
  });
  it('throws when tab-separated row has too few columns', () => {
    expect(() => parsePastedResults('a\tb\n1')).toThrow(/row 1/);
  });
});
