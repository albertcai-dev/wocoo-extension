# PFO Express Shipping Request — Move Workflow

**Date**: 2026-06-19
**Author**: Albert Cai (with Claude)
**Status**: Draft, pending implementation

## Problem

PFO restructured its issue types. The WOCOO Triager extension's Move workflow assumes three PFO work types — `Credit Card: Delivery Issue`, `Prepaid Card: Delivery Issue`, `Cheques: Delivery Issue` — but only `Cheques: Delivery Issue` (id `14658`) still exists. Credit and Prepaid card delivery have been consolidated into a single new issue type, **Express Shipping Request** (id `14656`), which carries 7 required custom fields. Today, picking Credit Card or Prepaid Card in the Move modal fails with: `Issue type "Prepaid Card: Delivery Issue" not found in project PFO`.

This blocks the most common WOCOO triage path for card delivery tickets. CXA agents currently have to fall back to Jira's native Move UI and fill the 7-field form by hand.

## Goals

- Restore one-click move from a WOCOO ticket to PFO for Credit/Prepaid card delivery issues.
- Keep the `Cheques: Delivery Issue` path working unchanged (it still exists in PFO).
- Auto-prefill every field that can be derived from the source ticket, so the agent's manual input is minimal — target: pick Reissue Reason, confirm Date, submit.
- Maintain the existing Clone/Move semantics: clone original on CXA board, reassign original to PFO, move clone to Done, log to Moves sheet.

## Non-Goals

- Bringing FRAUD onto the API path (still UI-only).
- Supporting non-Express-Shipping PFO issue types via the extension (Cash Delivery, Drafts, etc.) — agents can use Jira native for those.
- Editing or migrating tickets already created with the now-removed issue types.

## Field Plan

### Picker (unchanged)

The Step 3 work-type picker stays as three buttons: **Cheques | Credit Card | Prepaid Card**.

- **Cheques** → existing simple path, issue type `14658`, payload = Summary + Identity ID only. No form.
- **Credit Card** → Express Shipping Request form with Card Type pre-set to "Credit Card".
- **Prepaid Card** → Express Shipping Request form with Card Type pre-set to "Prepaid Mastercard".

### Express Shipping Request form fields

Target issue type id: `14656` ("Express Shipping Request").

| Custom field ID | Field name | UI treatment | Default | Editable |
|---|---|---|---|---|
| `customfield_25816` | Card Type | 2-way toggle | Pre-set from picker button | yes |
| `customfield_11416` | User Tier | 3-way toggle (Core / Premium / Generation) | Pre-set from `ticket.tier`, falls back to "Core" | yes |
| `customfield_25797` | Reissue Reason | Dropdown, 7 options | **none — agent must pick** | n/a |
| `customfield_25817` | Date that card is needed | Text input | `"ASAP"` | yes |
| `customfield_11458` | User Identity ID | Read-only display | From source ticket | no |
| `customfield_25819` | Did you perform the Card Reissue? | hidden | Hardcoded `"No"` | no |
| `customfield_25821` | Will CX keep ownership of response(s)? | hidden | Hardcoded `"Yes"` | no |

The existing **Reason for move** textarea (logs to the Moves sheet) stays at the bottom of the modal, unchanged.

### Validation

`pfoReady` becomes:

- If work type = Cheques: `!!ticket.identityId` (unchanged).
- If work type = Credit Card / Prepaid Card: `!!ticket.identityId && !!reissueReason && !!dateNeeded.trim()`.

`reasonReady` (the WOCOO sheet log reason) stays as is.

## Architecture

Three files touched, no new files.

### `src/data/moveConfig.ts`

Add:

```ts
// Hardcoded after one-time discovery via GET /rest/api/3/project/PFO. Avoids
// the per-move project-lookup call (EOC uses the same pattern).
export const PFO_PROJECT_ID = '13086';
export const PFO_EXPRESS_SHIPPING_ISSUETYPE_ID = '14656';
export const PFO_CHEQUES_DELIVERY_ISSUETYPE_ID = '14658';

export const EXPRESS_SHIPPING_FIELDS = {
  SUMMARY:           'summary',
  IDENTITY_ID:       'customfield_11458',
  CARD_TYPE:         'customfield_25816',
  USER_TIER:         'customfield_11416',
  REISSUE_REASON:    'customfield_25797',
  DATE_NEEDED:       'customfield_25817',
  DID_REISSUE:       'customfield_25819',
  CX_KEEPS_OWNERSHIP:'customfield_25821',
} as const;

// Card Type — 2 known labels from PFO data
export const CARD_TYPE_LABELS = ['Credit Card', 'Prepaid Mastercard'] as const;
export type CardType = (typeof CARD_TYPE_LABELS)[number];

// User Tier — matches WOCOO ticket.tier
export const USER_TIER_LABELS = ['Core', 'Premium', 'Generation'] as const;
export type UserTier = (typeof USER_TIER_LABELS)[number];

// Reissue Reason — 4 known labels from observed PFO tickets. 3 more will be
// discovered when createmeta is fetched on first run; add them here once known.
export const REISSUE_REASON_LABELS = [
  'Failed Delivery (It\'s been > 15 days)',
  'Upgrade Card Material',
  'Fraud',
  'Other',
  // TODO: 3 more labels (discoverable from createmeta on first call)
] as const;

export function recommendedCardType(workType: string): CardType {
  return /prepaid/i.test(workType) ? 'Prepaid Mastercard' : 'Credit Card';
}

export function tierToUserTierLabel(tier: string | null | undefined): UserTier {
  if (tier === 'Premium' || tier === 'Generation' || tier === 'Core') return tier;
  return 'Core';
}
```

Update `PFO_API_SUPPORTED_WORK_TYPES` (the labels stay the same, since the picker labels haven't changed even though their target issue types have):

```ts
export const PFO_API_SUPPORTED_WORK_TYPES = [
  'Credit Card: Delivery Issue',
  'Prepaid Card: Delivery Issue',
  'Cheques: Delivery Issue',
] as const;
```

### `src/api/jira.ts`

Generalize the existing `resolveEocProblemAreaId` into a reusable resolver:

```ts
const OPTION_LOOKUP_CACHE_KEY = 'jira_option_lookup_cache';

/**
 * Resolve a custom-field option ID by label, given project + issue type context.
 * Walks /rest/api/3/issue/createmeta/{projectKey}/issuetypes/{issueTypeId},
 * caches results in chrome.storage.local across sessions.
 */
export async function resolveOptionId(
  projectKey: string,
  issueTypeId: string,
  fieldId: string,
  label: string,
): Promise<string> { /* … */ }

export async function resolveEocProblemAreaId(label: string): Promise<string> {
  return resolveOptionId('EOC', '10002', 'customfield_10334', label);
}
```

Cache shape: `{ [projectKey:issueTypeId:fieldId]: { [labelLowercased]: optionId } }`.

The createmeta fetch is paginated (`startAt`, `maxResults=100`); existing EOC code already handles this. Reuse the same loop.

`lookupProjectAndIssueType` is no longer called on the PFO branches — issue type IDs are now hardcoded in `moveConfig.ts`. Keep the function for any future destination that needs it.

### `src/sidepanel/MoveModal.tsx`

State additions:

```ts
const [reissueReason, setReissueReason] = useState<string>('');
const [dateNeeded, setDateNeeded] = useState<string>('ASAP');
const [cardType, setCardType] = useState<CardType>(recommendedCardType(ticket.workType));
const [userTier, setUserTier] = useState<UserTier>(tierToUserTierLabel(ticket.tier));
```

When `pfoWorkType` changes via the picker button, **always overwrite** `cardType` to match the new button (Credit Card → "Credit Card", Prepaid Card → "Prepaid Mastercard"), even if the agent previously flipped the toggle. Rationale: the picker is the primary intent; a stale toggle from a previous selection would be confusing and could send a mismatched payload.

Replace today's `PfoFields` with a switch:

- `pfoWorkType === 'Cheques: Delivery Issue'` → render today's `PfoFields` minus the picker (or just a small "No additional fields" note).
- Otherwise → render new `ExpressShippingFields` with Card Type / Tier / Reissue Reason / Date inputs.

The Step 3 button picker stays exactly as is — it's a sibling of these per-work-type field renders, not a replacement.

`execute()` PFO branch splits:

**Cheques path:**

```ts
moveCall = () => moveTicket({
  sourceKey: ticket.id,
  destProjectId: PFO_PROJECT_ID,
  destIssueTypeId: PFO_CHEQUES_DELIVERY_ISSUETYPE_ID,
  mandatoryFields: {
    [MOVE_FIELDS.SUMMARY]:     rawField(ticket.summary),
    [MOVE_FIELDS.IDENTITY_ID]: rawField(ticket.identityId),
  },
});
```

**Express Shipping path:**

```ts
const [cardTypeId, userTierId, reissueReasonId, didReissueId, cxKeepsId] = await Promise.all([
  resolveOptionId('PFO', PFO_EXPRESS_SHIPPING_ISSUETYPE_ID, EXPRESS_SHIPPING_FIELDS.CARD_TYPE, cardType),
  resolveOptionId('PFO', PFO_EXPRESS_SHIPPING_ISSUETYPE_ID, EXPRESS_SHIPPING_FIELDS.USER_TIER, userTier),
  resolveOptionId('PFO', PFO_EXPRESS_SHIPPING_ISSUETYPE_ID, EXPRESS_SHIPPING_FIELDS.REISSUE_REASON, reissueReason),
  resolveOptionId('PFO', PFO_EXPRESS_SHIPPING_ISSUETYPE_ID, EXPRESS_SHIPPING_FIELDS.DID_REISSUE, 'No'),
  resolveOptionId('PFO', PFO_EXPRESS_SHIPPING_ISSUETYPE_ID, EXPRESS_SHIPPING_FIELDS.CX_KEEPS_OWNERSHIP, 'Yes'),
]);

moveCall = () => moveTicket({
  sourceKey: ticket.id,
  destProjectId: PFO_PROJECT_ID,
  destIssueTypeId: PFO_EXPRESS_SHIPPING_ISSUETYPE_ID,
  mandatoryFields: {
    [EXPRESS_SHIPPING_FIELDS.SUMMARY]:           rawField(ticket.summary),
    [EXPRESS_SHIPPING_FIELDS.IDENTITY_ID]:       rawField(ticket.identityId),
    [EXPRESS_SHIPPING_FIELDS.CARD_TYPE]:         rawField(cardTypeId),
    [EXPRESS_SHIPPING_FIELDS.USER_TIER]:         rawField(userTierId),
    [EXPRESS_SHIPPING_FIELDS.REISSUE_REASON]:    rawField(reissueReasonId),
    [EXPRESS_SHIPPING_FIELDS.DATE_NEEDED]:       rawField(dateNeeded.trim()),
    [EXPRESS_SHIPPING_FIELDS.DID_REISSUE]:       rawField(didReissueId),
    [EXPRESS_SHIPPING_FIELDS.CX_KEEPS_OWNERSHIP]:rawField(cxKeepsId),
  },
});
```

The `destLabel` used for the sheet log + cross-reference comment becomes:

```
PFO (Express Shipping Request · {cardType} · {reissueReason})
```

…so the audit row tells you what was actually sent.

## Option ID Resolution

Five option fields need label→ID resolution at submit time. Mechanism:

1. **Primary**: `GET /rest/api/3/issue/createmeta/PFO/issuetypes/14656?startAt=0&maxResults=100` with the user's Bearer token. Walk `data.fields`, find the entry whose `fieldId` matches, then walk `allowedValues` for a case-insensitive match on `value`. Identical shape to the existing EOC Problem Area resolver.
2. **Cache**: `chrome.storage.local` under `jira_option_lookup_cache`, keyed by `{projectKey}:{issueTypeId}:{fieldId}` → `{labelLowercased: optionId}`. The full createmeta call (~2–3 s on EOC) runs once per device; subsequent moves are instant.

### Known risk: blank option labels

In an earlier diagnostic call, `jira_get_project_metadata` returned **blank `name` values** for the `option`-type custom fields (Card Type / Reissue Reason / etc.) on PFO `14656`. This may be specific to the mcplocker-mediated tool path; the direct Bearer-token Jira REST API may return populated labels.

We will assume direct createmeta works (mitigation 1 below) and ship that as the implementation. If it doesn't, we add mitigation 2.

**Mitigation 1 (build)**: createmeta direct-fetch, as above.

**Mitigation 2 (only if 1 returns blank labels)**: `GET /rest/api/3/jql/autocompletedata/suggestions?fieldName=cf[25797]&fieldValue=` — Jira's autocomplete endpoint, used by its own search UI, returns option labels + IDs reliably even when createmeta doesn't. Drop into `resolveOptionId` as a fallback when the primary lookup yields a blank `value` for the matched option.

**Mitigation 3 (last resort)**: Hardcode the IDs in `moveConfig.ts`. Brittle, but for the 4 known Reissue Reasons + the simple 2-way Yes/No fields we can confirm the IDs at first sign-in and write them in. Not building this on day one.

## Error Handling

**Hard failures** (abort the move pre-clone):
- Source ticket has no Identity ID → existing pre-check.
- Reissue Reason empty (Credit/Prepaid path) → submit button disabled, no error path needed.
- `resolveOptionId(...)` rejects for any of the 5 lookups → abort with: `Couldn't resolve option ID for {field}={label}. Try Jira's native Move for this ticket, or check the value still exists in PFO.`
- `moveTicket(...)` itself rejects → existing error surfacing (Jira response body shown verbatim).

**Soft failures** (move succeeds, warnings appended to the success panel):
- Clone link / clone comment / done-transition failures → existing `softWarnings[]` flow.
- Sheet log failure → existing `logWarning` flow.

## Edge Cases

- **Picker mismatch**: Source ticket workType says "Cheques" but agent picks Credit Card. `recommendedCardType(workType)` falls back to "Credit Card"; toggle stays editable. No blocking validation — trust the agent.
- **Missing or unexpected `ticket.tier`**: `tierToUserTierLabel` returns `"Core"`. Toggle visible for correction.
- **Reissue Reason dropdown has only 4 known labels**: The form displays the 4 from `REISSUE_REASON_LABELS`. On first real submit with a label not in our list, the agent will need to wait for us to discover the missing 3 from createmeta and add them. Until then, "Other" covers the long tail.
- **Identity ID malformed**: Not validated client-side; Jira rejects and the error surfaces.

## Testing

Manual, no automated tests (the extension has none today; this work doesn't justify bootstrapping a test runner).

1. **Smoke — Prepaid Card**: pick a real WOCOO Prepaid Card ticket (e.g. WOCOO-23203 or fresh). Move it. Verify the resulting PFO ticket has correct Card Type=Prepaid Mastercard, User Tier matching source, Reissue Reason as picked, Date Needed as entered, Identity ID present, Did Reissue=No, CX Keeps Ownership=Yes. Verify clone + Done transition + Sheet log all happen.
2. **Smoke — Credit Card**: same drill on a Credit Card ticket.
3. **Smoke — Cheques**: pick a Cheques delivery WOCOO ticket, verify it routes to issue type 14658 with the simple payload (no regression).
4. **Negative — missing Reissue Reason**: open the form, don't pick a Reissue Reason, verify submit stays disabled.
5. **Negative — option lookup fails**: temporarily clear `jira_option_lookup_cache`, sign out + back in, confirm the first move triggers createmeta and resolves correctly.

## Out of Scope

- Auto-populating `customfield_25818` ("If you are unable to perform the card reissue, why?") with the source ticket URL. Field is optional in practice; skip until we see it's needed.
- Migrating existing in-flight PFO tickets created with the now-removed issue types.
- Exposing PFO's other issue types (Cash Delivery, Drafts, Documentation, etc.) through the extension.
