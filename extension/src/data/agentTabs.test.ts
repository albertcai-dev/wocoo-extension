import { describe, expect, it } from 'vitest';
import { QUIET_MS, isBetweenSessions, planAgentTabSweep } from './agentTabs';

const NOW = 1_000_000_000;
const OLD = NOW - QUIET_MS - 1;

describe('isBetweenSessions', () => {
  it('is true only for phases with no draft session', () => {
    for (const p of ['ended', 'paused', 'poll_failed', 'deferred_foreign_pw']) expect(isBetweenSessions(p)).toBe(true);
    for (const p of ['draining', 'start', 'polling', 'polled', null, undefined, '']) expect(isBetweenSessions(p)).toBe(false);
  });
});

describe('planAgentTabSweep', () => {
  it('closes a recorded tab and every tab in its group between sessions', () => {
    const tabs = [
      { id: 1, groupId: 7 }, // agent tab
      { id: 2, groupId: 7 }, // its connect page
      { id: 3, groupId: -1 }, // Albert's tab
      { id: 4, groupId: 9 }, // another group
    ];
    const plan = planAgentTabSweep({ '1': { lastHelloAt: OLD } }, tabs, 'ended', NOW);
    expect(plan.close.sort()).toEqual([1, 2]);
    expect(plan.forget).toEqual(['1']);
  });

  it('closes an ungrouped recorded tab on its own', () => {
    const plan = planAgentTabSweep({ '1': { lastHelloAt: OLD } }, [{ id: 1, groupId: -1 }, { id: 3, groupId: -1 }], 'paused', NOW);
    expect(plan.close).toEqual([1]);
  });

  it('leaves everything while a session may be running', () => {
    for (const phase of ['draining', 'start', 'polled', null]) {
      const plan = planAgentTabSweep({ '1': { lastHelloAt: OLD } }, [{ id: 1, groupId: 7 }], phase, NOW);
      expect(plan).toEqual({ close: [], forget: [] });
    }
  });

  it('leaves a tab that said hello recently', () => {
    const plan = planAgentTabSweep({ '1': { lastHelloAt: NOW - 1000 } }, [{ id: 1, groupId: 7 }], 'ended', NOW);
    expect(plan).toEqual({ close: [], forget: [] });
  });

  it('forgets entries whose tab is gone, in any phase', () => {
    const plan = planAgentTabSweep({ '5': { lastHelloAt: NOW } }, [{ id: 1, groupId: 7 }], 'draining', NOW);
    expect(plan).toEqual({ close: [], forget: ['5'] });
  });
});
