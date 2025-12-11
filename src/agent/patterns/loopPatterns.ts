/**
 * Concrete loop pattern detection strategies
 *
 * This module implements specific pattern detection algorithms for both
 * thinking loops and response loops. Each pattern class is stateless and
 * encapsulates a specific detection algorithm.
 *
 * Thinking Patterns:
 * - ReconstructionCyclePattern: Detects repeated reconsideration phrases
 * - RepeatedQuestionPattern: Detects similar questions asked multiple times
 * - RepeatedActionPattern: Detects similar action statements repeated
 *
 * Response Patterns:
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
import { THINKING_LOOP_DETECTOR, RESPONSE_LOOP_DETECTOR } from '../../config/constants.js';
import {
  extractQuestions,
  extractActions,
  extractSentences,
  findSimilarGroups,
  truncateText,
} from './textAnalysis.js';

// ===========================================
// THINKING PATTERNS
// ===========================================

/**
 * Regex patterns for reconstruction cycle detection
 */
const RECONSTRUCTION_PATTERNS = [
  /\b(?:let me |let's |i should |i'll |i will )?reconsider\b/gi,
  /\b(?:let me |let's |i should |i'll |i will )?rethink\b/gi,
  /\b(?:let me |let's |i should |i'll |i will )?revisit\b/gi,
  /\bgo back to\b/gi,
  /\bstart over\b/gi,
  /\breturn to\b/gi,
] as const;

/**
 * ReconstructionCyclePattern - Detects reconstruction cycle patterns
 *
 * Searches for phrases indicating reconsideration:
 * - "reconsider", "rethink", "revisit"
 * - "go back to", "start over", "return to"
 *
 * Triggers when 2+ occurrences are found (RECONSTRUCTION_THRESHOLD).
 */
export class ReconstructionCyclePattern implements LoopPattern {
  readonly name = 'reconstruction_cycle';

  /**
   * Check for reconstruction cycle patterns in accumulated text
   *
   * @param text - The accumulated stream text to analyze
   * @returns LoopInfo if pattern detected (2+ reconstruction phrases), null otherwise
   */
  check(text: string): LoopInfo | null {
    let totalMatches = 0;
    const matchedPhrases: string[] = [];

    // Check each pattern
    for (const pattern of RECONSTRUCTION_PATTERNS) {
      const matches = text.match(pattern);
      if (matches && matches.length > 0) {
        totalMatches += matches.length;
        matchedPhrases.push(...matches);
      }
    }

    if (totalMatches >= THINKING_LOOP_DETECTOR.RECONSTRUCTION_THRESHOLD) {
      const uniquePhrases = Array.from(new Set(matchedPhrases)).slice(0, 3);
      return {
        reason: `Reconstruction cycle detected: Found ${totalMatches} instances of reconsideration phrases (${uniquePhrases.join(', ')})`,
        patternName: this.name,
        repetitionCount: totalMatches,
      };
    }

    return null;
  }
}

/**
 * RepeatedQuestionPattern - Detects repeated questions
 *
 * Extracts questions (sentences ending with "?") and checks for similarity
 * using Jaccard word overlap (70% threshold).
 *
 * Triggers when 3+ similar questions are found (REPETITION_THRESHOLD).
 */
export class RepeatedQuestionPattern implements LoopPattern {
  readonly name = 'repeated_questions';

  /**
   * Check for repeated question patterns in accumulated text
   *
   * @param text - The accumulated stream text to analyze
   * @returns LoopInfo if pattern detected (3+ similar questions), null otherwise
   */
  check(text: string): LoopInfo | null {
    // Extract questions (sentences ending with ?)
    const questions = extractQuestions(text);

    if (questions.length < THINKING_LOOP_DETECTOR.REPETITION_THRESHOLD) {
      return null;
    }

    // Find similar question groups
    const similarGroups = findSimilarGroups(questions);

    for (const group of similarGroups) {
      if (group.length >= THINKING_LOOP_DETECTOR.REPETITION_THRESHOLD) {
        const firstItem = group[0];
        if (!firstItem) continue;
        const preview = truncateText(firstItem, 80);
        return {
          reason: `Repeated questions detected: Same question appears ${group.length} times ("${preview}")`,
          patternName: this.name,
          repetitionCount: group.length,
        };
      }
    }

    return null;
  }
}

/**
 * RepeatedActionPattern - Detects repeated action statements
 *
 * Extracts action statements ("I will", "I'll", "I should", "Let me") and
 * checks for similarity using Jaccard word overlap (70% threshold).
 *
 * Triggers when 3+ similar actions are found (REPETITION_THRESHOLD).
 */
export class RepeatedActionPattern implements LoopPattern {
  readonly name = 'repeated_actions';

  /**
   * Check for repeated action patterns in accumulated text
   *
   * @param text - The accumulated stream text to analyze
   * @returns LoopInfo if pattern detected (3+ similar actions), null otherwise
   */
  check(text: string): LoopInfo | null {
    // Extract action statements
    const actions = extractActions(text);

    if (actions.length < THINKING_LOOP_DETECTOR.REPETITION_THRESHOLD) {
      return null;
    }

    // Find similar action groups
    const similarGroups = findSimilarGroups(actions);

    for (const group of similarGroups) {
      if (group.length >= THINKING_LOOP_DETECTOR.REPETITION_THRESHOLD) {
        const firstItem = group[0];
        if (!firstItem) continue;
        const preview = truncateText(firstItem, 80);
        return {
          reason: `Repeated actions detected: Same action statement appears ${group.length} times ("${preview}")`,
          patternName: this.name,
          repetitionCount: group.length,
        };
      }
    }

    return null;
  }
}

// ===========================================
// RESPONSE PATTERNS
// ===========================================

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
