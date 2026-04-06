/**
 * Conversation Recovery — message filtering pipeline for session resume.
 *
 * When a session is interrupted mid-turn (e.g., crash, Ctrl+C during tool
 * execution), the saved messages can contain:
 *   - Assistant messages with tool_use blocks that never got results
 *   - Assistant messages with only thinking content (no user-visible output)
 *   - Whitespace-only assistant messages from interrupted streaming
 *
 * This module detects and cleans up these artifacts, then optionally injects
 * a continuation prompt so the model picks up where it left off.
 *
 * Follows the pattern from Claude Code's conversationRecovery.ts.
 */

import { Message } from '../types/index.js';
import { logger } from '../services/Logger.js';

/**
 * Filter out assistant messages that contain tool_use calls without
 * corresponding tool result messages. These are "orphaned" — the tool
 * was requested but never executed (or the result was never saved).
 */
export function filterUnresolvedToolUses(messages: Message[]): Message[] {
  // Collect all tool_call_ids that have results
  const resolvedIds = new Set<string>();
  for (const msg of messages) {
    if (msg.role === 'tool' && msg.tool_call_id) {
      resolvedIds.add(msg.tool_call_id);
    }
  }

  return messages.filter(msg => {
    if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
      // Keep if ALL tool calls have results
      const allResolved = msg.tool_calls.every(tc => resolvedIds.has(tc.id));
      if (!allResolved) {
        const unresolvedCount = msg.tool_calls.filter(tc => !resolvedIds.has(tc.id)).length;
        logger.debug(
          `[CONVERSATION_RECOVERY] Filtering assistant message with ${unresolvedCount} unresolved tool_use block(s)`
        );
        return false;
      }
    }
    return true;
  });
}

/**
 * Filter out assistant messages that contain only thinking content
 * (no user-visible content or tool calls). These are artifacts from
 * interrupted reasoning.
 */
export function filterOrphanedThinkingMessages(messages: Message[]): Message[] {
  return messages.filter(msg => {
    if (msg.role === 'assistant') {
      const hasContent = msg.content && msg.content.trim().length > 0;
      const hasToolCalls = msg.tool_calls && msg.tool_calls.length > 0;
      const hasThinking = msg.thinking && msg.thinking.trim().length > 0;

      // If it only has thinking but no content and no tool calls, filter it out
      if (hasThinking && !hasContent && !hasToolCalls) {
        logger.debug('[CONVERSATION_RECOVERY] Filtering thinking-only assistant message');
        return false;
      }
    }
    return true;
  });
}

/**
 * Filter out assistant messages that are whitespace-only.
 * These can appear when streaming was interrupted before meaningful content arrived.
 */
export function filterWhitespaceOnlyAssistantMessages(messages: Message[]): Message[] {
  return messages.filter(msg => {
    if (msg.role === 'assistant') {
      const hasContent = msg.content && msg.content.trim().length > 0;
      const hasToolCalls = msg.tool_calls && msg.tool_calls.length > 0;
      const hasThinking = msg.thinking && msg.thinking.trim().length > 0;

      if (!hasContent && !hasToolCalls && !hasThinking) {
        logger.debug('[CONVERSATION_RECOVERY] Filtering whitespace-only assistant message');
        return false;
      }
    }
    return true;
  });
}

/**
 * Detect if the conversation was interrupted mid-turn.
 *
 * Returns:
 *   - 'interrupted_turn' — last assistant message has unresolved tool calls
 *   - 'interrupted_prompt' — last message is from user (model never responded)
 *   - null — conversation ended cleanly
 */
export function detectTurnInterruption(
  messages: Message[]
): 'interrupted_turn' | 'interrupted_prompt' | null {
  if (messages.length === 0) return null;

  const last = messages[messages.length - 1];

  // If last message is user, the model never responded
  if (last?.role === 'user') {
    return 'interrupted_prompt';
  }

  // If last message is assistant with tool calls, check if all resolved
  if (last?.role === 'assistant' && last.tool_calls && last.tool_calls.length > 0) {
    const resolvedIds = new Set<string>();
    for (const msg of messages) {
      if (msg.role === 'tool' && msg.tool_call_id) {
        resolvedIds.add(msg.tool_call_id);
      }
    }
    const allResolved = last.tool_calls.every(tc => resolvedIds.has(tc.id));
    if (!allResolved) {
      return 'interrupted_turn';
    }
  }

  return null;
}

/**
 * Run the full conversation recovery pipeline on a set of messages.
 *
 * 1. Filter unresolved tool_use blocks
 * 2. Filter orphaned thinking-only messages
 * 3. Filter whitespace-only assistant messages
 * 4. Optionally detect interruption state
 *
 * Returns the cleaned messages and the interruption state.
 */
export function recoverConversation(messages: Message[]): {
  messages: Message[];
  interruption: 'interrupted_turn' | 'interrupted_prompt' | null;
} {
  // Detect interruption BEFORE filtering (so we can see the raw state)
  const interruption = detectTurnInterruption(messages);

  // Run filtering pipeline
  let cleaned = filterUnresolvedToolUses(messages);
  cleaned = filterOrphanedThinkingMessages(cleaned);
  cleaned = filterWhitespaceOnlyAssistantMessages(cleaned);

  const removed = messages.length - cleaned.length;
  if (removed > 0) {
    logger.info(`[CONVERSATION_RECOVERY] Removed ${removed} artifact message(s) during session resume`);
  }

  if (interruption) {
    logger.info(`[CONVERSATION_RECOVERY] Detected ${interruption} — model will be prompted to continue`);
  }

  return { messages: cleaned, interruption };
}
