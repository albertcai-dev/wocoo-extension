import { describe, expect, it } from 'vitest';
import { PresetAuthError } from './presetSql';
import type { WireSendRow } from './presetChartData';
import { atlasTransferUrl, fetchWireSendW, type WireSendWDeps } from './wireSendW';

const CELL = '/BNF/RETURN WIRE DATED 10 07 26 //REF AVJJXHZEBVIA53DF CAD56,295.89//.';
const ROW: WireSendRow = {
  sourceId: 'ca-cash-msb-icIMc1DLuA', identityId: 'identity-abc', fundingIntentId: 'funding_intent-xyz',
  amount: '56295.89', currency: 'CAD', createdAt: '2026-10-07 01:58:55 UTC', status: 'ACCEPTED',
};

function deps(over: Partial<WireSendWDeps> = {}) {
  const calls = { rows: [] as string[], account: [] as string[] };
  const d: WireSendWDeps = {
    fetchRows: async (ref) => { calls.rows.push(ref); return [ROW]; },
    fetchAccount: async (id) => { calls.account.push(id); return { accountNumber: 'WK5LGP131CAD', isCadSpend: true }; },
    ...over,
  };
  return { d, calls };
}

describe('fetchWireSendW', () => {
  it('goes from the pasted cell to the W#', async () => {
    const { d, calls } = deps();
    expect(await fetchWireSendW(CELL, d)).toEqual({
      kind: 'found', ref: 'AVJJXHZEBVIA53DF', row: ROW, account: { accountNumber: 'WK5LGP131CAD', isCadSpend: true },
    });
    expect(calls.rows).toEqual(['AVJJXHZEBVIA53DF']);
    expect(calls.account).toEqual(['ca-cash-msb-icIMc1DLuA']);
  });

  it('returns no_ref without touching Preset', async () => {
    const { d, calls } = deps();
    expect(await fetchWireSendW('nothing here', d)).toEqual({ kind: 'no_ref' });
    expect(calls.rows).toEqual([]);
  });

  it('returns none when Preset has no matching send', async () => {
    const { d } = deps({ fetchRows: async () => [] });
    expect(await fetchWireSendW(CELL, d)).toEqual({ kind: 'none', ref: 'AVJJXHZEBVIA53DF' });
  });

  it('lists every match and skips Atlas when more than one send matches', async () => {
    const other = { ...ROW, sourceId: 'ca-cash-msb-other' };
    const { d, calls } = deps({ fetchRows: async () => [ROW, other] });
    expect(await fetchWireSendW(CELL, d)).toEqual({ kind: 'multiple', ref: 'AVJJXHZEBVIA53DF', rows: [ROW, other] });
    expect(calls.account).toEqual([]);
  });

  it('does not call Atlas when the matched send has no source_id', async () => {
    const { d, calls } = deps({ fetchRows: async () => [{ ...ROW, sourceId: '' }] });
    const r = await fetchWireSendW(CELL, d);
    expect(r).toMatchObject({ kind: 'no_account', reason: 'This wire send has no source_id.' });
    expect(calls.account).toEqual([]);
  });

  it('turns an Atlas miss or failure into no_account', async () => {
    const miss = deps({ fetchAccount: async () => null });
    expect(await fetchWireSendW(CELL, miss.d)).toMatchObject({
      kind: 'no_account', reason: "Atlas didn't return an account number for ca-cash-msb-icIMc1DLuA.",
    });
    const boom = deps({ fetchAccount: async () => { throw new Error('Atlas getAccountDetails failed: HTTP 401'); } });
    expect(await fetchWireSendW(CELL, boom.d)).toMatchObject({
      kind: 'no_account', reason: "Atlas didn't return an account number for ca-cash-msb-icIMc1DLuA (Atlas getAccountDetails failed: HTTP 401).",
    });
  });

  it('lets Preset errors propagate', async () => {
    const { d } = deps({ fetchRows: async () => { throw new PresetAuthError('Not signed in to Preset.'); } });
    await expect(fetchWireSendW(CELL, d)).rejects.toBeInstanceOf(PresetAuthError);
  });
});

describe('atlasTransferUrl', () => {
  it('links to the transfer on the identity', () => {
    expect(atlasTransferUrl(ROW)).toBe('https://atlas.wealthsimple.com/identity/identity-abc/transfers/funding_intent-xyz');
  });
});
