import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AgentDraft, ReadyDraftRow } from './agentDraftTypes';
import type { JiraCommentDetail } from '../api/jira';
import { buildOutcomeRow, markPostedThisSession, resetPostedMemoryForTests } from './agentDraftView';
import {
  buildJiraOutcomeRow, mergeComments, fetchCommentsForOutcome, rememberDraft,
  captureJiraOutcome, resetOutcomeCaptureState, type CaptureDeps,
  firstReplyAfterDraft, lookupAssignedAt, checkExistingReply, markWorkflowHandled, wasWorkflowHandled,
} from './outcomeCapture';

const ME = 'acct-me';
const OTHER = 'acct-other';

function draft(over: Partial<AgentDraft> = {}): AgentDraft {
  return {
    schema: 1, ticket: 'TEST-1', kind: 'new', outcome: 'draft',
    created_at: '2026-01-01T12:00:00Z', ticket_updated: '2026-01-01T12:00:00Z',
    last_comment_id: null, work_type: 'Test Type', summary: 'A summary',
    segments: [{ type: 'text', text: 'Agent suggested reply.' }],
    suggested_status: 'Done', move: null, action_needed: null, evidence: [], flags: ['thin_precedent'], compass_thread: null,
    ...over,
  };
}

// Jira's own timestamp format (offset without a colon). 12:00Z == 07:00-0500.
const c = (id: string, author: string, created: string, text = ''): JiraCommentDetail =>
  ({ id, authorAccountId: author, authorName: '', authorAccountType: 'atlassian', parentId: null, created, text });

describe('reply greeting in outcome rows', () => {
  const T = { commentId: '50', parentId: null, accountId: 'acct-jenn', name: 'Jenn' };
  const greeted = draft({ segments: [{ type: 'text', text: 'Hi ' }, { type: 'mention', text: '@Reporter', accountId: 'acct-r' }, { type: 'text', text: ', ok' }] });

  it('firstReplyAfterDraft counts a threaded reply', () => {
    const reply = { ...c('2', ME, '2026-01-01T07:30:00.000-0500', 'Hi @Jenn, ok'), parentId: '50' };
    expect(firstReplyAfterDraft(draft(), [c('1', OTHER, '2026-01-01T06:00:00.000-0500', 'q'), reply], ME)?.id).toBe('2');
  });

  it("jira outcome row strips Jira's leading mention", () => {
    const comments = [
      { ...c('50', 'acct-jenn', '2026-01-01T06:00:00.000-0500', 'question'), authorName: 'Jenn' },
      { ...c('51', ME, '2026-01-01T07:30:00.000-0500', '@Jenn Hi @Jenn, ok'), parentId: '50' },
    ];
    const row = buildJiraOutcomeRow(greeted, comments, ME, 'Done');
    expect(row.posted_text).toBe('Hi @Jenn, ok');
    expect(row.draft_text).toBe('Hi @Jenn, ok');
  });

  it('jira outcome row leaves a top-level reply alone', () => {
    const row = buildJiraOutcomeRow(greeted, [c('51', ME, '2026-01-01T07:30:00.000-0500', 'Hi @Reporter, ok')], ME, 'Done');
    expect(row.posted_text).toBe('Hi @Reporter, ok');
    expect(row.draft_text).toBe('Hi @Reporter, ok');
  });

  it('card outcome row uses the greeted draft as draft_text', () => {
    const row = buildOutcomeRow(greeted, 'Hi @Jenn, ok', { id: 'TEST-1' }, 'Done', { replyTarget: T });
    expect(row.draft_text).toBe('Hi @Jenn, ok');
    expect(row.posted_text).toBe('Hi @Jenn, ok');
  });
});

describe('buildJiraOutcomeRow', () => {
  it("uses the user's first comment after the draft", () => {
    const comments = [
      c('1', ME, '2026-01-01T07:30:00.000-0500', 'My real reply'),
      c('2', ME, '2026-01-01T08:00:00.000-0500', 'A later note'),
    ];
    const row = buildJiraOutcomeRow(draft(), comments, ME, 'Done');
    expect(row.posted_text).toBe('My real reply');
    expect(row).toMatchObject({
      via: 'jira', key: 'TEST-1', work_type: 'Test Type', draft_created_at: '2026-01-01T12:00:00Z',
      draft_text: 'Agent suggested reply.', suggested_status: 'Done', actual_status: 'Done',
      flags: ['thin_precedent'], assigned_at: null,
    });
    expect(Number.isNaN(Date.parse(row.recorded_at))).toBe(false);
  });

  it("ignores the user's comments before the draft", () => {
    const comments = [
      c('1', ME, '2026-01-01T06:59:00.000-0500', 'Written before the draft existed'),
      c('2', ME, '2026-01-01T07:30:00.000-0500', 'After'),
    ];
    expect(buildJiraOutcomeRow(draft(), comments, ME, 'Done').posted_text).toBe('After');
  });

  it('null posted_text when no reply', () => {
    const comments = [c('1', ME, '2026-01-01T06:00:00.000-0500', 'Before only')];
    expect(buildJiraOutcomeRow(draft(), comments, ME, 'Done').posted_text).toBeNull();
    expect(buildJiraOutcomeRow(draft(), [], ME, 'Done').posted_text).toBeNull();
  });

  it('ignores other authors', () => {
    const comments = [
      c('1', OTHER, '2026-01-01T07:30:00.000-0500', 'Someone else'),
      c('2', ME, '2026-01-01T08:00:00.000-0500', 'Mine'),
    ];
    expect(buildJiraOutcomeRow(draft(), comments, ME, 'Done').posted_text).toBe('Mine');
    expect(buildJiraOutcomeRow(draft(), [comments[0]], ME, 'Done').posted_text).toBeNull();
  });

  it('counts a mention-only (empty text) comment as posted, with empty string not null', () => {
    const comments = [c('1', ME, '2026-01-01T07:30:00.000-0500', '')];
    expect(buildJiraOutcomeRow(draft(), comments, ME, 'Done').posted_text).toBe('');
  });

  it('compares by timestamp across offsets, not string order', () => {
    // Lexically "2026-01-01T09..." > "2026-01-01T12..."? no: it sorts before, yet 09:00-0500 is 14:00Z, after the draft.
    const comments = [c('1', ME, '2026-01-01T09:00:00.000-0500', 'Later in UTC')];
    expect(buildJiraOutcomeRow(draft(), comments, ME, 'Done').posted_text).toBe('Later in UTC');
  });

  it('is not fooled by a comment created at exactly the draft time', () => {
    const comments = [c('1', ME, '2026-01-01T07:00:00.000-0500', 'Same instant')];
    expect(buildJiraOutcomeRow(draft(), comments, ME, 'Done').posted_text).toBeNull();
  });

  it('passes assigned_at through', () => {
    const row = buildJiraOutcomeRow(draft(), [], ME, 'Done', '2026-01-01T10:00:00.000Z');
    expect(row.assigned_at).toBe('2026-01-01T10:00:00.000Z');
  });
});

describe('mergeComments', () => {
  it('dedupes by id and returns oldest first', () => {
    const a = [c('1', ME, '2026-01-01T01:00:00.000+0000'), c('2', ME, '2026-01-01T02:00:00.000+0000')];
    const b = [c('2', ME, '2026-01-01T02:00:00.000+0000'), c('3', ME, '2026-01-01T03:00:00.000+0000')];
    expect(mergeComments(a, b).map((x) => x.id)).toEqual(['1', '2', '3']);
  });
});

describe('fetchCommentsForOutcome', () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) =>
    c(String(i), OTHER, new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString().replace('Z', '+0000')));

  it('fetches once when under the 100-comment cap', async () => {
    const fetcher = vi.fn(async () => many(5));
    expect(await fetchCommentsForOutcome('TEST-1', fetcher)).toHaveLength(5);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith('TEST-1');
  });

  it('also fetches the newest 100 at the cap and merges by id', async () => {
    const oldest = many(100);
    const newest = [...many(100).slice(50), ...Array.from({ length: 10 }, (_, i) =>
      c('n' + i, ME, new Date(Date.UTC(2026, 0, 2, 0, i)).toISOString().replace('Z', '+0000')))];
    const fetcher = vi.fn(async (_k: string, opts?: { newest?: boolean }) => (opts?.newest ? newest : oldest));
    const out = await fetchCommentsForOutcome('TEST-1', fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenLastCalledWith('TEST-1', { newest: true });
    expect(out).toHaveLength(110);
    expect(out[out.length - 1].id).toBe('n9');
  });
});

describe('captureJiraOutcome', () => {
  const ready = (over: Partial<ReadyDraftRow> = {}): ReadyDraftRow => ({
    key: 'TEST-1', summary: 's', marker: '', kind: 'new', outcome: 'draft',
    url: 'https://example.test/TEST-1', created_at: '2026-01-01T12:00:00Z', assigned_at: 1767268800, ...over,
  });

  function deps(over: Partial<CaptureDeps> = {}): CaptureDeps & { record: ReturnType<typeof vi.fn> } {
    const record = vi.fn(async () => {});
    return {
      getDraft: vi.fn(async () => draft()),
      getComments: vi.fn(async () => [c('1', ME, '2026-01-01T07:30:00.000-0500', 'Mine')]),
      getMyAccountId: vi.fn(async () => ME),
      listReady: vi.fn(async () => [ready()]),
      record,
      ...over,
    } as CaptureDeps & { record: ReturnType<typeof vi.fn> };
  }

  beforeEach(() => { resetOutcomeCaptureState(); });

  it('records a jira outcome with assigned_at converted from epoch seconds', async () => {
    const d = deps();
    expect(await captureJiraOutcome(d, 'TEST-1', 'Done')).toBe('recorded');
    expect(d.record).toHaveBeenCalledTimes(1);
    const row = d.record.mock.calls[0][0];
    expect(row).toMatchObject({ via: 'jira', posted_text: 'Mine', actual_status: 'Done', assigned_at: new Date(1767268800 * 1000).toISOString() });
  });

  it('assigned_at is null when the ticket is not in the ready list', async () => {
    const d = deps({ listReady: vi.fn(async () => []) });
    await captureJiraOutcome(d, 'TEST-1', 'Done');
    expect(d.record.mock.calls[0][0].assigned_at).toBeNull();
  });

  it('assigned_at is null when the ready list is unavailable', async () => {
    const d = deps({ listReady: vi.fn(async () => { throw new Error('down'); }) });
    expect(await captureJiraOutcome(d, 'TEST-1', 'Done')).toBe('recorded');
    expect(d.record.mock.calls[0][0].assigned_at).toBeNull();
  });

  it('prefers the draft remembered at ticket open over getDraft (poll may have superseded it)', async () => {
    rememberDraft(draft({ segments: [{ type: 'text', text: 'Remembered draft' }] }));
    const d = deps({ getDraft: vi.fn(async () => null) });
    await captureJiraOutcome(d, 'TEST-1', 'Done');
    expect(d.getDraft).not.toHaveBeenCalled();
    expect(d.record.mock.calls[0][0].draft_text).toBe('Remembered draft');
  });

  it('skips when there is no draft', async () => {
    const d = deps({ getDraft: vi.fn(async () => null) });
    expect(await captureJiraOutcome(d, 'TEST-1', 'Done')).toBe('no-draft');
    expect(d.record).not.toHaveBeenCalled();
  });

  it('skips drafts the card cannot post (move / no_new_angle)', async () => {
    const d = deps({ getDraft: vi.fn(async () => draft({ outcome: 'move' })) });
    expect(await captureJiraOutcome(d, 'TEST-1', 'Done')).toBe('not-postable');
    expect(d.record).not.toHaveBeenCalled();
  });

  it('skips when the card already recorded this draft this session', async () => {
    // Unique created_at: the posted-this-session set is module state with no reset.
    markPostedThisSession('TEST-1', '2026-02-02T00:00:00Z');
    const d = deps({ getDraft: vi.fn(async () => draft({ created_at: '2026-02-02T00:00:00Z' })) });
    expect(await captureJiraOutcome(d, 'TEST-1', 'Done')).toBe('card-recorded');
    expect(d.record).not.toHaveBeenCalled();
    expect(d.getComments).not.toHaveBeenCalled();
  });

  it('records a draft only once', async () => {
    const d = deps();
    await captureJiraOutcome(d, 'TEST-1', 'Done');
    expect(await captureJiraOutcome(d, 'TEST-1', 'Done')).toBe('already-recorded');
    expect(d.record).toHaveBeenCalledTimes(1);
  });

  it('allows a retry after a failed record', async () => {
    const d = deps({ record: vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue(undefined) });
    expect(await captureJiraOutcome(d, 'TEST-1', 'Done')).toBe('failed');
    expect(await captureJiraOutcome(d, 'TEST-1', 'Done')).toBe('recorded');
  });

  it('never throws when a lookup fails', async () => {
    const d = deps({ getComments: vi.fn(async () => { throw new Error('jira down'); }) });
    expect(await captureJiraOutcome(d, 'TEST-1', 'Done')).toBe('failed');
  });
});

describe('firstReplyAfterDraft', () => {
  it('is the earliest of my comments strictly after the draft', () => {
    const comments = [
      c('1', ME, '2026-01-01T06:00:00.000-0500', 'before'),
      c('2', OTHER, '2026-01-01T07:10:00.000-0500', 'someone else'),
      c('4', ME, '2026-01-01T08:00:00.000-0500', 'second'),
      c('3', ME, '2026-01-01T07:30:00.000-0500', 'first'),
    ];
    expect(firstReplyAfterDraft(draft(), comments, ME)?.id).toBe('3');
    expect(firstReplyAfterDraft(draft(), comments.slice(0, 2), ME)).toBeNull();
  });
});

describe('lookupAssignedAt', () => {
  const row = (over: Partial<ReadyDraftRow>): ReadyDraftRow => ({
    key: 'TEST-1', summary: '', marker: '', kind: 'new', outcome: 'draft', url: '', created_at: '', assigned_at: null, ...over,
  });
  it('converts epoch seconds to ISO for the matching key', async () => {
    const out = await lookupAssignedAt('TEST-1', async () => [row({ key: 'TEST-2', assigned_at: 5 }), row({ assigned_at: 1767268800 })]);
    expect(out).toBe(new Date(1767268800 * 1000).toISOString());
  });
  it('is null when missing, unassigned or the list fails', async () => {
    expect(await lookupAssignedAt('TEST-1', async () => [])).toBeNull();
    expect(await lookupAssignedAt('TEST-1', async () => [row({})])).toBeNull();
    expect(await lookupAssignedAt('TEST-1', async () => { throw new Error('down'); })).toBeNull();
  });
});

describe('checkExistingReply', () => {
  it('returns my reply after the draft with the comments and my account id', async () => {
    const comments = [c('1', ME, '2026-01-01T07:30:00.000-0500', 'Mine')];
    const r = await checkExistingReply(draft(), { getComments: async () => comments, getMyAccountId: async () => ME });
    expect(r.reply?.id).toBe('1');
    expect(r.me).toBe(ME);
    expect(r.comments).toBe(comments);
  });
  it('reply is null when I have not replied since the draft', async () => {
    const r = await checkExistingReply(draft(), {
      getComments: async () => [c('1', OTHER, '2026-01-01T07:30:00.000-0500', 'x')],
      getMyAccountId: async () => ME,
    });
    expect(r.reply).toBeNull();
  });
  it('propagates lookup failures (the caller decides)', async () => {
    await expect(checkExistingReply(draft(), {
      getComments: async () => { throw new Error('jira down'); }, getMyAccountId: async () => ME,
    })).rejects.toThrow('jira down');
  });
});

describe('captureJiraOutcome: workflow-handled and persisted card marks', () => {
  function deps(): CaptureDeps & { record: ReturnType<typeof vi.fn> } {
    return {
      getDraft: vi.fn(async () => draft()),
      getComments: vi.fn(async () => [c('1', ME, '2026-01-01T07:30:00.000-0500', 'Workflow comment')]),
      getMyAccountId: vi.fn(async () => ME),
      listReady: vi.fn(async () => []),
      record: vi.fn(async () => {}),
    } as CaptureDeps & { record: ReturnType<typeof vi.fn> };
  }
  beforeEach(() => { resetOutcomeCaptureState(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('writes no row for a ticket a workflow completed', async () => {
    void markWorkflowHandled('TEST-1');
    const d = deps();
    expect(await captureJiraOutcome(d, 'TEST-1', 'Done')).toBe('workflow-handled');
    expect(d.record).not.toHaveBeenCalled();
    expect(d.getComments).not.toHaveBeenCalled();
  });

  it('other tickets are unaffected', async () => {
    void markWorkflowHandled('TEST-7');
    const d = deps();
    expect(await captureJiraOutcome(d, 'TEST-1', 'Done')).toBe('recorded');
  });

  it('a workflow mark made before a panel reload still skips (chrome.storage.session)', async () => {
    const data: Record<string, unknown> = {};
    vi.stubGlobal('chrome', { storage: { session: {
      get: vi.fn(async (k: string) => (k in data ? { [k]: data[k] } : {})),
      set: vi.fn(async (items: Record<string, unknown>) => { Object.assign(data, items); }),
    } } });
    await markWorkflowHandled('TEST-1');
    resetOutcomeCaptureState(); // drops memory, as a reload would
    expect(await wasWorkflowHandled('TEST-1')).toBe(true);
    const d = deps();
    expect(await captureJiraOutcome(d, 'TEST-1', 'Done')).toBe('workflow-handled');
  });

  it('a card mark made before a panel reload still skips (no duplicate sidekick + jira rows)', async () => {
    const data: Record<string, unknown> = {};
    vi.stubGlobal('chrome', { storage: { session: {
      get: vi.fn(async (k: string) => (k in data ? { [k]: data[k] } : {})),
      set: vi.fn(async (items: Record<string, unknown>) => { Object.assign(data, items); }),
    } } });
    await markPostedThisSession('TEST-1', '2026-03-03T00:00:00Z');
    resetPostedMemoryForTests();
    const d = deps();
    d.getDraft = vi.fn(async () => draft({ created_at: '2026-03-03T00:00:00Z' }));
    expect(await captureJiraOutcome(d, 'TEST-1', 'Done')).toBe('card-recorded');
    expect(d.record).not.toHaveBeenCalled();
  });
});
