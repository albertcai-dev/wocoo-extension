# PFO Express Shipping Request — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the Credit Card and Prepaid Card paths of the WOCOO Triager Move modal by retargeting them at PFO's new "Express Shipping Request" issue type (id `14656`) with all 7 of its required custom fields populated, leaving the Cheques path unchanged.

**Architecture:** Three-file edit. `moveConfig.ts` gains constants + helpers for the new issue type. `jira.ts` generalizes the existing EOC-Problem-Area resolver into a reusable `resolveOptionId(projectKey, issueTypeId, fieldId, label)` with chrome.storage.local caching. `MoveModal.tsx` splits the PFO branch: Cheques keeps today's minimal form, Credit/Prepaid render a new `ExpressShippingFields` form (Card Type / User Tier / Reissue Reason / Date) and call `moveTicket(...)` with 8 mandatory fields. Two fields are hidden + hardcoded (`Did you perform Card Reissue? = No`, `Will CX keep ownership? = Yes`).

**Tech Stack:** TypeScript, React (functional + hooks), Vite (build via `npm run build`), Chrome MV3 extension. No test framework; verification is manual via load-unpacked + clicking through real WOCOO tickets.

## Global Constraints

- **No automated tests.** This codebase has no test runner. Each task ends with `npm run build` (from `~/projects/wocoo-extension/extension/`) + a documented manual verification step. Do not introduce a test framework.
- **Not a git repository.** Skip every "commit" step that would normally close a TDD cycle. Tasks complete when manual verification passes.
- **Existing code style:** TypeScript, semicolons, single quotes, 2-space indent, React functional components, no default exports unless already used. Follow existing patterns in neighboring files.
- **Do not regress existing flows.** EOC moves, CRED moves, FRAUD UI-only path, and the Cheques PFO path must work exactly as they do today. The Reason-for-move textarea, sheet log, clone-and-Done workflow, and confirm gate all stay untouched.
- **PFO Project ID is `13086`** (already discovered and hardcoded in the spec).
- **Express Shipping issue type ID is `14656`. Cheques: Delivery Issue issue type ID is `14658`.** Both are stable; hardcode them, do not look up by name.
- **Reload the unpacked extension** in `chrome://extensions` after every build before manual verification — Chrome does NOT auto-pick-up `dist/` changes.

---

## File Structure

Files modified (no new files):

| Path | Responsibility |
|---|---|
| `src/data/moveConfig.ts` | Add PFO project/issuetype constants, EXPRESS_SHIPPING_FIELDS custom-field-ID map, Card Type / User Tier / Reissue Reason label arrays + types, `recommendedCardType()`, `tierToUserTierLabel()` helpers. |
| `src/api/jira.ts` | Extract `resolveOptionId(projectKey, issueTypeId, fieldId, label)` from the existing `resolveEocProblemAreaId`. Keep `resolveEocProblemAreaId` as a thin wrapper for backward compatibility. New cache key `jira_option_lookup_cache`. |
| `src/sidepanel/MoveModal.tsx` | Add state for `reissueReason`, `dateNeeded`, `cardType`, `userTier`. Split the PFO render branch into `PfoChequesFields` (existing minimal form) and `ExpressShippingFields` (new form). Split the `execute()` PFO branch into the existing Cheques call and a new Express Shipping call that resolves 5 option IDs in parallel and sends 8 mandatory fields. Update `destLabel` for the audit log. |

---

## Task 1: Add PFO constants and helpers to moveConfig.ts

**Files:**
- Modify: `src/data/moveConfig.ts:48-67` (the PFO/EOC constants region)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `PFO_PROJECT_ID: string` (constant `'13086'`)
  - `PFO_EXPRESS_SHIPPING_ISSUETYPE_ID: string` (`'14656'`)
  - `PFO_CHEQUES_DELIVERY_ISSUETYPE_ID: string` (`'14658'`)
  - `EXPRESS_SHIPPING_FIELDS` (record of customfield IDs)
  - `CARD_TYPE_LABELS: readonly string[]`, `type CardType`
  - `USER_TIER_LABELS: readonly string[]`, `type UserTier`
  - `REISSUE_REASON_LABELS: readonly string[]`
  - `recommendedCardType(workType: string): CardType`
  - `tierToUserTierLabel(tier: string | null | undefined): UserTier`

- [ ] **Step 1: Open the file** `src/data/moveConfig.ts` and locate the section starting at line 48 with the comment `// EOC bulk-move target identifiers (matches v3's Apps Script bridge)`.

- [ ] **Step 2: Insert the new constants directly below `EOC_CLIENT_STATUS_IDS`** (around line 58), before the existing `PFO_API_SUPPORTED_WORK_TYPES` comment. Paste this block verbatim:

```ts
// PFO bulk-move target identifiers — PFO restructured its issue types so we
// hardcode the new targets here. PROJECT_ID came from GET /rest/api/3/project/PFO.
export const PFO_PROJECT_ID = '13086';
export const PFO_EXPRESS_SHIPPING_ISSUETYPE_ID = '14656';
export const PFO_CHEQUES_DELIVERY_ISSUETYPE_ID = '14658';

// Express Shipping Request (issuetype 14656) required-field IDs. Discovered via
// jira_get_project_metadata on 2026-06-19.
export const EXPRESS_SHIPPING_FIELDS = {
  SUMMARY:            'summary',
  IDENTITY_ID:        'customfield_11458',
  CARD_TYPE:          'customfield_25816',
  USER_TIER:          'customfield_11416',
  REISSUE_REASON:     'customfield_25797',
  DATE_NEEDED:        'customfield_25817',
  DID_REISSUE:        'customfield_25819',
  CX_KEEPS_OWNERSHIP: 'customfield_25821',
} as const;

// Card Type options — labels match Jira; resolved to option IDs via resolveOptionId at submit.
export const CARD_TYPE_LABELS = ['Credit Card', 'Prepaid Mastercard'] as const;
export type CardType = (typeof CARD_TYPE_LABELS)[number];

// User Tier — labels match Jira AND WOCOO ticket.tier values.
export const USER_TIER_LABELS = ['Core', 'Premium', 'Generation'] as const;
export type UserTier = (typeof USER_TIER_LABELS)[number];

// Reissue Reason — 4 labels observed in real PFO tickets. 3 more exist in
// Jira (visible in the createmeta call) and should be appended once
// discovered on the first live submit. "Other" covers the long tail.
export const REISSUE_REASON_LABELS = [
  'Failed Delivery (It\'s been > 15 days)',
  'Upgrade Card Material',
  'Fraud',
  'Other',
] as const;

export function recommendedCardType(workType: string): CardType {
  return /prepaid/i.test(workType) ? 'Prepaid Mastercard' : 'Credit Card';
}

export function tierToUserTierLabel(tier: string | null | undefined): UserTier {
  if (tier === 'Premium' || tier === 'Generation' || tier === 'Core') return tier;
  return 'Core';
}
```

- [ ] **Step 3: Save the file and run a build to confirm TypeScript compiles.**

Run from `~/projects/wocoo-extension/extension/`:
```bash
npm run build
```
Expected: build completes without TypeScript errors. The `dist/` folder is regenerated.

- [ ] **Step 4: Spot-check the build output.**

Open `dist/assets/index-*.js` and grep for `'14656'`:
```bash
grep -l '14656' ~/projects/wocoo-extension/extension/dist/assets/*.js
```
Expected: at least one file matches. Confirms the constants made it into the bundle.

---

## Task 2: Generalize the option-ID resolver in jira.ts

**Files:**
- Modify: `src/api/jira.ts:60-92` (the existing `resolveEocProblemAreaId` block)

**Interfaces:**
- Consumes: nothing from Task 1 at runtime; this is a pure refactor.
- Produces:
  - `resolveOptionId(projectKey: string, issueTypeId: string, fieldId: string, label: string): Promise<string>` — exported.
  - `resolveEocProblemAreaId(label: string): Promise<string>` — unchanged signature, now a thin wrapper.

- [ ] **Step 1: Open the file** `src/api/jira.ts` and locate the existing block starting at line 60 (`// Look up an EOC Problem Area's option ID by its human label.`).

- [ ] **Step 2: Replace lines 60–92 with this generalized implementation.** Match the indentation exactly.

```ts
/**
 * Resolve a Jira custom-field option ID by its human label, given project + issue
 * type context. Walks /rest/api/3/issue/createmeta/{projectKey}/issuetypes/{issueTypeId},
 * caches results in chrome.storage.local so the (slow) lookup runs once per device.
 */
const OPTION_LOOKUP_CACHE_KEY = 'jira_option_lookup_cache';

type OptionLookupCache = Record<string, Record<string, string>>;

function optionCacheKey(projectKey: string, issueTypeId: string, fieldId: string): string {
  return `${projectKey}:${issueTypeId}:${fieldId}`;
}

export async function resolveOptionId(
  projectKey: string,
  issueTypeId: string,
  fieldId: string,
  label: string,
): Promise<string> {
  const target = label.toLowerCase().trim();
  const cacheKey = optionCacheKey(projectKey, issueTypeId, fieldId);

  const stored = (await chrome.storage.local.get(OPTION_LOOKUP_CACHE_KEY))[OPTION_LOOKUP_CACHE_KEY] as OptionLookupCache | undefined;
  const cached = stored?.[cacheKey];
  if (cached && cached[target]) return cached[target];

  // Paginated walk of createmeta — same shape the EOC resolver used.
  let allFields: any[] = [];
  let startAt = 0;
  for (let safety = 0; safety < 10; safety++) {
    const resp = await jiraFetch(`/rest/api/3/issue/createmeta/${encodeURIComponent(projectKey)}/issuetypes/${encodeURIComponent(issueTypeId)}?startAt=${startAt}&maxResults=100`);
    if (!resp.ok) throw new Error(`Failed to fetch createmeta for ${projectKey}/${issueTypeId} (HTTP ${resp.status})`);
    const data = await resp.json();
    const fields = data.fields || [];
    allFields = allFields.concat(fields);
    if (data.isLast !== false || fields.length === 0) break;
    startAt += fields.length;
  }

  const field = allFields.find((f: any) => f.fieldId === fieldId);
  if (!field?.allowedValues) throw new Error(`Field ${fieldId} not found in ${projectKey}/${issueTypeId} metadata`);
  const match = field.allowedValues.find((v: any) => {
    const val = (v.value ?? v.name ?? '').toString().toLowerCase();
    return val === target;
  });
  if (!match) throw new Error(`Option "${label}" not found for ${projectKey}/${issueTypeId} field ${fieldId}`);

  const next: OptionLookupCache = { ...(stored || {}) };
  next[cacheKey] = { ...(next[cacheKey] || {}), [target]: match.id };
  await chrome.storage.local.set({ [OPTION_LOOKUP_CACHE_KEY]: next });

  return match.id;
}

// Backward-compatible wrapper — EOC Problem Area resolution still uses the
// same field-and-issue-type tuple it always has.
export async function resolveEocProblemAreaId(label: string): Promise<string> {
  return resolveOptionId('EOC', '10002', 'customfield_10334', label);
}
```

- [ ] **Step 3: Remove the now-orphaned `EOC_PA_CACHE_KEY` constant and `PROBLEM_AREA_FIELD` constant** (they were defined just above the old block). The replacement covers their roles via `OPTION_LOOKUP_CACHE_KEY` and the `fieldId` parameter respectively.

Search for those names in the file and delete the constant declarations. They should be the only remaining references after the replacement above.

- [ ] **Step 4: Save and run a build to confirm.**

Run from `~/projects/wocoo-extension/extension/`:
```bash
npm run build
```
Expected: build completes without TypeScript errors.

- [ ] **Step 5: Manual smoke test the EOC path** (the wrapper must still work — this is a regression check, not new behavior).

  1. Run `chrome://extensions` → reload "WOCOO Triager" (unpacked).
  2. Open a WOCOO ticket in Jira that you can safely test-move (a closed/test ticket).
  3. Open the side panel → click **Move**.
  4. Pick **EOC**, set Problem Area to "Payment Card - Issuance & Lifecycle", fill Account ID (or click Fetch), enter a reason.
  5. Click **Review & Clone/Move** — do NOT confirm. The Review button should enable without errors.
  6. Press **Back to Edit**, close the modal.

Expected: no console errors, no `"Problem Area … not found"` exceptions. The Review step working confirms `resolveEocProblemAreaId` still resolves through the new generic path.

  > If you DO want a full end-to-end Confirm on a real ticket, fine, but only on a test ticket you're prepared to clean up.

---

## Task 3: Add ExpressShippingFields UI to MoveModal.tsx (render only — no execute wiring yet)

**Files:**
- Modify: `src/sidepanel/MoveModal.tsx` — add imports + state + new sub-component + swap the `dest.key === 'PFO'` render branch.

**Interfaces:**
- Consumes:
  - From Task 1: `CARD_TYPE_LABELS`, `type CardType`, `USER_TIER_LABELS`, `type UserTier`, `REISSUE_REASON_LABELS`, `recommendedCardType`, `tierToUserTierLabel`, `PFO_API_SUPPORTED_WORK_TYPES`, `type PfoWorkType` (already exported).
- Produces:
  - New top-level state vars in `MoveModal`: `cardType: CardType`, `userTier: UserTier`, `reissueReason: string`, `dateNeeded: string`.
  - New sub-component `ExpressShippingFields` (file-local, like the existing `PfoFields`).
  - Updated `pfoReady` validation expression.

- [ ] **Step 1: Update the import from `../data/moveConfig`** at the top of `MoveModal.tsx` (around line 14). Replace the existing import block with this expanded one:

```ts
import {
  DESTINATIONS,
  type DestinationConfig,
  type MoveDestination,
  EOC_TARGET,
  EOC_CLIENT_STATUS_IDS,
  EOC_PROBLEM_AREAS,
  PFO_API_SUPPORTED_WORK_TYPES,
  type PfoWorkType,
  CARD_TYPE_LABELS,
  type CardType,
  USER_TIER_LABELS,
  type UserTier,
  REISSUE_REASON_LABELS,
  recommendedCardType,
  recommendedPfoWorkType,
  recommendedProblemArea,
  tierToUserTierLabel,
} from '../data/moveConfig';
```

The unused `DestinationConfig` may already be present; leave it. If TypeScript complains it's unused, delete it.

- [ ] **Step 2: Add four new state hooks** inside the `MoveModal` component body, immediately after the existing `pfoWorkType` declaration (around line 49–51 in the current file):

```ts
const [cardType, setCardType] = useState<CardType>(recommendedCardType(ticket.workType));
const [userTier, setUserTier] = useState<UserTier>(tierToUserTierLabel(ticket.tier));
const [reissueReason, setReissueReason] = useState<string>('');
const [dateNeeded, setDateNeeded] = useState<string>('ASAP');
```

- [ ] **Step 3: Sync `cardType` whenever `pfoWorkType` changes** — add an effect right below the existing Esc-key effect (around line 68):

```ts
useEffect(() => {
  if (pfoWorkType === 'Credit Card: Delivery Issue') setCardType('Credit Card');
  else if (pfoWorkType === 'Prepaid Card: Delivery Issue') setCardType('Prepaid Mastercard');
}, [pfoWorkType]);
```

Always overwrites — picker is the primary intent (per spec).

- [ ] **Step 4: Update `pfoReady`** at the existing line that reads `const pfoReady = ...` (around line 110):

```ts
const isPfoCheques = pfoWorkType === 'Cheques: Delivery Issue';
const pfoReady = !!ticket.identityId && (
  isPfoCheques
    ? true
    : !!reissueReason && !!dateNeeded.trim() && !!cardType && !!userTier
);
```

- [ ] **Step 5: Replace the `{dest.key === 'PFO' && ...}` JSX block** (currently around lines 300–306) with a branching render:

```tsx
{dest.key === 'PFO' && isPfoCheques && (
  <PfoFields
    workType={pfoWorkType}
    onWorkType={setPfoWorkType}
    locked={status === 'confirming' || status === 'executing'}
  />
)}

{dest.key === 'PFO' && !isPfoCheques && (
  <>
    <PfoFields
      workType={pfoWorkType}
      onWorkType={setPfoWorkType}
      locked={status === 'confirming' || status === 'executing'}
    />
    <ExpressShippingFields
      cardType={cardType}
      onCardType={setCardType}
      userTier={userTier}
      onUserTier={setUserTier}
      reissueReason={reissueReason}
      onReissueReason={setReissueReason}
      dateNeeded={dateNeeded}
      onDateNeeded={setDateNeeded}
      locked={status === 'confirming' || status === 'executing'}
    />
  </>
)}
```

Keeping the existing `PfoFields` work-type picker buttons above keeps the UX of "pick the work type, then fill the form below" intact.

- [ ] **Step 6: Add the `ExpressShippingFields` sub-component** at the end of the file, just before the `// ---------- shells ----------` comment (around line 844). Paste verbatim:

```tsx
function ExpressShippingFields(props: {
  cardType: CardType;
  onCardType: (c: CardType) => void;
  userTier: UserTier;
  onUserTier: (t: UserTier) => void;
  reissueReason: string;
  onReissueReason: (r: string) => void;
  dateNeeded: string;
  onDateNeeded: (d: string) => void;
  locked: boolean;
}) {
  return (
    <section style={sectionStyle}>
      <Label>Step 4: Express Shipping Request details</Label>

      <div style={{ marginBottom: 'var(--mint-sp-3)' }}>
        <FieldLabel>Card Type</FieldLabel>
        <div style={{ display: 'flex', gap: 'var(--mint-sp-2)' }}>
          {CARD_TYPE_LABELS.map((ct) => {
            const active = props.cardType === ct;
            return (
              <button
                key={ct}
                disabled={props.locked}
                onClick={() => props.onCardType(ct)}
                style={{
                  flex: 1,
                  padding: '6px 12px',
                  background: active ? 'var(--mint-fg-strong)' : 'var(--mint-bg-card)',
                  color: active ? 'var(--mint-fg-inverted)' : 'var(--mint-fg-strong)',
                  border: 'var(--mint-card-stroke)',
                  borderRadius: 'var(--mint-radius-button)',
                  fontWeight: 600,
                  fontSize: 'var(--mint-text-meta)',
                  cursor: props.locked ? 'not-allowed' : 'pointer',
                  opacity: props.locked ? 0.6 : 1,
                }}
              >
                {ct}
              </button>
            );
          })}
        </div>
      </div>

      <div style={{ marginBottom: 'var(--mint-sp-3)' }}>
        <FieldLabel>User Tier</FieldLabel>
        <div style={{ display: 'flex', gap: 'var(--mint-sp-2)' }}>
          {USER_TIER_LABELS.map((t) => {
            const active = props.userTier === t;
            return (
              <button
                key={t}
                disabled={props.locked}
                onClick={() => props.onUserTier(t)}
                style={{
                  flex: 1,
                  padding: '6px 12px',
                  background: active ? 'var(--mint-warning-fg-graphic)' : 'var(--mint-bg-card)',
                  color: active ? '#fff' : 'var(--mint-fg-strong)',
                  border: 'var(--mint-card-stroke)',
                  borderRadius: 'var(--mint-radius-button)',
                  fontWeight: 600,
                  fontSize: 'var(--mint-text-meta)',
                  cursor: props.locked ? 'not-allowed' : 'pointer',
                  opacity: props.locked ? 0.6 : 1,
                }}
              >
                {t}
              </button>
            );
          })}
        </div>
      </div>

      <div style={{ marginBottom: 'var(--mint-sp-3)' }}>
        <FieldLabel>Reissue Reason <span style={{ color: 'var(--mint-negative-fg-strong)' }}>*</span></FieldLabel>
        <select
          value={props.reissueReason}
          disabled={props.locked}
          onChange={(e) => props.onReissueReason(e.target.value)}
          style={{
            width: '100%',
            padding: '6px 10px',
            border: 'var(--mint-card-stroke)',
            borderRadius: 'var(--mint-radius-button)',
            fontSize: 'var(--mint-text-meta)',
            background: 'var(--mint-bg-card)',
            color: 'var(--mint-fg-strong)',
          }}
        >
          <option value="">Select a reason…</option>
          {REISSUE_REASON_LABELS.map((r) => (
            <option key={r} value={r}>{r}</option>
          ))}
        </select>
      </div>

      <div>
        <FieldLabel>Date that card is needed <span style={{ color: 'var(--mint-negative-fg-strong)' }}>*</span></FieldLabel>
        <input
          type="text"
          value={props.dateNeeded}
          disabled={props.locked}
          onChange={(e) => props.onDateNeeded(e.target.value)}
          placeholder="e.g. ASAP, June 26 2026, Not urgent"
          style={{
            width: '100%',
            padding: '6px 10px',
            border: 'var(--mint-card-stroke)',
            borderRadius: 'var(--mint-radius-button)',
            fontSize: 'var(--mint-text-meta)',
            background: 'var(--mint-bg-card)',
            color: 'var(--mint-fg-strong)',
            boxSizing: 'border-box',
          }}
        />
      </div>
    </section>
  );
}
```

- [ ] **Step 7: Build and verify the type compile.**

Run from `~/projects/wocoo-extension/extension/`:
```bash
npm run build
```
Expected: build completes without TypeScript errors.

- [ ] **Step 8: Manual UI verification** (no submit yet — `execute()` is still on the old payload, so don't Confirm):

  1. `chrome://extensions` → reload "WOCOO Triager".
  2. Open a real Credit Card or Prepaid Card WOCOO ticket.
  3. Open side panel → **Move**.
  4. Pick **PFO**.
  5. **Credit Card** button → expect: Express Shipping Request form appears below, Card Type = "Credit Card" (highlighted), User Tier = ticket.tier or "Core", Reissue Reason = empty dropdown, Date Needed = "ASAP".
  6. Click **Prepaid Card** button → expect: Card Type **toggles to "Prepaid Mastercard"** automatically (even if you flipped it manually first).
  7. Click **Cheques: Delivery Issue** → expect: Express Shipping form disappears, only the work-type picker remains, "Review & Clone/Move" enables with no extra fields.
  8. Back to Credit Card → leave Reissue Reason empty → expect: Review button **disabled**.
  9. Pick a Reissue Reason → expect: Review button **enables**.

Do NOT click Confirm — the Express Shipping execute branch isn't wired yet (Task 4). If you accidentally confirm now, the move will fail with the old `Issue type "Credit Card: Delivery Issue" not found in project PFO` error.

---

## Task 4: Wire the Express Shipping payload into execute()

**Files:**
- Modify: `src/sidepanel/MoveModal.tsx` — `execute()` function's PFO branch.

**Interfaces:**
- Consumes:
  - From Task 1: `PFO_PROJECT_ID`, `PFO_EXPRESS_SHIPPING_ISSUETYPE_ID`, `PFO_CHEQUES_DELIVERY_ISSUETYPE_ID`, `EXPRESS_SHIPPING_FIELDS`.
  - From Task 2: `resolveOptionId`.
  - From Task 3: the new state vars `cardType`, `userTier`, `reissueReason`, `dateNeeded`, `isPfoCheques`.
- Produces: working Express Shipping moves end-to-end. No new exports.

- [ ] **Step 1: Update the import from `../data/moveConfig`** at the top of `MoveModal.tsx` to add the three new constants:

```ts
import {
  DESTINATIONS,
  type DestinationConfig,
  type MoveDestination,
  EOC_TARGET,
  EOC_CLIENT_STATUS_IDS,
  EOC_PROBLEM_AREAS,
  PFO_API_SUPPORTED_WORK_TYPES,
  type PfoWorkType,
  PFO_PROJECT_ID,
  PFO_EXPRESS_SHIPPING_ISSUETYPE_ID,
  PFO_CHEQUES_DELIVERY_ISSUETYPE_ID,
  EXPRESS_SHIPPING_FIELDS,
  CARD_TYPE_LABELS,
  type CardType,
  USER_TIER_LABELS,
  type UserTier,
  REISSUE_REASON_LABELS,
  recommendedCardType,
  recommendedPfoWorkType,
  recommendedProblemArea,
  tierToUserTierLabel,
} from '../data/moveConfig';
```

- [ ] **Step 2: Update the import from `../api/jira`** to add `resolveOptionId`:

```ts
import {
  moveTicket,
  rawField,
  MOVE_FIELDS,
  lookupProjectAndIssueType,
  resolveEocProblemAreaId,
  resolveOptionId,
  getMyself,
  cloneTicket,
  linkIssues,
  postComment,
  transitionTicket,
} from '../api/jira';
```

- [ ] **Step 3: Locate the existing PFO branch** inside `execute()` — it's the `} else if (dest.key === 'PFO') {` block (around lines 169–181 in the current file, after Task 3's edits the line numbers may shift slightly). It currently reads:

```ts
} else if (dest.key === 'PFO') {
  if (!ticket.identityId) throw new Error('Source ticket has no Identity ID.');
  const { projectId, issueTypeId } = await lookupProjectAndIssueType('PFO', pfoWorkType);
  destLabel = `PFO (${pfoWorkType})`;
  moveCall = () => moveTicket({
    sourceKey: ticket.id,
    destProjectId: projectId,
    destIssueTypeId: issueTypeId,
    mandatoryFields: {
      [MOVE_FIELDS.SUMMARY]:     rawField(ticket.summary),
      [MOVE_FIELDS.IDENTITY_ID]: rawField(ticket.identityId),
    },
  });
}
```

- [ ] **Step 4: Replace the entire PFO branch above** with the new dual-path version:

```ts
} else if (dest.key === 'PFO') {
  if (!ticket.identityId) throw new Error('Source ticket has no Identity ID.');

  if (isPfoCheques) {
    destLabel = `PFO (${pfoWorkType})`;
    moveCall = () => moveTicket({
      sourceKey: ticket.id,
      destProjectId: PFO_PROJECT_ID,
      destIssueTypeId: PFO_CHEQUES_DELIVERY_ISSUETYPE_ID,
      mandatoryFields: {
        [EXPRESS_SHIPPING_FIELDS.SUMMARY]:     rawField(ticket.summary),
        [EXPRESS_SHIPPING_FIELDS.IDENTITY_ID]: rawField(ticket.identityId),
      },
    });
  } else {
    if (!reissueReason) throw new Error('Pick a Reissue Reason first.');
    if (!dateNeeded.trim()) throw new Error('Enter a Date that card is needed.');

    const [cardTypeId, userTierId, reissueReasonId, didReissueId, cxKeepsId] = await Promise.all([
      resolveOptionId('PFO', PFO_EXPRESS_SHIPPING_ISSUETYPE_ID, EXPRESS_SHIPPING_FIELDS.CARD_TYPE, cardType),
      resolveOptionId('PFO', PFO_EXPRESS_SHIPPING_ISSUETYPE_ID, EXPRESS_SHIPPING_FIELDS.USER_TIER, userTier),
      resolveOptionId('PFO', PFO_EXPRESS_SHIPPING_ISSUETYPE_ID, EXPRESS_SHIPPING_FIELDS.REISSUE_REASON, reissueReason),
      resolveOptionId('PFO', PFO_EXPRESS_SHIPPING_ISSUETYPE_ID, EXPRESS_SHIPPING_FIELDS.DID_REISSUE, 'No'),
      resolveOptionId('PFO', PFO_EXPRESS_SHIPPING_ISSUETYPE_ID, EXPRESS_SHIPPING_FIELDS.CX_KEEPS_OWNERSHIP, 'Yes'),
    ]);

    destLabel = `PFO (Express Shipping Request · ${cardType} · ${reissueReason})`;

    moveCall = () => moveTicket({
      sourceKey: ticket.id,
      destProjectId: PFO_PROJECT_ID,
      destIssueTypeId: PFO_EXPRESS_SHIPPING_ISSUETYPE_ID,
      mandatoryFields: {
        [EXPRESS_SHIPPING_FIELDS.SUMMARY]:            rawField(ticket.summary),
        [EXPRESS_SHIPPING_FIELDS.IDENTITY_ID]:        rawField(ticket.identityId),
        [EXPRESS_SHIPPING_FIELDS.CARD_TYPE]:          rawField(cardTypeId),
        [EXPRESS_SHIPPING_FIELDS.USER_TIER]:          rawField(userTierId),
        [EXPRESS_SHIPPING_FIELDS.REISSUE_REASON]:     rawField(reissueReasonId),
        [EXPRESS_SHIPPING_FIELDS.DATE_NEEDED]:        rawField(dateNeeded.trim()),
        [EXPRESS_SHIPPING_FIELDS.DID_REISSUE]:        rawField(didReissueId),
        [EXPRESS_SHIPPING_FIELDS.CX_KEEPS_OWNERSHIP]: rawField(cxKeepsId),
      },
    });
  }
}
```

Note: `EXPRESS_SHIPPING_FIELDS.SUMMARY` and `EXPRESS_SHIPPING_FIELDS.IDENTITY_ID` are deliberately used in the Cheques branch too — they're the same field IDs the old `MOVE_FIELDS` constants resolve to (`summary` and `customfield_11458`). Using one map keeps the Cheques and Express paths visually parallel.

- [ ] **Step 5: Build to confirm TypeScript compiles.**

Run from `~/projects/wocoo-extension/extension/`:
```bash
npm run build
```
Expected: build completes without TypeScript errors.

- [ ] **Step 6: Reload the extension.**

`chrome://extensions` → reload "WOCOO Triager".

- [ ] **Step 7: End-to-end test — Prepaid Card move.**

  1. Open a real Prepaid Card WOCOO ticket safe for testing (or use the original blocking case WOCOO-23203 if it's still in the right state).
  2. Side panel → **Move** → **PFO** → **Prepaid Card**.
  3. Confirm the form pre-populates: Card Type = Prepaid Mastercard, User Tier = ticket's tier, Date = "ASAP".
  4. Pick a Reissue Reason ("Failed Delivery (It's been > 15 days)" is the common default — pick whatever fits the ticket).
  5. Type a Reason for move.
  6. Click **Review & Clone/Move** → **Confirm**.
  7. Watch for any errors in the side panel.

Expected:
  - Success panel appears: "Original WOCOO-X reassigned to PFO (Express Shipping Request · Prepaid Mastercard · ...). Clone WOCOO-Y created and moved to Done."
  - Open the original ticket in Jira (the link in the success panel). It should now be a PFO ticket of type **Express Shipping Request** with all custom fields populated: Card Type = Prepaid Mastercard, User Tier = matching, Reissue Reason = picked, Date that card is needed = "ASAP", User Identity ID = source's, Did you perform Card Reissue? = No, Will CX keep ownership? = Yes.
  - The clone is on the original CXA board, marked Done, with the cross-reference comments.
  - The WOCOO Moves sheet has a new row with destination "PFO (Express Shipping Request · ...)".

If any option resolution fails with `Option "X" not found …`: the createmeta endpoint is returning blank labels for that field, falling into the spec's "blank option labels" risk. Stop here and report; we'll add the autocomplete-endpoint fallback as a follow-up.

- [ ] **Step 8: End-to-end test — Credit Card move.**

Same as Step 7, but on a Credit Card WOCOO ticket. Confirm Card Type lands as "Credit Card" in the resulting PFO ticket.

- [ ] **Step 9: End-to-end test — Cheques regression.**

  1. Open a Cheques delivery WOCOO ticket.
  2. Move → PFO → **Cheques: Delivery Issue** (existing button).
  3. Expect: no extra form rows appear. Submit succeeds.
  4. Open the destination PFO ticket: it should be issue type "Cheques: Delivery Issue" (14658), Summary + Identity ID populated, no Express Shipping fields touched.

Expected: same Cheques behavior as before this work — no regression.

- [ ] **Step 10: Negative — verify validation gate.**

  1. New Move modal, PFO → Credit Card.
  2. Clear out the Date Needed field (delete "ASAP").
  3. Don't pick a Reissue Reason.
  4. Confirm the **Review & Clone/Move** button is disabled.
  5. Type something in Date, still no Reissue Reason → still disabled.
  6. Pick a Reissue Reason → button enables.

---

## Self-Review Summary

After writing the plan, checked it against the spec:

- **Spec coverage:** Field plan (Task 3 form + Task 4 payload), picker behavior (Task 3 Step 3 sync effect), Cheques unchanged path (Task 4 Step 4 conditional), `resolveOptionId` mechanism (Task 2), Reissue Reason 4 known + 3 TBD (Task 1 inline comment), hardcoded `No` / `Yes` for hidden fields (Task 4 Step 4), validation rules (Task 3 Step 4 + Task 4 Step 4 inline checks), audit log destLabel (Task 4 Step 4). EOC regression check (Task 2 Step 5). Cheques regression check (Task 4 Step 9). All covered.
- **Placeholder scan:** No "TBD"/"TODO" in any step. The `REISSUE_REASON_LABELS` comment about "3 more exist" is an intentional acknowledged gap, not a TODO blocking implementation.
- **Type consistency:** `CardType`, `UserTier`, `PfoWorkType`, `EXPRESS_SHIPPING_FIELDS` keys/values match across tasks.
- **Scope:** One feature, three files, four tasks. Single plan is the right shape.
