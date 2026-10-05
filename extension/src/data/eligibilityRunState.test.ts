import { describe, expect, it } from 'vitest';
import { defaultSelected, nextLogStatus } from './eligibilityRunState';
import type { Resolution } from './eligibilityTypes';

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
