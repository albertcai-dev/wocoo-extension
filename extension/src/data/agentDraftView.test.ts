import { describe, it, expect, vi, afterEach } from 'vitest';
import type { WocooTicket } from './mockTicket';
import {
  segmentsToPlain, plainToSegments, canPost, flagLabel, postLabel, isHttpUrl,
  unresolvedMentionNames, applyMentionResolution,
  markPostedThisSession, wasPostedThisSession, shouldTransition, buildOutcomeRow,
  currentStatusName, resetPostedMemoryForTests,
} from './agentDraftView';
import type { AgentDraft, DraftSegment } from './agentDraftTypes';

function draft(over: Partial<AgentDraft> = {}): AgentDraft {
  return {
    schema: 1, ticket: 'TEST-1', kind: 'new', outcome: 'draft',
    created_at: '2026-01-01T00:00:00Z', ticket_updated: '2026-01-01T00:00:00Z',
    last_comment_id: null, work_type: 'Test Type', summary: 'A summary',
    segments: [{ type: 'text', text: 'Hi ' }, { type: 'mention', text: '@Jai Doe' }, { type: 'text', text: ', all sorted.' }],
    suggested_status: 'Done', move: null, action_needed: null, evidence: [], flags: [], compass_thread: null,
    ...over,
  };
}

const SEGS: DraftSegment[] = draft().segments;

describe('segmentsToPlain', () => {
  it('renders mention text verbatim', () => {
    expect(segmentsToPlain(SEGS)).toBe('Hi @Jai Doe, all sorted.');
  });
  it('renders links by text and smartcards by href, even when the smartcard has text', () => {
    const segs = [
      { type: 'link', text: 'the guide', href: 'https://example.test/g' },
      { type: 'text', text: ' and ' },
      { type: 'smartcard', href: 'https://example.test/c' },
      { type: 'smartcard', text: 'Some title', href: 'https://example.test/d' },
    ] as DraftSegment[];
    expect(segmentsToPlain(segs)).toBe('the guide and https://example.test/chttps://example.test/d');
  });
});

describe('plainToSegments', () => {
  it('keeps mention when @text unchanged', () => {
    const out = plainToSegments('Hi @Jai Doe, all sorted.', SEGS);
    expect(out.filter((s) => s.type === 'mention')).toEqual([{ type: 'mention', text: '@Jai Doe' }]);
    expect(segmentsToPlain(out)).toBe('Hi @Jai Doe, all sorted.');
  });
  it('keeps the accountId on a kept mention', () => {
    const segs: DraftSegment[] = [{ type: 'mention', text: '@Jai Doe', accountId: 'acc-1' }];
    expect(plainToSegments('x @Jai Doe', segs).find((s) => s.type === 'mention')?.accountId).toBe('acc-1');
  });
  it('drops mention when removed by edit', () => {
    const out = plainToSegments('Hi there, all sorted.', SEGS);
    expect(out.some((s) => s.type === 'mention')).toBe(false);
    expect(segmentsToPlain(out)).toBe('Hi there, all sorted.');
  });
  it('edited text is what gets posted', () => {
    const out = plainToSegments('Hi @Jai Doe, changed', SEGS);
    expect(segmentsToPlain(out)).toContain('changed');
    expect(segmentsToPlain(out)).not.toContain('all sorted');
  });
  it('re-attaches links and smartcards that still appear', () => {
    const segs = [
      { type: 'text', text: 'See ' },
      { type: 'link', text: 'the guide', href: 'https://example.test/g' },
      { type: 'text', text: ' now ' },
      { type: 'smartcard', href: 'https://example.test/c' },
    ] as DraftSegment[];
    const out = plainToSegments('See the guide now https://example.test/c', segs);
    expect(out.map((s) => s.type)).toEqual(['text', 'link', 'text', 'smartcard']);
    expect(out[1].href).toBe('https://example.test/g');
    expect(plainToSegments('See the guide only', segs).some((s) => s.type === 'smartcard')).toBe(false);
  });
  it('does not re-attach a link inside another word', () => {
    const segs = [{ type: 'text', text: 'Go ' }, { type: 'link', text: 'here', href: 'https://example.test/h' }] as DraftSegment[];
    expect(plainToSegments('Go there', segs).some((s) => s.type === 'link')).toBe(false);
    const out = plainToSegments('Go there or here', segs);
    expect(out.find((s) => s.type === 'link')).toMatchObject({ text: 'here', href: 'https://example.test/h' });
    expect(segmentsToPlain(out)).toBe('Go there or here');
  });
  it('re-attaches a smartcard by its href', () => {
    const segs = [{ type: 'smartcard', text: 'Title', href: 'https://example.test/c' }] as DraftSegment[];
    const out = plainToSegments('see https://example.test/c', segs);
    expect(out.map((s) => s.type)).toEqual(['text', 'smartcard']);
    expect(out[1].href).toBe('https://example.test/c');
  });
  it('returns a single text segment when there is nothing to re-attach', () => {
    expect(plainToSegments('plain', [{ type: 'text', text: 'old' }])).toEqual([{ type: 'text', text: 'plain' }]);
  });
});

describe('canPost', () => {
  const action = { summary: 'Reverse the fee', workflow: null };
  it('is false when action_needed and not ticked', () => {
    expect(canPost(draft({ action_needed: action }), false)).toBe(false);
  });
  it('is true when action_needed and ticked', () => {
    expect(canPost(draft({ action_needed: action }), true)).toBe(true);
  });
  it('is true when no action_needed', () => {
    expect(canPost(draft(), false)).toBe(true);
  });
  it('is false for no_new_angle and move', () => {
    expect(canPost(draft({ outcome: 'no_new_angle', segments: [] }), true)).toBe(false);
    expect(canPost(draft({ outcome: 'move' }), true)).toBe(false);
  });
  it('is false when the (edited) text is empty', () => {
    expect(canPost(draft(), false, '   ')).toBe(false);
  });
  it('needs_info is postable only with a non-empty ask', () => {
    expect(canPost(draft({ outcome: 'needs_info', segments: [] }), false)).toBe(false);
    expect(canPost(draft({ outcome: 'needs_info', segments: [] }), false, 'Could you confirm the date?')).toBe(true);
  });
});

describe('postLabel', () => {
  it('names the target status', () => {
    expect(postLabel(draft())).toBe('Post + mark Done');
    expect(postLabel(draft({ suggested_status: 'Pending Internal' }))).toBe('Post + mark Pending Internal');
  });
  it('is just Post when no status is suggested', () => {
    expect(postLabel(draft({ suggested_status: null }))).toBe('Post');
  });
});

describe('flagLabel', () => {
  it('maps every flag to its copy', () => {
    expect(flagLabel('thin_precedent')).toBe('Thin precedent');
    expect(flagLabel('docs_silent')).toBe("Docs don't cover this");
    expect(flagLabel('guide_vs_precedent')).toBe('Guide differs from recent precedent');
    expect(flagLabel('cxo_differs')).toBe('CXO doc differs from ops practice');
    expect(flagLabel('no_new_angle')).toBe('No new angle found');
    expect(flagLabel('compass_no_reply')).toBe("Compass didn't answer");
    expect(flagLabel('i2c_deferred')).toBe('i2c not checked yet');
    expect(flagLabel('amount_mismatch')).toBe("Amounts don't match the description");
  });
});

describe('mention resolution', () => {
  const jai = { accountId: 'acc-jai', displayName: 'Jai Doe' };
  const other = { accountId: 'acc-other', displayName: 'Jai Doe Two' };

  it('lists mention names without an accountId, deduplicated, without the @', () => {
    const segs: DraftSegment[] = [
      { type: 'mention', text: '@Jai Doe' }, { type: 'mention', text: '@Jai Doe' },
      { type: 'mention', text: '@Ann Roe', accountId: 'x' },
    ];
    expect(unresolvedMentionNames(segs)).toEqual(['Jai Doe']);
  });
  it('1 match sets the accountId', () => {
    const r = applyMentionResolution(SEGS, { 'Jai Doe': [jai] });
    expect(r.segments[1]).toEqual({ type: 'mention', text: '@Jai Doe', accountId: 'acc-jai' });
    expect(r.unresolved).toEqual([]);
  });
  it('0 matches posts as plain text and reports it', () => {
    const r = applyMentionResolution(SEGS, { 'Jai Doe': [] });
    expect(r.segments[1]).toEqual({ type: 'text', text: '@Jai Doe' });
    expect(r.unresolved).toEqual(['@Jai Doe']);
  });
  it('2 matches posts as plain text and reports it', () => {
    const r = applyMentionResolution(SEGS, { 'Jai Doe': [jai, other] });
    expect(r.segments[1].type).toBe('text');
    expect(r.unresolved).toEqual(['@Jai Doe']);
  });
  it('a failed lookup (missing key) is treated as unresolved', () => {
    expect(applyMentionResolution(SEGS, {}).unresolved).toEqual(['@Jai Doe']);
  });
  it('leaves mentions that already carry an accountId alone', () => {
    const segs: DraftSegment[] = [{ type: 'mention', text: '@Jai Doe', accountId: 'acc-1' }];
    const r = applyMentionResolution(segs, {});
    expect(r.segments).toEqual(segs);
    expect(r.unresolved).toEqual([]);
  });
});

describe('posted-this-session tracking', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('remembers a posted draft by key and created_at', async () => {
    expect(await wasPostedThisSession('TEST-9', 't1')).toBe(false);
    void markPostedThisSession('TEST-9', 't1');
    expect(await wasPostedThisSession('TEST-9', 't1')).toBe(true);
    expect(await wasPostedThisSession('TEST-9', 't2')).toBe(false);
  });

  it('persists to chrome.storage.session and reads it back after a panel reload', async () => {
    const data: Record<string, unknown> = {};
    vi.stubGlobal('chrome', { storage: { session: {
      get: vi.fn(async (k: string) => (k in data ? { [k]: data[k] } : {})),
      set: vi.fn(async (items: Record<string, unknown>) => { Object.assign(data, items); }),
    } } });
    await markPostedThisSession('TEST-8', 't1');
    expect(Object.keys(data)).toHaveLength(1);
    resetPostedMemoryForTests();
    expect(await wasPostedThisSession('TEST-8', 't1')).toBe(true);
    expect(await wasPostedThisSession('TEST-8', 't2')).toBe(false);
  });
});

describe('isHttpUrl', () => {
  it('accepts http(s) only', () => {
    expect(isHttpUrl('https://example.test/x')).toBe(true);
    expect(isHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isHttpUrl(null)).toBe(false);
  });
});

describe('shouldTransition', () => {
  it('is false with no suggested status', () => {
    expect(shouldTransition(null, 'Triage')).toBe(false);
  });
  it('is false when the ticket is already in the suggested status, ignoring case', () => {
    expect(shouldTransition('Done', 'Done')).toBe(false);
    expect(shouldTransition('done', 'DONE')).toBe(false);
  });
  it('is true when the status differs', () => {
    expect(shouldTransition('Done', 'Triage')).toBe(true);
  });
});

describe('currentStatusName', () => {
  const t = (over: Partial<Pick<WocooTicket, 'status' | 'jiraStatus'>>) =>
    ({ status: 'Other', ...over }) as Pick<WocooTicket, 'status' | 'jiraStatus'>;

  it('uses the raw Jira status name when it is still current', () => {
    const ticket = t({ status: 'Cancelled', jiraStatus: { name: 'Cancelled/ No Action', bucket: 'Cancelled' } });
    expect(currentStatusName(ticket)).toBe('Cancelled/ No Action');
    expect(shouldTransition('Cancelled/ No Action', currentStatusName(ticket))).toBe(false);
  });

  it('distinguishes raw statuses that share a bucket', () => {
    const ticket = t({ status: 'Pending', jiraStatus: { name: 'Pending External', bucket: 'Pending' } });
    expect(shouldTransition('Pending Customer', currentStatusName(ticket))).toBe(true);
  });

  it('falls back to the bucket when there is no raw name', () => {
    expect(currentStatusName(t({ status: 'Triage' }))).toBe('Triage');
  });

  it('falls back to the bucket when a later update changed status but not the raw name', () => {
    // e.g. a workflow did onTicketUpdate({ ...ticket, status: 'Done' })
    const ticket = t({ status: 'Done', jiraStatus: { name: 'Triage', bucket: 'Triage' } });
    expect(currentStatusName(ticket)).toBe('Done');
    expect(shouldTransition('Done', currentStatusName(ticket))).toBe(false);
  });
});

describe('buildOutcomeRow', () => {
  it('has the sidekick payload shape', () => {
    const d = draft({ flags: ['thin_precedent'] });
    const row = buildOutcomeRow(d, 'edited text', { id: 'TEST-1' }, 'Triage');
    expect(row).toMatchObject({
      key: 'TEST-1', work_type: 'Test Type', draft_created_at: '2026-01-01T00:00:00Z',
      via: 'sidekick', draft_text: 'Hi @Jai Doe, all sorted.', posted_text: 'edited text',
      suggested_status: 'Done', actual_status: 'Triage', flags: ['thin_precedent'], assigned_at: null,
    });
    expect(Number.isNaN(Date.parse(row.recorded_at))).toBe(false);
  });

  it('accepts via, assigned_at and a null posted_text for the jira path', () => {
    const row = buildOutcomeRow(draft(), null, { id: 'TEST-1' }, 'Done', { via: 'jira', assignedAt: '2026-01-01T00:00:00.000Z' });
    expect(row).toMatchObject({ via: 'jira', posted_text: null, assigned_at: '2026-01-01T00:00:00.000Z' });
  });
});
