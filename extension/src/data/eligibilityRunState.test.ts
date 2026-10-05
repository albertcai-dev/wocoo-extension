import { describe, expect, it } from 'vitest';
import {
  canRunStep3, defaultSelected, EMPTY_RUN, earlierDraftRow, earlierRunResolution, mergeResolutions, nextLogStatus, rowsToResolve,
  unloggedCount, unsentDraftCount, unsentLoggedCount, type RunRow,
} from './eligibilityRunState';
import type { EligibilityRequest, Resolution } from './eligibilityTypes';

const base: Resolution = {
  requestId: 'm', status: 'matched', method: 'email_last4', clientEmail: 'p@example.com', identityId: 'identity-A',
  cards: [{ last4: '1763', product: 'ws_visa_infinite_privilege', creationDate: '08/21/2026', delinquent: false }],
  flags: [], candidates: [], note: '',
};

describe('defaultSelected', () => {
  it('selects clean matches only', () => {
    expect(defaultSelected(base)).toBe(true);
    expect(defaultSelected({ ...base, status: 'needs_review', flags: ['vi_1pct'] })).toBe(false);
    expect(defaultSelected({ ...base, status: 'no_match', method: null, cards: [] })).toBe(false);
  });
});

describe('nextLogStatus', () => {
  it('maps outcomes to Requests statuses', () => {
    expect(nextLogStatus(base, true)).toBe('DRAFTED');
    expect(nextLogStatus({ ...base, status: 'needs_review', flags: ['already_replied'] }, false)).toBe('ALREADY_HAS_ONE_REPLY');
    expect(nextLogStatus({ ...base, status: 'needs_review', flags: ['delinquent'] }, false)).toBe('NEEDS_REVIEW');
    expect(nextLogStatus({ ...base, status: 'needs_review', flags: ['delinquent'] }, true)).toBe('DRAFTED');
    expect(nextLogStatus({ ...base, status: 'no_match', method: null, cards: [] }, false)).toBe('NO_MATCH');
  });
});

const row = (over: Partial<RunRow>): RunRow => ({
  req: {} as EligibilityRequest, res: base, selected: false, draftId: '', draftBody: '',
  sent: 'no', sendError: '', logged: false, sentLogged: false, ...over,
});
const noMatch: Resolution = { ...base, status: 'no_match', method: null, cards: [] };

describe('canRunStep3 / unloggedCount', () => {
  it('enables step 3 for an all-no-match batch with no drafts (rows still need logging)', () => {
    const rows = [row({ res: noMatch }), row({ res: { ...base, status: 'needs_review', flags: ['delinquent'] } })];
    expect(unloggedCount(rows)).toBe(2);
    expect(canRunStep3(rows, false)).toBe(true);
  });
  it('enables step 3 when a draft is waiting to be created', () => {
    expect(canRunStep3([row({ selected: true, draftBody: 'hi', logged: true })], false)).toBe(true);
  });
  it('disables step 3 when every row is drafted and logged', () => {
    expect(canRunStep3([row({ selected: true, draftBody: 'hi', draftId: 'd1', logged: true })], false)).toBe(false);
  });
  it('re-enables step 3 for a retry when a created draft failed to log', () => {
    expect(canRunStep3([row({ selected: true, draftBody: 'hi', draftId: 'd1', logged: false })], false)).toBe(true);
  });
  it('is disabled while busy, and ignores unresolved rows', () => {
    expect(canRunStep3([row({ res: noMatch })], true)).toBe(false);
    expect(unloggedCount([row({ res: null })])).toBe(0);
    expect(canRunStep3([row({ res: null })], false)).toBe(false);
  });
});

describe('unsentLoggedCount', () => {
  it('counts sent-ok rows whose READ_EMAIL log is outstanding', () => {
    expect(unsentLoggedCount([row({ sent: 'ok' }), row({ sent: 'ok', sentLogged: true }), row({ sent: 'failed' })])).toBe(1);
  });
});

describe('unsentLoggedCount for earlier-run rows', () => {
  it('counts a sent earlier-run row that has no Resolution', () => {
    expect(unsentLoggedCount([row({ res: null, draftId: 'd1', sent: 'ok', earlier: true })])).toBe(1);
  });
});

describe('unsentDraftCount', () => {
  it('counts drafts that are not sent yet', () => {
    expect(unsentDraftCount([
      row({ draftId: 'd1' }), row({ draftId: 'd2', sent: 'failed' }), row({ draftId: 'd3', sent: 'ok' }), row({}),
    ])).toBe(2);
  });
});

const reqFor = (messageId: string) => ({ messageId } as EligibilityRequest);

describe('earlierDraftRow / earlierRunResolution', () => {
  it('builds an already-logged, unsent, unresolved row that step 3 ignores', () => {
    const r = earlierDraftRow(reqFor('m9'), 'd9');
    expect(r).toMatchObject({ res: null, draftId: 'd9', draftBody: '', sent: 'no', logged: true, sentLogged: false, earlier: true });
    expect(canRunStep3([r], false)).toBe(false);
    expect(unsentDraftCount([r])).toBe(1);
  });
  it('builds the minimal READ_EMAIL resolution', () => {
    expect(earlierRunResolution('m9')).toEqual({
      requestId: 'm9', status: 'matched', method: null, clientEmail: null, identityId: null,
      cards: [], flags: [], candidates: [], note: 'Sent from an earlier Sidekick run.',
    });
  });
});

describe('rowsToResolve / mergeResolutions', () => {
  const drafted = row({ req: reqFor('a'), draftId: 'd1', draftBody: 'old', logged: true, sent: 'ok', sentLogged: true });
  const earlier = earlierDraftRow(reqFor('b'), 'd2');
  const fresh = row({ req: reqFor('c'), res: null });
  const fresh2 = row({ req: reqFor('d'), res: null });

  it('only offers rows without a draft to Resolve', () => {
    expect(rowsToResolve([drafted, earlier, fresh, fresh2])).toEqual([fresh, fresh2]);
  });

  it('maps results by requestId and leaves drafted rows untouched', () => {
    const results: Resolution[] = [
      { ...noMatch, requestId: 'd' },
      { ...base, requestId: 'c' },
      { ...base, requestId: 'a' }, // must be ignored: row a already has a draft
    ];
    const out = mergeResolutions([drafted, earlier, fresh, fresh2], results, (_r, res) => (res.status === 'matched' ? 'body' : ''));
    expect(out[0]).toBe(drafted);
    expect(out[1]).toBe(earlier);
    expect(out[2]).toMatchObject({ res: { requestId: 'c' }, draftBody: 'body', selected: true, logged: false });
    expect(out[3]).toMatchObject({ res: { requestId: 'd', status: 'no_match' }, draftBody: '', selected: false, logged: false });
  });
});

describe('EMPTY_RUN', () => {
  it('starts with no skipped non-eligibility emails', () => {
    expect(EMPTY_RUN.skippedNotEligibility).toBe(0);
  });
});
