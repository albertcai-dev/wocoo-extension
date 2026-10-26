import { describe, expect, it } from 'vitest';
import { agentLocalTime } from './agentMode';
import { QUEUE_TAG_LABEL, currentMeta, emptyFooterText, formatClock, slowNote, waitingNote } from './agentProgressText';

describe('formatClock', () => {
  it('formats m:ss under an hour', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(5)).toBe('0:05');
    expect(formatClock(192)).toBe('3:12');
    expect(formatClock(3599)).toBe('59:59');
  });

  it('floors fractions and clamps junk to 0', () => {
    expect(formatClock(59.9)).toBe('0:59');
    expect(formatClock(-4)).toBe('0:00');
    expect(formatClock(NaN)).toBe('0:00');
  });

  it('adds hours from an hour on', () => {
    expect(formatClock(3600)).toBe('1:00:00');
    expect(formatClock(3725)).toBe('1:02:05');
  });
});

describe('currentMeta', () => {
  const base = { elapsedS: 192, typicalS: null, attempt: null, maxAttempts: 3 };

  it('is just the clock without typical or attempt', () => {
    expect(currentMeta(base)).toBe('3:12');
  });

  it('adds usually ~Nm, rounded, at least 1', () => {
    expect(currentMeta({ ...base, typicalS: 360 })).toBe('3:12 · usually ~6m');
    expect(currentMeta({ ...base, typicalS: 389 })).toBe('3:12 · usually ~6m');
    expect(currentMeta({ ...base, typicalS: 10 })).toBe('3:12 · usually ~1m');
  });

  it('adds the attempt last', () => {
    expect(currentMeta({ ...base, typicalS: 360, attempt: 2 })).toBe('3:12 · usually ~6m · attempt 2 of 3');
    expect(currentMeta({ ...base, attempt: 3, maxAttempts: 4 })).toBe('3:12 · attempt 3 of 4');
  });
});

describe('slowNote', () => {
  it('names the cutoff and attempt when there is a deadline', () => {
    expect(slowNote({ stepMin: 17, cutoffMin: 5, attempt: 1, maxAttempts: 3 })).toBe(
      'Same step for 17 min. Might be stuck on a login. Gets cut off in 5m and retried (attempt 1 of 3).',
    );
  });

  it('drops the cutoff clause without a deadline', () => {
    expect(slowNote({ stepMin: 17, cutoffMin: null, attempt: 1, maxAttempts: 3 })).toBe(
      'Same step for 17 min. Might be stuck on a login.',
    );
  });
});

describe('waitingNote', () => {
  it('uses the minutes since asking', () => {
    expect(waitingNote(8)).toBe(
      'Asked 8m ago. Jumps to the front when Compass answers, or drafts without it when time runs out.',
    );
  });
});

describe('emptyFooterText', () => {
  it('names the last draft and its time', () => {
    const at = 1_800_000_000;
    expect(emptyFooterText({ lastKey: 'L-1', lastAt: at, draftedToday: 7 })).toEqual({
      key: 'L-1',
      tail: ` drafted at ${agentLocalTime(at)} · 7 drafted today`,
    });
  });

  it('omits the time when unknown', () => {
    expect(emptyFooterText({ lastKey: 'L-1', lastAt: null, draftedToday: 2 }))
      .toEqual({ key: 'L-1', tail: ' drafted · 2 drafted today' });
  });

  it('drops the Last part with no last draft', () => {
    expect(emptyFooterText({ lastKey: null, lastAt: null, draftedToday: 0 })).toEqual({ key: null, tail: '0 drafted today' });
  });
});

describe('QUEUE_TAG_LABEL', () => {
  it('labels every queue tag, telling a Compass reply from a timeout', () => {
    expect(QUEUE_TAG_LABEL).toEqual({
      solve: 'Solve',
      compass: 'Compass replied',
      compass_timeout: 'Compass timed out',
      reply: 'Reply in',
    });
  });
});
