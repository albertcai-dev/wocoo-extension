// Panel run-state shapes + the two rules the panel applies to every row.

import type { LogStatus } from './eligibilityLog';
import type { EligibilityRequest, Resolution } from './eligibilityTypes';

export const RUN_STATE_KEY = 'eligibility_run_v1';

export interface RunRow {
  req: EligibilityRequest;
  res: Resolution | null;
  selected: boolean;
  draftId: string;
  draftBody: string;
  sent: 'no' | 'ok' | 'failed';
  sendError: string;
}

export interface RunState {
  stage: 'idle' | 'fetched' | 'resolved' | 'drafted' | 'sent';
  rows: RunRow[];
  skippedUnknownSender: number;
  /** Last generated warehouse SQL, for the Copy SQL fallback. */
  sql: string;
}

export const EMPTY_RUN: RunState = { stage: 'idle', rows: [], skippedUnknownSender: 0, sql: '' };

export function defaultSelected(res: Resolution): boolean {
  return res.status === 'matched';
}

export function nextLogStatus(res: Resolution, drafted: boolean): LogStatus {
  if (drafted) return 'DRAFTED';
  if (res.flags.includes('already_replied')) return 'ALREADY_HAS_ONE_REPLY';
  if (res.status === 'no_match') return 'NO_MATCH';
  return 'NEEDS_REVIEW';
}
