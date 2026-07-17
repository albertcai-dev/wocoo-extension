# Wallet Triage Decision Tree

**Date**: 2026-06-23
**Author**: Albert Cai (with Claude)
**Status**: Draft, pending implementation
**Builds on**: `2026-06-23-wallet-triage-design.md` (shipped)

## Problem

The shipped Wallet Triage workflow opens a Preset dashboard + Google Doc and posts a single "have you checked yet?" comment back to the reporter. In practice, the CXA agent is the one reviewing the dashboard — they need to communicate the **conclusion** to the reporter, not punt the investigation back. The investigation guide (`https://docs.google.com/document/d/18G1-lYpfxS-FHDVTYwKyypmnXF_0evFO2pFTJRRIbXU/`) defines five concrete outcomes from the three dashboard charts, each with its own resolution and message to the reporter. The workflow needs to surface those outcomes as picker choices and generate the correct comment per outcome.

## Goals

- Replace the current fixed-comment Step 2 with a two-sub-step decision flow: pick an outcome → review/edit the templated comment → post.
- Cover all five outcomes from the investigation guide (Max Token Limit / Device Token Match / No Decline / Device Score Issue / Other Decline → WOCOO Review) with pre-written comment templates an agent can edit before posting.
- Auto-transition to Done for outcomes A–D; leave the ticket open for outcome E (WOCOO Review) so it doesn't drop off the radar.
- Maintain ADF @mention pill for the reporter in every outcome's comment.
- Keep Step 1 (open dashboard + doc) untouched.

## Non-Goals

- Auto-reading the dashboard values. The agent eyeballs the charts and picks the outcome; the extension never scrapes Preset data.
- Auto-deactivating tokens in i2c (outcome B's action). The comment template states "I'll deactivate the matching token in i2c", but the deactivation itself is a manual step the agent performs outside the workflow.
- Guided 3-step walkthrough mirroring the doc literally. Flat picker is faster for agents who've already read the dashboard.
- Surfacing a "punt to reporter" outcome. The original fixed comment is dropped — the workflow now assumes the agent has done the investigation.

## Decision Tree

From the investigation guide:

| Outcome key | Trigger (in dashboard) | After-post |
|---|---|---|
| `MAX_TOKEN_LIMIT` | Step 1 chart `Digital Wallet Credit Token Count`: `distinct_token_count` = 20 on most recent `effective_as_at_date` | Move to Done |
| `DEVICE_TOKEN_MATCH` | Step 2 chart `Active Device Tokens`: `token_device_number` matches the client's device | Move to Done |
| `NO_DECLINE` | Step 3 chart `Token Decline Code`: no results or `error_message` blank | Move to Done |
| `DEVICE_SCORE` | Step 3 chart: `error_message` present AND `scr_info_devicescore ≤ 3` | Move to Done |
| `WOCOO_REVIEW` | Step 3 chart: `error_message` present AND `scr_info_devicescore > 3` | **Leave open** |

## Workflow Shape

Grows from 2 active steps + complete to 3 active steps + complete. Sticky header counter becomes `Step N of 3`. `ProgressDots` renders 3 dots.

```
Step 1: Open dashboard & doc        (unchanged)
Step 2: Pick outcome                 (NEW — 5 outcome cards in a flat list)
Step 3: Review & post comment        (NEW — editable textarea, then submit)
Complete: Success panel              (existing, with two flavor variants per outcome)
```

### Step 2 — Pick outcome

Flat list of 5 cards (`<button>`s), each with:
- Title (e.g. "Device score issue")
- Subtitle (e.g. "Step 3 chart: error_message present + scr_info_devicescore ≤ 3")

Tapping a card sets `selectedOutcome` and advances to Step 3. Step 2 doesn't render a "Back" or "Continue" button — the cards themselves are the action.

### Step 3 — Review & post comment

Renders:
- The selected outcome's title at the top (so the agent knows what they picked).
- A `<textarea>` (5 rows) pre-filled with the outcome's template. The template re-fills only when the agent re-picks a different outcome (via the Back link below). Once the agent edits the textarea manually, the dirty flag is set and the workflow stops overwriting their text; clearing the textarea to empty resets the dirty flag (same pattern as the Create REIMB modal's description).
- A small `← Back` link below the textarea returns to Step 2 for re-pick.
- A primary submit button labeled:
  - **Post & Move to Done** for outcomes A/B/C/D
  - **Post (leave open)** for outcome E

The submit button:
1. Builds ADF segments from the textarea text (see "Comment ADF Building" below).
2. Calls `postComment(ticket.id, segments)`. Hard-fails on error.
3. If outcome ≠ E: calls `transitionTicket(ticket.id, '251')`. Soft-fails — surface soft warning on success panel.
4. Advances to the success state.

### Success panel — two variants

- **Outcomes A/B/C/D** (transition): "Comment posted on {ticketId} and source ticket transitioned to Done."
- **Outcome E** (no transition): "Comment posted on {ticketId}. Ticket left open for WOCOO review."

Soft-warning slot, close button, link back to source — same shell as the existing success panel.

## Comment Templates

All five templates follow this pattern (agent's verbatim style from the user-provided device-score example):

```
Hi @<reporter> after looking into the Preset dashboard doc <doc-url> <observation>. <action>.
```

**A — `MAX_TOKEN_LIMIT`**:
```
Hi @<reporter> after looking into the Preset dashboard doc <doc-url> I can see that the client has hit the maximum token limit (20 tokens). A token must be deactivated before a new one can be added. Please ask the client to deactivate an existing token first, then retry.
```

**B — `DEVICE_TOKEN_MATCH`**:
```
Hi @<reporter> after looking into the Preset dashboard doc <doc-url> I can see there's an active device token matching the client's device. I'll deactivate the matching token in i2c — please ask the client to try adding the card again.
```

**C — `NO_DECLINE`**:
```
Hi @<reporter> after looking into the Preset dashboard doc <doc-url> I don't see any decline on record. Please ask the client to try adding the card again; escalate if the issue persists.
```

**D — `DEVICE_SCORE`** (verbatim from user request):
```
Hi @<reporter> after looking into the Preset dashboard doc <doc-url> I can see that the decline is due to a device score issue. Please send the client the device score macro.
```

**E — `WOCOO_REVIEW`**:
```
Hi @<reporter> after looking into the Preset dashboard doc <doc-url> I see a decline that isn't related to device score. Cutting to WOCOO for review.
```

### Comment ADF Building

The textarea displays the literal templated string — `@<reporter name>` and the doc URL appear inline as plain text. At submit time the workflow detects them by exact substring match (`@<reporter name>` and the doc URL) and emits the appropriate ADF nodes:
1. Split the textarea text on the literal `@<reporter name>` substring (first occurrence).
2. Split each surrounding chunk on the literal doc URL substring (first occurrence).
3. Emit ADF segments in order: text → mention pill (or plain text if no `reporterAccountId`) → text → link → text.

If the agent deletes the `@<reporter name>` substring while editing, no mention pill is emitted; if they delete the doc URL, no link is emitted. The rest of the text still posts. This degrades gracefully — the agent's edits override the defaults.

## Configuration

Add to `src/data/walletTriageConfig.ts` (existing file):

```ts
export type WalletTriageOutcomeKey =
  | 'MAX_TOKEN_LIMIT'
  | 'DEVICE_TOKEN_MATCH'
  | 'NO_DECLINE'
  | 'DEVICE_SCORE'
  | 'WOCOO_REVIEW';

export interface WalletTriageOutcome {
  key: WalletTriageOutcomeKey;
  label: string;                 // card title
  subtitle: string;              // card subtitle (which chart triggered)
  /** Template body — comes after the "Hi @<reporter> after looking into the Preset dashboard doc <doc-url> " prefix. */
  bodyTemplate: string;
  /** true → transition to Done on submit; false → leave the ticket open. */
  shouldTransition: boolean;
}

export const WALLET_TRIAGE_OUTCOMES: WalletTriageOutcome[] = [
  {
    key: 'MAX_TOKEN_LIMIT',
    label: 'Max token limit hit',
    subtitle: 'Step 1 chart: distinct_token_count = 20',
    bodyTemplate:
      'I can see that the client has hit the maximum token limit (20 tokens). ' +
      'A token must be deactivated before a new one can be added. ' +
      'Please ask the client to deactivate an existing token first, then retry.',
    shouldTransition: true,
  },
  {
    key: 'DEVICE_TOKEN_MATCH',
    label: 'Active device token matches',
    subtitle: "Step 2 chart: token_device_number matches client's device",
    bodyTemplate:
      "I can see there's an active device token matching the client's device. " +
      "I'll deactivate the matching token in i2c — please ask the client to try adding the card again.",
    shouldTransition: true,
  },
  {
    key: 'NO_DECLINE',
    label: 'No decline on record',
    subtitle: 'Step 3 chart: empty / blank error_message',
    bodyTemplate:
      "I don't see any decline on record. " +
      'Please ask the client to try adding the card again; escalate if the issue persists.',
    shouldTransition: true,
  },
  {
    key: 'DEVICE_SCORE',
    label: 'Device score issue',
    subtitle: 'Step 3 chart: error_message present + scr_info_devicescore ≤ 3',
    bodyTemplate:
      'I can see that the decline is due to a device score issue. ' +
      'Please send the client the device score macro.',
    shouldTransition: true,
  },
  {
    key: 'WOCOO_REVIEW',
    label: 'Other decline — WOCOO review',
    subtitle: 'Step 3 chart: error_message present + scr_info_devicescore > 3',
    bodyTemplate:
      "I see a decline that isn't related to device score. Cutting to WOCOO for review.",
    shouldTransition: false,
  },
];

/**
 * Build the full templated comment text the textarea pre-fills with.
 * Mention text is the literal "@<name>" the workflow detects + re-emits as a mention pill;
 * doc URL is the literal URL the workflow detects + re-emits as a link.
 */
export function buildOutcomeCommentText(reporterName: string, docUrl: string, body: string): string {
  return `Hi @${reporterName} after looking into the Preset dashboard doc ${docUrl} ${body}`;
}
```

The existing `WALLET_TRIAGE_COMMENT_TEXT_AFTER_MENTION` constant is **deleted** — no UI surfaces the old "have you checked yet?" comment anymore.

## Architecture

| Path | Change |
|---|---|
| `src/data/walletTriageConfig.ts` | Add `WALLET_TRIAGE_OUTCOMES`, types, `buildOutcomeCommentText`. Delete `WALLET_TRIAGE_COMMENT_TEXT_AFTER_MENTION`. |
| `src/sidepanel/WalletTriageWorkflow.tsx` | Restructure for 3 active steps. Replace `postAndMoveToDone` with `selectOutcome` (Step 2) + `postComment` (Step 3). Add outcome state, comment-text state, dirty-flag for textarea. ADF segment building at submit time via substring split on the literal mention text and doc URL. Update `STEP_TITLES`/`STEP_SUBTITLES`/`renderStep` for the 3-step shape; update `ProgressDots` and `Header`'s "Step N of M" to 3. |
| All other files | Unchanged (`WalletTriageCard.tsx`, `walletTriageDetect.ts`, `preset.ts`, `SidePanel.tsx`). |

### Reused machinery (unchanged)

- `chrome.storage.local` key `pending_preset_identity_id` — still drives Step 1.
- `postComment` / `CommentSegment` / ADF mention nodes — same plumbing.
- `transitionTicket(ticketKey, '251')` — Done transition.
- Sticky header + ExpandedCard + FutureStub + ProgressDots — keep the QC-Fee-Waiver layout, just grow from 2 to 3 dots.

## State

In `WalletTriageWorkflow`:

```ts
const [step, setStep] = useState<StepNum>(1);          // 1 | 2 | 3 | 4 (4 = success)
const [openedBoth, setOpenedBoth] = useState(false);
const [selectedOutcome, setSelectedOutcome] = useState<WalletTriageOutcome | null>(null);
const [commentText, setCommentText] = useState<string>('');
const [commentDirty, setCommentDirty] = useState(false);
const [busy, setBusy] = useState(false);
const [error, setError] = useState<string | null>(null);
const [softWarning, setSoftWarning] = useState<string | null>(null);
```

`StepNum` becomes `1 | 2 | 3 | 4` (4 is the success state, rendered separately like QCFeeWaiver does).

Auto-template effect (Step 3): whenever `selectedOutcome` is set and the textarea isn't dirty, re-fill `commentText` with `buildOutcomeCommentText(ticket.reporter, WALLET_TRIAGE_DOC_URL, selectedOutcome.bodyTemplate)`.

Selecting a different outcome on Step 2 (via the "← Back" link from Step 3 then re-pick) resets the dirty flag and re-templates.

## Error Handling

**Hard failures:**
- Source ticket has no `identityId` → Step 1 button stays disabled (unchanged).
- Comment post fails → return to Step 3 with the error visible above the textarea; retry-able.
- ADF segment-builder split produces no segments (impossible unless agent deleted everything in the textarea) → guard: refuse to submit empty comment.

**Soft failures (after comment posted):**
- Transition fails for outcome A/B/C/D → success panel shows the soft-warning line "Comment posted, but Move-to-Done on {ticketId} failed: {err}. Close manually in Jira." (same wording as today).
- Outcome E has no transition, so no soft-warning path here.

**Edge cases:**
- Agent picks outcome, edits the comment to delete `@<reporter name>` → no mention pill in the posted comment; the rest still posts.
- Agent picks outcome, edits the comment to delete the doc URL → no link; the rest still posts.
- Agent picks outcome, deletes the entire textarea → submit button disabled until they type something OR they hit Back to re-pick.

## Testing

Manual, no automated tests.

1. **Smoke — outcome D (the user's reference case)**: Open a wallet-provisioning WOCOO ticket. Run Wallet Triage → Step 1 (open dashboard + doc) → Step 2 (5 outcome cards visible) → pick "Device score issue" → Step 3 shows the textarea pre-filled with the device-score template, including `@<reporter>` and the doc URL inline → Post & Move to Done. Verify the Jira comment has the @mention pill, the doc URL is a real link, and the source ticket transitions to Done.
2. **Smoke — outcome E (no transition)**: Walk through to Step 3, pick "Other decline — WOCOO review", submit. Verify comment posts on Jira and the source ticket **remains in its current status** (not Done). Success panel reads "Ticket left open for WOCOO review."
3. **Smoke — edit-before-post**: Pick any outcome, edit the textarea (e.g., add a sentence). Submit. Verify the posted Jira comment includes the edited text. Verify the @mention pill and doc link still resolve (because the literal `@<name>` and URL were preserved).
4. **Negative — empty textarea**: Pick any outcome, delete all text. Submit button is disabled.
5. **Re-pick path**: Pick outcome A, advance to Step 3, then click "← Back". Returns to Step 2. Pick outcome B. Step 3 re-templates with B's text (textarea isn't dirty since we never edited it).
6. **Detection regression**: Auto-detect card still appears on WOCOO-23426 and similar tickets. Card's "Start Wallet Triage" button still launches this workflow.
7. **Manual button regression**: 💳 Wallet Triage button in QuickActions row 2 still launches the workflow.

## Out of Scope

- Auto-scraping the Preset dashboard for the outcome — relies on agent's eyeballs.
- Automating the i2c token deactivation for outcome B.
- Per-outcome custom dashboard tab selection (the doc has 3 charts on one tab; agents scroll).
- Surfacing the "Cut to WOCOO for review" outcome as a Move modal trigger (could be a follow-up).
