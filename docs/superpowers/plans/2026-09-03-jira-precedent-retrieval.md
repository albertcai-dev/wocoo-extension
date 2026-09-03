# Jira Precedent Retrieval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add past Done WOCOO tickets of the same work type as a third grounding source for the AI verdict card, so its `similar_tickets` covers the whole board's history rather than only the tickets Albert personally logged.

**Architecture:** Retrieval is deterministic — a JQL query on work type plus recency, capped at 40 rows, run over the Atlassian OAuth token the extension already holds. Candidates are joined in memory against the existing `getRecentLog` rows by ticket id so a candidate Albert logged carries its `resolution_note` and the rest are marked intake-only. The model only ranks and summarises what it is handed, and may not cite a ticket key outside the candidate set.

**Tech Stack:** TypeScript, React 18, Vite + `@crxjs/vite-plugin`, Vitest (node environment), Chrome MV3 sidepanel, Jira REST `/rest/api/3/search/jql`, LiteLLM gateway at `llm.w10e.com`.

**Spec:** `docs/superpowers/specs/2026-09-01-ticket-knowledge-loop-phase2-llmgateway-design.md` (§2b is this plan's subject; §4 changes are Task 3)

## Global Constraints

- Private VPC-hosted models only. Model id is `bedrock-claude-sonnet-4-6`. External models get WS PII masking applied, which mangles client names and emails inside ticket text.
- No embeddings and no semantic search of any kind. Retrieval is JQL only.
- WOCOO's "work type" **is** `issuetype.name`. There is no separate work-type custom field. See the existing mapping at `extension/src/api/jira.ts:1127`.
- Candidate cap is 40 rows.
- The card is never hidden outright — a hidden card makes the feature permanently invisible to its only user.
- Errors are never cached. Gateway timeout stays 45s.
- A precedent-fetch failure must not fail the card: the verdict still renders from log plus playbook.
- Personal-first. No team-shared output in this phase.
- All commands below run from `extension/` unless stated otherwise. Test command is `npm test` (`vitest run`, `include: ['src/**/*.test.ts']` — note `.test.ts` only, not `.test.tsx`).

## Prior state (already on `main`, do not rebuild)

Phase 2's base landed in commits `30c8d0e`..`16a4bb7`. These already exist and are tested:

- `src/api/llmGateway.ts` + `llmGateway.test.ts` — `callLlmGateway(messages, key)`.
- `src/auth/credentials.ts` — `getLlmGatewayKey` / `setLlmGatewayKey` / `clearLlmGatewayKey`.
- `src/sidepanel/SettingsView.tsx` — `LlmGatewayRow` with save + ping validation.
- `src/data/aiTriageTypes.ts` — `RecentLogRow`, `PlaybookChunk`, `SimilarTicket`, `TriageVerdict`, `TriagePromptInput`.
- `src/sidepanel/composePrompt.ts` + `composePrompt.test.ts` — `buildTriagePrompt`, `parseTriageVerdict`.
- `src/sidepanel/aiTriageCache.ts` + `aiTriageCache.test.ts` — `getOrCompute`, `invalidate`, `TRIAGE_CACHE_TTL_MS`.
- `src/sidepanel/AITriageCard.tsx` — rendered from `SidePanel.tsx:550`.
- `src/api/bridge.ts` — `getRecentLogViaBridge(workType, limit)`, `getPlaybookViaBridge()`.
- `manifest.json` — `https://llm.w10e.com/*` in `host_permissions`.

This plan is the precedent delta on top of that.

## File Structure

**Create:**

- `src/data/precedent.ts` — pure precedent logic: JQL construction and the outcome join. No network, no chrome APIs. Lives in `data/` because that is where this repo keeps pure, unit-tested logic (`credRouteDetect.ts`, `atlasAccountLookup.ts`, and friends).
- `src/data/precedent.test.ts` — Vitest cover for the above.

**Modify:**

- `src/data/aiTriageTypes.ts` — add `PrecedentCandidate`; add `source` to `SimilarTicket`; add `precedent` to `TriagePromptInput`.
- `src/api/jira.ts` — export `extractDescription`; add `extraFields` to `searchTickets`; add `description?` to `TicketRow`; add the `searchPrecedent` network wrapper.
- `src/sidepanel/composePrompt.ts` — render the `PRECEDENT CANDIDATES` block; extend the output contract; validate cited keys against the candidate set.
- `src/sidepanel/composePrompt.test.ts` — new precedent cases, plus the second argument at the five existing `parseTriageVerdict` call sites.
- `src/sidepanel/AITriageCard.tsx` — third parallel fetch, degradation state, source badge in the similar-tickets list.

---

### Task 1: Pure precedent logic

**Files:**
- Create: `extension/src/data/precedent.ts`
- Create: `extension/src/data/precedent.test.ts`
- Modify: `extension/src/data/aiTriageTypes.ts`

**Interfaces:**
- Consumes: `RecentLogRow` from `src/data/aiTriageTypes.ts` (existing, unchanged).
- Produces:
  - `export const PRECEDENT_MAX_RESULTS = 40`
  - `export interface PrecedentCandidate { ticketId: string; summary: string; description: string; source: 'logged' | 'intake-only'; outcome: string }` (declared in `aiTriageTypes.ts`)
  - `export function buildPrecedentJql(workType: string, excludeKey: string): string`
  - `export function joinPrecedentOutcomes(rows: PrecedentRowInput[], logRows: RecentLogRow[]): PrecedentCandidate[]`
  - `export interface PrecedentRowInput { id: string; summary: string; description?: string }`

- [ ] **Step 1: Add the types**

In `extension/src/data/aiTriageTypes.ts`, add below the existing `PlaybookChunk` interface:

```ts
/** One past Done WOCOO ticket offered to the model as precedent (§2b).
 *  `source` is `logged` when Albert's own log supplied a resolution note for this
 *  ticket, and `intake-only` when all we have is the original request text. The card
 *  must not present an intake-only entry as a resolution. */
export interface PrecedentCandidate {
  ticketId: string;
  summary: string;
  description: string;
  source: 'logged' | 'intake-only';
  /** The resolution note when `source === 'logged'`, otherwise the empty string. */
  outcome: string;
}
```

Then change the existing `SimilarTicket` interface to carry the same provenance:

```ts
export interface SimilarTicket {
  ticketId: string;
  whatHappened: string;
  source: 'logged' | 'intake-only';
}
```

- [ ] **Step 2: Write the failing test**

Create `extension/src/data/precedent.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildPrecedentJql, joinPrecedentOutcomes, PRECEDENT_MAX_RESULTS } from './precedent';
import type { RecentLogRow } from './aiTriageTypes';

function logRow(over: Partial<RecentLogRow> = {}): RecentLogRow {
  return {
    loggedAt: '2026-08-01T10:00:00Z',
    ticketId: 'WOCOO-100',
    summary: 'Interest charged after cutoff',
    originalWorkType: 'Credit Card: Statements',
    finalWorkType: 'Credit Card: Statements',
    transition: 'Done',
    movedToBoard: '',
    resolutionNote: 'Reversed as a one-time exception.',
    toolsUsed: 'i2c',
    ...over,
  };
}

describe('buildPrecedentJql', () => {
  it('scopes to Done WOCOO tickets of the same issue type, newest first', () => {
    const jql = buildPrecedentJql('Credit Card: Statements', 'WOCOO-999');
    expect(jql).toBe(
      'project = WOCOO AND statusCategory = Done AND issuetype = "Credit Card: Statements"'
      + ' AND key != WOCOO-999 ORDER BY created DESC',
    );
  });

  it('escapes double quotes in the work type so the JQL stays valid', () => {
    expect(buildPrecedentJql('Odd "quoted" type', 'WOCOO-1')).toContain('issuetype = "Odd \\"quoted\\" type"');
  });

  it('omits the key exclusion when there is no current key', () => {
    expect(buildPrecedentJql('Overpayment', '')).toBe(
      'project = WOCOO AND statusCategory = Done AND issuetype = "Overpayment" ORDER BY created DESC',
    );
  });

  it('caps candidates at 40', () => {
    expect(PRECEDENT_MAX_RESULTS).toBe(40);
  });
});

describe('joinPrecedentOutcomes', () => {
  it('attaches the resolution note when the log has the ticket', () => {
    const out = joinPrecedentOutcomes(
      [{ id: 'WOCOO-100', summary: 'Interest charged', description: 'Paid at 11:35 PM.' }],
      [logRow()],
    );
    expect(out).toEqual([{
      ticketId: 'WOCOO-100',
      summary: 'Interest charged',
      description: 'Paid at 11:35 PM.',
      source: 'logged',
      outcome: 'Reversed as a one-time exception.',
    }]);
  });

  it('marks unmatched candidates intake-only with an empty outcome', () => {
    const out = joinPrecedentOutcomes(
      [{ id: 'WOCOO-200', summary: 'Fee waiver', description: 'See Zendesk Support tab.' }],
      [logRow()],
    );
    expect(out[0].source).toBe('intake-only');
    expect(out[0].outcome).toBe('');
  });

  it('treats a log row with a blank resolution note as intake-only', () => {
    const out = joinPrecedentOutcomes(
      [{ id: 'WOCOO-100', summary: 'Interest charged', description: '' }],
      [logRow({ resolutionNote: '   ' })],
    );
    expect(out[0].source).toBe('intake-only');
  });

  it('defaults a missing description to the empty string', () => {
    const out = joinPrecedentOutcomes([{ id: 'WOCOO-300', summary: 'No body' }], []);
    expect(out[0].description).toBe('');
  });

  it('returns an empty array for no candidates', () => {
    expect(joinPrecedentOutcomes([], [logRow()])).toEqual([]);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test -- src/data/precedent.test.ts`
Expected: FAIL — `Failed to resolve import "./precedent"`.

- [ ] **Step 4: Write the implementation**

Create `extension/src/data/precedent.ts`:

```ts
// Pure precedent logic for the AI verdict card (spec §2b). Retrieval is deterministic:
// work type plus recency, no keyword guessing and no LLM-authored JQL. The model only
// ranks and summarises the candidates this module shapes.
//
// WOCOO's "work type" IS `issuetype.name` — there is no separate custom field to query.

import type { PrecedentCandidate, RecentLogRow } from './aiTriageTypes';

/** Candidate cap. Enough history to rank against without blowing the prompt budget. */
export const PRECEDENT_MAX_RESULTS = 40;

/** The subset of a Jira `TicketRow` this module needs, so the pure code stays free of
 *  the wider row type and its network origin. */
export interface PrecedentRowInput {
  id: string;
  summary: string;
  description?: string;
}

export function buildPrecedentJql(workType: string, excludeKey: string): string {
  const escaped = workType.replace(/"/g, '\\"');
  const parts = [
    'project = WOCOO',
    'statusCategory = Done',
    `issuetype = "${escaped}"`,
  ];
  if (excludeKey) parts.push(`key != ${excludeKey}`);
  return `${parts.join(' AND ')} ORDER BY created DESC`;
}

export function joinPrecedentOutcomes(
  rows: PrecedentRowInput[],
  logRows: RecentLogRow[],
): PrecedentCandidate[] {
  // getRecentLog already returns only rows with a non-empty resolution note for the
  // matching work type, so this index is exactly the join population. The trim guard
  // covers a whitespace-only cell slipping through the sheet-side filter.
  const outcomeById = new Map<string, string>();
  for (const r of logRows) {
    const note = (r.resolutionNote || '').trim();
    if (r.ticketId && note) outcomeById.set(r.ticketId, note);
  }

  return rows.map((row) => {
    const outcome = outcomeById.get(row.id) || '';
    return {
      ticketId: row.id,
      summary: row.summary,
      description: row.description || '',
      source: outcome ? ('logged' as const) : ('intake-only' as const),
      outcome,
    };
  });
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- src/data/precedent.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 6: Typecheck**

Run: `npx tsc -b`
Expected: no output. If it reports errors in `composePrompt.ts` or `AITriageCard.tsx` about a missing `source` on `SimilarTicket`, that is expected — those are Tasks 3 and 4. Leave them; do not patch them here.

- [ ] **Step 7: Commit**

```bash
git add extension/src/data/precedent.ts extension/src/data/precedent.test.ts extension/src/data/aiTriageTypes.ts
git commit -m "Add pure precedent JQL construction and the outcome join"
```

---

### Task 2: Jira precedent query

**Files:**
- Modify: `extension/src/api/jira.ts` (`TicketRow` at ~876, `searchTickets` at ~896, `extractDescription` at ~1183)

**Interfaces:**
- Consumes: `buildPrecedentJql`, `PRECEDENT_MAX_RESULTS`, `PrecedentRowInput` from `src/data/precedent.ts` (Task 1).
- Produces: `export async function searchPrecedent(workType: string, excludeKey: string): Promise<PrecedentRowInput[]>`; `searchTickets(jql, maxResults?, extraFields?)`; `TicketRow.description?: string`.

There is no unit test in this task. `searchTickets` is a thin network wrapper over `getValidAccessToken()` and `getCloudId()`, neither of which is injectable today, and it has no test on `main`. Rather than retrofit module mocking for a wrapper, Task 1 holds the logic worth testing and Task 5 exercises this path end to end. Do not add a test that asserts the wrapper calls the pure function.

- [ ] **Step 1: Add `description` to `TicketRow`**

In `extension/src/api/jira.ts`, inside the `TicketRow` interface, add after `summary`:

```ts
  /** Only populated when the caller passes `description` in `extraFields`. The Jira
   *  search response returns ADF, so this is the flattened plain text. */
  description?: string;
```

- [ ] **Step 2: Export the existing ADF flattener**

Find `function extractDescription(adfOrString: any): string` (~line 1183) and add the `export` keyword:

```ts
export function extractDescription(adfOrString: any): string {
```

Do not change its body. `getTicket` already depends on it at line 1079.

- [ ] **Step 3: Give `searchTickets` an `extraFields` parameter**

Change the signature and the `fields` array. Current signature:

```ts
export async function searchTickets(jql: string, maxResults = 50): Promise<TicketRow[]> {
```

becomes:

```ts
export async function searchTickets(
  jql: string,
  maxResults = 50,
  extraFields: string[] = [],
): Promise<TicketRow[]> {
```

and in the request body, the `fields` array:

```ts
      fields: [
        'summary', 'status', 'priority', 'issuetype', 'updated',
        'statuscategorychangedate', FIELD_TIER,
        ...extraFields,
      ],
```

Then, in the row mapping inside the same function, add `description` alongside the existing `summary` mapping:

```ts
      description: f.description === undefined ? undefined : extractDescription(f.description),
```

`HomeView.tsx:74` is the only other caller and passes neither new argument, so it keeps its current behaviour and `description` stays `undefined` there.

- [ ] **Step 4: Add the `searchPrecedent` wrapper**

Add immediately after `searchTickets`, in the same file:

```ts
/**
 * Precedent candidates for the AI verdict card (spec §2b): past Done WOCOO tickets of
 * the same work type, newest first, capped at PRECEDENT_MAX_RESULTS.
 *
 * Deliberately deterministic. Keyword JQL and LLM-authored JQL were both considered and
 * rejected: work type plus recency needs no query validation and no second round trip.
 * The accepted cost is missing precedent filed under a different work type.
 */
export async function searchPrecedent(
  workType: string,
  excludeKey: string,
): Promise<PrecedentRowInput[]> {
  if (!workType) return [];
  const rows = await searchTickets(
    buildPrecedentJql(workType, excludeKey),
    PRECEDENT_MAX_RESULTS,
    ['description'],
  );
  return rows.map((r) => ({ id: r.id, summary: r.summary, description: r.description || '' }));
}
```

Add the import at the top of `jira.ts`, next to the other `data/` imports:

```ts
import { buildPrecedentJql, PRECEDENT_MAX_RESULTS, type PrecedentRowInput } from '../data/precedent';
```

- [ ] **Step 5: Typecheck and run the whole suite**

Run: `npx tsc -b && npm test`
Expected: `tsc` reports only the pre-existing `SimilarTicket.source` errors in `composePrompt.ts` / `AITriageCard.tsx` (Tasks 3 and 4). All existing tests still pass, plus Task 1's 9.

- [ ] **Step 6: Commit**

```bash
git add extension/src/api/jira.ts
git commit -m "Query past Done WOCOO tickets of the same work type as precedent"
```

---

### Task 3: Prompt and verdict contract

**Files:**
- Modify: `extension/src/sidepanel/composePrompt.ts`
- Modify: `extension/src/sidepanel/composePrompt.test.ts`
- Modify: `extension/src/data/aiTriageTypes.ts`

**Interfaces:**
- Consumes: `PrecedentCandidate` from `src/data/aiTriageTypes.ts` (Task 1).
- Produces: `TriagePromptInput.precedent: PrecedentCandidate[]`; `parseTriageVerdict(raw: string, allowedTicketIds: string[])` — the second argument is **required**.

- [ ] **Step 1: Add `precedent` to the prompt input type**

In `extension/src/data/aiTriageTypes.ts`, add to `TriagePromptInput` after `playbookChunks`:

```ts
  precedent: PrecedentCandidate[];
```

- [ ] **Step 2: Write the failing tests**

In `extension/src/sidepanel/composePrompt.test.ts`, add this fixture next to the existing `row` and `chunk` constants:

```ts
const candidate: PrecedentCandidate = {
  ticketId: 'WOCOO-24990',
  summary: 'Interest charged after paying at 11:35 PM',
  description: 'Client made final payment at 11:35 PM on July 6; due date July 6.',
  source: 'logged',
  outcome: 'Reversed as a one-time exception.',
};

const intakeOnly: PrecedentCandidate = {
  ticketId: 'WOCOO-24715',
  summary: 'Interest Charge',
  description: 'Client paid June 26th 11:37 pm PST.',
  source: 'intake-only',
  outcome: '',
};
```

Extend its import to include `PrecedentCandidate`:

```ts
import type { RecentLogRow, PlaybookChunk, PrecedentCandidate } from '../data/aiTriageTypes';
```

Then append these two blocks to the file:

```ts
describe('buildTriagePrompt precedent block', () => {
  const base = {
    ticketId: 'WOCOO-222',
    summary: 'Client charged interest after a late-night payment',
    description: 'Paid at 11:40 PM on the due date.',
    workType: 'Credit Card: Statements',
    allowedWorkTypes: ['Credit Card: Statements'],
    recentRows: [] as RecentLogRow[],
    playbookChunks: [] as PlaybookChunk[],
  };

  it('renders each candidate with its key, summary, description and outcome', () => {
    const user = buildTriagePrompt({ ...base, precedent: [candidate] })[1].content;
    expect(user).toContain('PRECEDENT CANDIDATES');
    expect(user).toContain('WOCOO-24990');
    expect(user).toContain('Interest charged after paying at 11:35 PM');
    expect(user).toContain('Client made final payment at 11:35 PM on July 6');
    expect(user).toContain('Reversed as a one-time exception.');
  });

  it('labels a candidate with no resolution note as intake-only', () => {
    const user = buildTriagePrompt({ ...base, precedent: [intakeOnly] })[1].content;
    expect(user).toContain('intake-only');
    expect(user).not.toContain('outcome: \n');
  });

  it('renders (none) when there are no candidates', () => {
    const user = buildTriagePrompt({ ...base, precedent: [] })[1].content;
    expect(user).toContain('PRECEDENT CANDIDATES');
    expect(user).toContain('(none)');
  });

  it('renders all 40 candidates when the cap is full', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ ...candidate, ticketId: `WOCOO-${1000 + i}` }));
    const user = buildTriagePrompt({ ...base, precedent: many })[1].content;
    expect(user).toContain('WOCOO-1000');
    expect(user).toContain('WOCOO-1039');
  });

  it('forbids citing a key outside the candidate block', () => {
    const system = buildTriagePrompt({ ...base, precedent: [candidate] })[0].content;
    expect(system.toLowerCase()).toContain('candidate');
  });
});

describe('parseTriageVerdict candidate-set validation', () => {
  it('keeps a cited key that is in the candidate set and carries its source', () => {
    const res = parseTriageVerdict(JSON.stringify({
      work_type: 'Credit Card: Statements',
      confidence: 'high',
      similar_tickets: [{ ticket_id: 'WOCOO-24990', what_happened: 'Reversed once.', source: 'logged' }],
    }), ['WOCOO-24990']);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.verdict.similarTickets).toEqual([
      { ticketId: 'WOCOO-24990', whatHappened: 'Reversed once.', source: 'logged' },
    ]);
  });

  it('drops a cited key that is not in the candidate set', () => {
    const res = parseTriageVerdict(JSON.stringify({
      work_type: 'Credit Card: Statements',
      similar_tickets: [
        { ticket_id: 'WOCOO-24990', what_happened: 'Real.', source: 'logged' },
        { ticket_id: 'WOCOO-99999', what_happened: 'Invented.', source: 'logged' },
      ],
    }), ['WOCOO-24990']);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.verdict.similarTickets.map((s) => s.ticketId)).toEqual(['WOCOO-24990']);
  });

  it('defaults an unrecognised source to intake-only', () => {
    const res = parseTriageVerdict(JSON.stringify({
      work_type: 'Overpayment',
      similar_tickets: [{ ticket_id: 'WOCOO-100', what_happened: 'x', source: 'guessed' }],
    }), ['WOCOO-100']);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.verdict.similarTickets[0].source).toBe('intake-only');
  });

  it('accepts an empty similar_tickets array', () => {
    const res = parseTriageVerdict(JSON.stringify({
      work_type: 'Overpayment', similar_tickets: [],
    }), ['WOCOO-100']);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.verdict.similarTickets).toEqual([]);
  });
});
```

- [ ] **Step 3: Add the second argument at the five existing call sites**

Still in `composePrompt.test.ts`, the existing `parseTriageVerdict` calls at lines ~74, ~92, ~98, ~103 and ~109 take one argument. Add `, []` to each — none of them assert on `similar_tickets`, so an empty candidate set is correct for all five. Also add `precedent: []` to the existing `buildTriagePrompt` calls in the file; the field is now required.

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npm test -- src/sidepanel/composePrompt.test.ts`
Expected: FAIL — TypeScript/Vitest errors on the extra `parseTriageVerdict` argument and missing `PRECEDENT CANDIDATES` text.

- [ ] **Step 5: Implement the prompt changes**

In `extension/src/sidepanel/composePrompt.ts`:

Extend the type import:

```ts
import type {
  PlaybookChunk,
  PrecedentCandidate,
  RecentLogRow,
  TriageConfidence,
  TriagePromptInput,
  TriageVerdict,
} from '../data/aiTriageTypes';
```

Add one line to `SYSTEM`, after the "Never invent a work type" line:

```ts
  'Never cite a ticket key that does not appear in the PRECEDENT CANDIDATES block.',
```

Replace `OUTPUT_CONTRACT`'s `similar_tickets` line so the shape matches the new type:

```ts
  "similar_tickets": [{ "ticket_id": "WOCOO-123", "what_happened": "<one line>", "source": "logged" | "intake-only" }],
```

Add a renderer next to `renderRow` and `renderChunk`:

```ts
function renderCandidate(c: PrecedentCandidate): string {
  return [
    `- ${c.ticketId} [${c.source}]`,
    `  summary: ${c.summary}`,
    c.description ? `  request: ${c.description}` : '',
    c.outcome ? `  outcome: ${c.outcome}` : '  outcome: (not recorded — treat the request text as context, not as a resolution)',
  ].filter(Boolean).join('\n');
}
```

In `buildTriagePrompt`, add the candidate string next to `rows` and `chunks`:

```ts
  const candidates = input.precedent.length ? input.precedent.map(renderCandidate).join('\n') : '(none)';
```

and insert this section into the `user` array between `'## Playbook excerpts', chunks,` and `'## Output',`:

```ts
    '',
    '## PRECEDENT CANDIDATES',
    'Past Done WOCOO tickets of the same work type. Rank these, keep the best 3-5, and',
    'cite their keys verbatim. A candidate marked intake-only has no recorded outcome:',
    'its text is the original request, not what was done.',
    candidates,
```

- [ ] **Step 6: Implement the parse changes**

Replace the `similar` block and the signature in `parseTriageVerdict`:

```ts
export function parseTriageVerdict(
  raw: string,
  allowedTicketIds: string[],
): { ok: true; verdict: TriageVerdict } | { ok: false; error: string } {
```

and, after the `work_type` guard, replace the existing `const similar = ...` with:

```ts
  // The model will otherwise emit plausible-looking WOCOO keys that do not exist, so
  // anything outside the candidate set it was handed is dropped rather than rendered.
  const allowed = new Set(allowedTicketIds);
  const similar = Array.isArray(obj.similar_tickets)
    ? obj.similar_tickets
        .filter((s: any) => s && typeof s === 'object')
        .map((s: any) => ({
          ticketId: String(s.ticket_id ?? ''),
          whatHappened: String(s.what_happened ?? ''),
          source: s.source === 'logged' ? ('logged' as const) : ('intake-only' as const),
        }))
        .filter((s: { ticketId: string }) => s.ticketId && allowed.has(s.ticketId))
    : [];
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm test -- src/sidepanel/composePrompt.test.ts`
Expected: PASS — the existing cases plus 9 new ones.

- [ ] **Step 8: Commit**

```bash
git add extension/src/sidepanel/composePrompt.ts extension/src/sidepanel/composePrompt.test.ts extension/src/data/aiTriageTypes.ts
git commit -m "Hand precedent candidates to the model and reject keys it invents"
```

---

### Task 4: Card wiring and degradation

**Files:**
- Modify: `extension/src/sidepanel/AITriageCard.tsx`

**Interfaces:**
- Consumes: `searchPrecedent` from `src/api/jira.ts` (Task 2); `joinPrecedentOutcomes` from `src/data/precedent.ts` (Task 1); `buildTriagePrompt` / `parseTriageVerdict` from `./composePrompt` (Task 3).
- Produces: no new exports.

There is no unit test in this task. `vitest.config.ts` sets `include: ['src/**/*.test.ts']` — `.tsx` is not matched, and this repo has no component-test setup (no jsdom, no Testing Library). Adding one is out of scope for this plan. Task 5 verifies this task by hand.

- [ ] **Step 1: Add the imports**

```ts
import { getRecentLogViaBridge, getPlaybookViaBridge } from '../api/bridge';
import { searchPrecedent } from '../api/jira';
import { joinPrecedentOutcomes } from '../data/precedent';
```

- [ ] **Step 2: Fetch precedent in parallel, degrading on failure**

Inside `getOrCompute`'s callback, replace the existing two-way `Promise.all` with:

```ts
        const [recentRows, playbookChunks, precedentRows] = await Promise.all([
          getRecentLogViaBridge(ticket.workType),
          getPlaybookViaBridge(),
          // A precedent-fetch failure must not fail the card: the verdict still renders
          // from log plus playbook. Spec §2b, Degradation.
          searchPrecedent(ticket.workType, ticket.id).catch(() => null),
        ]);
        setPrecedentFailed(precedentRows === null);
        const precedent = joinPrecedentOutcomes(precedentRows ?? [], recentRows);
```

- [ ] **Step 3: Pass precedent into the prompt and the parser**

In the same callback, add `precedent,` to the `buildTriagePrompt` argument object (after `playbookChunks,`), and give `parseTriageVerdict` the candidate set:

```ts
        const parsed = parseTriageVerdict(raw, precedent.map((c) => c.ticketId));
```

- [ ] **Step 4: Track the degradation flag**

Add next to the existing `useState`:

```ts
  const [precedentFailed, setPrecedentFailed] = useState(false);
```

Reset it at the top of `run`, alongside `setState({ kind: 'loading' })`:

```ts
    setPrecedentFailed(false);
```

- [ ] **Step 5: Render the source badge and the degradation notice**

Replace the existing similar-tickets block with:

```tsx
      {v.similarTickets.length > 0 && (
        <div style={{ marginTop: 'var(--mint-sp-2)' }}>
          <div style={{ ...mutedStyle, fontWeight: 600 }}>Precedent</div>
          {v.similarTickets.map((s) => (
            <div key={s.ticketId} style={mutedStyle}>
              <a
                href={`https://wealthsimple.atlassian.net/browse/${s.ticketId}`}
                target="_blank"
                rel="noreferrer"
                style={{ color: 'var(--mint-fg-strong)' }}
              >{s.ticketId}</a>
              <SourceBadge source={s.source} />
              {' — '}{s.whatHappened}
            </div>
          ))}
        </div>
      )}

      {precedentFailed && (
        <div style={{ ...mutedStyle, color: 'var(--mint-fg-soft)' }}>
          Precedent unavailable — verdict is from your log and playbook only.
        </div>
      )}
```

and add the badge component next to `ConfidenceChip`:

```tsx
function SourceBadge({ source }: { source: 'logged' | 'intake-only' }) {
  // intake-only means we only have the original request, never the outcome. Say so, so
  // the request text is not read as a resolution.
  const logged = source === 'logged';
  return (
    <span
      title={logged ? 'You logged a resolution note for this ticket' : 'No recorded outcome — request text only'}
      style={{
        marginLeft: 6,
        fontSize: 'var(--mint-text-nano)',
        fontWeight: 600,
        color: logged ? 'var(--mint-positive-fg-strong)' : 'var(--mint-fg-soft)',
      }}
    >{logged ? 'logged' : 'intake only'}</span>
  );
}
```

Also change the loading copy, since the card now reads the board too:

```tsx
        <div style={mutedStyle}>Reading your log, playbook and past tickets…</div>
```

- [ ] **Step 6: Typecheck and run the full suite**

Run: `npx tsc -b && npm test`
Expected: `tsc` clean, no output. All tests pass.

- [ ] **Step 7: Build**

Run: `npm run build`
Expected: succeeds, writes `extension/dist/`.

- [ ] **Step 8: Commit**

```bash
git add extension/src/sidepanel/AITriageCard.tsx
git commit -m "Ground the verdict card in board precedent, degrading when the query fails"
```

---

### Task 5: On-VPN acceptance

**Files:** none — this task is verification. It produces a findings note, not code.

**Interfaces:**
- Consumes: everything from Tasks 1-4, built into `extension/dist/`.
- Produces: a pass/fail report against the four checks below.

Prerequisites, all required: on VPN; signed into `wealthsimple.atlassian.net` via Okta in a normal tab; an LLM Gateway key saved in the extension's Settings; the `Playbook` and `Log` tabs present on spreadsheet `1UnCQoj_oPiJshzP65QpU0hp6-DmcLtN-6H4WLV7HbPw`.

- [ ] **Step 1: Reload the extension**

Open `chrome://extensions`, hit ↻ on WOCOO Triager. MV3 does not hot-reload; a rebuild without this step runs the old code.

- [ ] **Step 2: Precedent acceptance check**

Open `https://wealthsimple.atlassian.net/browse/WOCOO-26433` (interest charged despite an on-time payment, work type `Prepaid Card: Other`) and then a `Credit Card: Statements` cutoff ticket such as `WOCOO-24990`.

Expected on the `Credit Card: Statements` ticket: the AI verdict card cites `WOCOO-24990` and `WOCOO-24715` among its precedent. This is the spec's acceptance check — both are Done, both are late-night-payment interest tickets.

Record what it actually cited. If neither appears, do not patch the prompt blind: first confirm the two tickets' `issuetype.name` matches the current ticket's, since recall is bounded by work type (spec, Open risks).

- [ ] **Step 3: Source badge check**

On the same card, confirm at least one cited ticket shows a badge. A ticket you logged with a resolution note must read `logged`; one you did not must read `intake only`. A ticket badged `logged` whose `what_happened` restates the original request is a real bug — report it.

- [ ] **Step 4: Degradation check**

Open DevTools on the sidepanel, go offline for Jira only by blocking `api.atlassian.com` in the Network request-blocking panel, then click Regenerate.

Expected: the card still renders a verdict, plus "Precedent unavailable — verdict is from your log and playbook only." A card that goes to its error state instead means the `.catch(() => null)` is not covering the failure.

- [ ] **Step 5: Report**

Write the four results into the task's completion note: what the card cited, badge correctness, degradation behaviour, and any prompt-quality observation worth a follow-up. Do not open a follow-up commit from this task.

---

## Self-Review

**Spec coverage.**

- §1 Architecture, four participants and the 7-step flow — Tasks 2 (Jira REST), 4 (parallel fetch, join, order).
- §2 Bridge changes — already on `main` (`40dc503`). No task; nothing in this plan changes the bridge.
- §2b Candidate query — Task 2. Fields — Task 2. Outcome join — Task 1. Why-not-keyword rationale — captured as a comment in Task 2 Step 4. Degradation — Task 4 Step 2.
- §3 File layout — `aiTriageTypes.ts` Task 1; `jira.ts` Task 2; `composePrompt.ts` Task 3; `AITriageCard.tsx` Task 4. `llmGateway.ts`, `aiTriageCache.ts`, `SidePanel.tsx`, `SettingsView.tsx`, `manifest.json` are already done on `main` — listed under Prior state.
- §4 Prompt shape, five parts and the candidate guardrail — Task 3.
- §5 Settings — already on `main` (`dd26cd5`).
- §6 Caching — unchanged by this plan; the cache key stays the current ticket's `fields.updated`, which is the freshness risk the spec records.
- Testing section — Task 1 (join, labelling), Task 3 (prompt with 0/1/40 candidates, key rejection), Task 5 (the 24990/24715 acceptance check).

**Placeholder scan.** No TBD/TODO. Every code step carries the actual code. Tasks 2 and 4 state plainly why they carry no unit test rather than leaving it unexplained.

**Type consistency.** `PrecedentCandidate` fields (`ticketId`, `summary`, `description`, `source`, `outcome`) are identical in Task 1's definition, Task 1's tests, Task 3's fixtures and `renderCandidate`. `SimilarTicket.source` is added in Task 1 and consumed in Tasks 3 and 4 with the same `'logged' | 'intake-only'` union. `parseTriageVerdict`'s second parameter is required in Task 3 and supplied in Task 4 Step 3 and at all five existing test sites in Task 3 Step 3. `PrecedentRowInput` is defined in Task 1 and returned by Task 2's `searchPrecedent`. `PRECEDENT_MAX_RESULTS` is defined once in Task 1 and used once in Task 2.

**Known ordering consequence.** Task 1 leaves `tsc` failing on `SimilarTicket.source` until Task 3 lands. This is called out in Task 1 Step 6 so an executor does not treat it as their own error, and it is the reason Task 1 does not run the full build.
