import { describe, it, expect, vi } from 'vitest';
import { openTicketInJiraTab, ticketUrlFor, type TabsApi } from './jiraTab';

function tabs(active: { id?: number; url?: string } | undefined): TabsApi & {
  update: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn>;
} {
  return {
    query: vi.fn(async () => (active ? [active] : [])),
    update: vi.fn(async () => undefined),
    create: vi.fn(async () => undefined),
  } as never;
}

describe('ticketUrlFor', () => {
  it('uses the row url when it is a Jira url', () => {
    expect(ticketUrlFor({ key: 'WOCOO-1', url: 'https://wealthsimple.atlassian.net/browse/WOCOO-1' }))
      .toBe('https://wealthsimple.atlassian.net/browse/WOCOO-1');
  });
  it('builds a browse url otherwise', () => {
    expect(ticketUrlFor({ key: 'WOCOO-2', url: '' })).toBe('https://wealthsimple.atlassian.net/browse/WOCOO-2');
    expect(ticketUrlFor({ key: 'WOCOO-2', url: 'https://example.test/WOCOO-2' })).toBe('https://wealthsimple.atlassian.net/browse/WOCOO-2');
  });
});

describe('openTicketInJiraTab', () => {
  const url = 'https://wealthsimple.atlassian.net/browse/WOCOO-5';

  it('navigates the active tab when it is a Jira tab', async () => {
    const t = tabs({ id: 7, url: 'https://wealthsimple.atlassian.net/jira/servicedesk/projects/WOCOO/queues' });
    expect(await openTicketInJiraTab(url, 'WOCOO-5', t)).toBe('updated');
    expect(t.update).toHaveBeenCalledWith(7, { url });
    expect(t.create).not.toHaveBeenCalled();
  });

  it('opens a new tab when the active tab is not Jira', async () => {
    const t = tabs({ id: 7, url: 'https://example.test/' });
    expect(await openTicketInJiraTab(url, 'WOCOO-5', t)).toBe('created');
    expect(t.create).toHaveBeenCalledWith({ url });
    expect(t.update).not.toHaveBeenCalled();
  });

  it('opens a new tab when there is no active tab', async () => {
    const t = tabs(undefined);
    expect(await openTicketInJiraTab(url, 'WOCOO-5', t)).toBe('created');
  });

  it('leaves the tab alone when it already shows the ticket (no reload, no lost edits)', async () => {
    const t = tabs({ id: 7, url: 'https://wealthsimple.atlassian.net/browse/WOCOO-5?focusedCommentId=1' });
    expect(await openTicketInJiraTab(url, 'WOCOO-5', t)).toBe('already-open');
    expect(t.update).not.toHaveBeenCalled();
    expect(t.create).not.toHaveBeenCalled();
  });

  it('does not mistake WOCOO-55 for WOCOO-5', async () => {
    const t = tabs({ id: 7, url: 'https://wealthsimple.atlassian.net/browse/WOCOO-55' });
    expect(await openTicketInJiraTab(url, 'WOCOO-5', t)).toBe('updated');
  });
});
