# Insurance Eligibility Confirmation Triage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Sidekick Home → Tools tile that reads unread insurer eligibility requests from `creditcardoperations@`, matches each to a client (warehouse first, then i2c, then Atlas by phone), drafts the standard reply in that mailbox, and sends all Sidekick drafts in one confirmed action.

**Architecture:** A new Apps Script web app, deployed as `creditcardoperations@` inside the CC Ops Automation project, lists requests, creates drafts, sends drafts and logs rows to the `Requests` sheet. Sidekick calls it through the existing headless `callBridge` path with a second base URL. All parsing, SQL building, matching and draft rendering are pure TypeScript in `src/data/` with vitest coverage. The batch orchestrator takes its I/O (Preset, i2c, Atlas) as injected functions, so the whole precedence chain is tested with fakes.

**Tech Stack:** Chrome MV3 extension (Vite + React + TypeScript, `@crxjs/vite-plugin`), vitest (node environment), Google Apps Script (V8), Preset SQL Lab API (Superset), Atlas GraphQL, i2c content-script chain.

**Spec:** `docs/superpowers/specs/2026-10-05-insurance-eligibility-triage-design.md`

## Global Constraints

- All extension commands run from `~/projects/wocoo-extension/extension/`. Tests: `npm test` (vitest). Build: `npm run build` (`tsc -b && vite build`), then reload Sidekick in `chrome://extensions`.
- Branch: `feat/insurance-eligibility-triage`. **Never stage** the pre-existing uncommitted files `src/data/atlasAccountLookup.ts`, `src/data/atlasAccountLookup.test.ts`, `src/data/atlasGraphql.ts`, `src/data/atlasGraphql.test.ts`, `src/sidepanel/SidePanel.tsx` unless the task says so. Always `git add` explicit paths, never `git add -A` / `.`.
- **Before Task 13** (the only task that edits `SidePanel.tsx`), the user must commit or stash the pre-existing `SidePanel.tsx` changes. Stop and ask if `git diff --stat src/sidepanel/SidePanel.tsx` is non-empty.
- No clasp. Apps Script is pasted into the web editor while signed in as `creditcardoperations@wealthsimple.com`, then **Deploy → Manage deployments → Edit → New version** after every change.
- Apps Script HTML replies post to **`window.top`**, never `window.parent`.
- Activation date = card **creation** date (`cc.created_at`, i2c "Card Creation Date"), formatted `MM/DD/YYYY` in America/New_York.
- Every auto-match requires the card's last 4 to equal the request's last 4. No last 4 → never auto-matched.
- Reply email line: include the client email only if it is one of the emails the insurer supplied; otherwise "Here are the requested details for client:".
- Credit products (the only ones ever reported): `ws_visa_infinite_privilege`, `ws_visa_infinite_plus`, `ws_visa_infinite_basic`, `ws_visa_infinite_core`. Prepaid products are never reported.
- Products other than `ws_visa_infinite_privilege` / `ws_visa_infinite_plus` are flagged `vi_1pct` (coverages must be added by hand).
- Preset workspace: `https://8a26d867.wealthsimple-aws-mpc.app.preset.io`; Pantheon database id `3`.
- Test fixtures use invented names, emails and phone numbers only. No client data in the repo.
- Client data is never written to `chrome.storage.local`; panel run state lives in `chrome.storage.session`.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **First listed email is wrong, second is right** → the request still matches on the second email (spec G1). Pinned in Task 4 (SQL has a row per email) and Task 12 (orchestrator test).
2. **Names with accents, apostrophes or middle names** ("Zoë O'Neil", "Mary Ann Smith") → SQL stays valid (apostrophe escaped), and a name that doesn't match exactly falls through to the live path. It must never produce a false match. Pinned in Tasks 3 and 4.
3. **Same client, two claims in one batch** → both requests are resolved and drafted independently (spec G3). Pinned in Task 12.
4. **Running twice / reopening the panel mid-run** → no duplicate drafts (label + idempotent `createEligibilityDraft`) and no duplicate sheet rows (upsert on `request_message_id`). Pinned in Task 10 (`testEligibilityIdempotency`) and Task 13 (session state restore).
5. **Quoted reply chains and signatures** containing other emails, `@wealthsimple.com` addresses or extra 4-digit numbers → excluded from candidates. Two different last-4 values add a warning, which blocks auto-drafting. Pinned in Task 3.

---

### Task 1: Spike S1 — Preset SQL from the extension (throwaway)

**Files:**
- Create: `docs/superpowers/specs/2026-10-05-insurance-eligibility-spikes.md` (findings only; no code kept)

**Interfaces:**
- Produces: a recorded decision `PRESET_MODE = 'direct-sync' | 'direct-async' | 'paste-only'` that Task 7 and Task 13 read.

- [ ] **Step 1: Make sure you are signed into Preset** in your normal Chrome profile by opening `https://8a26d867.wealthsimple-aws-mpc.app.preset.io/sqllab/` once.

- [ ] **Step 2: Run the probe from the side panel's DevTools.** In `chrome://extensions` → Sidekick → "Inspect views: side panel" (open the panel first), paste into the Console:

```js
const B = 'https://8a26d867.wealthsimple-aws-mpc.app.preset.io';
const t = await fetch(B + '/api/v1/security/csrf_token/', { credentials: 'include' });
console.log('csrf status', t.status);
const csrf = (await t.json()).result;
const r = await fetch(B + '/api/v1/sqllab/execute/', {
  method: 'POST',
  credentials: 'include',
  headers: { 'content-type': 'application/json', 'X-CSRFToken': csrf },
  body: JSON.stringify({ database_id: 3, sql: 'SELECT 1 AS ok', runAsync: false, json: true, tab: 'sidekick-spike', queryLimit: 10 }),
});
console.log('execute status', r.status, await r.json());
```

- [ ] **Step 3: Classify the result.**
  - `execute status 200` and the body has `data: [{ ok: 1 }]` → **`direct-sync`**.
  - `200`/`202` with `status: 'pending'` or `'running'` and a `query.resultsKey` → **`direct-async`**. Note the key name exactly as returned.
  - `401`/`403` on either call → repeat Step 2 in the DevTools console of a normal Preset tab (page origin). If it works there but not from the panel, cookies aren't sent from the extension, so record **`paste-only`**. (A content-script runner is out of scope for v1.)

- [ ] **Step 4: Write the findings** into `docs/superpowers/specs/2026-10-05-insurance-eligibility-spikes.md`:

```markdown
# Insurance Eligibility Triage — spike findings

## S1 — Preset SQL from the extension
- Date run:
- csrf_token status:
- execute status:
- Response shape (keys only, no data):
- Decision: PRESET_MODE = direct-sync | direct-async | paste-only
- Notes:
```

- [ ] **Step 5: Commit**

```bash
git add ../docs/superpowers/specs/2026-10-05-insurance-eligibility-spikes.md
git commit -m "Record spike S1: Preset SQL Lab from the extension

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Spike S2 — Atlas search by phone (throwaway)

**Files:**
- Modify: `docs/superpowers/specs/2026-10-05-insurance-eligibility-spikes.md`
- Create (only if a GraphQL operation exists): `extension/src/data/__fixtures__/atlasPhoneSearch.json`

**Interfaces:**
- Produces: `ATLAS_PHONE_SEARCH_ENABLED` (true/false), and when true: `ATLAS_PHONE_SERVICE` (one of `'' | 'fort_knox' | 'wealthsimple' | 'invest_graphql_api'`), `ATLAS_PHONE_OPERATION` (operationName), `ATLAS_PHONE_QUERY` (full query text), `ATLAS_PHONE_VARIABLE` (the variable name carrying the phone, and the phone format it expects). Task 9 consumes all of them.

- [ ] **Step 1: Open Atlas** (`https://atlas.wealthsimple.com`) with DevTools → Network, filter `graphql`, "Preserve log" on.

- [ ] **Step 2: Search by a phone number you're allowed to look up** (your own Wealthsimple identity's phone). Try Atlas's global search box, then any client-search page. Note the URL of the page that supports phone search.

- [ ] **Step 3: Find the request** that carries the phone number. Copy its URL path (`/api/atlas/graphql` or `/api/atlas/graphql/<service>`), `operationName`, `query`, and `variables`. Note the phone format sent (`4165550100`, `+14165550100` or `416-555-0100`).

- [ ] **Step 4: Save a scrubbed fixture.** Copy the response JSON into `extension/src/data/__fixtures__/atlasPhoneSearch.json`. Replace every real name, email, phone and id with invented values. Keep `identity-` prefixes on ids, for example `identity-FAKE000000000000000000001`. Keep at least two hits if the response had them.

- [ ] **Step 5: Record findings** by appending to the spikes doc:

```markdown
## S2 — Atlas search by phone
- Page supporting phone search:
- GraphQL path / service:
- operationName:
- Phone variable name and format:
- query (verbatim):
- Decision: ATLAS_PHONE_SEARCH_ENABLED = true | false
```

If no phone search exists, or it is not a GraphQL operation, record `false`. **Task 9 is then skipped**, and phone-only requests end as `no_match` for manual handling.

- [ ] **Step 6: Commit**

```bash
git add ../docs/superpowers/specs/2026-10-05-insurance-eligibility-spikes.md
# only if created:
git add src/data/__fixtures__/atlasPhoneSearch.json
git commit -m "Record spike S2: Atlas search by phone

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Shared types + email parser

**Files:**
- Create: `extension/src/data/eligibilityTypes.ts`
- Create: `extension/src/data/eligibilityParse.ts`
- Test: `extension/src/data/eligibilityParse.test.ts`

**Interfaces:**
- Produces (types, `eligibilityTypes.ts`): `RawEligibilityEmail`, `PersonName`, `EligibilityRequest`, `CardFact`, `MatchMethod`, `EligibilityFlag`, `Candidate`, `Resolution`, `WarehouseRow` (exact shapes below).
- Produces (functions, `eligibilityParse.ts`): `normalizeName(s: string): string`, `splitName(raw: string): PersonName | null`, `parseEligibilityEmail(raw: RawEligibilityEmail, excludedDomains: string[]): EligibilityRequest`.

- [ ] **Step 1: Write the types**

`extension/src/data/eligibilityTypes.ts`:

```ts
// Shared types for the Insurance Eligibility Confirmation Triage tool.
// Spec: docs/superpowers/specs/2026-10-05-insurance-eligibility-triage-design.md

/** One unread insurer email, as returned by the eligibility bridge's listEligibilityRequests. */
export interface RawEligibilityEmail {
  threadId: string;
  messageId: string;
  /** Raw From header, e.g. `Jane Adjuster <jane@insurer.example>`. */
  from: string;
  /** Lowercased address part of `from`. */
  fromEmail: string;
  subject: string;
  /** ISO timestamp of the latest message. */
  date: string;
  /** Messages in the thread; > 1 means someone already replied. */
  messageCount: number;
  plainBody: string;
}

export interface PersonName {
  /** Everything before the last token, as written. */
  first: string;
  /** The last whitespace-separated token, as written. */
  last: string;
  raw: string;
}

export interface EligibilityRequest {
  threadId: string;
  messageId: string;
  insurerEmail: string;
  insurerName: string;
  subject: string;
  receivedAt: string;
  messageCount: number;
  cardholderName: PersonName | null;
  /** Every non-insurer address found, lowercased, de-duplicated, in order of appearance. */
  emails: string[];
  /** 10 digits, no punctuation, leading country code 1 removed. */
  phone: string | null;
  last4: string | null;
  claimNumber: string | null;
  dateOfLoss: string | null;
  warnings: string[];
}

export interface CardFact {
  last4: string;
  /** card_product_id, e.g. `ws_visa_infinite_privilege`; '' when unknown. */
  product: string;
  /** MM/DD/YYYY; '' when unknown. */
  creationDate: string;
  /** null when unknown. */
  delinquent: boolean | null;
}

export type MatchMethod = 'email_last4' | 'name_last4' | 'i2c_email' | 'atlas_phone_i2c';

export type EligibilityFlag =
  | 'multiple_candidates'
  | 'delinquent'
  | 'vi_1pct'
  | 'no_last4'
  | 'parse_warning'
  | 'already_replied'
  | 'unknown_product'
  | 'i2c_details_incomplete'
  | 'lookup_error';

export interface Candidate {
  identityId: string;
  clientEmail: string;
  name: string;
}

export interface Resolution {
  /** = EligibilityRequest.messageId */
  requestId: string;
  status: 'matched' | 'needs_review' | 'no_match';
  method: MatchMethod | null;
  clientEmail: string | null;
  identityId: string | null;
  /** Requested last 4 first. Empty unless a single client was identified. */
  cards: CardFact[];
  flags: EligibilityFlag[];
  candidates: Candidate[];
  note: string;
}

/** One row of the batch warehouse query (Task 4), after type coercion. */
export interface WarehouseRow {
  requestId: string;
  matchRule: 'email' | 'name';
  identityId: string;
  clientEmail: string;
  firstName: string;
  lastName: string;
  last4: string;
  cardProduct: string;
  createdDate: string;
  isDelinquent: boolean | null;
}
```

- [ ] **Step 2: Write the failing parser tests**

`extension/src/data/eligibilityParse.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { normalizeName, parseEligibilityEmail, splitName } from './eligibilityParse';
import type { RawEligibilityEmail } from './eligibilityTypes';

function raw(over: Partial<RawEligibilityEmail>): RawEligibilityEmail {
  return {
    threadId: 't1',
    messageId: 'm1',
    from: 'Jane Adjuster <jane.adjuster@claims-co.example>',
    fromEmail: 'jane.adjuster@claims-co.example',
    subject: 'Eligibility Confirmation Request',
    date: '2026-10-02T17:08:00.000Z',
    messageCount: 1,
    plainBody: '',
    ...over,
  };
}

const EXCLUDED = ['claims-co.example', 'wealthsimple.com'];

const LABELLED = `Hello Team,

We are in receipt of a claim for a Wealthsimple Visa Infinite cardholder ending in the last 4 digits - 1763

Cardholder:  Priya Ramanathan
Email: wrong.address@example.com; priya.r1985@example.com
Phone: 416-555-0142
DOL: August 15, 2026

Please confirm the following:
Jane Adjuster
Claims Adjudicator
jane.adjuster@claims-co.example
`;

describe('normalizeName', () => {
  it('lowercases, strips accents and punctuation, collapses spaces', () => {
    expect(normalizeName("  Zoë  O'Neil ")).toBe("zoe o'neil");
    expect(normalizeName('Jean-François')).toBe('jean-francois');
    expect(normalizeName('Dr. Ana')).toBe('dr ana');
  });
});

describe('splitName', () => {
  it('uses the last token as the last name', () => {
    expect(splitName('Mary Ann Smith')).toEqual({ first: 'Mary Ann', last: 'Smith', raw: 'Mary Ann Smith' });
  });
  it('returns null for a single token', () => {
    expect(splitName('Priya')).toBeNull();
  });
});

describe('parseEligibilityEmail', () => {
  it('reads every labelled field and keeps all client emails in order', () => {
    const r = parseEligibilityEmail(raw({ plainBody: LABELLED }), EXCLUDED);
    expect(r.cardholderName).toEqual({ first: 'Priya', last: 'Ramanathan', raw: 'Priya Ramanathan' });
    expect(r.emails).toEqual(['wrong.address@example.com', 'priya.r1985@example.com']);
    expect(r.phone).toBe('4165550142');
    expect(r.last4).toBe('1763');
    expect(r.dateOfLoss).toBe('August 15, 2026');
    expect(r.insurerEmail).toBe('jane.adjuster@claims-co.example');
    expect(r.insurerName).toBe('Jane Adjuster');
    expect(r.warnings).toEqual([]);
  });

  it('takes the cardholder name and claim number from the subject when the body has no label', () => {
    const r = parseEligibilityEmail(
      raw({
        subject: 'Eligibility Confirmation Request – Wealthsimple Visa Infinite - EM Claim 4148347 - Priya Ramanathan',
        plainBody: 'Card ending in 1763. Email: priya.r1985@example.com',
      }),
      EXCLUDED,
    );
    expect(r.cardholderName?.raw).toBe('Priya Ramanathan');
    expect(r.claimNumber).toBe('4148347');
    expect(r.last4).toBe('1763');
  });

  it('reads masked card numbers', () => {
    const r = parseEligibilityEmail(raw({ plainBody: 'Card: 412650******0042' }), EXCLUDED);
    expect(r.last4).toBe('0042');
  });

  it('returns null last4 when none is present', () => {
    const r = parseEligibilityEmail(raw({ plainBody: 'Cardholder: Priya Ramanathan' }), EXCLUDED);
    expect(r.last4).toBeNull();
  });

  it('warns when two different last-4 values appear', () => {
    const r = parseEligibilityEmail(
      raw({ plainBody: 'last 4 digits - 1763\nPrevious card ending in 9921' }),
      EXCLUDED,
    );
    expect(r.last4).toBe('1763');
    expect(r.warnings).toEqual(['Multiple last-4 values found: 1763, 9921']);
  });

  it('ignores quoted reply text, insurer domains and wealthsimple.com', () => {
    const body = `Cardholder: Priya Ramanathan
Email: priya.r1985@example.com
last 4 digits - 1763

On Mon, Sep 29, 2026 at 9:00 AM Credit Card Operations <creditcardoperations@wealthsimple.com> wrote:
> Here are the requested details for client someone.else@example.com:
> • Last 4 digits of card: 5555
`;
    const r = parseEligibilityEmail(raw({ plainBody: body }), EXCLUDED);
    expect(r.emails).toEqual(['priya.r1985@example.com']);
    expect(r.last4).toBe('1763');
    expect(r.warnings).toEqual([]);
  });

  it('strips a leading 1 from an 11-digit phone and rejects short numbers', () => {
    expect(parseEligibilityEmail(raw({ plainBody: 'Tel: +1 (416) 555-0142' }), EXCLUDED).phone).toBe('4165550142');
    expect(parseEligibilityEmail(raw({ plainBody: 'Phone: 555-0142' }), EXCLUDED).phone).toBeNull();
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test -- src/data/eligibilityParse.test.ts`
Expected: FAIL with `Failed to load url ./eligibilityParse` (module does not exist).

- [ ] **Step 4: Implement the parser**

`extension/src/data/eligibilityParse.ts`:

```ts
// Parses one insurer eligibility-confirmation email into the fields the resolver needs.
// Pure: no chrome.*, no DOM. Spec section "2. Parser".

import type { EligibilityRequest, PersonName, RawEligibilityEmail } from './eligibilityTypes';

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const NAME_LABELS = ['Cardholder Name', 'Card Holder Name', 'Cardholder', 'Card Holder', 'Insured', 'Claimant', 'Name'];
const PHONE_LABELS = ['Phone', 'Telephone', 'Tel', 'Cell', 'Mobile'];
const DOL_LABELS = ['DOL', 'Date of Loss'];
const PHONE_RE = /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/;
const LAST4_PATTERNS: RegExp[] = [
  /last\s*(?:4|four)\s*(?:digits)?(?:\s*of\s*the\s*card)?\s*(?:is|are|:|-|–)?\s*(\d{4})\b/gi,
  /ending\s+(?:in|with)\s+(\d{4})\b/gi,
  /\d{4,6}[*xX•]{3,}(\d{4})\b/g,
  /[*xX•]{4,}\s?(\d{4})\b/g,
];
const SUBJECT_NAME_RE = /^[A-Za-zÀ-ÿ'’.-]+(?:\s+[A-Za-zÀ-ÿ'’.-]+){1,3}$/;
const CLAIM_RE = /claim\s*(?:#|no\.?|number)?\s*[:\-]?\s*([A-Z0-9-]{5,})/i;

export function normalizeName(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’]/g, "'")
    .replace(/[^a-z\s'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function splitName(raw: string): PersonName | null {
  const clean = raw.replace(/\s+/g, ' ').trim();
  const parts = clean.split(' ').filter(Boolean);
  if (parts.length < 2) return null;
  return { first: parts.slice(0, -1).join(' '), last: parts[parts.length - 1], raw: clean };
}

/** Drop quoted reply history: everything from an "On … wrote:" line, plus `>` lines. */
function stripQuoted(body: string): string {
  const cut = body.search(/^On .+wrote:\s*$/m);
  const head = cut >= 0 ? body.slice(0, cut) : body;
  return head
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('>'))
    .join('\n');
}

function labelled(body: string, labels: string[]): string | null {
  for (const label of labels) {
    const re = new RegExp('^\\s*' + label.replace(/\s+/g, '\\s*') + '\\s*[:\\-]\\s*(.+)$', 'im');
    const m = body.match(re);
    if (m && m[1].trim()) return m[1].trim();
  }
  return null;
}

function normalizePhone(s: string): string | null {
  let d = s.replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
  return d.length === 10 ? d : null;
}

function findLast4s(text: string): string[] {
  const seen: string[] = [];
  for (const re of LAST4_PATTERNS) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      if (!seen.includes(m[1])) seen.push(m[1]);
    }
  }
  return seen;
}

function subjectName(subject: string): string | null {
  const segments = subject.split(/\s[-–—]\s/).map((s) => s.trim()).filter(Boolean);
  const last = segments[segments.length - 1];
  return last && SUBJECT_NAME_RE.test(last) && !/claim|request|visa|wealthsimple/i.test(last) ? last : null;
}

function senderName(from: string): string {
  const m = from.match(/^\s*"?([^"<]*?)"?\s*</);
  return m ? m[1].trim() : '';
}

export function parseEligibilityEmail(raw: RawEligibilityEmail, excludedDomains: string[]): EligibilityRequest {
  const body = stripQuoted(raw.plainBody || '');
  const warnings: string[] = [];
  const excluded = new Set(excludedDomains.map((d) => d.toLowerCase()));
  const sender = raw.fromEmail.toLowerCase();

  // Emails: the labelled Email line first (it may list several), then the rest of the body.
  const emailLine = labelled(body, ['E-mail', 'Email Address', 'Email']) ?? '';
  const ordered = [...(emailLine.match(EMAIL_RE) ?? []), ...(body.match(EMAIL_RE) ?? [])];
  const emails: string[] = [];
  for (const e of ordered.map((x) => x.toLowerCase())) {
    const domain = e.split('@')[1] ?? '';
    if (e === sender || excluded.has(domain) || emails.includes(e)) continue;
    emails.push(e);
  }

  const nameRaw = labelled(body, NAME_LABELS) ?? subjectName(raw.subject || '');
  const cardholderName = nameRaw ? splitName(nameRaw) : null;

  const phoneLabel = labelled(body, PHONE_LABELS);
  const phoneMatch = (phoneLabel ?? '').match(PHONE_RE) ?? body.match(PHONE_RE);
  const phone = phoneLabel ? normalizePhone(phoneLabel) : phoneMatch ? normalizePhone(phoneMatch[0]) : null;

  const last4s = findLast4s(body);
  if (last4s.length > 1) warnings.push('Multiple last-4 values found: ' + last4s.join(', '));

  const claim = (raw.subject || '').match(CLAIM_RE) ?? body.match(CLAIM_RE);

  return {
    threadId: raw.threadId,
    messageId: raw.messageId,
    insurerEmail: sender,
    insurerName: senderName(raw.from),
    subject: raw.subject,
    receivedAt: raw.date,
    messageCount: raw.messageCount,
    cardholderName,
    emails,
    phone,
    last4: last4s[0] ?? null,
    claimNumber: claim ? claim[1] : null,
    dateOfLoss: labelled(body, DOL_LABELS),
    warnings,
  };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- src/data/eligibilityParse.test.ts`
Expected: PASS (all tests). If the "masked card numbers" case also matches pattern 4, the de-duplication keeps one value, which is fine.

- [ ] **Step 6: Commit**

```bash
git add src/data/eligibilityTypes.ts src/data/eligibilityParse.ts src/data/eligibilityParse.test.ts
git commit -m "Add eligibility request types and email parser

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Batch warehouse SQL builder + row coercion

**Files:**
- Create: `extension/src/data/eligibilitySql.ts`
- Test: `extension/src/data/eligibilitySql.test.ts`

**Interfaces:**
- Consumes: `EligibilityRequest`, `WarehouseRow`, `normalizeName` (Task 3).
- Produces: `CREDIT_PRODUCT_IDS: readonly string[]`, `buildEligibilitySql(reqs: EligibilityRequest[]): string | null`, `toWarehouseRows(rows: Record<string, unknown>[]): WarehouseRow[]`.

- [ ] **Step 1: Write the failing tests**

`extension/src/data/eligibilitySql.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildEligibilitySql, toWarehouseRows } from './eligibilitySql';
import type { EligibilityRequest } from './eligibilityTypes';

function req(over: Partial<EligibilityRequest>): EligibilityRequest {
  return {
    threadId: 't', messageId: 'abc123', insurerEmail: 'a@claims-co.example', insurerName: '',
    subject: '', receivedAt: '', messageCount: 1,
    cardholderName: { first: 'Priya', last: 'Ramanathan', raw: 'Priya Ramanathan' },
    emails: ['wrong.address@example.com', 'priya.r1985@example.com'],
    phone: null, last4: '1763', claimNumber: null, dateOfLoss: null, warnings: [],
    ...over,
  };
}

describe('buildEligibilitySql', () => {
  it('emits one email row per listed email and one name row per request', () => {
    const sql = buildEligibilitySql([req({})])!;
    expect(sql).toContain("SELECT 'abc123' AS request_id, 'wrong.address@example.com' AS email, '1763' AS last4");
    expect(sql).toContain("SELECT 'abc123', 'priya.r1985@example.com', '1763'");
    expect(sql).toContain("SELECT 'abc123' AS request_id, 'priya' AS first_norm, 'ramanathan' AS last_norm, '1763' AS last4");
    expect(sql).toContain("cc.i2c_card_status = 'open'");
    expect(sql).toContain("'ws_visa_infinite_core'");
  });

  it('escapes apostrophes in names', () => {
    const sql = buildEligibilitySql([req({ emails: [], cardholderName: { first: 'Zoë', last: "O'Neil", raw: "Zoë O'Neil" } })])!;
    expect(sql).toContain("'zoe' AS first_norm, 'o''neil' AS last_norm");
  });

  it('skips requests with no last4 and returns null when nothing is left', () => {
    expect(buildEligibilitySql([req({ last4: null })])).toBeNull();
  });

  it('drops values that fail validation instead of interpolating them', () => {
    const sql = buildEligibilitySql([req({ emails: ["x'; DROP TABLE t; --@example.com", 'ok@example.com'] })])!;
    expect(sql).not.toContain('DROP TABLE');
    expect(sql).toContain("'ok@example.com'");
  });

  it('uses an empty typed CTE when no request has emails', () => {
    const sql = buildEligibilitySql([req({ emails: [] })])!;
    expect(sql).toContain('WHERE FALSE');
  });

  it('includes a second request for the same client independently', () => {
    const sql = buildEligibilitySql([req({ messageId: 'aaa111' }), req({ messageId: 'bbb222' })])!;
    expect(sql).toContain("'aaa111'");
    expect(sql).toContain("'bbb222'");
  });
});

describe('toWarehouseRows', () => {
  it('coerces types and pads last4', () => {
    const rows = toWarehouseRows([
      { request_id: 'abc123', match_rule: 'email', identity_id: 'identity-X', client_email: 'P@Example.com',
        first_name: 'Priya', last_name: 'Ramanathan', last4: 42, card_product: 'ws_visa_infinite_privilege',
        created_date: '08/21/2026', is_delinquent: 'false' },
      { request_id: 'abc123', match_rule: 'name', identity_id: 'identity-Y', client_email: 'q@example.com',
        first_name: 'Priya', last_name: 'Ramanathan', last4: '1763', card_product: 'ws_visa_infinite_plus',
        created_date: '01/02/2026', is_delinquent: null },
    ]);
    expect(rows[0]).toEqual({
      requestId: 'abc123', matchRule: 'email', identityId: 'identity-X', clientEmail: 'p@example.com',
      firstName: 'Priya', lastName: 'Ramanathan', last4: '0042', cardProduct: 'ws_visa_infinite_privilege',
      createdDate: '08/21/2026', isDelinquent: false,
    });
    expect(rows[1].isDelinquent).toBeNull();
    expect(rows[1].matchRule).toBe('name');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/data/eligibilitySql.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`extension/src/data/eligibilitySql.ts`:

```ts
// Builds the one-per-batch warehouse query (spec "Step 1 — warehouse") and coerces its rows.
// Every interpolated value is validated against a strict pattern and quote-escaped.

import { normalizeName } from './eligibilityParse';
import type { EligibilityRequest, WarehouseRow } from './eligibilityTypes';

export const CREDIT_PRODUCT_IDS = [
  'ws_visa_infinite_privilege',
  'ws_visa_infinite_plus',
  'ws_visa_infinite_basic',
  'ws_visa_infinite_core',
] as const;

const SAFE_ID = /^[A-Za-z0-9]+$/;
const SAFE_EMAIL = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/;
const SAFE_NAME = /^[a-z' -]+$/;
const SAFE_LAST4 = /^\d{4}$/;

function q(s: string): string {
  return "'" + s.replace(/'/g, "''") + "'";
}

export function buildEligibilitySql(reqs: EligibilityRequest[]): string | null {
  const emailRows: string[] = [];
  const nameRows: string[] = [];

  for (const r of reqs) {
    if (!r.last4 || !SAFE_LAST4.test(r.last4) || !SAFE_ID.test(r.messageId)) continue;
    for (const e of r.emails) {
      if (SAFE_EMAIL.test(e)) emailRows.push(`${q(r.messageId)}|${q(e)}|${q(r.last4)}`);
    }
    if (r.cardholderName) {
      const first = normalizeName(r.cardholderName.first);
      const last = normalizeName(r.cardholderName.last);
      if (first && last && SAFE_NAME.test(first) && SAFE_NAME.test(last)) {
        nameRows.push(`${q(r.messageId)}|${q(first)}|${q(last)}|${q(r.last4)}`);
      }
    }
  }
  if (emailRows.length === 0 && nameRows.length === 0) return null;

  const emailCte = emailRows.length
    ? emailRows
        .map((row, i) => {
          const [id, email, last4] = row.split('|');
          return i === 0
            ? `  SELECT ${id} AS request_id, ${email} AS email, ${last4} AS last4`
            : `  UNION ALL SELECT ${id}, ${email}, ${last4}`;
        })
        .join('\n')
    : '  SELECT NULL::varchar AS request_id, NULL::varchar AS email, NULL::varchar AS last4 WHERE FALSE';

  const nameCte = nameRows.length
    ? nameRows
        .map((row, i) => {
          const [id, first, last, last4] = row.split('|');
          return i === 0
            ? `  SELECT ${id} AS request_id, ${first} AS first_norm, ${last} AS last_norm, ${last4} AS last4`
            : `  UNION ALL SELECT ${id}, ${first}, ${last}, ${last4}`;
        })
        .join('\n')
    : '  SELECT NULL::varchar AS request_id, NULL::varchar AS first_norm, NULL::varchar AS last_norm, NULL::varchar AS last4 WHERE FALSE';

  const products = CREDIT_PRODUCT_IDS.map(q).join(', ');

  return `WITH req_email AS (
${emailCte}
),
req_name AS (
${nameCte}
),
open_cards AS (
  SELECT cc.identity_id AS identity_canonical_id, RIGHT(cc.card_number, 4) AS card_last4,
         cc.created_at, cc.card_product_id
  FROM fort_knox.credit_cards cc
  WHERE cc.i2c_card_status = 'open' AND cc.card_product_id IN (${products})
),
latest_delinquency AS (
  SELECT d.identity_canonical_id, d.is_delinquent_account,
         ROW_NUMBER() OVER (PARTITION BY d.identity_canonical_id ORDER BY d.reporting_date DESC) AS rn
  FROM credit.mart_cc_acct_daily_reporting d
),
matched AS (
  SELECT DISTINCT r.request_id, 'email' AS match_rule, ip.identity_canonical_id
  FROM req_email r
  JOIN business_summary.identity_profile ip ON LOWER(ip.email) = r.email
  JOIN open_cards oc ON oc.identity_canonical_id = ip.identity_canonical_id AND oc.card_last4 = r.last4
  UNION
  SELECT DISTINCT r.request_id, 'name' AS match_rule, ip.identity_canonical_id
  FROM req_name r
  JOIN business_summary.identity_profile ip
    ON LOWER(TRIM(ip.first_name)) = r.first_norm AND LOWER(TRIM(ip.last_name)) = r.last_norm
  JOIN open_cards oc ON oc.identity_canonical_id = ip.identity_canonical_id AND oc.card_last4 = r.last4
)
SELECT m.request_id, m.match_rule, m.identity_canonical_id AS identity_id, ip.email AS client_email,
       ip.first_name, ip.last_name, oc.card_last4 AS last4, oc.card_product_id AS card_product,
       TO_CHAR(CONVERT_TIMEZONE('UTC', 'America/New_York', oc.created_at), 'MM/DD/YYYY') AS created_date,
       ld.is_delinquent_account AS is_delinquent
FROM matched m
JOIN business_summary.identity_profile ip ON ip.identity_canonical_id = m.identity_canonical_id
JOIN open_cards oc ON oc.identity_canonical_id = m.identity_canonical_id
LEFT JOIN latest_delinquency ld ON ld.identity_canonical_id = m.identity_canonical_id AND ld.rn = 1
ORDER BY m.request_id, m.match_rule, identity_id, last4`;
}

function str(v: unknown): string {
  return v == null ? '' : String(v).trim();
}

function bool(v: unknown): boolean | null {
  if (v === true || v === false) return v;
  const s = str(v).toLowerCase();
  if (s === 'true' || s === 't' || s === '1') return true;
  if (s === 'false' || s === 'f' || s === '0') return false;
  return null;
}

export function toWarehouseRows(rows: Record<string, unknown>[]): WarehouseRow[] {
  return rows.map((r) => ({
    requestId: str(r.request_id),
    matchRule: str(r.match_rule) === 'name' ? 'name' : 'email',
    identityId: str(r.identity_id),
    clientEmail: str(r.client_email).toLowerCase(),
    firstName: str(r.first_name),
    lastName: str(r.last_name),
    last4: str(r.last4).padStart(4, '0'),
    cardProduct: str(r.card_product),
    createdDate: str(r.created_date),
    isDelinquent: bool(r.is_delinquent),
  }));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- src/data/eligibilitySql.test.ts`
Expected: PASS.

- [ ] **Step 5: Sanity-run the generated SQL once in Preset SQL Lab** (Pantheon) with a two-request batch built from **your own** email and card last 4. Expected: rows come back with `match_rule = 'email'` and your card. Don't commit any output.

- [ ] **Step 6: Commit**

```bash
git add src/data/eligibilitySql.ts src/data/eligibilitySql.test.ts
git commit -m "Add batch warehouse SQL builder for eligibility matching

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Draft renderer

**Files:**
- Create: `extension/src/data/eligibilityDraft.ts`
- Test: `extension/src/data/eligibilityDraft.test.ts`

**Interfaces:**
- Consumes: `CardFact` (Task 3).
- Produces: `renderEligibilityDraft(args: { clientEmail: string | null; emailWasProvided: boolean; cards: CardFact[]; requestedLast4: string }): string`. It throws if any card has `delinquent === null`, `creationDate === ''` or `product === ''`. The resolver never marks such a card draftable.

- [ ] **Step 1: Write the failing tests**

`extension/src/data/eligibilityDraft.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { renderEligibilityDraft } from './eligibilityDraft';

const card = (last4: string, over = {}) => ({
  last4, product: 'ws_visa_infinite_privilege', creationDate: '08/21/2026', delinquent: false, ...over,
});

describe('renderEligibilityDraft', () => {
  it('matches the existing reply format byte-for-byte for one card', () => {
    const body = renderEligibilityDraft({
      clientEmail: 'priya.r1985@example.com', emailWasProvided: true, cards: [card('1763')], requestedLast4: '1763',
    });
    expect(body).toBe(
      'Hi,\n\n' +
      'Here are the requested details for client priya.r1985@example.com:\n\n' +
      '• Last 4 digits of card: 1763\n' +
      '• Status: the card is in good standing\n' +
      '• Activation date: 08/21/2026\n' +
      '• Product: ws_visa_infinite_privilege\n\n' +
      'Best,\nCash and Card Operations\n\n-- \n',
    );
  });

  it('omits the client email when the insurer did not supply it', () => {
    const body = renderEligibilityDraft({
      clientEmail: 'real.address@example.com', emailWasProvided: false, cards: [card('1763')], requestedLast4: '1763',
    });
    expect(body).toContain('Here are the requested details for client:\n\n');
    expect(body).not.toContain('real.address@example.com');
  });

  it('lists every card, requested last 4 first, separated by a blank line', () => {
    const body = renderEligibilityDraft({
      clientEmail: null, emailWasProvided: false,
      cards: [card('0042', { product: 'ws_visa_infinite_plus', creationDate: '01/02/2025' }), card('1763')],
      requestedLast4: '1763',
    });
    const i1763 = body.indexOf('card: 1763');
    const i0042 = body.indexOf('card: 0042');
    expect(i1763).toBeGreaterThan(-1);
    expect(i0042).toBeGreaterThan(i1763);
    expect(body).toContain('• Product: ws_visa_infinite_privilege\n\n• Last 4 digits of card: 0042');
  });

  it('says not in good standing for delinquent cards', () => {
    const body = renderEligibilityDraft({
      clientEmail: null, emailWasProvided: false, cards: [card('1763', { delinquent: true })], requestedLast4: '1763',
    });
    expect(body).toContain('• Status: the card is not in good standing');
  });

  it('refuses to render unknown facts', () => {
    expect(() => renderEligibilityDraft({
      clientEmail: null, emailWasProvided: false, cards: [card('1763', { delinquent: null })], requestedLast4: '1763',
    })).toThrow(/unknown/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/data/eligibilityDraft.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`extension/src/data/eligibilityDraft.ts`:

```ts
// Renders the reply body. Format is byte-identical to CC Ops Automation's
// sendAutoRepliescheck2, so insurers see no change.

import type { CardFact } from './eligibilityTypes';

export function renderEligibilityDraft(args: {
  clientEmail: string | null;
  emailWasProvided: boolean;
  cards: CardFact[];
  requestedLast4: string;
}): string {
  const { clientEmail, emailWasProvided, cards, requestedLast4 } = args;
  for (const c of cards) {
    if (c.delinquent === null || !c.creationDate || !c.product) {
      throw new Error(`Card ${c.last4} has unknown standing, date or product — cannot draft.`);
    }
  }
  const ordered = [
    ...cards.filter((c) => c.last4 === requestedLast4),
    ...cards.filter((c) => c.last4 !== requestedLast4),
  ];
  const who = emailWasProvided && clientEmail ? ' ' + clientEmail : '';
  const blocks = ordered.map((c) =>
    '• Last 4 digits of card: ' + c.last4.padStart(4, '0') + '\n' +
    '• Status: ' + (c.delinquent ? 'the card is not in good standing' : 'the card is in good standing') + '\n' +
    '• Activation date: ' + c.creationDate + '\n' +
    '• Product: ' + c.product,
  );
  return (
    'Hi,\n\n' +
    'Here are the requested details for client' + who + ':\n\n' +
    blocks.join('\n\n') + '\n\n' +
    'Best,\nCash and Card Operations\n\n-- \n'
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- src/data/eligibilityDraft.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/data/eligibilityDraft.ts src/data/eligibilityDraft.test.ts
git commit -m "Add eligibility reply renderer

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Resolver rules (pure)

**Files:**
- Create: `extension/src/data/eligibilityResolve.ts`
- Test: `extension/src/data/eligibilityResolve.test.ts`

**Interfaces:**
- Consumes: types (Task 3); `I2cCard` with the optional fields added in Task 8 (`program?`, `delinquencyStatus?`, `creationDate?`). To avoid a cross-task import cycle, this task declares the shape it needs locally as `I2cCardInput`.
- Produces:
  - `preflight(req: EligibilityRequest): Resolution | null`
  - `resolveFromWarehouse(req: EligibilityRequest, rows: WarehouseRow[]): Resolution | null`
  - `resolveFromI2c(req: EligibilityRequest, args: { email: string; method: 'i2c_email' | 'atlas_phone_i2c'; identityId: string | null; cards: I2cCardInput[]; mapProgram: (p: string | undefined) => string | null; parseDelinquency: (s: string | undefined) => boolean | null }): Resolution | null`
  - `multipleCandidates(req: EligibilityRequest, candidates: Candidate[], note: string): Resolution`
  - `noMatch(req: EligibilityRequest, note: string, extraFlags?: EligibilityFlag[]): Resolution`
  - `isDraftable(res: Resolution): boolean` (true when `method` is set, `cards.length > 0`, and no card has unknown facts)
  - `REVIEW_FREE_PRODUCTS: readonly string[]`

- [ ] **Step 1: Write the failing tests**

`extension/src/data/eligibilityResolve.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { isDraftable, noMatch, preflight, resolveFromI2c, resolveFromWarehouse } from './eligibilityResolve';
import type { EligibilityRequest, WarehouseRow } from './eligibilityTypes';

function req(over: Partial<EligibilityRequest> = {}): EligibilityRequest {
  return {
    threadId: 't', messageId: 'm1', insurerEmail: 'a@claims-co.example', insurerName: '', subject: '',
    receivedAt: '', messageCount: 1, cardholderName: { first: 'Priya', last: 'Ramanathan', raw: 'Priya Ramanathan' },
    emails: ['priya.r1985@example.com'], phone: '4165550142', last4: '1763', claimNumber: null, dateOfLoss: null,
    warnings: [], ...over,
  };
}

function row(over: Partial<WarehouseRow> = {}): WarehouseRow {
  return {
    requestId: 'm1', matchRule: 'email', identityId: 'identity-A', clientEmail: 'priya.r1985@example.com',
    firstName: 'Priya', lastName: 'Ramanathan', last4: '1763', cardProduct: 'ws_visa_infinite_privilege',
    createdDate: '08/21/2026', isDelinquent: false, ...over,
  };
}

describe('preflight', () => {
  it('stops already-replied threads', () => {
    expect(preflight(req({ messageCount: 2 }))?.flags).toEqual(['already_replied']);
  });
  it('stops requests without last4', () => {
    const r = preflight(req({ last4: null }))!;
    expect(r.status).toBe('needs_review');
    expect(r.flags).toEqual(['no_last4']);
  });
  it('passes normal requests', () => {
    expect(preflight(req())).toBeNull();
  });
});

describe('resolveFromWarehouse', () => {
  it('matches a single email identity and lists all its cards', () => {
    const r = resolveFromWarehouse(req(), [row(), row({ last4: '0042', cardProduct: 'ws_visa_infinite_plus' })])!;
    expect(r.status).toBe('matched');
    expect(r.method).toBe('email_last4');
    expect(r.cards.map((c) => c.last4)).toEqual(['1763', '0042']);
    expect(isDraftable(r)).toBe(true);
  });

  it('prefers the email rule over the name rule', () => {
    const r = resolveFromWarehouse(req(), [row({ matchRule: 'name', identityId: 'identity-B' }), row()])!;
    expect(r.identityId).toBe('identity-A');
    expect(r.method).toBe('email_last4');
  });

  it('falls back to a single name identity', () => {
    const r = resolveFromWarehouse(req(), [row({ matchRule: 'name', clientEmail: 'other@example.com' })])!;
    expect(r.method).toBe('name_last4');
    expect(r.clientEmail).toBe('other@example.com');
  });

  it('flags multiple candidates at the winning rule instead of picking one', () => {
    const r = resolveFromWarehouse(req(), [
      row({ matchRule: 'name', identityId: 'identity-B', clientEmail: 'b@example.com' }),
      row({ matchRule: 'name', identityId: 'identity-C', clientEmail: 'c@example.com' }),
    ])!;
    expect(r.status).toBe('needs_review');
    expect(r.flags).toEqual(['multiple_candidates']);
    expect(r.candidates.map((c) => c.identityId)).toEqual(['identity-B', 'identity-C']);
    expect(isDraftable(r)).toBe(false);
  });

  it('returns null when the warehouse has nothing for this request', () => {
    expect(resolveFromWarehouse(req(), [row({ requestId: 'other' })])).toBeNull();
  });

  it('flags delinquency, 1% products and parse warnings without dropping the match', () => {
    const r = resolveFromWarehouse(
      req({ warnings: ['Multiple last-4 values found: 1763, 9921'] }),
      [row({ isDelinquent: true, cardProduct: 'ws_visa_infinite_basic' })],
    )!;
    expect(r.status).toBe('needs_review');
    expect(r.flags.sort()).toEqual(['delinquent', 'parse_warning', 'vi_1pct']);
    expect(isDraftable(r)).toBe(true);
  });
});

describe('resolveFromI2c', () => {
  const deps = {
    mapProgram: (p?: string) => (p === 'Wealthsimple Visa Infinite VIP 01 Physical' ? 'ws_visa_infinite_privilege' : null),
    parseDelinquency: (s?: string) => (s === 'Current / Not Delinquent' ? false : null),
  };

  it('matches an open card with the requested last 4', () => {
    const r = resolveFromI2c(req(), {
      email: 'priya.r1985@example.com', method: 'i2c_email', identityId: null, ...deps,
      cards: [{ last4: '1763', status: 'ACTIVE', closed: false, program: 'Wealthsimple Visa Infinite VIP 01 Physical',
        delinquencyStatus: 'Current / Not Delinquent', creationDate: '07/07/2026' }],
    })!;
    expect(r.status).toBe('matched');
    expect(r.cards).toEqual([{ last4: '1763', product: 'ws_visa_infinite_privilege', creationDate: '07/07/2026', delinquent: false }]);
  });

  it('ignores closed cards', () => {
    expect(resolveFromI2c(req(), {
      email: 'x@example.com', method: 'i2c_email', identityId: null, ...deps,
      cards: [{ last4: '1763', status: 'CLOSED CARD', closed: true }],
    })).toBeNull();
  });

  it('flags unknown program and incomplete details', () => {
    const r = resolveFromI2c(req(), {
      email: 'x@example.com', method: 'i2c_email', identityId: null, ...deps,
      cards: [{ last4: '1763', status: 'ACTIVE', closed: false, program: 'Some New Program' }],
    })!;
    expect(r.flags.sort()).toEqual(['i2c_details_incomplete', 'unknown_product']);
    expect(isDraftable(r)).toBe(false);
  });
});

describe('noMatch', () => {
  it('builds a no_match resolution', () => {
    const r = noMatch(req(), 'Nothing found');
    expect(r.status).toBe('no_match');
    expect(r.cards).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/data/eligibilityResolve.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`extension/src/data/eligibilityResolve.ts`:

```ts
// Matching rules from the spec's "Matching outcomes" table. Pure: callers do all I/O.

import type {
  CardFact, Candidate, EligibilityFlag, EligibilityRequest, MatchMethod, Resolution, WarehouseRow,
} from './eligibilityTypes';

/** Products whose replies need no manual coverage note. Anything else is flagged vi_1pct. */
export const REVIEW_FREE_PRODUCTS = ['ws_visa_infinite_privilege', 'ws_visa_infinite_plus'] as const;

/** The i2c card shape this module needs (I2cCard from i2cCardLookup.ts satisfies it). */
export interface I2cCardInput {
  last4: string;
  status: string;
  closed: boolean;
  program?: string;
  delinquencyStatus?: string;
  creationDate?: string;
}

function base(req: EligibilityRequest): Resolution {
  return {
    requestId: req.messageId, status: 'no_match', method: null, clientEmail: null, identityId: null,
    cards: [], flags: [], candidates: [], note: '',
  };
}

export function noMatch(req: EligibilityRequest, note: string, extraFlags: EligibilityFlag[] = []): Resolution {
  return { ...base(req), status: extraFlags.length ? 'needs_review' : 'no_match', flags: extraFlags, note };
}

export function multipleCandidates(req: EligibilityRequest, candidates: Candidate[], note: string): Resolution {
  return { ...base(req), status: 'needs_review', flags: ['multiple_candidates'], candidates, note };
}

export function preflight(req: EligibilityRequest): Resolution | null {
  if (req.messageCount > 1) return noMatch(req, 'Thread already has a reply.', ['already_replied']);
  if (!req.last4) return noMatch(req, 'No card last 4 in the email — will not match on name alone.', ['no_last4']);
  return null;
}

function sortRequestedFirst(cards: CardFact[], last4: string): CardFact[] {
  return [...cards.filter((c) => c.last4 === last4), ...cards.filter((c) => c.last4 !== last4)];
}

function matched(
  req: EligibilityRequest, method: MatchMethod, identityId: string | null, clientEmail: string, cards: CardFact[], note: string,
): Resolution {
  const flags: EligibilityFlag[] = [];
  if (req.warnings.length) flags.push('parse_warning');
  if (cards.some((c) => c.delinquent === true)) flags.push('delinquent');
  if (cards.some((c) => c.product && !(REVIEW_FREE_PRODUCTS as readonly string[]).includes(c.product))) flags.push('vi_1pct');
  if (cards.some((c) => !c.product)) flags.push('unknown_product');
  if (cards.some((c) => !c.creationDate || c.delinquent === null)) flags.push('i2c_details_incomplete');
  return {
    requestId: req.messageId,
    status: flags.length ? 'needs_review' : 'matched',
    method, identityId, clientEmail,
    cards: sortRequestedFirst(cards, req.last4 ?? ''),
    flags, candidates: [], note,
  };
}

export function resolveFromWarehouse(req: EligibilityRequest, rows: WarehouseRow[]): Resolution | null {
  const mine = rows.filter((r) => r.requestId === req.messageId);
  for (const rule of ['email', 'name'] as const) {
    const ids = [...new Set(mine.filter((r) => r.matchRule === rule).map((r) => r.identityId))];
    if (ids.length === 0) continue;
    if (ids.length > 1) {
      const candidates = ids.map((id) => {
        const r = mine.find((x) => x.identityId === id)!;
        return { identityId: id, clientEmail: r.clientEmail, name: `${r.firstName} ${r.lastName}`.trim() };
      });
      return multipleCandidates(req, candidates, `${ids.length} clients match on ${rule} + last 4.`);
    }
    const id = ids[0];
    const own = mine.filter((r) => r.identityId === id);
    const byLast4 = new Map<string, CardFact>();
    for (const r of own) {
      if (!byLast4.has(r.last4)) {
        byLast4.set(r.last4, { last4: r.last4, product: r.cardProduct, creationDate: r.createdDate, delinquent: r.isDelinquent });
      }
    }
    const method: MatchMethod = rule === 'email' ? 'email_last4' : 'name_last4';
    return matched(req, method, id, own[0].clientEmail, [...byLast4.values()], `Warehouse: ${rule} + last 4.`);
  }
  return null;
}

export function resolveFromI2c(
  req: EligibilityRequest,
  args: {
    email: string;
    method: 'i2c_email' | 'atlas_phone_i2c';
    identityId: string | null;
    cards: I2cCardInput[];
    mapProgram: (p: string | undefined) => string | null;
    parseDelinquency: (s: string | undefined) => boolean | null;
  },
): Resolution | null {
  const open = args.cards.filter((c) => !c.closed);
  if (!open.some((c) => c.last4 === req.last4)) return null;
  const cards: CardFact[] = open.map((c) => ({
    last4: c.last4,
    product: args.mapProgram(c.program) ?? '',
    creationDate: c.creationDate ?? '',
    delinquent: args.parseDelinquency(c.delinquencyStatus),
  }));
  const how = args.method === 'i2c_email' ? 'i2c: listed email + last 4.' : 'Atlas phone + name → i2c last 4.';
  return matched(req, args.method, args.identityId, args.email, cards, how);
}

export function isDraftable(res: Resolution): boolean {
  return (
    res.method != null &&
    res.cards.length > 0 &&
    res.cards.every((c) => c.delinquent !== null && !!c.creationDate && !!c.product)
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- src/data/eligibilityResolve.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/data/eligibilityResolve.ts src/data/eligibilityResolve.test.ts
git commit -m "Add eligibility matching rules

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Preset SQL runner + paste fallback

**Files:**
- Create: `extension/src/data/presetSql.ts`
- Test: `extension/src/data/presetSql.test.ts`

**Interfaces:**
- Consumes: Task 1 decision `PRESET_MODE`.
- Produces: `PRESET_BASE`, `PANTHEON_DATABASE_ID = 3`, `PRESET_DIRECT_ENABLED: boolean`, `class PresetAuthError extends Error`, `runPresetSql(sql: string, fetchImpl?: FetchLike, sleep?: (ms: number) => Promise<void>): Promise<Record<string, unknown>[]>`, `parsePastedResults(text: string): Record<string, string>[]`.

- [ ] **Step 1: Write the failing tests**

`extension/src/data/presetSql.test.ts`:

```ts
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
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/data/presetSql.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`extension/src/data/presetSql.ts`. Set `PRESET_DIRECT_ENABLED` from Task 1: `true` for `direct-sync`/`direct-async`, `false` for `paste-only`.

```ts
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

export function parsePastedResults(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const sep = lines[0].includes('\t') ? '\t' : ',';
  const headers = lines[0].split(sep).map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cells = line.split(sep);
    const o: Record<string, string> = {};
    headers.forEach((h, i) => { o[h] = (cells[i] ?? '').trim(); });
    return o;
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- src/data/presetSql.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/data/presetSql.ts src/data/presetSql.test.ts
git commit -m "Add Preset SQL Lab runner and pasted-results parser

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: i2c card details — Program, Delinquency Status, Card Creation Date

**Files:**
- Create: `extension/src/data/i2cCardDetailsParse.ts`
- Create: `extension/src/data/eligibilityProducts.ts`
- Test: `extension/src/data/i2cCardDetailsParse.test.ts`
- Modify: `extension/src/data/i2cCardLookup.ts` (the `I2cCard` interface, around lines 20-27)
- Modify: `extension/src/content/i2c.ts` (`ScrapedCard` and `tryCardDetailsScrape`, around lines 1238-1302)

**Interfaces:**
- Produces: `readLabelValue(leaves: string[], label: string): string | null`, `readProgramForLast4(headers: string[], rows: string[][], last4: string): string | null`, `parseI2cDelinquency(s: string | undefined): boolean | null`, `mapI2cProgram(p: string | undefined): string | null`, `I2C_PROGRAM_TO_PRODUCT: Record<string, string>`. `I2cCard` gains optional `program?: string; delinquencyStatus?: string; creationDate?: string`.

- [ ] **Step 1: Write the failing tests**

`extension/src/data/i2cCardDetailsParse.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseI2cDelinquency, readLabelValue, readProgramForLast4 } from './i2cCardDetailsParse';
import { mapI2cProgram } from './eligibilityProducts';

const LEAVES = [
  'Card Details', 'Last Five Transactions',
  'Card Reference Number:', '527024663778',
  'Card Status Reason:', '-',
  'Delinquency Status:', 'Current / Not Delinquent',
  'Collection Status:', 'Not In Collection',
  'Card Creation Date:', '07/07/2026',
  'Free Text :', 'Funds Expiry Date:', 'N/A',
];

describe('readLabelValue', () => {
  it('returns the leaf after the label', () => {
    expect(readLabelValue(LEAVES, 'Delinquency Status:')).toBe('Current / Not Delinquent');
    expect(readLabelValue(LEAVES, 'Card Creation Date')).toBe('07/07/2026');
  });
  it('returns null when the next leaf is another label', () => {
    expect(readLabelValue(LEAVES, 'Free Text :')).toBeNull();
  });
  it('returns null for "-" placeholders and missing labels', () => {
    expect(readLabelValue(LEAVES, 'Card Status Reason:')).toBeNull();
    expect(readLabelValue(LEAVES, 'Nope:')).toBeNull();
  });
});

describe('readProgramForLast4', () => {
  it('reads the Program column of the row containing the last 4', () => {
    const headers = ['Account Number', 'Account Ref. Num', 'Program', 'Account Type'];
    const rows = [['412650******6990', '527024663778', 'Wealthsimple Visa Infinite VIP 01 Physical', 'Credit - Primary']];
    expect(readProgramForLast4(headers, rows, '6990')).toBe('Wealthsimple Visa Infinite VIP 01 Physical');
    expect(readProgramForLast4(headers, rows, '1111')).toBeNull();
  });
});

describe('parseI2cDelinquency', () => {
  it('maps i2c wording', () => {
    expect(parseI2cDelinquency('Current / Not Delinquent')).toBe(false);
    expect(parseI2cDelinquency('Delinquent 30 Days')).toBe(true);
    expect(parseI2cDelinquency('')).toBeNull();
    expect(parseI2cDelinquency(undefined)).toBeNull();
  });
});

describe('mapI2cProgram', () => {
  it('maps known programs and rejects unknown ones', () => {
    expect(mapI2cProgram('Wealthsimple  Visa Infinite VIP 01 Physical ')).toBe('ws_visa_infinite_privilege');
    expect(mapI2cProgram('Something Else')).toBeNull();
    expect(mapI2cProgram(undefined)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/data/i2cCardDetailsParse.test.ts`
Expected: FAIL (modules not found).

- [ ] **Step 3: Implement the pure helpers**

`extension/src/data/i2cCardDetailsParse.ts`:

```ts
// Pure readers for i2c's customer page (Accounts table + Card Details panel).

const norm = (s: string) => s.replace(/\s+/g, ' ').trim().replace(/\s*:\s*$/, '').toLowerCase();
const isLabel = (s: string) => /:\s*$/.test(s.trim());

export function readLabelValue(leaves: string[], label: string): string | null {
  const want = norm(label);
  const i = leaves.findIndex((l) => norm(l) === want);
  if (i < 0 || i + 1 >= leaves.length) return null;
  const next = leaves[i + 1].trim();
  if (!next || isLabel(next) || next === '-') return null;
  return next;
}

export function readProgramForLast4(headers: string[], rows: string[][], last4: string): string | null {
  const col = headers.findIndex((h) => norm(h) === 'program');
  if (col < 0) return null;
  const row = rows.find((r) => r.some((cell) => new RegExp(`[*x•]{3,}${last4}\\b`, 'i').test(cell)));
  const v = row?.[col]?.replace(/\s+/g, ' ').trim();
  return v ? v : null;
}

export function parseI2cDelinquency(s: string | undefined): boolean | null {
  const t = (s ?? '').trim();
  if (!t) return null;
  if (/not\s+delinquent/i.test(t)) return false;
  if (/delinquent/i.test(t)) return true;
  return null;
}
```

`extension/src/data/eligibilityProducts.ts`:

```ts
// i2c "Program" → card_product_id. Seed values come from confirmed matches (e.g. a client whose
// warehouse card_product_id and i2c Program were both visible). Unknown programs return null,
// which the resolver flags as unknown_product. Never guess.

export const I2C_PROGRAM_TO_PRODUCT: Record<string, string> = {
  'Wealthsimple Visa Infinite VIP 01 Physical': 'ws_visa_infinite_privilege',
};

export function mapI2cProgram(p: string | undefined): string | null {
  if (!p) return null;
  const key = p.replace(/\s+/g, ' ').trim();
  return I2C_PROGRAM_TO_PRODUCT[key] ?? null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- src/data/i2cCardDetailsParse.test.ts`
Expected: PASS.

- [ ] **Step 5: Extend `I2cCard`** in `extension/src/data/i2cCardLookup.ts`. Replace the interface with:

```ts
export interface I2cCard {
  /** Last 4 digits. */
  last4: string;
  /** i2c's status wording, e.g. 'ACTIVE', 'ACTIVE (Reissued)', 'CLOSED CARD'. */
  status: string;
  /** True when the status reads CLOSED — the card the refund was declined on. */
  closed: boolean;
  /** Accounts table "Program", e.g. 'Wealthsimple Visa Infinite VIP 01 Physical'. */
  program?: string;
  /** Card Details "Delinquency Status". Only set when the page shows exactly one open card. */
  delinquencyStatus?: string;
  /** Card Details "Card Creation Date" (MM/DD/YYYY). Only set when exactly one open card. */
  creationDate?: string;
}
```

- [ ] **Step 6: Enrich the scrape** in `extension/src/content/i2c.ts`.
  - Add the import at the top with the other `../data/` imports: `import { readLabelValue, readProgramForLast4 } from '../data/i2cCardDetailsParse';`
  - Change `interface ScrapedCard { last4: string; status: string; closed: boolean }` to:

```ts
interface ScrapedCard {
  last4: string; status: string; closed: boolean;
  program?: string; delinquencyStatus?: string; creationDate?: string;
}
```

  - Add these helpers directly above `async function tryCardDetailsScrape()`:

```ts
/** Visible leaf texts in document order (elements with text but no element children). */
function leafTextsForDetails(): string[] {
  const out: string[] = [];
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
    if (el.children.length > 0) continue;
    const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (t) out.push(t);
  }
  return out;
}

/** Program per card, from whichever table has a "Program" header. */
function enrichCards(cards: ScrapedCard[]): ScrapedCard[] {
  let headers: string[] = [];
  let rows: string[][] = [];
  for (const table of Array.from(document.querySelectorAll<HTMLTableElement>('table'))) {
    const ths = Array.from(table.querySelectorAll('th')).map((th) => (th.textContent || '').trim());
    if (!ths.some((h) => /^program$/i.test(h))) continue;
    headers = ths;
    rows = Array.from(table.querySelectorAll('tr'))
      .filter((tr) => tr.querySelectorAll('td').length > 0 && !tr.querySelector('tr'))
      .map((tr) => Array.from(tr.querySelectorAll('td')).map((td) => (td.textContent || '').trim()));
    break;
  }
  const leaves = leafTextsForDetails();
  const open = cards.filter((c) => !c.closed);
  const delinquencyStatus = readLabelValue(leaves, 'Delinquency Status:') ?? undefined;
  const creationDate = readLabelValue(leaves, 'Card Creation Date:') ?? undefined;
  return cards.map((c) => ({
    ...c,
    program: readProgramForLast4(headers, rows, c.last4) ?? undefined,
    // The Card Details panel describes one card; only trust it when there is exactly one open card.
    ...(open.length === 1 && !c.closed ? { delinquencyStatus, creationDate } : {}),
  }));
}
```

  - In `tryCardDetailsScrape`, change `const cards = readCardsFromPage();` to `const cards = enrichCards(readCardsFromPage());`.

- [ ] **Step 7: Build**

Run: `npm run build`
Expected: build succeeds. (The live check that `program`, `delinquencyStatus` and `creationDate` come back filled happens in Task 14 Step 1, through the panel, against what i2c shows on the Card Details tab.)

- [ ] **Step 8: Run the full suite and commit**

Run: `npm test`
Expected: PASS (the refund-letter callers of `I2cCard` still type-check, because the new fields are optional).

```bash
git add src/data/i2cCardDetailsParse.ts src/data/i2cCardDetailsParse.test.ts src/data/eligibilityProducts.ts src/data/i2cCardLookup.ts src/content/i2c.ts
git commit -m "Read Program, delinquency and creation date in the i2c card_details chain

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Atlas search by phone (skip if spike S2 recorded `false`)

**Files:**
- Create: `extension/src/data/atlasPhoneSearch.ts`
- Test: `extension/src/data/atlasPhoneSearch.test.ts`
- Uses fixture: `extension/src/data/__fixtures__/atlasPhoneSearch.json` (Task 2)

**Interfaces:**
- Consumes: `atlasGraphql(service, operationName, query, variables)` from `src/data/atlasGraphql.ts`; S2 constants.
- Produces: `ATLAS_PHONE_SEARCH_ENABLED: boolean`, `interface AtlasPhoneHit { identityId: string; firstName: string; lastName: string; email: string | null }`, `readPhoneSearchHits(res: unknown): AtlasPhoneHit[]`, `searchAtlasByPhone(phone: string): Promise<AtlasPhoneHit[]>`.

- [ ] **Step 1: Write the failing tests**

`extension/src/data/atlasPhoneSearch.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import fixture from './__fixtures__/atlasPhoneSearch.json';
import { readPhoneSearchHits } from './atlasPhoneSearch';

describe('readPhoneSearchHits', () => {
  it('finds identity hits in the captured Atlas response', () => {
    const hits = readPhoneSearchHits(fixture);
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) expect(h.identityId).toMatch(/^identity-/);
  });

  it('reads names and email from common key shapes and de-duplicates by id', () => {
    const res = {
      data: {
        search: {
          results: [
            { id: 'identity-A', firstName: 'Priya', lastName: 'Ramanathan', email: 'p@example.com' },
            { id: 'identity-A', firstName: 'Priya', lastName: 'Ramanathan', email: 'p@example.com' },
            { id: 'identity-B', profile: { first_name: 'Sam', last_name: 'Lee' } },
            { id: 'account-X', firstName: 'Not', lastName: 'Identity' },
          ],
        },
      },
    };
    expect(readPhoneSearchHits(res)).toEqual([
      { identityId: 'identity-A', firstName: 'Priya', lastName: 'Ramanathan', email: 'p@example.com' },
      { identityId: 'identity-B', firstName: 'Sam', lastName: 'Lee', email: null },
    ]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/data/atlasPhoneSearch.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`extension/src/data/atlasPhoneSearch.ts`. Paste the four `ATLAS_PHONE_*` values verbatim from the S2 section of the spikes doc. Format the phone the way S2 recorded. The `formatPhone` below assumes 10 bare digits; change only its return line if S2 recorded `+1XXXXXXXXXX`.

```ts
// Atlas identity search by phone (spike S2). Reads hits generically so small response-shape
// changes don't break it: any object whose `id` starts with "identity-" is a hit.

import { atlasGraphql, type AtlasGraphqlService } from './atlasGraphql';

export const ATLAS_PHONE_SEARCH_ENABLED = true;
const ATLAS_PHONE_SERVICE: AtlasGraphqlService = ''; // from S2
const ATLAS_PHONE_OPERATION = ''; // from S2
const ATLAS_PHONE_QUERY = ``; // from S2, verbatim
const ATLAS_PHONE_VARIABLE = ''; // from S2

export interface AtlasPhoneHit {
  identityId: string;
  firstName: string;
  lastName: string;
  email: string | null;
}

function pick(o: Record<string, unknown> | undefined, keys: string[]): string {
  if (!o) return '';
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

const FIRST = ['firstName', 'first_name', 'givenName', 'legalFirstName'];
const LAST = ['lastName', 'last_name', 'familyName', 'legalLastName'];
const EMAIL = ['email', 'primaryEmail', 'email_address', 'emailAddress'];

export function readPhoneSearchHits(res: unknown): AtlasPhoneHit[] {
  const out = new Map<string, AtlasPhoneHit>();
  const walk = (v: unknown) => {
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (!v || typeof v !== 'object') return;
    const o = v as Record<string, unknown>;
    if (typeof o.id === 'string' && o.id.startsWith('identity-') && !out.has(o.id)) {
      const nested = [o, o.profile, o.name, o.legalName].filter((x) => x && typeof x === 'object') as Record<string, unknown>[];
      const firstName = nested.map((n) => pick(n, FIRST)).find(Boolean) ?? '';
      const lastName = nested.map((n) => pick(n, LAST)).find(Boolean) ?? '';
      const email = nested.map((n) => pick(n, EMAIL)).find(Boolean) || null;
      out.set(o.id, { identityId: o.id, firstName, lastName, email: email ? email.toLowerCase() : null });
    }
    Object.values(o).forEach(walk);
  };
  walk(res);
  return [...out.values()];
}

function formatPhone(digits10: string): string {
  return digits10;
}

export async function searchAtlasByPhone(phone: string): Promise<AtlasPhoneHit[]> {
  const res = await atlasGraphql(ATLAS_PHONE_SERVICE, ATLAS_PHONE_OPERATION, ATLAS_PHONE_QUERY, {
    [ATLAS_PHONE_VARIABLE]: formatPhone(phone),
  });
  return readPhoneSearchHits(res);
}
```

If `tsconfig.json` lacks `"resolveJsonModule": true`, the fixture import fails to type-check. Add `"resolveJsonModule": true` under `compilerOptions`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- src/data/atlasPhoneSearch.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/data/atlasPhoneSearch.ts src/data/atlasPhoneSearch.test.ts
# plus tsconfig.json only if you changed it
git commit -m "Add Atlas identity search by phone

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

**If S2 recorded `false`:** create `extension/src/data/atlasPhoneSearch.ts` containing only the following, so Task 12/13 imports compile. Then commit with the message "Stub Atlas phone search (no Atlas phone search exists)".

```ts
export const ATLAS_PHONE_SEARCH_ENABLED = false;
export interface AtlasPhoneHit { identityId: string; firstName: string; lastName: string; email: string | null }
export async function searchAtlasByPhone(_phone: string): Promise<AtlasPhoneHit[]> {
  return [];
}
```

---

### Task 10: Eligibility bridge (Apps Script, deployed as creditcardoperations@)

**Files:**
- Create: `gas/cc-ops-eligibility/Eligibility.gs` (repo copy of what gets pasted)
- Create: `gas/cc-ops-eligibility/README.md` (deploy steps)

**Interfaces:**
- Consumes (already in the CC Ops Automation project): `extractEmailAddress_(fromStr)`, `loadInsurers_()`.
- Produces (HTTP GET `?action=`):
  - `listEligibilityRequests` → `{action:'eligibilityRequestsListed', requests: RawEligibilityEmail[], excludedDomains: string[], skippedUnknownSender: number}`
  - `createEligibilityDraft&messageId=&body=` → `{action:'eligibilityDraftCreated', messageId, draftId, reused}`
  - `sendEligibilityDrafts&draftIds=a,b` → `{action:'eligibilityDraftsSent', results:[{draftId, ok, error?}]}`
  - `logEligibilityResult&row=<JSON>` → `{action:'eligibilityResultLogged', rowNumber}`
  - Any failure → `{error: string}`

- [ ] **Step 1: Check for an existing `doGet`.** Open CC Ops Automation → Extensions → Apps Script (signed in as `creditcardoperations@`). Search all files for `function doGet`. If one exists, **stop and tell the user**. Two `doGet`s collide, so the router below would have to be merged into it. If none exists, continue.

- [ ] **Step 2: Write the file** `gas/cc-ops-eligibility/Eligibility.gs`:

```js
// Insurance Eligibility Confirmation Triage — bridge for Sidekick.
// Lives in the CC Ops Automation Apps Script project, owned by creditcardoperations@.
// Deploy as a web app: Execute as = Me, Who has access = Anyone within Wealthsimple.
// Replies postMessage to window.top (NOT window.parent — GAS's inner wrapper drops them).

var ELIG_LABEL_DRAFTED = 'Sidekick/Drafted';
var ELIG_LABEL_SENT = 'Sidekick/Sent';
var ELIG_BODY_CAP = 20000;
var ELIG_EXTRA_COLS = ['match_method', 'draft_id', 'notes'];

function doGet(e) {
  var p = (e && e.parameter) || {};
  try {
    switch (p.action) {
      case 'listEligibilityRequests':
        return eligReply_(eligList_());
      case 'createEligibilityDraft':
        return eligReply_(eligCreateDraft_(p.messageId, p.body));
      case 'sendEligibilityDrafts':
        return eligReply_(eligSendDrafts_(String(p.draftIds || '').split(',').filter(String)));
      case 'logEligibilityResult':
        return eligReply_(eligLog_(JSON.parse(p.row)));
      default:
        return eligReply_({ error: 'Unknown action: ' + p.action });
    }
  } catch (err) {
    return eligReply_({ error: String((err && err.message) || err) });
  }
}

function eligReply_(payload) {
  var json = JSON.stringify(payload).replace(/</g, '\\u003c');
  var html = '<!doctype html><html><body><script>window.top.postMessage(' + json + ', "*");</script></body></html>';
  return HtmlService.createHtmlOutput(html).setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function eligLabel_(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}

function eligHasLabel_(thread, name) {
  return thread.getLabels().some(function (l) { return l.getName() === name; });
}

function eligList_() {
  var insurers = loadInsurers_();
  // Domains from the normalised addresses. (loadInsurerDomains_ splits the raw
  // "Name <x@y>" string and yields "y>", so it never matches — don't reuse it.)
  var domains = {};
  Object.keys(insurers).forEach(function (addr) {
    var d = addr.split('@')[1];
    if (d) domains[d.toLowerCase()] = true;
  });
  domains['wealthsimple.com'] = true;

  var threads = GmailApp.search('in:inbox is:unread -label:sidekick-drafted', 0, 100);
  var out = [];
  var skipped = 0;
  threads.forEach(function (t) {
    var msgs = t.getMessages();
    var m = msgs[msgs.length - 1];
    if (!m.isUnread()) return;
    var fromEmail = extractEmailAddress_(m.getFrom());
    if (!insurers[fromEmail]) { skipped++; return; }
    out.push({
      threadId: t.getId(),
      messageId: m.getId(),
      from: m.getFrom(),
      fromEmail: fromEmail,
      subject: m.getSubject(),
      date: m.getDate().toISOString(),
      messageCount: msgs.length,
      plainBody: (m.getPlainBody() || '').substring(0, ELIG_BODY_CAP),
    });
  });
  return {
    action: 'eligibilityRequestsListed',
    requests: out,
    excludedDomains: Object.keys(domains),
    skippedUnknownSender: skipped,
  };
}

function eligCreateDraft_(messageId, body) {
  if (!messageId || !body) throw new Error('messageId and body are required');
  var msg = GmailApp.getMessageById(messageId);
  var thread = msg.getThread();
  if (eligHasLabel_(thread, ELIG_LABEL_DRAFTED)) {
    var existing = GmailApp.getDrafts().filter(function (d) {
      return d.getMessage().getThread().getId() === thread.getId();
    })[0];
    if (existing) return { action: 'eligibilityDraftCreated', messageId: messageId, draftId: existing.getId(), reused: true };
  }
  var draft = msg.createDraftReply(body, { name: 'Cash and Card Operations' });
  thread.addLabel(eligLabel_(ELIG_LABEL_DRAFTED));
  return { action: 'eligibilityDraftCreated', messageId: messageId, draftId: draft.getId(), reused: false };
}

function eligSendDrafts_(draftIds) {
  var drafted = eligLabel_(ELIG_LABEL_DRAFTED);
  var sentLabel = eligLabel_(ELIG_LABEL_SENT);
  var results = draftIds.map(function (id) {
    try {
      var sent = GmailApp.getDraft(id).send();
      var t = sent.getThread();
      t.markRead();
      t.removeLabel(drafted);
      t.addLabel(sentLabel);
      return { draftId: id, ok: true };
    } catch (err) {
      return { draftId: id, ok: false, error: String((err && err.message) || err) };
    }
  });
  return { action: 'eligibilityDraftsSent', results: results };
}

function eligLog_(row) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Requests');
  if (!sheet) throw new Error('Requests sheet not found');
  var header = sheet.getRange(1, 1, 1, 12).getValues()[0];
  ELIG_EXTRA_COLS.forEach(function (name, i) {
    if (!header[9 + i]) sheet.getRange(1, 10 + i).setValue(name);
  });
  var values = [[
    row.request_message_id, row.thread_id, row.insurer_email, row.client_email, row.status,
    row.last4, row.is_delinquent, row.activation_date, row.card_product,
    row.match_method, row.draft_id, row.notes,
  ]];
  var last = sheet.getLastRow();
  var ids = last >= 2 ? sheet.getRange(2, 1, last - 1, 1).getValues() : [];
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(row.request_message_id)) {
      sheet.getRange(i + 2, 1, 1, 12).setValues(values);
      return { action: 'eligibilityResultLogged', rowNumber: i + 2 };
    }
  }
  sheet.getRange(last + 1, 1, 1, 12).setValues(values);
  return { action: 'eligibilityResultLogged', rowNumber: last + 1 };
}

// ---- Editor test helpers (Run ▸ from the editor; read the Execution log) ----

function testListEligibilityRequests() {
  var r = eligList_();
  Logger.log('requests=%s skippedUnknownSender=%s domains=%s', r.requests.length, r.skippedUnknownSender, r.excludedDomains.join(','));
  r.requests.slice(0, 3).forEach(function (q) { Logger.log('%s | %s | %s', q.messageId, q.fromEmail, q.subject); });
}

/** Drafts twice on the newest listed request and checks the second call reuses the draft. Deletes the draft afterwards. */
function testEligibilityIdempotency() {
  var r = eligList_();
  if (!r.requests.length) { Logger.log('No unread insurer requests to test on.'); return; }
  var id = r.requests[0].messageId;
  var a = eligCreateDraft_(id, 'TEST DRAFT — delete me');
  var b = eligCreateDraft_(id, 'TEST DRAFT — delete me');
  Logger.log('first=%s second=%s reused=%s', a.draftId, b.draftId, b.reused);
  if (a.draftId !== b.draftId || !b.reused) throw new Error('Idempotency FAILED');
  GmailApp.getDraft(a.draftId).deleteDraft();
  var t = GmailApp.getMessageById(id).getThread();
  t.removeLabel(eligLabel_(ELIG_LABEL_DRAFTED));
  Logger.log('Idempotency OK; test draft deleted, label removed.');
}
```

- [ ] **Step 3: Write `gas/cc-ops-eligibility/README.md`**:

```markdown
# CC Ops eligibility bridge

Pasted into the **CC Ops Automation** Apps Script project (Extensions → Apps Script from the
sheet), signed in as creditcardoperations@wealthsimple.com. No clasp.

1. Add a file `Eligibility.gs`, paste `Eligibility.gs` from this folder, Save.
2. Run `testListEligibilityRequests` once and accept the Gmail + Sheets permission prompt.
3. Run `testEligibilityIdempotency` (needs ≥1 unread insurer email). Expect "Idempotency OK".
4. Deploy → New deployment → Web app. Execute as: **Me**. Who has access: **Anyone within Wealthsimple**.
5. Copy the `/exec` URL into `extension/src/api/bridgeTabs.ts` → `ELIGIBILITY_BRIDGE_URL`.
5a. In the sheet's `previous records` tab, type `match_method`, `draft_id`, `notes` into J1, K1, L1
    (once). `Requests` gets them automatically on the first logged row.
6. After every later edit: Deploy → Manage deployments → Edit → Version: **New version**.
```

- [ ] **Step 4: Paste, authorize, test, deploy.** Follow README steps 1–4.
Expected: `testListEligibilityRequests` logs a non-negative count. `testEligibilityIdempotency` logs "Idempotency OK", and the test draft is gone from Drafts.

- [ ] **Step 5: Smoke-test the deployed URL** from your normal profile. Open `<exec URL>?action=listEligibilityRequests` in a tab.
Expected: a blank page (the content script relays and closes it), with no Google "access denied" page. If you see "Sorry, unable to open the file", the access setting is wrong, so redo step 4.

- [ ] **Step 6: Commit**

```bash
git add ../gas/cc-ops-eligibility/Eligibility.gs ../gas/cc-ops-eligibility/README.md
git commit -m "Add CC Ops eligibility Apps Script bridge

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Extension bridge client

**Files:**
- Modify: `extension/src/api/bridgeTabs.ts` (add the URL constant next to `BRIDGE_URL` at line 27; widen `isBridgeActionTab` at ~line 161)
- Modify: `extension/src/api/bridge.ts` (`callBridge` signature at ~line 142; add four functions at the end)
- Create: `extension/src/data/eligibilityLog.ts`
- Test: `extension/src/data/eligibilityLog.test.ts`

**Interfaces:**
- Consumes: `RawEligibilityEmail`, `EligibilityRequest`, `Resolution` (Task 3).
- Produces:
  - `ELIGIBILITY_BRIDGE_URL: string`
  - `listEligibilityRequestsViaBridge(): Promise<{ requests: RawEligibilityEmail[]; excludedDomains: string[]; skippedUnknownSender: number }>`
  - `createEligibilityDraftViaBridge(messageId: string, body: string): Promise<string>` (draftId)
  - `sendEligibilityDraftsViaBridge(draftIds: string[]): Promise<{ draftId: string; ok: boolean; error?: string }[]>`
  - `logEligibilityResultViaBridge(row: EligibilityLogRow): Promise<void>`
  - `interface EligibilityLogRow` (12 snake_case string fields)
  - `type LogStatus = 'DRAFTED' | 'READ_EMAIL' | 'NEEDS_REVIEW' | 'NO_MATCH' | 'ALREADY_HAS_ONE_REPLY'`
  - `toLogRow(req: EligibilityRequest, res: Resolution, status: LogStatus, draftId: string): EligibilityLogRow`

- [ ] **Step 1: Write the failing test**

`extension/src/data/eligibilityLog.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { toLogRow } from './eligibilityLog';
import type { EligibilityRequest, Resolution } from './eligibilityTypes';

const req = {
  threadId: 't9', messageId: 'm9', insurerEmail: 'a@claims-co.example', insurerName: '', subject: '', receivedAt: '',
  messageCount: 1, cardholderName: null, emails: [], phone: null, last4: '1763', claimNumber: '123456',
  dateOfLoss: null, warnings: [],
} as EligibilityRequest;

const res: Resolution = {
  requestId: 'm9', status: 'needs_review', method: 'name_last4', clientEmail: 'p@example.com', identityId: 'identity-A',
  cards: [
    { last4: '1763', product: 'ws_visa_infinite_privilege', creationDate: '08/21/2026', delinquent: false },
    { last4: '0042', product: 'ws_visa_infinite_basic', creationDate: '01/02/2025', delinquent: false },
  ],
  flags: ['vi_1pct'], candidates: [], note: 'Warehouse: name + last 4.',
};

describe('toLogRow', () => {
  it('maps a resolution to the 12 Requests columns, joining multi-card values', () => {
    expect(toLogRow(req, res, 'DRAFTED', 'r-123')).toEqual({
      request_message_id: 'm9', thread_id: 't9', insurer_email: 'a@claims-co.example', client_email: 'p@example.com',
      status: 'DRAFTED', last4: '1763, 0042', is_delinquent: 'FALSE', activation_date: '08/21/2026, 01/02/2025',
      card_product: 'ws_visa_infinite_privilege, ws_visa_infinite_basic', match_method: 'name_last4', draft_id: 'r-123',
      notes: 'Warehouse: name + last 4. Flags: vi_1pct. Claim 123456.',
    });
  });

  it('leaves card columns blank for unmatched requests', () => {
    const row = toLogRow(req, { ...res, status: 'no_match', method: null, clientEmail: null, cards: [], flags: [], note: 'Nothing found.' }, 'NO_MATCH', '');
    expect(row.last4).toBe('');
    expect(row.is_delinquent).toBe('');
    expect(row.notes).toBe('Nothing found. Claim 123456.');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/data/eligibilityLog.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `eligibilityLog.ts`**

```ts
// Maps a resolved request to a row in the CC Ops Automation `Requests` sheet.

import type { EligibilityRequest, Resolution } from './eligibilityTypes';

export type LogStatus = 'DRAFTED' | 'READ_EMAIL' | 'NEEDS_REVIEW' | 'NO_MATCH' | 'ALREADY_HAS_ONE_REPLY';

export interface EligibilityLogRow {
  request_message_id: string; thread_id: string; insurer_email: string; client_email: string; status: string;
  last4: string; is_delinquent: string; activation_date: string; card_product: string;
  match_method: string; draft_id: string; notes: string;
}

export function toLogRow(req: EligibilityRequest, res: Resolution, status: LogStatus, draftId: string): EligibilityLogRow {
  const join = (xs: string[]) => xs.join(', ');
  const anyDelinquent = res.cards.some((c) => c.delinquent === true);
  const notes = [
    res.note,
    res.flags.length ? `Flags: ${res.flags.join(', ')}.` : '',
    req.claimNumber ? `Claim ${req.claimNumber}.` : '',
  ].filter(Boolean).join(' ');
  return {
    request_message_id: req.messageId,
    thread_id: req.threadId,
    insurer_email: req.insurerEmail,
    client_email: res.clientEmail ?? '',
    status,
    last4: join(res.cards.map((c) => c.last4)),
    is_delinquent: res.cards.length ? (anyDelinquent ? 'TRUE' : 'FALSE') : '',
    activation_date: join(res.cards.map((c) => c.creationDate)),
    card_product: join(res.cards.map((c) => c.product)),
    match_method: res.method ?? '',
    draft_id: draftId,
    notes,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/data/eligibilityLog.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the URL and widen the tab guard** in `src/api/bridgeTabs.ts`. Directly under the `BRIDGE_URL` constant, add the URL from Task 10 step 4:

```ts
/** CC Ops Automation eligibility bridge — deployed as creditcardoperations@ (Task 10). */
export const ELIGIBILITY_BRIDGE_URL =
  'https://script.google.com/a/macros/wealthsimple.com/s/<DEPLOYMENT_ID_FROM_TASK_10>/exec';
```

Replace `<DEPLOYMENT_ID_FROM_TASK_10>` with the real id; the commit must not contain the angle-bracket text. In `isBridgeActionTab`, change `if (!url || !url.startsWith(BRIDGE_URL)) return false;` to:

```ts
  if (!url || !(url.startsWith(BRIDGE_URL) || url.startsWith(ELIGIBILITY_BRIDGE_URL))) return false;
```

- [ ] **Step 6: Let `callBridge` take a base URL** in `src/api/bridge.ts`. Change the signature and URL line:

```ts
function callBridge(
  action: string,
  params: Record<string, string>,
  expectedReply: string,
  timeoutMs = 30_000,
  openInBackground = false,
  baseUrl: string = BRIDGE_URL,
): Promise<Record<string, unknown>> {
  const qs = new URLSearchParams({ action, ...params }).toString();
  const url = baseUrl + '?' + qs;
```

Add `ELIGIBILITY_BRIDGE_URL` to the existing `./bridgeTabs` import. Existing callers pass five arguments, so they are unchanged.

- [ ] **Step 7: Add the four client functions** at the end of `src/api/bridge.ts`:

```ts
// ---- Insurance Eligibility Confirmation Triage (separate deployment, runs as creditcardoperations@) ----

export async function listEligibilityRequestsViaBridge(): Promise<{
  requests: RawEligibilityEmail[];
  excludedDomains: string[];
  skippedUnknownSender: number;
}> {
  const res = await callBridge('listEligibilityRequests', {}, 'eligibilityRequestsListed', 120_000, true, ELIGIBILITY_BRIDGE_URL);
  const raw = Array.isArray(res.requests) ? (res.requests as Record<string, unknown>[]) : [];
  return {
    requests: raw.map((o) => ({
      threadId: String(o.threadId ?? ''),
      messageId: String(o.messageId ?? ''),
      from: String(o.from ?? ''),
      fromEmail: String(o.fromEmail ?? '').toLowerCase(),
      subject: String(o.subject ?? ''),
      date: String(o.date ?? ''),
      messageCount: Number(o.messageCount ?? 1),
      plainBody: String(o.plainBody ?? ''),
    })),
    excludedDomains: Array.isArray(res.excludedDomains) ? (res.excludedDomains as unknown[]).map(String) : [],
    skippedUnknownSender: Number(res.skippedUnknownSender ?? 0),
  };
}

export async function createEligibilityDraftViaBridge(messageId: string, body: string): Promise<string> {
  const res = await callBridge('createEligibilityDraft', { messageId, body }, 'eligibilityDraftCreated', 60_000, true, ELIGIBILITY_BRIDGE_URL);
  const draftId = String(res.draftId ?? '');
  if (!draftId) throw new Error('Bridge returned no draftId.');
  return draftId;
}

export async function sendEligibilityDraftsViaBridge(
  draftIds: string[],
): Promise<{ draftId: string; ok: boolean; error?: string }[]> {
  const res = await callBridge('sendEligibilityDrafts', { draftIds: draftIds.join(',') }, 'eligibilityDraftsSent', 300_000, true, ELIGIBILITY_BRIDGE_URL);
  const raw = Array.isArray(res.results) ? (res.results as Record<string, unknown>[]) : [];
  return raw.map((r) => ({ draftId: String(r.draftId ?? ''), ok: r.ok === true, error: r.error ? String(r.error) : undefined }));
}

export async function logEligibilityResultViaBridge(row: EligibilityLogRow): Promise<void> {
  await callBridge('logEligibilityResult', { row: JSON.stringify(row) }, 'eligibilityResultLogged', 60_000, true, ELIGIBILITY_BRIDGE_URL);
}
```

Add the imports at the top of `bridge.ts`:

```ts
import type { RawEligibilityEmail } from '../data/eligibilityTypes';
import type { EligibilityLogRow } from '../data/eligibilityLog';
```

- [ ] **Step 8: Type-check and run the full suite**

Run: `npx tsc -b && npm test`
Expected: no type errors; all tests PASS.

- [ ] **Step 9: Commit**

```bash
git add src/api/bridgeTabs.ts src/api/bridge.ts src/data/eligibilityLog.ts src/data/eligibilityLog.test.ts
git commit -m "Add eligibility bridge client and Requests log mapping

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Batch orchestrator (dependency-injected)

**Files:**
- Create: `extension/src/data/eligibilityRun.ts`
- Test: `extension/src/data/eligibilityRun.test.ts`

**Interfaces:**
- Consumes: `preflight`, `resolveFromWarehouse`, `resolveFromI2c`, `multipleCandidates`, `noMatch`, `I2cCardInput` (Task 6); `buildEligibilitySql`, `toWarehouseRows` (Task 4); `normalizeName` (Task 3); `mapI2cProgram` (Task 8); `parseI2cDelinquency` (Task 8); `AtlasPhoneHit` (Task 9).
- Produces:
  - `interface ResolveDeps { runSql(sql: string): Promise<Record<string, unknown>[]>; i2cCards(email: string, requestId: string): Promise<I2cCardInput[]>; atlasByPhone: ((phone: string) => Promise<AtlasPhoneHit[]>) | null; atlasEmail(identityId: string, requestId: string): Promise<string>; onProgress?(requestId: string, stage: string): void }`
  - `resolveBatch(reqs: EligibilityRequest[], deps: ResolveDeps): Promise<Resolution[]>` (same order as `reqs`). It **throws** if `deps.runSql` throws, so the panel can offer the paste fallback.

- [ ] **Step 1: Write the failing tests**

`extension/src/data/eligibilityRun.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { resolveBatch, type ResolveDeps } from './eligibilityRun';
import type { EligibilityRequest } from './eligibilityTypes';

function req(id: string, over: Partial<EligibilityRequest> = {}): EligibilityRequest {
  return {
    threadId: 't' + id, messageId: id, insurerEmail: 'a@claims-co.example', insurerName: '', subject: '', receivedAt: '',
    messageCount: 1, cardholderName: { first: 'Priya', last: 'Ramanathan', raw: 'Priya Ramanathan' },
    emails: ['wrong.address@example.com', 'priya.r1985@example.com'], phone: '4165550142', last4: '1763',
    claimNumber: null, dateOfLoss: null, warnings: [], ...over,
  };
}

const whRow = (requestId: string, over: Record<string, unknown> = {}) => ({
  request_id: requestId, match_rule: 'email', identity_id: 'identity-A', client_email: 'priya.r1985@example.com',
  first_name: 'Priya', last_name: 'Ramanathan', last4: '1763', card_product: 'ws_visa_infinite_privilege',
  created_date: '08/21/2026', is_delinquent: false, ...over,
});

const i2cOpen = [{
  last4: '1763', status: 'ACTIVE', closed: false, program: 'Wealthsimple Visa Infinite VIP 01 Physical',
  delinquencyStatus: 'Current / Not Delinquent', creationDate: '07/07/2026',
}];

function deps(over: Partial<ResolveDeps> = {}): ResolveDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    runSql: async () => [],
    i2cCards: async (email) => { calls.push('i2c:' + email); return []; },
    atlasByPhone: async (phone) => { calls.push('atlas:' + phone); return []; },
    atlasEmail: async (id) => { calls.push('atlasEmail:' + id); return ''; },
    ...over,
  };
}

describe('resolveBatch', () => {
  it('matches on the second listed email via the warehouse (first email wrong)', async () => {
    const d = deps({ runSql: async () => [whRow('m1')] });
    const [r] = await resolveBatch([req('m1')], d);
    expect(r.method).toBe('email_last4');
    expect(d.calls).toEqual([]);
  });

  it('resolves two claims for the same client independently', async () => {
    const d = deps({ runSql: async () => [whRow('m1'), whRow('m2')] });
    const rs = await resolveBatch([req('m1'), req('m2')], d);
    expect(rs.map((r) => [r.requestId, r.method])).toEqual([['m1', 'email_last4'], ['m2', 'email_last4']]);
  });

  it('falls back to i2c by listed email, trying each email in order', async () => {
    const d = deps({
      i2cCards: async (email) => { d.calls.push('i2c:' + email); return email === 'priya.r1985@example.com' ? i2cOpen : []; },
    });
    const [r] = await resolveBatch([req('m1')], d);
    expect(r.method).toBe('i2c_email');
    expect(r.clientEmail).toBe('priya.r1985@example.com');
    expect(d.calls).toEqual(['i2c:wrong.address@example.com', 'i2c:priya.r1985@example.com']);
  });

  it('falls back to Atlas phone → name check → Atlas email → i2c', async () => {
    const d = deps({
      atlasByPhone: async () => [
        { identityId: 'identity-Z', firstName: 'Someone', lastName: 'Else', email: 'z@example.com' },
        { identityId: 'identity-P', firstName: 'Priya', lastName: 'Ramanathan', email: null },
      ],
      atlasEmail: async () => 'real.priya@example.com',
      i2cCards: async (email) => (email === 'real.priya@example.com' ? i2cOpen : []),
    });
    const [r] = await resolveBatch([req('m1')], d);
    expect(r.method).toBe('atlas_phone_i2c');
    expect(r.identityId).toBe('identity-P');
    expect(r.clientEmail).toBe('real.priya@example.com');
  });

  it('flags multiple name-matched Atlas identities instead of picking one', async () => {
    const d = deps({
      atlasByPhone: async () => [
        { identityId: 'identity-P1', firstName: 'Priya', lastName: 'Ramanathan', email: 'a@example.com' },
        { identityId: 'identity-P2', firstName: 'Priya', lastName: 'Ramanathan', email: 'b@example.com' },
      ],
    });
    const [r] = await resolveBatch([req('m1')], d);
    expect(r.flags).toEqual(['multiple_candidates']);
  });

  it('never looks anything up for already-replied or no-last4 requests', async () => {
    const d = deps();
    const rs = await resolveBatch([req('m1', { messageCount: 3 }), req('m2', { last4: null })], d);
    expect(rs.map((r) => r.flags[0])).toEqual(['already_replied', 'no_last4']);
    expect(d.calls).toEqual([]);
  });

  it('keeps going when one i2c lookup throws, and records the error', async () => {
    const d = deps({
      i2cCards: async (email) => { if (email.startsWith('wrong')) throw new Error('timed out'); return []; },
      atlasByPhone: null,
    });
    const [r] = await resolveBatch([req('m1')], d);
    expect(r.status).toBe('needs_review');
    expect(r.flags).toEqual(['lookup_error']);
    expect(r.note).toContain('timed out');
  });

  it('propagates a warehouse failure so the panel can offer the paste fallback', async () => {
    const d = deps({ runSql: async () => { throw new Error('Not signed in to Preset.'); } });
    await expect(resolveBatch([req('m1')], d)).rejects.toThrow('Not signed in to Preset.');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/data/eligibilityRun.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`extension/src/data/eligibilityRun.ts`:

```ts
// Runs the spec's resolution order over a batch: preflight → warehouse → i2c by listed
// email → Atlas phone + name → i2c. All I/O is injected so the order is unit-tested.

import type { AtlasPhoneHit } from './atlasPhoneSearch';
import { mapI2cProgram } from './eligibilityProducts';
import { normalizeName } from './eligibilityParse';
import {
  multipleCandidates, noMatch, preflight, resolveFromI2c, resolveFromWarehouse, type I2cCardInput,
} from './eligibilityResolve';
import { buildEligibilitySql, toWarehouseRows } from './eligibilitySql';
import type { EligibilityRequest, Resolution } from './eligibilityTypes';
import { parseI2cDelinquency } from './i2cCardDetailsParse';

export interface ResolveDeps {
  runSql(sql: string): Promise<Record<string, unknown>[]>;
  i2cCards(email: string, requestId: string): Promise<I2cCardInput[]>;
  atlasByPhone: ((phone: string) => Promise<AtlasPhoneHit[]>) | null;
  atlasEmail(identityId: string, requestId: string): Promise<string>;
  onProgress?(requestId: string, stage: string): void;
}

const i2cDeps = { mapProgram: mapI2cProgram, parseDelinquency: parseI2cDelinquency };

function nameMatches(req: EligibilityRequest, hit: AtlasPhoneHit): boolean {
  if (!req.cardholderName) return false;
  const wantFirst = normalizeName(req.cardholderName.first).split(' ')[0];
  const wantLast = normalizeName(req.cardholderName.last);
  const gotFirst = normalizeName(hit.firstName).split(' ')[0];
  const gotLast = normalizeName(hit.lastName);
  return !!wantFirst && wantFirst === gotFirst && wantLast === gotLast;
}

async function resolveLive(req: EligibilityRequest, deps: ResolveDeps): Promise<Resolution> {
  const errors: string[] = [];

  for (const email of req.emails) {
    deps.onProgress?.(req.messageId, `i2c: ${email}`);
    try {
      const cards = await deps.i2cCards(email, req.messageId);
      const r = resolveFromI2c(req, { email, method: 'i2c_email', identityId: null, cards, ...i2cDeps });
      if (r) return r;
    } catch (e) {
      errors.push(`i2c ${email}: ${(e as Error).message}`);
    }
  }

  if (deps.atlasByPhone && req.phone && req.cardholderName) {
    deps.onProgress?.(req.messageId, 'Atlas: phone search');
    try {
      const hits = (await deps.atlasByPhone(req.phone)).filter((h) => nameMatches(req, h));
      if (hits.length > 1) {
        return multipleCandidates(
          req,
          hits.map((h) => ({ identityId: h.identityId, clientEmail: h.email ?? '', name: `${h.firstName} ${h.lastName}` })),
          `${hits.length} Atlas identities share this phone and name.`,
        );
      }
      if (hits.length === 1) {
        const hit = hits[0];
        const email = hit.email ?? (await deps.atlasEmail(hit.identityId, req.messageId));
        if (email) {
          deps.onProgress?.(req.messageId, `i2c: ${email}`);
          const cards = await deps.i2cCards(email, req.messageId);
          const r = resolveFromI2c(req, { email, method: 'atlas_phone_i2c', identityId: hit.identityId, cards, ...i2cDeps });
          if (r) return r;
        }
      }
    } catch (e) {
      errors.push(`Atlas: ${(e as Error).message}`);
    }
  }

  return errors.length
    ? noMatch(req, 'Lookup errors: ' + errors.join('; '), ['lookup_error'])
    : noMatch(req, 'No client matched on email, name, or phone with this last 4.');
}

export async function resolveBatch(reqs: EligibilityRequest[], deps: ResolveDeps): Promise<Resolution[]> {
  const out = new Map<string, Resolution>();
  const pending: EligibilityRequest[] = [];
  for (const r of reqs) {
    const pre = preflight(r);
    if (pre) out.set(r.messageId, pre);
    else pending.push(r);
  }

  const sql = buildEligibilitySql(pending);
  const rows = sql ? toWarehouseRows(await deps.runSql(sql)) : [];

  for (const r of pending) {
    const wh = resolveFromWarehouse(r, rows);
    out.set(r.messageId, wh ?? (await resolveLive(r, deps)));
  }
  return reqs.map((r) => out.get(r.messageId)!);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- src/data/eligibilityRun.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/data/eligibilityRun.ts src/data/eligibilityRun.test.ts
git commit -m "Add eligibility batch orchestrator

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Panel UI + Home tile + SidePanel wiring

**Prerequisite:** `git diff --stat src/sidepanel/SidePanel.tsx` must be empty. If not, stop and ask the user to commit or stash their pre-existing SidePanel changes.

**Files:**
- Create: `extension/src/sidepanel/EligibilityTriage.tsx`
- Create: `extension/src/data/eligibilityRunState.ts`
- Test: `extension/src/data/eligibilityRunState.test.ts`
- Modify: `extension/src/sidepanel/HomeView.tsx` (props at ~line 49; Tools section at ~lines 271-285)
- Modify: `extension/src/sidepanel/SidePanel.tsx` (import ~line 41; state ~line 83; reset effect ~line 146; early return ~line 163; both `HomeView` call sites ~lines 167-185)

**Interfaces:**
- Consumes: everything from Tasks 3–12.
- Produces:
  - `EligibilityTriage({ onClose }: { onClose: () => void })`
  - `interface RunRow { req: EligibilityRequest; res: Resolution | null; selected: boolean; draftId: string; draftBody: string; sent: 'no' | 'ok' | 'failed'; sendError: string }`
  - `interface RunState { stage: 'idle' | 'fetched' | 'resolved' | 'drafted' | 'sent'; rows: RunRow[]; skippedUnknownSender: number; sql: string }`
  - `defaultSelected(res: Resolution): boolean`
  - `nextLogStatus(res: Resolution, drafted: boolean): LogStatus`
  - `RUN_STATE_KEY = 'eligibility_run_v1'`

- [ ] **Step 1: Write the failing test for the run-state rules**

`extension/src/data/eligibilityRunState.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { defaultSelected, nextLogStatus } from './eligibilityRunState';
import type { Resolution } from './eligibilityTypes';

const base: Resolution = {
  requestId: 'm', status: 'matched', method: 'email_last4', clientEmail: 'p@example.com', identityId: 'identity-A',
  cards: [{ last4: '1763', product: 'ws_visa_infinite_privilege', creationDate: '08/21/2026', delinquent: false }],
  flags: [], candidates: [], note: '',
};

describe('defaultSelected', () => {
  it('selects clean matches only', () => {
    expect(defaultSelected(base)).toBe(true);
    expect(defaultSelected({ ...base, status: 'needs_review', flags: ['vi_1pct'] })).toBe(false);
    expect(defaultSelected({ ...base, status: 'no_match', method: null, cards: [] })).toBe(false);
  });
});

describe('nextLogStatus', () => {
  it('maps outcomes to Requests statuses', () => {
    expect(nextLogStatus(base, true)).toBe('DRAFTED');
    expect(nextLogStatus({ ...base, status: 'needs_review', flags: ['already_replied'] }, false)).toBe('ALREADY_HAS_ONE_REPLY');
    expect(nextLogStatus({ ...base, status: 'needs_review', flags: ['delinquent'] }, false)).toBe('NEEDS_REVIEW');
    expect(nextLogStatus({ ...base, status: 'needs_review', flags: ['delinquent'] }, true)).toBe('DRAFTED');
    expect(nextLogStatus({ ...base, status: 'no_match', method: null, cards: [] }, false)).toBe('NO_MATCH');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/data/eligibilityRunState.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `eligibilityRunState.ts`**

```ts
// Panel run-state shapes + the two rules the panel applies to every row.

import type { LogStatus } from './eligibilityLog';
import type { EligibilityRequest, Resolution } from './eligibilityTypes';

export const RUN_STATE_KEY = 'eligibility_run_v1';

export interface RunRow {
  req: EligibilityRequest;
  res: Resolution | null;
  selected: boolean;
  draftId: string;
  draftBody: string;
  sent: 'no' | 'ok' | 'failed';
  sendError: string;
}

export interface RunState {
  stage: 'idle' | 'fetched' | 'resolved' | 'drafted' | 'sent';
  rows: RunRow[];
  skippedUnknownSender: number;
  /** Last generated warehouse SQL, for the Copy SQL fallback. */
  sql: string;
}

export const EMPTY_RUN: RunState = { stage: 'idle', rows: [], skippedUnknownSender: 0, sql: '' };

export function defaultSelected(res: Resolution): boolean {
  return res.status === 'matched';
}

export function nextLogStatus(res: Resolution, drafted: boolean): LogStatus {
  if (drafted) return 'DRAFTED';
  if (res.flags.includes('already_replied')) return 'ALREADY_HAS_ONE_REPLY';
  if (res.status === 'no_match') return 'NO_MATCH';
  return 'NEEDS_REVIEW';
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/data/eligibilityRunState.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the panel** `extension/src/sidepanel/EligibilityTriage.tsx`:

```tsx
// Insurance Eligibility Confirmation Triage — Home → Tools.
// Spec: docs/superpowers/specs/2026-10-05-insurance-eligibility-triage-design.md

import { useEffect, useState } from 'react';
import {
  createEligibilityDraftViaBridge,
  listEligibilityRequestsViaBridge,
  logEligibilityResultViaBridge,
  sendEligibilityDraftsViaBridge,
} from '../api/bridge';
import { fetchAtlasClientEmailHeadless } from '../data/atlasAccountLookup';
import { ATLAS_PHONE_SEARCH_ENABLED, searchAtlasByPhone } from '../data/atlasPhoneSearch';
import { renderEligibilityDraft } from '../data/eligibilityDraft';
import { toLogRow } from '../data/eligibilityLog';
import { parseEligibilityEmail } from '../data/eligibilityParse';
import { isDraftable } from '../data/eligibilityResolve';
import { resolveBatch, type ResolveDeps } from '../data/eligibilityRun';
import { defaultSelected, EMPTY_RUN, nextLogStatus, RUN_STATE_KEY, type RunState } from '../data/eligibilityRunState';
import { buildEligibilitySql } from '../data/eligibilitySql';
import { fetchI2cCardDetailsHeadless } from '../data/i2cCardLookup';
import { parsePastedResults, PRESET_DIRECT_ENABLED, PresetAuthError, runPresetSql } from '../data/presetSql';

const FLAG_TEXT: Record<string, string> = {
  multiple_candidates: 'More than one client matches — pick manually',
  delinquent: 'Card is not in good standing',
  vi_1pct: 'Not Privilege/Plus — add 1% coverages by hand',
  no_last4: 'No card last 4 in the email',
  parse_warning: 'Email parsing warning',
  already_replied: 'Thread already has a reply',
  unknown_product: 'i2c program not recognised',
  i2c_details_incomplete: 'i2c details incomplete',
  lookup_error: 'A lookup failed',
};

function liveDeps(onProgress: (id: string, stage: string) => void): Omit<ResolveDeps, 'runSql'> {
  return {
    i2cCards: (email, id) => fetchI2cCardDetailsHeadless({ clientEmail: email, sourceTicketId: 'elig-' + id }),
    atlasByPhone: ATLAS_PHONE_SEARCH_ENABLED ? searchAtlasByPhone : null,
    atlasEmail: (identityId, id) => fetchAtlasClientEmailHeadless({ identityId, sourceTicketId: 'elig-' + id }),
    onProgress,
  };
}

export function EligibilityTriage({ onClose }: { onClose: () => void }) {
  const [run, setRun] = useState<RunState>(EMPTY_RUN);
  const [busy, setBusy] = useState<string>('');
  const [error, setError] = useState<string>('');
  const [progress, setProgress] = useState<Record<string, string>>({});
  const [pasteMode, setPasteMode] = useState(false);
  const [pasted, setPasted] = useState('');
  const [confirmSend, setConfirmSend] = useState(false);

  // Restore an in-flight run (Review Focus 4: reopening the panel must not lose state).
  useEffect(() => {
    chrome.storage.session.get(RUN_STATE_KEY).then((r) => {
      const saved = r[RUN_STATE_KEY] as RunState | undefined;
      if (saved) setRun(saved);
    });
  }, []);
  const save = (next: RunState) => {
    setRun(next);
    void chrome.storage.session.set({ [RUN_STATE_KEY]: next });
  };

  async function onFetch() {
    setBusy('Reading creditcardoperations@ inbox…'); setError('');
    try {
      const { requests, excludedDomains, skippedUnknownSender } = await listEligibilityRequestsViaBridge();
      const rows = requests.map((raw) => ({
        req: parseEligibilityEmail(raw, excludedDomains),
        res: null, selected: false, draftId: '', draftBody: '', sent: 'no' as const, sendError: '',
      }));
      save({ stage: 'fetched', rows, skippedUnknownSender, sql: buildEligibilitySql(rows.map((r) => r.req)) ?? '' });
    } catch (e) {
      setError((e as Error).message);
    } finally { setBusy(''); }
  }

  async function onResolve(pastedRows?: Record<string, unknown>[]) {
    setBusy('Matching clients…'); setError('');
    const runSql = pastedRows
      ? async () => pastedRows
      : PRESET_DIRECT_ENABLED
        ? (sql: string) => runPresetSql(sql)
        : async () => { throw new Error('Direct Preset is off — use Copy SQL and paste the results.'); };
    try {
      const results = await resolveBatch(run.rows.map((r) => r.req), {
        runSql,
        ...liveDeps((id, stage) => setProgress((p) => ({ ...p, [id]: stage }))),
      });
      const rows = run.rows.map((r, i) => {
        const res = results[i];
        const draftBody = isDraftable(res)
          ? renderEligibilityDraft({
              clientEmail: res.clientEmail,
              emailWasProvided: !!res.clientEmail && r.req.emails.includes(res.clientEmail),
              cards: res.cards,
              requestedLast4: r.req.last4 ?? '',
            })
          : '';
        return { ...r, res, draftBody, selected: defaultSelected(res) && !!draftBody };
      });
      setPasteMode(false);
      save({ ...run, stage: 'resolved', rows });
    } catch (e) {
      const msg = e instanceof PresetAuthError ? 'Sign in to Preset, then press Resolve again — or use Copy SQL.' : (e as Error).message;
      setError(msg);
      setPasteMode(true);
    } finally { setBusy(''); setProgress({}); }
  }

  async function onCreateDrafts() {
    setBusy('Creating drafts…'); setError('');
    const rows = [...run.rows];
    try {
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        if (!r.res) continue;
        let draftId = r.draftId;
        if (r.selected && r.draftBody && !draftId) {
          draftId = await createEligibilityDraftViaBridge(r.req.messageId, r.draftBody);
          rows[i] = { ...r, draftId };
        }
        await logEligibilityResultViaBridge(toLogRow(r.req, r.res, nextLogStatus(r.res, !!draftId), draftId));
        save({ ...run, rows });
      }
      save({ ...run, stage: 'drafted', rows });
    } catch (e) {
      setError((e as Error).message + ' — press Create drafts again to continue; finished rows are skipped.');
      save({ ...run, rows });
    } finally { setBusy(''); }
  }

  async function onSendAll() {
    setConfirmSend(false);
    const ids = run.rows.filter((r) => r.draftId && r.sent !== 'ok').map((r) => r.draftId);
    if (!ids.length) return;
    setBusy(`Sending ${ids.length} drafts…`); setError('');
    try {
      const results = await sendEligibilityDraftsViaBridge(ids);
      const byId = new Map(results.map((x) => [x.draftId, x]));
      const rows = run.rows.map((r) => {
        const x = byId.get(r.draftId);
        return x ? { ...r, sent: x.ok ? ('ok' as const) : ('failed' as const), sendError: x.error ?? '' } : r;
      });
      for (const r of rows) {
        if (r.sent === 'ok' && r.res) await logEligibilityResultViaBridge(toLogRow(r.req, r.res, 'READ_EMAIL', r.draftId));
      }
      save({ ...run, stage: 'sent', rows });
    } catch (e) {
      setError((e as Error).message);
    } finally { setBusy(''); }
  }

  const draftCount = run.rows.filter((r) => r.selected && r.draftBody && !r.draftId).length;
  const sendable = run.rows.filter((r) => r.draftId && r.sent !== 'ok').length;

  return (
    <div style={{ padding: 'var(--mint-sp-3)', display: 'flex', flexDirection: 'column', gap: 'var(--mint-sp-3)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button onClick={onClose}>← Back</button>
        <h2 style={{ margin: 0, fontSize: 'var(--mint-text-h-sm)' }}>Insurance Eligibility Confirmation Triage</h2>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button disabled={!!busy} onClick={onFetch}>1. Fetch requests</button>
        <button disabled={!!busy || run.stage === 'idle' || !run.rows.length} onClick={() => onResolve()}>2. Resolve</button>
        <button disabled={!!busy || !draftCount} onClick={onCreateDrafts}>3. Create drafts ({draftCount})</button>
        {confirmSend ? (
          <button disabled={!!busy} onClick={onSendAll} style={{ fontWeight: 700 }}>Confirm send {sendable}</button>
        ) : (
          <button disabled={!!busy || !sendable} onClick={() => setConfirmSend(true)}>4. Send all drafts ({sendable})</button>
        )}
        {run.stage !== 'idle' ? <button disabled={!!busy} onClick={() => save(EMPTY_RUN)}>Clear</button> : null}
      </div>

      {busy ? <div style={{ color: 'var(--mint-fg-soft)' }}>{busy}</div> : null}
      {error ? <div style={{ color: 'var(--mint-fg-danger, #b00020)' }}>{error}</div> : null}
      {run.skippedUnknownSender > 0 ? (
        <div style={{ color: 'var(--mint-fg-soft)' }}>
          {run.skippedUnknownSender} unread email(s) from senders not on the Insurers tab were skipped. Check the inbox.
        </div>
      ) : null}

      {pasteMode ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <button onClick={() => navigator.clipboard.writeText(run.sql)}>Copy SQL</button>
          <div style={{ fontSize: 'var(--mint-text-nano)' }}>
            Run it in Preset SQL Lab (Pantheon), copy the result table, paste below.
          </div>
          <textarea rows={6} value={pasted} onChange={(e) => setPasted(e.target.value)} />
          <button disabled={!pasted.trim()} onClick={() => onResolve(parsePastedResults(pasted))}>Use pasted results</button>
        </div>
      ) : null}

      {run.rows.map((r, i) => {
        const res = r.res;
        const icon = !res ? '•' : r.sent === 'ok' ? '📤' : res.status === 'matched' ? '✅' : res.status === 'needs_review' ? '⚠️' : '❌';
        return (
          <div key={r.req.messageId} style={{ border: 'var(--mint-card-stroke)', borderRadius: 'var(--mint-radius-card)', padding: 'var(--mint-sp-2)' }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span>{icon}</span>
              <strong>{r.req.cardholderName?.raw ?? '(no name)'}</strong>
              <span>· ****{r.req.last4 ?? '????'}</span>
              <span style={{ marginLeft: 'auto', fontSize: 'var(--mint-text-nano)' }}>{r.req.insurerEmail}</span>
            </div>
            <div style={{ fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-soft)' }}>
              Emails: {r.req.emails.join(', ') || '—'} · Phone: {r.req.phone ?? '—'}
              {progress[r.req.messageId] ? ` · ${progress[r.req.messageId]}` : ''}
            </div>
            {res ? (
              <div style={{ fontSize: 'var(--mint-text-nano)' }}>
                {res.method ? `Matched: ${res.method}` : 'Not matched'} — {res.note}
                {res.flags.map((f) => <div key={f}>⚠️ {FLAG_TEXT[f] ?? f}</div>)}
                {res.candidates.map((c) => <div key={c.identityId}>• {c.name} — {c.clientEmail} ({c.identityId})</div>)}
              </div>
            ) : null}
            {r.draftBody ? (
              <>
                <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 'var(--mint-text-nano)' }}>
                  <input
                    type="checkbox"
                    checked={r.selected}
                    disabled={!!r.draftId}
                    onChange={(e) => {
                      const rows = [...run.rows];
                      rows[i] = { ...r, selected: e.target.checked };
                      save({ ...run, rows });
                    }}
                  />
                  {r.draftId ? 'Drafted' : 'Create a draft for this request'}
                </label>
                <pre style={{ whiteSpace: 'pre-wrap', fontSize: 'var(--mint-text-nano)', background: 'var(--mint-bg-subtle)', padding: 6 }}>{r.draftBody}</pre>
              </>
            ) : null}
            {r.sent === 'failed' ? <div style={{ color: 'var(--mint-fg-danger, #b00020)' }}>Send failed: {r.sendError}</div> : null}
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 6: Add the Home tile.** In `src/sidepanel/HomeView.tsx`, add `onOpenEligibility` to the props type and destructuring:

```tsx
export function HomeView({ onOpenTicket, onOpenWiresPending, onOpenWiresPendingV2, onOpenEligibility, header }: { onOpenTicket: (ticketKey: string) => void; onOpenWiresPending: () => void; onOpenWiresPendingV2: () => void; onOpenEligibility: () => void; header: React.ReactNode }) {
```

and in the Tools section, directly after `<MobileChequeValidationTile />`:

```tsx
            <ToolTile
              icon="🛡️"
              title="Insurance Eligibility Confirmation Triage"
              subtitle="Reads unread insurer requests in creditcardoperations@, matches each client (warehouse → i2c → Atlas phone), drafts replies, then sends them all."
              onClick={onOpenEligibility}
            />
```

- [ ] **Step 7: Wire it in `SidePanel.tsx`.**
  - Import: `import { EligibilityTriage } from './EligibilityTriage';` next to the `WiresPendingPostingV2` import.
  - State, next to `wiresPendingV2Active`: `const [eligibilityActive, setEligibilityActive] = useState(false);`
  - In the reset-on-new-ticket effect, add `setEligibilityActive(false);` after `setWiresPendingV2Active(false);`.
  - Early return, after the `wiresPendingV2Active` block:

```tsx
  if (eligibilityActive) {
    return <EligibilityTriage onClose={() => setEligibilityActive(false)} />;
  }
```

  - At **both** `<HomeView … />` call sites, add `onOpenEligibility={() => setEligibilityActive(true)}`.

- [ ] **Step 8: Type-check, test, build**

Run: `npx tsc -b && npm test && npm run build`
Expected: no type errors; all tests PASS; the build writes `dist/`.

- [ ] **Step 9: Reload and click through** (`chrome://extensions` → Sidekick → reload). Home → Tools → **Insurance Eligibility Confirmation Triage** → **1. Fetch requests**.
Expected: one row per unread insurer email, with the parsed name, last 4, emails and phone. **Don't** press Create drafts yet; that's Task 14. Close the panel and reopen the tool: the fetched rows are still there.

- [ ] **Step 10: Commit**

```bash
git add src/sidepanel/EligibilityTriage.tsx src/data/eligibilityRunState.ts src/data/eligibilityRunState.test.ts src/sidepanel/HomeView.tsx src/sidepanel/SidePanel.tsx
git commit -m "Add Insurance Eligibility Confirmation Triage panel and Home tile

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: First live run (draft-only) and handover

**Files:**
- Modify: `extension/src/data/eligibilityProducts.ts` (add any i2c Program values confirmed during the run)
- Modify: `docs/superpowers/specs/2026-10-05-insurance-eligibility-spikes.md` (append "First live run" results)

**Interfaces:**
- Consumes: the whole feature.

- [ ] **Step 1: Run Fetch → Resolve** on the real unread batch. For every ✅ row, compare the draft against what the old process would have sent: same client, same last 4, same creation date, same product. For every ⚠️/❌ row, check the reason makes sense.

- [ ] **Step 2: Seed the product map.** For any row matched via i2c whose Program showed as `unknown_product`, look the client up in Preset (or the warehouse row, if they also matched there) to confirm the `card_product_id`. Add the pair to `I2C_PROGRAM_TO_PRODUCT`, then add a matching assertion in `i2cCardDetailsParse.test.ts`:

```ts
expect(mapI2cProgram('<exact Program text>')).toBe('<card_product_id>');
```

Run: `npm test -- src/data/i2cCardDetailsParse.test.ts`
Expected: PASS.

- [ ] **Step 3: Create drafts** for the ✅ rows only. In creditcardoperations@ → Drafts, open three drafts. Check they're in-thread replies, the sender is "Cash and Card Operations", and the body matches the panel preview. Check the `Requests` sheet has one row per request, with `match_method` and `notes` filled.

- [ ] **Step 4: Press Create drafts a second time.**
Expected: no new drafts (rows with a `draftId` are skipped) and no duplicate sheet rows (the upsert keys on `request_message_id`).

- [ ] **Step 5: Hand the Send step to the user.** **Do not press Send all drafts yourself.** Tell the user the drafts are ready to review in Gmail, and that **4. Send all drafts** sends exactly the drafts in this batch (as edited).

- [ ] **Step 6: Record the run** in the spikes doc under "First live run": batch size, ✅/⚠️/❌ counts, any mismatches against the old process, and any Program values added. No client data.

- [ ] **Step 7: Commit**

```bash
git add src/data/eligibilityProducts.ts src/data/i2cCardDetailsParse.test.ts ../docs/superpowers/specs/2026-10-05-insurance-eligibility-spikes.md
git commit -m "Seed i2c product map and record first eligibility live run

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
