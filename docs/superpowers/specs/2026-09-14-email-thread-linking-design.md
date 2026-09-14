# Email thread linking — design

Date: 2026-09-14

## Problem

The extension already notices inbound replies, but only on threads it created
itself: a Koho email sent from `MessagingCards`, or an i2c form it opened. Every
other email that matters to a ticket is invisible to it. A DailyPay support
thread, a partner escalation, a conversation forwarded in by another team — all
of them live in Gmail with no connection to the WOCOO ticket they belong to, so
nothing reminds the agent that the other side has answered and is waiting.

Two gaps follow from that:

1. **No way to link an arbitrary Gmail thread to a ticket.** The reply-tracking
   sheet only gains rows as a side effect of sending a Koho email or opening an
   i2c form. There is no "this thread belongs to this ticket" action.
2. **No signal for "they replied and I haven't answered."** Today a thread only
   turns red on the transition from no-reply to new-reply. A thread where the
   agent read the reply, meant to answer, and never did looks identical to a
   finished one.

The motivating case: Gmail thread `1a0055a25a5b3bc0` ("[DailyPay] Re: DailyPay
Support Ticket #21085316") belongs to WOCOO-26316. Its last message is from
DailyPay Support on 2026-08-18 asking for verification details, and it was never
answered. Nothing in the extension says so.

## Goal

Let the agent link any Gmail thread to a WOCOO ticket by pasting its URL, and
have that thread participate in the notification machinery that already exists:
the red card on the ticket panel, the red row and mailbox badge on Home. Add a
second reason for red — the last message in a thread is not from you — and apply
it to every thread kind, not just manually linked ones.

## Non-goals

- No button inside Gmail. That needs a `mail.google.com` host permission, which
  forces every teammate to re-authorize the extension on its next update
  (the extension ID is pinned and shared). The paste flow costs nothing.
- No automatic discovery of which threads belong to which ticket. Linking is a
  deliberate act.
- No outbound reply composition. The cards link into Gmail; replying happens
  there.

## Findings that shaped the design

Three things were verified against live Gmail before designing, and each one
changed a decision:

- **The id in a Gmail permalink is not addressable.** The URL the agent copies
  looks like `#search/dailypay/FMfcgzQhVrHLjkPQTgMVgbwnKQgwJChL`. That
  `FMfcgz…` segment is the web UI's own encoding; `GmailApp.getThreadById`
  wants the hex form (`1a0055a25a5b3bc0`). There is no public conversion, so
  linking must include a resolve step that ends in a hex thread id.
- **The hex id is enough for the deeplink.** `#all/<hex>` opens the thread, so
  the `FMfcgz…` id is never worth storing. One handle covers both polling and
  linking.
- **A naive search is useless.** Searching `dailypay` returned five threads, all
  of them Jira digests that happened to mention the word, and none of them the
  DailyPay conversation. `subject:dailypay OR from:dailypay` found it. The
  resolve step therefore has to show candidates and let the query be edited,
  rather than silently taking a top hit.

One constraint, not a finding: Gmail reads must happen in the Apps Script
bridge, not through the Gmail MCP tools. MCP masks email addresses
(`iansantos1*****`), and sender identity is exactly what the unreplied check
depends on.

## Data model

`TicketReply` (`src/api/bridge.ts`) gains four fields:

| field | meaning |
|---|---|
| `kind` | widened to `'koho' \| 'i2c' \| 'email'` |
| `threadId?` | hex Gmail thread id — the durable handle for linked threads |
| `subject?` | thread subject, used to name the card |
| `awaitingMyReply?` | the last message in the thread is not from the agent |

Storage moves from one entry per ticket to a list:

```ts
// chrome.storage.local
ticket_replies:         Record<string, TicketReply[]>  // keyed by wocooTicketId
ticket_replies_archive: Record<string, TicketReply[]>  // same shape, append-only
```

A ticket can now hold a Koho thread, an i2c thread, and any number of linked
email threads at once. Within a ticket's list an entry is identified by

```ts
entryKey(r) = `${r.kind}::${r.threadId ?? r.trackKey ?? r.messageId}`
```

which is what merge and dedup operate on.

### Migration

No migration script. A `normalizeRepliesMap(raw)` helper wraps any non-array
value in a single-element array, and every read site calls it. Old
single-entry storage therefore self-heals on first read.

Rolling *back* to a previous build is not symmetric: that build reads an array
where it expects an object, finds no `messageId` or `acked`, and renders no
card. It does not crash and it does not damage storage, but the chips disappear
until the newer build is reinstalled. Acceptable, and worth knowing before a
rollback.

### Tracking sheet

`kind='email'` rows reuse the existing `trackKey` column to hold the hex thread
id, mirroring how i2c rows hold a client email there. No new sheet columns.
`subject` and `awaitingMyReply` are computed live during the poll and never
stored.

**This is an assumption, not a verified fact.** The sheet id lives in the Apps
Script project, which cannot be read through MCPLocker, so the column layout was
inferred from `bridge.ts`. Confirm the layout against the live sheet before
writing the GAS patch. If `trackKey` turns out to be constrained (validation, a
formula, a width assumption elsewhere), add a `threadId` column instead —
additive either way, per the bridge's edit constraints.

## Link flow

A `🔗 Link an email` button sits under the reply cards on the ticket panel and
opens an inline paste field.

**Parsing** (`parseGmailLink`, pure, unit-tested):

- `#inbox/<16-hex>`, `#all/<16-hex>`, or a bare 16-hex string → the thread id is
  already known; skip search entirely and resolve it directly.
- `#search/<query>/<FMfcgz…>` → seed the search box with `<query>`, decoded.
- anything else → treat the whole input as a search query.

The seeded query is always shown editable before searching, because the
`dailypay` result above proves the seed is often too broad to be useful.

**Two new GAS actions:**

- `searchEmailThreads(query, limit=8)` → candidates, each carrying `threadId`,
  `subject`, `from`, `lastFrom`, `lastDate`, `messageCount`, and the ticket id it
  is already linked to, if any.
- `linkEmailThread(wocooTicketId, threadId)` → writes the tracking row with
  `kind='email'`, `trackKey=<threadId>`, `lastSeenMsgId` set to the thread's
  current last message, and `acknowledged=TRUE`.

Setting `acknowledged=TRUE` at link time is deliberate: linking a thread you are
looking at should not manufacture a "new reply" alert. The DailyPay thread still
turns red immediately, but through `awaitingMyReply` — which is the accurate
reason. The two red causes stay independent.

The picker shows a warning, not an error, when a candidate is already linked to
another ticket, naming that ticket. Linking one thread to two tickets is
occasionally correct (a partner thread covering two cases) and never dangerous.

**Unlink is part of the feature, not a follow-up.** `unlinkEmailThread(ticketId,
threadId)` removes the row and the archive entry. The archive is deliberately
sticky — it exists so a Koho deeplink survives a poll that drops the row — which
means without an explicit unlink a misclick in the picker is permanent.

After a successful link the extension calls `markHasTrackedReplies()` so the
5-minute alarm starts polling on accounts that have never sent a Koho email.

## Poll and unreplied detection

`checkForReplies` grows two branches. Both are additive; existing Koho and i2c
behaviour is unchanged except for the new field.

**For `kind='email'` rows:**

1. `GmailApp.getThreadById(trackKey)`, then the last message.
2. New reply when `lastMessage.getId() !== lastSeenMsgId` *and* the sender is not
   the agent. A new reply writes `acknowledged=FALSE`.
3. `lastSeenMsgId` is written back on every poll, reply or not.
4. Return `subject`, `from`, `snippet` (first 200 chars), `receivedAt`, and
   `awaitingMyReply`.

**For `kind='koho'` and `kind='i2c'` rows:** the sheet stores a search key, not a
thread handle, so the thread is reached via
`GmailApp.getMessageById(lastSeenMsgId).getThread()`. A row whose `lastSeenMsgId`
is still blank has no thread to inspect, and `awaitingMyReply` stays `undefined`
— not `false`, so the UI can tell "not waiting" from "unknown".

**Identity.** "Me" is `Session.getActiveUser().getEmail()`, falling back to
`getEffectiveUser()`. Comparison is on the address inside the `From` header, not
the display name.

**Cost.** Each row now costs at least one Gmail call, inside a 5-minute alarm
that opens a bridge tab. Rows are processed newest-first and capped at 60 per
poll. Uncapped, a long-lived sheet would eventually exceed the Apps Script
execution limit and the poll would return nothing at all — worse than returning
the 60 freshest.

**Survey false positive.** Automated mail counts as inbound. The Koho flow ends
in a Kustomer satisfaction survey, so without a guard every completed Koho
ticket would go permanently red with the survey as its "unanswered" message. A
sender matching `noreply|no-reply|donotreply|survey` never sets
`awaitingMyReply`. It still counts as a new reply if it is genuinely new, which
matches today's behaviour and is what the screenshot shows.

## Rendering

`ReplyPill` becomes `ReplyPills` and maps over the ticket's list, rendering one
card per entry, ordered: new replies, then awaiting-reply, then muted.

Three card states, one of them new:

| state | appearance |
|---|---|
| unacked with a `messageId` | red — `New reply from <label>` (exists today) |
| `awaitingMyReply` | red — `Awaiting your reply — <label>` (new) |
| everything else | muted — `↗ Reopen <label>` (exists today) |

`<label>` for a linked thread is the sender's display name when there is one
(`DailyPay Support`), falling back to the subject. Koho and i2c keep their
current labels.

The deeplink for a linked thread is
`https://mail.google.com/mail/u/0/#all/<threadId>` — `#all/` rather than
`#inbox/` so an archived thread still opens.

The awaiting card has no `✕`. Dismissing it would defeat its purpose; the only
thing that clears it is actually replying, which the next poll notices.

On Home, `isUnacked(reply)` is replaced by `needsAttention(entries)`, true when
any entry is an unacked new reply or any entry is awaiting a reply. `orderRows`
is otherwise untouched and keeps sorting flagged rows first. The badge
distinguishes the two causes — 📬 for a new reply, 📮 for awaiting your reply —
and appends a count when a ticket has more than one flagged thread.

## Error handling

Every failure keeps data and degrades the UI, rather than the reverse.

- `getThreadById` returns null (thread deleted, or moved out of reach): keep the
  row, render the muted card with a "thread not found" title. Never auto-delete
  a sheet row — an unreadable thread is far more likely to be a transient Gmail
  or scope problem than a genuinely gone one.
- Search returns nothing: inline "no threads matched — edit the query", with the
  query still in the box.
- A new action missing on an older GAS deployment: `callBridge` times out, the
  caller swallows it and falls back to current behaviour. This mirrors how
  `listTrackedTickets` is already handled.
- Poll failure: unchanged. The existing handler returns the prior map rather than
  clobbering it.

## Testing

Four pure units come out of this work and each gets vitest coverage in
`src/data/emailLink.ts`:

- `parseGmailLink` — `#inbox/hex`, `#all/hex`, bare hex, `#search/q/FMfcgz…`,
  URL-encoded queries, plain text, empty, garbage.
- `normalizeRepliesMap` — old single-entry shape, new array shape, mixed, null,
  non-object.
- `mergeEntries` — poll ∪ prior ∪ archive ∪ tracked, deduped on `entryKey`,
  newest `receivedAt` wins. This logic exists today as roughly 70 untested lines
  inside `runReplyPollNow`; extracting it is a precondition for making it handle
  lists correctly, not optional cleanup.
- `needsAttention` and `isSelfSender` (including the noreply guard).

`isSelfSender` and the noreply guard are written in TypeScript for the tests and
then ported to the `.gs` patch. The two copies must stay in step; the GAS side
cannot be unit-tested locally, so the TS version is the specification.

Manual verification, end to end: link `1a0055a25a5b3bc0` to WOCOO-26316, confirm
the panel shows an `Awaiting your reply — DailyPay Support` card and Home shows
that ticket red with 📮, then reply in Gmail and confirm the next poll clears
both.

## Files

| file | change |
|---|---|
| `src/api/bridge.ts` | widen `TicketReply`; add `searchEmailThreads`, `linkEmailThread`, `unlinkEmailThread` |
| `src/background/replyPollScheduler.ts` | list-shaped map; extract `mergeEntries`; `normalizeRepliesMap` |
| `src/sidepanel/SidePanel.tsx` | `ReplyPill` → `ReplyPills`; awaiting state; link button and picker |
| `src/sidepanel/HomeView.tsx` | `needsAttention`; 📬/📮 badges with counts |
| `src/data/emailLink.ts` | new — the four pure units |
| `src/data/emailLink.test.ts` | new |
| `docs/gas-patches/2026-09-14-email-thread-linking.gs` | new — additive GAS patch |

## Open item to settle before the GAS patch

Confirm the reply-tracking sheet's column layout against the live sheet, and
whether `trackKey` can carry a hex thread id or needs a dedicated `threadId`
column. Everything else in this design is independent of the answer.
