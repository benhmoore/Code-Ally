import { describe, expect, it } from 'vitest';
import { CharacterRepetitionPattern, PhraseRepetitionPattern, SentenceRepetitionPattern } from '../patterns/loopPatterns.js';

describe('CharacterRepetitionPattern', () => {
  it.each([' ', '\t', ' \t'])('does not mistake repeated layout %j for a content loop', unit => {
    const pattern = new CharacterRepetitionPattern();
    expect(pattern.check(`functionCall(firstArgument,\n${unit.repeat(60)}secondArgument)`)).toBeNull();
  });

  it.each([' '.repeat(60), '-'.repeat(60)])('continues checking after a formatting match', layout => {
    const pattern = new CharacterRepetitionPattern();
    expect(pattern.check(`${layout}\n${'x'.repeat(40)}`)).toEqual(
      expect.objectContaining({ patternName: 'character_repetition', repetitionCount: 40 }),
    );
  });

  it('still detects repeated non-whitespace units', () => {
    const pattern = new CharacterRepetitionPattern();
    expect(pattern.check('2.'.repeat(40))).toEqual(
      expect.objectContaining({ patternName: 'character_repetition', repetitionCount: 40 }),
    );
  });

  it.each(['-', '=', '_', '*', '#', '~'])('ignores long homogeneous formatting runs of %s', character => {
    expect(new CharacterRepetitionPattern().check(character.repeat(240))).toBeNull();
  });
});

describe('PhraseRepetitionPattern', () => {
  it('detects repeated natural-language phrases', () => {
    const pattern = new PhraseRepetitionPattern();
    const phrase = 'I will inspect the same file again without making progress';

    expect(pattern.check([phrase, phrase, phrase].join('.\n\n'))).toEqual(
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

// Synthetic labels only; no external documents are needed for these regressions.
describe.each([PhraseRepetitionPattern, SentenceRepetitionPattern])('%s false positives', Pattern => {
  it.each([
    Array.from({ length: 40 }, (_, i) => `• Sample Short Story ${i + 1}.pdf`).join('\n'),
    Array.from({ length: 40 }, (_, i) => `Sample Short Story ${i + 1}`).join(', '),
    Array.from({ length: 10 }, () => 'Sample Short Story').join(', '),
    Array.from({ length: 10 }, (_, i) => `I finished checking sample document number ${i + 1}.`).join(' '),
    ['I can read the selected sample document.', 'I may read the selected sample document.', 'I did read the selected sample document.'].join(' '),
    ['The selected sample document is ready', 'Done', 'The selected sample document is ready', 'Next', 'The selected sample document is ready'].join('. '),
  ])('allows recurring labels and meaningful progress: %s', text => {
    expect(new Pattern().check(text)).toBeNull();
  });

  it('detects a real loop despite streamed whitespace differences', () => {
    const phrase = 'I will inspect the same file again without making progress';
    expect(new Pattern().check([phrase, phrase.replaceAll(' ', '\t'), phrase].join('.\n\n')))
      .toEqual(expect.objectContaining({ repetitionCount: 3 }));
  });
});
