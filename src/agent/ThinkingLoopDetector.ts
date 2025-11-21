/**
 * ThinkingLoopDetector - Detects repetitive patterns in extended thinking streams
 *
 * Purpose:
 * Some models can get stuck in thinking loops where they:
 * 1. Continuously reconsider/rethink/revisit decisions (reconstruction cycles)
 * 2. Repeat the same questions or action statements multiple times
 *
 * This detector monitors streaming thinking chunks in real-time and identifies
 * these patterns, allowing the agent to be interrupted before wasting tokens.
 *
 * Key Features:
 * - Real-time streaming detection: Processes chunks as they arrive
 * - Warmup period: 20-second grace period before checks begin
 * - Periodic checking: Analyzes accumulated text every 5 seconds
 * - Two pattern types:
 *   1. Reconstruction cycles: "reconsider", "rethink", "revisit", "go back to"
 *   2. Repeated questions/actions: Same question or action appearing 3+ times
 * - Clean lifecycle management: Start/stop/reset with proper timer cleanup
 *
 * Usage:
 * ```typescript
 * const detector = new ThinkingLoopDetector({
 *   onLoopDetected: (info) => {
 *     console.log(`Loop detected: ${info.reason}`);
 *     // Handle loop (e.g., interrupt thinking)
 *   },
 *   instanceId: 'agent-123',
 * });
 *
 * // As thinking chunks stream in
 * detector.addChunk('Let me reconsider this approach...');
 * detector.addChunk('Actually, I should rethink this...');
 *
 * // When thinking completes or is interrupted
 * detector.stop();
 * ```
 */

import { logger } from '../services/Logger.js';
import { THINKING_LOOP_DETECTOR } from '../config/constants.js';

/**
 * Configuration options for ThinkingLoopDetector
 */
export interface ThinkingLoopDetectorConfig {
  /** Callback invoked when a thinking loop is detected */
  onLoopDetected: (info: ThinkingLoopInfo) => void;

  /** Instance identifier for logging (optional) */
  instanceId?: string;
}

/**
 * Information about a detected thinking loop
 */
export interface ThinkingLoopInfo {
  /** Human-readable explanation of why the loop was detected */
  reason: string;

  /** Number of reconstruction phrases detected (if applicable) */
  reconstructionCount?: number;

  /** Number of similar repetitions detected (if applicable) */
  repetitionCount?: number;
}

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
 * Regex patterns for action statement detection
 */
const ACTION_PATTERNS = [
  /\b(?:i will|i'll|i should|let me)\s+[^.!?]+[.!?]/gi,
] as const;

/**
 * ThinkingLoopDetector monitors thinking streams for repetitive patterns
 *
 * This class implements a watchdog pattern that:
 * 1. Accumulates thinking chunks as they stream in
 * 2. Waits for a warmup period before checking
 * 3. Periodically analyzes the accumulated text for patterns
 * 4. Invokes callback when loop detected
 * 5. Stops monitoring on completion or interruption
 */
export class ThinkingLoopDetector {
  private config: Required<ThinkingLoopDetectorConfig>;
  private accumulatedText: string = '';
  private warmupTimer: NodeJS.Timeout | null = null;
  private checkTimer: NodeJS.Timeout | null = null;
  private isMonitoring: boolean = false;
  private hasDetectedLoop: boolean = false;

  /**
   * Create a new ThinkingLoopDetector
   *
   * @param config - Configuration options
   */
  constructor(config: ThinkingLoopDetectorConfig) {
    this.config = {
      ...config,
      instanceId: config.instanceId ?? 'unknown',
    };
  }

  /**
   * Add a thinking chunk to the accumulator
   *
   * Starts monitoring on the first chunk received.
   * Subsequent chunks are simply appended to the accumulated text.
   *
   * @param chunk - Thinking text chunk from the stream
   */
  addChunk(chunk: string): void {
    // Skip empty chunks
    if (!chunk || chunk.trim().length === 0) {
      return;
    }

    // Append to accumulated text
    this.accumulatedText += chunk;

    // Start monitoring on first chunk
    if (!this.isMonitoring) {
      this.startMonitoring();
    }
  }

  /**
   * Start monitoring for thinking loops
   *
   * Sets up a warmup timer followed by periodic checks.
   * Safe to call multiple times - subsequent calls are ignored.
   */
  private startMonitoring(): void {
    if (this.isMonitoring) {
      return;
    }

    this.isMonitoring = true;
    this.hasDetectedLoop = false;

    logger.debug(
      '[THINKING_LOOP_DETECTOR]',
      this.config.instanceId,
      `Started - warmup: ${THINKING_LOOP_DETECTOR.WARMUP_PERIOD_MS}ms, check interval: ${THINKING_LOOP_DETECTOR.CHECK_INTERVAL_MS}ms`
    );

    // Schedule first check after warmup period
    this.warmupTimer = setTimeout(() => {
      this.warmupTimer = null;

      // Start periodic checking
      this.checkTimer = setInterval(() => {
        this.checkForLoops();
      }, THINKING_LOOP_DETECTOR.CHECK_INTERVAL_MS);

      // Run first check immediately after warmup
      this.checkForLoops();

      logger.debug('[THINKING_LOOP_DETECTOR]', this.config.instanceId, 'Warmup complete, checks started');
    }, THINKING_LOOP_DETECTOR.WARMUP_PERIOD_MS);
  }

  /**
   * Check accumulated text for loop patterns
   *
   * Runs both reconstruction cycle and repetition detection.
   * Stops checking after first loop detected to avoid multiple callbacks.
   */
  private checkForLoops(): void {
    // Skip if already detected a loop
    if (this.hasDetectedLoop) {
      return;
    }

    // Skip if no text accumulated
    if (this.accumulatedText.length === 0) {
      return;
    }

    logger.debug(
      '[THINKING_LOOP_DETECTOR]',
      this.config.instanceId,
      `Checking ${this.accumulatedText.length} chars for patterns`
    );

    // Check for reconstruction cycles
    const reconstructionInfo = this.detectReconstructionCycles();
    if (reconstructionInfo) {
      this.handleLoopDetected(reconstructionInfo);
      return;
    }

    // Check for repeated questions
    const questionInfo = this.detectRepeatedQuestions();
    if (questionInfo) {
      this.handleLoopDetected(questionInfo);
      return;
    }

    // Check for repeated actions
    const actionInfo = this.detectRepeatedActions();
    if (actionInfo) {
      this.handleLoopDetected(actionInfo);
      return;
    }
  }

  /**
   * Detect reconstruction cycle patterns
   *
   * Searches for phrases like "reconsider", "rethink", "revisit", "go back to".
   * Triggers when 2+ occurrences are found.
   *
   * @returns Loop info if pattern detected, null otherwise
   */
  private detectReconstructionCycles(): ThinkingLoopInfo | null {
    let totalMatches = 0;
    const matchedPhrases: string[] = [];

    // Check each pattern
    for (const pattern of RECONSTRUCTION_PATTERNS) {
      const matches = this.accumulatedText.match(pattern);
      if (matches && matches.length > 0) {
        totalMatches += matches.length;
        matchedPhrases.push(...matches);
      }
    }

    if (totalMatches >= THINKING_LOOP_DETECTOR.RECONSTRUCTION_THRESHOLD) {
      const uniquePhrases = Array.from(new Set(matchedPhrases)).slice(0, 3);
      return {
        reason: `Reconstruction cycle detected: Found ${totalMatches} instances of reconsideration phrases (${uniquePhrases.join(', ')})`,
        reconstructionCount: totalMatches,
      };
    }

    return null;
  }

  /**
   * Detect repeated questions
   *
   * Extracts questions (sentences ending with "?") and checks for similarity.
   * Triggers when 3+ similar questions are found.
   *
   * @returns Loop info if pattern detected, null otherwise
   */
  private detectRepeatedQuestions(): ThinkingLoopInfo | null {
    // Extract questions (sentences ending with ?)
    const questions = this.extractQuestions(this.accumulatedText);

    if (questions.length < THINKING_LOOP_DETECTOR.REPETITION_THRESHOLD) {
      return null;
    }

    // Find similar question groups
    const similarGroups = this.findSimilarGroups(questions);

    for (const group of similarGroups) {
      if (group.length >= THINKING_LOOP_DETECTOR.REPETITION_THRESHOLD) {
        const firstItem = group[0];
        if (!firstItem) continue;
        const preview = this.truncateText(firstItem, 80);
        return {
          reason: `Repeated questions detected: Same question appears ${group.length} times ("${preview}")`,
          repetitionCount: group.length,
        };
      }
    }

    return null;
  }

  /**
   * Detect repeated action statements
   *
   * Extracts action statements ("I will", "I'll", "I should", "Let me") and checks for similarity.
   * Triggers when 3+ similar actions are found.
   *
   * @returns Loop info if pattern detected, null otherwise
   */
  private detectRepeatedActions(): ThinkingLoopInfo | null {
    // Extract action statements
    const actions = this.extractActions(this.accumulatedText);

    if (actions.length < THINKING_LOOP_DETECTOR.REPETITION_THRESHOLD) {
      return null;
    }

    // Find similar action groups
    const similarGroups = this.findSimilarGroups(actions);

    for (const group of similarGroups) {
      if (group.length >= THINKING_LOOP_DETECTOR.REPETITION_THRESHOLD) {
        const firstItem = group[0];
        if (!firstItem) continue;
        const preview = this.truncateText(firstItem, 80);
        return {
          reason: `Repeated actions detected: Same action statement appears ${group.length} times ("${preview}")`,
          repetitionCount: group.length,
        };
      }
    }

    return null;
  }

  /**
   * Extract questions from text
   *
   * Questions are sentences ending with "?".
   *
   * @param text - Text to extract questions from
   * @returns Array of question strings
   */
  private extractQuestions(text: string): string[] {
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
   *
   * @param text - Text to extract actions from
   * @returns Array of action strings
   */
  private extractActions(text: string): string[] {
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
   * Find groups of similar items using Jaccard similarity
   *
   * Groups items that have 70%+ word overlap (based on Jaccard similarity).
   *
   * @param items - Items to group by similarity
   * @returns Array of similar item groups
   */
  private findSimilarGroups(items: string[]): string[][] {
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

        if (this.areTextsSimilar(item, compareItem)) {
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
   * Calculates word overlap: intersection / union >= 70%
   *
   * @param text1 - First text
   * @param text2 - Second text
   * @returns True if texts are similar
   */
  private areTextsSimilar(text1: string, text2: string): boolean {
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

    return similarity >= THINKING_LOOP_DETECTOR.SIMILARITY_THRESHOLD;
  }

  /**
   * Truncate text for display
   *
   * @param text - Text to truncate
   * @param maxLength - Maximum length
   * @returns Truncated text with ellipsis if needed
   */
  private truncateText(text: string, maxLength: number): string {
    if (text.length <= maxLength) {
      return text;
    }
    return text.slice(0, maxLength - 3) + '...';
  }

  /**
   * Handle loop detection
   *
   * Marks loop as detected, logs it, and invokes callback.
   * Stops further checking to avoid multiple callbacks.
   *
   * @param info - Loop information
   */
  private handleLoopDetected(info: ThinkingLoopInfo): void {
    this.hasDetectedLoop = true;

    logger.debug('[THINKING_LOOP_DETECTOR]', this.config.instanceId, `Loop detected: ${info.reason}`);

    // Invoke callback
    this.config.onLoopDetected(info);

    // Stop checking (but don't clear state yet - that happens in stop())
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
  }

  /**
   * Stop monitoring and clear all timers
   *
   * Call this when thinking completes (success, error, or interruption).
   * Safe to call multiple times - subsequent calls are ignored.
   */
  stop(): void {
    if (!this.isMonitoring) {
      return;
    }

    // Clear warmup timer if still waiting
    if (this.warmupTimer) {
      clearTimeout(this.warmupTimer);
      this.warmupTimer = null;
    }

    // Clear check timer if running
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }

    this.isMonitoring = false;

    logger.debug('[THINKING_LOOP_DETECTOR]', this.config.instanceId, 'Stopped');
  }

  /**
   * Reset detector for a new thinking session
   *
   * Clears all state and prepares for fresh monitoring.
   * Call this when starting a new thinking session.
   */
  reset(): void {
    this.stop();
    this.accumulatedText = '';
    this.hasDetectedLoop = false;

    logger.debug('[THINKING_LOOP_DETECTOR]', this.config.instanceId, 'Reset');
  }

  /**
   * Get the current accumulated text length
   *
   * Useful for debugging or displaying current state.
   *
   * @returns Number of characters accumulated
   */
  getAccumulatedLength(): number {
    return this.accumulatedText.length;
  }

  /**
   * Check if monitoring is currently active
   *
   * @returns True if monitoring is active, false otherwise
   */
  isActive(): boolean {
    return this.isMonitoring;
  }

  /**
   * Check if a loop has been detected
   *
   * @returns True if a loop was detected, false otherwise
   */
  hasDetected(): boolean {
    return this.hasDetectedLoop;
  }
}
