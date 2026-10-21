import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createLatestRefresher } from './latestRefresh';

const deferred = <T,>() => {
  let resolve!: (v: T) => void; let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('createLatestRefresher', () => {
  it('now() loads immediately', async () => {
    const load = vi.fn(async () => 1);
    const apply = vi.fn();
    createLatestRefresher(load, apply, vi.fn()).now();
    await vi.runAllTimersAsync();
    expect(load).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith(1);
  });

  it('soon() collapses a burst of focus/visibility events into one load after the debounce', async () => {
    const load = vi.fn(async () => 1);
    const r = createLatestRefresher(load, vi.fn(), vi.fn(), 1000);
    r.soon(); r.soon(); await vi.advanceTimersByTimeAsync(500); r.soon();
    await vi.advanceTimersByTimeAsync(999);
    expect(load).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('ignores a stale response that settles after a newer one', async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const load = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const apply = vi.fn();
    const onError = vi.fn();
    const r = createLatestRefresher(load, apply, onError);
    r.now();
    r.now();
    second.resolve('new');
    await vi.runAllTimersAsync();
    first.resolve('old');
    await vi.runAllTimersAsync();
    expect(apply.mock.calls).toEqual([['new']]);
    expect(onError).not.toHaveBeenCalled();
  });

  it('ignores a stale failure too', async () => {
    const first = deferred<string>();
    const load = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce('ok');
    const apply = vi.fn();
    const onError = vi.fn();
    const r = createLatestRefresher(load, apply, onError);
    r.now(); r.now();
    await vi.runAllTimersAsync();
    first.reject(new Error('late'));
    await vi.runAllTimersAsync();
    expect(apply.mock.calls).toEqual([['ok']]);
    expect(onError).not.toHaveBeenCalled();
  });

  it('reports the latest failure', async () => {
    const onError = vi.fn();
    createLatestRefresher(vi.fn(async () => { throw new Error('down'); }), vi.fn(), onError).now();
    await vi.runAllTimersAsync();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('dispose() cancels a pending debounce and drops in-flight results', async () => {
    const d = deferred<number>();
    const load = vi.fn().mockReturnValueOnce(d.promise).mockResolvedValue(2);
    const apply = vi.fn();
    const r = createLatestRefresher(load, apply, vi.fn(), 1000);
    r.now(); r.soon(); r.dispose();
    d.resolve(1);
    await vi.runAllTimersAsync();
    expect(load).toHaveBeenCalledTimes(1);
    expect(apply).not.toHaveBeenCalled();
  });
});
