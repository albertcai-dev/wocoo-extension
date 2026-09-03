# Ticket Knowledge Loop — Phase 2 (Retrieval) Design

**Date:** 2026-09-01
**Amended:** 2026-09-03 — folds in Jira precedent retrieval as a third source (§2b).
**Status:** Base retrieval implemented (commits `30c8d0e`..`16a4bb7`). The §2b precedent
delta has a plan at `docs/superpowers/plans/2026-09-03-jira-precedent-retrieval.md`.
**Supersedes:** `2026-07-03-ticket-knowledge-loop-phase2-retrieval.md` (Voyage embeddings + MagicAI via GAS). Do not execute that plan.
**Parent spec:** `2026-07-02-ticket-knowledge-loop-design.md`

## Goal

Replace the sidepanel's heuristic suggested-response with an AI verdict card grounded in
(a) Albert's own resolved-ticket log, (b) his Notion playbook, and (c) past Done WOCOO
tickets of the same work type. The card answers "how did I handle this kind of ticket
before, and where should this one go?"

## Non-goals

- Team-shared output. Personal-first, as in the parent spec.
- Embeddings or semantic search of any kind.
- Phase 3 novelty digest.
- Auto-acting on the verdict. The card advises; Albert clicks.

## 1. Architecture

Four participants:

- **Extension (sidepanel)** — owns retrieval orchestration, prompt construction, the LLM
  call, caching, and rendering. All prompt logic lives here so iteration is an HMR reload
  rather than a GAS redeploy.
- **Apps Script bridge** — pure data layer. Two new read-only actions. No LLM calls.
- **Jira REST** — queried directly from the extension over the existing Atlassian OAuth
  token for precedent candidates (§2b). No new auth.
- **LLM Gateway** (`llm.w10e.com`) — called directly from the extension.

The bridge cannot call the gateway: the gateway is VPN-locked and Apps Script runs on
Google's public servers. This constraint is what forced the redesign.

Flow on WOCOO ticket open:

1. Sidepanel resolves the current ticket and its `original_work_type`.
2. Cache lookup by `ticket_id + versionTag`. Hit -> render, stop.
3. Miss -> `getRecentLog(work_type)` and `getPlaybook()` via the bridge, and
   `searchPrecedent(work_type, currentKey)` against Jira, all three in parallel.
4. Join the precedent candidates against the log rows by ticket id, so a candidate Albert
   logged carries its `resolution_note` and the rest are marked intake-only.
5. Build one prompt containing the filtered log rows, the relevant playbook chunks, and
   the joined precedent candidates.
6. `POST https://llm.w10e.com/api/v2/chat/completions` with `response_format: json_object`.
7. Parse into a `TriageVerdict`, cache it, render the card.

## 2. Bridge changes

Both actions follow the existing `_handle*FromGet_` + postMessage-in-HTML pattern; direct
JSON return resolves under the GAS Run button but not through the browser bridge.

- **`getRecentLog(work_type, limit = 25)`** — reads the `Log` tab of
  `1UnCQoj_oPiJshzP65QpU0hp6-DmcLtN-6H4WLV7HbPw`. Keeps rows with a non-empty
  `resolution_note`. Scores each row against `work_type`: exact match on
  `original_work_type` = 2, substring match = 1, otherwise 0 and the row is dropped.
  Sorts by score descending then `logged_at` descending, returns the top `limit`.
- **`getPlaybook()`** — reads a new `Playbook` tab on the same spreadsheet. Columns:
  `page_id`, `page_title`, `parent_path`, `chunk_key`, `chunk_text`, `updated_at`.
  Returns all rows; filtering is the extension's job.

The `Playbook` tab is populated by a Claude-session runbook ("sync playbook") that reads
the Notion page tree under *Albert's WOCOO Ticket Playbook*
(`39241167-bd96-81d5-92b1-da6303f0b22c`) and upserts by `chunk_key`. The shared team
Notion page is not a source. No automated sync in this phase.

The `Log` tab's `embedding` and `embedded_at` columns stay unused.

## 2b. Jira precedent retrieval (amendment 2026-09-03)

The log and playbook only cover tickets Albert personally handled and wrote up. This
source adds the rest of the board's history. Retrieval is deterministic; the LLM only
ranks and summarises what it is handed.

- **Candidate query.** `searchPrecedent(workType, excludeKey)` in `api/jira.ts` runs
  `project = WOCOO AND statusCategory = Done AND issuetype = "<workType>" AND key !=
  <excludeKey> ORDER BY created DESC`, capped at 40 rows. WOCOO's "work type" *is*
  `issuetype.name` — see the mapping already relied on at `api/jira.ts:1127`. There is no
  separate work-type custom field to query.
- **Fields.** `searchTickets` does not request `description` today. It gains an optional
  `extraFields?: string[]` parameter rather than a parallel helper, so both callers keep
  one code path.
- **Outcome join.** `getRecentLog(work_type)` already returns only rows with a non-empty
  `resolution_note` for the matching work type — exactly the join population. The join is
  an in-memory match on ticket id, so it costs no extra call. A candidate with a hit
  carries `outcome: <resolution_note>`; a candidate without one is passed as
  `source: 'intake-only'`.
- **Why not keyword or LLM-authored JQL.** Both were considered. Work type plus recency
  needs no query validation and no second round trip; the accepted cost is missing
  precedent that was filed under a different work type.
- **Degradation.** A precedent-fetch failure must not fail the card. The verdict still
  renders from log plus playbook, with "precedent unavailable" noted on the card.

## 3. Extension file layout

New:

- `data/aiTriageTypes.ts` — `TriageVerdict`, `RecentLogRow`, `PlaybookChunk`,
  `PrecedentCandidate`.
- `api/llmGateway.ts` — `callLlmGateway(messages, key, opts)`. Header
  `X-LiteLLM-Dev-Key`, model `bedrock-claude-sonnet-4-6`, `response_format:
  { type: 'json_object' }`, 45s timeout via `AbortController`.
- `sidepanel/composePrompt.ts` — pure `buildTriagePrompt(...)` and
  `parseTriageVerdict(...)`. Unit-tested with Vitest; no network, no chrome APIs.
- `sidepanel/AITriageCard.tsx` — the card, including the precedent list. Each cited
  ticket renders as a Jira link with a `logged` / `intake-only` source badge.
- `sidepanel/aiTriageCache.ts` — in-memory Map plus in-flight promise map.

Modified:

- `api/bridge.ts` — `getRecentLogViaBridge`, `getPlaybookViaBridge`.
- `api/jira.ts` — new `searchPrecedent`; `searchTickets` gains `extraFields`.
- `sidepanel/SidePanel.tsx` — render `<AITriageCard>` between the `QuickActions` block
  (~line 521) and the `{/* RECENT COMMENTS (collapsed) */}` block (~line 548).
- `sidepanel/SettingsView.tsx` — LLM Gateway key field (Section 5).
- `extension/manifest.json` — add `https://llm.w10e.com/*` to `host_permissions`.

## 4. Prompt shape and the LLM call

One user message, five labelled parts: the current ticket (summary + description), the
scored log rows, the playbook chunks, a `PRECEDENT CANDIDATES` block, and the output
contract. Each candidate renders as key, summary, description, and either its outcome or
the literal `intake-only`. The instruction is to rank the candidates, keep the top 3–5,
and cite their keys verbatim. System message states the role, forbids inventing work
types outside the list it is given, and forbids citing any ticket key not in the
candidate block.

Model choice is constrained: **private VPC-hosted models only**. External models get
WS PII masking applied, which mangles client names and emails inside ticket text.

`TriageVerdict` fields: `work_type`, `confidence` (`high` | `medium` | `low`),
`rationale`, `steps` (string array), `similar_tickets`, `gotchas`.

`similar_tickets` entries are `{ key, what_happened, source }` where `source` is `logged`
or `intake-only`. The card must not present an intake-only entry as a resolution — that
text is the original request, not the outcome.

`parseTriageVerdict` validates shape and returns a parse error rather than throwing, so a
malformed response renders as an error state, not a crash. It additionally rejects any
`similar_tickets` key absent from the supplied candidate set: the model will otherwise
emit plausible-looking WOCOO keys that do not exist. An empty `similar_tickets` array is
valid and renders as "no precedent found".

## 5. Settings and first-run UX

The key lives in a new "LLM Gateway" block in `SettingsView.tsx`, mirroring the existing
username/password block: password-style input with a show/hide toggle, saved to
`chrome.storage.local` under `llmGatewayKey`.

Saving fires one cheap validation call (1 max token) against the gateway and reports
"Key works" or the failure reason. A VPN-off failure and a bad-key failure are hard to
tell apart from the browser, so the failure message names both possibilities explicitly.

When no key is stored, `AITriageCard` renders a collapsed stub reading "Add LLM Gateway
key in Settings", linking straight to Settings. The card is never hidden outright — a
hidden card makes the feature permanently invisible to its only user.

## 6. Caching and regenerate

- **Key:** `ticket_id + versionTag`, where `versionTag` is the Jira `fields.updated`
  timestamp. Editing the ticket therefore invalidates its verdict for free.
- **Store:** in-memory `Map` in `aiTriageCache.ts`, 30-minute TTL. Deliberately not
  `chrome.storage.session` or `.local`: closing the sidepanel drops the cache and the
  next open pays for a fresh call. Accepted in exchange for no persistence or eviction
  logic. Revisit if call volume proves annoying in daily use.
- **In-flight guard:** one promise per cache key, reused by concurrent callers, so
  rapid open/close cycles cannot fan out into duplicate gateway calls.
- **Regenerate:** a button on the card bypasses the cache and overwrites the entry.
  Disabled while a call is in flight.
- **Errors are never cached.** Failures render an error state with Retry. Timeout is the
  same 45s as the underlying call.

## Testing

- Vitest unit tests for `buildTriagePrompt` and `parseTriageVerdict` (well-formed,
  malformed, missing-field responses).
- Vitest unit tests for the precedent path: prompt built with 0, 1, and 40 candidates;
  `parseTriageVerdict` rejecting a key outside the candidate set; the log join matching by
  ticket id; intake-only labelling of unmatched candidates.
- Vitest unit tests for the cache: hit, expiry, invalidation on `versionTag` change,
  in-flight dedup, errors not cached.
- Bridge actions verified manually against the live sheet; scoring checked against a row
  set with exact, substring, and non-matching work types.
- End-to-end on a real WOCOO ticket, on VPN, before the card is enabled by default.
- Acceptance check for precedent: open an interest-charged-after-cutoff ticket and confirm
  `WOCOO-24990` and `WOCOO-24715` appear among the cited precedent.

## Open risks

- Playbook content is still largely `_TBD_` placeholder across the 13 work-type pages.
  Verdict quality is bounded by that until Albert fills them in.
- `getPlaybook()` returns the whole tab. If the playbook outgrows a single prompt, the
  first fix is work-type filtering in the extension, not embeddings.
- The `Playbook` tab is refreshed by hand via the sync runbook and will drift from Notion
  between runs.
- Precedent recall is bounded by work type. A ticket filed under a different issue type
  than its true procedure will not surface as precedent, and WOCOO's 37 issue types do not
  map cleanly onto triage procedures.
- Precedent freshness is bounded by the cache key, which is the *current* ticket's
  `fields.updated`. A ticket that closes during the 30-minute TTL will not appear until the
  entry expires or Regenerate is clicked.
- Outcome coverage is limited to tickets Albert logged with a `resolution_note`. Everything
  else contributes intake text only, which is weaker evidence.
