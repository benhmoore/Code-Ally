import { describe, expect, it, vi } from 'vitest';
import { ConversationInputQueue } from '../ConversationInputQueue.js';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));

describe('ConversationInputQueue', () => {
  it('waits for the complete turn boundary, preserves FIFO, and exposes editing/removal', async () => {
    let busy = true;
    const queue = new ConversationInputQueue(() => busy);
    const execute = vi.fn(async () => {});
    const one = queue.enqueue('one', execute);
    const two = queue.enqueue('two', execute);
    const three = queue.enqueue('three', execute);
    await tick();
    expect(execute).not.toHaveBeenCalled();
    const [first, second] = queue.getSnapshot();
    expect(queue.edit(first!.id, 'revised')).toBe(true);
    expect(queue.remove(second!.id)?.text).toBe('two');
    expect(queue.getSnapshot().map(input => input.text)).toEqual(['revised', 'three']);
    busy = false;
    queue.drain();
    await Promise.all([one, two, three]);
    expect(execute.mock.calls.map(call => call[0])).toEqual(['revised', 'three']);
  });

  it('never overlaps asynchronous preparation and continues after failure', async () => {
    const queue = new ConversationInputQueue(() => false);
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const order: string[] = [];
    const first = queue.enqueue('first', async () => { order.push('first'); await held; throw new Error('failed'); });
    const failure = expect(first).rejects.toThrow('failed');
    const next = queue.enqueue('next', async () => { order.push('next'); });
    await tick();
    expect(order).toEqual(['first']);
    release();
    await failure;
    await next;
    expect(order).toEqual(['first', 'next']);
  });

  it('cancels both admitted preparation and waiting work without touching another conversation', async () => {
    const queue = new ConversationInputQueue(() => false);
    const other = new ConversationInputQueue(() => true);
    const execute = vi.fn(async () => {});
    const first = queue.enqueue('first', execute);
    const second = queue.enqueue('second', execute);
    const independent = other.enqueue('other', execute);
    queue.cancel();
    await Promise.all([first, second]);
    expect(execute).not.toHaveBeenCalled();
    expect(queue.getSnapshot()).toEqual([]);
    expect(other.getSnapshot()[0]?.text).toBe('other');
    other.clear();
    await independent;
  });

  it('preserves undelivered text for recall after the owning conversation closes', async () => {
    const queue = new ConversationInputQueue(() => true);
    const completion = queue.enqueue('do not lose this', vi.fn());
    queue.close();
    await completion;
    const input = queue.getSnapshot()[0]!;
    expect(input).toMatchObject({ text: 'do not lose this', status: 'not_sent' });
    expect(queue.remove(input.id)?.text).toBe('do not lose this');
    await expect(queue.enqueue('too late', vi.fn())).rejects.toThrow('closed');
  });
});

it('retains a follow-up admitted at the boundary if delegation closes before execution', async () => {
  const queue = new ConversationInputQueue(() => false);
  const execute = vi.fn();
  const result = queue.enqueue('boundary message', execute);
  queue.close();
  await result;
  await tick();
  expect(execute).not.toHaveBeenCalled();
  expect(queue.getSnapshot()).toEqual([expect.objectContaining({ text: 'boundary message', status: 'not_sent' })]);
});
