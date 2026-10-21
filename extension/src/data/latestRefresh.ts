// A refresh loop that only ever applies the newest response: focus/visibility bursts are
// debounced, and a slow older request that settles after a newer one is dropped.

export interface LatestRefresher {
  /** Load now (mount). */
  now(): void;
  /** Load after `debounceMs` of quiet (focus / visibility events). */
  soon(): void;
  dispose(): void;
}

export function createLatestRefresher<T>(
  load: () => Promise<T>,
  apply: (value: T) => void,
  onError: (err: unknown) => void,
  debounceMs = 1000,
): LatestRefresher {
  let seq = 0;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const clear = () => { if (timer) { clearTimeout(timer); timer = null; } };
  const run = () => {
    clear();
    if (disposed) return;
    const mine = ++seq;
    load().then(
      (v) => { if (!disposed && mine === seq) apply(v); },
      (e) => { if (!disposed && mine === seq) onError(e); },
    );
  };
  return {
    now: run,
    soon() {
      if (disposed) return;
      clear();
      timer = setTimeout(run, debounceMs);
    },
    dispose() { disposed = true; clear(); },
  };
}
