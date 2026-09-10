import { describe, expect, it } from 'vitest';
import { ConversationOperationQueue } from '../ConversationOperationQueue.js';

describe('ConversationOperationQueue', () => {
  it('admits without executing and drains in order through failures', async () => {
    const queue = new ConversationOperationQueue();
    const order: number[] = [];
    const first = queue.enqueue(async () => { order.push(1); throw new Error('failed operation'); });
    const failed = expect(first).rejects.toThrow('failed operation');
    const second = queue.enqueue(async () => { order.push(2); return 'result'; });
    expect(order).toEqual([]);
    await queue.drain();
    await failed;
    expect(await second).toBe('result');
    expect(order).toEqual([1, 2]);
    expect(queue.hasWork).toBe(false);
  });

  it('includes operations admitted while an earlier operation is draining', async () => {
    const queue = new ConversationOperationQueue();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const first = queue.enqueue(() => gate);
    const drain = queue.drain();
    expect(queue.drain()).toBe(drain);
    const second = queue.enqueue(async () => 'second');
    release();
    await drain;
    await first;
    expect(await second).toBe('second');
    expect(queue.hasWork).toBe(false);
  });

  it('rejects queued operations on close but drains the active operation', async () => {
    const queue = new ConversationOperationQueue();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const first = queue.enqueue(() => gate);
    const drain = queue.drain();
    await Promise.resolve();
    const second = queue.enqueue(async () => 'must not execute');
    const rejected = expect(second).rejects.toThrow('shutdown');
    let closed = false;
    const closing = queue.close().then(() => { closed = true; });
    await rejected;
    expect(closed).toBe(false);
    await expect(queue.enqueue(async () => 'late')).rejects.toThrow('closed');
    release();
    await Promise.all([first, drain, closing]);
    expect(closed).toBe(true);
    expect(queue.hasWork).toBe(false);
  });
});
