import { describe, expect, it } from 'vitest';
import { solveOffered, solveView } from './solveState';

const item = (state: string | null, extra: { solo?: boolean; priority?: boolean } = {}) =>
  ({ state, solo: false, priority: false, ...extra });

describe('solveView', () => {
  it('idle until pressed or prioritised', () => {
    expect(solveView(null, false)).toEqual({ kind: 'idle' });
    expect(solveView(item('baseline'), false)).toEqual({ kind: 'idle' });
    expect(solveView(item('queued'), false)).toEqual({ kind: 'idle' }); // just the normal queue
  });
  it('shows progress for a pressed ticket', () => {
    expect(solveView(item('queued', { priority: true }), true).kind).toBe('solving');
    expect(solveView(item('in_progress', { solo: true }), true)).toEqual({ kind: 'solving', label: 'Solving with Sidekick Agent…' });
    expect(solveView(item('awaiting_compass', { solo: true }), true).kind).toBe('solving');
  });
  it('reports the outcome after a press', () => {
    expect(solveView(item('drafted'), true)).toMatchObject({ kind: 'finished', draftReady: true });
    expect(solveView(item('skipped'), true)).toMatchObject({ kind: 'finished', draftReady: false });
    expect(solveView(item('drafted'), false)).toEqual({ kind: 'idle' });
  });
});

describe('solveOffered', () => {
  it('hides the button on overpayments', () => {
    expect(solveOffered('Credit Card: Overpayment')).toBe(false);
    expect(solveOffered('Credit Card: Transactions')).toBe(true);
    expect(solveOffered(undefined)).toBe(true);
  });
});
