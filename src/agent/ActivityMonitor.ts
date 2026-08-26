/**
 * ActivityMonitor - Detects agents stuck generating tokens without making tool calls
 *
 * Purpose:
 * Agents can sometimes get stuck in infinite loops where they
 * generate tokens continuously without making tool calls. This monitor detects such
 * scenarios by tracking the time since the last tool call and interrupting the agent
 * if it exceeds a configured timeout.
 *
 * Key Features:
 * - Watchdog timer that periodically checks for activity
 * - Tracks time since last tool call
 * - Callback mechanism for timeout handling
 * - Clean start/stop interface for lifecycle management
 * - Applies to main and specialized agents when configured
 *
 * PAUSED OPERATION COORDINATION
 * =============================
 *
 * Tool execution, compaction, checks, and child-agent delegation can all take
 * longer than the model-generation watchdog permits. Their owners pause the
 * monitor for the bounded operation and resume it afterward. Completion earns
 * fresh progress credit; exceptions and interruption do not.
 *
 * REFERENCE COUNTING: Multiple pause/resume calls are handled via pauseCount,
 * allowing safe nesting (e.g., Agent1 → Agent2 → Agent3). The monitor only
 * resumes when pauseCount reaches zero.
 *
 * Usage:
 * ```typescript
 * const monitor = new ActivityMonitor({
 *   timeoutMs: 60000, // 60 second timeout
 *   checkIntervalMs: 10000, // Check every 10 seconds
 *   enabled: true, // Enable monitoring
 *   onTimeout: (elapsedMs) => {
 *     console.log(`Timeout after ${elapsedMs}ms`);
 *     // Handle timeout (e.g., interrupt agent)
 *   }
 * });
 *
 * monitor.start();
 * monitor.recordActivity(); // Call when tool is executed
 * monitor.stop();
 * ```
 */

import { logger } from '../services/Logger.js';

/**
 * Configuration options for ActivityMonitor
 */
export interface ActivityMonitorConfig {
  /** Timeout threshold in milliseconds - agent is interrupted if no tool calls occur within this period */
  timeoutMs: number;

  /** Interval in milliseconds for checking activity (default: 10000ms / 10 seconds) */
  checkIntervalMs?: number;

  /** Whether monitoring is enabled */
  enabled: boolean;

  /** Callback invoked when activity timeout is detected */
  onTimeout: (elapsedMs: number) => void;

  /** Instance identifier for logging (optional) */
  instanceId?: string;
}

/**
 * ActivityMonitor monitors agent activity and detects timeout scenarios
 *
 * This class implements a watchdog timer pattern that:
 * 1. Tracks when the last tool call occurred
 * 2. Periodically checks if too much time has elapsed without tool calls
 * 3. Invokes a callback when timeout is detected
 * 4. Provides clean start/stop lifecycle management
 */
export class ActivityMonitor {
  private config: Required<ActivityMonitorConfig>;
  private lastActivityTime: number = Date.now();
  private watchdogInterval: NodeJS.Timeout | null = null;
  private isRunning: boolean = false;
  private pauseCount: number = 0;
  // Safety limit: prevents stuck monitors from pause/resume mismatches
  // If pause count exceeds this limit, reset to 0 to recover from corrupted state
  private maxPauseCount: number = 10;
  // A model request is in flight and has produced no output yet (prefill).
  // See awaitingFirstOutput handling in checkTimeout() for why this suspends the clock.
  private awaitingFirstOutput: boolean = false;

  /**
   * Create a new ActivityMonitor
   *
   * @param config - Configuration options
   */
  constructor(config: ActivityMonitorConfig) {
    // Apply defaults for optional parameters
    this.config = {
      ...config,
      checkIntervalMs: config.checkIntervalMs ?? 10000,
      instanceId: config.instanceId ?? 'unknown',
    };
  }

  /**
   * Start monitoring agent activity
   *
   * Initializes the watchdog timer that periodically checks for timeout.
   * If monitoring is disabled (config.enabled = false), this is a no-op.
   * Safe to call multiple times - subsequent calls are ignored if already running.
   */
  start(): void {
    // Skip if monitoring is disabled
    if (!this.config.enabled) {
      return;
    }

    // Skip if already running
    if (this.isRunning) {
      logger.debug('[ACTIVITY_MONITOR]', this.config.instanceId, 'Already running, ignoring start()');
      return;
    }

    // Reset activity time at start
    this.lastActivityTime = Date.now();
    this.isRunning = true;

    // Start watchdog interval
    this.watchdogInterval = setInterval(() => {
      this.checkTimeout();
    }, this.config.checkIntervalMs);

    logger.debug(
      '[ACTIVITY_MONITOR]',
      this.config.instanceId,
      `Started - timeout: ${this.config.timeoutMs}ms, check interval: ${this.config.checkIntervalMs}ms`
    );
  }

  /**
   * Stop monitoring agent activity
   *
   * Clears the watchdog timer and resets state.
   * Safe to call multiple times - subsequent calls are ignored if already stopped.
   */
  stop(): void {
    const wasRunning = this.watchdogInterval !== null;

    if (this.watchdogInterval) {
      clearInterval(this.watchdogInterval);
      this.watchdogInterval = null;
    }

    // Reset unconditionally: stopping while paused used to leave pauseCount
    // above zero, and since start() only guards on isRunning, the next turn
    // would arm a watchdog whose every check short-circuits on the stale pause.
    this.isRunning = false;
    this.pauseCount = 0;
    this.awaitingFirstOutput = false;

    if (wasRunning) {
      logger.debug('[ACTIVITY_MONITOR]', this.config.instanceId, 'Stopped');
    }
  }

  /**
   * Update monitor configuration at runtime.
   */
  updateConfig(config: Partial<Pick<ActivityMonitorConfig, 'timeoutMs' | 'enabled'>>): void {
    const shouldRestart = this.isRunning && (config.enabled ?? this.config.enabled);

    if (this.isRunning) {
      this.stop();
    }

    this.config = {
      ...this.config,
      ...config,
    };

    if (shouldRestart) {
      this.start();
    }
  }

  /**
   * Pause monitoring agent activity
   *
   * Temporarily stops the watchdog timer while preserving the lastActivityTime.
   * This allows monitoring to be paused without losing track of when the last
   * activity occurred, which is critical for accurate timeout tracking when resumed.
   *
   * PARENT-CHILD COORDINATION CONTEXT:
   * This method is called when a child agent starts execution (Agent.ts line 608).
   * The parent agent must pause its activity monitoring to prevent false timeouts
   * while the child is actively working. The coordination flow is:
   *
   *   1. Child agent constructor initializes (Agent.ts line 234: this.parentAgent = config.parentAgent)
   *   2. Child agent starts execution (Agent.sendMessage)
   *   3. Child immediately pauses parent: this.parentAgent.pauseActivityMonitoring()
   *   4. Child executes its work (makes tool calls, generates responses)
   *   5. Child completes and resumes parent in finally block (Agent.ts line 872)
   *
   * This prevents the parent from timing out during legitimate delegation, while still
   * detecting genuinely stuck agents that stop making progress.
   *
   * REFERENCE COUNTING MECHANISM:
   * Uses reference counting (pauseCount) to support nested agent hierarchies:
   * - Multiple pause() calls increment pauseCount
   * - Only the first pause() stops the watchdog timer
   * - Matching resume() calls are required to fully resume
   * - This enables safe nesting: Parent → Child1 → Child2 → Child3
   *
   * Safe to call multiple times - maintains a count of pause requests.
   * Safe to call when not started - will be a no-op.
   */
  pause(): void {
    // No-op if not enabled (monitoring is disabled entirely)
    if (!this.config.enabled) {
      return;
    }

    // Safety check: prevent pause count corruption from breaking the monitor
    if (this.pauseCount >= this.maxPauseCount) {
      logger.error('[ACTIVITY_MONITOR]', this.config.instanceId, `Pause count exceeded safety limit (${this.maxPauseCount}). Resetting to 0 to recover.`);
      this.pauseCount = 0;
      return;
    }

    // Increment pause count (even if not currently running - supports nested pauses)
    this.pauseCount++;

    // Only stop the watchdog timer on the first pause (when isRunning=true)
    if (this.pauseCount === 1 && this.isRunning) {
      if (this.watchdogInterval) {
        clearInterval(this.watchdogInterval);
        this.watchdogInterval = null;
      }
      this.isRunning = false;
      logger.debug('[ACTIVITY_MONITOR]', this.config.instanceId, `Paused (pauseCount: ${this.pauseCount})`);
    } else {
      logger.debug('[ACTIVITY_MONITOR]', this.config.instanceId, `Pause count incremented (pauseCount: ${this.pauseCount})`);
    }
  }

  /**
   * Resume monitoring after a bounded operation that legitimately paused the
   * no-progress clock (tool execution, compaction, checks, or delegation).
   *
   * Pauses are reference-counted. Only the outermost resume restarts the
   * watchdog, and only a completed operation receives progress credit. An
   * operation that threw, timed out, or was interrupted resumes monitoring
   * without extending the deadline.
   */
  resume(operationCompleted: boolean = true): void {
    // No-op if monitoring is disabled
    if (!this.config.enabled) {
      return;
    }

    // Skip if not paused
    if (this.pauseCount === 0) {
      logger.debug('[ACTIVITY_MONITOR]', this.config.instanceId, 'Not paused, ignoring resume()');
      return;
    }

    // Decrement pause count (ensure it doesn't go negative)
    this.pauseCount = Math.max(0, this.pauseCount - 1);

    // Only restart the watchdog timer when pause count reaches zero
    if (this.pauseCount === 0) {
      if (operationCompleted) {
        this.lastActivityTime = Date.now();
        logger.debug('[ACTIVITY_MONITOR]', this.config.instanceId, 'Progress recorded: paused operation completed');
      } else {
        logger.debug('[ACTIVITY_MONITOR]', this.config.instanceId, 'Progress not recorded: paused operation incomplete');
      }

      // Restart the watchdog interval
      this.watchdogInterval = setInterval(() => {
        this.checkTimeout();
      }, this.config.checkIntervalMs);

      this.isRunning = true;
      logger.debug('[ACTIVITY_MONITOR]', this.config.instanceId, `Resumed (pauseCount: ${this.pauseCount})`);
    } else {
      logger.debug('[ACTIVITY_MONITOR]', this.config.instanceId, `Pause count decremented (pauseCount: ${this.pauseCount})`);
    }
  }

  /**
   * Record agent activity (typically a tool call)
   *
   * Resets the activity timer. Call this whenever the agent executes a tool
   * to indicate that it's making progress and not stuck.
   */
  recordActivity(): void {
    this.lastActivityTime = Date.now();
    logger.debug('[ACTIVITY_MONITOR]', this.config.instanceId, 'Activity recorded');
  }

  /**
   * Mark the start of a model request that has not produced output yet.
   *
   * Prefill emits nothing on the wire, so a large prompt on a slow (typically
   * local) backend looks identical to a stuck agent from this monitor's vantage
   * point. Killing it here is worse than useless: the retry re-sends an even
   * larger prompt and times out again, so the turn can never complete. That
   * phase is bounded by the transport instead (`readWithTimeout` per read, plus
   * the overall request budget), so the watchdog stands down until output
   * actually starts.
   */
  beginModelRequest(): void {
    this.awaitingFirstOutput = true;
    this.lastActivityTime = Date.now();
    logger.debug('[ACTIVITY_MONITOR]', this.config.instanceId, 'Model request started - awaiting first output');
  }

  /**
   * Mark the end of a model request (response returned, errored, or aborted).
   *
   * The clock restarts from here so the gaps this monitor still owns — response
   * processing and the space between requests — remain covered.
   */
  endModelRequest(): void {
    if (!this.awaitingFirstOutput) return;
    this.awaitingFirstOutput = false;
    this.lastActivityTime = Date.now();
    logger.debug('[ACTIVITY_MONITOR]', this.config.instanceId, 'Model request ended without output');
  }

  /**
   * Record streamed model output (assistant or thinking chunks).
   *
   * Tool calls used to be the only accepted proof of life, which made this a
   * wall-clock cap on a single generation rather than a stall detector: a model
   * streaming steadily for longer than the timeout was interrupted mid-answer.
   * Streamed tokens are progress, so they reset the clock; what remains detected
   * is a generation that goes *silent* for the full timeout. Unbounded but
   * non-repetitive output is bounded elsewhere (output token limit, per-turn
   * round-trip budget), and repetition is the LoopDetector's job.
   *
   * Ignored while paused so a delegated agent's stream cannot credit the parent
   * that is waiting on it (see resume's `delegationSucceeded` semantics).
   */
  recordStreamProgress(): void {
    if (this.pauseCount > 0) return;

    const wasAwaiting = this.awaitingFirstOutput;
    this.awaitingFirstOutput = false;
    this.lastActivityTime = Date.now();

    if (wasAwaiting) {
      logger.debug('[ACTIVITY_MONITOR]', this.config.instanceId, 'First model output received - watchdog armed');
    }
  }

  /**
   * Check if timeout has occurred
   *
   * Called periodically by the watchdog timer. If elapsed time since last
   * activity exceeds the timeout threshold, invokes the timeout callback.
   * This method is exposed for testing purposes but is primarily used internally.
   *
   * Skips timeout checks when paused to avoid false positives during pause periods.
   */
  checkTimeout(): void {
    // Skip timeout checks when paused
    if (this.pauseCount > 0) {
      return;
    }

    // Skip while a request is still in prefill (no output yet) - bounded by the
    // transport's stream-read timeout, not by this watchdog.
    if (this.awaitingFirstOutput) {
      return;
    }

    const elapsedMs = Date.now() - this.lastActivityTime;

    if (elapsedMs > this.config.timeoutMs) {
      const elapsedSeconds = Math.round(elapsedMs / 1000);
      const timeoutSeconds = this.config.timeoutMs / 1000;

      logger.debug(
        '[ACTIVITY_MONITOR]',
        this.config.instanceId,
        `Timeout detected: ${elapsedSeconds}s since last activity (limit: ${timeoutSeconds}s)`
      );

      // Invoke timeout callback
      this.config.onTimeout(elapsedMs);
    }
  }

  /**
   * Check if monitoring is currently active
   *
   * @returns True if the watchdog is running, false otherwise
   */
  isActive(): boolean {
    return this.isRunning;
  }

  /**
   * Get time elapsed since last activity
   *
   * Useful for debugging or displaying current activity state.
   *
   * @returns Milliseconds since last recorded activity
   */
  getElapsedTime(): number {
    return Date.now() - this.lastActivityTime;
  }
}
