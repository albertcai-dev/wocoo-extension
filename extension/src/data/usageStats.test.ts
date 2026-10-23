import { describe, it, expect } from 'vitest';
import { rangeStart, summarizeUsage, type UsageEvent } from './usageStats';

// Thursday 2026-10-22, 15:00 local.
const now = new Date(2026, 9, 22, 15, 0);
const at = (day: number, hour = 10) => new Date(2026, 9, day, hour).getTime();

describe('rangeStart', () => {
  it('today starts at local midnight', () => {
    expect(rangeStart('today', now)).toBe(new Date(2026, 9, 22).getTime());
  });
  it('week starts on Monday', () => {
    expect(rangeStart('week', now)).toBe(new Date(2026, 9, 19).getTime());
  });
  it('all is unbounded', () => {
    expect(rangeStart('all', now)).toBe(0);
  });
});

describe('summarizeUsage', () => {
  const events: UsageEvent[] = [
    // A: workflow button → sidekick
    { t: at(22, 9), type: 'click', ticketId: 'WOCOO-1', button: 'atlas' },
    { t: at(22, 9), type: 'click', ticketId: 'WOCOO-1', button: 'reverse_fee' },
    { t: at(22, 10), type: 'outcome', ticketId: 'WOCOO-1', outcome: 'Done' },
    // B: lookup only → assisted
    { t: at(22, 9), type: 'click', ticketId: 'WOCOO-2', button: 'i2c' },
    { t: at(22, 9), type: 'click', ticketId: 'WOCOO-2', button: 'i2c' },
    { t: at(22, 11), type: 'outcome', ticketId: 'WOCOO-2', outcome: 'Cancelled' },
    // C: nothing → unassisted
    { t: at(22, 12), type: 'outcome', ticketId: 'WOCOO-3', outcome: 'Done' },
    // D: clicked yesterday (before this week? no — Tue), moved today → sidekick, moved
    { t: at(20, 9), type: 'click', ticketId: 'WOCOO-4', button: 'clone_move' },
    { t: at(22, 13), type: 'outcome', ticketId: 'WOCOO-4', outcome: 'Moved', movedToBoard: 'EOC' },
    { t: at(22, 13), type: 'created', ticketId: 'WOCOO-4', createdKey: 'WOCOO-99', createdKind: 'Clone' },
    // E: click AFTER outcome doesn't count toward classification
    { t: at(22, 9), type: 'outcome', ticketId: 'WOCOO-5', outcome: 'Done' },
    { t: at(22, 10), type: 'click', ticketId: 'WOCOO-5', button: 'create_reimb' },
    { t: at(22, 10), type: 'created', ticketId: 'WOCOO-5', createdKey: 'REIMB-1', createdKind: 'REIMB' },
    // F: last week — excluded from today/week
    { t: at(12), type: 'outcome', ticketId: 'WOCOO-6', outcome: 'Done' },
  ];

  it('classifies solved tickets for today', () => {
    const s = summarizeUsage(events, 'today', now);
    expect(s.solved).toBe(5);
    expect(s.byClass).toEqual({ sidekick: 2, assisted: 1, unassisted: 2 });
    expect(s.moved).toBe(1);
    expect(s.created).toBe(2);
  });

  it('counts every click, sorted by count', () => {
    const s = summarizeUsage(events, 'today', now);
    expect(s.buttons[0]).toMatchObject({ id: 'i2c', count: 2 });
    expect(s.buttons.find((b) => b.id === 'clone_move')?.count).toBe(0); // clicked Tuesday
    expect(s.buttons.find((b) => b.id === 'koho')?.count).toBe(0);
  });

  it('week includes earlier clicks; all includes last week', () => {
    expect(summarizeUsage(events, 'week', now).buttons.find((b) => b.id === 'clone_move')?.count).toBe(1);
    expect(summarizeUsage(events, 'all', now).solved).toBe(6);
  });

  it('counts a ticket once at its latest outcome', () => {
    const twice: UsageEvent[] = [
      { t: at(22, 9), type: 'outcome', ticketId: 'WOCOO-7', outcome: 'Moved' },
      { t: at(22, 10), type: 'click', ticketId: 'WOCOO-7', button: 'done' },
      { t: at(22, 11), type: 'outcome', ticketId: 'WOCOO-7', outcome: 'Done' },
    ];
    const s = summarizeUsage(twice, 'today', now);
    expect(s.solved).toBe(1);
    expect(s.byClass.sidekick).toBe(1);
    expect(s.moved).toBe(1);
  });
});
