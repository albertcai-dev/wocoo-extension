import { describe, it, expect } from 'vitest';
import { planPost } from './postPlan';
import type { ReplyTarget } from './replyTarget';

const A: ReplyTarget = { commentId: '1', parentId: null, accountId: 'acct-a', name: 'A' };
const B: ReplyTarget = { commentId: '2', parentId: null, accountId: 'acct-b', name: 'B' };

describe('planPost', () => {
  it('same target posts', () => {
    expect(planPost({ shown: A, fresh: { ...A }, confirmedId: null })).toEqual({ kind: 'post', target: A });
  });

  it('targetChanged when a new outsider commented', () => {
    expect(planPost({ shown: A, fresh: B, confirmedId: null })).toEqual({ kind: 'targetChanged', target: B });
  });

  it('second click with confirmed target posts', () => {
    expect(planPost({ shown: B, fresh: B, confirmedId: '2' })).toEqual({ kind: 'post', target: B });
    expect(planPost({ shown: A, fresh: B, confirmedId: '2' })).toEqual({ kind: 'post', target: B });
  });

  it('null to target counts as changed', () => {
    expect(planPost({ shown: null, fresh: A, confirmedId: null })).toEqual({ kind: 'targetChanged', target: A });
  });

  it('target to null counts as changed', () => {
    expect(planPost({ shown: A, fresh: null, confirmedId: null })).toEqual({ kind: 'targetChanged', target: null });
  });

  it('confirmed new-comment fallback posts with no target', () => {
    expect(planPost({ shown: A, fresh: null, confirmedId: '' })).toEqual({ kind: 'post', target: null });
  });

  it('no target either time posts a new comment', () => {
    expect(planPost({ shown: null, fresh: null, confirmedId: null })).toEqual({ kind: 'post', target: null });
  });
});
