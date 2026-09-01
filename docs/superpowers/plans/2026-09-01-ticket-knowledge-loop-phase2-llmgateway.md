# Ticket Knowledge Loop Phase 2 (Retrieval) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the sidepanel's heuristic suggested-response with an AI verdict card grounded in Albert's own resolved-ticket log and his Notion playbook, powered by the WS LLM Gateway called directly from the extension.

**Architecture:** The Apps Script bridge stays a pure data layer exposing two new read-only actions (`getRecentLog`, `getPlaybook`) over the WOCOO Ticket Log spreadsheet. The extension does retrieval orchestration, prompt construction, the `llm.w10e.com` call, in-memory caching, and rendering. The bridge cannot call the gateway — the gateway is VPN-locked and Apps Script runs outside the VPN.

**Tech Stack:** TypeScript, React 18, Vite + @crxjs (MV3), Vitest (node environment, `src/**/*.test.ts`), Google Apps Script (edited in the web editor only).

**Spec:** `docs/superpowers/specs/2026-09-01-ticket-knowledge-loop-phase2-llmgateway-design.md`

## Global Constraints

- Gateway endpoint: `POST https://llm.w10e.com/api/v2/chat/completions`.
- Auth header: `X-LiteLLM-Dev-Key: <key>` — **not** `Authorization: Bearer`.
- Model: `bedrock-claude-sonnet-4-6`. Private VPC-hosted models only — external models apply WS PII masking and mangle client names/emails in ticket text.
- Request body includes `"response_format": { "type": "json_object" }`.
- Call timeout: 45s, via `AbortController`.
- Cache TTL: 30 minutes, in-memory only. Not `chrome.storage.session`, not `.local`.
- Spreadsheet: `1UnCQoj_oPiJshzP65QpU0hp6-DmcLtN-6H4WLV7HbPw`. Tabs: `Log` (existing, 18 columns), `Playbook` (new).
- `Log` columns in order: `logged_at`, `ticket_id`, `ticket_link`, `summary`, `description_snippet`, `original_work_type`, `final_work_type`, `transition`, `moved_to_board`, `resolution_note`, `tools_used`, `mistriaged`, `novel_pattern`, `novel_note`, `time_on_ticket_minutes`, `embedding`, `embedded_at`, `promoted_at`. Leave `embedding` / `embedded_at` unused.
- `Playbook` columns in order: `page_id`, `page_title`, `parent_path`, `chunk_key`, `chunk_text`, `updated_at`.
- Notion source is **Albert's WOCOO Ticket Playbook** (`39241167-bd96-81d5-92b1-da6303f0b22c`) only. The shared team page is never a source.
- **No clasp.** All Apps Script changes are pasted by the user into the web editor, and are strictly additive — existing bridge handlers must not be rewritten.
- Every new bridge handler follows the `_handle<Action>FromGet_` + postMessage-in-HTML pattern. A handler that returns JSON directly works under the GAS Run button but never resolves through the browser bridge.
- Run tests with `npm test` from `extension/`.

---

### Task 1: Verdict types and the prompt builder

**Files:**
- Create: `extension/src/data/aiTriageTypes.ts`
- Create: `extension/src/sidepanel/composePrompt.ts`
- Test: `extension/src/sidepanel/composePrompt.test.ts`

**Interfaces:**
- Consumes: `WocooTicket` from `../data/mockTicket`.
- Produces: `TriageVerdict`, `RecentLogRow`, `PlaybookChunk`, `TriagePromptInput`; `buildTriagePrompt(input: TriagePromptInput): Array<{ role: 'system' | 'user'; content: string }>`; `parseTriageVerdict(raw: string): { ok: true; verdict: TriageVerdict } | { ok: false; error: string }`.

- [ ] **Step 1: Write the failing test**

```ts
// extension/src/sidepanel/composePrompt.test.ts
import { describe, it, expect } from 'vitest';
import { buildTriagePrompt, parseTriageVerdict } from './composePrompt';
import type { RecentLogRow, PlaybookChunk } from '../data/aiTriageTypes';

const row: RecentLogRow = {
  loggedAt: '2026-08-01T10:00:00Z',
  ticketId: 'WOCOO-100',
  summary: 'Duplicate payment posted twice',
  originalWorkType: 'Overpayment',
  finalWorkType: 'Overpayment',
  transition: 'Done',
  movedToBoard: '',
  resolutionNote: 'Refunded via CRED, client confirmed.',
  toolsUsed: 'Atlas, Ledge',
};

const chunk: PlaybookChunk = {
  pageId: 'p1',
  pageTitle: 'Overpayment',
  parentPath: 'Work types',
  chunkKey: 'p1#steps',
  chunkText: 'Check Ledge for the duplicate before refunding.',
  updatedAt: '2026-08-01T00:00:00Z',
};

describe('buildTriagePrompt', () => {
  it('puts ticket, log rows and playbook chunks in the user message', () => {
    const msgs = buildTriagePrompt({
      ticketId: 'WOCOO-222',
      summary: 'Client charged twice',
      description: 'Two identical charges on the same day.',
      workType: 'Overpayment',
      allowedWorkTypes: ['Overpayment', 'Reverse Fee'],
      recentRows: [row],
      playbookChunks: [chunk],
    });
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe('system');
    const user = msgs[1].content;
    expect(user).toContain('WOCOO-222');
    expect(user).toContain('Refunded via CRED, client confirmed.');
    expect(user).toContain('Check Ledge for the duplicate before refunding.');
  });

  it('lists the allowed work types so the model cannot invent one', () => {
    const msgs = buildTriagePrompt({
      ticketId: 'WOCOO-222',
      summary: 's',
      description: 'd',
      workType: 'Overpayment',
      allowedWorkTypes: ['Overpayment', 'Reverse Fee'],
      recentRows: [],
      playbookChunks: [],
    });
    expect(msgs[1].content).toContain('Reverse Fee');
  });

  it('says so explicitly when there is no prior history', () => {
    const msgs = buildTriagePrompt({
      ticketId: 'WOCOO-222',
      summary: 's',
      description: 'd',
      workType: 'Overpayment',
      allowedWorkTypes: ['Overpayment'],
      recentRows: [],
      playbookChunks: [],
    });
    expect(msgs[1].content).toContain('(none)');
  });
});

describe('parseTriageVerdict', () => {
  it('parses a well-formed verdict', () => {
    const res = parseTriageVerdict(JSON.stringify({
      work_type: 'Overpayment',
      confidence: 'high',
      rationale: 'Matches two prior tickets.',
      steps: ['Check Ledge', 'Refund via CRED'],
      similar_tickets: [{ ticket_id: 'WOCOO-100', what_happened: 'Refunded via CRED.' }],
      gotchas: ['Confirm the second charge settled.'],
    }));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.verdict.workType).toBe('Overpayment');
      expect(res.verdict.confidence).toBe('high');
      expect(res.verdict.steps).toEqual(['Check Ledge', 'Refund via CRED']);
      expect(res.verdict.similarTickets[0].ticketId).toBe('WOCOO-100');
    }
  });

  it('returns an error instead of throwing on malformed JSON', () => {
    const res = parseTriageVerdict('not json at all');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/parse/i);
  });

  it('returns an error when work_type is missing', () => {
    const res = parseTriageVerdict(JSON.stringify({ confidence: 'high' }));
    expect(res.ok).toBe(false);
  });

  it('falls back to low confidence when the value is not a known level', () => {
    const res = parseTriageVerdict(JSON.stringify({ work_type: 'Overpayment', confidence: 'certain' }));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.verdict.confidence).toBe('low');
  });

  it('tolerates a fenced code block around the JSON', () => {
    const res = parseTriageVerdict('```json\n{"work_type":"Overpayment"}\n```');
    expect(res.ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extension && npx vitest run src/sidepanel/composePrompt.test.ts`
Expected: FAIL — cannot resolve `./composePrompt`.

- [ ] **Step 3: Write the types**

```ts
// extension/src/data/aiTriageTypes.ts
// Shapes for the AI verdict card (Ticket Knowledge Loop Phase 2). Kept in data/ next to
// the other pure ticket types so the prompt builder and the card share one definition.

export type TriageConfidence = 'high' | 'medium' | 'low';

/** One prior resolved ticket, as returned by the bridge's `getRecentLog`. */
export interface RecentLogRow {
  loggedAt: string;
  ticketId: string;
  summary: string;
  originalWorkType: string;
  finalWorkType: string;
  transition: string;
  movedToBoard: string;
  resolutionNote: string;
  toolsUsed: string;
}

/** One chunk of the Notion playbook, mirrored into the `Playbook` sheet tab. */
export interface PlaybookChunk {
  pageId: string;
  pageTitle: string;
  parentPath: string;
  chunkKey: string;
  chunkText: string;
  updatedAt: string;
}

export interface SimilarTicket {
  ticketId: string;
  whatHappened: string;
}

/** The model's answer, after parsing and validation. */
export interface TriageVerdict {
  workType: string;
  confidence: TriageConfidence;
  rationale: string;
  steps: string[];
  similarTickets: SimilarTicket[];
  gotchas: string[];
}

export interface TriagePromptInput {
  ticketId: string;
  summary: string;
  description: string;
  workType: string;
  allowedWorkTypes: string[];
  recentRows: RecentLogRow[];
  playbookChunks: PlaybookChunk[];
}
```

- [ ] **Step 4: Write the prompt builder**

```ts
// extension/src/sidepanel/composePrompt.ts
// Pure prompt construction + response parsing. No network, no chrome APIs — everything
// here is unit-tested, so prompt iteration costs an HMR reload rather than a GAS deploy.

import type {
  PlaybookChunk,
  RecentLogRow,
  TriageConfidence,
  TriagePromptInput,
  TriageVerdict,
} from '../data/aiTriageTypes';

const SYSTEM = [
  'You are a triage assistant for a Wealthsimple client-experience agent working WOCOO tickets.',
  'You answer only from the prior resolved tickets and playbook excerpts you are given.',
  'Never invent a work type that is not in the allowed list.',
  'When the history does not support a confident answer, say so and set confidence to "low".',
  'Reply with a single JSON object and nothing else.',
].join(' ');

const OUTPUT_CONTRACT = `Reply with JSON of exactly this shape:
{
  "work_type": "<one of the allowed work types>",
  "confidence": "high" | "medium" | "low",
  "rationale": "<two sentences at most>",
  "steps": ["<ordered action>", "..."],
  "similar_tickets": [{ "ticket_id": "WOCOO-123", "what_happened": "<one line>" }],
  "gotchas": ["<one line>", "..."]
}`;

function renderRow(r: RecentLogRow): string {
  const moved = r.movedToBoard ? ` -> ${r.movedToBoard}` : '';
  return [
    `- ${r.ticketId} (${r.loggedAt}) [${r.originalWorkType} -> ${r.finalWorkType}${moved}, ${r.transition}]`,
    `  summary: ${r.summary}`,
    `  resolution: ${r.resolutionNote}`,
    r.toolsUsed ? `  tools: ${r.toolsUsed}` : '',
  ].filter(Boolean).join('\n');
}

function renderChunk(c: PlaybookChunk): string {
  return `- [${c.parentPath} / ${c.pageTitle}] ${c.chunkText}`;
}

export function buildTriagePrompt(input: TriagePromptInput): Array<{ role: 'system' | 'user'; content: string }> {
  const rows = input.recentRows.length ? input.recentRows.map(renderRow).join('\n') : '(none)';
  const chunks = input.playbookChunks.length ? input.playbookChunks.map(renderChunk).join('\n') : '(none)';

  const user = [
    '## Current ticket',
    `id: ${input.ticketId}`,
    `current work type: ${input.workType}`,
    `summary: ${input.summary}`,
    `description: ${input.description}`,
    '',
    '## Allowed work types',
    input.allowedWorkTypes.map((w) => `- ${w}`).join('\n') || '(none)',
    '',
    '## Prior resolved tickets',
    rows,
    '',
    '## Playbook excerpts',
    chunks,
    '',
    '## Output',
    OUTPUT_CONTRACT,
  ].join('\n');

  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: user },
  ];
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean) : [];
}

function asConfidence(v: unknown): TriageConfidence {
  return v === 'high' || v === 'medium' || v === 'low' ? v : 'low';
}

/** Strip a ```json fence if the model wrapped its answer in one. */
function unfence(raw: string): string {
  const m = raw.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return m ? m[1] : raw.trim();
}

export function parseTriageVerdict(
  raw: string,
): { ok: true; verdict: TriageVerdict } | { ok: false; error: string } {
  let obj: any;
  try {
    obj = JSON.parse(unfence(raw));
  } catch {
    return { ok: false, error: 'Could not parse the model response as JSON.' };
  }
  if (!obj || typeof obj !== 'object') {
    return { ok: false, error: 'Could not parse the model response as JSON.' };
  }
  if (!obj.work_type || typeof obj.work_type !== 'string') {
    return { ok: false, error: 'The model response is missing work_type.' };
  }
  const similar = Array.isArray(obj.similar_tickets)
    ? obj.similar_tickets
        .filter((s: any) => s && typeof s === 'object')
        .map((s: any) => ({
          ticketId: String(s.ticket_id ?? ''),
          whatHappened: String(s.what_happened ?? ''),
        }))
        .filter((s: { ticketId: string }) => s.ticketId)
    : [];

  return {
    ok: true,
    verdict: {
      workType: obj.work_type,
      confidence: asConfidence(obj.confidence),
      rationale: String(obj.rationale ?? ''),
      steps: asStringArray(obj.steps),
      similarTickets: similar,
      gotchas: asStringArray(obj.gotchas),
    },
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd extension && npx vitest run src/sidepanel/composePrompt.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 6: Commit**

```bash
git add extension/src/data/aiTriageTypes.ts extension/src/sidepanel/composePrompt.ts extension/src/sidepanel/composePrompt.test.ts
git commit -m "Add the triage verdict types, prompt builder and response parser"
```

---

### Task 2: Verdict cache with TTL and in-flight dedup

**Files:**
- Create: `extension/src/sidepanel/aiTriageCache.ts`
- Test: `extension/src/sidepanel/aiTriageCache.test.ts`

**Interfaces:**
- Consumes: `TriageVerdict` from `../data/aiTriageTypes`.
- Produces: `getOrCompute(ticketId: string, versionTag: string, compute: () => Promise<TriageVerdict>): Promise<TriageVerdict>`; `invalidate(ticketId: string, versionTag: string): void`; `clearAll(): void`; `TRIAGE_CACHE_TTL_MS` (number, 1_800_000).

- [ ] **Step 1: Write the failing test**

```ts
// extension/src/sidepanel/aiTriageCache.test.ts
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { getOrCompute, invalidate, clearAll, TRIAGE_CACHE_TTL_MS } from './aiTriageCache';
import type { TriageVerdict } from '../data/aiTriageTypes';

const verdict = (workType: string): TriageVerdict => ({
  workType,
  confidence: 'high',
  rationale: '',
  steps: [],
  similarTickets: [],
  gotchas: [],
});

describe('aiTriageCache', () => {
  beforeEach(() => { clearAll(); vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('computes once and serves the cached value on the second call', async () => {
    const compute = vi.fn(async () => verdict('Overpayment'));
    const a = await getOrCompute('WOCOO-1', 'v1', compute);
    const b = await getOrCompute('WOCOO-1', 'v1', compute);
    expect(compute).toHaveBeenCalledTimes(1);
    expect(a.workType).toBe('Overpayment');
    expect(b.workType).toBe('Overpayment');
  });

  it('recomputes after the TTL expires', async () => {
    const compute = vi.fn(async () => verdict('Overpayment'));
    await getOrCompute('WOCOO-1', 'v1', compute);
    vi.advanceTimersByTime(TRIAGE_CACHE_TTL_MS + 1);
    await getOrCompute('WOCOO-1', 'v1', compute);
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it('treats a changed versionTag as a different ticket state', async () => {
    const compute = vi.fn(async () => verdict('Overpayment'));
    await getOrCompute('WOCOO-1', 'v1', compute);
    await getOrCompute('WOCOO-1', 'v2', compute);
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it('shares one in-flight promise between concurrent callers', async () => {
    let resolve!: (v: TriageVerdict) => void;
    const compute = vi.fn(() => new Promise<TriageVerdict>((r) => { resolve = r; }));
    const p1 = getOrCompute('WOCOO-1', 'v1', compute);
    const p2 = getOrCompute('WOCOO-1', 'v1', compute);
    resolve(verdict('Overpayment'));
    await Promise.all([p1, p2]);
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it('does not cache failures', async () => {
    const compute = vi.fn()
      .mockRejectedValueOnce(new Error('gateway down'))
      .mockResolvedValueOnce(verdict('Overpayment'));
    await expect(getOrCompute('WOCOO-1', 'v1', compute)).rejects.toThrow('gateway down');
    const second = await getOrCompute('WOCOO-1', 'v1', compute);
    expect(second.workType).toBe('Overpayment');
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it('invalidate forces a recompute for that key', async () => {
    const compute = vi.fn(async () => verdict('Overpayment'));
    await getOrCompute('WOCOO-1', 'v1', compute);
    invalidate('WOCOO-1', 'v1');
    await getOrCompute('WOCOO-1', 'v1', compute);
    expect(compute).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extension && npx vitest run src/sidepanel/aiTriageCache.test.ts`
Expected: FAIL — cannot resolve `./aiTriageCache`.

- [ ] **Step 3: Write the cache**

```ts
// extension/src/sidepanel/aiTriageCache.ts
// In-memory verdict cache for the AI triage card.
//
// Deliberately NOT chrome.storage.session or .local: closing the side panel drops the
// cache and the next open pays for a fresh gateway call. That is the accepted trade for
// having no persistence or eviction logic to maintain. Revisit if the call volume ever
// becomes annoying in daily use.

import type { TriageVerdict } from '../data/aiTriageTypes';

export const TRIAGE_CACHE_TTL_MS = 30 * 60 * 1000;

interface Entry {
  verdict: TriageVerdict;
  storedAt: number;
}

const entries = new Map<string, Entry>();
const inFlight = new Map<string, Promise<TriageVerdict>>();

function keyOf(ticketId: string, versionTag: string): string {
  return `${ticketId}::${versionTag}`;
}

export function getOrCompute(
  ticketId: string,
  versionTag: string,
  compute: () => Promise<TriageVerdict>,
): Promise<TriageVerdict> {
  const key = keyOf(ticketId, versionTag);

  const hit = entries.get(key);
  if (hit && Date.now() - hit.storedAt < TRIAGE_CACHE_TTL_MS) {
    return Promise.resolve(hit.verdict);
  }
  if (hit) entries.delete(key);

  // Rapid open/close of the side panel would otherwise fan out into duplicate calls.
  const running = inFlight.get(key);
  if (running) return running;

  const p = compute()
    .then((verdict) => {
      entries.set(key, { verdict, storedAt: Date.now() });
      return verdict;
    })
    .finally(() => {
      inFlight.delete(key);
    });

  inFlight.set(key, p);
  return p;
}

/** Drop the cached verdict for one ticket state. Used by the card's Regenerate button. */
export function invalidate(ticketId: string, versionTag: string): void {
  entries.delete(keyOf(ticketId, versionTag));
}

export function clearAll(): void {
  entries.clear();
  inFlight.clear();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd extension && npx vitest run src/sidepanel/aiTriageCache.test.ts`
Expected: PASS, 6 tests. Failures are never stored — the `.then` that writes the entry does not run on rejection.

- [ ] **Step 5: Commit**

```bash
git add extension/src/sidepanel/aiTriageCache.ts extension/src/sidepanel/aiTriageCache.test.ts
git commit -m "Cache triage verdicts in memory with a TTL and in-flight dedup"
```

---

### Task 3: LLM Gateway client and key storage

**Files:**
- Modify: `extension/src/auth/credentials.ts` (append; do not touch the i2c helpers)
- Create: `extension/src/api/llmGateway.ts`
- Modify: `extension/manifest.json:74-86` (`host_permissions`)
- Test: `extension/src/api/llmGateway.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `getLlmGatewayKey(): Promise<string | null>`, `setLlmGatewayKey(key: string): Promise<void>`, `clearLlmGatewayKey(): Promise<void>` from `../auth/credentials`; `callLlmGateway(messages, key, opts?): Promise<string>` and `pingLlmGateway(key: string): Promise<{ ok: true } | { ok: false; error: string }>` from `./llmGateway`.

- [ ] **Step 1: Write the failing test**

```ts
// extension/src/api/llmGateway.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { callLlmGateway, pingLlmGateway, LLM_GATEWAY_URL, LLM_GATEWAY_MODEL } from './llmGateway';

afterEach(() => { vi.restoreAllMocks(); });

function mockFetchOnce(body: unknown, ok = true, status = 200) {
  const fetchMock = vi.fn(async () => ({
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  })) as unknown as typeof fetch;
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock as unknown as ReturnType<typeof vi.fn>;
}

describe('callLlmGateway', () => {
  it('posts to the gateway with the dev-key header and json_object mode', async () => {
    const fetchMock = mockFetchOnce({ choices: [{ message: { content: '{"work_type":"X"}' } }] });
    const out = await callLlmGateway([{ role: 'user', content: 'hi' }], 'sk-test');
    expect(out).toBe('{"work_type":"X"}');

    const [url, init] = (fetchMock as any).mock.calls[0];
    expect(url).toBe(LLM_GATEWAY_URL);
    expect((init.headers as Record<string, string>)['X-LiteLLM-Dev-Key']).toBe('sk-test');
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe(LLM_GATEWAY_MODEL);
    expect(body.response_format).toEqual({ type: 'json_object' });
  });

  it('throws a VPN-aware message on a network failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    await expect(callLlmGateway([{ role: 'user', content: 'hi' }], 'sk-test'))
      .rejects.toThrow(/VPN/i);
  });

  it('throws on a non-OK status', async () => {
    mockFetchOnce({ error: 'nope' }, false, 401);
    await expect(callLlmGateway([{ role: 'user', content: 'hi' }], 'sk-bad'))
      .rejects.toThrow(/401/);
  });

  it('throws when the response has no content', async () => {
    mockFetchOnce({ choices: [] });
    await expect(callLlmGateway([{ role: 'user', content: 'hi' }], 'sk-test'))
      .rejects.toThrow(/empty/i);
  });
});

describe('pingLlmGateway', () => {
  it('reports ok on a successful call', async () => {
    mockFetchOnce({ choices: [{ message: { content: '{}' } }] });
    expect(await pingLlmGateway('sk-test')).toEqual({ ok: true });
  });

  it('names both the key and the VPN when the call fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    const res = await pingLlmGateway('sk-test');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toMatch(/VPN/i);
      expect(res.error).toMatch(/key/i);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extension && npx vitest run src/api/llmGateway.test.ts`
Expected: FAIL — cannot resolve `./llmGateway`.

- [ ] **Step 3: Write the gateway client**

```ts
// extension/src/api/llmGateway.ts
// Direct browser calls to the Wealthsimple LLM Gateway (LiteLLM, OpenAI-shaped).
//
// This cannot live on the Apps Script bridge: the gateway is VPN-locked and Apps Script
// runs on Google's public servers. The extension is inside the VPN whenever Albert is.

export const LLM_GATEWAY_URL = 'https://llm.w10e.com/api/v2/chat/completions';
/** Private VPC-hosted model. External models get WS PII masking, which mangles client
 *  names and emails inside ticket text. Do not switch this to an external model. */
export const LLM_GATEWAY_MODEL = 'bedrock-claude-sonnet-4-6';
export const LLM_GATEWAY_TIMEOUT_MS = 45_000;

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CallOpts {
  maxTokens?: number;
  timeoutMs?: number;
  jsonMode?: boolean;
}

/** Returns the assistant's raw message content. Callers do their own parsing. */
export async function callLlmGateway(
  messages: LlmMessage[],
  key: string,
  opts: CallOpts = {},
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? LLM_GATEWAY_TIMEOUT_MS);

  let resp: Response;
  try {
    resp = await fetch(LLM_GATEWAY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-LiteLLM-Dev-Key': key,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: LLM_GATEWAY_MODEL,
        messages,
        ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
        ...(opts.jsonMode === false ? {} : { response_format: { type: 'json_object' } }),
      }),
    });
  } catch (e: any) {
    if (e?.name === 'AbortError') {
      throw new Error(`LLM Gateway timed out after ${(opts.timeoutMs ?? LLM_GATEWAY_TIMEOUT_MS) / 1000}s.`);
    }
    throw new Error('Could not reach the LLM Gateway. Check that you are on the WS VPN.');
  } finally {
    clearTimeout(timer);
  }

  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new Error(`LLM Gateway returned ${resp.status}. ${detail.slice(0, 200)}`);
  }

  const data: any = await resp.json().catch(() => null);
  const content = data?.choices?.[0]?.message?.content;
  if (!content || typeof content !== 'string') {
    throw new Error('LLM Gateway returned an empty response.');
  }
  return content;
}

/** One cheap call used by Settings to validate a freshly pasted key. */
export async function pingLlmGateway(key: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await callLlmGateway([{ role: 'user', content: 'Reply with {}' }], key, {
      maxTokens: 1,
      timeoutMs: 15_000,
    });
    return { ok: true };
  } catch (e: any) {
    // A VPN-off failure and a bad-key failure look almost identical from the browser,
    // so the message names both rather than guessing.
    return {
      ok: false,
      error: `${e?.message || 'Call failed.'} Check the key is correct and that you are on the WS VPN.`,
    };
  }
}
```

- [ ] **Step 4: Append the key storage helpers**

Append to `extension/src/auth/credentials.ts`, below the existing i2c helpers:

```ts
// ============ LLM Gateway developer key ============
// Same trust model as the i2c credentials above: chrome.storage.local is scoped to this
// extension. The key is a personal LiteLLM developer key, not a shared secret.

const LLM_GATEWAY_KEY = 'llmGatewayKey';

export async function getLlmGatewayKey(): Promise<string | null> {
  const res = await chrome.storage.local.get(LLM_GATEWAY_KEY);
  const v = res[LLM_GATEWAY_KEY];
  return typeof v === 'string' && v.trim() ? v : null;
}

export async function setLlmGatewayKey(key: string): Promise<void> {
  await chrome.storage.local.set({ [LLM_GATEWAY_KEY]: key.trim() });
}

export async function clearLlmGatewayKey(): Promise<void> {
  await chrome.storage.local.remove(LLM_GATEWAY_KEY);
}
```

- [ ] **Step 5: Add the host permission**

In `extension/manifest.json`, add one entry to the `host_permissions` array (which starts at line 74), after `"http://localhost:8501/*"`:

```json
    "https://llm.w10e.com/*",
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd extension && npx vitest run src/api/llmGateway.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 7: Commit**

```bash
git add extension/src/api/llmGateway.ts extension/src/api/llmGateway.test.ts extension/src/auth/credentials.ts extension/manifest.json
git commit -m "Add the LLM Gateway client, key storage and host permission"
```

---

### Task 4: Apps Script read actions — getRecentLog and getPlaybook

**Files:**
- Create: `docs/gas/2026-09-01-phase2-read-actions.gs` (paste source, kept in the repo for review)
- Manual: the shared WOCOO Apps Script project, edited in the web editor by the user

**Interfaces:**
- Consumes: the `Log` and `Playbook` tabs of `1UnCQoj_oPiJshzP65QpU0hp6-DmcLtN-6H4WLV7HbPw`.
- Produces: bridge actions `getRecentLog` (reply action `recentLog`, payload `{ rows: [...] }`) and `getPlaybook` (reply action `playbook`, payload `{ chunks: [...] }`). Each row/chunk uses the sheet's own snake_case column names.

- [ ] **Step 1: Create the `Playbook` tab**

In the spreadsheet, add a tab named exactly `Playbook` with this frozen header row:

```
page_id | page_title | parent_path | chunk_key | chunk_text | updated_at
```

Leave it empty below the header. Task 5 fills it.

- [ ] **Step 2: Write the paste source**

```js
// docs/gas/2026-09-01-phase2-read-actions.gs
// ADDITIVE. Paste at the end of the shared WOCOO bridge project. Do not edit or reorder
// any existing handler. Route both actions in the existing doGet dispatch (Step 3).

var TICKET_LOG_SHEET_ID = '1UnCQoj_oPiJshzP65QpU0hp6-DmcLtN-6H4WLV7HbPw';

function _readTab_(tabName) {
  var sh = SpreadsheetApp.openById(TICKET_LOG_SHEET_ID).getSheetByName(tabName);
  if (!sh) return { header: [], rows: [] };
  var values = sh.getDataRange().getValues();
  if (values.length < 2) return { header: values[0] || [], rows: [] };
  return { header: values[0], rows: values.slice(1) };
}

function _rowToObject_(header, row) {
  var o = {};
  for (var i = 0; i < header.length; i++) {
    var k = String(header[i] || '').trim();
    if (!k) continue;
    var v = row[i];
    o[k] = v instanceof Date ? v.toISOString() : String(v == null ? '' : v);
  }
  return o;
}

/** Prior resolved tickets for one work type, best match first.
 *  Exact match on original_work_type scores 2, substring scores 1, no match drops the
 *  row. Rows without a resolution_note carry no knowledge, so they are dropped too. */
function handleGetRecentLog(params) {
  var wantRaw = String(params.work_type || '');
  var want = wantRaw.toLowerCase().trim();
  var limit = Math.max(1, Math.min(100, parseInt(params.limit, 10) || 25));

  var data = _readTab_('Log');
  var scored = [];

  for (var i = 0; i < data.rows.length; i++) {
    var o = _rowToObject_(data.header, data.rows[i]);
    if (!String(o.resolution_note || '').trim()) continue;

    var owt = String(o.original_work_type || '').toLowerCase().trim();
    var score = 0;
    if (want && owt === want) score = 2;
    else if (want && owt && (owt.indexOf(want) >= 0 || want.indexOf(owt) >= 0)) score = 1;
    if (score === 0) continue;

    scored.push({ score: score, loggedAt: String(o.logged_at || ''), obj: o });
  }

  scored.sort(function (a, b) {
    if (b.score !== a.score) return b.score - a.score;
    return a.loggedAt < b.loggedAt ? 1 : a.loggedAt > b.loggedAt ? -1 : 0;
  });

  var out = [];
  for (var j = 0; j < Math.min(limit, scored.length); j++) {
    var s = scored[j].obj;
    out.push({
      logged_at: s.logged_at || '',
      ticket_id: s.ticket_id || '',
      summary: s.summary || '',
      original_work_type: s.original_work_type || '',
      final_work_type: s.final_work_type || '',
      transition: s.transition || '',
      moved_to_board: s.moved_to_board || '',
      resolution_note: s.resolution_note || '',
      tools_used: s.tools_used || ''
    });
  }
  return { action: 'recentLog', rows: out };
}

/** Whole Playbook tab. Filtering is the extension's job. */
function handleGetPlaybook() {
  var data = _readTab_('Playbook');
  var out = [];
  for (var i = 0; i < data.rows.length; i++) {
    var o = _rowToObject_(data.header, data.rows[i]);
    if (!String(o.chunk_key || '').trim()) continue;
    out.push({
      page_id: o.page_id || '',
      page_title: o.page_title || '',
      parent_path: o.parent_path || '',
      chunk_key: o.chunk_key || '',
      chunk_text: o.chunk_text || '',
      updated_at: o.updated_at || ''
    });
  }
  return { action: 'playbook', chunks: out };
}

// The browser bridge only resolves on a postMessage from the rendered HTML page. A
// handler that returns JSON directly works under the Run button and hangs in the panel.
function _handleGetRecentLogFromGet_(params) {
  return _bridgeHtmlReply_(handleGetRecentLog(params));
}

function _handleGetPlaybookFromGet_() {
  return _bridgeHtmlReply_(handleGetPlaybook());
}

/** Mirrors the postMessage wrapper the existing handlers use. If the project already
 *  has an equivalent helper under a different name, call that one instead of adding
 *  this — do not define a second copy. */
function _bridgeHtmlReply_(payload) {
  var json = JSON.stringify(payload);
  return HtmlService.createHtmlOutput(
    '<script>window.top.postMessage(' + json + ', "*");</script>'
  );
}
```

Note the `window.top` target: `window.parent` hits Apps Script's own `mae_html_user.js` wrapper, which drops unrecognised messages and leaves the extension waiting for a reply that never arrives.

- [ ] **Step 3: Route the actions**

Ask the user to paste the file into the web editor and add two cases to the existing `doGet` dispatch, matching the surrounding style:

```js
  if (action === 'getRecentLog') return _handleGetRecentLogFromGet_(params);
  if (action === 'getPlaybook')  return _handleGetPlaybookFromGet_();
```

Then **Deploy → Manage deployments → edit the active deployment → Deploy**. Apps Script snapshots code at deploy time; saving alone changes nothing for the extension.

- [ ] **Step 4: Verify against the live sheet**

In the browser, open the bridge URL directly with a work type that exists in the log, e.g.
`<BRIDGE_URL>?action=getRecentLog&work_type=Overpayment&limit=5`.
Expected: an HTML page whose script posts `{"action":"recentLog","rows":[...]}`. View source to read it.
Then `<BRIDGE_URL>?action=getPlaybook`. Expected: `{"action":"playbook","chunks":[]}` while the tab is still empty.

Check the scoring by eye: exact-work-type rows come before substring rows, and rows with an empty `resolution_note` are absent.

- [ ] **Step 5: Commit**

```bash
git add docs/gas/2026-09-01-phase2-read-actions.gs
git commit -m "Add the Phase 2 Apps Script read actions as reviewable paste source"
```

---

### Task 5: Playbook sync runbook and first sync

**Files:**
- Create: `docs/runbooks/sync-playbook.md`

**Interfaces:**
- Consumes: the `Playbook` tab created in Task 4.
- Produces: a populated `Playbook` tab. No code depends on this task, but verdict quality does.

- [ ] **Step 1: Write the runbook**

```markdown
# Runbook: sync playbook

Mirrors the Notion playbook into the `Playbook` tab of the WOCOO Ticket Log sheet so the
AI triage card can read it through the bridge. Run by hand in a Claude session; there is
no automated sync.

**Source:** Albert's WOCOO Ticket Playbook, Notion page `39241167-bd96-81d5-92b1-da6303f0b22c`.
Only this page tree. The shared team WOCOO page is never a source.

**Destination:** tab `Playbook` on `1UnCQoj_oPiJshzP65QpU0hp6-DmcLtN-6H4WLV7HbPw`.

## Steps

1. Fetch the page tree under *Work types* with the Notion MCP tools.
2. For each work-type page, emit one row per populated block of the 5-block template:
   When applies / Steps / Tools + queries / Gotchas / Example tickets.
3. Skip blocks whose body is still `_TBD_` — a placeholder row is worse than no row,
   because it fills prompt space with nothing.
4. Build each row as:
   - `page_id` — the Notion page id
   - `page_title` — the work-type name, e.g. `Overpayment`
   - `parent_path` — e.g. `Work types`
   - `chunk_key` — `<page_id>#<block-slug>`, e.g. `<id>#steps`. Stable across runs.
   - `chunk_text` — the block's text, flattened to plain prose
   - `updated_at` — the Notion page's last-edited timestamp
5. Upsert into the tab **by `chunk_key`**: overwrite a matching row, append a new one.
   Never clear the tab and rewrite it — that loses rows for pages the run did not reach.
6. Delete rows whose `chunk_key` no longer exists in Notion.

## After the run

Reload the side panel and open a WOCOO ticket whose work type you just synced. The
verdict card should cite the playbook content in its steps or gotchas.
```

- [ ] **Step 2: Run the first sync**

Execute the runbook against the current Notion tree. Most of the 13 work-type pages are
still `_TBD_`, so expect a small number of rows — that is the honest current state, not a
failure. Record the resulting row count in the commit message.

- [ ] **Step 3: Verify the bridge sees the rows**

Open `<BRIDGE_URL>?action=getPlaybook` and confirm `chunks` is no longer empty and the
`chunk_key` values match what you wrote.

- [ ] **Step 4: Commit**

```bash
git add docs/runbooks/sync-playbook.md
git commit -m "Add the playbook sync runbook"
```

---

### Task 6: Bridge callers for the two read actions

**Files:**
- Modify: `extension/src/api/bridge.ts` (append a new section after the Ticket Log section, which ends around line 353)

**Interfaces:**
- Consumes: `callBridge(action, params, expectedReply, timeoutMs, openInBackground)` (private, `bridge.ts:141`); `RecentLogRow` and `PlaybookChunk` from `../data/aiTriageTypes`.
- Produces: `getRecentLogViaBridge(workType: string, limit?: number): Promise<RecentLogRow[]>`; `getPlaybookViaBridge(): Promise<PlaybookChunk[]>`.

- [ ] **Step 1: Add the callers**

Append to `extension/src/api/bridge.ts`. Add `RecentLogRow` and `PlaybookChunk` to the existing type import block at the top of the file.

```ts
// ============ Ticket Knowledge Loop Phase 2 reads ============
// Both run headless (background tab, auto-closed) — the verdict card fires on every
// ticket open, so a visible script.google.com tab flashing each time is unacceptable.

/** Prior resolved tickets matching this work type, best match first. */
export async function getRecentLogViaBridge(workType: string, limit = 25): Promise<RecentLogRow[]> {
  const res = await callBridge('getRecentLog', {
    work_type: workType,
    limit: String(limit),
  }, 'recentLog', 30_000, true);

  const rows = Array.isArray((res as any).rows) ? (res as any).rows : [];
  return rows.map((r: any) => ({
    loggedAt: String(r.logged_at ?? ''),
    ticketId: String(r.ticket_id ?? ''),
    summary: String(r.summary ?? ''),
    originalWorkType: String(r.original_work_type ?? ''),
    finalWorkType: String(r.final_work_type ?? ''),
    transition: String(r.transition ?? ''),
    movedToBoard: String(r.moved_to_board ?? ''),
    resolutionNote: String(r.resolution_note ?? ''),
    toolsUsed: String(r.tools_used ?? ''),
  }));
}

/** The whole Playbook tab. Filtering happens in the extension. */
export async function getPlaybookViaBridge(): Promise<PlaybookChunk[]> {
  const res = await callBridge('getPlaybook', {}, 'playbook', 30_000, true);

  const chunks = Array.isArray((res as any).chunks) ? (res as any).chunks : [];
  return chunks.map((c: any) => ({
    pageId: String(c.page_id ?? ''),
    pageTitle: String(c.page_title ?? ''),
    parentPath: String(c.parent_path ?? ''),
    chunkKey: String(c.chunk_key ?? ''),
    chunkText: String(c.chunk_text ?? ''),
    updatedAt: String(c.updated_at ?? ''),
  }));
}
```

- [ ] **Step 2: Typecheck**

Run: `cd extension && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add extension/src/api/bridge.ts
git commit -m "Add bridge callers for the recent-log and playbook reads"
```

---

### Task 7: Give WocooTicket an `updated` timestamp

**Files:**
- Modify: `extension/src/data/mockTicket.ts:24` (interface) and the `MOCK_TICKET` literal
- Modify: `extension/src/api/jira.ts:1026-1140` (`getTicket` — the `fields` list and the returned object)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `WocooTicket.updated: string` — an ISO timestamp used as the cache `versionTag` in Task 8.

- [ ] **Step 1: Add the field to the interface**

In `extension/src/data/mockTicket.ts`, immediately after `created: string;`:

```ts
  /** Jira `fields.updated`. Used as the AI triage cache's versionTag, so editing the
   *  ticket invalidates its cached verdict for free. */
  updated: string;
```

- [ ] **Step 2: Add it to MOCK_TICKET**

After `created: '2026-06-08T11:52:00Z',` in the `MOCK_TICKET` literal:

```ts
  updated: '2026-06-08T11:52:00Z',
```

- [ ] **Step 3: Request and map the field**

In `getTicket` in `extension/src/api/jira.ts`, add `'updated',` to the `fields` array (immediately after `'created',`), and add this to the returned object next to `created:`:

```ts
    updated: f.updated || f.created || new Date().toISOString(),
```

- [ ] **Step 4: Typecheck**

Run: `cd extension && npx tsc --noEmit`
Expected: no errors. If another fixture builds a bare `WocooTicket` literal, TypeScript will name it here — add `updated` there too, copying the fixture's `created` value.

- [ ] **Step 5: Commit**

```bash
git add extension/src/data/mockTicket.ts extension/src/api/jira.ts
git commit -m "Carry the Jira updated timestamp on WocooTicket"
```

---

### Task 8: The AI triage card

**Files:**
- Create: `extension/src/sidepanel/AITriageCard.tsx`
- Modify: `extension/src/sidepanel/SidePanel.tsx` (render between the `QuickActions` block at ~line 521 and the `{/* RECENT COMMENTS (collapsed) */}` block at ~line 548)

**Interfaces:**
- Consumes: `getOrCompute`, `invalidate` (Task 2); `buildTriagePrompt`, `parseTriageVerdict` (Task 1); `callLlmGateway` (Task 3); `getLlmGatewayKey` (Task 3); `getRecentLogViaBridge`, `getPlaybookViaBridge` (Task 6); `WocooTicket.updated` (Task 7).
- Produces: `<AITriageCard ticket={ticket} onOpenSettings={() => void} />`.

- [ ] **Step 1: Write the card**

```tsx
// extension/src/sidepanel/AITriageCard.tsx
// AI verdict card — replaces the heuristic suggested-response. Fires on ticket open,
// grounded in Albert's own resolved-ticket log plus the Notion playbook mirror.

import { useCallback, useEffect, useState } from 'react';
import type { WocooTicket } from '../data/mockTicket';
import type { TriageVerdict } from '../data/aiTriageTypes';
import { getLlmGatewayKey } from '../auth/credentials';
import { callLlmGateway } from '../api/llmGateway';
import { getRecentLogViaBridge, getPlaybookViaBridge } from '../api/bridge';
import { buildTriagePrompt, parseTriageVerdict } from './composePrompt';
import { getOrCompute, invalidate } from './aiTriageCache';

type State =
  | { kind: 'no-key' }
  | { kind: 'loading' }
  | { kind: 'ready'; verdict: TriageVerdict }
  | { kind: 'error'; message: string };

export function AITriageCard({ ticket, onOpenSettings }: { ticket: WocooTicket; onOpenSettings: () => void }) {
  const [state, setState] = useState<State>({ kind: 'loading' });

  const run = useCallback(async (force: boolean) => {
    const key = await getLlmGatewayKey();
    if (!key) { setState({ kind: 'no-key' }); return; }

    setState({ kind: 'loading' });
    if (force) invalidate(ticket.id, ticket.updated);

    try {
      const verdict = await getOrCompute(ticket.id, ticket.updated, async () => {
        const [recentRows, playbookChunks] = await Promise.all([
          getRecentLogViaBridge(ticket.workType),
          getPlaybookViaBridge(),
        ]);
        const messages = buildTriagePrompt({
          ticketId: ticket.id,
          summary: ticket.summary,
          description: ticket.description,
          workType: ticket.workType,
          allowedWorkTypes: Array.from(new Set([
            ticket.workType,
            ...recentRows.map((r) => r.finalWorkType || r.originalWorkType),
          ].filter(Boolean))),
          recentRows,
          playbookChunks,
        });
        const raw = await callLlmGateway(messages, key);
        const parsed = parseTriageVerdict(raw);
        if (!parsed.ok) throw new Error(parsed.error);
        return parsed.verdict;
      });
      setState({ kind: 'ready', verdict });
    } catch (e: any) {
      setState({ kind: 'error', message: e?.message || 'The verdict call failed.' });
    }
  }, [ticket.id, ticket.updated, ticket.summary, ticket.description, ticket.workType]);

  useEffect(() => { void run(false); }, [run]);

  // Never hidden outright: a hidden card makes the feature permanently invisible to the
  // one person who uses it.
  if (state.kind === 'no-key') {
    return (
      <div style={cardStyle}>
        <Header />
        <button type="button" onClick={onOpenSettings} style={linkButtonStyle}>
          Add LLM Gateway key in Settings
        </button>
      </div>
    );
  }

  if (state.kind === 'loading') {
    return (
      <div style={cardStyle}>
        <Header />
        <div style={mutedStyle}>Reading your past tickets…</div>
      </div>
    );
  }

  if (state.kind === 'error') {
    return (
      <div style={cardStyle}>
        <Header />
        <div style={{ ...mutedStyle, color: 'var(--mint-critical-fg-strong)' }}>{state.message}</div>
        <button type="button" onClick={() => void run(true)} style={linkButtonStyle}>Retry</button>
      </div>
    );
  }

  const v = state.verdict;
  return (
    <div style={cardStyle}>
      <Header right={<ConfidenceChip level={v.confidence} />} />
      <div style={{ fontSize: 'var(--mint-text-meta)', fontWeight: 700, color: 'var(--mint-fg-strong)' }}>{v.workType}</div>
      {v.rationale && <div style={mutedStyle}>{v.rationale}</div>}

      {v.steps.length > 0 && (
        <ol style={listStyle}>
          {v.steps.map((s, i) => <li key={i}>{s}</li>)}
        </ol>
      )}

      {v.gotchas.length > 0 && (
        <ul style={listStyle}>
          {v.gotchas.map((g, i) => <li key={i}>⚠ {g}</li>)}
        </ul>
      )}

      {v.similarTickets.length > 0 && (
        <div style={{ marginTop: 'var(--mint-sp-2)' }}>
          <div style={{ ...mutedStyle, fontWeight: 600 }}>Similar tickets you closed</div>
          {v.similarTickets.map((s) => (
            <div key={s.ticketId} style={mutedStyle}>
              <a
                href={`https://wealthsimple.atlassian.net/browse/${s.ticketId}`}
                target="_blank"
                rel="noreferrer"
                style={{ color: 'var(--mint-fg-strong)' }}
              >{s.ticketId}</a>
              {' — '}{s.whatHappened}
            </div>
          ))}
        </div>
      )}

      <button type="button" onClick={() => void run(true)} style={linkButtonStyle}>Regenerate</button>
    </div>
  );
}

function Header({ right }: { right?: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 'var(--mint-sp-2)' }}>
      <span style={{ fontSize: 'var(--mint-text-meta)', fontWeight: 700, color: 'var(--mint-fg-strong)' }}>AI verdict</span>
      {right && <span style={{ marginLeft: 'auto' }}>{right}</span>}
    </div>
  );
}

function ConfidenceChip({ level }: { level: TriageVerdict['confidence'] }) {
  const color = level === 'high'
    ? 'var(--mint-positive-fg-strong)'
    : level === 'medium' ? 'var(--mint-fg-subdued-title)' : 'var(--mint-fg-soft)';
  return <span style={{ fontSize: 'var(--mint-text-nano)', fontWeight: 600, color }}>{level} confidence</span>;
}

const cardStyle: React.CSSProperties = {
  border: '1px solid var(--mint-border-soft)',
  borderRadius: 8,
  padding: 'var(--mint-sp-3)',
  marginTop: 'var(--mint-sp-3)',
};

const mutedStyle: React.CSSProperties = {
  fontSize: 'var(--mint-text-micro)',
  color: 'var(--mint-fg-subdued-title)',
  marginTop: 4,
};

const listStyle: React.CSSProperties = {
  fontSize: 'var(--mint-text-micro)',
  color: 'var(--mint-fg-subdued-title)',
  margin: '6px 0 0',
  paddingLeft: 18,
};

const linkButtonStyle: React.CSSProperties = {
  marginTop: 'var(--mint-sp-2)',
  background: 'none',
  border: 'none',
  padding: 0,
  fontSize: 'var(--mint-text-micro)',
  color: 'var(--mint-fg-strong)',
  textDecoration: 'underline',
  cursor: 'pointer',
};
```

If any `--mint-*` token above does not exist in this codebase, substitute the nearest token already used in `SettingsView.tsx` rather than inventing a hex value.

- [ ] **Step 2: Render it in the side panel**

In `extension/src/sidepanel/SidePanel.tsx`, import the card and place it between the closing tag of the `<QuickActions … />` block (~line 521) and the `{/* RECENT COMMENTS (collapsed) */}` comment (~line 548):

```tsx
      <AITriageCard ticket={ticket} onOpenSettings={() => setView('settings')} />
```

Use whatever state setter the file already uses to open Settings — match the existing settings navigation rather than adding a new mechanism.

- [ ] **Step 3: Typecheck and build**

Run: `cd extension && npx tsc --noEmit && npm run build`
Expected: both succeed.

- [ ] **Step 4: Commit**

```bash
git add extension/src/sidepanel/AITriageCard.tsx extension/src/sidepanel/SidePanel.tsx
git commit -m "Render the AI verdict card above recent comments"
```

---

### Task 9: Settings block for the gateway key

**Files:**
- Modify: `extension/src/sidepanel/SettingsView.tsx` (add a sibling to `I2cCredentialsRow`, rendered in the same Section)

**Interfaces:**
- Consumes: `getLlmGatewayKey`, `setLlmGatewayKey`, `clearLlmGatewayKey` (Task 3); `pingLlmGateway` (Task 3).
- Produces: nothing other tasks depend on.

- [ ] **Step 1: Add the component**

Add to `extension/src/sidepanel/SettingsView.tsx`, mirroring `I2cCredentialsRow`'s structure — same `cardStyle`, `labelStyle`, `inputStyle`, same saved/not-set chip, same transient status line.

```tsx
function LlmGatewayRow() {
  const [loaded, setLoaded] = useState(false);
  const [hasSaved, setHasSaved] = useState(false);
  const [key, setKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [checking, setChecking] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    getLlmGatewayKey().then((k) => {
      if (k) { setHasSaved(true); setKey(k); }
      setLoaded(true);
    });
  }, []);

  async function save() {
    if (!key.trim()) { setStatus('A key is required.'); return; }
    await setLlmGatewayKey(key);
    setHasSaved(true);
    setChecking(true);
    setStatus('Checking…');
    const res = await pingLlmGateway(key.trim());
    setChecking(false);
    setStatus(res.ok ? 'Saved. Key works.' : `Saved, but the check failed. ${res.error}`);
  }

  async function clear() {
    await clearLlmGatewayKey();
    setHasSaved(false);
    setKey('');
    setStatus('Cleared.');
    setTimeout(() => setStatus(null), 2000);
  }

  if (!loaded) return null;

  return (
    <div style={cardStyle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 'var(--mint-sp-2)' }}>
        <span style={{ fontSize: 'var(--mint-text-meta)', fontWeight: 700, color: 'var(--mint-fg-strong)' }}>LLM Gateway</span>
        {hasSaved ? (
          <span style={{ marginLeft: 'auto', fontSize: 'var(--mint-text-nano)', color: 'var(--mint-positive-fg-strong)', fontWeight: 600 }}>✓ Saved</span>
        ) : (
          <span style={{ marginLeft: 'auto', fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-soft)' }}>Not set</span>
        )}
      </div>

      <label style={labelStyle}>Developer key</label>
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          type={showKey ? 'text' : 'password'}
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="sk-…"
          style={{ ...inputStyle, flex: 1 }}
        />
        <button type="button" onClick={() => setShowKey((s) => !s)} style={linkButtonStyle}>
          {showKey ? 'Hide' : 'Show'}
        </button>
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 'var(--mint-sp-2)' }}>
        <button type="button" onClick={() => void save()} disabled={checking} style={linkButtonStyle}>Save</button>
        {hasSaved && <button type="button" onClick={() => void clear()} style={linkButtonStyle}>Clear</button>}
      </div>

      {status && (
        <div style={{ fontSize: 'var(--mint-text-micro)', color: 'var(--mint-fg-subdued-title)', marginTop: 6 }}>{status}</div>
      )}
    </div>
  );
}
```

`linkButtonStyle` is not defined in `SettingsView.tsx` today. Reuse whatever button style the file already has; if it has none, define a local `linkButtonStyle` alongside the existing `labelStyle` / `inputStyle` constants at the bottom of the file, copying the definition from Task 8. Do not import styles across files.

- [ ] **Step 2: Render it**

Add `<LlmGatewayRow />` directly below `<I2cCredentialsRow />` in the Section that currently ends with the `<Row label="More tooling coming soon." … />` line (~line 60), and import the four helpers from `../auth/credentials` and `../api/llmGateway`.

- [ ] **Step 3: Typecheck and build**

Run: `cd extension && npx tsc --noEmit && npm run build`
Expected: both succeed.

- [ ] **Step 4: Commit**

```bash
git add extension/src/sidepanel/SettingsView.tsx
git commit -m "Add the LLM Gateway key field to Settings"
```

---

### Task 10: End-to-end verification on a live ticket

**Files:** none — this task changes no code. It gates enabling the card in daily use.

**Interfaces:**
- Consumes: everything above.
- Produces: a verified feature, or a defect list.

- [ ] **Step 1: Full test suite**

Run: `cd extension && npm test`
Expected: all tests pass, including the pre-existing `atlasAccountLookup` and `atlasGraphql` suites.

- [ ] **Step 2: Load the build**

Run `npm run build`, then reload the unpacked extension at `chrome://extensions`. Confirm on VPN.

- [ ] **Step 3: No-key path**

With no key saved, open a WOCOO ticket. Expected: the card shows "Add LLM Gateway key in Settings" and the link opens Settings.

- [ ] **Step 4: Bad-key path**

Save a deliberately wrong key. Expected: Settings reports the failure and names both the key and the VPN. The card then shows an error state with Retry, not a blank card and not a crash.

- [ ] **Step 5: Happy path**

Save the real key from 1Password (`LITELLM_DEVELOPER_KEY`). Open a WOCOO ticket whose work type has both log rows and synced playbook content. Expected: a verdict with a work type from the allowed list, a rationale, steps, and at least one similar ticket that really exists in the log.

- [ ] **Step 6: Cache behaviour**

Reopen the same ticket within 30 minutes. Expected: the verdict renders immediately with no `script.google.com` background tab activity. Click Regenerate. Expected: a fresh call, the button disabled while it runs.

- [ ] **Step 7: VPN-off path**

Disconnect the VPN and open a different ticket. Expected: the error state names the VPN. Reconnect and hit Retry; the verdict loads.

- [ ] **Step 8: Report**

Write up what passed and what did not. Anything failing goes back to its owning task — do not patch around it here.

---

## Notes for the executor

- The gateway is VPN-locked. Any "could not reach" failure during Tasks 3, 8, or 10 is a VPN check before it is a code change.
- The Apps Script side (Task 4) cannot be read or written programmatically. It is paste-and-deploy in the web editor, by the user, and strictly additive.
- Deploying Apps Script means **Manage deployments → edit → Deploy**. Saving the editor does nothing for the extension, which calls the deployed URL.
- Playbook content is mostly `_TBD_` today. A thin verdict in Task 10 Step 5 is a content problem, not a code defect — confirm against the sheet before debugging code.
