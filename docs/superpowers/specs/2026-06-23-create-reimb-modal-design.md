# Create REIMB Ticket Modal

**Date**: 2026-06-23
**Author**: Albert Cai (with Claude)
**Status**: Draft, pending implementation

## Problem

The WOCOO Triager extension has two ways to create REIMB tickets today: through Overpayment Triage (a fixed multi-step workflow with hardcoded payload values), and via Jira's native UI (out of band, 11 required fields to fill manually). There is no fast in-extension path for the everyday case where a CXA agent needs to spin up a generic reimbursement ticket from a non-overpayment WOCOO context — credit card cashback recovery, transfer fee reimbursement, missed returns, goodwill credits, write-offs, etc.

The agent currently has to leave the side panel, hit Jira's native Create, fill all 11 required fields by hand (most of which could be inferred from the source ticket), then copy the new REIMB key back and link it manually on the WOCOO ticket. That's the round-trip this design eliminates.

## Goals

- Add a side-panel button "Create REIMB Ticket" that opens a modal mirroring Clone/Move's shell.
- Autofill from the source WOCOO ticket every field that can be derived (Account ID, User Tier, Identity ID, Amount, Summary, Description template).
- Provide quick-pick defaults for the everyday dropdown values; require the agent to actively pick the one truly variable field (Reimbursement Reason).
- Post a comment on the source WOCOO ticket linking the new REIMB and transition the source to Done — same audit-trail pattern OverpaymentTriage uses.
- Leave OverpaymentTriage's existing `createReimbTicket` and call site completely untouched. The new modal gets its own Jira-create function (`createReimbTicketFromForm`). Two payload builders for two workflows; explicit duplication beats the regression risk of refactoring a working path.

## Non-Goals

- Goodwill Credit and Bulk Reimbursement issue types — out of scope for v1. Only the "Reimbursement" issue type (id `11471`).
- Replacing or modifying Overpayment Triage. Its UI, flow, and `createReimbTicket` call are untouched.
- A bulk-create flow (multiple REIMBs from one source ticket).
- Editing or migrating REIMB tickets already created.

## Side Panel Layout Change

Today's action button bar (in `SidePanel.tsx`):

| Row | Buttons |
|---|---|
| 1 | Clone/Move · Triage Overpayment · Done |
| 2 | Reverse Fee · QC Fee Waiver |
| 3 | Verify Eligible DD (full-width) |

New layout:

| Row | Buttons |
|---|---|
| 1 | Clone/Move · Triage Overpayment · Done |
| 2 | Reverse Fee · QC Fee Waiver |
| 3 | **Verify Eligible DD · Create REIMB Ticket** (half-width each) |

The new button uses `variant="highlight"` (same as Verify Eligible DD), is disabled when `!ticket.identityId`, and on click sets a `createReimbActive: boolean` state that mounts the `<CreateReimbModal ticket={ticket} onClose={...} />` overlay.

## Modal Contents

### Header
`Create REIMB ticket from <WOCOO-XXXXX>` with a close ✕ button. Esc closes (when not executing).

### Form fields

Modal body renders as a single vertical stack of field sections. All fields except Description and Summary are required-marked.

| Field | Custom field | UI | Default | Notes |
|---|---|---|---|---|
| Summary | `summary` | Text input | `ticket.summary` | editable |
| Description | `description` | Textarea (5 rows) | Template (see below) | editable; live re-templates until first manual edit |
| Account ID (W#) | `customfield_10082` | Text input + Atlas Fetch button | `ticket.accountId` (or empty) | validates against `/^[CHWN][0-9A-Z]{7,}$/i`; Atlas Fetch uses `fetchAtlasAccountIdHeadless` |
| User Tier | `customfield_11416` | 3-way toggle Core / Premium / Generation | `tierToUserTierLabel(ticket.tier)` | editable |
| User Identity ID | `customfield_11458` | Read-only display | `ticket.identityId` | not editable |
| Total reimbursement amount | `customfield_10285` | Number input | `ticket.totalReimbursementAmount ?? ''` | accepts negative values (write-offs); must be non-empty to submit |
| Currency | `customfield_10213` | 2-way toggle CAD / USD | **CAD** | editable |
| Reimbursement Reason | `customfield_10288` | Dropdown, 21 options | **none — agent must pick** | required for submit |
| Requestor team | `customfield_10287` | Dropdown, 7 options | **Operations Cash** | editable |
| Next Level Approval | `customfield_10315` | Luke / Amanda quick-pick buttons + "Other" search input | Luke if amount < $5K, Amanda if ≥ $5K | search hits `/rest/api/3/user/picker?query=` |
| Incident Related? | `customfield_12419` | 2-way toggle Yes / No | **No** | editable |

### Description template

When the modal opens (and continuously, until the agent manually edits the textarea):

```
Hi team, can we please reimburse this client ({identityId}) for ${amount.toFixed(2)}? Reference ticket:

{sourceUrl}
```

- `{identityId}` = `ticket.identityId`
- `{amount}` = the current value of the amount input (formatted with 2 decimals, e.g. `$211.68`; for negative `-613` → `$-613.00`)
- `{sourceUrl}` = `https://wealthsimple.atlassian.net/browse/${ticket.id}`

Once the agent touches the textarea, the live re-template stops. If they want to reset, they can delete the field and the template will re-fill on the next state update (amount change, for example) — or we expose a small `↻ Reset template` link. Initial design: no explicit reset link; the dirty flag is only cleared on full-empty.

### Validation (`reimbReady`)

```
identityId AND
accountId matches /^[CHWN][0-9A-Z]{7,}$/i AND
amount is a finite number (typeof === 'number' && !isNaN) AND
summary.trim().length > 0 AND
reimbursementReason !== '' AND
nextLevelApprover.accountId !== null
```

Currency, User Tier, Requestor team, Incident Related?, Description, Reimbursement Reason — all defaulted or always populated; no need to validate.

### Submit flow

```
1. resolveOptionId('REIMB', '11471', '10213', currency)         → currencyId
2. resolveOptionId('REIMB', '11471', '10287', requestorTeam)    → requestorTeamId
3. resolveOptionId('REIMB', '11471', '10288', reimbursementReason) → reasonId
4. resolveOptionId('REIMB', '11471', '12419', incidentRelated)  → incidentRelatedId
   (4 calls in Promise.all; cached via the existing jira_option_lookup_cache)

5. createReimbTicket({ ...all 11 args... })   → { key, url }

6. postComment(ticket.id, [
     'Hi ', mention(reporterAccountId, '@'+reporterName),
     ' reimbursement ticket has been created! ',
     link(reimbUrl, reimbUrl),
   ])

7. transitionTicket(ticket.id, '251')   // Done

Steps 6 and 7 each wrapped in try/catch — if they fail, treat REIMB-create as
success but surface a soft warning. REIMB is never rolled back.
```

### Confirm gate

Same two-step pattern as MoveModal:
1. Configuring → click `Review & Create REIMB` → enters `confirming` state.
2. Confirming → shows yellow warning panel: `Create REIMB from {ticket.id}, post a link comment to it, then transition it to Done?` with `✓ Confirm Create` and `← Back to Edit`.
3. Confirming → click confirm → enters `executing` state.

### Success panel

After step 5 succeeds (regardless of 6/7 outcome):

```
✓ REIMB ticket created
<REIMB-XXXXX> ← link, opens in new tab

[Source ticket comment + Done] succeeded silently OR shown as soft warnings:
  - Comment on WOCOO-XXXXX failed: {err}. Link it manually in Jira.
  - Move-to-Done on WOCOO-XXXXX failed: {err}. Close it manually in Jira.

Jira processes asynchronously — open {REIMB-XXXXX} in Jira to verify.

[Close] button
```

## Architecture

### Files touched

| Path | New? | Responsibility |
|---|---|---|
| `src/sidepanel/SidePanel.tsx` | modify | Split Verify Eligible DD row into 2 half-width buttons; add Create REIMB Ticket button; track `createReimbActive` state; mount `<CreateReimbModal>`. |
| `src/sidepanel/CreateReimbModal.tsx` | **new** | Self-contained modal mirroring `MoveModal`'s shell + subcomponents. Owns all field state, validation, option-ID resolution, the Jira create call, the post-comment, the transition, and success/error UI. |
| `src/api/jira.ts` | modify | Add a new `createReimbTicketFromForm(args)` function — separate from the existing `createReimbTicket` — that builds the REIMB create payload from explicit option IDs and form fields. Add `searchJiraUsers(query)` helper wrapping `/rest/api/3/user/picker?query=...&maxResults=10`. No edits to `createReimbTicket` or `REIMB_APPROVERS`. |
| `src/data/reimbConfig.ts` | **new** | REIMB project + issuetype IDs; `REIMB_FIELDS` custom-field-ID map; option label arrays (`CURRENCY_LABELS`, `REQUESTOR_TEAM_LABELS`, `REIMBURSEMENT_REASON_LABELS`, `INCIDENT_RELATED_LABELS`); UI defaults (currency = `'CAD'`, requestor team = `'Operations Cash'`, incident related = `'No'`). |

No deletions; no moves. `OverpaymentTriage.tsx` is **not** touched.

### Reused machinery

- `resolveOptionId(projectKey, issueTypeId, fieldId, label)` — shipped in the PFO Express Shipping work. Handles all 4 REIMB option lookups with the existing `jira_option_lookup_cache` storage entry.
- `buildCommentSegments` / `postComment` / ADF mention nodes — exist in `jira.ts` and `OverpaymentTriage.tsx`. Reuse the comment-segment shape.
- `transitionTicket(ticketKey, '251')` — transition id `'251'` = Done. Already used by OverpaymentTriage and MoveModal.
- `fetchAtlasAccountIdHeadless` — existing Atlas Fetch path MoveModal uses for the EOC Account ID field. Same UX in this modal.
- `REIMB_APPROVERS` constant in `jira.ts` — Luke / Amanda accountId pair, used for the quick-pick buttons.

### New `createReimbTicketFromForm` (separate from `createReimbTicket`)

```ts
export interface CreateReimbFromFormArgs {
  identityId: string;
  amount: number;
  accountId: string;
  tier: 'Core' | 'Premium' | 'Generation';
  approverAccountId: string;
  summary: string;
  description: string;
  currencyId: string;
  requestorTeamId: string;
  reimbursementReasonId: string;
  incidentRelatedId: string;
}

export async function createReimbTicketFromForm(args: CreateReimbFromFormArgs): Promise<{ key: string; url: string }>
```

Builds the same `POST /rest/api/3/issue` payload shape as the existing `createReimbTicket` (project key `'REIMB'`, issuetype `'Reimbursement'`, priority `'Medium'`, ADF description, the 8 custom fields), but takes everything as explicit args with no hidden defaults. The two functions are intentionally parallel — if Jira's REIMB schema ever changes both will need updating, but the duplication is bounded (one short payload-builder function) and keeps OverpaymentTriage off the change list.

The new modal calls `createReimbTicketFromForm` after running `resolveOptionId` for the 4 option fields. OverpaymentTriage continues to call `createReimbTicket` unchanged.

Description is now passed in as a string, not built inside the function. OverpaymentTriage passes the same template string it would have built internally; the new modal passes whatever the textarea contains.

### `searchJiraUsers` signature

```ts
export interface JiraUserSearchResult {
  accountId: string;
  displayName: string;
  emailAddress?: string;
  avatarUrl?: string;
}

export async function searchJiraUsers(query: string): Promise<JiraUserSearchResult[]>
```

Wraps `GET /rest/api/3/user/picker?query={encoded}&maxResults=10`. Returns `[]` for empty queries. No caching (per-modal-session is enough); the modal debounces 300ms client-side.

### `reimbConfig.ts` shape

```ts
export const REIMB_PROJECT_KEY = 'REIMB';
export const REIMB_REIMBURSEMENT_ISSUETYPE_ID = '11471';

export const REIMB_FIELDS = {
  ACCOUNT_ID:           'customfield_10082',
  CURRENCY:             'customfield_10213',
  AMOUNT:               'customfield_10285',
  REQUESTOR_TEAM:       'customfield_10287',
  REIMBURSEMENT_REASON: 'customfield_10288',
  APPROVER:             'customfield_10315',
  USER_TIER:            'customfield_11416',
  IDENTITY_ID:          'customfield_11458',
  INCIDENT_RELATED:     'customfield_12419',
} as const;

export const CURRENCY_LABELS = ['CAD', 'USD'] as const;
export type Currency = (typeof CURRENCY_LABELS)[number];

export const INCIDENT_RELATED_LABELS = ['No', 'Yes'] as const;
export type IncidentRelated = (typeof INCIDENT_RELATED_LABELS)[number];

// Observed in real REIMB tickets (5 of 7 — 2 may surface during use)
export const REQUESTOR_TEAM_LABELS = [
  'Operations Cash',
  'CX - Standard',
  'CX - Premium',
  'Operations FFR',
  'Other',
  // TODO: 2 more labels (discoverable from createmeta or real tickets)
] as const;

// Observed in real REIMB tickets (5 of 21 — more will surface)
export const REIMBURSEMENT_REASON_LABELS = [
  'Reimburse to Close',
  'General Promotion',
  'Reimbursement Fees',
  'AP Write Offs',
  'Transfer Fee Reimbursement',
  'Missed Returns Reimbursement',
  // TODO: ~15 more labels (discoverable from createmeta or real tickets)
] as const;

// UI defaults for the new modal. These are labels (not IDs) because the modal
// resolves them via resolveOptionId at submit time. OverpaymentTriage's
// existing hardcoded option IDs live inside createReimbTicket and are not
// referenced from this file.
export const MODAL_DEFAULTS = {
  currency:        'CAD' as Currency,
  requestorTeam:   'Operations Cash',
  incidentRelated: 'No' as IncidentRelated,
} as const;
```

## Option ID Resolution

Same mechanism shipped for PFO Express Shipping. `resolveOptionId(...)` hits `/rest/api/3/issue/createmeta/REIMB/issuetypes/11471` and walks `allowedValues` for the named field, matching on `(v.value ?? v.name)` case-insensitively.

If `createmeta` returns blank `value` strings for REIMB option fields (the same risk flagged for PFO), OverpaymentTriage is unaffected — its `createReimbTicket` still uses the raw option IDs it always has. The new modal would surface `Option "X" not found …` to the agent for any unresolved label — at that point the fallback work (Jira `autocompletedata/suggestions` endpoint) becomes a v1.1 follow-up.

## Comment Format (source WOCOO update)

Modeled on REIMB-42740's actual comment on WOCOO-23296:

```
Hi @<reporter>  reimbursement ticket has been created!  <REIMB-URL>
```

Built via `buildCommentSegments` → `postComment`, producing ADF nodes:
1. `text` "Hi "
2. `mention` with `accountId = ticket.reporterAccountId`, `text = '@' + ticket.reporter`
3. `text` " reimbursement ticket has been created! "
4. `link` with `href = reimbUrl`, `text = reimbUrl`

If `ticket.reporterAccountId` is unavailable (the existing buildCommentSegments handles this), the mention falls back to plain `'@' + reporter` text, which still reads naturally.

## Error Handling

**Hard failures** (abort before any side effect):
- Source ticket has no Identity ID → button disabled, modal can't open.
- Required field missing on submit → Review button disabled.
- `resolveOptionId(...)` rejects → abort with `Couldn't resolve option ID for {field}={label}. Try Jira's native Create.`
- `createReimbTicket(...)` rejects → display Jira's response body verbatim; modal returns to `configuring`.
- `searchJiraUsers(query)` rejects → search input shows inline error message; quick-pick buttons (Luke/Amanda) still work.

**Soft failures** (REIMB created, warnings on success panel):
- `postComment` rejects → soft warning: `REIMB-XXXXX created, but comment on WOCOO-XXXXX failed: {err}. Link it manually in Jira.`
- `transitionTicket` rejects → soft warning: `REIMB-XXXXX created and comment posted, but Move-to-Done on WOCOO-XXXXX failed: {err}. Close it manually in Jira.`

The REIMB ticket itself is never rolled back — once Jira returns a key, it exists.

## Edge Cases

- **`ticket.totalReimbursementAmount` is null/missing**: amount input opens empty; submit disabled until agent types a number.
- **`ticket.tier` is unexpected**: `tierToUserTierLabel` returns `'Core'`; toggle stays editable.
- **Agent manually edits the description**: live re-templating stops. Reset is achieved by clearing the textarea entirely (next state change re-fills the template). No explicit reset button.
- **Negative amount** (observed in REIMB-42728 = -613 for write-offs): number input accepts any numeric value; template formats as `$-613.00`. Submit allows it.
- **Account ID malformed**: red border + helper text, submit disabled. Same regex as MoveModal.
- **Source WOCOO ticket already Done**: REIMB still created and comment posted; the transition call will likely no-op or fail. If it fails, it shows as a soft warning (informational only, since the ticket is already in the desired state).
- **Approver search returns 0 results**: input shows "No users match. Use Luke or Amanda quick-pick."
- **Approver search is in flight when agent picks Luke/Amanda quick-pick**: the in-flight result is discarded; the quick-pick wins.

## Testing

Manual, no automated tests (extension has none).

1. **Smoke — happy path with full autofill**: A WOCOO ticket with `accountId`, `tier`, `totalReimbursementAmount`, and `reporter` all populated → open the modal → confirm Summary, Description, Account ID, Tier, Identity ID, Amount, Approver default all pre-fill correctly → pick a Reimbursement Reason → leave other defaults → submit. Verify: REIMB created with all 11 fields populated; comment posted on source; source ticket Done.

2. **Smoke — minimal autofill**: A WOCOO ticket missing `accountId` and `totalReimbursementAmount` → open the modal → confirm those fields empty → click Atlas Fetch (Account ID auto-populates) → type a number for amount → pick required dropdowns → submit. Verify same outcomes as test 1.

3. **Smoke — non-default approver via search**: Open the modal → click into the Approver "Other" search → type a name → pick a result. Verify the picked accountId is in `customfield_10315` of the new REIMB.

4. **Smoke — USD currency, Yes Incident Related**: Override defaults; verify they land correctly in the resulting REIMB.

5. **Negative — required field missing**: Don't pick Reimbursement Reason → Review button stays disabled. Don't enter Amount → Review stays disabled.

6. **Negative — option lookup failure**: If first run shows `Option "X" not found …`, the createmeta-blank-labels risk has materialized. Stop and report; falls into v1.1 follow-up.

7. **Sanity — Overpayment Triage untouched**: Run the existing Overpayment Triage flow through Step 3 to confirm the existing path still works. No code in that file should have changed; this is a quick smoke check, not a regression test.

## Out of Scope

- Goodwill Credit (issuetype `11472`) and Bulk Reimbursement (issuetype `15380`) — handled by Jira native for v1.
- A "Reset description template" button — agents can clear the textarea to reset.
- Approver picker server-side recents/favorites — quick-pick handles the common case.
- Account ID accepting `H` prefix at runtime (`/^[CHWN][...]/`) — same regex as MoveModal but the H form is rare; spec accepts it via the existing regex.
- Bulk-creating multiple REIMBs from one WOCOO source ticket.
