import { describe, it, expect, vi, afterEach } from 'vitest';
import { callLlmGateway, pingLlmGateway, LLM_GATEWAY_URL, LLM_GATEWAY_MODEL } from './llmGateway';

afterEach(() => { vi.restoreAllMocks(); });

function mockFetchOnce(body: unknown, ok = true, status = 200) {
  const fetchMock = vi.fn(async () => ({
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  })) as unknown as typeof fetch;
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock as unknown as ReturnType<typeof vi.fn>;
}

describe('callLlmGateway', () => {
  it('posts to the gateway with the dev-key header and json_object mode', async () => {
    const fetchMock = mockFetchOnce({ choices: [{ message: { content: '{"work_type":"X"}' } }] });
    const out = await callLlmGateway([{ role: 'user', content: 'hi' }], 'sk-test');
    expect(out).toBe('{"work_type":"X"}');

    const [url, init] = (fetchMock as any).mock.calls[0];
    expect(url).toBe(LLM_GATEWAY_URL);
    // Open WebUI fronts the gateway and authenticates with a bearer token. The older
    // LiteLLM-specific header is rejected by it, which is what made every call 401.
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test');
    expect((init.headers as Record<string, string>)['X-LiteLLM-Dev-Key']).toBeUndefined();
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe(LLM_GATEWAY_MODEL);
    expect(body.response_format).toEqual({ type: 'json_object' });
  });

  it('throws a VPN-aware message on a network failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    await expect(callLlmGateway([{ role: 'user', content: 'hi' }], 'sk-test'))
      .rejects.toThrow(/VPN/i);
  });

  it('throws on a non-OK status', async () => {
    mockFetchOnce({ error: 'nope' }, false, 401);
    await expect(callLlmGateway([{ role: 'user', content: 'hi' }], 'sk-bad'))
      .rejects.toThrow(/401/);
  });

  it('throws when the response has no content', async () => {
    mockFetchOnce({ choices: [] });
    await expect(callLlmGateway([{ role: 'user', content: 'hi' }], 'sk-test'))
      .rejects.toThrow(/empty/i);
  });
});

describe('pingLlmGateway', () => {
  it('reports ok on a successful call', async () => {
    mockFetchOnce({ choices: [{ message: { content: '{}' } }] });
    expect(await pingLlmGateway('sk-test')).toEqual({ ok: true });
  });

  it('names both the key and the VPN when the call fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    const res = await pingLlmGateway('sk-test');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toMatch(/VPN/i);
      expect(res.error).toMatch(/key/i);
    }
  });
});

describe('LLM_GATEWAY_URL', () => {
  it('targets Open WebUI chat completions, not the retired LiteLLM v2 path', () => {
    expect(LLM_GATEWAY_URL).toBe('https://llm.w10e.com/api/chat/completions');
  });
});

describe('LLM_GATEWAY_MODEL', () => {
  it('names a model id the gateway still serves', () => {
    // The un-suffixed bedrock-claude-sonnet-4-6 was retired; the gateway now lists
    // only the -global inference profile, and the old id returns 400 "Model not found".
    expect(LLM_GATEWAY_MODEL).toBe('bedrock-claude-sonnet-4-6-global');
  });
});
