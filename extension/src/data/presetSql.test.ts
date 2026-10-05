import { describe, expect, it } from 'vitest';
import { PresetAuthError, parsePastedResults, runPresetSql } from './presetSql';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('runPresetSql', () => {
  it('returns rows from a synchronous execute', async () => {
    const calls: string[] = [];
    const fake = async (url: string) => {
      calls.push(url);
      if (url.endsWith('/csrf_token/')) return json({ result: 'tok' });
      return json({ status: 'success', data: [{ ok: 1 }] });
    };
    expect(await runPresetSql('SELECT 1', fake)).toEqual([{ ok: 1 }]);
    expect(calls[1]).toContain('/api/v1/sqllab/execute/');
  });

  it('polls the results endpoint when execute returns a results key', async () => {
    let polls = 0;
    const fake = async (url: string) => {
      if (url.endsWith('/csrf_token/')) return json({ result: 'tok' });
      if (url.includes('/execute/')) return json({ status: 'pending', query: { resultsKey: 'k1' } });
      polls++;
      return polls < 2 ? json({ status: 'running' }) : json({ status: 'success', data: [{ n: 2 }] });
    };
    expect(await runPresetSql('SELECT 2', fake, async () => {})).toEqual([{ n: 2 }]);
  });

  it('throws PresetAuthError on 401', async () => {
    const fake = async () => json({ msg: 'no' }, 401);
    await expect(runPresetSql('SELECT 1', fake)).rejects.toBeInstanceOf(PresetAuthError);
  });

  it('surfaces the engine error message', async () => {
    const fake = async (url: string) =>
      url.endsWith('/csrf_token/') ? json({ result: 'tok' }) : json({ errors: [{ message: 'column "x" does not exist' }] }, 400);
    await expect(runPresetSql('SELECT x', fake)).rejects.toThrow('column "x" does not exist');
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
