/**
 * Agent utilities
 *
 * Shared utility functions for agent operations.
 */

import { Agent } from '../agent/Agent.js';
import { logger } from '../services/Logger.js';

/**
 * Extract a summary from an agent's conversation history.
 * Returns the last assistant message content, or null if none found.
 *
 * @param agent - The agent to extract summary from
 * @param context - Optional context string for logging (e.g., '[AGENT_TOOL]')
 * @param prefix - Optional prefix to add when multiple messages are combined
 * @param recentMessagesCount - Number of recent messages to include (default: 3)
 * @returns The summary text or null
 */
export function extractSummaryFromConversation(
  agent: Agent,
  context: string = '[AGENT]',
  prefix?: string,
  recentMessagesCount: number = 3
): string | null {
  try {
    const messages = agent.getMessages();

    // Find all assistant messages (excluding system/user/tool messages)
    const assistantMessages = messages
      .filter(msg => msg.role === 'assistant' && msg.content && msg.content.trim().length > 0)
      .map(msg => msg.content);

    if (assistantMessages.length === 0) {
      logger.debug(`${context} No assistant messages found in conversation`);
      return null;
    }

    // If we have multiple assistant messages, combine the last few
    if (assistantMessages.length > 1) {
      // Take the last N assistant messages (or all if less than N)
      const recentMessages = assistantMessages.slice(-recentMessagesCount);
      const summary = recentMessages.join('\n\n');
      logger.debug(`${context} Extracted summary from`, recentMessages.length, 'assistant messages, length:', summary.length);

      // Add prefix if provided
      if (prefix) {
        return `${prefix}\n\n${summary}`;
      }
      return summary;
    }

    // Single assistant message
    const summary = assistantMessages[0];
    if (summary) {
      logger.debug(`${context} Using single assistant message as summary, length:`, summary.length);
      return summary;
    }

    return null;
  } catch (error) {
    logger.debug(`${context} Error extracting summary from conversation:`, error);
    return null;
  }
}
