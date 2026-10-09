// Looks up a wire send on Preset's "ALL wire sends created" table (chart 86733 on the
// Wire Send Monitoring dashboard, dataset 62667) by its e2e_identifier — the REF a
// returned wire carries. Uses /api/v1/chart/data rather than SQL Lab so the dashboard's
// own dataset logic is reused as-is. Runs in a hidden Preset tab (see presetSql.ts).

import { chromeTabDeps, PRESET_BASE, rowsOrThrow, withPresetTab, type PageSqlResult, type PresetTabDeps } from './presetSql';

export const WIRE_SENDS_DATASET_ID = 62667;

export interface WireSendRow {
  sourceId: string;
  identityId: string;
  fundingIntentId: string;
  amount: string;
  currency: string;
  /** `YYYY-MM-DD HH:MM:SS`, with ` UTC` when Preset sent epoch ms. */
  createdAt: string;
  status: string;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Runs inside the Preset page. SELF-CONTAINED ON PURPOSE: chrome.scripting.executeScript
 * serialises this function's source, so it must not reference imports, module constants or
 * helpers defined outside it. Never throws; returns a plain serialisable result.
 */
export async function pageFetchWireSends(
  base: string,
  datasetId: number,
  ref: string,
  fetchImpl: FetchLike = (u, i) => fetch(u, i),
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<PageSqlResult> {
  const errMsg = (body: unknown, status: number): string => {
    const b = body as { errors?: { message?: string }[]; message?: string; msg?: string } | null;
    return b?.errors?.[0]?.message || b?.message || b?.msg || `Preset returned HTTP ${status}`;
  };
  const fromBody = (body: unknown): PageSqlResult => {
    const q = (body as { result?: { data?: Record<string, unknown>[]; error?: string | null }[] } | null)?.result?.[0];
    if (q?.error) return { kind: 'error', message: String(q.error) };
    if (Array.isArray(q?.data)) return { kind: 'rows', rows: q.data };
    return { kind: 'error', message: 'Preset returned no rows for the wire send query.' };
  };
  try {
    const tokRes = await fetchImpl(`${base}/api/v1/security/csrf_token/`, { credentials: 'include' });
    if (tokRes.status === 401 || tokRes.status === 403) return { kind: 'auth' };
    const tokBody = (await tokRes.json().catch(() => null)) as { result?: string } | null;
    if (!tokRes.ok) return { kind: 'error', message: errMsg(tokBody, tokRes.status) };
    if (!tokBody?.result) return { kind: 'auth' };

    const res = await fetchImpl(`${base}/api/v1/chart/data`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json', 'X-CSRFToken': tokBody.result },
      body: JSON.stringify({
        datasource: { id: datasetId, type: 'table' },
        force: false,
        result_format: 'json',
        result_type: 'full',
        queries: [{
          columns: ['source_id', 'actor_identity_id', 'FI canonical id', 'requested_amount_value', 'currency', 'created_at', 'Wire Send status'],
          filters: [{ col: 'e2e_identifier', op: '==', val: ref }],
          time_range: 'No filter',
          row_limit: 10,
          orderby: [['created_at', false]],
        }],
      }),
    });
    if (res.status === 401 || res.status === 403) return { kind: 'auth' };
    const body = (await res.json().catch(() => null)) as { result_url?: string } | null;
    if (res.status !== 202) return res.ok ? fromBody(body) : { kind: 'error', message: errMsg(body, res.status) };

    // Async query mode: the result appears at result_url once the worker finishes.
    const resultUrl = body?.result_url;
    if (!resultUrl) return { kind: 'error', message: 'Preset queued the query but gave no result URL.' };
    for (let i = 0; i < 60; i++) {
      await sleep(2000);
      const r = await fetchImpl(`${base}${resultUrl}`, { credentials: 'include' });
      if (r.status === 404 || r.status === 410) continue;
      if (r.status === 401 || r.status === 403) return { kind: 'auth' };
      const rb = await r.json().catch(() => null);
      return r.ok ? fromBody(rb) : { kind: 'error', message: errMsg(rb, r.status) };
    }
    return { kind: 'error', message: 'Preset query did not finish within 2 minutes.' };
  } catch (e) {
    return { kind: 'error', message: e instanceof Error ? e.message : String(e) };
  }
}

function str(v: unknown): string {
  return v == null ? '' : String(v).trim();
}

function formatCreatedAt(v: unknown): string {
  if (typeof v === 'number' && Number.isFinite(v)) {
    return `${new Date(v).toISOString().slice(0, 19).replace('T', ' ')} UTC`;
  }
  return str(v).replace('T', ' ').slice(0, 19);
}

export function toWireSendRows(rows: Record<string, unknown>[]): WireSendRow[] {
  return rows.map((r) => ({
    sourceId: str(r.source_id),
    identityId: str(r.actor_identity_id),
    fundingIntentId: str(r['FI canonical id']),
    amount: str(r.requested_amount_value),
    currency: str(r.currency),
    createdAt: formatCreatedAt(r.created_at),
    status: str(r['Wire Send status']),
  }));
}

/** Chrome calls behind fetchWireSendsByRef, injectable for tests. */
export interface WireSendDeps extends PresetTabDeps {
  executeScript: (tabId: number, args: [string, number, string]) => Promise<PageSqlResult | undefined>;
}

const chromeDeps: WireSendDeps = {
  ...chromeTabDeps,
  executeScript: async (tabId, args) => {
    const results = await chrome.scripting.executeScript({
      target: { tabId }, world: 'MAIN', func: pageFetchWireSends, args,
    });
    return results?.[0]?.result as PageSqlResult | undefined;
  },
};

/** Every wire send whose e2e_identifier is `ref`. `ref` must already be validated by parseWireRef. */
export async function fetchWireSendsByRef(ref: string, deps: WireSendDeps = chromeDeps): Promise<WireSendRow[]> {
  return withPresetTab(deps, async (tabId) =>
    toWireSendRows(rowsOrThrow(await deps.executeScript(tabId, [PRESET_BASE, WIRE_SENDS_DATASET_ID, ref]))));
}
