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
  /** Re-listed from Gmail: Sidekick drafted it in an earlier run and it hasn't been sent. Never re-resolved. */
  earlier?: boolean;
  /** Informational note on a successful send (already sent earlier / tidy-up warning). */
  sendNote?: string;
}

/** An insurer email dropped as a non-eligibility request. Metadata only — never the body. */
export interface SkippedEmail { subject: string; from: string; date: string }

export interface RunState {
  stage: 'idle' | 'fetched' | 'resolved' | 'drafted' | 'sent';
  rows: RunRow[];
  skippedUnknownSender: number;
  /** The unknown-sender scan hit its cap, so the count is a lower bound ("200+"). */
  skippedUnknownSenderCapped?: boolean;
  /** Insurer emails dropped because neither subject nor body mentions eligibility. */
  skippedNotEligibility: number;
  /** Which emails those were (restored state from before this field existed may lack it — read with `?? []`). */
  skippedNotEligibilityList: SkippedEmail[];
  /** Last generated warehouse SQL, for the Copy SQL fallback. */
  sql: string;
}

export const EMPTY_RUN: RunState = { stage: 'idle', rows: [], skippedUnknownSender: 0, skippedNotEligibility: 0, skippedNotEligibilityList: [], sql: '' };

const SKIPPED_SUBJECT_MAX = 120;

/** `YYYY-MM-DD · from · subject`, subject truncated to 120 chars with an ellipsis. */
export function formatSkippedLine(item: SkippedEmail): string {
  const subject = item.subject.length > SKIPPED_SUBJECT_MAX ? item.subject.slice(0, SKIPPED_SUBJECT_MAX - 1) + '…' : item.subject;
  return `${item.date.slice(0, 10)} · ${item.from} · ${subject}`;
}

/** Newest first (ISO dates sort lexicographically); input is not mutated. */
export function sortSkippedNewestFirst(items: SkippedEmail[]): SkippedEmail[] {
  return [...items].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

/** Always show the matched client email in the draft (user decision, live run 5). */
export function shouldShowClientEmail(res: Resolution): boolean {
  return !!res.clientEmail;
}

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

/** Rows that were sent but whose READ_EMAIL log hasn't been written (incl. earlier-run rows with no Resolution). */
export function unsentLoggedCount(rows: RunRow[]): number {
  return rows.filter((r) => r.sent === 'ok' && !r.sentLogged).length;
}

/** Drafts in this run that exist in Gmail but haven't been sent — losing the panel view of them needs a confirm. */
export function unsentDraftCount(rows: RunRow[]): number {
  return rows.filter((r) => r.draftId && r.sent !== 'ok').length;
}

/** A row for a thread Sidekick drafted in an earlier run: already logged as DRAFTED, waiting to be sent. */
export function earlierDraftRow(req: EligibilityRequest, draftId: string): RunRow {
  return {
    req, res: null, selected: false, draftId, draftBody: '', sent: 'no', sendError: '', logged: true, sentLogged: false,
    earlier: true,
  };
}

/** Minimal Resolution used to log READ_EMAIL for an earlier-run row that was never resolved in this run. */
export function earlierRunResolution(requestId: string): Resolution {
  return {
    requestId, status: 'matched', method: null, clientEmail: null, identityId: null,
    cards: [], flags: [], candidates: [], note: 'Sent from an earlier Sidekick run.',
  };
}

/** Rows Resolve may (re-)resolve: anything already drafted is left alone. */
export function rowsToResolve(rows: RunRow[]): RunRow[] {
  return rows.filter((r) => !r.draftId);
}

/**
 * Applies fresh resolutions by requestId. Rows with a draftId, or with no result, come back unchanged.
 * `draftBodyFor` renders the reply ('' when the resolution isn't draftable).
 */
export function mergeResolutions(
  rows: RunRow[], results: Resolution[], draftBodyFor: (row: RunRow, res: Resolution) => string,
): RunRow[] {
  const byId = new Map(results.map((x) => [x.requestId, x]));
  return rows.map((r) => {
    if (r.draftId) return r;
    const res = byId.get(r.req.messageId);
    if (!res) return r;
    const draftBody = draftBodyFor(r, res);
    return { ...r, res, draftBody, selected: defaultSelected(res) && !!draftBody, logged: false };
  });
}

/** Step 3 (create drafts & log) is available while there are drafts to create or rows to log. */
export function canRunStep3(rows: RunRow[], busy: boolean): boolean {
  if (busy) return false;
  const drafts = rows.filter((r) => r.selected && r.draftBody && !r.draftId).length;
  return drafts > 0 || unloggedCount(rows) > 0;
}
