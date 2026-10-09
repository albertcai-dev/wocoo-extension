# Fetch W# Wire Send Monitoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Sidekick Home → Tools tile that turns a returned wire's `txdetail_rmtinfo_ustrd` (or bare REF) into a copy-pastable W#.

**Architecture:** Parse the REF → query Preset dataset 62667 ("ALL wire sends created") through `/api/v1/chart/data` from a hidden Preset tab, filtered on `e2e_identifier` → take the single row's `source_id` → Atlas GraphQL `getAccountDetails` → W#. The hidden-tab lifecycle in `presetSql.ts` is extracted into a shared `withPresetTab` helper so both Preset callers use one copy.

**Tech Stack:** Chrome MV3 extension, React 18 + TypeScript, Vite, vitest 2. All commands run from `extension/`.

**Spec:** `docs/superpowers/specs/2026-10-09-fetch-w-wire-send-monitoring-design.md`

## Global Constraints

- Tile title, exactly: `Fetch W# Wire Send Monitoring`. Position: Home → Tools, after **Wires Pending Posting**, before **Mobile Cheque Validation**.
- Preset base `https://8a26d867.wealthsimple-aws-mpc.app.preset.io` (`PRESET_BASE` in `presetSql.ts`); dataset id `62667`; filter column `e2e_identifier`; **no** time filter; `row_limit: 10`.
- REF format: exactly 16 chars `[A-Z0-9]`.
- The REF is only ever sent as a JSON filter value, never interpolated into SQL.
- Page functions passed to `chrome.scripting.executeScript` must be self-contained (no imports or module constants referenced inside).
- No writes to any sheet. One wire at a time.
- `runPresetSql`'s existing tests in `src/data/presetSql.test.ts` must pass unmodified.
- Baseline before Task 2: `npx vitest run` → 519 passed.

## Review Focus

- A cell copied from Google Sheets arrives wrapped in quotes with embedded newlines → the REF must still be extracted (test in Task 3).
- Pasted text that has a 16-char token but no `REF` (wrong column pasted) → "Couldn't find a REF", never a lookup on a random token (test in Task 3).
- The matched wire send has an empty `source_id` → a clear message, and Atlas is not called (test in Task 6).
- Pressing Fetch again while a fetch is running → no second hidden Preset tab (guard + manual check in Task 7).
- Editing the input after a result → the old W# disappears, so a W# for the previous wire can't be pasted against a new one (manual check in Task 7).

---

### Task 1: Live spike — chart-data endpoint from a Preset page

No code. Confirms the one unverified assumption in the spec before anything is built.

**Files:**
- Modify: `docs/superpowers/specs/2026-10-09-fetch-w-wire-send-monitoring-design.md` (append a "Spike result" section)

- [ ] **Step 1: User runs the request in a Preset tab**

Ask the user to open `https://8a26d867.wealthsimple-aws-mpc.app.preset.io/api/v1/security/csrf_token/` in Chrome (this is the exact page the hidden tab loads), open DevTools → Console, and paste:

```js
(async () => {
  const base = location.origin;
  const tok = (await (await fetch(`${base}/api/v1/security/csrf_token/`, { credentials: 'include' })).json()).result;
  const res = await fetch(`${base}/api/v1/chart/data`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json', 'X-CSRFToken': tok },
    body: JSON.stringify({
      datasource: { id: 62667, type: 'table' },
      force: false,
      result_format: 'json',
      result_type: 'full',
      queries: [{
        columns: ['source_id', 'actor_identity_id', 'FI canonical id', 'requested_amount_value', 'currency', 'created_at', 'Wire Send status'],
        filters: [{ col: 'e2e_identifier', op: '==', val: 'AVJJXHZEBVIA53DF' }],
        time_range: 'No filter',
        row_limit: 10,
        orderby: [['created_at', false]],
      }],
    }),
  });
  const body = await res.json();
  console.log(res.status, JSON.stringify(body.result?.[0]?.data ?? body, null, 2));
})();
```

Expected: `200` and one row with `source_id: "ca-cash-msb-icIMc1DLuA"`. Ask the user to paste back the status and the shape of the row, with the identity id redacted — only the keys, the `source_id`, and the type of `created_at` (number vs string) matter.

- [ ] **Step 2: Decide**

- `200` + one row → continue with Task 2 as written.
- `202` with a `result_url` → continue; Task 4's polling branch covers it.
- `403`/`400` mentioning permissions, or any other failure → STOP. Report to the user; the fallback is spec approach B (hand-written SQL via `runPresetSql`), which needs a spec update before any further task.

- [ ] **Step 3: Record the result in the spec and commit**

Append to the spec:

```markdown
## Spike result (2026-10-09)

`POST /api/v1/chart/data` from a page on the Preset origin: HTTP <status>. Row keys:
<keys>. `created_at` arrives as <number (epoch ms) | string>. `source_id` for
AVJJXHZEBVIA53DF = ca-cash-msb-icIMc1DLuA.
```

```bash
git add ../docs/superpowers/specs/2026-10-09-fetch-w-wire-send-monitoring-design.md
git commit -m "Spec: record chart-data spike result

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Extract the hidden-tab lifecycle into `withPresetTab`

Pure refactor plus two small tests for the new helper. `runPresetSql` behaviour is unchanged.

**Files:**
- Modify: `src/data/presetSql.ts:83-163` (deps interface, `chromeDeps`, `runInTab`, `runPresetSql`)
- Test: `src/data/presetSql.test.ts` (append a `describe('withPresetTab')` block; existing blocks untouched)

**Interfaces:**
- Produces:
  - `export interface PresetTabDeps { createTab(url: string): Promise<number>; waitForComplete(tabId: number): Promise<void>; getTabUrl(tabId: number): Promise<string>; removeTab(tabId: number): Promise<void>; }`
  - `export interface PresetSqlDeps extends PresetTabDeps { executeScript(tabId: number, args: [string, number, string]): Promise<PageSqlResult | undefined>; }` (same shape as today)
  - `export const chromeTabDeps: PresetTabDeps`
  - `export function withPresetTab<T>(deps: PresetTabDeps, body: (tabId: number) => Promise<T>): Promise<T>` — opens the tab on `${PRESET_BASE}/api/v1/security/csrf_token/`, waits, throws `PresetAuthError('Not signed in to Preset.')` if the tab is off the Preset origin, runs `body`, always closes the tab, rejects with `Error('Preset query timed out.')` after 150 s.
  - `export function rowsOrThrow(result: PageSqlResult | undefined): Record<string, unknown>[]`

- [ ] **Step 1: Write the failing tests**

Append to `src/data/presetSql.test.ts`, and add `withPresetTab, rowsOrThrow, type PresetTabDeps` to the existing import from `./presetSql`:

```ts
describe('withPresetTab', () => {
  function tabDeps(over: Partial<PresetTabDeps> = {}) {
    const removed: number[] = [];
    const deps: PresetTabDeps = {
      createTab: async () => 9,
      waitForComplete: async () => {},
      getTabUrl: async () => `${PRESET_BASE}/api/v1/security/csrf_token/`,
      removeTab: async (id) => { removed.push(id); },
      ...over,
    };
    return { deps, removed };
  }

  it('runs the body with the tab id and closes the tab', async () => {
    const { deps, removed } = tabDeps();
    expect(await withPresetTab(deps, async (id) => `ran in ${id}`)).toBe('ran in 9');
    expect(removed).toEqual([9]);
  });

  it('does not run the body when the tab is off Preset', async () => {
    const { deps, removed } = tabDeps({ getTabUrl: async () => 'https://login.okta.com/' });
    let ran = false;
    await expect(withPresetTab(deps, async () => { ran = true; })).rejects.toBeInstanceOf(PresetAuthError);
    expect(ran).toBe(false);
    expect(removed).toEqual([9]);
  });

  it('closes the tab when the body throws', async () => {
    const { deps, removed } = tabDeps();
    await expect(withPresetTab(deps, async () => { throw new Error('body failed'); })).rejects.toThrow('body failed');
    expect(removed).toEqual([9]);
  });
});

describe('rowsOrThrow', () => {
  it('returns rows', () => {
    expect(rowsOrThrow({ kind: 'rows', rows: [{ a: 1 }] })).toEqual([{ a: 1 }]);
  });
  it('throws PresetAuthError on auth', () => {
    expect(() => rowsOrThrow({ kind: 'auth' })).toThrow(PresetAuthError);
  });
  it('throws the message on error, and on a missing result', () => {
    expect(() => rowsOrThrow({ kind: 'error', message: 'bad' })).toThrow('bad');
    expect(() => rowsOrThrow(undefined)).toThrow('Preset tab returned no result.');
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/data/presetSql.test.ts`
Expected: FAIL — `withPresetTab` / `rowsOrThrow` are not exported.

- [ ] **Step 3: Implement**

In `src/data/presetSql.ts`, replace everything from the `/** Chrome calls behind runPresetSql…` comment through the end of `runPresetSql` with:

```ts
/** Chrome tab calls behind every hidden-Preset-tab request, injectable for tests. */
export interface PresetTabDeps {
  /** Opens a background tab on `url`; resolves to its id. */
  createTab: (url: string) => Promise<number>;
  /** Resolves once the tab has finished loading (rejects after a timeout). */
  waitForComplete: (tabId: number) => Promise<void>;
  /** The tab's current URL (after any redirects). */
  getTabUrl: (tabId: number) => Promise<string>;
  removeTab: (tabId: number) => Promise<void>;
}

/** Chrome calls behind runPresetSql, injectable for tests. */
export interface PresetSqlDeps extends PresetTabDeps {
  /** Runs pageRunSql in the tab's page and returns its result. */
  executeScript: (tabId: number, args: [string, number, string]) => Promise<PageSqlResult | undefined>;
}

const TAB_LOAD_TIMEOUT_MS = 30_000;
const OVERALL_TIMEOUT_MS = 150_000;

export const chromeTabDeps: PresetTabDeps = {
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
  removeTab: (tabId) => chrome.tabs.remove(tabId),
};

const chromeDeps: PresetSqlDeps = {
  ...chromeTabDeps,
  executeScript: async (tabId, args) => {
    const results = await chrome.scripting.executeScript({
      target: { tabId }, world: 'MAIN', func: pageRunSql, args,
    });
    return results?.[0]?.result as PageSqlResult | undefined;
  },
};

/** A page function's result → rows, or the matching error. */
export function rowsOrThrow(result: PageSqlResult | undefined): Record<string, unknown>[] {
  if (!result) throw new Error('Preset tab returned no result.');
  if (result.kind === 'rows') return result.rows;
  if (result.kind === 'auth') throw new PresetAuthError('Not signed in to Preset.');
  throw new Error(result.message);
}

/**
 * Opens a hidden tab on the Preset origin, runs `body` with its id, and always closes it.
 * The tab loads the tiny csrf_token JSON endpoint, so requests made inside it carry a
 * same-origin Referer and the user's session cookies.
 */
export async function withPresetTab<T>(deps: PresetTabDeps, body: (tabId: number) => Promise<T>): Promise<T> {
  const tab: { id: number | null } = { id: null };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Preset query timed out.')), OVERALL_TIMEOUT_MS);
  });
  const run = async (): Promise<T> => {
    tab.id = await deps.createTab(`${PRESET_BASE}/api/v1/security/csrf_token/`);
    await deps.waitForComplete(tab.id);
    const url = await deps.getTabUrl(tab.id);
    let sameOrigin = false;
    try { sameOrigin = new URL(url).origin === new URL(PRESET_BASE).origin; } catch { sameOrigin = false; }
    if (!sameOrigin) throw new PresetAuthError('Not signed in to Preset.');
    return body(tab.id);
  };
  try {
    return await Promise.race([run(), timeout]);
  } finally {
    clearTimeout(timer);
    if (tab.id != null) {
      try { await deps.removeTab(tab.id); } catch { /* tab may already be closed */ }
    }
  }
}

export async function runPresetSql(
  sql: string,
  deps: PresetSqlDeps = chromeDeps,
): Promise<Record<string, unknown>[]> {
  return withPresetTab(deps, async (tabId) =>
    rowsOrThrow(await deps.executeScript(tabId, [PRESET_BASE, PANTHEON_DATABASE_ID, sql])));
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/data/presetSql.test.ts` → PASS (old `runPresetSql` tests included, unmodified).
Run: `npx vitest run` → all pass (519 + 6 new).

- [ ] **Step 5: Commit**

```bash
git add src/data/presetSql.ts src/data/presetSql.test.ts
git commit -m "Extract the hidden Preset tab lifecycle into withPresetTab

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `parseWireRef`

**Files:**
- Create: `src/data/wireRef.ts`
- Test: `src/data/wireRef.test.ts`

**Interfaces:**
- Produces: `export function parseWireRef(input: string): string | null` — the uppercase 16-char REF, or null.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { parseWireRef } from './wireRef';

const CELL = '/BNF/RETURN WIRE DATED 10 07 26 //REF AVJJXHZEBVIA53DF CAD56,295.89//. //LESS CHGS AS //8 00362 LESS CHG';

describe('parseWireRef', () => {
  it('pulls the REF out of a full txdetail_rmtinfo_ustrd cell', () => {
    expect(parseWireRef(CELL)).toBe('AVJJXHZEBVIA53DF');
  });
  it('accepts a bare ref, trimmed', () => {
    expect(parseWireRef('  AVJJXHZEBVIA53DF \n')).toBe('AVJJXHZEBVIA53DF');
  });
  it('uppercases lowercase input', () => {
    expect(parseWireRef('avjjxhzebvia53df')).toBe('AVJJXHZEBVIA53DF');
    expect(parseWireRef('//ref avjjxhzebvia53df cad1')).toBe('AVJJXHZEBVIA53DF');
  });
  it('accepts REF with no space, a colon, or a slash before the token', () => {
    expect(parseWireRef('//REFAVJJXHZEBVIA53DF CAD')).toBe('AVJJXHZEBVIA53DF');
    expect(parseWireRef('REF: AVJJXHZEBVIA53DF')).toBe('AVJJXHZEBVIA53DF');
    expect(parseWireRef('REF/AVJJXHZEBVIA53DF')).toBe('AVJJXHZEBVIA53DF');
  });
  it('handles a Sheets cell copied with surrounding quotes and line breaks', () => {
    expect(parseWireRef(`"/BNF/RETURN WIRE DATED 10 07 26\n//REF AVJJXHZEBVIA53DF\nCAD56,295.89"`)).toBe('AVJJXHZEBVIA53DF');
  });
  it('rejects a 16-char token with no REF in longer text (wrong column pasted)', () => {
    expect(parseWireRef('PAYMENT AVJJXHZEBVIA53DF THANKS')).toBeNull();
  });
  it('rejects tokens that are not exactly 16 chars', () => {
    expect(parseWireRef('AVJJXHZEBVIA53D')).toBeNull();
    expect(parseWireRef('//REF AVJJXHZEBVIA53DFX CAD')).toBeNull();
  });
  it('rejects junk and empty input', () => {
    expect(parseWireRef('')).toBeNull();
    expect(parseWireRef('hello')).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/data/wireRef.test.ts`
Expected: FAIL — cannot resolve `./wireRef`.

- [ ] **Step 3: Implement**

`src/data/wireRef.ts`:

```ts
// The original wire send's reference, as RBC prints it in a returned wire's
// txdetail_rmtinfo_ustrd (e.g. "…//REF AVJJXHZEBVIA53DF CAD56,295.89//…"). It equals the
// send's e2e_identifier in Preset's "ALL wire sends created" table.

const REF_IN_TEXT = /\bREF[\s/:]*([A-Z0-9]{16})(?![A-Z0-9])/;
const BARE_REF = /^[A-Z0-9]{16}$/;

/** The 16-char REF from a pasted cell or a bare ref, uppercased; null if there isn't one. */
export function parseWireRef(input: string): string | null {
  const text = input.toUpperCase().replace(/\s+/g, ' ').trim().replace(/^"+|"+$/g, '').trim();
  const m = REF_IN_TEXT.exec(text);
  if (m) return m[1];
  return BARE_REF.test(text) ? text : null;
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/data/wireRef.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/data/wireRef.ts src/data/wireRef.test.ts
git commit -m "Parse the wire send REF from a returned wire's remittance text

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Preset chart-data lookup — `fetchWireSendsByRef`

**Files:**
- Create: `src/data/presetChartData.ts`
- Test: `src/data/presetChartData.test.ts`

**Interfaces:**
- Consumes: `withPresetTab`, `chromeTabDeps`, `rowsOrThrow`, `PresetTabDeps`, `PageSqlResult`, `PRESET_BASE` from `./presetSql` (Task 2).
- Produces:
  - `export const WIRE_SENDS_DATASET_ID = 62667`
  - `export interface WireSendRow { sourceId: string; identityId: string; fundingIntentId: string; amount: string; currency: string; createdAt: string; status: string }`
  - `export function pageFetchWireSends(base: string, datasetId: number, ref: string, fetchImpl?, sleep?): Promise<PageSqlResult>`
  - `export function toWireSendRows(rows: Record<string, unknown>[]): WireSendRow[]`
  - `export interface WireSendDeps extends PresetTabDeps { executeScript(tabId: number, args: [string, number, string]): Promise<PageSqlResult | undefined> }`
  - `export function fetchWireSendsByRef(ref: string, deps?: WireSendDeps): Promise<WireSendRow[]>`

- [ ] **Step 1: Write the failing tests**

```ts
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

  it('returns auth on 401/403', async () => {
    expect(await pageFetchWireSends('https://p', 1, 'R', async () => json({}, 401), noSleep)).toEqual({ kind: 'auth' });
    const fake = async (url: string) => (url.endsWith('/csrf_token/') ? json({ result: 'tok' }) : json({}, 403));
    expect(await pageFetchWireSends('https://p', 1, 'R', fake, noSleep)).toEqual({ kind: 'auth' });
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
```

Note: `1791338335000` is `2026-10-07T01:58:55Z`. If Task 1 recorded `created_at` as a string, the first `toWireSendRows` test still pins the number path — keep both.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/data/presetChartData.test.ts`
Expected: FAIL — cannot resolve `./presetChartData`.

- [ ] **Step 3: Implement**

`src/data/presetChartData.ts`:

```ts
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
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/data/presetChartData.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/data/presetChartData.ts src/data/presetChartData.test.ts
git commit -m "Look up wire sends by e2e_identifier via Preset chart data

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Atlas custodian account reader — `readCustodianAccountNumber`

The recorded `getAccountDetails` response has a `C…CAD` custodian sibling next to the `W…CAD` W# (see `ACCOUNT_DETAILS_RES` in `atlasGraphql.test.ts`, and `C13BVPP28CAD` next to `WK5LGP131CAD` in the user's example). So the non-CAD fallback accepts only W-prefixed ids — returning a `C…` id would hand the user a wrong number. This tightens the spec's "first custodian id of any shape"; update the spec line in this task.

**Files:**
- Modify: `src/data/atlasGraphql.ts` (add after `readSpendCustodianAccountNumber`, ~line 120)
- Test: `src/data/atlasGraphql.test.ts` (append; add the two names to the existing import)
- Modify: `docs/superpowers/specs/2026-10-09-fetch-w-wire-send-monitoring-design.md` (Flow step 3)

**Interfaces:**
- Produces:
  - `export interface CustodianAccount { accountNumber: string; isCadSpend: boolean }`
  - `export function readCustodianAccountNumber(res: unknown): CustodianAccount | null`
  - `export async function fetchCustodianAccountNumber(accountId: string): Promise<CustodianAccount | null>` — throws whatever `atlasGraphql` throws.

- [ ] **Step 1: Write the failing tests**

```ts
describe('readCustodianAccountNumber', () => {
  const res = (ids: string[]) => ({ data: { account: { custodianAccounts: ids.map((custodianAccountId) => ({ custodianAccountId })) } } });

  it('prefers the W…CAD account over its C…CAD sibling', () => {
    expect(readCustodianAccountNumber(res(['C13BVPP28CAD', 'WK5LGP131CAD']))).toEqual({ accountNumber: 'WK5LGP131CAD', isCadSpend: true });
  });
  it('falls back to a W-prefixed non-CAD account, flagged', () => {
    expect(readCustodianAccountNumber(res(['C13BVPP28USD', 'wk5lgp131usd']))).toEqual({ accountNumber: 'WK5LGP131USD', isCadSpend: false });
  });
  it('never returns a C… custodian id', () => {
    expect(readCustodianAccountNumber(res(['C13BVPP28CAD']))).toBeNull();
  });
  it('returns null on an empty list or unknown shape', () => {
    expect(readCustodianAccountNumber(res([]))).toBeNull();
    expect(readCustodianAccountNumber({ data: {} })).toBeNull();
  });
});

describe('fetchCustodianAccountNumber', () => {
  it('asks getAccountDetails on the wealthsimple service for the source account', async () => {
    const spy = stubFetch(() => ok({ data: { account: { custodianAccounts: [{ custodianAccountId: 'WK5LGP131CAD' }] } } }));
    expect(await fetchCustodianAccountNumber('ca-cash-msb-icIMc1DLuA')).toEqual({ accountNumber: 'WK5LGP131CAD', isCadSpend: true });
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://cs-tools-satori.wealthsimple.com/api/atlas/graphql/wealthsimple');
    expect(JSON.parse(init.body as string)).toMatchObject({ operationName: 'getAccountDetails', variables: { id: 'ca-cash-msb-icIMc1DLuA' } });
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/data/atlasGraphql.test.ts`
Expected: FAIL — `readCustodianAccountNumber` is not exported.

- [ ] **Step 3: Implement**

In `src/data/atlasGraphql.ts`, directly after `readSpendCustodianAccountNumber`:

```ts
export interface CustodianAccount {
  accountNumber: string;
  /** False when the account is a W# but not W…CAD (e.g. USD) — the UI warns. */
  isCadSpend: boolean;
}

const W_ACCOUNT_RE = /^W[A-Z0-9]+$/i;

/**
 * `getAccountDetails` → the account's W#, for any cash account (not just the client's
 * spend account). Prefers W…CAD; otherwise any W-prefixed id, flagged. Never a C… id:
 * that is the custodian sibling, not the client's account number.
 */
export function readCustodianAccountNumber(res: unknown): CustodianAccount | null {
  const custodians = asRecord(asRecord(asRecord(res)?.data)?.account)?.custodianAccounts;
  if (!Array.isArray(custodians)) return null;
  const ids = custodians
    .map((c) => asRecord(c)?.custodianAccountId)
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
    .map((id) => id.toUpperCase());
  const cad = ids.find((id) => SPEND_ACCOUNT_RE.test(id));
  if (cad) return { accountNumber: cad, isCadSpend: true };
  const other = ids.find((id) => W_ACCOUNT_RE.test(id));
  return other ? { accountNumber: other, isCadSpend: false } : null;
}

/** An account canonical id (e.g. a wire send's `source_id`, `ca-cash-msb-…`) → its W#. */
export async function fetchCustodianAccountNumber(accountId: string): Promise<CustodianAccount | null> {
  const res = await atlasGraphql('wealthsimple', 'getAccountDetails', GET_ACCOUNT_DETAILS_QUERY, { id: accountId });
  return readCustodianAccountNumber(res);
}
```

In the spec, replace the sentence in Flow step 3 beginning "New reader `readCustodianAccountNumber(res)` returns" with:

```markdown
   New reader `readCustodianAccountNumber(res)` returns `{ accountNumber, isCadSpend }`: the
   first `W…CAD` custodian id if any (`isCadSpend: true`), otherwise the first W-prefixed id
   (`isCadSpend: false`), otherwise `null`. It never returns a `C…` id — that is the custodian
   sibling listed next to the W# (e.g. `C13BVPP28CAD` beside `WK5LGP131CAD`), not the
   client's account number.
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/data/atlasGraphql.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/data/atlasGraphql.ts src/data/atlasGraphql.test.ts ../docs/superpowers/specs/2026-10-09-fetch-w-wire-send-monitoring-design.md
git commit -m "Read a W# from any Atlas cash account, never the C… sibling

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Orchestrator — `fetchWireSendW`

**Files:**
- Create: `src/data/wireSendW.ts`
- Test: `src/data/wireSendW.test.ts`

**Interfaces:**
- Consumes: `parseWireRef` (Task 3); `fetchWireSendsByRef`, `WireSendRow` (Task 4); `fetchCustodianAccountNumber`, `CustodianAccount` (Task 5).
- Produces:
  - ```ts
    export type WireSendWResult =
      | { kind: 'no_ref' }
      | { kind: 'none'; ref: string }
      | { kind: 'multiple'; ref: string; rows: WireSendRow[] }
      | { kind: 'found'; ref: string; row: WireSendRow; account: CustodianAccount }
      | { kind: 'no_account'; ref: string; row: WireSendRow; reason: string };
    ```
  - `export interface WireSendWDeps { fetchRows(ref: string): Promise<WireSendRow[]>; fetchAccount(accountId: string): Promise<CustodianAccount | null> }`
  - `export function fetchWireSendW(input: string, deps?: WireSendWDeps): Promise<WireSendWResult>` — Preset errors (incl. `PresetAuthError`) propagate; Atlas errors become `no_account`.
  - `export function atlasTransferUrl(row: WireSendRow): string`

- [ ] **Step 1: Write the failing tests**

```ts
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
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/data/wireSendW.test.ts`
Expected: FAIL — cannot resolve `./wireSendW`.

- [ ] **Step 3: Implement**

`src/data/wireSendW.ts`:

```ts
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

export function atlasTransferUrl(row: WireSendRow): string {
  return `https://atlas.wealthsimple.com/identity/${row.identityId}/transfers/${row.fundingIntentId}`;
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/data/wireSendW.test.ts` → PASS. Then `npx vitest run` → all pass.

- [ ] **Step 5: Commit**

```bash
git add src/data/wireSendW.ts src/data/wireSendW.test.ts
git commit -m "Chain REF → wire send → Atlas W# for returned wires

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: The Home tile

No component test harness exists in this repo (no `*.test.tsx`); the tile is verified by `tsc` via the build and a live run.

**Files:**
- Modify: `src/sidepanel/toolUi.tsx` (add `CopyButton`, moved from `SidePanel.tsx`)
- Modify: `src/sidepanel/SidePanel.tsx:768,775,793-815` (use `CopyButton` from toolUi; delete `CapturedCopyButton`)
- Create: `src/sidepanel/FetchWireSendW.tsx`
- Modify: `src/sidepanel/HomeView.tsx:6,255-262` (import + place the tile)

**Interfaces:**
- Consumes: `fetchWireSendW`, `atlasTransferUrl`, `WireSendWResult` (Task 6); `PresetAuthError` (`presetSql.ts`); `Pill`, `primaryButton`, `errorBanner`, `listItemStyle` (`toolUi.tsx`).
- Produces: `export function FetchWireSendWTile(): JSX.Element`; `export function CopyButton({ value }: { value: string })` in `toolUi.tsx`.

- [ ] **Step 1: Move the copy button into toolUi**

At the top of `src/sidepanel/toolUi.tsx`, add `import { useState } from 'react';` and append the component, renamed from `CapturedCopyButton` with its body unchanged:

```tsx
/** Pill Copy button used on captured-value cards; each instance keeps its own Copied state. */
export function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(value).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1500); });
      }}
      disabled={copied}
      style={{
        padding: '4px 10px',
        background: copied ? 'var(--mint-positive-fg-graphic)' : 'var(--mint-bg-card)',
        color: copied ? '#fff' : 'var(--mint-positive-fg-strong)',
        border: '1px solid var(--mint-positive-fg-graphic)',
        borderRadius: 'var(--mint-radius-pill)',
        fontSize: 'var(--mint-text-nano)',
        fontWeight: 700,
        cursor: copied ? 'default' : 'pointer',
        flexShrink: 0,
      }}
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}
```

In `src/sidepanel/SidePanel.tsx`: delete the `CapturedCopyButton` function and its doc comment, replace both `<CapturedCopyButton value=…/>` usages with `<CopyButton value=…/>`, and add `import { CopyButton } from './toolUi';` with the other `./` imports.

- [ ] **Step 2: Create the tile**

`src/sidepanel/FetchWireSendW.tsx`:

```tsx
// Fetch W# Wire Send Monitoring — Home view tool.
//
// For RBC incoming-wire tracker rows with no receiver external account: paste the
// returned wire's txdetail_rmtinfo_ustrd (or just its REF) and get the W# of the account
// the original wire was sent from. Preset runs in a hidden tab; Atlas is GraphQL.
// Read-only — nothing is written to the tracker.

import { useState } from 'react';
import { PresetAuthError } from '../data/presetSql';
import { atlasTransferUrl, fetchWireSendW, type WireSendWResult } from '../data/wireSendW';
import type { WireSendRow } from '../data/presetChartData';
import { CopyButton, errorBanner, listItemStyle, Pill, primaryButton } from './toolUi';

const label: React.CSSProperties = { color: 'var(--mint-positive-fg-strong)', fontWeight: 700, flexShrink: 0 };
const mono: React.CSSProperties = { fontFamily: 'var(--mint-font-mono)', color: 'var(--mint-fg-strong)', overflowWrap: 'anywhere' };

export function FetchWireSendWTile() {
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<WireSendWResult | null>(null);
  const [error, setError] = useState('');

  async function onFetch() {
    if (busy) return; // one hidden Preset tab at a time
    setBusy(true); setError(''); setResult(null);
    try {
      setResult(await fetchWireSendW(input));
    } catch (e) {
      setError(e instanceof PresetAuthError ? 'Sign in to Preset, then press Fetch again.' : (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 8, padding: 'var(--mint-sp-3)',
      background: 'var(--mint-bg-card)', border: 'var(--mint-card-stroke)', borderRadius: 'var(--mint-radius-card)',
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <span style={{ fontSize: 22, lineHeight: 1 }}>🔎</span>
        <span style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
          <span style={{ fontSize: 'var(--mint-text-meta)', fontWeight: 700, color: 'var(--mint-fg-strong)' }}>Fetch W# Wire Send Monitoring</span>
          <span style={{ fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-soft)', lineHeight: 1.45 }}>
            For a returned wire with no receiver account: paste txdetail_rmtinfo_ustrd (or the REF) to get the W# it was sent from.
          </span>
        </span>
      </div>
      <textarea
        value={input}
        onChange={(e) => { setInput(e.target.value); setResult(null); setError(''); }}
        placeholder="Paste txdetail_rmtinfo_ustrd or the REF"
        rows={3}
        style={{ width: '100%', boxSizing: 'border-box', fontFamily: 'var(--mint-font-mono)', fontSize: 'var(--mint-text-nano)', padding: 8, borderRadius: 'var(--mint-radius-button)', border: 'var(--mint-card-stroke)', resize: 'vertical' }}
      />
      <button onClick={onFetch} disabled={busy || !input.trim()} style={{ ...primaryButton, padding: '8px 12px', opacity: busy || !input.trim() ? 0.6 : 1, cursor: busy ? 'wait' : 'pointer' }}>
        {busy ? 'Fetching…' : 'Fetch W#'}
      </button>
      {error ? <div style={errorBanner}>{error}</div> : null}
      {result ? <ResultView result={result} /> : null}
    </div>
  );
}

function ResultView({ result }: { result: WireSendWResult }) {
  switch (result.kind) {
    case 'no_ref':
      return <div style={errorBanner}>Couldn't find a REF in that text.</div>;
    case 'none':
      return <div style={errorBanner}>No wire send with e2e_identifier {result.ref} — this may not be a returned send.</div>;
    case 'multiple':
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={errorBanner}>{result.rows.length} wire sends match {result.ref} — check which one in Atlas.</div>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
            {result.rows.map((row, i) => (
              <li key={i} style={{ ...listItemStyle, flexDirection: 'column', fontSize: 'var(--mint-text-nano)' }}>
                <RowContext row={row} />
              </li>
            ))}
          </ul>
        </div>
      );
    case 'no_account':
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={errorBanner}>{result.reason}</div>
          <div style={{ ...listItemStyle, flexDirection: 'column', fontSize: 'var(--mint-text-nano)' }}><RowContext row={result.row} /></div>
        </div>
      );
    case 'found':
      return (
        <div style={{ padding: '6px 10px', background: 'var(--mint-positive-bg-soft)', border: '1px solid var(--mint-positive-fg-graphic)', borderRadius: 'var(--mint-radius-button)', display: 'flex', flexDirection: 'column', gap: 4, fontSize: 'var(--mint-text-micro)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={label}>W#:</span>
            <span style={{ ...mono, flex: 1, userSelect: 'all' }}>{result.account.accountNumber}</span>
            <CopyButton value={result.account.accountNumber} />
          </div>
          {!result.account.isCadSpend ? (
            <div><Pill tone="warning" wrap label="Not a CAD chequing account — check before pasting." /></div>
          ) : null}
          <RowContext row={result.row} />
        </div>
      );
  }
}

function RowContext({ row }: { row: WireSendRow }) {
  const line = (k: string, v: string) => (
    <div style={{ display: 'flex', gap: 8 }}>
      <span style={{ color: 'var(--mint-fg-soft)', flexShrink: 0 }}>{k}</span>
      <span style={mono}>{v || '—'}</span>
    </div>
  );
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 'var(--mint-text-nano)' }}>
      {line('Identity', row.identityId)}
      {line('Amount', [row.amount, row.currency].filter(Boolean).join(' '))}
      {line('Sent', row.createdAt)}
      {line('Source', row.sourceId)}
      {row.identityId && row.fundingIntentId ? (
        <a href={atlasTransferUrl(row)} target="_blank" rel="noreferrer" style={{ color: 'var(--mint-highlight-fg-strong)', fontWeight: 700 }}>↗ Atlas</a>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 3: Place it on Home**

In `src/sidepanel/HomeView.tsx`, add `import { FetchWireSendWTile } from './FetchWireSendW';` next to the `MobileChequeValidationTile` import, and insert `<FetchWireSendWTile />` on the line between the Wires Pending Posting `<ToolTile … />` and `<MobileChequeValidationTile />`.

- [ ] **Step 4: Build and test**

Run: `npm run build` → exits 0 (tsc + vite).
Run: `npx vitest run` → all pass.

- [ ] **Step 5: Live check (user)**

Ask the user to reload the unpacked extension in `chrome://extensions`, open the side panel Home, and:

1. The tile sits between Wires Pending Posting and Mobile Cheque Validation.
2. Paste the full cell `/BNF/RETURN WIRE DATED 10 07 26 //REF AVJJXHZEBVIA53DF CAD56,295.89//. //LESS CHGS AS //8 00362 LESS CHG` → **Fetch W#** → W# `WK5LGP131CAD`, amount `56295.89 CAD`, source `ca-cash-msb-icIMc1DLuA`, and no warning pill. Copy pastes the W#.
3. While it's fetching, the button reads "Fetching…" and can't be pressed again; only one Preset tab flashes in the tab strip.
4. Edit the textarea after a result → the result card disappears.
5. Paste `hello` → "Couldn't find a REF in that text." and no Preset tab opens.
6. Optional: signed out of Preset → "Sign in to Preset, then press Fetch again."

- [ ] **Step 6: Commit**

```bash
git add src/sidepanel/FetchWireSendW.tsx src/sidepanel/HomeView.tsx src/sidepanel/toolUi.tsx src/sidepanel/SidePanel.tsx
git commit -m "Add the Fetch W# Wire Send Monitoring tile to Home → Tools

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
