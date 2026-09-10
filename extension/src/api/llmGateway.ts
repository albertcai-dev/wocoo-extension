// Direct browser calls to the Wealthsimple LLM Gateway (OpenAI-shaped).
//
// The gateway is fronted by Open WebUI, which owns the API keys shown under its
// Account settings and authenticates them with a bearer token. Calls used to go to a
// LiteLLM path (`/api/v2/chat/completions`) with an `X-LiteLLM-Dev-Key` header; after
// the migration that path rejects every Open WebUI key with a 401 reading "Unable to
// find token in ... LiteLLM_VerificationTokenTable", because the key genuinely is not
// in LiteLLM's own store. Response bodies are unchanged, so only the transport moved.
//
// This cannot live on the Apps Script bridge: the gateway is VPN-locked and Apps Script
// runs on Google's public servers. The extension is inside the VPN whenever Albert is.

export const LLM_GATEWAY_URL = 'https://llm.w10e.com/api/chat/completions';
/** The un-suffixed `bedrock-claude-sonnet-4-6` was retired and now returns 400 "Model
 *  not found"; the gateway lists only the `-global` cross-region inference profile.
 *
 *  This used to carry a note that the model had to stay VPC-hosted, because external
 *  models get WS PII masking that mangles client names and emails inside ticket text.
 *  Under Open WebUI every base model reports `connection_type: external`, which is a
 *  statement about how Open WebUI reaches its backend rather than about VPC hosting —
 *  so that field cannot be used to tell the two apart. Confirm with #ml-platform
 *  before assuming ticket text reaches this model unmasked. */
export const LLM_GATEWAY_MODEL = 'bedrock-claude-sonnet-4-6-global';
export const LLM_GATEWAY_TIMEOUT_MS = 45_000;

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CallOpts {
  maxTokens?: number;
  timeoutMs?: number;
  jsonMode?: boolean;
}

/** Returns the assistant's raw message content. Callers do their own parsing. */
export async function callLlmGateway(
  messages: LlmMessage[],
  key: string,
  opts: CallOpts = {},
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? LLM_GATEWAY_TIMEOUT_MS);

  let resp: Response;
  try {
    resp = await fetch(LLM_GATEWAY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: LLM_GATEWAY_MODEL,
        messages,
        ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
        ...(opts.jsonMode === false ? {} : { response_format: { type: 'json_object' } }),
      }),
    });
  } catch (e: any) {
    if (e?.name === 'AbortError') {
      throw new Error(`LLM Gateway timed out after ${(opts.timeoutMs ?? LLM_GATEWAY_TIMEOUT_MS) / 1000}s.`);
    }
    throw new Error('Could not reach the LLM Gateway. Check that you are on the WS VPN.');
  } finally {
    clearTimeout(timer);
  }

  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new Error(`LLM Gateway returned ${resp.status}. ${detail.slice(0, 200)}`);
  }

  const data: any = await resp.json().catch(() => null);
  const content = data?.choices?.[0]?.message?.content;
  if (!content || typeof content !== 'string') {
    throw new Error('LLM Gateway returned an empty response.');
  }
  return content;
}

/** One cheap call used by Settings to validate a freshly pasted key. */
export async function pingLlmGateway(key: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await callLlmGateway([{ role: 'user', content: 'Reply with {}' }], key, {
      maxTokens: 1,
      timeoutMs: 15_000,
    });
    return { ok: true };
  } catch (e: any) {
    // A VPN-off failure and a bad-key failure look almost identical from the browser,
    // so the message names both rather than guessing.
    return {
      ok: false,
      error: `${e?.message || 'Call failed.'} Check the key is correct and that you are on the WS VPN.`,
    };
  }
}
