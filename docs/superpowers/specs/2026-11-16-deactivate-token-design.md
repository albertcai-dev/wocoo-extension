# Deactivate wallet token from the agent draft — design

**Status:** short design, approved by Albert 2026-11-16. Own build only (Sidekick is
still pending AppSec).

## Intent

On tickets like WOCOO-31689 the Sidekick Agent's action is "deactivate the Active Pixel 9 Pro XL
token on the client's card". Today Albert does it by hand in i2c. He wants a button on
the draft card that does what **Activate token in i2c** does: open the client in i2c, go to
Manage Card Tokens, Select the right row and fill in the form. Albert still clicks Update Status.

## Goals / non-goals / anti-goals

- Goal: one click from the draft card gets to a filled Change Status form for the named token.
- Goal: Albert's Update Status click ticks "I've done this", as with activate.
- Non-goal: clicking Update Status for him. Non-goal: deactivating several tokens in one run.
  When a ticket needs two, the agent names one and puts the other in `summary` for him to do by hand.
- **Anti-goal: ever deactivating an InActive token.** Albert activates those and never deletes
  them. The flow also never touches an already DeActivated row.

## Form values (Albert, 2026-11-16)

- New Status: the deactivate option (exact label still unconfirmed; matched by
  `/^(de-?activ(e|ate|ated)|delete)$/i`, never `InActive`/`Active`)
- Reason: **Other**
- Comments: **the WOCOO Jira ticket link**

## Approaches

1. **Generalize the activate flow into a single token flow with a mode (picked, my call).**
   `i2cTokenActivate.ts` gets an `activate | deactivate` mode that sets which rows qualify
   (InActive vs Active) and which status and reason options to pick. `tryActivateToken`
   becomes `tryTokenStatusChange`, and the storage keys and the Update Status watcher are shared.
   Login, card switching and the sidebar retry code stay single-copy.
2. A separate parallel `deactivate_token` module and content function. It doesn't touch
   activate, but it copies about 150 lines of fragile DOM-retry code that would then drift.
3. A generic "fill any i2c form" action driven by agent JSON. Too loose for an irreversible action.

## Design

- **Row match (deactivate):** match on the exact **Token ID**. Only an Active row with that ID
  qualifies. No ID, no exact match, or a non-Active status means no Select click, and a log
  line tells Albert to pick by hand. This is stricter than activate's device/created narrowing,
  because two rows here are both "Pixel 9 Pro".
- **Agent:** `draft.md` adds `deactivate_token`, with
  `token: {card_last4, token_id, device, created}`. It's only for an Active token the
  client agreed to remove, never for InActive or DeActivated ones. `navigation.md` keeps
  i2c read-only for the agent.
- **Side panel:** the button label is "Deactivate token in i2c".
  `openI2cTokenFlow(ticket, token, mode)` replaces `openI2cActivateToken` and sets
  `pending_i2c_flow = 'deactivate_token'`. The content script's account-row and card picking
  apply to both flows.
- **Tests:** unit tests for the Active-only, exact-ID row pick (including refusing InActive and
  two "Pixel 9 Pro" rows), the option regexes and `parseTokenTarget` with `token_id`. Then a
  live run on WOCOO-31689, stopping before Update Status.

## Left to the builder

- The exact i2c label for the deactivate status option and the Reason list. Confirm them on the
  live form during the WOCOO-31689 run and tighten the regexes.
