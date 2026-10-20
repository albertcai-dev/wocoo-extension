import { describe, expect, it } from 'vitest';
import { REPORT_THROTTLE_MS, shouldReport } from './i2cActivity';

const T = 1_000_000;

describe('shouldReport', () => {
  it('ignores untrusted events', () => {
    expect(shouldReport({ isTrusted: false }, false, 0, T)).toBe(false);
  });

  it('ignores the agent tab', () => {
    expect(shouldReport({ isTrusted: true }, true, 0, T)).toBe(false);
  });

  it('reports the first trusted event', () => {
    expect(shouldReport({ isTrusted: true }, false, 0, T)).toBe(true);
  });

  it('throttles within 30s', () => {
    expect(shouldReport({ isTrusted: true }, false, T - 1_000, T)).toBe(false);
    expect(shouldReport({ isTrusted: true }, false, T - (REPORT_THROTTLE_MS - 1), T)).toBe(false);
  });

  it('reports after 30s', () => {
    expect(shouldReport({ isTrusted: true }, false, T - REPORT_THROTTLE_MS, T)).toBe(true);
    expect(shouldReport({ isTrusted: true }, false, T - 60_000, T)).toBe(true);
  });
});
