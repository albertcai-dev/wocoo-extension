# WOCOO Analytics Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a team-visible Magic site showing WOCOO tickets completed per assignee over four calendar windows, with a per-assignee daily trend chart and an inline work-type drill-down.

**Architecture:** Pure ES modules in `~/projects/wocoo-analytics/src/`, unit-tested with Vitest, assembled by a build script into a single `dist/index.html` deployed to Magic. Jira is queried one calendar day at a time through `MagicTools.call('jira_search_tickets', …)`; the day is carried by the query because WOCOO exposes no readable per-ticket completion timestamp. Every board window is the union of its days, so a day-keyed cache makes narrower windows free.

**Tech Stack:** Vanilla ES modules, Vitest, React 18 + `@babel/standalone@7` from CDN, Tailwind v4 (auto-injected by Magic — never bundle it), MagicTools.

**Spec:** `docs/superpowers/specs/2026-08-03-wocoo-analytics-dashboard-design.md`

## Global Constraints

- Roster is exactly `['Albert Cai', 'Esther Liao', 'Ishan Jain', 'Luke Gazmin', 'JC Ulat']`.
- Non-roster assignees fold to `Other`; null/empty assignee becomes `Unassigned`. These are distinct rows.
- Outcome split: `status.name === 'Cancelled/ No Action'` → `cancelled`; anything else → `done`. Unrecognised names fall to `done` deliberately.
- Every JQL string MUST include `AND summary !~ "Eligibility Confirmation Request"`. This is the only thing excluding Workato automation tickets and its absence silently inflates roster counts by ~5/day.
- Never render `0` for a failed fetch. A failed day is `missing`, not zero.
- `max_results` for `jira_search_tickets` is capped at 100 by the tool.
- Tailwind v4 and Wealthsimple tokens are auto-injected by Magic. Do not add Tailwind to the bundle.
- Deployed file is a build artifact; editing it on Magic gets overwritten by the next build.
- Node 18+ (uses built-in `fetch`-free code only, but Vitest requires modern Node).

**Colour tokens** (from spec Findings §3 — greys authoritative, categorical sampled from a screenshot and numerically approximate):

```
strong-fg #32302F   soft-fg #615E5C   inactive-fg #94908D
app-bg #FCFCFC      default-bg #FFFFFF   soft-bg #F5F4F4
outline rgba(0,0,0,0.08)
categorical: #6E93E0 #B07FE8 #EE86CE #EBCB2E #38934F #F09340
```

---

### Task 1: Project scaffold and the `dates` module

**Files:**
- Create: `~/projects/wocoo-analytics/package.json`
- Create: `~/projects/wocoo-analytics/.gitignore`
- Create: `~/projects/wocoo-analytics/src/dates.js`
- Test: `~/projects/wocoo-analytics/test/dates.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `lastNDates(n: number, today: string) => string[]` (oldest → newest, length `n`, last element is `today`); `nextDate(date: string) => string`. Both take and return `'YYYY-MM-DD'`.

- [ ] **Step 1: Create the project and install Vitest**

```bash
mkdir -p ~/projects/wocoo-analytics/src ~/projects/wocoo-analytics/test
cd ~/projects/wocoo-analytics
git init
npm init -y
npm install --save-dev vitest
```

- [ ] **Step 2: Set the package to ESM and add scripts**

Replace `package.json` with:

```json
{
  "name": "wocoo-analytics",
  "version": "1.0.0",
  "type": "module",
  "private": true,
  "scripts": {
    "test": "vitest run",
    "build": "node build.js"
  },
  "devDependencies": {
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 3: Add `.gitignore`**

```
node_modules/
dist/
.DS_Store
```

- [ ] **Step 4: Write the failing test**

`test/dates.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { lastNDates, nextDate } from '../src/dates.js';

describe('nextDate', () => {
  it('advances one day', () => {
    expect(nextDate('2026-08-03')).toBe('2026-08-04');
  });

  it('crosses a month boundary', () => {
    expect(nextDate('2026-07-31')).toBe('2026-08-01');
  });

  it('crosses a year boundary', () => {
    expect(nextDate('2026-12-31')).toBe('2027-01-01');
  });

  it('handles a leap day', () => {
    expect(nextDate('2028-02-28')).toBe('2028-02-29');
  });

  // Toronto is UTC-4 in March. Naive local-time parsing would land on the wrong
  // day here; UTC arithmetic must not.
  it('is unaffected by a DST transition', () => {
    expect(nextDate('2026-03-08')).toBe('2026-03-09');
  });
});

describe('lastNDates', () => {
  it('returns exactly n dates', () => {
    expect(lastNDates(7, '2026-08-03')).toHaveLength(7);
  });

  it('ends on today and starts n-1 days earlier', () => {
    const result = lastNDates(7, '2026-08-03');
    expect(result[6]).toBe('2026-08-03');
    expect(result[0]).toBe('2026-07-28');
  });

  it('returns just today for n=1', () => {
    expect(lastNDates(1, '2026-08-03')).toEqual(['2026-08-03']);
  });

  it('is sorted oldest first', () => {
    const result = lastNDates(30, '2026-08-03');
    expect([...result].sort()).toEqual(result);
  });
});
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `cd ~/projects/wocoo-analytics && npm test`
Expected: FAIL — `Failed to resolve import "../src/dates.js"`

- [ ] **Step 6: Write the implementation**

`src/dates.js`:

```js
// Date helpers over 'YYYY-MM-DD' strings.
//
// All arithmetic goes through Date.UTC. Parsing 'YYYY-MM-DD' with `new Date(str)`
// yields UTC midnight, but reading it back with getFullYear/getMonth/getDate
// applies the local offset — west of Greenwich that reports the previous day.
// Staying in UTC for both ends sidesteps it entirely.

function toUTC(date) {
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function toISODate(ms) {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** The calendar day after `date`. */
export function nextDate(date) {
  return toISODate(toUTC(date) + DAY_MS);
}

/** The `n` calendar days ending at `today`, oldest first. */
export function lastNDates(n, today) {
  const end = toUTC(today);
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    out.push(toISODate(end - i * DAY_MS));
  }
  return out;
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — 9 tests.

- [ ] **Step 8: Commit**

```bash
cd ~/projects/wocoo-analytics
git add package.json package-lock.json .gitignore src/dates.js test/dates.test.js
git commit -m "Add date helpers over YYYY-MM-DD strings

All arithmetic is UTC-based. Parsing a bare date gives UTC midnight but
reading it back with local getters reports the previous day west of
Greenwich, so both ends stay in UTC."
```

---

### Task 2: The `aggregate` module

**Files:**
- Create: `~/projects/wocoo-analytics/src/aggregate.js`
- Test: `~/projects/wocoo-analytics/test/aggregate.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `ROSTER: string[]`
  - `assigneeKey(name: string|null) => string`
  - `outcomeOf(statusName: string) => 'done'|'cancelled'`
  - `rowsForDates(dayMap: Map<string, Row[]>, dates: string[]) => Row[]`
  - `totalsFor(rows: Row[]) => { done: number, cancelled: number }`
  - `byAssignee(rows: Row[]) => Array<{ key: string, done: number, cancelled: number }>` ranked by `done` desc, ties broken alphabetically
  - `byWorkType(rows: Row[], key: string|null) => Array<{ workType: string, done: number, cancelled: number }>` ranked by `done` desc; `key === null` means all rows
  - `dailySeries(dayMap, dates) => { dates: string[], series: Array<{ key: string, values: number[] }>, total: number[] }` — `values[i]` is the **done** count on `dates[i]`; a date absent from `dayMap` yields `null` at that index, not `0`

  `Row` is `{ assignee: string|null, workType: string, outcome: 'done'|'cancelled' }`.

- [ ] **Step 1: Write the failing test**

`test/aggregate.test.js`:

```js
import { describe, it, expect } from 'vitest';
import {
  assigneeKey, outcomeOf, rowsForDates, totalsFor,
  byAssignee, byWorkType, dailySeries,
} from '../src/aggregate.js';

const row = (assignee, workType, outcome = 'done') => ({ assignee, workType, outcome });

describe('assigneeKey', () => {
  it('keeps roster members', () => {
    expect(assigneeKey('Esther Liao')).toBe('Esther Liao');
  });
  it('folds non-roster humans to Other', () => {
    expect(assigneeKey('Anh Tran')).toBe('Other');
  });
  it('maps null to Unassigned', () => {
    expect(assigneeKey(null)).toBe('Unassigned');
  });
  it('maps empty string to Unassigned', () => {
    expect(assigneeKey('')).toBe('Unassigned');
  });
  it('keeps Other and Unassigned distinct', () => {
    expect(assigneeKey('Anh Tran')).not.toBe(assigneeKey(null));
  });
});

describe('outcomeOf', () => {
  it('recognises the cancelled status, including its internal space', () => {
    expect(outcomeOf('Cancelled/ No Action')).toBe('cancelled');
  });
  it('treats Done as done', () => {
    expect(outcomeOf('Done')).toBe('done');
  });
  // Deliberate default: an unrecognised status counts as work completed rather
  // than silently vanishing from every total.
  it('falls back to done for an unrecognised status', () => {
    expect(outcomeOf('Shipped To Vendor')).toBe('done');
  });
  it('tolerates surrounding whitespace', () => {
    expect(outcomeOf('  Cancelled/ No Action  ')).toBe('cancelled');
  });
});

describe('rowsForDates', () => {
  const dayMap = new Map([
    ['2026-08-01', [row('Albert Cai', 'A')]],
    ['2026-08-02', [row('Esther Liao', 'B')]],
    ['2026-08-03', [row('Albert Cai', 'C')]],
  ]);

  it('collects only the requested dates', () => {
    expect(rowsForDates(dayMap, ['2026-08-02', '2026-08-03'])).toHaveLength(2);
  });

  it('ignores dates absent from the map', () => {
    expect(rowsForDates(dayMap, ['2026-07-30'])).toEqual([]);
  });
});

describe('totalsFor', () => {
  it('counts done and cancelled separately', () => {
    const rows = [
      row('Albert Cai', 'A', 'done'),
      row('Albert Cai', 'A', 'cancelled'),
      row('Esther Liao', 'B', 'done'),
    ];
    expect(totalsFor(rows)).toEqual({ done: 2, cancelled: 1 });
  });

  it('returns zeroes for no rows', () => {
    expect(totalsFor([])).toEqual({ done: 0, cancelled: 0 });
  });
});

describe('byAssignee', () => {
  const rows = [
    row('Albert Cai', 'A'), row('Albert Cai', 'B'),
    row('Esther Liao', 'A'), row('Esther Liao', 'B'), row('Esther Liao', 'C'),
    row('Anh Tran', 'A'),
    row(null, 'A'),
    row('Albert Cai', 'A', 'cancelled'),
  ];

  it('ranks by done count, highest first', () => {
    expect(byAssignee(rows).map((r) => r.key)).toEqual(
      ['Esther Liao', 'Albert Cai', 'Other', 'Unassigned'],
    );
  });

  it('counts cancelled without letting it affect rank', () => {
    const albert = byAssignee(rows).find((r) => r.key === 'Albert Cai');
    expect(albert).toEqual({ key: 'Albert Cai', done: 2, cancelled: 1 });
  });

  it('reconciles: row totals equal the overall total', () => {
    const perRow = byAssignee(rows).reduce(
      (acc, r) => ({ done: acc.done + r.done, cancelled: acc.cancelled + r.cancelled }),
      { done: 0, cancelled: 0 },
    );
    expect(perRow).toEqual(totalsFor(rows));
  });

  it('omits roster members with no rows in the window', () => {
    expect(byAssignee(rows).map((r) => r.key)).not.toContain('Luke Gazmin');
  });
});

describe('byWorkType', () => {
  const rows = [
    row('Albert Cai', 'Credit Card: Overpayment'),
    row('Albert Cai', 'Credit Card: Overpayment'),
    row('Albert Cai', 'Wires Posting'),
    row('Esther Liao', 'Wires Posting'),
  ];

  it('filters to one assignee', () => {
    expect(byWorkType(rows, 'Albert Cai')).toEqual([
      { workType: 'Credit Card: Overpayment', done: 2, cancelled: 0 },
      { workType: 'Wires Posting', done: 1, cancelled: 0 },
    ]);
  });

  it('covers every row when the key is null', () => {
    const total = byWorkType(rows, null).reduce((n, r) => n + r.done, 0);
    expect(total).toBe(4);
  });
});

describe('dailySeries', () => {
  const dayMap = new Map([
    ['2026-08-01', [row('Albert Cai', 'A'), row('Esther Liao', 'A')]],
    ['2026-08-02', [row('Albert Cai', 'A', 'cancelled')]],
    ['2026-08-03', [row('Albert Cai', 'A')]],
  ]);
  const dates = ['2026-08-01', '2026-08-02', '2026-08-03'];

  it('emits one value per date per series', () => {
    const { series } = dailySeries(dayMap, dates);
    const albert = series.find((s) => s.key === 'Albert Cai');
    expect(albert.values).toEqual([1, 0, 1]);
  });

  it('counts only done in the series', () => {
    const { series } = dailySeries(dayMap, dates);
    expect(series.find((s) => s.key === 'Albert Cai').values[1]).toBe(0);
  });

  it('sums the total line across series', () => {
    expect(dailySeries(dayMap, dates).total).toEqual([2, 0, 1]);
  });

  // The critical one: a day we failed to fetch must not look like a quiet day.
  it('yields null, not zero, for a date missing from the map', () => {
    const { series, total } = dailySeries(dayMap, [...dates, '2026-08-04']);
    expect(series.find((s) => s.key === 'Albert Cai').values[3]).toBeNull();
    expect(total[3]).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `Failed to resolve import "../src/aggregate.js"`

- [ ] **Step 3: Write the implementation**

`src/aggregate.js`:

```js
// Pure aggregation over a day-keyed map of rows. No I/O, no dates arithmetic —
// the day is the map key, so there is nothing here to get wrong about timezones.

export const ROSTER = ['Albert Cai', 'Esther Liao', 'Ishan Jain', 'Luke Gazmin', 'JC Ulat'];

const UNASSIGNED = 'Unassigned';
const OTHER = 'Other';
const CANCELLED_STATUS = 'Cancelled/ No Action';

/** Roster members keep their name; everyone else folds to Other; nobody is Unassigned.
 *  Other and Unassigned stay distinct so it's visible whether work is going to
 *  untracked people or to nobody. */
export function assigneeKey(name) {
  const trimmed = (name || '').trim();
  if (!trimmed) return UNASSIGNED;
  return ROSTER.includes(trimmed) ? trimmed : OTHER;
}

/** Anything that isn't explicitly cancelled counts as done. Deliberate: an
 *  unrecognised status should inflate nothing but also vanish from nothing. */
export function outcomeOf(statusName) {
  return (statusName || '').trim() === CANCELLED_STATUS ? 'cancelled' : 'done';
}

export function rowsForDates(dayMap, dates) {
  const out = [];
  for (const date of dates) {
    const rows = dayMap.get(date);
    if (rows) out.push(...rows);
  }
  return out;
}

export function totalsFor(rows) {
  let done = 0;
  let cancelled = 0;
  for (const r of rows) {
    if (r.outcome === 'cancelled') cancelled++;
    else done++;
  }
  return { done, cancelled };
}

function rankByDone(entries) {
  return entries.sort((a, b) => b.done - a.done || a.__label.localeCompare(b.__label))
    .map(({ __label, ...rest }) => rest);
}

export function byAssignee(rows) {
  const acc = new Map();
  for (const r of rows) {
    const key = assigneeKey(r.assignee);
    if (!acc.has(key)) acc.set(key, { key, done: 0, cancelled: 0, __label: key });
    const entry = acc.get(key);
    if (r.outcome === 'cancelled') entry.cancelled++;
    else entry.done++;
  }
  return rankByDone([...acc.values()]);
}

export function byWorkType(rows, key) {
  const acc = new Map();
  for (const r of rows) {
    if (key !== null && assigneeKey(r.assignee) !== key) continue;
    const workType = r.workType || 'Unknown';
    if (!acc.has(workType)) {
      acc.set(workType, { workType, done: 0, cancelled: 0, __label: workType });
    }
    const entry = acc.get(workType);
    if (r.outcome === 'cancelled') entry.cancelled++;
    else entry.done++;
  }
  return rankByDone([...acc.values()]);
}

/** One line per assignee plus a total line. A date absent from the map is null,
 *  never 0 — a day we failed to fetch must not render as a quiet day. */
export function dailySeries(dayMap, dates) {
  const keys = new Set();
  for (const date of dates) {
    for (const r of dayMap.get(date) || []) keys.add(assigneeKey(r.assignee));
  }

  const series = [...keys].sort().map((key) => ({
    key,
    values: dates.map((date) => {
      const rows = dayMap.get(date);
      if (!rows) return null;
      return rows.filter((r) => assigneeKey(r.assignee) === key && r.outcome !== 'cancelled').length;
    }),
  }));

  const total = dates.map((date) => {
    const rows = dayMap.get(date);
    if (!rows) return null;
    return rows.filter((r) => r.outcome !== 'cancelled').length;
  });

  return { dates, series, total };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — all `dates` and `aggregate` tests.

- [ ] **Step 5: Commit**

```bash
git add src/aggregate.js test/aggregate.test.js
git commit -m "Add pure aggregation over the day-keyed row map

A date absent from the map yields null rather than 0 in the series, so a
day that failed to fetch cannot render as a quiet day."
```

---

### Task 3: The `jiraClient` module

**Files:**
- Create: `~/projects/wocoo-analytics/src/jiraClient.js`
- Test: `~/projects/wocoo-analytics/test/jiraClient.test.js`

**Interfaces:**
- Consumes: `nextDate` from `src/dates.js`.
- Produces:
  - `buildDayJql(date: string) => string`
  - `parseToolResult(result: object) => object` — unwraps the MCP `content[]` envelope
  - `createJiraClient(tools) => { fetchDay(date: string) => Promise<Row[]> }` where `tools` is an object with `.call(name, args)`, i.e. `window.MagicTools`

The spec scopes tests to `aggregate`, `dayCache` and `dates`. `buildDayJql` and `parseToolResult` are tested anyway: both are pure, and a wrong JQL string is the highest-consequence bug in the project — it fails silently by returning plausible numbers.

- [ ] **Step 1: Write the failing test**

`test/jiraClient.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { buildDayJql, parseToolResult, createJiraClient } from '../src/jiraClient.js';

describe('buildDayJql', () => {
  const jql = buildDayJql('2026-08-03');

  it('bounds the day half-open, from the date to the next date', () => {
    expect(jql).toContain('statusCategoryChangedDate >= "2026-08-03"');
    expect(jql).toContain('statusCategoryChangedDate < "2026-08-04"');
  });

  it('restricts to the done status category', () => {
    expect(jql).toContain('statusCategory = Done');
  });

  // Load-bearing: automation tickets are visible under statusCategoryChangedDate
  // and are assigned to roster members. Without this they inflate counts ~5/day.
  it('excludes the Workato automation tickets', () => {
    expect(jql).toContain('summary !~ "Eligibility Confirmation Request"');
  });

  it('scopes to WOCOO', () => {
    expect(jql).toContain('project = WOCOO');
  });
});

describe('parseToolResult', () => {
  it('unwraps the MCP content envelope', () => {
    const result = { content: [{ type: 'text', text: '{"issues":[]}' }] };
    expect(parseToolResult(result)).toEqual({ issues: [] });
  });

  it('ignores non-text parts', () => {
    const result = {
      content: [{ type: 'image', data: 'x' }, { type: 'text', text: '{"issues":[1]}' }],
    };
    expect(parseToolResult(result).issues).toEqual([1]);
  });

  it('throws when there is no text part', () => {
    expect(() => parseToolResult({ content: [] })).toThrow(/no text/i);
  });
});

describe('createJiraClient', () => {
  const issue = (assignee, issue_type, status) => ({ assignee, issue_type, status });
  const wrap = (payload) => ({ content: [{ type: 'text', text: JSON.stringify(payload) }] });

  it('maps issues to rows', async () => {
    const tools = {
      call: async () => wrap({ issues: [issue('Albert Cai', 'Wires Posting', 'Done')] }),
    };
    const rows = await createJiraClient(tools).fetchDay('2026-08-03');
    expect(rows).toEqual([
      { assignee: 'Albert Cai', workType: 'Wires Posting', outcome: 'done' },
    ]);
  });

  it('marks cancelled rows', async () => {
    const tools = {
      call: async () => wrap({ issues: [issue('Albert Cai', 'X', 'Cancelled/ No Action')] }),
    };
    const rows = await createJiraClient(tools).fetchDay('2026-08-03');
    expect(rows[0].outcome).toBe('cancelled');
  });

  it('follows next_page_token until exhausted', async () => {
    const pages = [
      wrap({ issues: [issue('A', 'T', 'Done')], next_page_token: 'p2' }),
      wrap({ issues: [issue('B', 'T', 'Done')], next_page_token: 'p3' }),
      wrap({ issues: [issue('C', 'T', 'Done')] }),
    ];
    let i = 0;
    const seen = [];
    const tools = {
      call: async (_name, args) => { seen.push(args.next_page_token); return pages[i++]; },
    };
    const rows = await createJiraClient(tools).fetchDay('2026-08-03');
    expect(rows).toHaveLength(3);
    expect(seen).toEqual([undefined, 'p2', 'p3']);
  });

  it('requests only the three fields it needs', async () => {
    let captured;
    const tools = {
      call: async (_name, args) => { captured = args; return wrap({ issues: [] }); },
    };
    await createJiraClient(tools).fetchDay('2026-08-03');
    expect(captured.fields).toBe('assignee,status,issuetype');
    expect(captured.max_results).toBe(100);
  });

  it('treats a missing assignee as null rather than a string', async () => {
    const tools = {
      call: async () => wrap({ issues: [{ issue_type: 'T', status: 'Done' }] }),
    };
    const rows = await createJiraClient(tools).fetchDay('2026-08-03');
    expect(rows[0].assignee).toBeNull();
  });

  it('stops after the page cap so a pagination bug cannot loop forever', async () => {
    const tools = {
      call: async () => wrap({ issues: [issue('A', 'T', 'Done')], next_page_token: 'always' }),
    };
    await expect(createJiraClient(tools).fetchDay('2026-08-03')).rejects.toThrow(/too many pages/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `Failed to resolve import "../src/jiraClient.js"`

- [ ] **Step 3: Write the implementation**

`src/jiraClient.js`:

```js
import { nextDate } from './dates.js';

const FIELDS = 'assignee,status,issuetype';
const PAGE_SIZE = 100;          // jira_search_tickets caps max_results at 100
const MAX_PAGES = 50;           // 5,000 tickets in one day is impossible; a hit means a bug

/**
 * One calendar day, half-open [date, nextDate).
 *
 * Bare YYYY-MM-DD bounds are interpreted in the viewer's own Jira timezone, so Jira
 * does the bucketing and there is no client-side date maths to get wrong.
 *
 * The summary exclusion is load-bearing, not defensive: Workato's "Eligibility
 * Confirmation Request" tickets are created and closed within seconds, are assigned
 * to roster members, and DO carry a status-category change date.
 */
export function buildDayJql(date) {
  return [
    'project = WOCOO',
    'statusCategory = Done',
    `statusCategoryChangedDate >= "${date}"`,
    `statusCategoryChangedDate < "${nextDate(date)}"`,
    'summary !~ "Eligibility Confirmation Request"',
  ].join(' AND ');
}

/** MagicTools returns a standard MCP result: { content: [{type, text}] }. */
export function parseToolResult(result) {
  const part = (result?.content || []).find((p) => p.type === 'text');
  if (!part) throw new Error('MagicTools returned no text part');
  return JSON.parse(part.text);
}

function toRow(issue) {
  return {
    assignee: issue.assignee ? String(issue.assignee) : null,
    workType: issue.issue_type || 'Unknown',
    outcome: (issue.status || '').trim() === 'Cancelled/ No Action' ? 'cancelled' : 'done',
  };
}

/** `tools` is window.MagicTools, or anything with the same .call(name, args) shape. */
export function createJiraClient(tools) {
  async function fetchDay(date) {
    const jql = buildDayJql(date);
    const rows = [];
    let token;

    for (let page = 0; page < MAX_PAGES; page++) {
      const args = { jql, fields: FIELDS, max_results: PAGE_SIZE };
      if (token) args.next_page_token = token;

      const payload = parseToolResult(await tools.call('jira_search_tickets', args));
      for (const issue of payload.issues || []) rows.push(toRow(issue));

      token = payload.next_page_token;
      if (!token) return rows;
    }
    throw new Error(`too many pages for ${date} — pagination is not terminating`);
  }

  return { fetchDay };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/jiraClient.js test/jiraClient.test.js
git commit -m "Add the per-day Jira client

One query per calendar day with half-open bounds, so Jira buckets by day in
the viewer's timezone. The summary exclusion is load-bearing: automation
tickets carry a status-category change date and are assigned to the roster."
```

---

### Task 4: The `dayCache` module

**Files:**
- Create: `~/projects/wocoo-analytics/src/dayCache.js`
- Test: `~/projects/wocoo-analytics/test/dayCache.test.js`

**Interfaces:**
- Consumes: `createJiraClient(...)`'s returned object (anything with `fetchDay(date)`).
- Produces: `createDayCache(client, storage?) => { ensureDays(dates, onProgress?) => Promise<void>, getDayMap() => Map<string, Row[]>, getMissing() => Set<string>, size() => number }`
  - `onProgress` is called as `({ loaded, total })` after each day settles.
  - A day whose fetch rejects goes into `missing` and is **not** written to the map. `ensureDays` resolves rather than rejecting — partial data plus a marked gap beats an empty page.
  - `storage` defaults to `globalThis.sessionStorage` and is injectable for tests.

- [ ] **Step 1: Write the failing test**

`test/dayCache.test.js`:

```js
import { describe, it, expect, vi } from 'vitest';
import { createDayCache } from '../src/dayCache.js';

const row = (assignee) => ({ assignee, workType: 'T', outcome: 'done' });

function fakeClient(impl) {
  const calls = [];
  return {
    calls,
    fetchDay: vi.fn(async (date) => {
      calls.push(date);
      return impl ? impl(date) : [row('Albert Cai')];
    }),
  };
}

function fakeStorage() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, v),
    removeItem: (k) => store.delete(k),
  };
}

describe('ensureDays', () => {
  it('fetches each requested day once', async () => {
    const client = fakeClient();
    const cache = createDayCache(client, fakeStorage());
    await cache.ensureDays(['2026-08-01', '2026-08-02']);
    expect(client.fetchDay).toHaveBeenCalledTimes(2);
    expect(cache.size()).toBe(2);
  });

  // The behaviour that replaces the old cumulative-merge guarantee: once the wide
  // window is loaded, narrower ones are free.
  it('issues no further fetches for a subset already held', async () => {
    const client = fakeClient();
    const cache = createDayCache(client, fakeStorage());
    await cache.ensureDays(['2026-08-01', '2026-08-02', '2026-08-03']);
    client.fetchDay.mockClear();
    await cache.ensureDays(['2026-08-02', '2026-08-03']);
    expect(client.fetchDay).not.toHaveBeenCalled();
  });

  it('fetches only the days it is missing when widening', async () => {
    const client = fakeClient();
    const cache = createDayCache(client, fakeStorage());
    await cache.ensureDays(['2026-08-02', '2026-08-03']);
    client.fetchDay.mockClear();
    await cache.ensureDays(['2026-08-01', '2026-08-02', '2026-08-03']);
    expect(client.fetchDay).toHaveBeenCalledTimes(1);
    expect(client.fetchDay).toHaveBeenCalledWith('2026-08-01');
  });

  it('does not duplicate rows when a day is requested twice', async () => {
    const client = fakeClient();
    const cache = createDayCache(client, fakeStorage());
    await cache.ensureDays(['2026-08-01']);
    await cache.ensureDays(['2026-08-01']);
    expect(cache.getDayMap().get('2026-08-01')).toHaveLength(1);
  });

  it('keeps good days and marks the failed one when one day rejects', async () => {
    const client = fakeClient((date) => {
      if (date === '2026-08-02') throw new Error('boom');
      return [row('Albert Cai')];
    });
    const cache = createDayCache(client, fakeStorage());
    await cache.ensureDays(['2026-08-01', '2026-08-02', '2026-08-03']);

    expect(cache.getMissing()).toEqual(new Set(['2026-08-02']));
    expect(cache.getDayMap().has('2026-08-01')).toBe(true);
    expect(cache.getDayMap().has('2026-08-03')).toBe(true);
    // Critical: a failed day must be absent, not an empty array. An empty array
    // aggregates to 0 and renders as a genuine quiet day.
    expect(cache.getDayMap().has('2026-08-02')).toBe(false);
  });

  it('retries a previously failed day on the next call', async () => {
    let fail = true;
    const client = fakeClient((date) => {
      if (date === '2026-08-02' && fail) throw new Error('boom');
      return [row('Albert Cai')];
    });
    const cache = createDayCache(client, fakeStorage());
    await cache.ensureDays(['2026-08-02']);
    fail = false;
    await cache.ensureDays(['2026-08-02']);
    expect(cache.getDayMap().has('2026-08-02')).toBe(true);
    expect(cache.getMissing().size).toBe(0);
  });

  it('reports progress as days settle', async () => {
    const client = fakeClient();
    const cache = createDayCache(client, fakeStorage());
    const seen = [];
    await cache.ensureDays(['2026-08-01', '2026-08-02'], (p) => seen.push(p));
    expect(seen[seen.length - 1]).toEqual({ loaded: 2, total: 2 });
  });

  it('reports total 0 and fetches nothing when everything is cached', async () => {
    const client = fakeClient();
    const cache = createDayCache(client, fakeStorage());
    await cache.ensureDays(['2026-08-01']);
    const seen = [];
    await cache.ensureDays(['2026-08-01'], (p) => seen.push(p));
    expect(seen).toEqual([{ loaded: 0, total: 0 }]);
  });
});

describe('sessionStorage mirror', () => {
  it('restores a previous session without fetching', async () => {
    const storage = fakeStorage();
    const first = createDayCache(fakeClient(), storage);
    await first.ensureDays(['2026-08-01']);

    const client = fakeClient();
    const second = createDayCache(client, storage);
    await second.ensureDays(['2026-08-01']);
    expect(client.fetchDay).not.toHaveBeenCalled();
    expect(second.getDayMap().get('2026-08-01')).toHaveLength(1);
  });

  it('still works when storage throws a quota error', async () => {
    const storage = {
      getItem: () => null,
      setItem: () => { throw new Error('QuotaExceededError'); },
      removeItem: () => {},
    };
    const cache = createDayCache(fakeClient(), storage);
    await expect(cache.ensureDays(['2026-08-01'])).resolves.toBeUndefined();
    expect(cache.size()).toBe(1);
  });

  it('ignores corrupt stored data rather than throwing', async () => {
    const storage = fakeStorage();
    storage.setItem('wocoo-analytics/days/v1', 'not json');
    const cache = createDayCache(fakeClient(), storage);
    await cache.ensureDays(['2026-08-01']);
    expect(cache.size()).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `Failed to resolve import "../src/dayCache.js"`

- [ ] **Step 3: Write the implementation**

`src/dayCache.js`:

```js
// Day-keyed cache. Every board window is the union of its days, so holding days
// rather than dated tickets is what makes narrower windows free.

const STORAGE_KEY = 'wocoo-analytics/days/v1';
const CONCURRENCY = 6;   // polite to Jira; the year window is 365 days

export function createDayCache(client, storage = globalThis.sessionStorage) {
  const dayMap = new Map();
  const missing = new Set();

  restore();

  function restore() {
    try {
      const raw = storage?.getItem(STORAGE_KEY);
      if (!raw) return;
      for (const [date, rows] of Object.entries(JSON.parse(raw))) {
        dayMap.set(date, rows);
      }
    } catch {
      // Corrupt or unreadable — start empty rather than taking the page down.
    }
  }

  function persist() {
    try {
      storage?.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(dayMap)));
    } catch {
      // Quota exceeded, or storage unavailable. In-memory only from here.
    }
  }

  async function ensureDays(dates, onProgress) {
    const todo = dates.filter((d) => !dayMap.has(d));
    const total = todo.length;
    let loaded = 0;

    if (total === 0) {
      onProgress?.({ loaded: 0, total: 0 });
      return;
    }

    const queue = [...todo];
    async function worker() {
      while (queue.length) {
        const date = queue.shift();
        try {
          dayMap.set(date, await client.fetchDay(date));
          missing.delete(date);
        } catch {
          // Leave the day ABSENT, not empty. An empty array aggregates to 0 and
          // renders as a genuine quiet day, which is the failure this design
          // most wants to avoid.
          missing.add(date);
        }
        loaded++;
        onProgress?.({ loaded, total });
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, total) }, worker),
    );
    persist();
  }

  return {
    ensureDays,
    getDayMap: () => dayMap,
    getMissing: () => new Set(missing),
    size: () => dayMap.size,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — all four test files.

- [ ] **Step 5: Commit**

```bash
git add src/dayCache.js test/dayCache.test.js
git commit -m "Add the day-keyed cache

A failed day stays absent from the map rather than being stored as an empty
array, so it renders as a gap instead of a quiet day. Windows are unions of
days, so narrowing is free and widening fetches only the difference."
```

---

### Task 5: Design tokens and the build script

**Files:**
- Create: `~/projects/wocoo-analytics/src/tokens.css`
- Create: `~/projects/wocoo-analytics/src/shell.html`
- Create: `~/projects/wocoo-analytics/build.js`

**Interfaces:**
- Consumes: all `src/*.js` modules.
- Produces: `dist/index.html`, a single self-contained file. The build inlines each module's source inside one `<script type="text/babel">`, stripping `import`/`export` keywords, because Babel standalone in the browser does not resolve module specifiers.

- [ ] **Step 1: Write the tokens**

`src/tokens.css`:

```css
/* Patchwork tokens.
   Greys: read from Foundation/Colour in Figma — authoritative.
   Categorical: SAMPLED FROM A SCREENSHOT and numerically approximate. The Figma
   doc's hex chips are detached from their swatches (six multi-hued swatches are
   labelled with a single green ramp), so these were eyedropped. Replace when the
   real values surface; do NOT "correct" them back to the greens in Figma. */
:root {
  --fg-strong: #32302F;
  --fg-soft: #615E5C;
  --fg-inactive: #94908D;
  --bg-app: #FCFCFC;
  --bg-default: #FFFFFF;
  --bg-soft: #F5F4F4;
  --outline: rgba(0, 0, 0, 0.08);

  --cat-01: #6E93E0;
  --cat-02: #B07FE8;
  --cat-03: #EE86CE;
  --cat-04: #EBCB2E;
  --cat-05: #38934F;
  --cat-06: #F09340;
  /* Unassigned is a seventh row; the categorical set only has six, so it takes a
     neutral grey and is excluded from the chart. */
  --cat-unassigned: #94908D;
}

body {
  margin: 0;
  background: var(--bg-app);
  color: var(--fg-strong);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
}
```

- [ ] **Step 2: Write the HTML shell**

`src/shell.html` — `__TOKENS__`, `__MODULES__` and `__COMPONENTS__` are replaced by the build:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>WOCOO Analytics</title>
  <!-- Tailwind v4 and the Wealthsimple token set are auto-injected by Magic.
       Do not add them here. React and Babel are not injected. -->
  <script crossorigin src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
  <script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
  <!-- Pinned to 7: standalone v8 emits import statements that break text/babel. -->
  <script src="https://unpkg.com/@babel/standalone@7/babel.min.js"></script>
  <style>__TOKENS__</style>
</head>
<body>
  <div id="root"></div>
  <script type="text/babel" data-type="module">
    const { useState, useEffect, useMemo, useCallback } = React;
__MODULES__
__COMPONENTS__
    ReactDOM.createRoot(document.getElementById('root')).render(<App />);
  </script>
</body>
</html>
```

- [ ] **Step 3: Write the build script**

`build.js`:

```js
// Assembles src/ into a single dist/index.html.
//
// Babel standalone cannot resolve module specifiers in the browser, so the build
// strips import/export syntax and concatenates the modules in dependency order
// into one scope. Order matters: dates before jiraClient, jiraClient before dayCache.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const src = (f) => readFileSync(join(root, 'src', f), 'utf8');

const MODULE_ORDER = ['dates.js', 'aggregate.js', 'jiraClient.js', 'dayCache.js'];

/** Remove ESM syntax so the modules can share one browser scope. */
function stripModuleSyntax(code) {
  return code
    .replace(/^\s*import[^;]+;\s*$/gm, '')
    .replace(/^export\s+(const|function|class)\s/gm, '$1 ')
    .replace(/^export\s*\{[^}]*\}\s*;?\s*$/gm, '');
}

const modules = MODULE_ORDER
  .map((f) => `// ---- ${f} ----\n${stripModuleSyntax(src(f))}`)
  .join('\n\n')
  .split('\n')
  .map((line) => (line ? `    ${line}` : line))
  .join('\n');

const components = src('components.js')
  .split('\n')
  .map((line) => (line ? `    ${line}` : line))
  .join('\n');

const html = src('shell.html')
  .replace('__TOKENS__', () => src('tokens.css'))
  .replace('__MODULES__', () => modules)
  .replace('__COMPONENTS__', () => components);

mkdirSync(join(root, 'dist'), { recursive: true });
writeFileSync(join(root, 'dist', 'index.html'), html);

const kb = (html.length / 1024).toFixed(1);
console.log(`dist/index.html written — ${kb} KB`);
```

- [ ] **Step 4: Create a components placeholder so the build runs**

`src/components.js`:

```js
function App() {
  return <div style={{ padding: 24 }}>WOCOO Analytics — scaffold</div>;
}
```

- [ ] **Step 5: Run the build**

Run: `npm run build`
Expected: `dist/index.html written — N KB`

- [ ] **Step 6: Verify the assembled file has no leftover module syntax**

Run: `grep -nE "^\s*(import|export) " dist/index.html; echo "exit: $?"`
Expected: no matching lines (grep exits 1).

- [ ] **Step 7: Commit**

```bash
git add src/tokens.css src/shell.html src/components.js build.js
git commit -m "Add tokens, HTML shell and the single-file build

Categorical colours are eyedropped from a screenshot, not read from Figma —
the doc's hex chips are detached from their swatches. Marked in the CSS so
nobody 'corrects' them back to the green ramp."
```

---

### Task 6: App shell — period tabs, summary tiles, load orchestration

**Files:**
- Modify: `~/projects/wocoo-analytics/src/components.js` (replace the placeholder)

**Interfaces:**
- Consumes: `lastNDates`, `createJiraClient`, `createDayCache`, `rowsForDates`, `totalsFor`.
- Produces: `App`, `PeriodTabs`, `SummaryTiles`, `LoadState` — all in the shared browser scope.

Window sizes: Day = 1, 7 days = 7, 30 days = 30, Year = 365. The initial load fetches 30 days, which covers the first three tabs and the default chart window.

- [ ] **Step 1: Write the app shell**

Replace `src/components.js` with:

```js
const PERIODS = [
  { id: 'day', label: 'Day', days: 1 },
  { id: 'week', label: '7 days', days: 7 },
  { id: 'month', label: '30 days', days: 30 },
  { id: 'year', label: 'Year', days: 365 },
];

const INITIAL_DAYS = 30;

/** Today in the viewer's timezone, as YYYY-MM-DD. Matches how Jira reads bare
 *  date bounds, so the client and the query agree on what "today" means. */
function todayISO() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function PeriodTabs({ value, onChange, disabled }) {
  return (
    <div style={{ display: 'flex', gap: 4, marginBottom: 16 }}>
      {PERIODS.map((p) => (
        <button
          key={p.id}
          onClick={() => onChange(p.id)}
          disabled={disabled}
          style={{
            padding: '6px 14px',
            border: `1px solid ${value === p.id ? 'var(--fg-strong)' : 'var(--outline)'}`,
            background: value === p.id ? 'var(--fg-strong)' : 'var(--bg-default)',
            color: value === p.id ? 'var(--bg-default)' : 'var(--fg-soft)',
            borderRadius: 6,
            cursor: disabled ? 'wait' : 'pointer',
            font: 'inherit',
            fontWeight: value === p.id ? 600 : 400,
          }}
        >
          {p.label}
        </button>
      ))}
    </div>
  );
}

function SummaryTiles({ totals, incomplete }) {
  const tile = (label, value, muted) => (
    <div style={{
      flex: 1, padding: '12px 16px', background: 'var(--bg-default)',
      border: '1px solid var(--outline)', borderRadius: 8,
    }}>
      <div style={{ fontSize: 12, color: 'var(--fg-soft)' }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 700, color: muted ? 'var(--fg-soft)' : 'var(--fg-strong)' }}>
        {value}{incomplete ? '+' : ''}
      </div>
    </div>
  );
  return (
    <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
      {tile('Completed', totals.done, false)}
      {tile('Cancelled / No Action', totals.cancelled, true)}
    </div>
  );
}

function LoadState({ progress, missing, onRetry }) {
  if (progress && progress.total > 0 && progress.loaded < progress.total) {
    return (
      <div style={{ padding: '8px 12px', marginBottom: 12, background: 'var(--bg-soft)', borderRadius: 6, fontSize: 13 }}>
        Loading {progress.loaded} of {progress.total} days…
      </div>
    );
  }
  if (missing.size > 0) {
    return (
      <div style={{
        padding: '8px 12px', marginBottom: 12, borderRadius: 6, fontSize: 13,
        background: '#FDECEC', border: '1px solid #E9A7A7',
      }}>
        {missing.size} {missing.size === 1 ? 'day' : 'days'} failed to load — counts below are
        incomplete and ranking is hidden.{' '}
        <button onClick={onRetry} style={{ font: 'inherit', textDecoration: 'underline', border: 0, background: 'none', cursor: 'pointer' }}>
          Retry
        </button>
      </div>
    );
  }
  return null;
}

function App() {
  const [period, setPeriod] = useState('month');
  const [chartDays, setChartDays] = useState(30);
  const [progress, setProgress] = useState(null);
  const [tick, setTick] = useState(0);          // bumped to force re-read of the cache
  const [error, setError] = useState(null);
  const [expanded, setExpanded] = useState(() => new Set());

  const today = useMemo(() => todayISO(), []);
  const cache = useMemo(() => {
    if (!window.MagicTools) return null;
    return createDayCache(createJiraClient(window.MagicTools));
  }, []);

  const load = useCallback(async (days) => {
    if (!cache) return;
    setError(null);
    try {
      await cache.ensureDays(lastNDates(days, today), setProgress);
    } catch (e) {
      setError(e?.message || String(e));
    }
    setTick((n) => n + 1);
  }, [cache, today]);

  useEffect(() => { load(INITIAL_DAYS); }, [load]);

  const periodDays = PERIODS.find((p) => p.id === period).days;
  useEffect(() => { load(Math.max(periodDays, chartDays)); }, [periodDays, chartDays, load]);

  if (!window.MagicTools) {
    return (
      <div style={{ padding: 24, maxWidth: 560 }}>
        <h1 style={{ fontSize: 20 }}>Can't reach Jira</h1>
        <p style={{ color: 'var(--fg-soft)' }}>
          The MCPLocker browser extension isn't available, so this page can't query Jira as you.
          Check your VPN, then connect at{' '}
          <a href="https://mcplocker.w10external.com">mcplocker.w10external.com</a>.
        </p>
      </div>
    );
  }

  const dayMap = cache.getDayMap();
  const missing = cache.getMissing();
  const dates = lastNDates(periodDays, today);
  const rows = rowsForDates(dayMap, dates);
  const totals = totalsFor(rows);
  const incomplete = dates.some((d) => missing.has(d));

  return (
    <div style={{ padding: 24, maxWidth: 1000, margin: '0 auto' }} key={tick}>
      <h1 style={{ fontSize: 22, marginBottom: 4 }}>WOCOO Analytics</h1>
      <p style={{ color: 'var(--fg-soft)', fontSize: 13, marginTop: 0 }}>
        Tickets completed by calendar day, excluding automated eligibility confirmations.
      </p>

      {error && (
        <div style={{ padding: '8px 12px', marginBottom: 12, background: '#FDECEC', borderRadius: 6, fontSize: 13 }}>
          {error}
        </div>
      )}

      <PeriodTabs value={period} onChange={setPeriod} disabled={!!progress && progress.loaded < progress.total} />
      <LoadState progress={progress} missing={missing} onRetry={() => load(Math.max(periodDays, chartDays))} />
      <SummaryTiles totals={totals} incomplete={incomplete} />

      <Leaderboard rows={rows} expanded={expanded} onToggle={setExpanded} suppressRank={incomplete} />
      <TrendChart dayMap={dayMap} today={today} days={chartDays} onDaysChange={setChartDays} />

      <p style={{ color: 'var(--fg-inactive)', fontSize: 11, marginTop: 24 }}>
        A ticket reopened and closed again counts on its most recent close date, so historical
        days can change.
      </p>
    </div>
  );
}
```

- [ ] **Step 2: Build and confirm it assembles**

Run: `npm run build`
Expected: `dist/index.html written — N KB`. It will not render yet — `Leaderboard` and `TrendChart` arrive in Tasks 7 and 8.

- [ ] **Step 3: Commit**

```bash
git add src/components.js
git commit -m "Add app shell with period tabs, summary tiles and load orchestration

Initial load covers 30 days, which serves the first three tabs and the default
chart window. Rank is suppressed whenever any day in the window failed."
```

---

### Task 7: Leaderboard and work-type drill-down

**Files:**
- Modify: `~/projects/wocoo-analytics/src/components.js` (append)

**Interfaces:**
- Consumes: `byAssignee`, `byWorkType`, `totalsFor`, `ROSTER`.
- Produces: `Leaderboard`, `WorkTypeBreakdown`, `colourFor(key)`.

`colourFor` is shared with Task 8 so a person's colour is identical in the chart and their row.

- [ ] **Step 1: Append the leaderboard**

Append to `src/components.js`:

```js
const CATEGORICAL = ['var(--cat-01)', 'var(--cat-02)', 'var(--cat-03)',
                     'var(--cat-04)', 'var(--cat-05)', 'var(--cat-06)'];

/** Stable colour per row key, shared by the chart and the leaderboard.
 *  Roster order fixes the first five; Other takes the sixth; Unassigned falls to
 *  grey because the categorical set only has six entries. */
function colourFor(key) {
  if (key === 'Unassigned') return 'var(--cat-unassigned)';
  const index = key === 'Other' ? 5 : ROSTER.indexOf(key);
  return index >= 0 ? CATEGORICAL[index % CATEGORICAL.length] : 'var(--cat-unassigned)';
}

function WorkTypeBreakdown({ rows, assigneeKey: key }) {
  const breakdown = byWorkType(rows, key);
  if (breakdown.length === 0) {
    return <div style={{ padding: '8px 0 8px 28px', color: 'var(--fg-soft)', fontSize: 13 }}>No tickets.</div>;
  }
  const max = Math.max(...breakdown.map((b) => b.done), 1);
  return (
    <div style={{ padding: '4px 0 10px 28px', background: 'var(--bg-soft)' }}>
      {breakdown.map((b) => (
        <div key={b.workType} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '3px 12px 3px 0', fontSize: 13 }}>
          <span style={{ flex: 2 }}>{b.workType}</span>
          <span style={{ flex: 3, height: 6, background: 'var(--outline)', borderRadius: 3 }}>
            <span style={{ display: 'block', width: `${(b.done / max) * 100}%`, height: '100%', background: colourFor(key || 'Other'), borderRadius: 3 }} />
          </span>
          <span style={{ width: 40, textAlign: 'right', fontWeight: 600 }}>{b.done}</span>
          <span style={{ width: 40, textAlign: 'right', color: 'var(--fg-soft)' }}>{b.cancelled || ''}</span>
        </div>
      ))}
    </div>
  );
}

function Leaderboard({ rows, expanded, onToggle, suppressRank }) {
  const perAssignee = byAssignee(rows);
  const totals = totalsFor(rows);

  const toggle = (key) => {
    const next = new Set(expanded);
    if (next.has(key)) next.delete(key); else next.add(key);
    onToggle(next);
  };

  const headerCell = { padding: '6px 12px 6px 0', fontSize: 12, color: 'var(--fg-soft)', fontWeight: 600 };

  return (
    <div style={{ background: 'var(--bg-default)', border: '1px solid var(--outline)', borderRadius: 8, overflow: 'hidden', marginBottom: 20 }}>
      <div style={{ display: 'flex', padding: '0 12px', borderBottom: '1px solid var(--outline)' }}>
        <span style={{ ...headerCell, flex: 1 }}>{suppressRank ? 'Assignee' : 'Assignee (ranked)'}</span>
        <span style={{ ...headerCell, width: 70, textAlign: 'right' }}>Done</span>
        <span style={{ ...headerCell, width: 90, textAlign: 'right' }}>Cancelled</span>
      </div>

      {perAssignee.map((entry) => (
        <div key={entry.key}>
          <div
            onClick={() => toggle(entry.key)}
            style={{ display: 'flex', alignItems: 'center', padding: '8px 12px', cursor: 'pointer', borderBottom: '1px solid var(--outline)' }}
          >
            <span style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ width: 9, height: 9, borderRadius: 2, background: colourFor(entry.key), flexShrink: 0 }} />
              <span style={{ color: 'var(--fg-inactive)', width: 12 }}>{expanded.has(entry.key) ? '▾' : '▸'}</span>
              {entry.key}
            </span>
            <span style={{ width: 70, textAlign: 'right', fontWeight: 600 }}>{entry.done}</span>
            <span style={{ width: 90, textAlign: 'right', color: 'var(--fg-soft)' }}>{entry.cancelled}</span>
          </div>
          {expanded.has(entry.key) && <WorkTypeBreakdown rows={rows} assigneeKey={entry.key} />}
        </div>
      ))}

      <div>
        <div
          onClick={() => toggle('__total__')}
          style={{ display: 'flex', alignItems: 'center', padding: '8px 12px', cursor: 'pointer', fontWeight: 700, background: 'var(--bg-soft)' }}
        >
          <span style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ width: 9, flexShrink: 0 }} />
            <span style={{ color: 'var(--fg-inactive)', width: 12 }}>{expanded.has('__total__') ? '▾' : '▸'}</span>
            Total
          </span>
          <span style={{ width: 70, textAlign: 'right' }}>{totals.done}</span>
          <span style={{ width: 90, textAlign: 'right' }}>{totals.cancelled}</span>
        </div>
        {expanded.has('__total__') && <WorkTypeBreakdown rows={rows} assigneeKey={null} />}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/components.js
git commit -m "Add ranked leaderboard with inline work-type drill-down

Total is pinned last and excluded from ranking; it sums every row above it so
the two reconcile. Colours come from colourFor so a person matches between
their row and the chart."
```

---

### Task 8: Trend chart

**Files:**
- Modify: `~/projects/wocoo-analytics/src/components.js` (append)

**Interfaces:**
- Consumes: `dailySeries`, `lastNDates`, `colourFor`.
- Produces: `TrendChart`.

- [ ] **Step 1: Read the dataviz skill before writing chart code**

Invoke the `dataviz` skill. It governs axis treatment, gridlines, and validating a categorical palette for contrast and colour-blind safety. This matters more than usual here: the six colours were eyedropped from a screenshot rather than taken from a validated scale, so confirm they hold up and record the result. If any pair is indistinguishable, note it in the spec's Findings §3 rather than silently substituting different colours.

- [ ] **Step 2: Append the chart**

Append to `src/components.js`:

```js
const CHART_WINDOWS = [30, 90, 365];

/** Inline SVG line chart. A null value breaks the line rather than dropping to
 *  zero, so a failed day reads as a gap. */
function TrendChart({ dayMap, today, days, onDaysChange }) {
  const [hidden, setHidden] = useState(() => new Set());
  const dates = lastNDates(days, today);
  const { series, total } = dailySeries(dayMap, dates);

  const W = 940, H = 200, PAD_L = 34, PAD_B = 20, PAD_T = 8;
  const maxY = Math.max(1, ...total.filter((v) => v !== null));
  const x = (i) => PAD_L + (i * (W - PAD_L - 8)) / Math.max(1, dates.length - 1);
  const y = (v) => PAD_T + (H - PAD_T - PAD_B) * (1 - v / maxY);

  /** Split into unbroken runs so nulls leave gaps instead of joining across them. */
  const pathFor = (values) => {
    const runs = [];
    let run = [];
    values.forEach((v, i) => {
      if (v === null) { if (run.length) runs.push(run); run = []; }
      else run.push(`${x(i)},${y(v)}`);
    });
    if (run.length) runs.push(run);
    return runs.map((r) => `M${r.join(' L')}`).join(' ');
  };

  const toggle = (key) => {
    const next = new Set(hidden);
    if (next.has(key)) next.delete(key); else next.add(key);
    setHidden(next);
  };

  return (
    <div style={{ background: 'var(--bg-default)', border: '1px solid var(--outline)', borderRadius: 8, padding: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <strong style={{ fontSize: 14 }}>Completed per day</strong>
        <div style={{ display: 'flex', gap: 4 }}>
          {CHART_WINDOWS.map((w) => (
            <button
              key={w}
              onClick={() => onDaysChange(w)}
              style={{
                padding: '3px 10px', fontSize: 12, borderRadius: 5, cursor: 'pointer', font: 'inherit',
                border: `1px solid ${days === w ? 'var(--fg-strong)' : 'var(--outline)'}`,
                background: days === w ? 'var(--fg-strong)' : 'var(--bg-default)',
                color: days === w ? 'var(--bg-default)' : 'var(--fg-soft)',
              }}
            >
              {w}d
            </button>
          ))}
        </div>
      </div>

      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto' }}>
        <line x1={PAD_L} y1={y(0)} x2={W - 8} y2={y(0)} stroke="var(--outline)" />
        <line x1={PAD_L} y1={PAD_T} x2={W - 8} y2={PAD_T} stroke="var(--outline)" strokeDasharray="2 3" />
        <text x={4} y={y(0) + 4} fontSize="10" fill="var(--fg-inactive)">0</text>
        <text x={4} y={PAD_T + 8} fontSize="10" fill="var(--fg-inactive)">{maxY}</text>

        {!hidden.has('__total__') && (
          <path d={pathFor(total)} fill="none" stroke="var(--fg-strong)" strokeWidth="2" />
        )}
        {series.filter((s) => !hidden.has(s.key)).map((s) => (
          <path key={s.key} d={pathFor(s.values)} fill="none" stroke={colourFor(s.key)} strokeWidth="1.5" />
        ))}
      </svg>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 8 }}>
        {[{ key: '__total__', label: 'Total', colour: 'var(--fg-strong)' },
          ...series.map((s) => ({ key: s.key, label: s.key, colour: colourFor(s.key) }))].map((item) => (
          <button
            key={item.key}
            onClick={() => toggle(item.key)}
            style={{
              display: 'flex', alignItems: 'center', gap: 6, border: 0, background: 'none',
              cursor: 'pointer', font: 'inherit', fontSize: 12, padding: 0,
              opacity: hidden.has(item.key) ? 0.35 : 1,
            }}
          >
            <span style={{ width: 14, height: 3, background: item.colour, borderRadius: 2 }} />
            {item.label}
          </button>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add src/components.js
git commit -m "Add per-assignee trend chart with legend toggles

Null days break the line rather than dropping to zero, so a failed fetch
reads as a gap instead of a quiet day."
```

---

### Task 9: Deploy and verify against Jira

**Files:**
- No source changes unless verification fails.

- [ ] **Step 1: Run the full suite and build**

```bash
cd ~/projects/wocoo-analytics && npm test && npm run build
```
Expected: all tests pass; `dist/index.html` written.

- [ ] **Step 2: Deploy to Magic**

Upload `dist/index.html` with `magic_site_upload`, site name `wocoo-analytics`.

- [ ] **Step 3: Open the site and confirm it loads**

Visit `https://magic.w10e.com/albert.cai/wocoo-analytics`. Expect a progress line counting to 30 days, then the board and a populated 30-day chart.

If it shows the "Can't reach Jira" state, the MCPLocker extension isn't connected — that is the designed message, not a bug.

- [ ] **Step 4: Cross-check one window against Jira directly**

This is the check the spec calls more valuable than any unit test. Note the dashboard's **Completed** figure on the 7-day tab, then run the equivalent query in Jira and compare counts:

```
project = WOCOO AND statusCategory = Done
  AND statusCategoryChangedDate >= -7d
  AND summary !~ "Eligibility Confirmation Request"
  AND status != "Cancelled/ No Action"
```

Note the boundary difference: the dashboard sums 7 **calendar** days including today, while `-7d` is a rolling 168 hours, so small disagreement at the edges is expected. A large gap means the exclusion or the day bucketing is wrong — investigate before announcing the site.

- [ ] **Step 5: Confirm the automation exclusion is holding**

Run in Jira:

```
project = WOCOO AND statusCategory = Done
  AND statusCategoryChangedDate >= -7d
  AND summary ~ "Eligibility Confirmation Request"
```

Every ticket returned must be absent from the dashboard's counts. If the dashboard total is roughly this count higher than expected, the `summary !~` clause isn't being applied.

- [ ] **Step 6: Verify the failure path renders honestly**

In devtools, block requests to the MCPLocker endpoint and reload. Expect the "Can't reach Jira" panel or a "days failed to load" banner with rank suppressed — **not** a board of zeroes. If zeroes appear, stop and fix: that is the failure mode the design most wants to avoid.

- [ ] **Step 7: Commit and record the deployment**

```bash
git add -A
git commit -m "Verify the dashboard against Jira and record deployment

Cross-checked the 7-day total against the equivalent JQL, confirmed the
automation exclusion holds, and confirmed a blocked MCPLocker renders an
error rather than zeroes."
```

---

## Self-Review

**Spec coverage.** Purpose → Tasks 6–8. Roster and Other/Unassigned → Task 2. Query and `MagicTools` → Task 3. Done/Cancelled split → Tasks 2 and 3. Cache and day-keying → Task 4. All six components → Tasks 6–8. Colour → Tasks 5, 7, 8. Loading and progress → Tasks 4 and 6. Failure modes: partial fetch → Task 4 + Step 6 of Task 9; automation reappearing → Task 3 test + Task 9 Step 5; reopened tickets → footnote in Task 6; `sessionStorage` quota → Task 4; `MagicTools` unavailable → Task 6. Testing → Tasks 1–4. Build → Task 5. Manual cross-check → Task 9 Step 4.

**Deliberately not implemented:** the missing-`resolutiondate` footnote from earlier spec drafts. Findings §4 made it meaningless — `resolutiondate` is absent project-wide, so the count would be every ticket in WOCOO.

**Known gaps, stated rather than hidden:**
- Components are untested by decision. Their bugs are visible; the tested modules' bugs aren't.
- The categorical colours are approximate. Task 8 Step 1 validates them but cannot make them authoritative.
- The Year tab is ~365 requests and will take around a minute. Accepted during brainstorming.
