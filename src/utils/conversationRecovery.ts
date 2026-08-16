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
import { createToolResultMessage } from '../llm/FunctionCalling.js';
import { INTERRUPTED_TOOL_RESULT } from '../config/constants.js';

/**
 * Restore the tool_call/tool_result pairing invariant.
 *
 * Every id in an assistant `tool_calls` must have exactly one `role:'tool'`
 * message, and every tool message must belong to a preceding assistant call.
 * Providers reject message arrays that violate this, and several ordinary code
 * paths can break it — most commonly ephemeral read results, which are pruned at
 * end of turn while the assistant message that requested them survives.
 *
 * Unanswered calls are repaired by SYNTHESIS rather than by deleting the
 * assistant message: dropping it would rewrite earlier history and invalidate
 * the stable prompt prefix the agent deliberately engineers for KV-cache reuse.
 * A tool message with no parent is the one case where deletion is the only
 * option, since there is nothing to synthesize from.
 *
 * Pure and idempotent — running it twice changes nothing.
 */
export function reconcileToolCallPairs(messages: Message[]): Message[] {
  const answeredIds = new Set<string>();
  const calledIds = new Set<string>();

  for (const msg of messages) {
    if (msg.role === 'tool' && msg.tool_call_id) answeredIds.add(msg.tool_call_id);
    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const tc of msg.tool_calls) calledIds.add(tc.id);
    }
  }

  const reconciled: Message[] = [];
  let synthesized = 0;
  let dropped = 0;

  for (const msg of messages) {
    // Drop a result whose parent call is gone — unsynthesizable.
    if (msg.role === 'tool' && msg.tool_call_id && !calledIds.has(msg.tool_call_id)) {
      dropped++;
      continue;
    }

    reconciled.push(msg);

    if (msg.role !== 'assistant' || !msg.tool_calls?.length) continue;

    // Answer any of this message's calls that nothing else answered, keeping the
    // synthetic result adjacent to the call it belongs to.
    for (const toolCall of msg.tool_calls) {
      if (answeredIds.has(toolCall.id)) continue;

      reconciled.push(
        createToolResultMessage(
          toolCall.id,
          toolCall.function?.name ?? 'unknown',
          INTERRUPTED_TOOL_RESULT,
          true,
          'interrupted'
        ) as Message
      );
      answeredIds.add(toolCall.id);
      synthesized++;
    }
  }

  if (synthesized || dropped) {
    logger.debug(
      `[CONVERSATION_RECOVERY] Reconciled tool call pairing: synthesized ${synthesized} missing result(s), dropped ${dropped} parentless result(s)`
    );
  }

  return reconciled;
}

/**
 * Move a candidate split index back to the nearest safe conversation boundary.
 *
 * A "split" at index `i` means `messages.slice(i)` is retained and
 * `messages.slice(0, i)` is handed off (summarized or dropped). Such a split is
 * only legal where it does not land between an assistant message carrying
 * `tool_calls` and that message's `role:'tool'` results: cutting there either
 * strands results whose parent call is gone (providers reject the array) or
 * strands a call whose results are gone.
 *
 * Since every tool result is preceded by the assistant message that requested
 * it, walking backwards past any leading `role:'tool'` message is sufficient —
 * the walk lands either on the parent assistant call itself (retaining call and
 * results together) or at index 0 (retaining everything, which discards
 * nothing and so cannot orphan anything).
 *
 * Total: any input, including out-of-range or negative candidates, yields an
 * index clamped to [0, messages.length].
 */
export function findSafeSplitIndex(messages: Message[], candidateIndex: number): number {
  if (messages.length === 0) return 0;

  let index = Math.min(Math.max(Math.floor(candidateIndex) || 0, 0), messages.length);

  while (index > 0 && index < messages.length && messages[index]?.role === 'tool') {
    index--;
  }

  return index;
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
 * 1. Reconcile tool_call/tool_result pairing
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
  let cleaned = reconcileToolCallPairs(messages);
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
