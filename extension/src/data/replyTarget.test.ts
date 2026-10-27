import { describe, it, expect } from 'vitest';
import type { JiraCommentDetail } from '../api/jira';
import type { DraftSegment } from './agentDraftTypes';
import { greetTarget, pickReplyTarget, replyParentId, stripReplyGreeting, type ReplyTarget } from './replyTarget';

const TEAM = new Set(['acct-team-1', 'acct-team-2']);

let seq = 0;
const c = (author: string, name: string, opts: Partial<JiraCommentDetail> = {}): JiraCommentDetail => {
  seq += 1;
  return {
    id: String(100 + seq),
    authorAccountId: author,
    authorName: name,
    authorAccountType: 'atlassian',
    parentId: null,
    created: `2026-01-01T${String(seq).padStart(2, '0')}:00:00.000-0500`,
    text: '',
    ...opts,
  };
};

describe('pickReplyTarget', () => {
  it('returns null for no comments', () => {
    expect(pickReplyTarget([], TEAM)).toBeNull();
  });

  it('returns null when only team and app comments', () => {
    const cs = [c('acct-bot', 'Automation for Jira', { authorAccountType: 'app' }), c('acct-team-1', 'Teammate')];
    expect(pickReplyTarget(cs, TEAM)).toBeNull();
  });

  it("skips the newest comment when it is the team's (Albert's question)", () => {
    const agent = c('acct-cx', 'CX Agent');
    const cs = [agent, c('acct-team-1', 'Me')];
    expect(pickReplyTarget(cs, TEAM)?.commentId).toBe(agent.id);
  });

  it('skips app accounts', () => {
    const agent = c('acct-cx', 'CX Agent');
    const cs = [agent, c('acct-bot', 'Automation for Jira', { authorAccountType: 'app' })];
    expect(pickReplyTarget(cs, TEAM)?.commentId).toBe(agent.id);
  });

  it('picks the most recent of several outsiders', () => {
    const first = c('acct-cx-1', 'First Agent');
    const second = c('acct-cx-2', 'Second Agent');
    const t = pickReplyTarget([first, second], TEAM);
    expect(t).toEqual<ReplyTarget>({ commentId: second.id, parentId: null, accountId: 'acct-cx-2', name: 'Second Agent' });
  });

  it('a non-CX outsider still counts', () => {
    const agent = c('acct-cx', 'CX Agent');
    const eng = c('acct-eng', 'Eng Person');
    expect(pickReplyTarget([agent, eng], TEAM)?.accountId).toBe('acct-eng');
  });

  it('customer accounts count as people', () => {
    const cust = c('acct-cust', 'Customer', { authorAccountType: 'customer' });
    expect(pickReplyTarget([cust], TEAM)?.accountId).toBe('acct-cust');
  });

  it('skips WS Compass, which posts as a regular user account', () => {
    const agent = c('acct-cx', 'CX Agent');
    const compass = c('acct-compass', 'WS Compass');
    expect(pickReplyTarget([agent, compass], TEAM)?.commentId).toBe(agent.id);
    expect(pickReplyTarget([compass], TEAM)).toBeNull();
  });

  it('carries the target comment parentId', () => {
    const reply = c('acct-cx', 'CX Agent', { parentId: '555' });
    expect(pickReplyTarget([reply], TEAM)?.parentId).toBe('555');
  });
});

const T: ReplyTarget = { commentId: '9', parentId: null, accountId: 'acct-t', name: 'Target Person' };
const text = (t: string): DraftSegment => ({ type: 'text', text: t });
const mention = (name: string, accountId?: string): DraftSegment => ({ type: 'mention', text: `@${name}`, ...(accountId ? { accountId } : {}) });

describe('greetTarget', () => {
  it('keeps a greeting that already tags the target', () => {
    const segs = [text('Hi '), mention('Target Person', 'acct-t'), text(', I checked')];
    expect(greetTarget(segs, T)).toEqual(segs);
  });

  it('swaps greeting mention', () => {
    const segs = [text('Hi '), mention('Reporter', 'acct-r'), text(', I checked')];
    expect(greetTarget(segs, T)).toEqual([text('Hi '), mention('Target Person', 'acct-t'), text(', I checked')]);
  });

  it('adds a greeting when there is no mention', () => {
    expect(greetTarget([text('I checked')], T)).toEqual([text('Hi '), mention('Target Person', 'acct-t'), text(', '), text('I checked')]);
  });

  it('leaves later mentions alone', () => {
    const segs = [text('I checked with '), mention('Someone', 'acct-s'), text('.')];
    const out = greetTarget(segs, T);
    expect(out.slice(0, 3)).toEqual([text('Hi '), mention('Target Person', 'acct-t'), text(', ')]);
    expect(out.slice(3)).toEqual(segs);
  });

  it('treats a mention with no greeting word before it as the greeting', () => {
    const segs = [mention('Reporter', 'acct-r'), text(' please confirm')];
    expect(greetTarget(segs, T)).toEqual([mention('Target Person', 'acct-t'), text(' please confirm')]);
  });

  it('matches the target by name when the draft mention has no accountId yet', () => {
    const segs = [text('Hi '), mention('Target Person'), text(', ok')];
    expect(greetTarget(segs, T)).toEqual([text('Hi '), mention('Target Person', 'acct-t'), text(', ok')]);
  });
});

describe('stripReplyGreeting', () => {
  it("removes Jira's leading mention", () => {
    expect(stripReplyGreeting('@Jenn Hi, x', 'Jenn')).toBe('Hi, x');
  });

  it('keeps a mention inside the greeting', () => {
    expect(stripReplyGreeting('Hi @Jenn, x', 'Jenn')).toBe('Hi @Jenn, x');
  });

  it('removes one leading mention followed by the greeting', () => {
    expect(stripReplyGreeting('@Jenn Hi @Jenn, ok', 'Jenn')).toBe('Hi @Jenn, ok');
  });

  it('leaves text alone with no target name', () => {
    expect(stripReplyGreeting('@Jenn Hi, x', null)).toBe('@Jenn Hi, x');
  });
});

describe('replyParentId', () => {
  it('reply to a top-level comment uses its id', () => {
    expect(replyParentId({ commentId: '9', parentId: null, accountId: 'a', name: 'A' })).toBe('9');
  });

  it('reply to a reply uses the thread root', () => {
    // Jira threads are one level deep: parentId must be a top-level comment (WOCOO-29976 400'd).
    expect(replyParentId({ commentId: '9', parentId: '5', accountId: 'a', name: 'A' })).toBe('5');
  });
});
