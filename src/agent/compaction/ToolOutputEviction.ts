import type { Message } from '../../types/index.js';
import {
  compactCompletedToolCall,
  toolCallHasDurablePayload,
} from './ToolCallArgumentCompaction.js';

/**
 * First-line context reclaim: replace the payloads of stale, bulky, successful
 * tool results with short stubs, in the active window only.
 *
 * On small context windows (16–32k) the dominant context cost is tool output —
 * whole-file reads, listings, search results — which is exactly the content
 * that is cheapest to recover: the tool can simply be re-run. Evicting it in
 * place keeps the conversation's shape (the model still sees that the call
 * happened and succeeded) without spending a checkpoint generation, and leaves
 * the recent working set intact. Full checkpoint compaction remains the
 * fallback for when non-evictable content accumulates.
 *
 * Never evicted: error results (the error text is the signal), small results,
 * the most recent results (the model's working set), ephemeral messages
 * (they have their own lifecycle), and checkpoint messages.
 */

/** Results at or above this estimated size are worth evicting. */
const MIN_EVICTABLE_TOKENS = 256;
/** The newest tool results are the model's working set; never evict them. */
const PROTECTED_RECENT_RESULTS = 2;

/**
 * Completed source mutations often cost more in their tool-call arguments than
 * in their results: a `write` call repeats the complete file in the assistant
 * message, while its result is only "created file". Once an older mutation has
 * succeeded, the repository and durable transcript are the canonical copies.
 * Keep paths and a small structural outline in the active window, not another
 * full source-file copy.
 */
const MIN_EVICTABLE_ARGUMENT_TOKENS = 256;

export interface EvictionResult {
  /** New active-window array; shares unchanged message objects with the input. */
  messages: Message[];
  evictedCount: number;
  /** Estimated tokens reclaimed. */
  reclaimedTokens: number;
}

function evictionStub(message: Message, estimatedTokens: number): string {
  const callIdLine = message.content.match(/^\[Tool Call ID:[^\]]*\]/)?.[0];
  const toolName = message.name || 'tool';
  const notice = `[Tool output evicted to reclaim context: ~${estimatedTokens}-token ${toolName} result. `
    + `The operation succeeded. Re-run the tool if this output is needed again.]`;
  return callIdLine ? `${callIdLine}\n${notice}` : notice;
}

export function evictStaleToolOutputs(
  messages: readonly Message[],
  estimateMessageTokens: (message: Message) => number,
): EvictionResult {
  const evictableIndexes: number[] = [];
  const successfulOldCallIds = new Set<string>();
  let recentResultsSeen = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role !== 'tool') continue;
    if (message.metadata?.ephemeral || message.metadata?.isConversationCheckpoint) continue;
    recentResultsSeen++;
    if (recentResultsSeen <= PROTECTED_RECENT_RESULTS) continue;
    if (message.is_error || message.metadata?.isError) continue;
    if (message.tool_call_id) successfulOldCallIds.add(message.tool_call_id);
    if (message.metadata?.contentEvicted) continue;
    if (estimateMessageTokens(message) < MIN_EVICTABLE_TOKENS) continue;
    evictableIndexes.push(index);
  }
  const evictable = new Set(evictableIndexes);
  let reclaimedTokens = 0;
  let evictedCount = evictable.size;
  const replaced = messages.map((message, index) => {
    if (evictable.has(index)) {
      const before = estimateMessageTokens(message);
      const evicted: Message = {
        ...message,
        content: evictionStub(message, before),
        metadata: { ...message.metadata, contentEvicted: true },
      };
      reclaimedTokens += Math.max(0, before - estimateMessageTokens(evicted));
      return evicted;
    }
    if (message.role !== 'assistant' || !message.tool_calls?.some(call =>
      successfulOldCallIds.has(call.id) && toolCallHasDurablePayload(call))) return message;
    const before = estimateMessageTokens(message);
    if (before < MIN_EVICTABLE_ARGUMENT_TOKENS) return message;
    const compacted: Message = {
      ...message,
      tool_calls: message.tool_calls.map(call =>
        successfulOldCallIds.has(call.id) ? compactCompletedToolCall(call) : call),
      metadata: { ...message.metadata, toolArgumentsEvicted: true },
    };
    const reclaimed = Math.max(0, before - estimateMessageTokens(compacted));
    if (reclaimed === 0) return message;
    reclaimedTokens += reclaimed;
    evictedCount++;
    return compacted;
  });
  return { messages: replaced, evictedCount, reclaimedTokens };
}
