/**
 * RequiredToolTracker - Tracks execution of required tool calls for agents
 *
 * Core responsibilities:
 * - Maintains set of required tools that must be called before agent exit
 * - Tracks which required tools have been called
 * - Manages warning state when agent attempts to exit without required tools
 * - Provides validation and warning message management
 *
 * Usage:
 * 1. Configure required tools via setRequired()
 * 2. Mark tools as called via markCalled()
 * 3. Check completion status via areAllCalled()
 * 4. Handle warnings via shouldWarn() and related methods
 */

import { Message } from '../types/index.js';
import { logger } from '../services/Logger.js';
import { createRequiredToolsWarning } from '../utils/messageUtils.js';

export interface RequiredToolWarningResult {
  /** Whether a warning should be issued */
  shouldWarn: boolean;
  /** Missing tools that still need to be called */
  missingTools: string[];
  /** Current warning count */
  warningCount: number;
}

/**
 * Tracks required tool execution for specialized agents
 */
export class RequiredToolTracker {
  /** Set of required tool names that must be called */
  private requiredTools: Set<string> = new Set();

  /** Set of required tools that have been called */
  private calledTools: Set<string> = new Set();

  /** Number of warnings issued for missing required tools */
  private warningCount: number = 0;

  /** Index of the last warning message in conversation history (for removal) */
  private warningMessageIndex: number = -1;

  /** Agent instance ID for logging */
  private readonly instanceId: string;

  constructor(instanceId: string) {
    this.instanceId = instanceId;
  }

  /**
   * Configure required tools that must be called
   *
   * @param tools - Array of tool names that must be executed
   */
  setRequired(tools: string[]): void {
    this.requiredTools = new Set(tools);
    this.calledTools.clear();
    this.warningCount = 0;
    this.warningMessageIndex = -1;

    if (tools.length > 0) {
      logger.debug(
        '[REQUIRED_TOOLS]',
        this.instanceId,
        'Configured required tools:',
        tools
      );
    }
  }

  /**
   * Mark a tool as called
   *
   * @param toolName - Name of the tool that was executed
   * @returns True if this was a required tool, false otherwise
   */
  markCalled(toolName: string): boolean {
    if (this.requiredTools.has(toolName)) {
      this.calledTools.add(toolName);
      logger.debug(
        '[REQUIRED_TOOLS]',
        this.instanceId,
        `Tracked required tool call: ${toolName}`
      );
      logger.debug(
        '[REQUIRED_TOOLS]',
        this.instanceId,
        'Called so far:',
        Array.from(this.calledTools)
      );
      return true;
    }
    return false;
  }

  /**
   * Check if all required tools have been called
   *
   * @returns True if all required tools have been executed
   */
  areAllCalled(): boolean {
    if (this.requiredTools.size === 0) {
      return true; // No required tools configured
    }

    for (const tool of this.requiredTools) {
      if (!this.calledTools.has(tool)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Get list of missing tools that still need to be called
   *
   * @returns Array of tool names that haven't been called yet
   */
  getMissingTools(): string[] {
    const missing: string[] = [];
    for (const tool of this.requiredTools) {
      if (!this.calledTools.has(tool)) {
        missing.push(tool);
      }
    }
    return missing;
  }

  /**
   * Check if a warning should be issued and increment warning count
   *
   * @returns Warning result with status and metadata
   */
  checkAndWarn(): RequiredToolWarningResult {
    const missingTools = this.getMissingTools();

    // All tools called - no warning needed
    if (missingTools.length === 0) {
      return {
        shouldWarn: false,
        missingTools: [],
        warningCount: this.warningCount,
      };
    }

    // Issue warning and increment counter
    this.warningCount++;
    logger.debug(
      '[REQUIRED_TOOLS]',
      this.instanceId,
      `Agent attempting to exit without calling required tools (warning ${this.warningCount}, will retry indefinitely). Missing: ${missingTools.join(', ')}`
    );

    return {
      shouldWarn: true,
      missingTools,
      warningCount: this.warningCount,
    };
  }

  /**
   * Create a warning message to prompt the agent to call required tools
   *
   * PERSIST: false (ephemeral) - This is a one-time warning that the agent should act on immediately.
   * No persist="true" attribute means it will be cleaned up after the turn.
   *
   * @param missingTools - Array of tool names that need to be called
   * @returns Message object for conversation history
   */
  createWarningMessage(missingTools: string[]): Message {
    return createRequiredToolsWarning(missingTools);
  }

  /**
   * Track the index of a warning message in conversation history
   * This allows the warning to be removed once satisfied
   *
   * @param index - Index in the messages array where warning was added
   */
  setWarningMessageIndex(index: number): void {
    this.warningMessageIndex = index;
  }

  /**
   * Get the warning message index for removal
   *
   * @returns Index of warning message, or -1 if none
   */
  getWarningMessageIndex(): number {
    return this.warningMessageIndex;
  }

  /**
   * Clear the warning message index
   */
  clearWarningMessageIndex(): void {
    this.warningMessageIndex = -1;
  }

  /**
   * Check if there are any required tools configured
   *
   * @returns True if required tools are configured
   */
  hasRequiredTools(): boolean {
    return this.requiredTools.size > 0;
  }

  /**
   * Get current warning count
   *
   * @returns Number of warnings issued
   */
  getWarningCount(): number {
    return this.warningCount;
  }

  /**
   * Get set of required tool names
   *
   * @returns Array of required tool names
   */
  getRequiredTools(): string[] {
    return Array.from(this.requiredTools);
  }

  /**
   * Get set of called tool names
   *
   * @returns Array of called required tool names
   */
  getCalledTools(): string[] {
    return Array.from(this.calledTools);
  }

  /**
   * Reset tracking state (for cleanup or new conversations)
   */
  reset(): void {
    this.calledTools.clear();
    this.warningCount = 0;
    this.warningMessageIndex = -1;
    logger.debug('[REQUIRED_TOOLS]', this.instanceId, 'Tracker reset');
  }
}
