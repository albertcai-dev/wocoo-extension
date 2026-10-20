// Real I/O for outcome capture: the draft store (native host) and Jira.

import type { AgentDraft } from './agentDraftTypes';
import { getDraft, listReadyDrafts, recordOutcome } from '../api/draftStore';
import { getIssueCommentsDetailed, getMyself } from '../api/jira';
import { JIRA_WHOAMI_MESSAGE, resolveMyAccountId } from './jiraIdentity';
import {
  captureJiraOutcome, checkExistingReply, fetchCommentsForOutcome, lookupAssignedAt,
  type CaptureDeps, type CaptureResult, type ExistingReply,
} from './outcomeCapture';

/** Asks each open Jira tab's content script for the signed-in accountId; the first answer wins. */
async function accountIdFromJiraPage(): Promise<string | null> {
  const tabs = await chrome.tabs.query({ url: 'https://wealthsimple.atlassian.net/*' });
  for (const tab of tabs) {
    if (tab.id == null) continue;
    try {
      const reply = await chrome.tabs.sendMessage(tab.id, { type: JIRA_WHOAMI_MESSAGE }) as { accountId?: string | null } | undefined;
      if (reply?.accountId) return reply.accountId;
    } catch { /* tab without the content script (e.g. opened before an extension reload) */ }
  }
  return null;
}

let myAccountId: string | null = null;
async function getMyAccountId(): Promise<string> {
  if (myAccountId) return myAccountId;
  myAccountId = await resolveMyAccountId({
    fromApi: async () => (await getMyself()).accountId,
    fromPage: accountIdFromJiraPage,
  });
  return myAccountId;
}

const liveDeps: CaptureDeps = {
  getDraft,
  // Oldest page plus, on a long thread, the newest page, so a recent reply is never missed.
  getComments: (key) => fetchCommentsForOutcome(key, getIssueCommentsDetailed),
  getMyAccountId,
  listReady: listReadyDrafts,
  record: recordOutcome,
};

export function captureJiraOutcomeLive(key: string, actualStatus: string): Promise<CaptureResult> {
  return captureJiraOutcome(liveDeps, key, actualStatus);
}

/** Has the user already replied in Jira since this draft was written? Throws if Jira can't be read. */
export function checkExistingReplyLive(draft: AgentDraft): Promise<ExistingReply> {
  return checkExistingReply(draft, liveDeps);
}

export function lookupAssignedAtLive(key: string): Promise<string | null> {
  return lookupAssignedAt(key, liveDeps.listReady);
}
