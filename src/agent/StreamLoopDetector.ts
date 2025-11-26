/**
 * StreamLoopDetector - Generic stream loop detection for activity events
 *
 * Purpose:
 * This is a generic, reusable implementation for detecting loop patterns in
 * streaming activity events. It monitors any configurable event type and runs
 * pattern-based detection strategies on accumulated text.
 *
 * Key Features:
 * - Generic event type subscription (not hardcoded to specific events)
 * - Strategy-based pattern detection (configurable patterns)
 * - Warmup period before detection starts (configurable)
 * - Periodic checking during streaming (configurable interval)
 * - Clean lifecycle management (proper timer and subscription cleanup)
 * - First-match wins (patterns checked in order)
 *
 * Design:
 * Extracted from ThinkingLoopDetector to create a reusable component.
 * Uses the Strategy pattern for loop detection algorithms.
 * Manages its own ActivityStream subscription and timer lifecycle.
 *
 * Usage:
 * ```typescript
 * const detector = new StreamLoopDetector(
 *   {
 *     eventType: ActivityEventType.THOUGHT_CHUNK,
 *     patterns: [
 *       new ReconstructionCyclePattern(),
 *       new RepeatedQuestionPattern(),
 *       new RepeatedActionPattern(),
 *     ],
 *     warmupPeriodMs: 20000,
 *     checkIntervalMs: 5000,
 *     onLoopDetected: (info) => {
 *       console.log(`Loop detected: ${info.reason}`);
 *       // Handle interruption
 *     },
 *     instanceId: 'agent-123',
 *   },
 *   activityStream
 * );
 *
 * // Detector automatically starts on first chunk
 * // ...streaming events arrive...
 *
 * // When done
 * detector.stop();
 * ```
 */

import { logger } from '../services/Logger.js';
import type { ActivityStream } from '../services/ActivityStream.js';
import type {
  StreamLoopDetectorConfig,
  LoopInfo,
} from './types/loopDetection.js';

/**
 * StreamLoopDetector monitors activity stream events for loop patterns
 *
 * This class implements a generic watchdog pattern that:
 * 1. Subscribes to configurable activity event types
 * 2. Accumulates text chunks from streaming events
 * 3. Waits for a configurable warmup period before checking
 * 4. Periodically analyzes accumulated text using pattern strategies
 * 5. Invokes callback when first pattern match is detected
 * 6. Stops monitoring on completion or interruption
 * 7. Cleans up subscriptions and timers properly
 */
export class StreamLoopDetector {
  private config: Required<Omit<StreamLoopDetectorConfig, 'instanceId'>> & {
    instanceId: string;
  };
  private activityStream: ActivityStream;
  private accumulatedText: string = '';
  private warmupTimer: NodeJS.Timeout | null = null;
  private checkTimer: NodeJS.Timeout | null = null;
  private isMonitoring: boolean = false;
  private hasDetectedLoop: boolean = false;
  private unsubscribe: (() => void) | null = null;

  /**
   * Create a new StreamLoopDetector
   *
   * @param config - Configuration options
   * @param activityStream - ActivityStream to subscribe to
   */
  constructor(config: StreamLoopDetectorConfig, activityStream: ActivityStream) {
    this.config = {
      ...config,
      instanceId: config.instanceId ?? 'unknown',
    };
    this.activityStream = activityStream;

    // Subscribe to the configured event type
    this.subscribeToEvents();
  }

  /**
   * Subscribe to activity stream events
   *
   * Sets up the event listener for the configured event type.
   * Extracts chunks from event.data?.chunk and starts monitoring.
   *
   * IMPORTANT: This method unsubscribes from any existing subscription
   * before creating a new one to prevent duplicate subscriptions.
   */
  private subscribeToEvents(): void {
    // Unsubscribe from existing subscription if any
    // This prevents duplicate subscriptions if called multiple times
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }

    this.unsubscribe = this.activityStream.subscribe(
      this.config.eventType,
      (event) => {
        // Extract chunk from event data
        const chunk = event.data?.chunk;
        if (chunk && typeof chunk === 'string') {
          this.addChunk(chunk);
        }
      }
    );
  }

  /**
   * Add a text chunk to the accumulator
   *
   * Starts monitoring on the first chunk received.
   * Subsequent chunks are simply appended to the accumulated text.
   *
   * @param chunk - Text chunk from the stream
   */
  private addChunk(chunk: string): void {
    // Skip empty chunks
    if (!chunk || chunk.trim().length === 0) {
      return;
    }

    // Append to accumulated text
    this.accumulatedText += chunk;

    // Start monitoring on first chunk
    if (!this.isMonitoring) {
      this.start();
    }
  }

  /**
   * Start monitoring for loop patterns
   *
   * Sets up a warmup timer followed by periodic checks.
   * Safe to call multiple times - subsequent calls are ignored.
   *
   * Note: This is called automatically on the first chunk, but can also
   * be called manually if needed.
   */
  start(): void {
    if (this.isMonitoring) {
      return;
    }

    this.isMonitoring = true;
    this.hasDetectedLoop = false;

    logger.debug(
      '[STREAM_LOOP_DETECTOR]',
      this.config.instanceId,
      `Started - event: ${this.config.eventType}, warmup: ${this.config.warmupPeriodMs}ms, check interval: ${this.config.checkIntervalMs}ms, patterns: ${this.config.patterns.length}`
    );

    // Schedule first check after warmup period
    this.warmupTimer = setTimeout(() => {
      this.warmupTimer = null;

      // Start periodic checking
      this.checkTimer = setInterval(() => {
        this.checkForLoops();
      }, this.config.checkIntervalMs);

      // Run first check immediately after warmup
      this.checkForLoops();

      logger.debug(
        '[STREAM_LOOP_DETECTOR]',
        this.config.instanceId,
        'Warmup complete, checks started'
      );
    }, this.config.warmupPeriodMs);
  }

  /**
   * Check accumulated text for loop patterns
   *
   * Runs all configured patterns in order until one matches.
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
      '[STREAM_LOOP_DETECTOR]',
      this.config.instanceId,
      `Checking ${this.accumulatedText.length} chars for patterns (${this.config.patterns.length} patterns)`
    );

    // Run patterns in order - first match wins
    for (const pattern of this.config.patterns) {
      try {
        const loopInfo = pattern.check(this.accumulatedText);
        if (loopInfo) {
          this.handleLoopDetected(loopInfo);
          return; // Stop checking after first detection
        }
      } catch (error) {
        logger.error(
          '[STREAM_LOOP_DETECTOR]',
          this.config.instanceId,
          `Pattern ${pattern.name} check failed:`,
          error
        );
        // Continue to next pattern
      }
    }
  }

  /**
   * Handle loop detection
   *
   * Marks loop as detected, logs it, and invokes callback.
   * Stops further checking to avoid multiple callbacks.
   *
   * @param info - Loop information
   */
  private handleLoopDetected(info: LoopInfo): void {
    this.hasDetectedLoop = true;

    logger.debug(
      '[STREAM_LOOP_DETECTOR]',
      this.config.instanceId,
      `Loop detected: ${info.reason} (pattern: ${info.patternName})`
    );

    // Invoke callback with error handling
    try {
      this.config.onLoopDetected(info);
    } catch (error) {
      logger.error(
        '[STREAM_LOOP_DETECTOR]',
        this.config.instanceId,
        'Loop detection callback failed:',
        error
      );
    }

    // Stop checking (but don't clear state yet - that happens in stop())
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
  }

  /**
   * Stop monitoring and clear all timers and subscriptions
   *
   * Call this when streaming completes (success, error, or interruption).
   * Safe to call multiple times - subsequent calls are ignored.
   *
   * IMPORTANT: This cleans up the ActivityStream subscription to prevent
   * memory leaks. Always call stop() when done with the detector.
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

    // Unsubscribe from activity stream
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }

    this.isMonitoring = false;

    logger.debug('[STREAM_LOOP_DETECTOR]', this.config.instanceId, 'Stopped');
  }

  /**
   * Reset detector for a new session
   *
   * Clears all state, re-subscribes to events, and prepares for fresh monitoring.
   * Call this when starting a new session.
   */
  reset(): void {
    this.stop();
    this.accumulatedText = '';
    this.hasDetectedLoop = false;
    this.subscribeToEvents();

    logger.debug('[STREAM_LOOP_DETECTOR]', this.config.instanceId, 'Reset');
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
