/**
 * ActivityMonitor - Detects agents stuck generating tokens without making tool calls
 *
 * Purpose:
 * Specialized agents (subagents) can sometimes get stuck in infinite loops where they
 * generate tokens continuously without making tool calls. This monitor detects such
 * scenarios by tracking the time since the last tool call and interrupting the agent
 * if it exceeds a configured timeout.
 *
 * Key Features:
 * - Watchdog timer that periodically checks for activity
 * - Tracks time since last tool call
 * - Callback mechanism for timeout handling
 * - Clean start/stop interface for lifecycle management
 * - Only monitors specialized agents (disabled for main agent)
 *
 * PARENT-CHILD AGENT COORDINATION
 * ================================
 *
 * ActivityMonitor plays a critical role in parent-child agent coordination:
 *
 * PROBLEM: When a parent agent delegates to a child agent (e.g., via AgentTool),
 * the parent agent pauses while the child executes. During this time, the parent
 * is not making tool calls, which could trigger a false timeout.
 *
 * SOLUTION: Parent agents pause their ActivityMonitor before delegating, and
 * resume it when the child completes. This prevents false timeouts while
 * preserving timeout detection for genuinely stuck agents.
 *
 * INTEGRATION: Parent agent reference is set in Agent.ts (lines 231-234) from
 * config.parentAgent. When a child agent starts, it calls:
 *   1. this.parentAgent.pauseActivityMonitoring()  (line 608, before sendMessage)
 *   2. this.parentAgent.resumeActivityMonitoring() (line 872, after sendMessage, in finally)
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

  /** Whether monitoring is enabled (typically disabled for main agent, enabled for specialized agents) */
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
    if (this.watchdogInterval) {
      clearInterval(this.watchdogInterval);
      this.watchdogInterval = null;
      this.isRunning = false;
      this.pauseCount = 0;
      logger.debug('[ACTIVITY_MONITOR]', this.config.instanceId, 'Stopped');
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
   * Resume monitoring agent activity
   *
   * Restarts the watchdog timer after being paused. Conditionally records progress
   * by updating lastActivityTime to Date.now() based on whether the delegated work
   * succeeded or failed.
   *
   * PARENT-CHILD COORDINATION CONTEXT:
   * This method is called when a child agent completes execution (Agent.ts line 872,
   * in finally block). The child agent resumes the parent's activity monitoring,
   * signaling that the delegation is complete and the parent should continue monitoring
   * for timeout conditions.
   *
   * The coordination flow completes as:
   *   1. Child finishes work (success, error, or timeout)
   *   2. finally block ensures parent is always resumed: this.parentAgent.resumeActivityMonitoring()
   *   3. Parent's activity timer conditionally resets based on success/failure
   *   4. Parent continues monitoring for its own timeout conditions
   *
   * Progress Recording Semantics:
   * - delegationSucceeded=true (default): Records progress by resetting lastActivityTime
   *   - Semantic: "The delegated work I was waiting for has completed successfully"
   *   - This prevents timeout after long delegations where wall-clock time advanced but the agent
   *     was actually making progress through its delegated sub-agent
   *   - Without this, an agent that delegates a 50-second task would timeout immediately after
   *     the delegation completes, even though it was making productive progress the entire time
   *
   * - delegationSucceeded=false: Does NOT record progress, preserves lastActivityTime
   *   - Semantic: "The delegated work failed, so no actual progress was made"
   *   - This ensures a parent agent that delegates to a failing child doesn't get its timer reset
   *   - If the parent keeps delegating to failing children without making progress, it will timeout
   *   - Example: Agent delegates to child that immediately errors - parent should not get credit
   *
   * When to Pass delegationSucceeded=true (default):
   * - Delegated work completed successfully (normal execution finished)
   * - Child agent returned a result, even if the result indicates partial success
   * - The delegation itself succeeded, even if the outcome wasn't perfect
   *
   * When to Pass delegationSucceeded=false:
   * - Delegated work threw an error or exception
   * - Child agent was interrupted before completing
   * - Child agent timed out without making progress
   * - The delegation failed catastrophically
   *
   * Reference Counting:
   * - Uses reference counting: multiple pause() calls require matching resume() calls
   * - The watchdog timer is only restarted when the pause count reaches zero
   * - Safe to call multiple times - maintains a count of pause requests
   * - Safe to call when not enabled - will be a no-op
   *
   * @param delegationSucceeded - Whether the delegated work succeeded (default: true)
   *                              true = record progress (reset timer)
   *                              false = don't record progress (preserve timer)
   */
  resume(delegationSucceeded: boolean = true): void {
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
      // Conditionally record progress based on delegation success
      if (delegationSucceeded) {
        // Record progress: delegation completion represents successful progress
        // Semantic: "The delegating tool call I was waiting for has completed successfully"
        // This prevents timeout after long delegations where wall-clock time advanced
        this.lastActivityTime = Date.now();
        logger.debug('[ACTIVITY_MONITOR]', this.config.instanceId, 'Progress recorded: delegation succeeded');
      } else {
        // Do NOT record progress: delegation failed, no progress was made
        // Semantic: "The delegating tool call I was waiting for has failed"
        // This ensures parent agents don't get timer resets for failed delegations
        logger.debug('[ACTIVITY_MONITOR]', this.config.instanceId, 'Progress NOT recorded: delegation failed');
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
