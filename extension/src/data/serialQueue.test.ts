import { describe, expect, it } from 'vitest';
import { createSerialQueue } from './serialQueue';

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe('createSerialQueue', () => {
  it('never runs more than one task at a time', async () => {
    const q = createSerialQueue();
    let running = 0;
    let peak = 0;
    const task = (ms: number) => async () => {
      running++; peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, ms));
      running--;
      return ms;
    };
    const out = await Promise.all([q.run(task(5)), q.run(task(1)), q.run(task(3))]);
    expect(out).toEqual([5, 1, 3]);
    expect(peak).toBe(1);
  });

  it('runs tasks in FIFO order', async () => {
    const q = createSerialQueue();
    const order: string[] = [];
    const t = (id: string, ms: number) => () => new Promise<void>((r) => setTimeout(() => { order.push(id); r(); }, ms));
    await Promise.all([q.run(t('a', 6)), q.run(t('b', 0)), q.run(t('c', 2))]);
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('a failing task rejects its own caller but does not block the next', async () => {
    const q = createSerialQueue();
    const failed = q.run(async () => { throw new Error('boom'); });
    const next = q.run(async () => 'ok');
    await expect(failed).rejects.toThrow('boom');
    await expect(next).resolves.toBe('ok');
  });

  it('a synchronously throwing task does not block the next', async () => {
    const q = createSerialQueue();
    const failed = q.run(() => { throw new Error('sync'); });
    await expect(failed).rejects.toThrow('sync');
    await expect(q.run(async () => 2)).resolves.toBe(2);
  });

  it('does not start a queued task until the previous one settles', async () => {
    const q = createSerialQueue();
    let release!: () => void;
    let secondStarted = false;
    const first = q.run(() => new Promise<void>((r) => { release = r; }));
    const second = q.run(async () => { secondStarted = true; });
    await tick(); await tick();
    expect(secondStarted).toBe(false);
    release();
    await first; await second;
    expect(secondStarted).toBe(true);
  });
});
