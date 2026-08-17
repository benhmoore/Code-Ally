import { countTokens } from '@anthropic-ai/tokenizer';
import { describe, expect, it, vi } from 'vitest';
import { TokenCounter } from '../TokenCounter.js';

describe('TokenCounter', () => {
  it('preserves the official tokenizer count', () => {
    const counter = new TokenCounter();
    const samples = [
      'hello world',
      'const answer = 42;',
      'Ｆｕｌｌ－ｗｉｄｔｈ text is normalized',
      JSON.stringify({ tool: 'read', path: '/tmp/example.ts' }),
    ];

    for (const sample of samples) {
      expect(counter.count(sample)).toBe(countTokens(sample));
    }
    counter.dispose();
  });

  it('constructs one tokenizer across repeated field-level counts', () => {
    const tokenizer = {
      encode: vi.fn((text: string) => new Uint32Array(text.length)),
      free: vi.fn(),
    };
    const factory = vi.fn(() => tokenizer as any);
    const counter = new TokenCounter(factory);

    expect(counter.count('one')).toBe(3);
    expect(counter.count('two')).toBe(3);
    expect(counter.count('three')).toBe(5);
    expect(factory).toHaveBeenCalledOnce();
    expect(tokenizer.encode).toHaveBeenCalledTimes(3);
    expect(tokenizer.free).not.toHaveBeenCalled();
  });

  it('disposes idempotently and lazily recreates when reused', () => {
    const instances = Array.from({ length: 2 }, () => ({
      encode: vi.fn((text: string) => new Uint32Array(text.length)),
      free: vi.fn(),
    }));
    const factory = vi.fn()
      .mockReturnValueOnce(instances[0] as any)
      .mockReturnValueOnce(instances[1] as any);
    const counter = new TokenCounter(factory);

    counter.count('first');
    counter.dispose();
    counter.dispose();
    counter.count('second');

    expect(instances[0]!.free).toHaveBeenCalledOnce();
    expect(instances[1]!.free).not.toHaveBeenCalled();
    expect(factory).toHaveBeenCalledTimes(2);
    counter.dispose();
    expect(instances[1]!.free).toHaveBeenCalledOnce();
  });
});
