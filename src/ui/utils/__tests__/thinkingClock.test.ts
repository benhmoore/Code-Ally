/**
 * "Thought for Ns" is the only place the UI reports how long the model spent
 * reasoning, so it must not absorb the prefill wait that precedes the first
 * token - on a local backend that gap dwarfs the reasoning itself.
 */

import { describe, expect, test } from 'vitest';
import { ThinkingClock } from '../thinkingClock.js';

describe('ThinkingClock', () => {
  test('times from the first reasoning token, not from the request', () => {
    const clock = new ThinkingClock();
    clock.markRequestSent('root', 1_000);
    clock.markReasoningToken('root', 41_000);

    // 44s wall-clock, 3s of which was reasoning.
    expect(clock.resolveStart('root')).toBe(41_000);
  });

  test('falls back to the request when no reasoning streamed', () => {
    const clock = new ThinkingClock();
    clock.markRequestSent('root', 1_000);

    expect(clock.resolveStart('root')).toBe(1_000);
  });

  test('keeps the first token, ignoring later ones', () => {
    const clock = new ThinkingClock();
    clock.markReasoningToken('root', 5_000);
    clock.markReasoningToken('root', 6_000);
    clock.markReasoningToken('root', 7_000);

    expect(clock.resolveStart('root')).toBe(5_000);
  });

  test('tracks agents independently', () => {
    const clock = new ThinkingClock();
    clock.markReasoningToken('root', 5_000);
    clock.markReasoningToken('call-1', 9_000);

    expect(clock.resolveStart('root')).toBe(5_000);
    expect(clock.resolveStart('call-1')).toBe(9_000);
  });

  test('reports nothing once cleared', () => {
    const clock = new ThinkingClock();
    clock.markRequestSent('root', 1_000);
    clock.markReasoningToken('root', 2_000);

    clock.clear('root');

    expect(clock.resolveStart('root')).toBeUndefined();
  });

  test('bounds tracked keys so interrupted agents cannot leak', () => {
    const clock = new ThinkingClock();
    for (let i = 0; i < 1_500; i++) {
      clock.markReasoningToken(`call-${i}`, i);
    }

    // Oldest evicted, newest retained.
    expect(clock.resolveStart('call-0')).toBeUndefined();
    expect(clock.resolveStart('call-1499')).toBe(1_499);
  });
});
