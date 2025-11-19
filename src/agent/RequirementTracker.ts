/**
 * RequirementValidator - Tracks and validates agent tool requirements
 *
 * Monitors successful tool calls during agent execution and validates
 * that requirements are met before the agent exits. If requirements
 * are not met, injects reminder messages and continues the conversation.
 *
 * This is separate from RequiredToolTracker which handles the legacy
 * requiredToolCalls config (simple list of tools that must be called).
 */

import { logger } from '../services/Logger.js';

/**
 * Agent requirements specification
 *
 * Ensures agents make required tool calls before completing their turn.
 * Only successful tool calls (where success=true) are counted toward requirements.
 * If requirements are not met, the agent receives a reminder message and is given
 * another opportunity to fulfill them (up to max_retries times).
 *
 * Requirements are checked in the following order:
 * 1. require_tool_use (if true, at least one tool must be called)
 * 2. minimum_tool_calls (minimum number of successful tool calls)
 * 3. required_tools_one_of (at least one from the list must be called)
 * 4. required_tools_all (all tools in the list must be called)
 *
 * @example Basic tool requirement
 * ```typescript
 * {
 *   required_tools_one_of: ["Read", "Grep"],
 *   max_retries: 2
 * }
 * ```
 *
 * @example Enforce minimum tool usage
 * ```typescript
 * {
 *   require_tool_use: true,
 *   minimum_tool_calls: 3,
 *   reminder_message: "Please use at least 3 tools to thoroughly analyze the codebase."
 * }
 * ```
 *
 * @example Require specific tool combination
 * ```typescript
 * {
 *   required_tools_all: ["Read", "Edit", "Bash"],
 *   max_retries: 1,
 *   reminder_message: "You must read the file, edit it, and run tests before finishing."
 * }
 * ```
 */
export interface AgentRequirements {
  /**
   * At least one of these tools must be called successfully
   *
   * Use this when the agent must use one tool from a set of alternatives.
   * Only successful tool calls (success=true) count toward this requirement.
   *
   * @example
   * ```typescript
   * required_tools_one_of: ["Read", "Glob", "Grep"]
   * // Agent must use at least one file exploration tool
   * ```
   */
  required_tools_one_of?: string[];

  /**
   * All of these tools must be called successfully
   *
   * Use this when the agent must use a specific set of tools.
   * Only successful tool calls (success=true) count toward this requirement.
   * The order of tool calls does not matter.
   *
   * @example
   * ```typescript
   * required_tools_all: ["Read", "Edit", "Bash"]
   * // Agent must read a file, edit it, and run a command
   * ```
   */
  required_tools_all?: string[];

  /**
   * Minimum number of successful tool calls required
   *
   * Use this to ensure the agent performs sufficient exploration or work.
   * Only successful tool calls (success=true) are counted.
   * Duplicate calls to the same tool are counted only once.
   *
   * @example
   * ```typescript
   * minimum_tool_calls: 5
   * // Agent must successfully use at least 5 different tools
   * ```
   */
  minimum_tool_calls?: number;

  /**
   * At least one tool must be called successfully
   *
   * Use this to prevent the agent from completing without using any tools.
   * Set to true to require at least one successful tool call.
   *
   * @default undefined (no requirement)
   *
   * @example
   * ```typescript
   * require_tool_use: true
   * // Agent cannot finish without calling at least one tool
   * ```
   */
  require_tool_use?: boolean;


  /**
   * Custom reminder message (optional)
   *
   * If provided, this message is sent to the agent when requirements are not met.
   * If not provided, a message is auto-generated based on which requirement failed.
   *
   * The message should clearly explain what the agent needs to do to meet requirements.
   *
   * @example
   * ```typescript
   * reminder_message: "You must read the configuration file and search for the API key before completing this task."
   * ```
   */
  reminder_message?: string;
}

/**
 * Tracks tool calls and validates requirements for an agent
 */
export class RequirementValidator {
  private requirements?: AgentRequirements;
  private successfulToolCalls: Set<string> = new Set();
  private retryCount: number = 0;
  private instanceId: string;

  constructor(instanceId: string) {
    this.instanceId = instanceId;
  }

  /**
   * Set requirements for this agent
   * @param requirements - Requirements specification
   */
  setRequirements(requirements: AgentRequirements): void {
    this.requirements = requirements;
    logger.debug('[REQUIREMENT_TRACKER]', this.instanceId, 'Requirements set:', requirements);
  }

  /**
   * Check if this agent has requirements configured
   * @returns True if requirements are set
   */
  hasRequirements(): boolean {
    return this.requirements !== undefined;
  }

  /**
   * Record a tool call result
   * @param toolName - Name of the tool that was called
   * @param success - Whether the tool call was successful
   */
  recordToolCall(toolName: string, success: boolean): void {
    if (!this.requirements) {
      return; // No requirements to track
    }

    if (success) {
      this.successfulToolCalls.add(toolName);
      logger.debug('[REQUIREMENT_TRACKER]', this.instanceId, 'Recorded successful tool call:', toolName, '- Total successful calls:', this.successfulToolCalls.size);
    }
  }

  /**
   * Check if all requirements are met
   * @returns Object with met flag and optional reason if not met
   */
  checkRequirements(): { met: boolean; reason?: string } {
    if (!this.requirements) {
      return { met: true }; // No requirements = always met
    }

    const reqs = this.requirements;

    // Check require_tool_use
    if (reqs.require_tool_use && this.successfulToolCalls.size === 0) {
      return {
        met: false,
        reason: 'You must use at least one tool successfully before completing this task.',
      };
    }

    // Check minimum_tool_calls
    if (reqs.minimum_tool_calls !== undefined && this.successfulToolCalls.size < reqs.minimum_tool_calls) {
      return {
        met: false,
        reason: `You must make at least ${reqs.minimum_tool_calls} successful tool call(s). Current: ${this.successfulToolCalls.size}`,
      };
    }

    // Check required_tools_one_of
    if (reqs.required_tools_one_of && reqs.required_tools_one_of.length > 0) {
      const hasOne = reqs.required_tools_one_of.some(toolName =>
        this.successfulToolCalls.has(toolName)
      );
      if (!hasOne) {
        return {
          met: false,
          reason: `You must use at least one of these tools: ${reqs.required_tools_one_of.join(', ')}`,
        };
      }
    }

    // Check required_tools_all
    if (reqs.required_tools_all && reqs.required_tools_all.length > 0) {
      const missing = reqs.required_tools_all.filter(
        toolName => !this.successfulToolCalls.has(toolName)
      );
      if (missing.length > 0) {
        return {
          met: false,
          reason: `You must use all of these tools: ${reqs.required_tools_all.join(', ')}. Missing: ${missing.join(', ')}`,
        };
      }
    }

    // All requirements met
    logger.debug('[REQUIREMENT_TRACKER]', this.instanceId, 'All requirements met');
    return { met: true };
  }

  /**
   * Increment retry count and return new count
   * @returns Current retry count after increment
   */
  incrementRetryCount(): number {
    this.retryCount++;
    logger.debug('[REQUIREMENT_TRACKER]', this.instanceId, 'Retry count incremented to:', this.retryCount, '(will retry indefinitely)');
    return this.retryCount;
  }

  /**
   * Get current retry count
   * @returns Current retry count
   */
  getRetryCount(): number {
    return this.retryCount;
  }

  /**
   * Generate reminder message for unmet requirements
   * Uses custom message if provided, otherwise generates based on requirements
   * @returns Reminder message string
   */
  getReminderMessage(): string {
    if (!this.requirements) {
      return 'Please complete the required actions before finishing.';
    }

    // Use custom message if provided
    if (this.requirements.reminder_message) {
      return this.requirements.reminder_message;
    }

    // Generate message based on which requirement is not met
    const { reason } = this.checkRequirements();
    if (reason) {
      return `${reason} Please continue your work to meet these requirements.`;
    }

    return 'Please complete the required actions before finishing.';
  }

  /**
   * Reset the tracker state (clears tool calls and retry count)
   */
  reset(): void {
    this.successfulToolCalls.clear();
    this.retryCount = 0;
    logger.debug('[REQUIREMENT_TRACKER]', this.instanceId, 'Tracker reset');
  }

  /**
   * Get list of successful tool calls (for debugging)
   * @returns Array of tool names that were called successfully
   */
  getSuccessfulToolCalls(): string[] {
    return Array.from(this.successfulToolCalls);
  }
}
