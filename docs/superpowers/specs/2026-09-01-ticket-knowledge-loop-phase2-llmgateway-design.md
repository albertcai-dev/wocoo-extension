# Ticket Knowledge Loop — Phase 2 (Retrieval) Design

**Date:** 2026-09-01
**Status:** Approved design, no implementation plan yet
**Supersedes:** `2026-07-03-ticket-knowledge-loop-phase2-retrieval.md` (Voyage embeddings + MagicAI via GAS). Do not execute that plan.
**Parent spec:** `2026-07-02-ticket-knowledge-loop-design.md`

## Goal

Replace the sidepanel's heuristic suggested-response with an AI verdict card grounded in
(a) Albert's own resolved-ticket log and (b) his Notion playbook. The card answers
"how did I handle this kind of ticket before, and where should this one go?"

## Non-goals

- Team-shared output. Personal-first, as in the parent spec.
- Embeddings or semantic search of any kind.
- Phase 3 novelty digest.
- Auto-acting on the verdict. The card advises; Albert clicks.

## 1. Architecture

Three participants:

- **Extension (sidepanel)** — owns retrieval orchestration, prompt construction, the LLM
  call, caching, and rendering. All prompt logic lives here so iteration is an HMR reload
  rather than a GAS redeploy.
- **Apps Script bridge** — pure data layer. Two new read-only actions. No LLM calls.
- **LLM Gateway** (`llm.w10e.com`) — called directly from the extension.

The bridge cannot call the gateway: the gateway is VPN-locked and Apps Script runs on
Google's public servers. This constraint is what forced the redesign.

Flow on WOCOO ticket open:

1. Sidepanel resolves the current ticket and its `original_work_type`.
2. Cache lookup by `ticket_id + versionTag`. Hit -> render, stop.
3. Miss -> `getRecentLog(work_type)` and `getPlaybook()` in parallel via the bridge.
4. Build one prompt containing the filtered log rows plus the relevant playbook chunks.
5. `POST https://llm.w10e.com/api/v2/chat/completions` with `response_format: json_object`.
6. Parse into a `TriageVerdict`, cache it, render the card.

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

## 3. Extension file layout

New:

- `data/aiTriageTypes.ts` — `TriageVerdict`, `RecentLogRow`, `PlaybookChunk`.
- `api/llmGateway.ts` — `callLlmGateway(messages, key, opts)`. Header
  `X-LiteLLM-Dev-Key`, model `bedrock-claude-sonnet-4-6`, `response_format:
  { type: 'json_object' }`, 45s timeout via `AbortController`.
- `sidepanel/composePrompt.ts` — pure `buildTriagePrompt(...)` and
  `parseTriageVerdict(...)`. Unit-tested with Vitest; no network, no chrome APIs.
- `sidepanel/AITriageCard.tsx` — the card.
- `sidepanel/aiTriageCache.ts` — in-memory Map plus in-flight promise map.

Modified:

- `api/bridge.ts` — `getRecentLogViaBridge`, `getPlaybookViaBridge`.
- `sidepanel/SidePanel.tsx` — render `<AITriageCard>` between the `QuickActions` block
  (~line 521) and the `{/* RECENT COMMENTS (collapsed) */}` block (~line 548).
- `sidepanel/SettingsView.tsx` — LLM Gateway key field (Section 5).
- `extension/manifest.json` — add `https://llm.w10e.com/*` to `host_permissions`.

## 4. Prompt shape and the LLM call

One user message, four labelled parts: the current ticket (summary + description), the
scored log rows, the playbook chunks, and the output contract. System message states the
role and forbids inventing work types outside the list it is given.

Model choice is constrained: **private VPC-hosted models only**. External models get
WS PII masking applied, which mangles client names and emails inside ticket text.

`TriageVerdict` fields: `work_type`, `confidence` (`high` | `medium` | `low`),
`rationale`, `steps` (string array), `similar_tickets` (ticket id + one-line what-happened),
`gotchas`. `parseTriageVerdict` validates shape and returns a parse error rather than
throwing, so a malformed response renders as an error state, not a crash.

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
- Vitest unit tests for the cache: hit, expiry, invalidation on `versionTag` change,
  in-flight dedup, errors not cached.
- Bridge actions verified manually against the live sheet; scoring checked against a row
  set with exact, substring, and non-matching work types.
- End-to-end on a real WOCOO ticket, on VPN, before the card is enabled by default.

## Open risks

- Playbook content is still largely `_TBD_` placeholder across the 13 work-type pages.
  Verdict quality is bounded by that until Albert fills them in.
- `getPlaybook()` returns the whole tab. If the playbook outgrows a single prompt, the
  first fix is work-type filtering in the extension, not embeddings.
- The `Playbook` tab is refreshed by hand via the sync runbook and will drift from Notion
  between runs.
