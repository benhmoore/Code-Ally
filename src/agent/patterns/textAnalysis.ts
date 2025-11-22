/**
 * Shared text analysis utilities for loop pattern detection
 *
 * This module provides common text extraction and similarity analysis
 * functions used by various loop pattern detectors. These utilities
 * extract structured information (questions, actions, sentences) and
 * perform similarity matching using Jaccard similarity on word sets.
 *
 * Key Features:
 * - Text extraction: Questions, actions, sentences
 * - Similarity detection: Jaccard word overlap with configurable threshold
 * - Grouping: Find clusters of similar text items
 * - Truncation: Safe text preview with ellipsis
 */

import { THINKING_LOOP_DETECTOR } from '../../config/constants.js';

/**
 * Regex patterns for action statement detection
 */
const ACTION_PATTERNS = [
  /\b(?:i will|i'll|i should|let me)\s+[^.!?]+[.!?]/gi,
] as const;

/**
 * Extract questions from text
 *
 * Questions are identified as sentences ending with "?".
 * Very short questions (<=10 chars) are filtered out to avoid noise.
 *
 * @param text - Text to extract questions from
 * @returns Array of question strings
 */
export function extractQuestions(text: string): string[] {
  // Split on sentence boundaries, keeping questions
  const sentences = text.split(/[.!?]+/);
  const questions: string[] = [];

  // Track position to find questions
  let currentPos = 0;
  for (const sentence of sentences) {
    const endPos = currentPos + sentence.length;
    const nextChar = text[endPos];

    if (nextChar === '?') {
      const question = sentence.trim();
      if (question.length > 10) {
        // Skip very short questions
        questions.push(question);
      }
    }

    currentPos = endPos + 1;
  }

  return questions;
}

/**
 * Extract action statements from text
 *
 * Actions are phrases starting with "I will", "I'll", "I should", "Let me".
 * Very short actions (<=15 chars) are filtered out to avoid noise.
 *
 * @param text - Text to extract actions from
 * @returns Array of action strings
 */
export function extractActions(text: string): string[] {
  const actions: string[] = [];

  for (const pattern of ACTION_PATTERNS) {
    const matches = text.match(pattern);
    if (matches) {
      for (const match of matches) {
        const action = match.trim();
        if (action.length > 15) {
          // Skip very short actions
          actions.push(action);
        }
      }
    }
  }

  return actions;
}

/**
 * Extract sentences from text
 *
 * Sentences are identified by common ending punctuation (. ! ?).
 * Very short sentences (<=10 chars) are filtered out.
 *
 * @param text - Text to extract sentences from
 * @returns Array of sentence strings
 */
export function extractSentences(text: string): string[] {
  // Split on sentence boundaries
  const rawSentences = text.split(/[.!?]+/);
  const sentences: string[] = [];

  for (const sentence of rawSentences) {
    const trimmed = sentence.trim();
    if (trimmed.length > 10) {
      // Skip very short fragments
      sentences.push(trimmed);
    }
  }

  return sentences;
}

/**
 * Find groups of similar items using Jaccard similarity
 *
 * Groups items that have similarity >= threshold (based on word overlap).
 * Only returns groups that meet the minimum size threshold.
 *
 * @param items - Items to group by similarity
 * @param threshold - Minimum similarity threshold (0-1), defaults to SIMILARITY_THRESHOLD
 * @returns Array of similar item groups (each group contains >=3 items)
 */
export function findSimilarGroups(
  items: string[],
  threshold: number = THINKING_LOOP_DETECTOR.SIMILARITY_THRESHOLD
): string[][] {
  const groups: string[][] = [];
  const used = new Set<number>();

  for (let i = 0; i < items.length; i++) {
    if (used.has(i)) continue;

    const item = items[i];
    if (!item) continue;

    const group = [item];
    used.add(i);

    // Find similar items
    for (let j = i + 1; j < items.length; j++) {
      if (used.has(j)) continue;

      const compareItem = items[j];
      if (!compareItem) continue;

      if (areTextsSimilar(item, compareItem, threshold)) {
        group.push(compareItem);
        used.add(j);
      }
    }

    if (group.length >= THINKING_LOOP_DETECTOR.REPETITION_THRESHOLD) {
      groups.push(group);
    }
  }

  return groups;
}

/**
 * Check if two texts are similar using Jaccard similarity on word sets
 *
 * Algorithm:
 * 1. Normalize both texts (lowercase, remove punctuation)
 * 2. Split into word sets (filter out short words <=2 chars)
 * 3. Calculate Jaccard similarity: |intersection| / |union|
 * 4. Return true if similarity >= threshold
 *
 * @param text1 - First text
 * @param text2 - Second text
 * @param threshold - Minimum similarity threshold (0-1), defaults to SIMILARITY_THRESHOLD
 * @returns True if texts are similar
 */
export function areTextsSimilar(
  text1: string,
  text2: string,
  threshold: number = THINKING_LOOP_DETECTOR.SIMILARITY_THRESHOLD
): boolean {
  // Normalize: lowercase and split into words
  const words1 = new Set(
    text1
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2) // Skip short words
  );

  const words2 = new Set(
    text2
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2)
  );

  // Calculate Jaccard similarity
  const intersection = new Set(Array.from(words1).filter(w => words2.has(w)));
  const union = new Set(Array.from(words1).concat(Array.from(words2)));

  const similarity = union.size > 0 ? intersection.size / union.size : 0;

  return similarity >= threshold;
}

/**
 * Truncate text for display
 *
 * Adds ellipsis if text exceeds maxLength.
 *
 * @param text - Text to truncate
 * @param maxLength - Maximum length (including ellipsis)
 * @returns Truncated text with ellipsis if needed
 */
export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return text.slice(0, maxLength - 3) + '...';
}
