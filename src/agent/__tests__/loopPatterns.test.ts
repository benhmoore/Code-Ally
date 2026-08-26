import { describe, expect, it } from 'vitest';
import { PhraseRepetitionPattern, SentenceRepetitionPattern } from '../patterns/loopPatterns.js';

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

  it('does not treat repeated code and query predicates as prose loops', () => {
    const pattern = new PhraseRepetitionPattern();
    const predicates = [
      'Check state == leased',
      'Check state == leased',
      'Check state == leased',
      "AND state='leased'",
      "AND state='leased'",
      "AND state='leased'",
      'from_state: str',
      'from_state: str',
      'from_state: str',
      'maybe call transition(queue',
      'maybe call transition(queue',
      'maybe call transition(queue',
    ];

    expect(pattern.check(predicates.join(', '))).toBeNull();
  });
});

describe('SentenceRepetitionPattern', () => {
  it('detects repeated prose sentences', () => {
    const pattern = new SentenceRepetitionPattern();
    const sentence = 'I will inspect the current implementation before changing it.';

    expect(pattern.check([sentence, sentence, sentence].join(' '))).toEqual(
      expect.objectContaining({ patternName: 'sentence_repetition', repetitionCount: 3 })
    );
  });

  it('does not split repeated dotted identifiers into standalone sentences', () => {
    const pattern = new SentenceRepetitionPattern();
    const report = [
      'The check using self.HEADER_STRUCT.size distinguishes a partial header from a complete frame.',
      'The call to self.HEADER_STRUCT.unpack decodes the version and declared payload length.',
      'The expression self.HEADER_STRUCT.pack writes the validated header during append.',
    ].join(' ');

    expect(pattern.check(report)).toBeNull();
  });
});
