/**
 * Information about a detected loop in a stream.
 *
 * Contains details about why the loop was detected, which pattern
 * identified it, and any relevant metrics.
 */
export interface LoopInfo {
  /**
   * Human-readable explanation of why the loop was detected.
   * Example: "Repeated identical thinking blocks detected"
   */
  reason: string;

  /**
   * Name of the pattern that detected this loop.
   * Corresponds to the LoopPattern.name that triggered.
   */
  patternName: string;

  /**
   * Number of repetitions observed, if applicable.
   * Optional because not all patterns are repetition-based.
   */
  repetitionCount?: number;
}

/**
 * Strategy interface for detecting specific loop patterns.
 *
 * Each pattern implementation encapsulates a specific detection
 * algorithm (e.g., exact repetition, semantic similarity, stalling).
 */
export interface LoopPattern {
  /**
   * Unique identifier for this pattern.
   * Used in LoopInfo.patternName when a loop is detected.
   */
  name: string;

  /**
   * Check if the accumulated text contains this pattern.
   *
   * @param text - The accumulated stream text to analyze
   * @returns LoopInfo if a loop is detected, null otherwise
   */
  check(text: string): LoopInfo | null;
}
