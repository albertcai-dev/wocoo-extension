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

describe('transitionTicketByName via Back Office', () => {
  const TRIAGE: T[] = [
    { id: '31', name: 'Done', to: { name: 'Done' } },
    { id: '51', name: 'Request reviewed', to: { name: 'Back Office' } },
    { id: '41', name: 'Cancel request', to: { name: 'Cancelled/ No Action' } },
  ];
  const BACK_OFFICE: T[] = [
    { id: '71', name: 'Pending External', to: { name: 'Pending External' } },
    { id: '31', name: 'Done', to: { name: 'Done' } },
  ];

  function mockSequence(lists: T[][]) {
    let n = 0;
    const fn = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes('accessible-resources')) {
        return new Response(JSON.stringify([{ id: 'cloud-1', url: 'https://wealthsimple.atlassian.net' }]), { status: 200 });
      }
      if (String(url).endsWith('/transitions') && (!init || !init.method || init.method === 'GET')) {
        return new Response(JSON.stringify({ transitions: lists[Math.min(n++, lists.length - 1)] }), { status: 200 });
      }
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal('fetch', fn);
    return fn;
  }

  it('hops through Back Office when the target is not reachable from Triage', async () => {
    const fn = mockSequence([TRIAGE, BACK_OFFICE]);
    await transitionTicketByName('WOCOO-1', 'Pending External');
    expect(posted(fn)).toEqual(['51', '71']);
    expect(emitTicketTransition).not.toHaveBeenCalled();
  });

  it('goes straight there when the target is reachable', async () => {
    const fn = mockSequence([TRIAGE]);
    await transitionTicketByName('WOCOO-1', 'Done');
    expect(posted(fn)).toEqual(['31']);
  });

  it('says it reached Back Office when the target is still missing there', async () => {
    const fn = mockSequence([TRIAGE, [{ id: '31', name: 'Done', to: { name: 'Done' } }]]);
    await expect(transitionTicketByName('WOCOO-1', 'Pending External')).rejects.toThrow(/Moved WOCOO-1 to Back Office/);
    expect(posted(fn)).toEqual(['51']);
  });

  it('fails without moving when neither the target nor Back Office is offered', async () => {
    const fn = mockSequence([[{ id: '31', name: 'Done', to: { name: 'Done' } }]]);
    await expect(transitionTicketByName('WOCOO-1', 'Pending External')).rejects.toThrow(/not available/);
    expect(posted(fn)).toEqual([]);
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
