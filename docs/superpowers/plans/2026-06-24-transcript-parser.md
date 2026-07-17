# Transcript Parser — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite the dormant `TranscriptCard` into a working paste-in transcript parser that sends Zendesk-sourced transcripts through the Apps Script bridge to MagicAI and renders a Summary + Key Facts response.

**Architecture:** A new `parseTranscript` Apps Script function (pasted into the bridge's web editor — no clasp per repo conventions) calls MagicAI via HTTP and returns `{ summary, key_facts }`. Extension-side, `parseTranscriptViaBridge` wraps the existing `callBridge('parseTranscript', ...)` iframe transport. `TranscriptCard.tsx` is fully rewritten to manage its own `idle` / `parsing` / `parsed` / `error` state, with a paste textarea, Parse button, and two output sections each with a Copy button.

**Tech Stack:** TypeScript, React, Vite, Chrome MV3 extension. Apps Script (Google Apps Script V8 runtime) for the bridge function. MagicAI HTTP endpoint (confirmed in Task 1 Step 1).

## Global Constraints

- **No automated tests.** Each task ends with `npm run build` (from `~/projects/wocoo-extension/extension/`) + a documented manual verification step.
- **Not a git repository.** Skip every "commit" step. Tasks complete when manual verification passes.
- **Apps Script edits via the web editor only.** Per `reference_apps_script_gotchas` / `feedback_no_clasp` — do not propose `clasp` commands. Albert pastes the GAS function manually and re-deploys from the web editor.
- **Bridge transport uses GET with URL query string.** Per `callBridge`'s existing iframe pattern (`src/api/bridge.ts:128`). URL length is the practical payload ceiling. The 12,000-char soft warning in `TranscriptCard` keeps transcripts well under typical URL limits.
- **PII stays inside Wealthsimple.** MagicAI only — never a public-internet LLM. This is enforced by the choice of LLM endpoint, not by code.
- **Do not regress existing flows.** OverpaymentTriage, Wallet Triage, Wires Pending Posting, Mobile Cheque Validation status calls, Create REIMB, Move modal — all must work exactly as today. The new `parseTranscript` bridge action is additive.
- **Reload the unpacked extension** in `chrome://extensions` after every build before manual verification. Re-deploy the Apps Script bridge after editing the GAS function (it caches at deploy time — see `reference_apps_script_gotchas`).

---

## File Structure

| Path | Change |
|---|---|
| Apps Script bridge (web editor, not a file under `extension/`) | Add `parseTranscript(payload)` + `buildTranscriptParserPrompt(transcript)` + `callMagicAI(args)`. Wire `parseTranscript` into the existing `doGet`/`doPost` dispatcher's switch on `action`. Re-deploy. |
| `src/api/bridge.ts` | Add `parseTranscriptViaBridge(text: string): Promise<{ summary: string; keyFacts: string[] }>` that wraps `callBridge('parseTranscript', { text }, 'transcriptParsed')`. |
| `src/components/TranscriptCard.tsx` | Full rewrite. Drop the `transcript` prop and the 4-state machine (`fetching`/`success`/`partial`/`error`). New internal states `idle` / `parsing` / `parsed` / `error`. Renders paste textarea + char counter + soft warning + Parse button + Summary + Key Facts sections + Re-Parse link. |
| `src/sidepanel/SidePanel.tsx` | Update `<TranscriptCard transcript={ticket.zendeskTranscript} />` to `<TranscriptCard />`. |

`WocooTicket['zendeskTranscript']` field is left in place — still used by mock data; harmless.

---

## Task 1: Verify MagicAI HTTP-callability + add `parseTranscript` to the Apps Script bridge

**Files:**
- Modify (in the GAS web editor): the existing bridge `code.gs`. No file in this repo to edit.

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: a new bridge action `parseTranscript` that accepts `{ text: string }` and returns `{ summary: string, keyFacts: string[] }` via the standard `postMessage({ action: 'transcriptParsed', ... })` reply convention.

This task has a blocking discovery step. If Step 1 fails, STOP and re-plan — the rest of the steps assume MagicAI is HTTP-callable from Apps Script. The spec's "Open Question" calls out the fallbacks if needed (Magic-site proxy, alternative internal LLM, service-account token).

- [ ] **Step 1: Verify MagicAI HTTP endpoint.** In the existing bridge's Apps Script web editor, open a fresh script tab and paste this probe function:

```js
function probeMagicAI() {
  // Replace with the actual MagicAI HTTP endpoint URL.
  const url = 'PASTE_MAGIC_AI_URL_HERE';
  const headers = {
    // Whatever auth MagicAI needs. Service-account token, OAuth bearer, etc.
    // If none required (intra-network), leave empty.
  };
  try {
    const resp = UrlFetchApp.fetch(url, {
      method: 'POST',
      contentType: 'application/json',
      headers: headers,
      payload: JSON.stringify({
        prompt: 'Reply with the literal string "pong" only.',
        max_tokens: 16,
      }),
      muteHttpExceptions: true,
    });
    Logger.log('status: ' + resp.getResponseCode());
    Logger.log('body: ' + resp.getContentText());
  } catch (e) {
    Logger.log('threw: ' + e);
  }
}
```

Click Run, check the logs (`View → Executions` or the inline log panel). Expected: 200 status + a response body containing "pong" (or similar). If the call fails or 404s, MagicAI is not HTTP-callable from GAS via the URL/auth we guessed — STOP and tell the user; the plan needs to switch to a Magic-site proxy or alternative endpoint per the spec's Open Question. Otherwise, **record the exact URL + auth header shape** that worked — they go into the real `parseTranscript` function in Step 3.

- [ ] **Step 2: Add the prompt builder.** In the bridge's main `code.gs` tab, add at the bottom (or near other helpers) verbatim:

```js
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

- [ ] **Step 3: Add the MagicAI wrapper using the URL + auth from Step 1.** Replace the `'PASTE_…'` placeholders with the actual values you recorded:

```js
function callMagicAI(args) {
  // args = { prompt: string, json?: boolean, temperature?: number, max_tokens?: number }
  const url = 'PASTE_MAGIC_AI_URL_HERE_FROM_STEP_1';
  const headers = {
    // From Step 1. e.g. { 'Authorization': 'Bearer ' + PropertiesService.getScriptProperties().getProperty('MAGIC_AI_TOKEN') }
  };
  const resp = UrlFetchApp.fetch(url, {
    method: 'POST',
    contentType: 'application/json',
    headers: headers,
    payload: JSON.stringify({
      prompt: args.prompt,
      json: args.json === true,
      temperature: args.temperature != null ? args.temperature : 0.1,
      max_tokens: args.max_tokens != null ? args.max_tokens : 4000,
    }),
    muteHttpExceptions: true,
  });
  const code = resp.getResponseCode();
  const text = resp.getContentText();
  if (code < 200 || code >= 300) {
    throw new Error('MagicAI HTTP ' + code + ': ' + text);
  }
  // MagicAI is expected to return a JSON envelope; adjust the field extraction
  // here based on what Step 1's probe actually showed. Common shapes:
  //   { content: "<json string>" }
  //   { choices: [{ message: { content: "<json string>" } }] }   (OpenAI-like)
  //   { result: { json: { ... parsed already ... } } }
  // The function below assumes a content-as-JSON-string shape; if MagicAI
  // already returns parsed JSON, simplify the parse step.
  var raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error('MagicAI returned non-JSON envelope: ' + text.slice(0, 200));
  }
  var contentStr = raw.content || (raw.choices && raw.choices[0] && raw.choices[0].message && raw.choices[0].message.content) || raw;
  if (typeof contentStr === 'object') return contentStr;
  try {
    return JSON.parse(contentStr);
  } catch (e) {
    throw new Error('MagicAI content was not JSON-parseable: ' + String(contentStr).slice(0, 200));
  }
}
```

If MagicAI's actual response shape differs from the common cases above, adjust the `contentStr` extraction. Print one real response from Step 1's probe and pattern-match.

- [ ] **Step 4: Add the `parseTranscript` action function.** At the bottom (or near other `*Via*` bridge actions) paste:

```js
function parseTranscript(payload) {
  if (!payload || typeof payload.text !== 'string' || !payload.text.trim()) {
    throw new Error('parseTranscript: missing text');
  }
  var prompt = buildTranscriptParserPrompt(payload.text);
  var result = callMagicAI({
    prompt: prompt,
    json: true,
    temperature: 0.1,
    max_tokens: 4000,
  });
  return {
    summary: String(result.summary || ''),
    keyFacts: Array.isArray(result.key_facts) ? result.key_facts.map(String) : [],
  };
}
```

- [ ] **Step 5: Wire `parseTranscript` into the bridge's dispatcher.** Find the existing `doGet(e)` (or `doPost(e)`) function — it has a `switch` (or `if/else`) on `e.parameter.action`. Add a new case:

```js
  // ... existing cases ...
  case 'parseTranscript': {
    var result = parseTranscript({ text: e.parameter.text || '' });
    return postReplyToParent('transcriptParsed', result);
  }
```

Use the same `postReplyToParent` (or equivalent) helper the other actions use — the one that builds the HTML page with `window.parent.postMessage(...)`. The reply action name MUST be `'transcriptParsed'` to match `expectedReply` in the extension's `callBridge` call.

If the existing dispatcher uses an `if/else if` chain instead of `switch`, add an equivalent branch.

- [ ] **Step 6: Re-deploy.** In the GAS web editor: **Deploy → Manage deployments** → edit the existing Web App deployment → **New version** → Deploy. Take note of the deployment URL (should match what the extension's `BRIDGE_URL` constant already points to). Per `reference_apps_script_gotchas`, the deploy CACHES at deploy time — a re-deploy is required for changes to take effect.

- [ ] **Step 7: Smoke-test the bridge action from inside GAS.** In the web editor, add a temporary test function:

```js
function testParseTranscript() {
  var sample = 'Hi, I\'m calling because I can\'t add my credit card to Apple Pay. My identity ID is identity-test. Got an error about Visa Provisioning Service.';
  var result = parseTranscript({ text: sample });
  Logger.log(JSON.stringify(result, null, 2));
}
```

Click Run. Expected: logs show a JSON object with `summary` (3–5 sentences) and `keyFacts` (4–7 bullets). If MagicAI returns an unexpected shape, fix `callMagicAI`'s content extraction (Step 3 has the placeholder comment) and re-run.

When this passes, delete the `testParseTranscript` function (or leave it — it's harmless).

---

## Task 2: Extension-side — bridge wrapper + TranscriptCard rewrite + SidePanel prop drop

**Files:**
- Modify: `src/api/bridge.ts` (add `parseTranscriptViaBridge`)
- Rewrite: `src/components/TranscriptCard.tsx` (full file replacement)
- Modify: `src/sidepanel/SidePanel.tsx` (drop the `transcript` prop on `<TranscriptCard />`)

**Interfaces:**
- Consumes: Task 1's `parseTranscript` bridge action.
- Produces: `parseTranscriptViaBridge(text: string): Promise<{ summary: string; keyFacts: string[] }>` (no other exports from `bridge.ts` — `TranscriptCard` is imported directly by `SidePanel.tsx` via its existing `import` statement).

- [ ] **Step 1: Add `parseTranscriptViaBridge` to `src/api/bridge.ts`.** Open the file and find the end of the existing exports (around the bottom, after `markMobileChequeValidationSentViaBridge`). Append:

```ts
/**
 * Parse a pasted Zendesk transcript via the Apps Script bridge → MagicAI.
 * Returns a 3–5 sentence summary + 4–7 bulleted key facts.
 */
export async function parseTranscriptViaBridge(text: string): Promise<{ summary: string; keyFacts: string[] }> {
  const res = await callBridge('parseTranscript', { text }, 'transcriptParsed');
  return {
    summary: String((res as any).summary ?? ''),
    keyFacts: Array.isArray((res as any).keyFacts)
      ? (res as any).keyFacts.map((x: unknown) => String(x))
      : [],
  };
}
```

- [ ] **Step 2: Replace the entire contents of `src/components/TranscriptCard.tsx`** with this rewrite. (The old 4-state machine and `transcript` prop are dropped.)

```tsx
// Transcript Parser card. Paste a Zendesk-sourced transcript, click Parse,
// get back a Summary + Key Facts via the Apps Script bridge → MagicAI route.

import { useState } from 'react';
import { parseTranscriptViaBridge } from '../api/bridge';

type CardState = 'idle' | 'parsing' | 'parsed' | 'error';

const LONG_TRANSCRIPT_THRESHOLD = 12_000;

export function TranscriptCard() {
  const [state, setState] = useState<CardState>('idle');
  const [text, setText] = useState<string>('');
  const [summary, setSummary] = useState<string>('');
  const [keyFacts, setKeyFacts] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function onParse() {
    if (!text.trim()) return;
    setState('parsing');
    setError(null);
    try {
      const result = await parseTranscriptViaBridge(text);
      if (!result.summary && result.keyFacts.length === 0) {
        throw new Error('Couldn\'t parse the response. Try splitting the transcript in half.');
      }
      setSummary(result.summary);
      setKeyFacts(result.keyFacts);
      setState('parsed');
    } catch (e: any) {
      setError(e?.message || String(e));
      setState('error');
    }
  }

  function onReParse() {
    setState('idle');
    setSummary('');
    setKeyFacts([]);
    setError(null);
  }

  function onTryAgain() {
    setState('idle');
    setError(null);
  }

  const charCount = text.length;
  const tooLong = charCount > LONG_TRANSCRIPT_THRESHOLD;
  const parseDisabled = !text.trim() || state === 'parsing';

  return (
    <section style={cardBaseStyle}>
      <header style={cardHeaderStyle}>
        <span style={cardTitleStyle}>🗒️ Parse Zendesk Transcript</span>
        {state === 'parsed' ? (
          <button onClick={onReParse} style={textLinkStyle}>↻ Re-Parse</button>
        ) : null}
      </header>

      <div style={{ padding: 'var(--mint-sp-3)', display: 'flex', flexDirection: 'column', gap: 'var(--mint-sp-2)' }}>
        <textarea
          placeholder="Paste the Zendesk transcript here..."
          value={text}
          disabled={state === 'parsing'}
          onChange={(e) => setText(e.target.value)}
          rows={6}
          style={textareaStyle}
        />
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--mint-text-nano)', color: 'var(--mint-fg-soft)' }}>
          <span>{charCount.toLocaleString()} chars</span>
          {tooLong ? <span style={{ color: 'var(--mint-warning-fg-strong)' }}>Long transcript — consider splitting in half if MagicAI rejects.</span> : null}
        </div>

        {state === 'error' && error ? (
          <div style={errorBannerStyle}>
            <span>⚠ {error}</span>
            <button onClick={onTryAgain} style={textLinkStyle}>Try again</button>
          </div>
        ) : null}

        <button onClick={onParse} disabled={parseDisabled} style={{ ...primaryButtonStyle, opacity: parseDisabled ? 0.55 : 1, cursor: parseDisabled ? 'not-allowed' : 'pointer' }}>
          {state === 'parsing' ? 'Parsing…' : 'Parse'}
        </button>

        {state === 'parsed' ? (
          <>
            <OutputSection title="📞 Summary" content={summary} />
            <OutputSection title="🔑 Key Facts" content={keyFacts.length ? keyFacts.map((f) => '- ' + f).join('\n') : '(no key facts extracted)'} />
          </>
        ) : null}
      </div>
    </section>
  );
}

function OutputSection({ title, content }: { title: string; content: string }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    if (!content || !navigator.clipboard) return;
    navigator.clipboard.writeText(content).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  }
  return (
    <div style={outputSectionStyle}>
      <div style={outputHeaderStyle}>
        <span style={{ fontWeight: 700, fontSize: 'var(--mint-text-meta)', color: 'var(--mint-fg-strong)' }}>{title}</span>
        <button onClick={copy} disabled={copied} style={copyPillStyle(copied)}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre style={outputContentStyle}>{content}</pre>
    </div>
  );
}

// ===== styles =====

const cardBaseStyle: React.CSSProperties = {
  background: 'var(--mint-bg-card)',
  border: 'var(--mint-card-stroke)',
  borderRadius: 'var(--mint-radius-card)',
  overflow: 'hidden',
  boxShadow: 'var(--mint-card-shadow)',
};

const cardHeaderStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '8px var(--mint-sp-3)',
  background: 'var(--mint-bg-subtle)',
  borderBottom: 'var(--mint-card-stroke)',
};

const cardTitleStyle: React.CSSProperties = {
  fontWeight: 700,
  fontSize: 'var(--mint-text-meta)',
  color: 'var(--mint-fg-strong)',
};

const textareaStyle: React.CSSProperties = {
  width: '100%',
  padding: 'var(--mint-sp-2)',
  border: 'var(--mint-card-stroke)',
  borderRadius: 'var(--mint-radius-button)',
  fontFamily: 'var(--mint-font-family)',
  fontSize: 'var(--mint-text-meta)',
  background: 'var(--mint-bg-card)',
  color: 'var(--mint-fg-strong)',
  boxSizing: 'border-box',
  lineHeight: 1.5,
  resize: 'vertical',
  minHeight: 120,
};

const primaryButtonStyle: React.CSSProperties = {
  padding: '8px 14px',
  background: 'var(--mint-fg-strong)',
  color: 'var(--mint-fg-inverted)',
  border: 'none',
  borderRadius: 'var(--mint-radius-button)',
  fontWeight: 600,
  fontSize: 'var(--mint-text-meta)',
  alignSelf: 'flex-start',
};

const errorBannerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 'var(--mint-sp-2)',
  padding: 'var(--mint-sp-2) var(--mint-sp-3)',
  background: 'var(--mint-negative-bg-soft)',
  color: 'var(--mint-negative-fg-strong)',
  borderRadius: 'var(--mint-radius-button)',
  fontSize: 'var(--mint-text-meta)',
};

const outputSectionStyle: React.CSSProperties = {
  marginTop: 'var(--mint-sp-2)',
  padding: 'var(--mint-sp-2) var(--mint-sp-3)',
  background: 'var(--mint-bg-subtle)',
  border: 'var(--mint-card-stroke)',
  borderRadius: 'var(--mint-radius-card)',
};

const outputHeaderStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  marginBottom: 6,
};

const outputContentStyle: React.CSSProperties = {
  margin: 0,
  fontFamily: 'var(--mint-font-family)',
  fontSize: 'var(--mint-text-meta)',
  color: 'var(--mint-fg-strong)',
  whiteSpace: 'pre-wrap',
  lineHeight: 1.5,
};

const copyPillStyle = (copied: boolean): React.CSSProperties => ({
  padding: '3px 10px',
  background: copied ? 'var(--mint-positive-fg-graphic)' : 'var(--mint-bg-card)',
  color: copied ? '#fff' : 'var(--mint-positive-fg-strong)',
  border: '1px solid var(--mint-positive-fg-graphic)',
  borderRadius: 'var(--mint-radius-pill)',
  fontSize: 'var(--mint-text-nano)',
  fontWeight: 700,
  cursor: copied ? 'default' : 'pointer',
});

const textLinkStyle: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: 'var(--mint-highlight-fg-strong)',
  fontWeight: 600,
  fontSize: 'var(--mint-text-meta)',
  cursor: 'pointer',
  padding: 0,
};
```

- [ ] **Step 3: Update `src/sidepanel/SidePanel.tsx`.** Find the existing `<TranscriptCard ... />` render (around line 390):

```tsx
      {/* TRANSCRIPT */}
      <TranscriptCard transcript={ticket.zendeskTranscript} />
```

Replace with:

```tsx
      {/* TRANSCRIPT PARSER */}
      <TranscriptCard />
```

- [ ] **Step 4: Build to confirm everything compiles.**

Run from `~/projects/wocoo-extension/extension/`:
```bash
npm run build
```
Expected: build completes with no TypeScript errors. The `transcript` prop's type — `WocooTicket['zendeskTranscript']` — is no longer referenced in `TranscriptCard.tsx`. If TypeScript flags the `transcript` field on `WocooTicket` as unused, ignore — mock data still consumes it.

- [ ] **Step 5: Reload the extension.**

`chrome://extensions` → reload "WOCOO Triager".

- [ ] **Step 6: End-to-end test — happy path.**

  1. Open any WOCOO ticket (the card is unconditional now — appears on every ticket).
  2. Scroll to the **🗒️ Parse Zendesk Transcript** card.
  3. Paste a real Zendesk transcript (~1k–5k chars) into the textarea.
  4. Confirm the char counter shows below the textarea, no warning yet.
  5. Click **Parse**. Within ~5–15s, the card transitions to `parsed`:
     - **📞 Summary** section with a 3–5 sentence paragraph.
     - **🔑 Key Facts** section with 4–7 bulleted lines.
     - **↻ Re-Parse** link in the card header.
  6. Click **Copy** on Summary → paste somewhere → confirm content.
  7. Click **Copy** on Key Facts → paste somewhere → confirm content is `- bullet\n- bullet\n...` lines.

- [ ] **Step 7: Re-Parse path.**

  1. After Step 6, click **↻ Re-Parse** in the card header.
  2. Card returns to `idle`, textarea content is **preserved**, Summary and Key Facts sections disappear.
  3. Edit the textarea (e.g. add an extra sentence). Click **Parse**. New output appears.

- [ ] **Step 8: Soft warning.**

  1. Paste or generate a transcript > 12,000 chars.
  2. Confirm `Long transcript — consider splitting in half if MagicAI rejects.` appears in the char-counter row.
  3. Click Parse anyway. Either it succeeds (output appears) OR it fails with an inline error banner; both are acceptable behaviors.

- [ ] **Step 9: Empty textarea.**

  1. Clear the textarea entirely.
  2. Parse button is disabled.

- [ ] **Step 10: Bridge error path.**

  1. Temporarily set the Apps Script bridge URL to a known-bad value (via SettingsView if available, or by editing the deploy directly to break it; revert after the test).
  2. Click Parse on a transcript.
  3. Error banner shows the timeout / failure message.
  4. Click "Try again" → returns to `idle` with the textarea content intact.
  5. Restore the bridge URL.

- [ ] **Step 11: Regression — existing bridge actions.**

  1. Run a Wires Pending Posting pass (uses `readPendingWiresViaBridge`). Confirm it still works end-to-end (loads rows, verifies via Ledge, marks Posted).
  2. Click Mobile Cheque Validation in QuickActions if available — confirm the status check still works.
  3. The new `parseTranscript` action is additive; existing actions should be unaffected.

- [ ] **Step 12: Regression — side panel layout.**

  1. Cycle through several different WOCOO tickets (wallet, overpayment, wires, fraud). Confirm the side panel still renders cleanly for each — the Transcript Parser card appears in its previous slot, the other cards above QuickActions still appear as before.

---

## Self-Review Summary

After writing the plan, checked it against the spec:

- **Spec coverage:**
  - 4-state card UX (`idle`/`parsing`/`parsed`/`error`) → Task 2 Step 2 (`useState<CardState>`).
  - Paste textarea + char counter + 12k soft warning → Task 2 Step 2 (`LONG_TRANSCRIPT_THRESHOLD`).
  - Parse button disabled when empty/parsing → Task 2 Step 2 (`parseDisabled`).
  - Summary + Key Facts sections + per-section Copy buttons → Task 2 Step 2 (`OutputSection`).
  - Re-Parse link preserves textarea → Task 2 Step 2 (`onReParse` only clears state, not `text`).
  - Error banner with "Try again" → Task 2 Step 2 (`onTryAgain`).
  - `parseTranscriptViaBridge` API → Task 2 Step 1.
  - Apps Script `parseTranscript` + `buildTranscriptParserPrompt` + `callMagicAI` → Task 1 Steps 2–4.
  - Dispatcher wiring → Task 1 Step 5.
  - Re-deploy convention → Task 1 Step 6.
  - PII boundary (MagicAI only) → enforced by Task 1's endpoint choice, not by code.
  - SidePanel prop drop → Task 2 Step 3.
  - Open Question discovery (MagicAI HTTP-callable from GAS?) → Task 1 Step 1 (probe + STOP path).
- **Placeholder scan:** The probe function (Task 1 Step 1) uses `'PASTE_MAGIC_AI_URL_HERE'` and `headers: {}` placeholders — these are necessarily user-supplied at discovery time, not vague TODOs. The plan explicitly tells Albert to replace them with Step 1's discovered values in Step 3. This is the intentional discovery path; not a plan failure.
- **Type consistency:** `parseTranscriptViaBridge` return shape `{ summary: string; keyFacts: string[] }` matches the GAS function's return shape (`{ summary, keyFacts }`) and matches `TranscriptCard`'s state shape. Action name `'parseTranscript'` and reply name `'transcriptParsed'` consistent across `callBridge` invocation, dispatcher case, and `postReplyToParent` call.
- **Scope:** One focused feature, four files (1 GAS + 3 extension), two tasks. Single plan, right shape.
