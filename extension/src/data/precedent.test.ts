import { describe, it, expect } from 'vitest';
import { buildPrecedentJql, joinPrecedentOutcomes, PRECEDENT_MAX_RESULTS } from './precedent';
import type { RecentLogRow } from './aiTriageTypes';

function logRow(over: Partial<RecentLogRow> = {}): RecentLogRow {
  return {
    loggedAt: '2026-08-01T10:00:00Z',
    ticketId: 'WOCOO-100',
    summary: 'Interest charged after cutoff',
    originalWorkType: 'Credit Card: Statements',
    finalWorkType: 'Credit Card: Statements',
    transition: 'Done',
    movedToBoard: '',
    resolutionNote: 'Reversed as a one-time exception.',
    toolsUsed: 'i2c',
    ...over,
  };
}

describe('buildPrecedentJql', () => {
  it('scopes to Done WOCOO tickets of the same issue type, newest first', () => {
    const jql = buildPrecedentJql('Credit Card: Statements', 'WOCOO-999');
    expect(jql).toBe(
      'project = WOCOO AND statusCategory = Done AND issuetype = "Credit Card: Statements"'
      + ' AND key != WOCOO-999 ORDER BY created DESC',
    );
  });

  it('escapes double quotes in the work type so the JQL stays valid', () => {
    expect(buildPrecedentJql('Odd "quoted" type', 'WOCOO-1')).toContain('issuetype = "Odd \\"quoted\\" type"');
  });

  it('omits the key exclusion when there is no current key', () => {
    expect(buildPrecedentJql('Overpayment', '')).toBe(
      'project = WOCOO AND statusCategory = Done AND issuetype = "Overpayment" ORDER BY created DESC',
    );
  });

  it('caps candidates at 40', () => {
    expect(PRECEDENT_MAX_RESULTS).toBe(40);
  });
});

describe('joinPrecedentOutcomes', () => {
  it('attaches the resolution note when the log has the ticket', () => {
    const out = joinPrecedentOutcomes(
      [{ id: 'WOCOO-100', summary: 'Interest charged', description: 'Paid at 11:35 PM.' }],
      [logRow()],
    );
    expect(out).toEqual([{
      ticketId: 'WOCOO-100',
      summary: 'Interest charged',
      description: 'Paid at 11:35 PM.',
      source: 'logged',
      outcome: 'Reversed as a one-time exception.',
    }]);
  });

  it('marks unmatched candidates intake-only with an empty outcome', () => {
    const out = joinPrecedentOutcomes(
      [{ id: 'WOCOO-200', summary: 'Fee waiver', description: 'See Zendesk Support tab.' }],
      [logRow()],
    );
    expect(out[0].source).toBe('intake-only');
    expect(out[0].outcome).toBe('');
  });

  it('treats a log row with a blank resolution note as intake-only', () => {
    const out = joinPrecedentOutcomes(
      [{ id: 'WOCOO-100', summary: 'Interest charged', description: '' }],
      [logRow({ resolutionNote: '   ' })],
    );
    expect(out[0].source).toBe('intake-only');
  });

  it('defaults a missing description to the empty string', () => {
    const out = joinPrecedentOutcomes([{ id: 'WOCOO-300', summary: 'No body' }], []);
    expect(out[0].description).toBe('');
  });

  it('returns an empty array for no candidates', () => {
    expect(joinPrecedentOutcomes([], [logRow()])).toEqual([]);
  });
});
