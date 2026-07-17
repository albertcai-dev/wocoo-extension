# Visa Companion Recommender

**Date**: 2026-06-24
**Author**: Albert Cai (with Claude)
**Status**: Draft, pending implementation

## Problem

A recurring class of WOCOO tickets is "client can't register for Visa Airport Companion" (canonical example: WOCOO-23600; resolved example: WOCOO-22531). The CXA reply is always the same boilerplate — direct the reporter to a specific Guru card + Google doc, mention the Visa Infinite Concierge phone number, explain that Visa-managed benefits are outside Wealthsimple's visibility. After posting, the source ticket gets moved to Done.

Today the agent reads the ticket, copies the boilerplate from a previous reply (often WOCOO-22531), edits the @reporter mention, and clicks through Jira's transition UI. The whole flow is one button's worth of work.

## Goals

- Auto-detect Visa Airport Companion tickets (signals: `visa companion`, `airport companion`, `visa airport companion`).
- Render a recommendation card with a single button that, in one click, (a) posts a templated comment @mentioning the current ticket's reporter and embedding the Guru + doc links + concierge phone, and (b) transitions the source WOCOO ticket to Done.
- Soft-fail the transition (warn but show success) if Jira rejects the Done transition.
- Hide the card when there's no reporter to mention.

## Non-Goals

- Editing the comment before posting. One-click; no preview/edit dance.
- Detecting broader Visa Infinite benefit issues (Concierge, Priority Pass, Lounge Access, etc.). Scoped narrowly to Airport Companion per the user choice in brainstorming.
- A multi-step workflow shell (like Wallet Triage / QC Fee Waiver). The action is one bridge-less call; a workflow file would be overkill.
- Configurable URLs / phone number via UI. Edits go in `visaCompanionConfig.ts`; code change.
- Cards for other "post canned reply and close" patterns. This spec ships only the Visa Companion one; future similar cards can follow the same pattern.

## Detection

New file `src/data/visaCompanionDetect.ts`. Mirrors the `credRouteDetect.ts` / `walletTriageDetect.ts` shape.

```ts
export interface VisaCompanionDetection {
  matched: boolean;
  reasons: string[];
}

const SIGNALS = [
  'visa companion',
  'airport companion',
  'visa airport companion',
];

export function detectVisaCompanion(
  summary: string,
  description: string,
  _workType: string | null | undefined,
): VisaCompanionDetection { ... }
```

Match against `summary + '\n' + description`, lowercased. `matched = signals.length > 0`. No veto list — the phrases are specific enough that false positives are very unlikely.

The detector accepts `workType` for shape consistency with the other detectors, but doesn't use it.

## Card UX

New file `src/sidepanel/VisaCompanionCard.tsx`. Unlike the other recommendation cards (which delegate to a workflow's start callback), this card owns its action end-to-end — no separate workflow file. The card manages a small state machine.

| State | UI |
|---|---|
| `idle` | Title "🛫 Looks like a Visa Companion / Airport Companion ticket". Matched-reasons line below the title. A faint quote box showing a preview of the comment that will be posted (with the @reporter rendered as a highlighted pill). Single primary button: **Send concierge reply & Move to Done**. |
| `posting` | Button disabled, label `Posting & moving…`. |
| `done` | Card transforms into a success state: ✓ banner + "Posted on {ticket.id} and moved to Done." with an optional soft-warning slot if the Done transition failed. No retry option (the agent moves on to the next ticket). |
| `error` | Inline error banner above the button: `⚠ {err}`. Retry link returns to `idle` so the button is clickable again. |

The card is hidden when:
- `!ticket.reporter` (no one to mention — soft requirement; without it the comment reads "Hi @team").
- Detector doesn't match.

The reporter check is stricter than the other cards' `clientEmail` gate — for the other workflows the agent could still proceed; here the @mention IS the point of the comment, so we hide the affordance rather than post a degraded comment.

## Comment template

The comment is constructed as ADF segments by the card (matches the pattern from Wallet Triage / Create REIMB).

Plain-text rendering (with the mention pill and link styling intact in Jira):

```
Hi @<reporter> , We can follow this guru and this document. If its resolved using
these documents then we can always direct the client to Visa Infinite Concierge:
1-855-822-1240.

For benefits enabled through Visa directly, those are managed on Visas end so
unfortunately we don't have visibility into eligibility for that program.

The best people to assist would be the Visa Concierge team.
```

(`guru` and `document` are clickable links — see ADF segments below.)

ADF segments (passed to `postComment(ticket.id, segments)`):

```ts
const segments: CommentSegment[] = [
  { type: 'text', text: 'Hi ' },
  // @mention pill, OR plain text fallback if no reporterAccountId
  reporterAccountId
    ? { type: 'mention', text: '@' + reporterName, accountId: reporterAccountId }
    : { type: 'text', text: '@' + reporterName },
  { type: 'text', text: ' , We can follow this ' },
  { type: 'link', text: 'guru', href: VISA_COMPANION_GURU_URL },
  { type: 'text', text: ' and this ' },
  { type: 'link', text: 'document', href: VISA_COMPANION_DOC_URL },
  { type: 'text', text: `. If its resolved using these documents then we can always direct the client to Visa Infinite Concierge: ${VISA_COMPANION_CONCIERGE_PHONE}.\n\nFor benefits enabled through Visa directly, those are managed on Visas end so unfortunately we don't have visibility into eligibility for that program.\n\nThe best people to assist would be the Visa Concierge team.` },
];
```

`\n\n` paragraph breaks survive through Jira's ADF renderer as visible blank-line gaps (confirmed earlier via REIMB-42740's description rendering).

## Action sequence

When the agent clicks **Send concierge reply & Move to Done**, the card runs (in `posting` state):

1. Build the ADF segments above.
2. `await postComment(ticket.id, segments)` — existing helper in `src/api/jira.ts`. Hard-fail: if this rejects, transition to `error` state with the message, do NOT attempt the Done transition.
3. `await transitionTicket(ticket.id, '251')` — soft-fail. If this rejects, transition to `done` state but pass a `softWarning` string with the error.
4. On success, transition to `done` state with `softWarning = null`.

The flow mirrors the merged "Post comment & Move to Done" step from OverpaymentTriage and Wallet Triage's decision-tree submit.

## Configuration

New file `src/data/visaCompanionConfig.ts`:

```ts
// Visa Companion / Airport Companion reply constants. Edit here to update the
// guru/doc URLs or the concierge phone without touching the card component.

export const VISA_COMPANION_GURU_URL =
  'https://app.getguru.com/card/idGo6pdT/Wealthsimple-Visa-Infinite-Privilege-credit-card-benefits';

export const VISA_COMPANION_DOC_URL =
  'https://docs.google.com/document/d/1K9huSHGOCkScKj22F5aMBdtJYisixnJmXyIj9vAPVP4/edit?tab=t.0';

export const VISA_COMPANION_CONCIERGE_PHONE = '1-855-822-1240';
```

The card imports all three. Future edits — phone-number change, new doc URL — touch one file.

## Architecture

| Path | New? | Responsibility |
|---|---|---|
| `src/data/visaCompanionDetect.ts` | new | `detectVisaCompanion(summary, description, workType): VisaCompanionDetection`. |
| `src/data/visaCompanionConfig.ts` | new | Guru URL, doc URL, concierge phone constants. |
| `src/sidepanel/VisaCompanionCard.tsx` | new | Self-contained card with `idle` / `posting` / `done` / `error` state. Calls `postComment` + `transitionTicket` inline. |
| `src/sidepanel/SidePanel.tsx` | modify | Mount `<VisaCompanionCard ticket={ticket} onTicketUpdate={onTicketUpdate} />` at the bottom of the recommendation-card stack, after `WalletTriageCard`. It's the most specific-action card (single canned reply); broader workflow cards take priority when both match. |

`SidePanel.tsx` already has `onTicketUpdate` in `TicketViewInner` scope — passed in from `TicketView`. The card calls it with the updated `status: 'Done'` ticket after a successful transition (matches what other workflows do).

## Reused machinery

- `CommentSegment` / `postComment` from `src/api/jira.ts` — existing ADF comment builder.
- `transitionTicket(ticketKey, '251')` — Done transition.
- The recommendation-card styling pattern from `WalletTriageCard.tsx` / the three workflow cards — copied verbatim into `VisaCompanionCard.tsx` for the card shell. (No shared style file yet; YAGNI for one more card.)

## Error Handling

**Hard failures** (abort, no side effect on Jira):
- `!ticket.reporter` → card hidden.
- `postComment` rejects → card returns to `error` state with the message + Retry link.
- Detector throws (shouldn't happen — pure substring code) → React error boundary upstream handles it.

**Soft failures** (comment posted, secondary action failed):
- `transitionTicket` rejects after `postComment` succeeded → success panel shows + warning string: "Comment posted on {ticket.id}, but Move-to-Done failed: {err}. Close the ticket manually in Jira."

**Edge cases:**
- **`reporter` present but `reporterAccountId` missing**: comment posts with plain-text `@<name>` instead of a real mention pill. Reader still sees the name, no Jira notification. Acceptable — matches the fallback we use in Wallet Triage / Create REIMB.
- **Source ticket is already Done**: `transitionTicket` will likely no-op or 400. Soft-failure path covers it; success panel shows + warning.
- **Detector matches but the ticket is not actually Visa Companion (false positive)**: agent ignores the card. Card is suggestive, not blocking.
- **Agent clicks the button twice rapidly**: button is disabled in `posting` state; the second click is dropped.

## Testing

Manual, no automated tests.

1. **Smoke — happy path**: Open WOCOO-23600 (or a similar Visa Companion ticket). Above QuickActions, confirm the **🛫 Looks like a Visa Companion / Airport Companion ticket** card appears with the comment preview showing `Hi @<reporter> ...`. Click **Send concierge reply & Move to Done**. Within ~2 seconds: card transitions to `done` ("Posted on WOCOO-23600 and moved to Done."). Open Jira and verify: comment posted with @mention pill, `guru` and `document` as clickable links, phone number `1-855-822-1240` inline, source ticket in Done status.
2. **Smoke — soft warning path**: Pre-transition the source ticket to Done manually in Jira, THEN click the card's button. Confirm comment still posts; success panel shows the warning line about the transition failure.
3. **Negative — no reporter**: Find/simulate a ticket with no reporter. Confirm the card is hidden.
4. **Negative — unrelated ticket**: Open a wallet-provisioning ticket. Confirm the Visa Companion card does NOT appear.
5. **Mutual coexistence**: Open a Visa Companion ticket that also matches another card (e.g., contains "credit card" topic that would fire OverpaymentTriageCard). Confirm both cards render; agent picks the right one. (Order: QCAutoReimb → OverpaymentTriage → ReverseFee → QCFeeWaiver → CredRoute → WalletTriage → VisaCompanion — the new card goes after WalletTriage at the bottom of the stack, since it's the most specific-action card.)
6. **Regression — existing recommendation cards**: CredRouteCard, QCAutoReimbCard, WalletTriageCard, OverpaymentTriageCard, ReverseFeeCard, QCFeeWaiverCard all still fire on their respective tickets.

## Out of scope

- Other Visa-benefit cards (Concierge-specific, Priority Pass, etc.). Future similar canned-reply cards can be added by copying this pattern.
- Pre-submit preview editing.
- Saving outcomes for analytics ("agents used this card N times this week").
- Bulk-send (apply to all matching tickets at once).
- A settings UI to enable/disable the card per agent.
