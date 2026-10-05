import { describe, expect, it } from 'vitest';
import {
  buildCreateAndLogItems, canRunStep3, chunkByEncodedSize, defaultSelected, EMPTY_RUN, earlierDraftRow, earlierRunResolution, formatSkippedLine, mergeResolutions, nextLogStatus, rowsToResolve,
  nextAction, shouldShowClientEmail, sortSkippedNewestFirst, summarizeRows, unloggedCount, unsentDraftCount, unsentLoggedCount, type RunRow, type RunState,
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

describe('formatSkippedLine / sortSkippedNewestFirst', () => {
  it('formats date · from · subject', () => {
    expect(formatSkippedLine({ subject: 'Hello', from: 'a@b.com', date: '2026-10-04T15:00:00.000Z' })).toBe('2026-10-04 · a@b.com · Hello');
  });
  it('truncates long subjects to 120 chars with an ellipsis', () => {
    const line = formatSkippedLine({ subject: 'x'.repeat(300), from: 'a@b.com', date: '2026-10-04' });
    expect(line).toBe('2026-10-04 · a@b.com · ' + 'x'.repeat(119) + '…');
  });
  it('sorts newest first without mutating', () => {
    const items = [
      { subject: 'old', from: 'a', date: '2026-10-01T00:00:00Z' },
      { subject: 'new', from: 'a', date: '2026-10-04T00:00:00Z' },
    ];
    expect(sortSkippedNewestFirst(items).map((i) => i.subject)).toEqual(['new', 'old']);
    expect(items[0].subject).toBe('old');
  });
});

describe('shouldShowClientEmail', () => {
  it('shows the matched email whenever we have one', () => {
    expect(shouldShowClientEmail({ ...base, clientEmail: 'real.address@example.com' })).toBe(true);
  });
  it('hides it when there is none', () => {
    expect(shouldShowClientEmail({ ...base, clientEmail: null })).toBe(false);
    expect(shouldShowClientEmail({ ...base, clientEmail: '' })).toBe(false);
  });
});

describe('summarizeRows', () => {
  it('buckets each row exactly once', () => {
    const rows = [
      row({ res: base }),
      row({ res: { ...base, status: 'needs_review', flags: ['delinquent'] } }),
      row({ res: noMatch }),
      row({ res: base, draftId: 'd1' }),
      row({ res: base, draftId: 'd2', sent: 'ok' }),
      row({ res: null, draftId: 'd3', earlier: true }),
      row({ res: null }),
    ];
    expect(summarizeRows(rows)).toEqual({ total: 7, ready: 1, review: 1, noMatch: 1, drafted: 2, sent: 1, pending: 1 });
  });
  it('is all zeros but total for an empty list', () => {
    expect(summarizeRows([])).toEqual({ total: 0, ready: 0, review: 0, noMatch: 0, drafted: 0, sent: 0, pending: 0 });
  });
});

describe('nextAction', () => {
  const run = (over: Partial<RunState>): RunState => ({ ...EMPTY_RUN, stage: 'resolved', ...over });
  it('busy wins', () => {
    expect(nextAction(run({ rows: [row({})] }), true, false)).toEqual({ kind: 'busy', count: 0 });
  });
  it('fetch while idle', () => {
    expect(nextAction(EMPTY_RUN, false, false)).toEqual({ kind: 'fetch', count: 0 });
  });
  it('resolve counts unresolved rows', () => {
    expect(nextAction(run({ stage: 'fetched', rows: [row({ res: null }), row({ res: null }), row({ res: base })] }), false, false))
      .toEqual({ kind: 'resolve', count: 2 });
  });
  it('draft when drafts are waiting, counting only selected bodies', () => {
    const rows = [row({ selected: true, draftBody: 'hi' }), row({ selected: false, draftBody: 'hi' })];
    expect(nextAction(run({ rows }), false, false)).toEqual({ kind: 'draft', count: 1 });
  });
  it('draft with count 0 when only logging remains', () => {
    expect(nextAction(run({ rows: [row({ res: noMatch })] }), false, false)).toEqual({ kind: 'draft', count: 0 });
  });
  it('send, then confirm, when drafts are unsent', () => {
    const rows = [row({ draftId: 'd1', logged: true }), row({ draftId: 'd2', logged: true })];
    expect(nextAction(run({ stage: 'drafted', rows }), false, false)).toEqual({ kind: 'send', count: 2 });
    expect(nextAction(run({ stage: 'drafted', rows }), false, true)).toEqual({ kind: 'confirm', count: 2 });
  });
  it('retryLog when sent but not logged', () => {
    const rows = [row({ draftId: 'd1', sent: 'ok', logged: true, sentLogged: false })];
    expect(nextAction(run({ stage: 'sent', rows }), false, false)).toEqual({ kind: 'retryLog', count: 1 });
  });
  it('done when everything is sent and logged', () => {
    const rows = [row({ draftId: 'd1', sent: 'ok', logged: true, sentLogged: true })];
    expect(nextAction(run({ stage: 'sent', rows }), false, false)).toEqual({ kind: 'done', count: 0 });
  });
});

describe('chunkByEncodedSize', () => {
  const len = (s: string) => s.length;
  it('returns [] for empty input', () => {
    expect(chunkByEncodedSize([], 10, len)).toEqual([]);
  });
  it('packs greedily in order without exceeding the limit', () => {
    expect(chunkByEncodedSize(['aaa', 'bbb', 'cc', 'dddd', 'e'], 6, len)).toEqual([['aaa', 'bbb'], ['cc', 'dddd'], ['e']]);
  });
  it('puts an item larger than the limit in its own chunk', () => {
    expect(chunkByEncodedSize(['aa', 'xxxxxxxxxx', 'bb', 'cc'], 5, len)).toEqual([['aa'], ['xxxxxxxxxx'], ['bb', 'cc']]);
  });
  it('never yields an empty chunk, even when the first item is oversized', () => {
    const out = chunkByEncodedSize(['xxxxxxxxxx', 'yyyyyyyyyy'], 5, len);
    expect(out).toEqual([['xxxxxxxxxx'], ['yyyyyyyyyy']]);
    expect(out.every((c) => c.length > 0)).toBe(true);
  });
});

describe('buildCreateAndLogItems', () => {
  const req = (messageId: string) => ({ messageId, threadId: 't-' + messageId, insurerEmail: 'ins@x.com', claimNumber: null } as EligibilityRequest);

  it('sends the draft body for rows that need a draft, logged as DRAFTED with no draft id yet', () => {
    const items = buildCreateAndLogItems([row({ req: req('a'), selected: true, draftBody: 'hello', logged: true })]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ messageId: 'a', body: 'hello', row: { request_message_id: 'a', status: 'DRAFTED', draft_id: '' } });
  });

  it('sends log-only items for resolved rows not yet logged', () => {
    const items = buildCreateAndLogItems([
      row({ req: req('b'), res: noMatch }),
      row({ req: req('c'), selected: false, draftBody: 'unticked' }),
      row({ req: req('d'), selected: true, draftBody: 'hi', draftId: 'd1', logged: false }),
    ]);
    expect(items.map((i) => [i.messageId, i.body, i.row.status, i.row.draft_id])).toEqual([
      ['b', '', 'NO_MATCH', ''],
      ['c', '', 'NEEDS_REVIEW', ''],
      ['d', '', 'DRAFTED', 'd1'],
    ]);
  });

  it('skips already-logged rows, unresolved rows and earlier-run rows', () => {
    expect(buildCreateAndLogItems([
      row({ req: req('e'), res: noMatch, logged: true }),
      row({ req: req('f'), selected: true, draftBody: 'hi', draftId: 'd2', logged: true }),
      row({ req: req('g'), res: null }),
      earlierDraftRow(req('h'), 'd3'),
    ])).toEqual([]);
  });
});
