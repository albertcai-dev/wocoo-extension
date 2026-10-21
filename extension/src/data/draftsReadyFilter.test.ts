import { describe, expect, it } from 'vitest';
import { repliedAfterDraft, splitReadyRows } from './draftsReadyFilter';
import type { ReadyDraftRow } from './agentDraftTypes';

const row = (key: string, created_at = '2026-10-20T18:25:00-0400'): ReadyDraftRow => ({
  key, summary: '', marker: '', kind: 'new', outcome: 'draft', url: '', created_at, assigned_at: null,
});

describe('splitReadyRows', () => {
  it('drops tickets that are no longer open and the user\'s (closed, moved, reassigned)', () => {
    const { keep } = splitReadyRows([row('P-1'), row('P-2'), row('P-3')], [
      { key: 'P-1', status: 'Back Office', updated: '2026-10-20T18:00:00-0400' },
      { key: 'P-3', status: 'Cancelled/ No Action', updated: '2026-10-20T18:00:00-0400' },
    ]);
    expect(keep.map((r) => r.key)).toEqual(['P-1']);
  });

  it('rechecks only tickets updated after the draft was written', () => {
    const { recheck } = splitReadyRows([row('P-1'), row('P-2')], [
      { key: 'P-1', status: 'Triage', updated: '2026-10-20T18:00:00-0400' },
      { key: 'P-2', status: 'Triage', updated: '2026-10-20T18:31:00-0400' },
    ]);
    expect(recheck.map((r) => r.key)).toEqual(['P-2']);
  });

  it('rechecks when a timestamp cannot be read', () => {
    const { recheck } = splitReadyRows([row('P-1', 'garbage')], [{ key: 'P-1', status: 'Triage', updated: 'x' }]);
    expect(recheck).toHaveLength(1);
  });
});

describe('repliedAfterDraft', () => {
  const c = (author: string, created: string) => ({ id: '1', authorAccountId: author, created, text: '' });
  it('is true only for the user\'s comment after the draft', () => {
    const at = '2026-10-20T18:25:00-0400';
    expect(repliedAfterDraft([c('me', '2026-10-20T18:31:00-0400')], 'me', at)).toBe(true);
    expect(repliedAfterDraft([c('me', '2026-10-20T18:00:00-0400')], 'me', at)).toBe(false);
    expect(repliedAfterDraft([c('other', '2026-10-20T18:31:00-0400')], 'me', at)).toBe(false);
  });
});
