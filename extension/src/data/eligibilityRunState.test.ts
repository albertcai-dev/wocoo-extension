import { describe, expect, it } from 'vitest';
import { canRunStep3, defaultSelected, nextLogStatus, unloggedCount, unsentLoggedCount, type RunRow } from './eligibilityRunState';
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
