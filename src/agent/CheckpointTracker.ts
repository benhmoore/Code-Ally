/**
 * CheckpointTracker - Manages checkpoint reminder tracking for agents
 *
 * Responsibilities:
 * - Track tool call counts across agent execution
 * - Determine when checkpoint reminders should be injected
 * - Generate checkpoint reminders with original user prompt
 * - Reset tracking state when appropriate
 *
 * Checkpoint reminders help keep the agent aligned with the user's original
 * goal during long-running tasks with many tool calls.
 */

import { logger } from '../services/Logger.js';
import { TOKEN_MANAGEMENT, TOOL_GUIDANCE } from '../config/constants.js';
import { createCheckpointReminder } from '../utils/messageUtils.js';

/**
 * Manages checkpoint reminder tracking for agents
 */
export class CheckpointTracker {
  /** Total tool calls since tracking started */
  private toolCallsSinceStart: number = 0;

  /** Tool calls since last checkpoint reminder was injected */
  private toolCallsSinceLastCheckpoint: number = 0;

  /** Initial user prompt for the current turn */
  private initialUserPrompt: string = '';

  /** Agent instance ID for logging */
  private readonly instanceId: string;

  /**
   * Create a new CheckpointTracker
   *
   * @param instanceId - Agent instance ID for logging
   */
  constructor(instanceId: string) {
    this.instanceId = instanceId;
  }

  /**
   * Reset checkpoint tracking counters and initial prompt
   *
   * Call this when conversation is cleared, agent is reset, or starting a new turn.
   */
  reset(): void {
    this.toolCallsSinceStart = 0;
    this.toolCallsSinceLastCheckpoint = 0;
    this.initialUserPrompt = '';
    logger.debug('[AGENT_CHECKPOINT]', this.instanceId, 'Reset checkpoint tracking');
  }

  /**
   * Set the initial user prompt for checkpoint reminders
   *
   * This should be called at the start of each turn to capture the user's goal.
   *
   * @param prompt - The user's message to track
   */
  setInitialPrompt(prompt: string): void {
    this.initialUserPrompt = prompt;
    logger.debug('[AGENT_CHECKPOINT]', this.instanceId, 'Captured user prompt for turn');
  }

  /**
   * Increment tool call counters for checkpoint tracking
   *
   * Call this after successful tool execution to update counters.
   *
   * @param count - Number of tool calls to increment by
   */
  incrementToolCalls(count: number): void {
    if (count < 1) {
      logger.warn('[AGENT_CHECKPOINT]', this.instanceId, 'Invalid tool call count:', count);
      return;
    }
    this.toolCallsSinceStart += count;
    this.toolCallsSinceLastCheckpoint += count;
    logger.debug('[AGENT_CHECKPOINT]', this.instanceId,
      `Tool calls - Total: ${this.toolCallsSinceStart}, Since checkpoint: ${this.toolCallsSinceLastCheckpoint}`);
  }

  /**
   * Generate a checkpoint reminder for the agent
   *
   * Returns a reminder if the checkpoint threshold has been met, otherwise null.
   * Automatically resets the checkpoint counter after generating a reminder.
   *
   * @returns Checkpoint reminder string or null if not needed
   */
  generateReminder(): string | null {
    if (!this.shouldInjectCheckpoint()) {
      return null;
    }

    // Truncate user prompt to conserve context
    const truncatedPrompt = this.truncateToTokenLimit(
      this.initialUserPrompt,
      TOOL_GUIDANCE.CHECKPOINT_MAX_PROMPT_TOKENS
    );

    // PERSIST: false - Ephemeral: One-time alignment verification checkpoint
    // Cleaned up after turn since agent should course-correct immediately and move on
    const reminder = createCheckpointReminder(this.toolCallsSinceStart, truncatedPrompt);

    // Reset checkpoint counter
    this.toolCallsSinceLastCheckpoint = 0;

    logger.debug('[AGENT_CHECKPOINT]', this.instanceId,
      `Generated checkpoint reminder at ${this.toolCallsSinceStart} tool calls`);

    return reminder;
  }

  /**
   * Check if a checkpoint reminder should be injected
   *
   * @returns true if checkpoint should be injected
   */
  private shouldInjectCheckpoint(): boolean {
    // Skip if no initial prompt captured
    if (!this.initialUserPrompt) {
      return false;
    }

    // Skip if prompt too short (using ~4 chars per token heuristic)
    const estimatedTokens = Math.floor(this.initialUserPrompt.length / TOKEN_MANAGEMENT.CHARS_PER_TOKEN_ESTIMATE);
    if (estimatedTokens < TOOL_GUIDANCE.CHECKPOINT_MIN_PROMPT_TOKENS) {
      return false;
    }

    // Check if we've hit the interval
    if (this.toolCallsSinceLastCheckpoint < TOOL_GUIDANCE.CHECKPOINT_INTERVAL) {
      return false;
    }

    return true;
  }

  /**
   * Truncate text to a token limit using smart truncation
   *
   * Tries to break at sentence boundaries (period, newline) when possible.
   *
   * @param text - Text to truncate
   * @param maxTokens - Maximum tokens allowed
   * @returns Truncated text
   */
  private truncateToTokenLimit(text: string, maxTokens: number): string {
    const maxChars = maxTokens * TOKEN_MANAGEMENT.CHARS_PER_TOKEN_ESTIMATE;

    if (text.length <= maxChars) {
      return text;
    }

    // Try to break at sentence boundary (period or newline)
    const truncated = text.substring(0, maxChars);
    const lastPeriod = truncated.lastIndexOf('.');
    const lastNewline = truncated.lastIndexOf('\n');
    const bestBoundary = Math.max(lastPeriod, lastNewline);

    // If we found a good boundary in the last 40% of the truncated text, use it
    if (bestBoundary > maxChars * 0.6) {
      return truncated.substring(0, bestBoundary + 1).trim();
    }

    // Otherwise, truncate and add ellipsis
    return truncated.trim() + '...';
  }
}
