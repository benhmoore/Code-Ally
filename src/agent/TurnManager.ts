/**
 * TurnManager - Manages turn timing and duration limits for agents
 *
 * Responsibilities:
 * - Track when a turn starts (turn = agent execution session)
 * - Calculate elapsed turn duration
 * - Enforce maximum duration limits
 * - Provide duration information for time-aware features
 *
 * This is primarily used for specialized agents (subagents) to prevent
 * them from running indefinitely. The main agent typically doesn't have
 * duration limits.
 */

import { logger } from '../services/Logger.js';

/**
 * Configuration for TurnManager
 */
export interface TurnManagerConfig {
  /** Maximum duration in minutes (optional, can be updated) */
  maxDuration?: number;
  /** Agent instance ID for logging */
  instanceId?: string;
}

/**
 * Manages turn timing and duration enforcement for agents
 */
export class TurnManager {
  /** Turn start time (ms since epoch) */
  private turnStartTime?: number;

  /** Maximum duration in minutes */
  private maxDuration?: number;

  /** Agent instance ID for logging */
  private readonly instanceId: string;

  /**
   * Create a new TurnManager
   *
   * @param config - Configuration options
   */
  constructor(config: TurnManagerConfig = {}) {
    this.maxDuration = config.maxDuration;
    this.instanceId = config.instanceId ?? 'unknown';

    if (this.maxDuration !== undefined) {
      logger.debug('[TURN_MANAGER]', this.instanceId, 'Initialized with max duration:', this.maxDuration, 'minutes');
    }
  }

  /**
   * Start a new turn
   *
   * Records the current timestamp as the turn start time.
   * Call this at the beginning of each agent execution session.
   */
  startTurn(): void {
    this.turnStartTime = Date.now();
    logger.debug('[TURN_MANAGER]', this.instanceId, 'Turn started at', this.turnStartTime);
  }

  /**
   * Reset the turn start time
   *
   * Useful when starting a new conversation turn or resetting the timer.
   */
  resetTurn(): void {
    this.turnStartTime = Date.now();
    logger.debug('[TURN_MANAGER]', this.instanceId, 'Turn reset at', this.turnStartTime);
  }

  /**
   * Get the turn start time
   *
   * @returns Turn start timestamp (ms since epoch) or undefined if not started
   */
  getTurnStartTime(): number | undefined {
    return this.turnStartTime;
  }

  /**
   * Get elapsed turn duration in milliseconds
   *
   * @returns Elapsed time since turn start, or 0 if turn not started
   */
  getElapsedMs(): number {
    if (!this.turnStartTime) {
      return 0;
    }
    return Date.now() - this.turnStartTime;
  }

  /**
   * Get elapsed turn duration in minutes
   *
   * @returns Elapsed time since turn start in minutes, or 0 if not started
   */
  getElapsedMinutes(): number {
    return this.getElapsedMs() / 60000;
  }

  /**
   * Get elapsed turn duration in seconds
   *
   * @returns Elapsed time since turn start in seconds, or 0 if not started
   */
  getElapsedSeconds(): number {
    return this.getElapsedMs() / 1000;
  }

  /**
   * Check if maximum duration has been exceeded
   *
   * @returns True if turn has exceeded max duration, false otherwise
   */
  isMaxDurationExceeded(): boolean {
    if (!this.maxDuration || !this.turnStartTime) {
      return false; // No limit or turn not started
    }

    const elapsedMinutes = this.getElapsedMinutes();
    return elapsedMinutes > this.maxDuration;
  }

  /**
   * Get remaining time in minutes
   *
   * @returns Minutes remaining before max duration, or undefined if no limit
   */
  getRemainingMinutes(): number | undefined {
    if (!this.maxDuration || !this.turnStartTime) {
      return undefined; // No limit or turn not started
    }

    const elapsedMinutes = this.getElapsedMinutes();
    const remaining = this.maxDuration - elapsedMinutes;
    return Math.max(0, remaining);
  }

  /**
   * Get maximum duration in minutes
   *
   * @returns Maximum duration if set, undefined otherwise
   */
  getMaxDuration(): number | undefined {
    return this.maxDuration;
  }

  /**
   * Set maximum duration in minutes
   *
   * Allows updating the time budget for individual turns.
   *
   * @param minutes - Maximum duration in minutes (or undefined to remove limit)
   */
  setMaxDuration(minutes: number | undefined): void {
    this.maxDuration = minutes;
    logger.debug('[TURN_MANAGER]', this.instanceId, 'Max duration updated to', minutes, 'minutes');
  }

  /**
   * Check if turn has started
   *
   * @returns True if turn has started, false otherwise
   */
  hasTurnStarted(): boolean {
    return this.turnStartTime !== undefined;
  }

  /**
   * Clear turn state
   *
   * Resets turn start time and duration tracking.
   */
  clearTurn(): void {
    this.turnStartTime = undefined;
    logger.debug('[TURN_MANAGER]', this.instanceId, 'Turn cleared');
  }

  /**
   * Get formatted duration string
   *
   * @returns Human-readable duration (e.g., "2m 30s")
   */
  getFormattedDuration(): string {
    const elapsedMs = this.getElapsedMs();
    const seconds = Math.floor(elapsedMs / 1000);
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;

    if (minutes > 0) {
      return `${minutes}m ${remainingSeconds}s`;
    } else {
      return `${seconds}s`;
    }
  }
}
