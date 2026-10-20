// Real I/O for outcome capture: the draft store (native host) and Jira.

import { getDraft, listReadyDrafts, recordOutcome } from '../api/draftStore';
import { getIssueCommentsDetailed, getMyself } from '../api/jira';
import { captureJiraOutcome, fetchCommentsForOutcome, type CaptureDeps, type CaptureResult } from './outcomeCapture';

const liveDeps: CaptureDeps = {
  getDraft,
  getComments: (key) => fetchCommentsForOutcome(key, getIssueCommentsDetailed),
  getMyAccountId: async () => (await getMyself()).accountId,
  listReady: listReadyDrafts,
  record: recordOutcome,
};

export function captureJiraOutcomeLive(key: string, actualStatus: string): Promise<CaptureResult> {
  return captureJiraOutcome(liveDeps, key, actualStatus);
}
