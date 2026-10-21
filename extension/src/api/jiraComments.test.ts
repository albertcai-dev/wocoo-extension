import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../auth/oauth', () => ({ getValidAccessToken: vi.fn(async () => 'tok') }));

import { getIssueCommentsDetailed } from './jira';

const adf = (text: string) => ({
  type: 'doc', version: 1,
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

function mockFetch(commentsResp: { ok: boolean; status?: number; body: unknown }) {
  const fn = vi.fn(async (url: string) => {
    if (String(url).includes('accessible-resources')) {
      return new Response(JSON.stringify([{ id: 'cloud-1', url: 'https://wealthsimple.atlassian.net' }]), { status: 200 });
    }
    return new Response(JSON.stringify(commentsResp.body), { status: commentsResp.status ?? 200 });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('getIssueCommentsDetailed', () => {
  it('maps ADF comments to detail rows', async () => {
    const fn = mockFetch({
      ok: true,
      body: { comments: [
        { id: '101', author: { accountId: 'acct-a' }, created: '2026-01-01T10:00:00.000-0500', body: adf('First note') },
        { id: '102', author: { accountId: 'acct-b' }, created: '2026-01-01T11:00:00.000-0500', body: adf('Second note') },
      ] },
    });
    const rows = await getIssueCommentsDetailed('TEST-1');
    expect(rows).toEqual([
      { id: '101', authorAccountId: 'acct-a', created: '2026-01-01T10:00:00.000-0500', text: 'First note' },
      { id: '102', authorAccountId: 'acct-b', created: '2026-01-01T11:00:00.000-0500', text: 'Second note' },
    ]);
    const url = String(fn.mock.calls.find((c) => String(c[0]).includes('/comment'))![0]);
    expect(url).toContain('/ex/jira/cloud-1/rest/api/3/issue/TEST-1/comment');
  });

  it('returns oldest first and tolerates missing author / body', async () => {
    mockFetch({
      ok: true,
      body: { comments: [
        { id: '2', author: { accountId: 'x' }, created: '2026-01-02T00:00:00.000+0000', body: adf('later') },
        { id: '1', created: '2026-01-01T00:00:00.000+0000' },
      ] },
    });
    const rows = await getIssueCommentsDetailed('TEST-1');
    expect(rows.map((r) => r.id)).toEqual(['1', '2']);
    expect(rows[0]).toMatchObject({ authorAccountId: '', text: '' });
  });

  it('asks for orderBy=-created with newest, and still returns oldest first', async () => {
    const fn = mockFetch({
      ok: true,
      body: { comments: [
        { id: '9', author: { accountId: 'x' }, created: '2026-01-09T00:00:00.000+0000', body: adf('newer') },
        { id: '8', author: { accountId: 'x' }, created: '2026-01-08T00:00:00.000+0000', body: adf('older') },
      ] },
    });
    const rows = await getIssueCommentsDetailed('TEST-1', { newest: true });
    const url = String(fn.mock.calls.find((c) => String(c[0]).includes('/comment'))![0]);
    expect(url).toContain('orderBy=-created');
    expect(rows.map((r) => r.id)).toEqual(['8', '9']);
  });

  it('defaults to orderBy=created', async () => {
    const fn = mockFetch({ ok: true, body: { comments: [] } });
    await getIssueCommentsDetailed('TEST-1');
    const url = String(fn.mock.calls.find((c) => String(c[0]).includes('/comment'))![0]);
    expect(url).toContain('orderBy=created');
    expect(url).not.toContain('-created');
  });

  it('throws with the HTTP status on failure', async () => {
    mockFetch({ ok: false, status: 404, body: { errorMessages: ['nope'] } });
    await expect(getIssueCommentsDetailed('TEST-1')).rejects.toThrow('HTTP 404');
  });
});

// --- comment ADF -> plain text (I3) and card-path multi-line ADF (M1) ---------------------

import { adfCommentToPlain, buildCommentAdf, postComment, extractDescription } from './jira';
import { segmentsToPlain } from '../data/agentDraftView';
import type { DraftSegment } from '../data/agentDraftTypes';

describe('adfCommentToPlain', () => {
  it('keeps mentions as "@Name" without doubling the @', () => {
    const body = { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [
      { type: 'text', text: 'Hi ' },
      { type: 'mention', attrs: { id: 'acct-1', text: '@Pat Example' } },
      { type: 'text', text: ' and ' },
      { type: 'mention', attrs: { id: 'acct-2', text: 'Sam Sample' } },
    ] }] };
    expect(adfCommentToPlain(body)).toBe('Hi @Pat Example and @Sam Sample');
  });

  it('emits the URL of inline and block cards', () => {
    const body = { type: 'doc', version: 1, content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'See ' }, { type: 'inlineCard', attrs: { url: 'https://example.test/a' } }] },
      { type: 'blockCard', attrs: { url: 'https://example.test/b' } },
    ] };
    expect(adfCommentToPlain(body)).toBe('See https://example.test/a\nhttps://example.test/b');
  });

  it('joins paragraphs with one newline and renders hardBreak as a newline', () => {
    const body = { type: 'doc', version: 1, content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'Line one' }, { type: 'hardBreak' }, { type: 'text', text: 'line two' }] },
      { type: 'paragraph', content: [] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Second para' }] },
    ] };
    expect(adfCommentToPlain(body)).toBe('Line one\nline two\nSecond para');
  });

  it('walks lists and passes plain strings through', () => {
    const body = { type: 'doc', version: 1, content: [{ type: 'bulletList', content: [
      { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' }] }] },
      { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'two' }] }] },
    ] }] };
    expect(adfCommentToPlain(body)).toBe('one\ntwo');
    expect(adfCommentToPlain('already text')).toBe('already text');
    expect(adfCommentToPlain(null)).toBe('');
  });

  it('leaves extractDescription unchanged (still drops mentions)', () => {
    const body = { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [
      { type: 'text', text: 'Hi ' }, { type: 'mention', attrs: { id: 'a', text: '@Pat' } },
    ] }] };
    expect(extractDescription(body)).toBe('Hi');
  });

  it('is what getIssueCommentsDetailed returns as text', async () => {
    mockFetch({ ok: true, body: { comments: [{ id: '1', author: { accountId: 'x' }, created: '2026-01-01T00:00:00.000+0000',
      body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [
        { type: 'mention', attrs: { id: 'a', text: '@Pat' } }, { type: 'text', text: ' done' }] }] } }] } });
    expect((await getIssueCommentsDetailed('TEST-1'))[0].text).toBe('@Pat done');
  });

  it('round trip: a posted draft with a mention and a link reads back as the draft text', async () => {
    const draft: DraftSegment[] = [
      { type: 'text', text: 'Hi ' },
      { type: 'mention', text: '@Pat Example', accountId: 'acct-1' },
      { type: 'text', text: ', the fee is reversed. Details: ' },
      { type: 'link', text: 'statement', href: 'https://example.test/statement' },
      { type: 'text', text: '.' },
    ];
    const fn = mockFetch({ ok: true, body: {} });
    await postComment('TEST-1', draft);
    const call = fn.mock.calls.find((c) => String(c[0]).endsWith('/comment'))!;
    const body = JSON.parse(String((call as unknown as [string, RequestInit])[1].body)).body;
    expect(adfCommentToPlain(body)).toBe(segmentsToPlain(draft));
  });
});

describe('buildCommentAdf', () => {
  const segs: DraftSegment[] = [
    { type: 'text', text: 'Hi ' },
    { type: 'mention', text: '@Pat', accountId: 'acct-1' },
    { type: 'text', text: ',\n\nFirst line\nsecond line\n\n\nLast' },
  ];

  it('default (existing callers): one paragraph, newlines left inside the text', () => {
    expect(buildCommentAdf(segs)).toEqual({ type: 'doc', version: 1, content: [{ type: 'paragraph', content: [
      { type: 'text', text: 'Hi ' },
      { type: 'mention', attrs: { id: 'acct-1', text: '@Pat' } },
      { type: 'text', text: ',\n\nFirst line\nsecond line\n\n\nLast' },
    ] }] });
  });

  it('multiline: blank lines start paragraphs, single newlines become hardBreaks', () => {
    expect(buildCommentAdf(segs, { multiline: true }).content).toEqual([
      { type: 'paragraph', content: [
        { type: 'text', text: 'Hi ' },
        { type: 'mention', attrs: { id: 'acct-1', text: '@Pat' } },
        { type: 'text', text: ',' },
      ] },
      { type: 'paragraph', content: [
        { type: 'text', text: 'First line' }, { type: 'hardBreak' }, { type: 'text', text: 'second line' },
      ] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Last' }] },
    ]);
  });

  it('multiline: CRLF, trailing blank lines and smartcards', () => {
    const adf = buildCommentAdf([
      { type: 'text', text: 'One\r\ntwo\n\n' },
      { type: 'smartcard', text: '', href: 'https://example.test/x' },
      { type: 'text', text: '\n\nAfter' },
    ], { multiline: true });
    expect(adf.content).toEqual([
      { type: 'paragraph', content: [{ type: 'text', text: 'One' }, { type: 'hardBreak' }, { type: 'text', text: 'two' }] },
      { type: 'blockCard', attrs: { url: 'https://example.test/x' } },
      { type: 'paragraph', content: [{ type: 'text', text: 'After' }] },
    ]);
  });

  it('multiline round trip reads back whitespace-equivalent to the draft text', () => {
    const plain = segmentsToPlain(segs);
    const back = adfCommentToPlain(buildCommentAdf(segs, { multiline: true }));
    const norm = (s: string) => s.split(/\s+/).join(' ').trim();
    expect(norm(back)).toBe(norm(plain));
  });

  it('postComment passes multiline through and defaults it off', async () => {
    const fn = mockFetch({ ok: true, body: {} });
    await postComment('TEST-1', [{ type: 'text', text: 'a\n\nb' }]);
    await postComment('TEST-1', [{ type: 'text', text: 'a\n\nb' }], { multiline: true });
    const bodies = fn.mock.calls.filter((c) => String(c[0]).endsWith('/comment'))
      .map((c) => JSON.parse(String((c as unknown as [string, RequestInit])[1].body)).body.content.length);
    expect(bodies).toEqual([1, 2]);
  });
});
