import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../auth/oauth', () => ({ getValidAccessToken: vi.fn(async () => 'tok') }));

import { getIssueCommentsDetailed } from './jira';

const adf = (text: string) => ({
  type: 'doc', version: 1,
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

function mockFetch(commentsResp: { ok: boolean; status?: number; body: unknown }) {
  const fn = vi.fn(async (url: string) => {
    if (String(url).includes('accessible-resources')) {
      return new Response(JSON.stringify([{ id: 'cloud-1', url: 'https://wealthsimple.atlassian.net' }]), { status: 200 });
    }
    return new Response(JSON.stringify(commentsResp.body), { status: commentsResp.status ?? 200 });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('getIssueCommentsDetailed', () => {
  it('maps ADF comments to detail rows', async () => {
    const fn = mockFetch({
      ok: true,
      body: { comments: [
        { id: '101', author: { accountId: 'acct-a' }, created: '2026-01-01T10:00:00.000-0500', body: adf('First note') },
        { id: '102', author: { accountId: 'acct-b' }, created: '2026-01-01T11:00:00.000-0500', body: adf('Second note') },
      ] },
    });
    const rows = await getIssueCommentsDetailed('TEST-1');
    expect(rows).toEqual([
      { id: '101', authorAccountId: 'acct-a', created: '2026-01-01T10:00:00.000-0500', text: 'First note' },
      { id: '102', authorAccountId: 'acct-b', created: '2026-01-01T11:00:00.000-0500', text: 'Second note' },
    ]);
    const url = String(fn.mock.calls.find((c) => String(c[0]).includes('/comment'))![0]);
    expect(url).toContain('/ex/jira/cloud-1/rest/api/3/issue/TEST-1/comment');
  });

  it('returns oldest first and tolerates missing author / body', async () => {
    mockFetch({
      ok: true,
      body: { comments: [
        { id: '2', author: { accountId: 'x' }, created: '2026-01-02T00:00:00.000+0000', body: adf('later') },
        { id: '1', created: '2026-01-01T00:00:00.000+0000' },
      ] },
    });
    const rows = await getIssueCommentsDetailed('TEST-1');
    expect(rows.map((r) => r.id)).toEqual(['1', '2']);
    expect(rows[0]).toMatchObject({ authorAccountId: '', text: '' });
  });

  it('asks for orderBy=-created with newest, and still returns oldest first', async () => {
    const fn = mockFetch({
      ok: true,
      body: { comments: [
        { id: '9', author: { accountId: 'x' }, created: '2026-01-09T00:00:00.000+0000', body: adf('newer') },
        { id: '8', author: { accountId: 'x' }, created: '2026-01-08T00:00:00.000+0000', body: adf('older') },
      ] },
    });
    const rows = await getIssueCommentsDetailed('TEST-1', { newest: true });
    const url = String(fn.mock.calls.find((c) => String(c[0]).includes('/comment'))![0]);
    expect(url).toContain('orderBy=-created');
    expect(rows.map((r) => r.id)).toEqual(['8', '9']);
  });

  it('defaults to orderBy=created', async () => {
    const fn = mockFetch({ ok: true, body: { comments: [] } });
    await getIssueCommentsDetailed('TEST-1');
    const url = String(fn.mock.calls.find((c) => String(c[0]).includes('/comment'))![0]);
    expect(url).toContain('orderBy=created');
    expect(url).not.toContain('-created');
  });

  it('throws with the HTTP status on failure', async () => {
    mockFetch({ ok: false, status: 404, body: { errorMessages: ['nope'] } });
    await expect(getIssueCommentsDetailed('TEST-1')).rejects.toThrow('HTTP 404');
  });
});
