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
  /** The Requests-sheet row has been written for this row's current outcome (DRAFTED / NEEDS_REVIEW / …). */
  logged: boolean;
  /** READ_EMAIL has been written after a successful send. */
  sentLogged: boolean;
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

/** Resolved rows whose current outcome hasn't reached the Requests sheet yet. */
export function unloggedCount(rows: RunRow[]): number {
  return rows.filter((r) => r.res && !r.logged).length;
}

/** Rows that were sent but whose READ_EMAIL log hasn't been written. */
export function unsentLoggedCount(rows: RunRow[]): number {
  return rows.filter((r) => r.sent === 'ok' && r.res && !r.sentLogged).length;
}

/** Step 3 (create drafts & log) is available while there are drafts to create or rows to log. */
export function canRunStep3(rows: RunRow[], busy: boolean): boolean {
  if (busy) return false;
  const drafts = rows.filter((r) => r.selected && r.draftBody && !r.draftId).length;
  return drafts > 0 || unloggedCount(rows) > 0;
}
