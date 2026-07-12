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
import { extractSentences, findSimilarGroups, truncateText } from './textAnalysis.js';

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

      const matches = text.match(pattern);

      if (matches && matches.length > 0) {
        const firstMatch = matches[0];
        if (!firstMatch) continue;

        // Extract the repeated unit (first unitLength characters)
        const repeatedUnit = firstMatch.substring(0, unitLength);

        // Skip single-character markdown formatting (horizontal rules, etc.)
        // These are legitimate uses: ---, ===, ***, ___, ###, ~~~
        if (unitLength === 1 && MARKDOWN_FORMATTING_CHARS.has(repeatedUnit)) {
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

/**
 * PhraseRepetitionPattern - Detects repeated phrases
 *
 * Identifies when the same phrase (short text snippet) appears
 * multiple times in the response.
 *
 * Detection:
 * - Extract phrases (15-100 chars) from text
 * - Find groups with 70% similarity
 * - Trigger when 3+ similar phrases found
 */
export class PhraseRepetitionPattern implements LoopPattern {
  readonly name = 'phrase_repetition';

  /**
   * Check for repeated phrase patterns in accumulated text
   *
   * Extracts phrases by splitting on sentence boundaries and
   * commas, then finds groups of similar phrases.
   *
   * @param text - The accumulated stream text to analyze
   * @returns LoopInfo if pattern detected (3+ similar phrases), null otherwise
   */
  check(text: string): LoopInfo | null {
    // Extract phrases (split on sentence boundaries and commas)
    const phrases = this.extractPhrases(text);

    if (phrases.length < RESPONSE_LOOP_DETECTOR.PHRASE_REPETITION_THRESHOLD) {
      return null;
    }

    // Find similar phrase groups
    const similarGroups = findSimilarGroups(phrases, RESPONSE_LOOP_DETECTOR.SIMILARITY_THRESHOLD);

    for (const group of similarGroups) {
      if (group.length >= RESPONSE_LOOP_DETECTOR.PHRASE_REPETITION_THRESHOLD) {
        const firstItem = group[0];
        if (!firstItem) continue;
        const preview = truncateText(firstItem, 60);
        return {
          reason: `Repeated phrases detected: Similar phrase appears ${group.length} times ("${preview}")`,
          patternName: this.name,
          repetitionCount: group.length,
        };
      }
    }

    return null;
  }

  /**
   * Extract phrases from text
   *
   * Splits on sentence boundaries and commas, filters by length.
   *
   * @param text - Text to extract phrases from
   * @returns Array of phrase strings
   */
  private extractPhrases(text: string): string[] {
    // Split on sentence boundaries and commas
    const rawPhrases = text.split(/[.!?,;]+/);
    const phrases: string[] = [];

    for (const phrase of rawPhrases) {
      const trimmed = phrase.trim();
      if (trimmed.length >= PHRASE_MIN_LENGTH && trimmed.length <= PHRASE_MAX_LENGTH) {
        phrases.push(trimmed);
      }
    }

    return phrases;
  }
}

/**
 * SentenceRepetitionPattern - Detects repeated sentences
 *
 * Identifies when the same or very similar sentences appear
 * multiple times in the response.
 *
 * Detection:
 * - Extract sentences from text
 * - Find groups with 70% similarity
 * - Trigger when 3+ similar sentences found
 */
export class SentenceRepetitionPattern implements LoopPattern {
  readonly name = 'sentence_repetition';

  /**
   * Check for repeated sentence patterns in accumulated text
   *
   * @param text - The accumulated stream text to analyze
   * @returns LoopInfo if pattern detected (3+ similar sentences), null otherwise
   */
  check(text: string): LoopInfo | null {
    // Extract sentences
    const sentences = extractSentences(text);

    if (sentences.length < RESPONSE_LOOP_DETECTOR.SENTENCE_REPETITION_THRESHOLD) {
      return null;
    }

    // Find similar sentence groups
    const similarGroups = findSimilarGroups(sentences, RESPONSE_LOOP_DETECTOR.SIMILARITY_THRESHOLD);

    for (const group of similarGroups) {
      if (group.length >= RESPONSE_LOOP_DETECTOR.SENTENCE_REPETITION_THRESHOLD) {
        const firstItem = group[0];
        if (!firstItem) continue;
        const preview = truncateText(firstItem, 80);
        return {
          reason: `Repeated sentences detected: Similar sentence appears ${group.length} times ("${preview}")`,
          patternName: this.name,
          repetitionCount: group.length,
        };
      }
    }

    return null;
  }
}
