import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

vi.mock('../auth/oauth', () => ({ getValidAccessToken: vi.fn(async () => 'tok') }));
const emitTicketTransition = vi.fn();
vi.mock('../sidepanel/ticketLogEvents', () => ({ emitTicketTransition: (e: unknown) => emitTicketTransition(e) }));

import { transitionTicket, transitionTicketByName } from './jira';

type T = { id: string; name: string; to: { name: string } };

function mockFetch(transitions: T[]) {
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).includes('accessible-resources')) {
      return new Response(JSON.stringify([{ id: 'cloud-1', url: 'https://wealthsimple.atlassian.net' }]), { status: 200 });
    }
    if (String(url).endsWith('/transitions') && (!init || !init.method || init.method === 'GET')) {
      return new Response(JSON.stringify({ transitions }), { status: 200 });
    }
    return new Response(null, { status: 204 });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

const posted = (fn: ReturnType<typeof mockFetch>) =>
  fn.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === 'POST')
    .map((c) => JSON.parse(String((c[1] as RequestInit).body)).transition.id);

beforeEach(() => { emitTicketTransition.mockClear(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('transitionTicketByName ticket-log kind', () => {
  const TRANSITIONS: T[] = [
    { id: '31', name: 'Resolve', to: { name: 'Done' } },
    { id: '41', name: 'Cancel request', to: { name: 'Cancelled/ No Action' } },
    { id: '51', name: 'Request reviewed', to: { name: 'Back Office' } },
    { id: '61', name: 'Wait for customer', to: { name: 'Pending' } },
  ];

  it('logs Done when the destination status is Done, whatever the transition id', async () => {
    const fn = mockFetch(TRANSITIONS);
    await transitionTicketByName('WOCOO-1', 'Done');
    expect(posted(fn)).toEqual(['31']);
    expect(emitTicketTransition).toHaveBeenCalledTimes(1);
    expect(emitTicketTransition.mock.calls[0][0]).toMatchObject({ ticketId: 'WOCOO-1', kind: 'Done' });
  });

  it('logs Cancelled when the destination status starts with "Cancel"', async () => {
    mockFetch(TRANSITIONS);
    await transitionTicketByName('WOCOO-1', 'Cancel request');
    expect(emitTicketTransition.mock.calls[0][0]).toMatchObject({ kind: 'Cancelled' });
  });

  it('does not log non-terminal destinations (Back Office, Pending)', async () => {
    const fn = mockFetch(TRANSITIONS);
    await transitionTicketByName('WOCOO-1', 'Back Office');
    await transitionTicketByName('WOCOO-1', 'Pending');
    expect(posted(fn)).toEqual(['51', '61']);
    expect(emitTicketTransition).not.toHaveBeenCalled();
  });
});

describe('transitionTicket (other callers unchanged)', () => {
  it('still maps 251 to Done and anything else to Cancelled', async () => {
    mockFetch([]);
    await transitionTicket('WOCOO-1', '251');
    await transitionTicket('WOCOO-2', '201');
    expect(emitTicketTransition.mock.calls.map((c) => c[0].kind)).toEqual(['Done', 'Cancelled']);
  });

  it('still honours skipLog', async () => {
    mockFetch([]);
    await transitionTicket('WOCOO-1', '999', { skipLog: true });
    expect(emitTicketTransition).not.toHaveBeenCalled();
  });
});
