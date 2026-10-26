import { describe, expect, it } from 'vitest';
import {
  agentCardView,
  normaliseAgentStatus,
  STEP_ROWS,
  systemLabel,
  type AgentStatus,
} from './agentStatus';

const NOW = 1_800_000_000;

/** A running status with nothing in flight, overridable per test. */
function status(over: Partial<AgentStatus> = {}): AgentStatus {
  return {
    mode: 'running',
    since: null,
    solo: null,
    tick: { phase: 'ended', at: NOW - 60, pollFailures: 0, nextCheckAt: NOW + 240, stale: false },
    current: null,
    waiting: [],
    queue: [{ key: 'Q-1', summary: 'Queued one', tag: null }],
    typicalS: null,
    lastDrafted: null,
    draftedToday: 0,
    ...over,
  };
}

type Current = NonNullable<AgentStatus['current']>;
function current(over: Partial<Current> = {}): Current {
  return {
    key: 'CUR-1',
    summary: 'Current ticket',
    system: null,
    kind: null,
    resumeReason: null,
    stage: 'gather',
    begunAt: NOW - 120,
    attempts: 0,
    maxAttempts: 3,
    steps: [],
    deadlineAt: null,
    ...over,
  };
}

function rowStates(s: AgentStatus) {
  const v = agentCardView(s, NOW);
  return Object.fromEntries(v.current!.rows.map((r) => [r.id, r.state]));
}

describe('STEP_ROWS and systemLabel', () => {
  it('lists the six rows in table order with exact labels', () => {
    expect(STEP_ROWS).toEqual([
      { id: 'read', label: 'Read ticket & client email' },
      { id: 'preset', label: 'Checking Preset' },
      { id: 'lookup', label: 'i2c / KOHO lookup' },
      { id: 'precedent', label: 'Precedent & guides' },
      { id: 'compass', label: 'Ask Compass' },
      { id: 'write', label: 'Write draft' },
    ]);
  });

  it('labels known systems and nulls the rest', () => {
    expect(systemLabel('i2c_credit')).toBe('i2c credit');
    expect(systemLabel('i2c_prepaid')).toBe('i2c prepaid');
    expect(systemLabel('koho')).toBe('KOHO prepaid');
    expect(systemLabel('atlas')).toBe('Atlas');
    expect(systemLabel('none')).toBeNull();
    expect(systemLabel(null)).toBeNull();
    expect(systemLabel('mystery')).toBeNull();
  });
});

describe('normaliseAgentStatus', () => {
  it('never throws on junk and yields a safe paused status', () => {
    for (const junk of [undefined, null, 42, 'x', [], { mode: 'sleeping' }]) {
      const s = normaliseAgentStatus(junk);
      expect(s.mode).toBe('paused');
      expect(s.current).toBeNull();
      expect(s.waiting).toEqual([]);
      expect(s.queue).toEqual([]);
      expect(s.tick).toEqual({ phase: null, at: null, pollFailures: 0, nextCheckAt: null, stale: false });
      expect(s.typicalS).toBeNull();
      expect(s.lastDrafted).toBeNull();
      expect(s.draftedToday).toBe(0);
    }
  });

  it('camelCases a full reply', () => {
    const s = normaliseAgentStatus({
      ok: true,
      mode: 'running',
      since: 10,
      solo: 'S-1',
      tick: { phase: 'draining', at: 20, poll_failures: 2, next_check_at: 30, stale: false },
      current: {
        key: 'C-1', summary: 'Sum', system: 'koho', kind: 'draft', resume_reason: 'compass_answered',
        stage: 'write', begun_at: 5, attempts: 1, max_attempts: 3,
        steps: [{ step: 'read', at: 6 }], deadline_at: 1505,
      },
      waiting: [{ key: 'W-1', summary: 'Wait', asked_at: 1, timeout_at: 1801 }],
      queue: [{ key: 'Q-1', summary: 'Q', tag: 'solve' }],
      typical_s: 400.5,
      last_drafted: { key: 'L-1', at: 3 },
      drafted_today: 4,
    });
    expect(s).toEqual({
      mode: 'running',
      since: 10,
      solo: 'S-1',
      tick: { phase: 'draining', at: 20, pollFailures: 2, nextCheckAt: 30, stale: false },
      current: {
        key: 'C-1', summary: 'Sum', system: 'koho', kind: 'draft', resumeReason: 'compass_answered',
        stage: 'write', begunAt: 5, attempts: 1, maxAttempts: 3,
        steps: [{ step: 'read', at: 6 }], deadlineAt: 1505,
      },
      waiting: [{ key: 'W-1', summary: 'Wait', askedAt: 1, timeoutAt: 1801 }],
      queue: [{ key: 'Q-1', summary: 'Q', tag: 'solve' }],
      typicalS: 400.5,
      lastDrafted: { key: 'L-1', at: 3 },
      draftedToday: 4,
    });
  });

  it('drops malformed entries, unknown steps and tags, and nulls non-finite numbers', () => {
    const s = normaliseAgentStatus({
      mode: 'running',
      since: NaN,
      solo: 7,
      tick: { phase: 3, at: 'x', poll_failures: null, next_check_at: Infinity, stale: 'yes' },
      current: {
        key: 'C-1', begun_at: 'soon', attempts: 'x',
        steps: [{ step: 'read', at: 1 }, { step: 'route', at: 2 }, { at: 3 }, null, { step: 'write', at: 'x' }],
      },
      waiting: [{ summary: 'no key' }, { key: 'W-2', asked_at: null }],
      queue: 'nope',
      typical_s: '400',
      last_drafted: { at: 3 },
      drafted_today: 'many',
    });
    expect(s.since).toBeNull();
    expect(s.solo).toBeNull();
    expect(s.tick).toEqual({ phase: null, at: null, pollFailures: 0, nextCheckAt: null, stale: false });
    expect(s.current).toMatchObject({
      key: 'C-1', summary: '', system: null, begunAt: null, attempts: 0, maxAttempts: 3,
      steps: [{ step: 'read', at: 1 }], deadlineAt: null,
    });
    expect(s.waiting).toEqual([{ key: 'W-2', summary: '', askedAt: null, timeoutAt: null }]);
    expect(s.queue).toEqual([]);
    expect(s.typicalS).toBeNull();
    expect(s.lastDrafted).toBeNull();
    expect(s.draftedToday).toBe(0);
  });

  it('nulls an unknown queue tag and a current without a key', () => {
    const s = normaliseAgentStatus({
      mode: 'running',
      current: { summary: 'keyless' },
      queue: [{ key: 'Q-1', tag: 'urgent' }, { key: 'Q-2', tag: 'reply' }],
    });
    expect(s.current).toBeNull();
    expect(s.queue).toEqual([
      { key: 'Q-1', summary: '', tag: null },
      { key: 'Q-2', summary: '', tag: 'reply' },
    ]);
  });
});

describe('agentCardView: working rows and bar', () => {
  it('marks reported rows done with times, the last as now, and the rest todo', () => {
    const v = agentCardView(
      status({
        current: current({
          system: 'i2c_credit',
          steps: [
            { step: 'read', at: NOW - 100 },
            { step: 'preset', at: NOW - 70 },
            { step: 'lookup', at: NOW - 30 },
          ],
        }),
      }),
      NOW,
    );
    const c = v.current!;
    expect(c.key).toBe('CUR-1');
    expect(c.system).toBe('i2c credit');
    expect(c.elapsedS).toBe(120);
    expect(c.rows).toEqual([
      { id: 'read', label: 'Read ticket & client email', state: 'done', seconds: 30 },
      { id: 'preset', label: 'Checking Preset', state: 'done', seconds: 40 },
      { id: 'lookup', label: 'i2c / KOHO lookup', state: 'now', seconds: 30 },
      { id: 'precedent', label: 'Precedent & guides', state: 'todo', seconds: null },
      { id: 'compass', label: 'Ask Compass', state: 'todo', seconds: null },
      { id: 'write', label: 'Write draft', state: 'todo', seconds: null },
    ]);
    expect(c.barPct).toBe(33); // 2 / 6
    expect(c.slow).toBeNull();
    expect(v.idleLine).toBeNull();
    expect(v.emptyFooter).toBeNull();
  });

  it('has an all-todo checklist and a zero bar before any step', () => {
    const v = agentCardView(status({ current: current() }), NOW);
    expect(v.current!.rows.every((r) => r.state === 'todo')).toBe(true);
    expect(v.current!.barPct).toBe(0);
  });

  it('handles steps out of table order: last reported is now, earlier unreported is skipped', () => {
    const s = status({
      current: current({ steps: [{ step: 'lookup', at: NOW - 50 }, { step: 'preset', at: NOW - 20 }] }),
    });
    expect(rowStates(s)).toEqual({
      read: 'skipped', preset: 'now', lookup: 'done', precedent: 'todo', compass: 'todo', write: 'todo',
    });
    const v = agentCardView(s, NOW);
    expect(v.current!.rows.find((r) => r.id === 'lookup')!.seconds).toBe(30);
    expect(v.current!.barPct).toBe(20); // 1 done / (6 - 1 skipped)
  });

  it('never marks a re-reported step done twice', () => {
    const s = status({
      current: current({
        steps: [{ step: 'preset', at: NOW - 90 }, { step: 'lookup', at: NOW - 60 }, { step: 'preset', at: NOW - 10 }],
      }),
    });
    const v = agentCardView(s, NOW);
    expect(rowStates(s)).toMatchObject({ preset: 'now', lookup: 'done', read: 'skipped' });
    expect(v.current!.rows.filter((r) => r.state === 'done')).toHaveLength(1);
  });

  it('skips compass once write is reported, with a denominator of 5', () => {
    const s = status({
      current: current({
        stage: 'write',
        steps: [
          { step: 'read', at: NOW - 100 },
          { step: 'preset', at: NOW - 90 },
          { step: 'lookup', at: NOW - 80 },
          { step: 'precedent', at: NOW - 70 },
          { step: 'write', at: NOW - 10 },
        ],
      }),
    });
    expect(rowStates(s)).toEqual({
      read: 'done', preset: 'done', lookup: 'done', precedent: 'done', compass: 'skipped', write: 'now',
    });
    expect(agentCardView(s, NOW).current!.barPct).toBe(80); // 4 / 5
  });

  it('on a compass resume with no steps, shows gather rows and compass done without times, write now', () => {
    const v = agentCardView(
      status({ current: current({ resumeReason: 'compass_answered', stage: 'write', steps: [] }) }),
      NOW,
    );
    const rows = v.current!.rows;
    for (const id of ['read', 'preset', 'lookup', 'precedent', 'compass']) {
      expect(rows.find((r) => r.id === id)).toMatchObject({ state: 'done', seconds: null });
    }
    expect(rows.find((r) => r.id === 'write')!.state).toBe('now');
    expect(v.current!.barPct).toBe(83); // 5 / 6, never 0
  });

  it('on a compass resume, ignores reported gather steps and follows only write', () => {
    const before = status({
      current: current({ resumeReason: 'compass_timeout', stage: 'gather', steps: [{ step: 'lookup', at: NOW - 5 }] }),
    });
    expect(rowStates(before)).toEqual({
      read: 'done', preset: 'done', lookup: 'done', precedent: 'done', compass: 'done', write: 'todo',
    });
    expect(agentCardView(before, NOW).current!.rows.find((r) => r.id === 'lookup')!.seconds).toBeNull();

    const writing = status({
      current: current({ resumeReason: 'compass_answered', stage: 'write', steps: [{ step: 'write', at: NOW - 5 }] }),
    });
    expect(rowStates(writing).write).toBe('now');
  });
});

describe('agentCardView: attempt and slow', () => {
  it('shows attempt only when attempts > 0', () => {
    expect(agentCardView(status({ current: current({ attempts: 0 }) }), NOW).current!.attempt).toBeNull();
    expect(agentCardView(status({ current: current({ attempts: 1 }) }), NOW).current!.attempt).toBe(2);
    expect(agentCardView(status({ current: current({ maxAttempts: 4 }) }), NOW).current!.maxAttempts).toBe(4);
  });

  it('is slow past 3 x typical', () => {
    const base = { begunAt: NOW - 901, steps: [{ step: 'read' as const, at: NOW - 125 }] };
    const v = agentCardView(status({ typicalS: 300, current: current({ ...base, attempts: 1 }) }), NOW);
    expect(v.current!.typicalS).toBe(300);
    expect(v.current!.slow).toEqual({ stepMin: 3, cutoffMin: null, attempt: 2, maxAttempts: 3 });
    // exactly 3x is not slow
    const ok = agentCardView(status({ typicalS: 300, current: current({ begunAt: NOW - 900 }) }), NOW);
    expect(ok.current!.slow).toBeNull();
  });

  it('is slow with under 300 s left to the deadline', () => {
    const v = agentCardView(
      status({ current: current({ begunAt: NOW - 1250, deadlineAt: NOW + 250 }) }),
      NOW,
    );
    expect(v.current!.slow).toEqual({ stepMin: 21, cutoffMin: 5, attempt: 1, maxAttempts: 3 });
    const ok = agentCardView(status({ current: current({ deadlineAt: NOW + 300 }) }), NOW);
    expect(ok.current!.slow).toBeNull();
  });

  it('is never slow when both typical and deadline are null', () => {
    const v = agentCardView(status({ current: current({ begunAt: NOW - 100_000 }) }), NOW);
    expect(v.current!.slow).toBeNull();
  });

  it('gives stepMin at least 1', () => {
    const v = agentCardView(
      status({ current: current({ deadlineAt: NOW + 10, steps: [{ step: 'read', at: NOW }] }) }),
      NOW,
    );
    expect(v.current!.slow!.stepMin).toBe(1);
    expect(v.current!.slow!.cutoffMin).toBe(1);
  });
});

describe('agentCardView: header, finishing, solo, queue', () => {
  it('paused with a current ticket is finishing it, keeps the checklist, and lists the queue as Queued', () => {
    const v = agentCardView(status({ mode: 'paused', current: current() }), NOW);
    expect(v.header).toBe('paused');
    expect(v.finishing).toBe('CUR-1');
    expect(v.current).not.toBeNull();
    expect(v.queueLabel).toBe('Queued');
    expect(v.queue).toEqual([{ key: 'Q-1', summary: 'Queued one', tag: null }]);
    expect(v.idleLine).toBeNull();
  });

  it('paused without a current ticket has no finishing and no idle line', () => {
    const v = agentCardView(status({ mode: 'paused' }), NOW);
    expect(v.finishing).toBeNull();
    expect(v.idleLine).toBeNull();
    expect(v.emptyFooter).toBeNull();
  });

  it('running uses Up next and no finishing', () => {
    const v = agentCardView(status({ current: current() }), NOW);
    expect(v.header).toBe('running');
    expect(v.finishing).toBeNull();
    expect(v.queueLabel).toBe('Up next');
  });

  it('solo replaces Up next', () => {
    const v = agentCardView(status({ solo: 'S-9' }), NOW);
    expect(v.solo).toBe('S-9');
    expect(v.queue).toEqual([]);
    expect(agentCardView(status({ mode: 'paused', solo: 'S-9' }), NOW).solo).toBeNull();
  });

  it('computes waiting minutes', () => {
    const v = agentCardView(
      status({ waiting: [{ key: 'W-1', summary: 'Wait', askedAt: NOW - 659, timeoutAt: NOW + 61 }] }),
      NOW,
    );
    expect(v.waiting).toEqual([{ key: 'W-1', summary: 'Wait', minutesLeft: 2, askedMinAgo: 10 }]);
    const late = agentCardView(
      status({ waiting: [{ key: 'W-1', summary: '', askedAt: NOW + 30, timeoutAt: NOW - 30 }] }),
      NOW,
    );
    expect(late.waiting[0]).toMatchObject({ minutesLeft: 0, askedMinAgo: 0 });
  });
});

describe('agentCardView: idle line', () => {
  const tick = (over: Partial<AgentStatus['tick']>): AgentStatus['tick'] => ({
    phase: 'ended', at: NOW - 60, pollFailures: 0, nextCheckAt: NOW + 240, stale: false, ...over,
  });

  it('stale wins over everything', () => {
    const v = agentCardView(status({ tick: tick({ phase: 'poll_failed', at: NOW - 901, stale: true }) }), NOW);
    expect(v.idleLine).toEqual({ tone: 'negative', text: "Agent hasn't checked in for 16 min", aside: null });
  });

  it('poll failed, with and without a next check', () => {
    expect(agentCardView(status({ tick: tick({ phase: 'poll_failed', nextCheckAt: NOW + 61 }) }), NOW).idleLine)
      .toEqual({ tone: 'negative', text: 'Check failed · VPN or MCPLocker may be down · retrying in 2m', aside: null });
    expect(agentCardView(status({ tick: tick({ phase: 'poll_failed', nextCheckAt: null }) }), NOW).idleLine)
      .toEqual({ tone: 'negative', text: 'Check failed · VPN or MCPLocker may be down', aside: null });
  });

  it('polling', () => {
    expect(agentCardView(status({ tick: tick({ phase: 'polling', nextCheckAt: null }) }), NOW).idleLine)
      .toEqual({ tone: 'neutral', text: 'Checking for new tickets', aside: null });
  });

  it('deferred for a foreign browser session', () => {
    expect(agentCardView(status({ tick: tick({ phase: 'deferred_foreign_pw' }) }), NOW).idleLine)
      .toEqual({ tone: 'warning', text: 'Waiting for your browser session to close', aside: null });
  });

  it('empty queue shows the footer', () => {
    const v = agentCardView(
      status({ queue: [], lastDrafted: { key: 'L-1', at: NOW - 600 }, draftedToday: 5 }),
      NOW,
    );
    expect(v.idleLine).toEqual({ tone: 'neutral', text: 'Queue empty', aside: 'checks again in 4m' });
    expect(v.emptyFooter).toEqual({ lastKey: 'L-1', lastAt: NOW - 600, draftedToday: 5 });
    const noNext = agentCardView(status({ queue: [], tick: tick({ nextCheckAt: null }) }), NOW);
    expect(noNext.idleLine!.aside).toBeNull();
    expect(noNext.emptyFooter).toEqual({ lastKey: null, lastAt: null, draftedToday: 0 });
  });

  it('between checks, with and without a next check, minimum 1m', () => {
    expect(agentCardView(status(), NOW).idleLine)
      .toEqual({ tone: 'neutral', text: 'Between checks · next check in 4m', aside: null });
    expect(agentCardView(status({ tick: tick({ nextCheckAt: NOW - 5 }) }), NOW).idleLine!.text)
      .toBe('Between checks · next check in 1m');
    expect(agentCardView(status({ tick: tick({ nextCheckAt: null }) }), NOW).idleLine!.text)
      .toBe('Between checks');
    expect(agentCardView(status(), NOW).emptyFooter).toBeNull();
  });
});
