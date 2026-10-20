import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../auth/oauth', () => ({ getValidAccessToken: vi.fn(async () => 'tok') }));

import { getTicket } from './jira';

function mockIssue(status: unknown) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).includes('accessible-resources')) {
      return new Response(JSON.stringify([{ id: 'cloud-1', url: 'https://wealthsimple.atlassian.net' }]), { status: 200 });
    }
    return new Response(JSON.stringify({ fields: { summary: 'Synthetic', status } }), { status: 200 });
  }));
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('getTicket raw status', () => {
  it('keeps the raw Jira status name next to its bucket', async () => {
    mockIssue({ name: 'Cancelled/ No Action', statusCategory: { name: 'Done' } });
    const t = await getTicket('TEST-1');
    expect(t.jiraStatus).toEqual({ name: 'Cancelled/ No Action', bucket: t.status });
  });

  it('omits it when Jira sends no status', async () => {
    mockIssue(undefined);
    expect((await getTicket('TEST-1')).jiraStatus).toBeUndefined();
  });
});
