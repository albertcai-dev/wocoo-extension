// Real I/O for outcome capture: the draft store (native host) and Jira.

import type { AgentDraft } from './agentDraftTypes';
import { getDraft, listReadyDrafts, recordOutcome } from '../api/draftStore';
import { getIssueCommentsDetailed, getMyself } from '../api/jira';
import {
  captureJiraOutcome, checkExistingReply, fetchCommentsForOutcome, lookupAssignedAt,
  type CaptureDeps, type CaptureResult, type ExistingReply,
} from './outcomeCapture';

const liveDeps: CaptureDeps = {
  getDraft,
  // Oldest page plus, on a long thread, the newest page, so a recent reply is never missed.
  getComments: (key) => fetchCommentsForOutcome(key, getIssueCommentsDetailed),
  getMyAccountId: async () => (await getMyself()).accountId,
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
