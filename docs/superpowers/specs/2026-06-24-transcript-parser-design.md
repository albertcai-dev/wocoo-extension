# Transcript Parser (Zendesk → Summary + Key Facts)

**Date**: 2026-06-24
**Author**: Albert Cai (with Claude)
**Status**: Draft, pending implementation

## Problem

Zendesk-sourced transcripts attached to WOCOO tickets are often badly diarized — all messages appear under a single speaker label. CXA agents have to read through the wall-of-text to extract what happened. The wocoo-triage-v3 Magic site had a "Parse Transcript" tool that fed a pasted transcript into MagicAI and returned a structured summary, key facts, and diarized turns. That tool never made it into the Chrome extension. The existing `TranscriptCard` component renders mock data only — it has a dormant 4-state machine (`fetching`/`success`/`partial`/`error`) tied to an auto-capture from the Zendesk iframe that was scoped out and never landed.

This spec brings the parser into the extension, repurposing the `TranscriptCard` for a clean paste → parse → display flow.

## Goals

- Rewrite `TranscriptCard` to be a functional paste-in transcript parser with three states it manages internally (`idle` / `parsing` / `parsed`, plus an inline error variant).
- Add a `parseTranscriptViaBridge` API on the existing Apps Script bridge that returns `{ summary: string; keyFacts: string[] }`.
- Add a new `parseTranscript` GAS function (Albert pastes into the bridge's web editor) that calls MagicAI with a transcript-parsing prompt and returns JSON.
- Keep client PII inside the Wealthsimple boundary — MagicAI only, never a public-internet LLM.

## Non-Goals

- Auto-fetching the transcript from the Zendesk-for-Jira iframe. The iframe is third-party + cross-origin; v3 explicitly scoped this out and we inherit that decision.
- Diarized Agent/Client turns. v3 had these; we drop them for v1 of the extension parser to keep the UI lean and reduce LLM token spend.
- Posting the summary back as a Jira comment. Agent copies and pastes manually via Copy buttons.
- Agent-name inference. Not relevant since we're dropping turns.
- Token-by-token streaming. Single round-trip JSON response.

## Card UX

`src/components/TranscriptCard.tsx` is rewritten. The `transcript` prop is removed (it was unused beyond the mock-data placeholder). SidePanel renders `<TranscriptCard />` with no props.

Four states the card manages internally:

| State | UI |
|---|---|
| `idle` | Card header "🗒️ Parse Zendesk Transcript". Below: paste textarea (placeholder `"Paste the Zendesk transcript here…"`), char counter, soft warning shown above the button when count > 12,000 (`"Long transcript — consider splitting in half if MagicAI rejects."`). "Parse" button disabled when the textarea is empty. |
| `parsing` | Textarea locked. Button replaced by `Parsing…` label (with a small inline spinner via CSS keyframes, or just an animated `…`). |
| `parsed` | Output below the textarea: **📞 Summary** section (3–5 sentence paragraph) with a Copy button; **🔑 Key Facts** section (bulleted list of 4–7 items) with a Copy button. A "↻ Re-Parse" link below the outputs lets the agent edit the textarea and submit again — clicking it transitions back to `idle` while retaining the textarea content. |
| `error` | Inline above the Parse button: red error banner with the failure message + a "Try again" link that returns to `idle` with the textarea content intact. |

Copy buttons use `navigator.clipboard.writeText`. Summary copies as a single paragraph. Key Facts copy as `- bullet\n- bullet\n...` lines (markdown-style, pastable into Jira comments).

The 12,000-char soft warning matches v3's threshold. No hard cap — if MagicAI rejects an oversized request, the error path catches it.

## LLM call — Apps Script bridge

Extension calls a new bridge action `parseTranscript`. Bridge-side (Apps Script):

```js
// In the bridge's code.gs (Albert pastes into the GAS web editor — no clasp per
// reference_apps_script_gotchas / feedback_no_clasp).
function parseTranscript(payload) {
  if (!payload || typeof payload.text !== 'string' || !payload.text.trim()) {
    throw new Error('parseTranscript: missing text');
  }
  const prompt = buildTranscriptParserPrompt(payload.text);
  // MagicAI HTTP endpoint — confirm at implementation time. If MagicAI is not
  // HTTP-callable from Apps Script, fall back per "Open Question" below.
  const result = callMagicAI({
    prompt,
    json: true,
    temperature: 0.1,
    max_tokens: 4000,
  });
  return {
    summary: String(result.summary || ''),
    keyFacts: Array.isArray(result.key_facts) ? result.key_facts.map(String) : [],
  };
}

function buildTranscriptParserPrompt(transcript) {
  return [
    'You are parsing a customer-support transcript from Wealthsimple\'s Zendesk.',
    '',
    'The transcript may be poorly diarized (all messages may appear under one speaker).',
    'Infer turn boundaries from conversational cues. PRESERVE WORDING VERBATIM — do not',
    'paraphrase, summarize within turns, or translate.',
    '',
    'Return strict JSON in this exact shape:',
    '{',
    '  "summary": "<3-5 sentence summary of the conversation>",',
    '  "key_facts": [',
    '    "<bullet — e.g. Client name: Jane Doe>",',
    '    "<bullet — e.g. Card type: Credit (Prestige)>",',
    '    "<bullet — e.g. Merchant: Apple>",',
    '    "<bullet — e.g. Error code: scr_info_devicescore = 1.0>",',
    '    "<bullet — e.g. Action item: Send device-score macro to client>"',
    '  ]',
    '}',
    '',
    'Aim for 4-7 key facts. Prioritize: client name, card type/account, merchant or',
    'counterparty, decline reason / error codes, action items mentioned.',
    '',
    'Transcript follows:',
    '---',
    transcript,
  ].join('\n');
}
```

`callMagicAI` is the bridge's existing or new wrapper around MagicAI's HTTP endpoint — see the Open Question below for what to confirm at implementation time.

Extension-side wrapper in `src/api/bridge.ts`:

```ts
export async function parseTranscriptViaBridge(text: string): Promise<{
  summary: string;
  keyFacts: string[];
}> {
  const res = await callBridge('parseTranscript', { text }, 'transcriptParsed');
  return {
    summary: String((res as any).summary ?? ''),
    keyFacts: Array.isArray((res as any).keyFacts)
      ? (res as any).keyFacts.map((x: unknown) => String(x))
      : [],
  };
}
```

Matches the existing pattern of `readPendingWiresViaBridge`, `sendKohoEmailViaBridge`, etc.

## Open Question (resolved at implementation time)

**Is MagicAI HTTP-callable from Apps Script?** The v3 Magic-site Parse Transcript used `MagicAI.chat({json:true, ...})` — the SDK form available inside Magic-hosted pages. Calling MagicAI from GAS requires an HTTP endpoint (probably at `magic.w10e.com` or similar) that accepts GAS's `UrlFetchApp` requests, with authentication the bridge can pass through.

The implementation plan must verify this BEFORE wiring `callMagicAI`. If MagicAI has no HTTP endpoint reachable from GAS, the fallback options (decided then, not now) are:

1. **A small Magic-site proxy page** that accepts the transcript via a query param, runs MagicAI inside the page, and posts the JSON back via `chrome.storage.local` or a callback URL.
2. **A different internal LLM gateway** Wealthsimple exposes for GAS-based tools.
3. **A pre-shared MagicAI service-account token** if one exists.

The first task of the implementation plan will be a single discovery step ("does `MagicAI_HTTP_ENDPOINT_URL` exist and respond?") that decides whether we proceed with the bridge route or pause to design a proxy.

## Architecture

| Path | Change |
|---|---|
| `src/components/TranscriptCard.tsx` | Rewrite — drop the `transcript` prop and the 4-state machine. New internal states `idle` / `parsing` / `parsed` / `error`. Renders paste textarea + Parse button + Summary + Key Facts sections + Re-Parse link. |
| `src/api/bridge.ts` | Add `parseTranscriptViaBridge(text)` — wraps a new `callBridge('parseTranscript', ...)` action. |
| `src/sidepanel/SidePanel.tsx` | Update the existing `<TranscriptCard transcript={ticket.zendeskTranscript} />` render to drop the prop: `<TranscriptCard />`. |
| Apps Script bridge (web editor — no clasp) | Add `parseTranscript(payload)` function + `buildTranscriptParserPrompt(transcript)` helper + `callMagicAI(args)` wrapper (or whatever route the Open Question resolves to). Albert pastes verbatim and re-deploys the bridge. |

`WocooTicket['zendeskTranscript']` field is no longer referenced after the SidePanel edit. We leave the field on the type — it's still in mock data and might be useful for a future auto-capture feature. No deletion churn for an out-of-scope possibility.

## Reused machinery

- `callBridge` (existing in `src/api/bridge.ts`) — the canonical Apps Script JSONP/CORS wrapper used by every other bridge action.
- `navigator.clipboard.writeText` — used by the I2cCard's Copy buttons today.
- Soft warning + char counter pattern — fresh code, but trivially small.
- v3 prompt — lifted verbatim, scoped down by removing the `turns[]` instruction.

## Error handling

**Card-level**:
- **Empty textarea**: Parse button stays disabled. No error.
- **Bridge call rejects** (network, GAS error, MagicAI rejection): transition to `error` state with the failure message; preserve textarea content; "Try again" returns to `idle`.
- **Bridge returns malformed payload** (missing `summary` or `keyFacts`): transition to `error` with message `"Couldn't parse the response. Try splitting the transcript in half."`.
- **MagicAI returns non-JSON**: bridge throws → handled by the "bridge call rejects" path.

**Bridge-level**:
- **Missing `text` in payload**: GAS throws `parseTranscript: missing text` — surfaces as the bridge error in the extension.
- **MagicAI HTTP failure**: GAS catches, returns `{ error: '...' }` envelope; `callBridge` propagates as an exception to the extension's catch.

**Edge cases**:
- **Transcript with sensitive info beyond PII** (passwords, full card numbers): same as v3 — we trust the agent's judgment. No automatic redaction.
- **Transcript already cleanly diarized** (`Agent:` / `Client:` labels): MagicAI still works fine. Key facts still extract.
- **Transcript in French or another language**: prompt says "do not translate". MagicAI returns French summary + key facts. Acceptable.
- **Transcript is a single very long monologue**: MagicAI still summarizes. Quality drops naturally for short inputs without facts to extract; agent will see a thin Key Facts list.

## Testing

Manual, no automated tests.

1. **Smoke — happy path**: Open a WOCOO ticket. The TranscriptCard appears in `idle` state with the paste textarea. Paste a real Zendesk transcript (~1–4k chars). Click **Parse**. Within ~5–15 seconds (MagicAI latency), the card transitions to `parsed` with Summary + Key Facts sections. Confirm the summary is 3–5 sentences and the key facts list is 4–7 bullets covering client name / card type / merchant / error / action.
2. **Smoke — copy buttons**: Click Copy on Summary, paste into a Jira comment, confirm content. Same for Key Facts (should paste as `- bullet\n- bullet\n...`).
3. **Smoke — Re-Parse**: After a parse, click **↻ Re-Parse**. Card returns to `idle` with the textarea pre-populated. Edit the textarea (add a missing line). Click Parse again. New output appears.
4. **Soft warning**: Paste a transcript > 12,000 chars. Confirm the warning appears above the Parse button. Submit anyway — if MagicAI rejects, error banner appears; if it succeeds, output appears as normal.
5. **Empty input**: Clear the textarea. Parse button is disabled.
6. **Bridge error**: Temporarily break the bridge (point it at a dead URL via SettingsView, if possible) and click Parse. Error banner shows the failure. Click "Try again" → returns to `idle` with content intact.
7. **Regression — SidePanel render**: Confirm the side panel still renders correctly for tickets that don't open the transcript card (i.e., the card lives at its current position; nothing else moves).
8. **Regression — existing bridge actions**: Run a Wires Pending Posting pass (uses `readPendingWiresViaBridge`) and a Mobile Cheque Validation status check if available. Both should still work — the new bridge action is additive.

## Out of scope

- Auto-capture from the Zendesk-for-Jira iframe.
- Diarized turns.
- Auto-posting the summary as a Jira comment.
- Agent-name inference.
- Persisting parsed results across sessions (each ticket session re-paste + re-parse).
- A "Parse all comments on this ticket" mode (would use Jira REST `/issue/{key}/comment`; out of scope for v1).
