// Runs SQL in Preset SQL Lab with the user's browser session (spike S1), or parses
// results pasted from SQL Lab when direct execution isn't available.

export const PRESET_BASE = 'https://8a26d867.wealthsimple-aws-mpc.app.preset.io';
export const PANTHEON_DATABASE_ID = 3;
/** From spike S1 (docs/superpowers/specs/2026-10-05-insurance-eligibility-spikes.md). */
export const PRESET_DIRECT_ENABLED = true;

export class PresetAuthError extends Error {}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

function engineError(body: unknown, status: number): Error {
  const b = body as { errors?: { message?: string }[]; message?: string; msg?: string } | null;
  const msg = b?.errors?.[0]?.message || b?.message || b?.msg || `Preset returned HTTP ${status}`;
  return new Error(msg);
}

async function readJson(res: Response): Promise<unknown> {
  if (res.status === 401 || res.status === 403) throw new PresetAuthError('Not signed in to Preset.');
  const body = await res.json().catch(() => null);
  if (!res.ok) throw engineError(body, res.status);
  return body;
}

export async function runPresetSql(
  sql: string,
  fetchImpl: FetchLike = (u, i) => fetch(u, i),
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<Record<string, unknown>[]> {
  const tok = (await readJson(await fetchImpl(`${PRESET_BASE}/api/v1/security/csrf_token/`, { credentials: 'include' }))) as { result?: string };
  const csrf = tok?.result ?? '';

  const exec = (await readJson(await fetchImpl(`${PRESET_BASE}/api/v1/sqllab/execute/`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json', 'X-CSRFToken': csrf },
    body: JSON.stringify({
      database_id: PANTHEON_DATABASE_ID, sql, runAsync: false, json: true,
      tab: 'Sidekick eligibility', queryLimit: 10000,
    }),
  }))) as { status?: string; data?: Record<string, unknown>[]; query?: { resultsKey?: string } };

  if (Array.isArray(exec?.data)) return exec.data;
  const key = exec?.query?.resultsKey;
  if (!key) throw new Error('Preset returned neither rows nor a results key.');

  for (let i = 0; i < 60; i++) {
    await sleep(2000);
    const q = encodeURIComponent(`(key:'${key}')`);
    const res = await fetchImpl(`${PRESET_BASE}/api/v1/sqllab/results/?q=${q}`, { credentials: 'include' });
    if (res.status === 410 || res.status === 404) continue;
    const body = (await readJson(res)) as { status?: string; data?: Record<string, unknown>[] };
    if (Array.isArray(body?.data)) return body.data;
    if (body?.status === 'failed') throw engineError(body, 200);
  }
  throw new Error('Preset query did not finish within 2 minutes.');
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
