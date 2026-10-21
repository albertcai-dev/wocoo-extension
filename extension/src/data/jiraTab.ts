// Opening a ticket in the user's Jira tab from the side panel, so the content script there can
// pre-fill its comment box (it only acts on the ticket its own page shows).

export const JIRA_TAB_URL = /^https:\/\/wealthsimple\.atlassian\.net\//;

/** The minimal chrome.tabs surface used here (real chrome.tabs in the panel, fakes in tests). */
export interface TabsApi {
  query(q: { active: true; currentWindow: true }): Promise<Array<{ id?: number; url?: string }>>;
  update(tabId: number, props: { url: string }): Promise<unknown>;
  create(props: { url: string }): Promise<unknown>;
}

/** The row's own Jira URL, or the ticket's browse URL when the row has none (or a non-Jira one). */
export function ticketUrlFor(row: { key: string; url?: string | null }): string {
  if (row.url && JIRA_TAB_URL.test(row.url)) return row.url;
  return `https://wealthsimple.atlassian.net/browse/${encodeURIComponent(row.key)}`;
}

const showsTicket = (url: string, key: string) =>
  new RegExp(`(^|[^A-Z0-9-])${key.replace(/[-]/g, '\\-')}(?!\\d)`, 'i').test(url);

/** Navigates the current window's active tab to `url` when it is a Jira tab; otherwise opens a
 *  new tab. A Jira tab already showing the ticket is left alone (no reload, no lost edits). */
export async function openTicketInJiraTab(
  url: string,
  key: string,
  tabs: TabsApi,
): Promise<'updated' | 'created' | 'already-open'> {
  const [tab] = await tabs.query({ active: true, currentWindow: true });
  if (tab?.id != null && tab.url && JIRA_TAB_URL.test(tab.url)) {
    if (showsTicket(tab.url, key)) return 'already-open';
    await tabs.update(tab.id, { url });
    return 'updated';
  }
  await tabs.create({ url });
  return 'created';
}
