import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { getOrCompute, invalidate, clearAll, TRIAGE_CACHE_TTL_MS } from './aiTriageCache';
import type { TriageVerdict } from '../data/aiTriageTypes';

const verdict = (workType: string): TriageVerdict => ({
  workType,
  confidence: 'high',
  rationale: '',
  steps: [],
  similarTickets: [],
  gotchas: [],
});

describe('aiTriageCache', () => {
  beforeEach(() => { clearAll(); vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('computes once and serves the cached value on the second call', async () => {
    const compute = vi.fn(async () => verdict('Overpayment'));
    const a = await getOrCompute('WOCOO-1', 'v1', compute);
    const b = await getOrCompute('WOCOO-1', 'v1', compute);
    expect(compute).toHaveBeenCalledTimes(1);
    expect(a.workType).toBe('Overpayment');
    expect(b.workType).toBe('Overpayment');
  });

  it('recomputes after the TTL expires', async () => {
    const compute = vi.fn(async () => verdict('Overpayment'));
    await getOrCompute('WOCOO-1', 'v1', compute);
    vi.advanceTimersByTime(TRIAGE_CACHE_TTL_MS + 1);
    await getOrCompute('WOCOO-1', 'v1', compute);
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it('treats a changed versionTag as a different ticket state', async () => {
    const compute = vi.fn(async () => verdict('Overpayment'));
    await getOrCompute('WOCOO-1', 'v1', compute);
    await getOrCompute('WOCOO-1', 'v2', compute);
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it('shares one in-flight promise between concurrent callers', async () => {
    let resolve!: (v: TriageVerdict) => void;
    const compute = vi.fn(() => new Promise<TriageVerdict>((r) => { resolve = r; }));
    const p1 = getOrCompute('WOCOO-1', 'v1', compute);
    const p2 = getOrCompute('WOCOO-1', 'v1', compute);
    resolve(verdict('Overpayment'));
    await Promise.all([p1, p2]);
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it('does not cache failures', async () => {
    const compute = vi.fn()
      .mockRejectedValueOnce(new Error('gateway down'))
      .mockResolvedValueOnce(verdict('Overpayment'));
    await expect(getOrCompute('WOCOO-1', 'v1', compute)).rejects.toThrow('gateway down');
    const second = await getOrCompute('WOCOO-1', 'v1', compute);
    expect(second.workType).toBe('Overpayment');
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it('invalidate forces a recompute for that key', async () => {
    const compute = vi.fn(async () => verdict('Overpayment'));
    await getOrCompute('WOCOO-1', 'v1', compute);
    invalidate('WOCOO-1', 'v1');
    await getOrCompute('WOCOO-1', 'v1', compute);
    expect(compute).toHaveBeenCalledTimes(2);
  });
});
