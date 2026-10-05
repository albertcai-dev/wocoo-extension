// Runs SQL in Preset SQL Lab, or parses results pasted from SQL Lab when direct execution
// isn't available.
//
// Spike S1: Preset rejects SQL Lab requests from the extension origin ("The referrer header
// is missing."), so the query is issued from a hidden Preset tab instead. The tab loads the
// tiny csrf_token JSON endpoint (same origin, so the browser sends a Referer), and the
// request runs in that page via chrome.scripting.executeScript in the MAIN world. The user's
// session cookies come along; nothing is written to chrome.storage.

export const PRESET_BASE = 'https://8a26d867.wealthsimple-aws-mpc.app.preset.io';
export const PANTHEON_DATABASE_ID = 3;
/** Direct = run the SQL automatically from a hidden Preset tab (spike S1,
 *  docs/superpowers/specs/2026-10-05-insurance-eligibility-spikes.md). */
export const PRESET_DIRECT_ENABLED = true;

export class PresetAuthError extends Error {}

export type PageSqlResult =
  | { kind: 'rows'; rows: Record<string, unknown>[] }
  | { kind: 'auth' }
  | { kind: 'error'; message: string };

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Runs inside the Preset page. SELF-CONTAINED ON PURPOSE: chrome.scripting.executeScript
 * serialises this function's source, so it must not reference imports, module constants or
 * helpers defined outside it. Never throws; returns a plain serialisable result.
 */
export async function pageRunSql(
  base: string,
  databaseId: number,
  sql: string,
  fetchImpl: FetchLike = (u, i) => fetch(u, i),
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<PageSqlResult> {
  const errMsg = (body: unknown, status: number): string => {
    const b = body as { errors?: { message?: string }[]; message?: string; msg?: string } | null;
    return b?.errors?.[0]?.message || b?.message || b?.msg || `Preset returned HTTP ${status}`;
  };
  try {
    const tokRes = await fetchImpl(`${base}/api/v1/security/csrf_token/`, { credentials: 'include' });
    if (tokRes.status === 401 || tokRes.status === 403) return { kind: 'auth' };
    const tokBody = (await tokRes.json().catch(() => null)) as { result?: string } | null;
    if (!tokRes.ok) return { kind: 'error', message: errMsg(tokBody, tokRes.status) };
    if (!tokBody?.result) return { kind: 'auth' };

    const execRes = await fetchImpl(`${base}/api/v1/sqllab/execute/`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json', 'X-CSRFToken': tokBody.result },
      body: JSON.stringify({
        database_id: databaseId, sql, runAsync: false, json: true,
        tab: 'Sidekick eligibility', queryLimit: 10000,
      }),
    });
    if (execRes.status === 401 || execRes.status === 403) return { kind: 'auth' };
    const exec = (await execRes.json().catch(() => null)) as
      { data?: Record<string, unknown>[]; query?: { resultsKey?: string } } | null;
    if (!execRes.ok) return { kind: 'error', message: errMsg(exec, execRes.status) };
    if (Array.isArray(exec?.data)) return { kind: 'rows', rows: exec.data };
    const key = exec?.query?.resultsKey;
    if (!key) return { kind: 'error', message: 'Preset returned neither rows nor a results key.' };

    for (let i = 0; i < 60; i++) {
      await sleep(2000);
      const q = encodeURIComponent(`(key:'${key}')`);
      const res = await fetchImpl(`${base}/api/v1/sqllab/results/?q=${q}`, { credentials: 'include' });
      if (res.status === 404 || res.status === 410) continue;
      if (res.status === 401 || res.status === 403) return { kind: 'auth' };
      const body = (await res.json().catch(() => null)) as
        { status?: string; data?: Record<string, unknown>[] } | null;
      if (!res.ok) return { kind: 'error', message: errMsg(body, res.status) };
      if (Array.isArray(body?.data)) return { kind: 'rows', rows: body.data };
      if (body?.status === 'failed') return { kind: 'error', message: errMsg(body, 200) };
    }
    return { kind: 'error', message: 'Preset query did not finish within 2 minutes.' };
  } catch (e) {
    return { kind: 'error', message: e instanceof Error ? e.message : String(e) };
  }
}

/** Chrome calls behind runPresetSql, injectable for tests. */
export interface PresetSqlDeps {
  /** Opens a background tab on `url`; resolves to its id. */
  createTab: (url: string) => Promise<number>;
  /** Resolves once the tab has finished loading (rejects after a timeout). */
  waitForComplete: (tabId: number) => Promise<void>;
  /** The tab's current URL (after any redirects). */
  getTabUrl: (tabId: number) => Promise<string>;
  /** Runs pageRunSql in the tab's page and returns its result. */
  executeScript: (tabId: number, args: [string, number, string]) => Promise<PageSqlResult | undefined>;
  removeTab: (tabId: number) => Promise<void>;
}

const TAB_LOAD_TIMEOUT_MS = 30_000;
const OVERALL_TIMEOUT_MS = 150_000;

const chromeDeps: PresetSqlDeps = {
  createTab: async (url) => {
    const tab = await chrome.tabs.create({ url, active: false });
    if (tab.id == null) throw new Error('Could not open a Preset tab.');
    return tab.id;
  },
  waitForComplete: (tabId) => new Promise<void>((resolve, reject) => {
    let done = false;
    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      clearTimeout(timer);
      if (err) reject(err); else resolve();
    };
    const onUpdated = (id: number, info: { status?: string }) => {
      if (id === tabId && info.status === 'complete') finish();
    };
    const timer = setTimeout(() => finish(new Error('Preset tab did not finish loading.')), TAB_LOAD_TIMEOUT_MS);
    chrome.tabs.onUpdated.addListener(onUpdated);
    // The tab may already be complete before the listener was attached.
    chrome.tabs.get(tabId).then((t) => { if (t.status === 'complete') finish(); }, () => { /* tab gone; timeout reports */ });
  }),
  getTabUrl: async (tabId) => (await chrome.tabs.get(tabId)).url ?? '',
  executeScript: async (tabId, args) => {
    const results = await chrome.scripting.executeScript({
      target: { tabId }, world: 'MAIN', func: pageRunSql, args,
    });
    return results?.[0]?.result as PageSqlResult | undefined;
  },
  removeTab: (tabId) => chrome.tabs.remove(tabId),
};

async function runInTab(sql: string, deps: PresetSqlDeps, tab: { id: number | null }): Promise<Record<string, unknown>[]> {
  tab.id = await deps.createTab(`${PRESET_BASE}/api/v1/security/csrf_token/`);
  await deps.waitForComplete(tab.id);
  const url = await deps.getTabUrl(tab.id);
  let sameOrigin = false;
  try { sameOrigin = new URL(url).origin === new URL(PRESET_BASE).origin; } catch { sameOrigin = false; }
  if (!sameOrigin) throw new PresetAuthError('Not signed in to Preset.');
  const result = await deps.executeScript(tab.id, [PRESET_BASE, PANTHEON_DATABASE_ID, sql]);
  if (!result) throw new Error('Preset tab returned no result.');
  if (result.kind === 'rows') return result.rows;
  if (result.kind === 'auth') throw new PresetAuthError('Not signed in to Preset.');
  throw new Error(result.message);
}

export async function runPresetSql(
  sql: string,
  deps: PresetSqlDeps = chromeDeps,
): Promise<Record<string, unknown>[]> {
  const tab: { id: number | null } = { id: null };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Preset query timed out.')), OVERALL_TIMEOUT_MS);
  });
  try {
    return await Promise.race([runInTab(sql, deps, tab), timeout]);
  } finally {
    clearTimeout(timer);
    if (tab.id != null) {
      try { await deps.removeTab(tab.id); } catch { /* tab may already be closed */ }
    }
  }
}

/** Parse CSV or tab-separated values with quote handling. */
function parseLine(line: string, sep: string): string[] {
  if (sep === '\t') {
    // Tab-separated: strip surrounding quotes from each cell
    return line.split(sep).map((cell) => {
      const trimmed = cell.trim();
      if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
        return trimmed.slice(1, -1);
      }
      return trimmed;
    });
  }
  // Comma-separated with RFC 4180 quote handling
  const cells: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        // Escaped quote: "" becomes "
        current += '"';
        i++;
      } else {
        // Toggle quote state
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      // Unquoted comma is a field separator
      cells.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current.trim());
  return cells;
}

export function parsePastedResults(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const sep = lines[0].includes('\t') ? '\t' : ',';
  const headers = parseLine(lines[0], sep);
  return lines.slice(1).map((line, idx) => {
    const cells = parseLine(line, sep);
    if (cells.length !== headers.length) {
      throw new Error(
        `Could not parse pasted row ${idx + 1}: expected ${headers.length} columns, got ${cells.length}. Paste the tab-separated results from SQL Lab.`
      );
    }
    const o: Record<string, string> = {};
    headers.forEach((h, i) => { o[h] = cells[i]; });
    return o;
  });
}
