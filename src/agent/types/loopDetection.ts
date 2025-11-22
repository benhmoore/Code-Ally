import { ActivityEventType } from '../../types/index.js';

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

/**
 * Configuration for a stream loop detector.
 *
 * Defines which stream to monitor, what patterns to check for,
 * timing parameters, and the callback to invoke on detection.
 */
export interface StreamLoopDetectorConfig {
  /**
   * The activity event type to monitor for loop detection.
   * Example: ActivityEventType.THOUGHT_CHUNK for thinking loops
   */
  eventType: ActivityEventType;

  /**
   * Array of pattern strategies to check against the stream.
   * Patterns are checked in order; first match triggers detection.
   */
  patterns: LoopPattern[];

  /**
   * Grace period before starting loop detection (milliseconds).
   * Allows the stream to establish normal patterns before monitoring.
   */
  warmupPeriodMs: number;

  /**
   * How often to check for loops (milliseconds).
   * Balance between responsiveness and performance overhead.
   */
  checkIntervalMs: number;

  /**
   * Optional identifier for this detector instance.
   * Useful for logging and debugging multiple detectors.
   */
  instanceId?: string;

  /**
   * Callback invoked when a loop is detected.
   * Should handle the loop appropriately (e.g., interrupt, log, notify).
   *
   * @param info - Information about the detected loop
   */
  onLoopDetected: (info: LoopInfo) => void;
}
