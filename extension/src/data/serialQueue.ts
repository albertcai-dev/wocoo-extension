// One-at-a-time FIFO task queue. Each run() waits for every earlier task to settle
// (resolve or reject) before starting, so a failure never wedges the tasks behind it.

export interface SerialQueue {
  run<T>(task: () => Promise<T> | T): Promise<T>;
}

export function createSerialQueue(): SerialQueue {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    run<T>(task: () => Promise<T> | T): Promise<T> {
      const next = tail.then(() => task());
      tail = next.then(() => undefined, () => undefined);
      return next;
    },
  };
}
