// Returned wire → W#: REF (from txdetail_rmtinfo_ustrd) → the wire send on Preset's
// Wire Send Monitoring table → its source account → that account's W# on Atlas.
// Replaces the manual dashboard search + Atlas search for tracker rows with no
// receiver external account.

import { fetchCustodianAccountNumber, type CustodianAccount } from './atlasGraphql';
import { fetchWireSendsByRef, type WireSendRow } from './presetChartData';
import { parseWireRef } from './wireRef';

export type WireSendWResult =
  | { kind: 'no_ref' }
  | { kind: 'none'; ref: string }
  | { kind: 'multiple'; ref: string; rows: WireSendRow[] }
  | { kind: 'found'; ref: string; row: WireSendRow; account: CustodianAccount }
  | { kind: 'no_account'; ref: string; row: WireSendRow; reason: string };

export interface WireSendWDeps {
  fetchRows: (ref: string) => Promise<WireSendRow[]>;
  fetchAccount: (accountId: string) => Promise<CustodianAccount | null>;
}

const liveDeps: WireSendWDeps = {
  fetchRows: (ref) => fetchWireSendsByRef(ref),
  fetchAccount: fetchCustodianAccountNumber,
};

/** Preset errors (including PresetAuthError) propagate; Atlas errors become `no_account`. */
export async function fetchWireSendW(input: string, deps: WireSendWDeps = liveDeps): Promise<WireSendWResult> {
  const ref = parseWireRef(input);
  if (!ref) return { kind: 'no_ref' };
  const rows = await deps.fetchRows(ref);
  if (rows.length === 0) return { kind: 'none', ref };
  if (rows.length > 1) return { kind: 'multiple', ref, rows };
  const row = rows[0];
  if (!row.sourceId) return { kind: 'no_account', ref, row, reason: 'This wire send has no source_id.' };
  const miss = `Atlas didn't return an account number for ${row.sourceId}`;
  try {
    const account = await deps.fetchAccount(row.sourceId);
    return account ? { kind: 'found', ref, row, account } : { kind: 'no_account', ref, row, reason: `${miss}.` };
  } catch (e) {
    return { kind: 'no_account', ref, row, reason: `${miss} (${e instanceof Error ? e.message : String(e)}).` };
  }
}

/**
 * Whether `result` still answers what is in the box. A lookup takes seconds, so the user can
 * paste the next wire before it lands; showing its W# under the new text would invite pasting
 * it against the wrong tracker row.
 */
export function isResultForInput(result: WireSendWResult, input: string): boolean {
  const ref = parseWireRef(input);
  return result.kind === 'no_ref' ? ref === null : result.ref === ref;
}

export function atlasTransferUrl(row: WireSendRow): string {
  return `https://atlas.wealthsimple.com/identity/${row.identityId}/transfers/${row.fundingIntentId}`;
}
