import { describe, expect, it } from 'vitest';
import { PhraseRepetitionPattern } from '../patterns/loopPatterns.js';

describe('PhraseRepetitionPattern', () => {
  it('detects repeated natural-language phrases', () => {
    const pattern = new PhraseRepetitionPattern();
    const phrase = 'I will inspect the same file again without making progress';

    expect(pattern.check([phrase, phrase, phrase].join('. '))).toEqual(
      expect.objectContaining({ patternName: 'phrase_repetition', repetitionCount: 3 })
    );
  });

  it('does not treat repeated mathematical templates as prose loops', () => {
    const pattern = new PhraseRepetitionPattern();
    const derivations = [
      '-1) cross = (c1-c0) × (c2-c0) = |i j k|',
      '-1) cross = (c1-c0) × (c2-c0) = |i j k|',
      '-1) cross = (c1-c0) × (c2-c0) = |i j k|',
      '-1) cross = (c1-c0) × (c2-c0) = |i j k|',
    ];

    expect(pattern.check(derivations.join(',\n'))).toBeNull();
  });
});
