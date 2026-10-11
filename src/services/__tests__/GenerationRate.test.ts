import { describe, expect, it } from 'vitest';
import { GenerationRate } from '../GenerationRate.js';

describe('stream generation rate', () => {
  it('excludes prefill and the first buffered chunk, and freezes during tool work', () => {
    const rate = new GenerationRate();
    rate.start();
    expect(rate.add('initial buffered text', 90_000)).toBeUndefined();
    expect(rate.add('a'.repeat(160), 92_000)).toBe(20);
    rate.stop();
    expect(rate.add('ignored tool output', 192_000)).toBe(20);
  });

  it('does not invent a rate for a single chunk or a sub-half-second sample', () => {
    const rate = new GenerationRate();
    rate.start();
    expect(rate.add('whole response', 1000)).toBeUndefined();
    expect(rate.add('x', 1100)).toBeUndefined();
    rate.stop();
    rate.start();
    expect(rate.add('retry first chunk', 2000)).toBeUndefined();
    expect(rate.add('a'.repeat(40), 3000)).toBe(10);
    rate.clear();
    expect(rate.add('late event', 4000)).toBeUndefined();
  });

  it('counts Unicode code points and publishes at most once a second', () => {
    const rate = new GenerationRate();
    rate.start();
    rate.add('first', 1000);
    expect(rate.add('😀'.repeat(80), 2000)).toBe(20);
    expect(rate.add('a'.repeat(80), 2200)).toBe(20);
    expect(rate.add('a'.repeat(80), 3000)).toBe(30);
  });
});
