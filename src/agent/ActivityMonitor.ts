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
   * Uses reference counting: multiple pause() calls require matching resume() calls.
   * The watchdog timer is only stopped on the first pause() call.
   *
   * Safe to call multiple times - maintains a count of pause requests.
   * Safe to call when not started - will be a no-op.
   */
  pause(): void {
    console.log(`[DEBUG-MONITOR-STATE] ${this.config.instanceId} pause() called. isRunning=${this.isRunning}, pauseCount=${this.pauseCount}`);
    // No-op if not started
    if (!this.isRunning) {
      console.log(`[DEBUG-MONITOR-STATE] ${this.config.instanceId} NOT running, pause() is no-op`);
      return;
    }

    // Increment pause count
    this.pauseCount++;

    // Only stop the watchdog timer on the first pause
    if (this.pauseCount === 1) {
      if (this.watchdogInterval) {
        clearInterval(this.watchdogInterval);
        this.watchdogInterval = null;
      }
      this.isRunning = false;
      console.log(`[DEBUG-MONITOR-STATE] ${this.config.instanceId} PAUSED watchdog (pauseCount: ${this.pauseCount})`);
      logger.debug('[ACTIVITY_MONITOR]', this.config.instanceId, `Paused (pauseCount: ${this.pauseCount})`);
    } else {
      console.log(`[DEBUG-MONITOR-STATE] ${this.config.instanceId} Pause count incremented (pauseCount: ${this.pauseCount})`);
      logger.debug('[ACTIVITY_MONITOR]', this.config.instanceId, `Pause count incremented (pauseCount: ${this.pauseCount})`);
    }
  }

  /**
   * Resume monitoring agent activity
   *
   * Restarts the watchdog timer after being paused, preserving the lastActivityTime.
   * This ensures timeout tracking continues from where it was when paused, maintaining
   * accurate elapsed time calculations.
   *
   * Uses reference counting: multiple pause() calls require matching resume() calls.
   * The watchdog timer is only restarted when the pause count reaches zero.
   *
   * Safe to call multiple times - maintains a count of pause requests.
   * Safe to call when not enabled - will be a no-op.
   */
  resume(): void {
    console.log(`[DEBUG-MONITOR-STATE] ${this.config.instanceId} resume() called. enabled=${this.config.enabled}, pauseCount=${this.pauseCount}`);
    // No-op if monitoring is disabled
    if (!this.config.enabled) {
      console.log(`[DEBUG-MONITOR-STATE] ${this.config.instanceId} Monitoring disabled, resume() is no-op`);
      return;
    }

    // Skip if not paused
    if (this.pauseCount === 0) {
      console.log(`[DEBUG-MONITOR-STATE] ${this.config.instanceId} Not paused (pauseCount=0), resume() is no-op`);
      logger.debug('[ACTIVITY_MONITOR]', this.config.instanceId, 'Not paused, ignoring resume()');
      return;
    }

    // Decrement pause count (ensure it doesn't go negative)
    this.pauseCount = Math.max(0, this.pauseCount - 1);

    // Only restart the watchdog timer when pause count reaches zero
    if (this.pauseCount === 0) {
      // Record progress on resume: delegation completion represents successful progress
      // Semantic: "The delegating tool call I was waiting for has completed successfully"
      // This prevents timeout after long delegations where wall-clock time advanced
      this.lastActivityTime = Date.now();
      console.log(`[DEBUG-MONITOR-STATE] ${this.config.instanceId} Recording progress on resume (delegation completed)`);

      // Restart the watchdog interval
      this.watchdogInterval = setInterval(() => {
        this.checkTimeout();
      }, this.config.checkIntervalMs);

      this.isRunning = true;
      console.log(`[DEBUG-MONITOR-STATE] ${this.config.instanceId} RESUMED watchdog (pauseCount: ${this.pauseCount})`);
      logger.debug('[ACTIVITY_MONITOR]', this.config.instanceId, `Resumed (pauseCount: ${this.pauseCount})`);
    } else {
      console.log(`[DEBUG-MONITOR-STATE] ${this.config.instanceId} Pause count decremented (pauseCount: ${this.pauseCount})`);
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
      console.log(`[DEBUG-MONITOR-STATE] ${this.config.instanceId} checkTimeout() skipped (paused, pauseCount=${this.pauseCount})`);
      return;
    }

    const elapsedMs = Date.now() - this.lastActivityTime;

    if (elapsedMs > this.config.timeoutMs) {
      const elapsedSeconds = Math.round(elapsedMs / 1000);
      const timeoutSeconds = this.config.timeoutMs / 1000;

      console.log(`[DEBUG-MONITOR-STATE] ${this.config.instanceId} TIMEOUT DETECTED! elapsed=${elapsedSeconds}s, limit=${timeoutSeconds}s, pauseCount=${this.pauseCount}`);
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
