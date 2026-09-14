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

describe('joinPrecedentOutcomes with Jira comments', () => {
  it('uses the closing comments when the log has no note for the ticket', () => {
    const out = joinPrecedentOutcomes(
      [{ id: 'WOCOO-1', summary: 's', description: 'd', comments: ['Waived the fee as a one-time courtesy.'] }],
      [],
    );
    expect(out[0].source).toBe('comments');
    expect(out[0].outcome).toBe('Waived the fee as a one-time courtesy.');
  });

  it('prefers a human resolution note over the closing comments', () => {
    const out = joinPrecedentOutcomes(
      [{ id: 'WOCOO-1', summary: 's', description: 'd', comments: ['Closing comment text'] }],
      [{ ticketId: 'WOCOO-1', resolutionNote: 'Hand-written note' } as any],
    );
    expect(out[0].source).toBe('logged');
    expect(out[0].outcome).toBe('Hand-written note');
  });

  it('keeps only the last two comments, oldest of the pair first', () => {
    const out = joinPrecedentOutcomes(
      [{ id: 'WOCOO-1', summary: 's', description: 'd', comments: ['one', 'two', 'three', 'four'] }],
      [],
    );
    expect(out[0].outcome).toBe('three\nfour');
  });

  it('caps a long comment so one rambling thread cannot dominate the prompt', () => {
    const out = joinPrecedentOutcomes(
      [{ id: 'WOCOO-1', summary: 's', description: 'd', comments: ['x'.repeat(900)] }],
      [],
    );
    expect(out[0].outcome.length).toBeLessThanOrEqual(603);
    expect(out[0].outcome.endsWith('…')).toBe(true);
  });

  it('ignores blank and whitespace-only comments', () => {
    const out = joinPrecedentOutcomes(
      [{ id: 'WOCOO-1', summary: 's', description: 'd', comments: ['', '   ', 'real'] }],
      [],
    );
    expect(out[0].outcome).toBe('real');
    expect(out[0].source).toBe('comments');
  });

  it('stays intake-only when there is neither a note nor a comment', () => {
    const out = joinPrecedentOutcomes([{ id: 'WOCOO-1', summary: 's', description: 'd', comments: [] }], []);
    expect(out[0].source).toBe('intake-only');
    expect(out[0].outcome).toBe('');
  });
});
