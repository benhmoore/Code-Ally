/**
 * Concrete loop pattern detection strategies
 *
 * This module implements specific pattern detection algorithms for both
 * thinking loops and response loops. Each pattern class is stateless and
 * encapsulates a specific detection algorithm.
 *
 * Streaming patterns:
 * - CharacterRepetitionPattern: Detects character/token glitches (e.g., "2.2.2...")
 * - PhraseRepetitionPattern: Detects repeated phrases (short text snippets)
 * - SentenceRepetitionPattern: Detects repeated sentences
 *
 * Design:
 * - All patterns implement the LoopPattern interface
 * - Patterns are stateless - all state managed by detector
 * - Each check() receives full accumulated text and returns LoopInfo or null
 */

import type { LoopPattern, LoopInfo } from '../types/loopDetection.js';
import { RESPONSE_LOOP_DETECTOR } from '../../config/constants.js';
import { findRepeatedProse, truncateText } from './textAnalysis.js';

/**
 * Maximum character pattern length to check for repetition
 */
const CHAR_REPETITION_MAX_LENGTH = 5; // Maximum character pattern length to check

/**
 * Characters commonly used in markdown formatting that should not trigger
 * repetition detection when used alone (e.g., horizontal rules: ---, ===, ***)
 */
const MARKDOWN_FORMATTING_CHARS = new Set(['-', '=', '_', '*', '#', '~']);

/**
 * CharacterRepetitionPattern - Detects character/token glitches
 *
 * Identifies repetitive character patterns like "2.2.2.2.2..." which
 * indicate model output issues or token generation problems.
 *
 * Detection:
 * - Pattern: Same 1-5 chars repeated 30+ times consecutively
 * - Example: "2." repeated 30 times = "2.2.2.2.2.2.2.2.2.2..."
 * - Regex: `(.{1,5})\1{29,}` matches pattern repeated 30+ times
 * - Excludes: Single markdown formatting characters (-, =, _, *, #, ~)
 *   which are legitimately used for horizontal rules, headers, etc.
 *   Whitespace-only units are layout, not evidence of a content loop.
 */
export class CharacterRepetitionPattern implements LoopPattern {
  readonly name = 'character_repetition';

  /**
   * Check for character repetition patterns in accumulated text
   *
   * Uses regex to detect patterns where the same 1-5 characters
   * repeat consecutively 30 or more times.
   *
   * @param text - The accumulated stream text to analyze
   * @returns LoopInfo if pattern detected, null otherwise
   */
  check(text: string): LoopInfo | null {
    // Try to find the smallest repeating unit (1-5 chars) that repeats 30+ times
    // We check from smallest to largest to find the minimal pattern
    for (let unitLength = 1; unitLength <= CHAR_REPETITION_MAX_LENGTH; unitLength++) {
      const patternStr = `(.{${unitLength}})\\1{${RESPONSE_LOOP_DETECTOR.CHAR_REPETITION_THRESHOLD - 1},}`;
      const pattern = new RegExp(patternStr, 'g');

      for (const match of text.matchAll(pattern)) {
        const firstMatch = match[0];

        // Extract the repeated unit (first unitLength characters)
        const repeatedUnit = firstMatch.substring(0, unitLength);

        // Indentation and column alignment are normal in generated code and
        // tables. They carry no evidence of repeated semantic content.
        if (repeatedUnit.trim().length === 0) continue;

        // A homogeneous formatting run stays formatting even when the same
        // text is encountered again at a larger candidate unit length.
        if (MARKDOWN_FORMATTING_CHARS.has(repeatedUnit[0]!)
          && repeatedUnit === repeatedUnit[0]!.repeat(unitLength)) {
          continue;
        }

        // Count how many times it repeated
        const repetitionCount = Math.floor(firstMatch.length / unitLength);

        const preview = truncateText(firstMatch, 40);
        return {
          reason: `Character repetition detected: "${repeatedUnit}" repeated ${repetitionCount} times ("${preview}")`,
          patternName: this.name,
          repetitionCount,
        };
      }
    }

    return null;
  }
}

/**
 * Phrase length constraints
 */
const PHRASE_MIN_LENGTH = 15; // Minimum phrase length to consider
const PHRASE_MAX_LENGTH = 100; // Maximum phrase length to consider
const PHRASE_MIN_PROSE_RATIO = 0.55;
const PHRASE_MIN_DISTINCT_WORDS = 3;
const CODE_STRUCTURE_PATTERN = /(?:={1,3}|!==?|<=|>=|=>|:=|::|&&|\|\||[{}\u005b\u005d`;]|\b[A-Za-z_]\w*\s*:\s*[A-Za-z_]\w*\b|\b[A-Za-z_]\w*\s*\()/;

/**
 * Phrase similarity is meaningful for prose, but not for equations, tables, or
 * code where a deliberately repeated template can have near-perfect token
 * overlap. Those streams remain protected by character and sentence loop
 * detection; excluding them here prevents case-by-case technical analysis from
 * being mistaken for a stalled generation.
 */
function isProseLikePhrase(text: string): boolean {
  // Symbolic operators and delimiters are strong structural evidence that a
  // short fragment is code, a query predicate, or an expression rather than
  // prose. Repeating the same guard across several state transitions is normal
  // technical reasoning and must not be mistaken for a generation loop.
  // Character- and sentence-level detectors still protect these streams.
  if (CODE_STRUCTURE_PATTERN.test(text)) return false;

  const compact = text.replace(/\s/g, '');
  if (compact.length === 0) return false;

  const letters = compact.match(/[A-Za-z]/g)?.length ?? 0;
  const distinctWords = new Set(
    (text.match(/[A-Za-z]{3,}/g) ?? []).map(word => word.toLowerCase())
  );
  return letters / compact.length >= PHRASE_MIN_PROSE_RATIO
    && distinctWords.size >= PHRASE_MIN_DISTINCT_WORDS;
}

/** Detect consecutive unchanged prose fragments, not shared title templates. */
export class PhraseRepetitionPattern implements LoopPattern {
  readonly name = 'phrase_repetition';

  check(text: string): LoopInfo | null {
    // Preserve dotted filenames and identifiers. Newlines are boundaries so
    // extensions cannot become part of the following list item's title.
    const phrases = text.split(/(?:[.!?]+(?=\s|$)|[,;]+|\n+)\s*/);
    const repeated = findRepeatedProse(
      phrases,
      RESPONSE_LOOP_DETECTOR.PHRASE_REPETITION_THRESHOLD,
      phrase => phrase.length >= PHRASE_MIN_LENGTH
        && phrase.length <= PHRASE_MAX_LENGTH
        && isProseLikePhrase(phrase)
    );
    if (!repeated) return null;
    return {
      reason: `Repeated phrases detected: Unchanged prose appears ${repeated.count} times consecutively ("${truncateText(repeated.text, 60)}")`,
      patternName: this.name,
      repetitionCount: repeated.count,
    };
  }
}

/** Detect consecutive unchanged sentences while retaining meaningful differences. */
export class SentenceRepetitionPattern implements LoopPattern {
  readonly name = 'sentence_repetition';

  check(text: string): LoopInfo | null {
    const sentences = text.split(/(?:[.!?]+(?=\s|$)|\n+)\s*/);
    const repeated = findRepeatedProse(
      sentences,
      RESPONSE_LOOP_DETECTOR.SENTENCE_REPETITION_THRESHOLD,
      sentence => isProseLikePhrase(sentence)
    );
    if (!repeated) return null;
    return {
      reason: `Repeated sentences detected: Unchanged prose appears ${repeated.count} times consecutively ("${truncateText(repeated.text, 80)}")`,
      patternName: this.name,
      repetitionCount: repeated.count,
    };
  }
}
