/**
 * ContextCoordinator - Coordinates context usage monitoring and token management
 *
 * Core responsibilities:
 * - Monitor context usage percentage
 * - Check context limits
 * - Coordinate with TokenManager for token tracking
 * - Provide context-related utilities for decision making
 *
 * This class extracts context tracking logic from Agent to maintain
 * separation of concerns and improve testability.
 */

import { TokenManager } from './TokenManager.js';
import { ConversationManager } from './ConversationManager.js';
import { logger } from '../services/Logger.js';

/**
 * ContextCoordinator manages context usage tracking and limits
 */
export class ContextCoordinator {
  constructor(
    private tokenManager: TokenManager,
    private conversationManager: ConversationManager,
    private instanceId: string
  ) {}

  /**
   * Get the current context usage as a percentage (0-100)
   *
   * Delegates to TokenManager for actual calculation.
   *
   * @returns Context usage percentage, capped at 100
   */
  getContextUsagePercentage(): number {
    return this.tokenManager.getContextUsagePercentage();
  }

  /**
   * Check if context usage is near or above a threshold
   *
   * @param thresholdPercent - Threshold percentage (0-100)
   * @returns true if usage is at or above threshold
   */
  isNearContextLimit(thresholdPercent: number): boolean {
    return this.tokenManager.isAboveThreshold(thresholdPercent);
  }

  /**
   * Update token count based on current conversation messages
   * Should be called after message additions or conversation changes
   */
  updateTokenCount(): void {
    this.tokenManager.updateTokenCount(this.conversationManager.getMessages());
  }

  /**
   * Log current context usage for debugging
   *
   * @param label - Optional label for the log message
   */
  logContextUsage(label?: string): void {
    const contextUsage = this.getContextUsagePercentage();
    const messageCount = this.conversationManager.getMessageCount();
    const logLabel = label ? `${label} - ` : '';

    logger.debug(
      '[AGENT_CONTEXT]',
      this.instanceId,
      `${logLabel}Context usage: ${contextUsage}%, Messages: ${messageCount}`
    );
  }

  /**
   * Get detailed context statistics
   *
   * @returns Context statistics including token counts and usage
   */
  getContextStats(): {
    contextSize: number;
    currentTokens: number;
    remainingTokens: number;
    usagePercentage: number;
    messageCount: number;
  } {
    const stats = this.tokenManager.getStats();
    return {
      ...stats,
      messageCount: this.conversationManager.getMessageCount(),
    };
  }

  /**
   * Check if context has enough room for additional tokens
   *
   * @param requiredTokens - Number of tokens needed
   * @returns true if there's enough room
   */
  hasRoomForTokens(requiredTokens: number): boolean {
    const remaining = this.tokenManager.getRemainingTokens();
    return remaining >= requiredTokens;
  }

  /**
   * Get the TokenManager instance
   * Used by components that need direct access (e.g., ToolResultManager)
   *
   * @returns TokenManager instance
   */
  getTokenManager(): TokenManager {
    return this.tokenManager;
  }

  /**
   * Get the ConversationManager instance
   * Used by components that need direct access
   *
   * @returns ConversationManager instance
   */
  getConversationManager(): ConversationManager {
    return this.conversationManager;
  }
}
