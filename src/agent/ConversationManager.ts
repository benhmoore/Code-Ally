/**
 * ConversationManager - Manages conversation message history
 *
 * Responsibilities:
 * - Message array management (add, get, clear, set)
 * - Message validation and metadata enrichment
 * - Message filtering (e.g., ephemeral, system reminders)
 * - Message history operations (rewind, compact preparation)
 *
 * This class extracts message management logic from Agent to maintain
 * separation of concerns and make message operations testable.
 */

import { Message } from '../types/index.js';
import { generateMessageId } from '../utils/id.js';
import { logger } from '../services/Logger.js';
import { SYSTEM_REMINDER } from '../config/constants.js';

/**
 * Configuration for ConversationManager
 */
export interface ConversationManagerConfig {
  /** Agent instance ID for logging */
  instanceId?: string;
  /** Initial messages to populate (optional) */
  initialMessages?: Message[];
}

/**
 * Result of removing tool results from conversation
 */
export interface ToolRemovalResult {
  /** Number of tool result messages removed */
  removed_count: number;
  /** Tool call IDs that were successfully removed */
  removed_ids: string[];
  /** Tool call IDs that were not found in conversation */
  not_found_ids: string[];
}

/**
 * Manages conversation message history
 */
export class ConversationManager {
  /** Conversation message array */
  private messages: Message[] = [];

  /** Index mapping tool_call_id to tool result message for O(1) lookup */
  private toolResultIndex: Map<string, Message> = new Map();

  /** Agent instance ID for logging */
  private readonly instanceId: string;

  /**
   * Create a new ConversationManager
   *
   * @param config - Configuration options
   */
  constructor(config: ConversationManagerConfig = {}) {
    this.instanceId = config.instanceId ?? 'unknown';

    // Initialize with initial messages if provided
    if (config.initialMessages && config.initialMessages.length > 0) {
      this.messages = config.initialMessages.map(msg => ({
        ...msg,
        id: msg.id || generateMessageId(),
        timestamp: msg.timestamp || Date.now(),
      }));
      // Build tool result index from initial messages
      this.rebuildToolResultIndex();
      logger.debug('[CONVERSATION_MANAGER]', this.instanceId, 'Initialized with', this.messages.length, 'messages');
    }
  }

  /**
   * Add a message to conversation history
   *
   * Ensures message has ID and timestamp before adding.
   *
   * @param message - Message to add
   */
  addMessage(message: Message): void {
    // Ensure message has ID and timestamp
    const messageWithMetadata = {
      ...message,
      id: message.id || generateMessageId(),
      timestamp: message.timestamp || Date.now(),
    };
    this.messages.push(messageWithMetadata);

    // Update tool result index if this is a tool result message
    if (messageWithMetadata.role === 'tool' && messageWithMetadata.tool_call_id) {
      this.toolResultIndex.set(messageWithMetadata.tool_call_id, messageWithMetadata);
    }

    // Log message addition for context tracking
    const toolInfo = message.tool_calls ? ` toolCalls:${message.tool_calls.length}` : '';
    const toolCallId = message.tool_call_id ? ` toolCallId:${message.tool_call_id}` : '';
    const toolName = message.name ? ` name:${message.name}` : '';
    logger.debug(
      '[CONVERSATION_MANAGER]',
      this.instanceId,
      'Message added:',
      message.role,
      toolInfo,
      toolCallId,
      toolName,
      '- Total messages:',
      this.messages.length
    );
  }

  /**
   * Add multiple messages to conversation history
   *
   * @param messages - Messages to add
   */
  addMessages(messages: Message[]): void {
    for (const message of messages) {
      this.addMessage(message);
    }
  }

  /**
   * Get the current conversation history (readonly reference)
   *
   * Returns a readonly reference to the message array for efficient read access.
   * For mutation scenarios, use getMessagesCopy() instead.
   *
   * @returns Readonly reference to message array
   */
  getMessages(): readonly Message[] {
    return this.messages;
  }

  /**
   * Get a copy of the conversation history for mutation
   *
   * Use this when you need to modify the returned array.
   * Most callers should use getMessages() for readonly access.
   *
   * @returns Copy of message array
   */
  getMessagesCopy(): Message[] {
    return [...this.messages];
  }

  /**
   * Set messages (replaces entire conversation)
   *
   * Used for compaction, rewind, and session loading.
   * Ensures all messages have IDs.
   *
   * @param messages - New message array to replace current messages
   */
  setMessages(messages: Message[]): void {
    // Ensure all messages have IDs
    this.messages = messages.map(msg => ({
      ...msg,
      id: msg.id || generateMessageId(),
    }));
    // Rebuild tool result index from scratch
    this.rebuildToolResultIndex();
    logger.debug('[CONVERSATION_MANAGER]', this.instanceId, 'Messages set, count:', this.messages.length);
  }

  /**
   * Get message count
   *
   * @returns Number of messages in conversation
   */
  getMessageCount(): number {
    return this.messages.length;
  }

  /**
   * Clear all messages
   */
  clearMessages(): void {
    this.messages = [];
    this.toolResultIndex.clear();
    logger.debug('[CONVERSATION_MANAGER]', this.instanceId, 'Messages cleared');
  }

  /**
   * Get the system message (if present)
   *
   * @returns System message or null if not found
   */
  getSystemMessage(): Message | null {
    return this.messages[0]?.role === 'system' ? this.messages[0] : null;
  }

  /**
   * Update the system message content
   *
   * @param content - New system message content
   */
  updateSystemMessage(content: string): void {
    if (this.messages[0]?.role === 'system') {
      // Create new object to maintain immutability (preserves token cache validity)
      this.messages[0] = {
        ...this.messages[0],
        content
      };
      logger.debug('[CONVERSATION_MANAGER]', this.instanceId, 'System message updated');
    }
  }

  /**
   * Remove messages matching a predicate
   *
   * @param predicate - Function that returns true for messages to remove
   * @returns Number of messages removed
   */
  removeMessages(predicate: (msg: Message) => boolean): number {
    const originalLength = this.messages.length;

    // Remove matching tool results from index before filtering
    for (const msg of this.messages) {
      if (predicate(msg) && msg.role === 'tool' && msg.tool_call_id) {
        this.toolResultIndex.delete(msg.tool_call_id);
      }
    }

    this.messages = this.messages.filter(msg => !predicate(msg));
    const removedCount = originalLength - this.messages.length;

    if (removedCount > 0) {
      logger.debug('[CONVERSATION_MANAGER]', this.instanceId, `Removed ${removedCount} message(s)`);
    }

    return removedCount;
  }

  /**
   * Remove ephemeral system reminder messages from conversation history
   *
   * System reminders can be either ephemeral (cleaned up after each turn) or persistent
   * (kept forever). This method removes only ephemeral reminders:
   *
   * 1. Standalone messages with role='system' or role='user' (continuation prompts) that contain
   *    non-persistent <system-reminder> tags
   * 2. <system-reminder> tags embedded in tool result content (role='tool') that lack persist="true"
   *
   * Reminders marked with persist="true" attribute are preserved in the conversation.
   *
   * Edge cases handled:
   * - Multiple reminder tags in same message:
   *   - For tool results: Each tag evaluated independently; only ephemeral tags removed
   *   - For standalone messages: If ANY tag has persist="true", entire message is kept
   * - Extra whitespace in tags and attributes (flexible regex matching)
   * - Case variations: persist="true", persist="TRUE", persist="True" (all case-insensitive)
   * - Attribute order: persist="true" works anywhere in opening tag (not just first)
   * - Nested tags (though not recommended, outer tags are processed)
   * - Malformed tags without closing tags (left as-is to avoid data corruption)
   *
   * Performance optimization: Uses .includes() pre-check before expensive regex operations.
   *
   * @returns Number of messages affected (standalone messages removed + tool results with tags stripped)
   *          Note: A tool result with 5 ephemeral tags removed counts as 1 in the return value
   *
   * @example
   * // Before:
   * // Tool result: "Success\n\n<system-reminder>Check logs</system-reminder>"
   * // System message: "<system-reminder persist=\"true\">Important</system-reminder>"
   * // User message: "<system-reminder>Your response was interrupted</system-reminder>"
   *
   * // After removeEphemeralSystemReminders():
   * // Tool result: "Success" (ephemeral tag stripped)
   * // System message: "<system-reminder persist=\"true\">Important</system-reminder>" (preserved)
   * // User message: (removed entirely - ephemeral continuation prompt)
   */
  removeEphemeralSystemReminders(): number {
    let totalRemoved = 0;

    // Part 1: Remove standalone messages with ephemeral <system-reminder> tags
    // These are complete messages with role='system' or role='user' (continuation prompts)
    // that contain non-persistent reminders
    const standaloneRemoved = this.removeMessages(msg => {
      if ((msg.role !== 'system' && msg.role !== 'user') || typeof msg.content !== 'string') {
        return false;
      }

      // Quick pre-check: does this message contain any system-reminder tags?
      if (!msg.content.includes(SYSTEM_REMINDER.OPENING_TAG)) {
        return false;
      }

      // Check if ALL reminder tags in this message are ephemeral (no persist="true")
      // If ANY tag has persist="true", we keep the entire message
      const hasPersistentTag = SYSTEM_REMINDER.PERSIST_PATTERN.test(msg.content);

      // Remove message only if it has reminder tags AND none are persistent
      return !hasPersistentTag;
    });

    totalRemoved += standaloneRemoved;

    // Part 2: Strip ephemeral <system-reminder> tags from tool result content
    // These are embedded in tool results (role='tool') and need content modification
    for (let i = 0; i < this.messages.length; i++) {
      const msg = this.messages[i];
      if (!msg || msg.role !== 'tool' || typeof msg.content !== 'string') {
        continue;
      }

      // Quick pre-check: does this content contain any system-reminder tags?
      if (!msg.content.includes(SYSTEM_REMINDER.OPENING_TAG)) {
        continue;
      }

      // Remove only non-persistent <system-reminder> tags using regex
      // Uses EPHEMERAL_TAG_PATTERN from constants which matches tags without persist="true"
      const originalContent = msg.content;
      const newContent = msg.content.replace(SYSTEM_REMINDER.EPHEMERAL_TAG_PATTERN, '');

      // Create new object if content changed (maintains immutability, preserves token cache validity)
      if (newContent !== originalContent) {
        this.messages[i] = {
          ...msg,
          content: newContent.replace(/\n{3,}/g, '\n\n').trim()
        } as Message;
        totalRemoved++;
      }
    }

    if (totalRemoved > 0) {
      logger.debug(
        '[CONVERSATION_MANAGER]',
        this.instanceId,
        `Removed ${totalRemoved} ephemeral system reminder(s) (${standaloneRemoved} standalone message(s), ${totalRemoved - standaloneRemoved} embedded tag(s))`
      );
    }

    return totalRemoved;
  }

  /**
   * Clean up stale persistent reminders older than specified age
   *
   * This is a defensive mechanism to prevent persistent reminder accumulation.
   * Persistent reminders should be rare and have limited lifetime.
   *
   * @param maxAge - Maximum age in milliseconds (default: 30 minutes)
   * @returns Number of stale persistent reminders removed
   */
  cleanupStaleReminders(maxAge: number = 30 * 60 * 1000): number {
    let removed = 0;
    const cutoff = Date.now() - maxAge;

    // Remove tool results from index before filtering
    for (const msg of this.messages) {
      // Keep messages without system-reminder tags
      if (!msg.content.includes(SYSTEM_REMINDER.OPENING_TAG)) {
        continue;
      }

      // Keep ephemeral reminders (handled by removeEphemeralSystemReminders)
      if (!SYSTEM_REMINDER.PERSIST_PATTERN.test(msg.content)) {
        continue;
      }

      // Check if this is a stale persistent reminder that will be removed
      if (msg.timestamp && msg.timestamp < cutoff) {
        // Remove from tool result index if it's a tool message
        if (msg.role === 'tool' && msg.tool_call_id) {
          this.toolResultIndex.delete(msg.tool_call_id);
        }
      }
    }

    this.messages = this.messages.filter(msg => {
      // Keep messages without system-reminder tags
      if (!msg.content.includes(SYSTEM_REMINDER.OPENING_TAG)) {
        return true;
      }

      // Keep ephemeral reminders (handled by removeEphemeralSystemReminders)
      if (!SYSTEM_REMINDER.PERSIST_PATTERN.test(msg.content)) {
        return true;
      }

      // Remove persistent reminders older than maxAge
      if (msg.timestamp && msg.timestamp < cutoff) {
        logger.debug(
          `[CONVERSATION_MANAGER] Removing stale persistent reminder (age: ${Math.floor((Date.now() - msg.timestamp) / 1000)}s)`
        );
        removed++;
        return false;
      }

      return true;
    });

    if (removed > 0) {
      logger.debug(`[CONVERSATION_MANAGER] Cleaned up ${removed} stale persistent reminders`);
    }

    return removed;
  }

  /**
   * Clean up ephemeral messages from conversation history
   *
   * Ephemeral messages are marked with metadata.ephemeral = true
   * and should be removed at end of turn.
   *
   * @returns Number of ephemeral messages removed
   */
  cleanupEphemeralMessages(): number {
    return this.removeMessages(msg => msg.metadata?.ephemeral === true);
  }

  /**
   * Remove tool result messages for specific tool call IDs
   *
   * Finds and removes tool result messages (role: 'tool') that match
   * the provided tool call IDs. Supports partial success - will remove
   * valid IDs and report which IDs were not found.
   *
   * Also extracts file paths from 'read' tool calls for untracking.
   *
   * @param toolCallIds - Array of tool call IDs to remove
   * @returns ToolRemovalResult with counts, ID lists, and read file paths
   */
  removeToolResults(toolCallIds: string[]): ToolRemovalResult {
    // Categorize IDs as found vs not found using O(1) index lookup
    const removedIds: string[] = [];
    const notFoundIds: string[] = [];

    for (const toolCallId of toolCallIds) {
      if (this.toolResultIndex.has(toolCallId)) {
        removedIds.push(toolCallId);
      } else {
        notFoundIds.push(toolCallId);
      }
    }

    // Build Set for O(1) removal check
    const idsToRemove = new Set(removedIds);

    // Remove tool result messages and update index in single pass
    const originalLength = this.messages.length;
    this.messages = this.messages.filter(msg => {
      if (msg.role === 'tool' && msg.tool_call_id && idsToRemove.has(msg.tool_call_id)) {
        this.toolResultIndex.delete(msg.tool_call_id);
        return false;
      }
      return true;
    });
    const removedCount = originalLength - this.messages.length;

    // Log results
    logger.debug(
      '[CONVERSATION_MANAGER]',
      this.instanceId,
      'Removed tool results:',
      removedCount,
      'messages,',
      removedIds.length,
      'IDs found,',
      notFoundIds.length,
      'IDs not found'
    );

    if (notFoundIds.length > 0) {
      logger.debug('[CONVERSATION_MANAGER]', this.instanceId, 'Not found IDs:', notFoundIds.join(', '));
    }

    return {
      removed_count: removedCount,
      removed_ids: removedIds,
      not_found_ids: notFoundIds,
    };
  }

  /**
   * Check if a file has been successfully read in the conversation
   *
   * Searches through conversation history to find 'read' tool calls that include
   * the specified file path, then verifies if any of those reads completed successfully
   * by checking the corresponding tool result messages.
   *
   * This is useful for determining if a file's contents are already in conversation
   * context, allowing downstream code to avoid redundant reads or handle file state.
   *
   * @param filePath - Absolute path to the file to check
   * @returns True if the file has been successfully read at least once, false otherwise
   *
   * @example
   * ```ts
   * if (conversationManager.hasSuccessfulReadFor('/path/to/file.ts')) {
   *   // File is already in context, no need to read again
   * }
   * ```
   */
  hasSuccessfulReadFor(filePath: string): boolean {
    // Find all assistant messages with tool_calls
    for (const message of this.messages) {
      if (message.role !== 'assistant' || !message.tool_calls) {
        continue;
      }

      // Look for 'read' tool calls that include the target file path
      for (const toolCall of message.tool_calls) {
        if (toolCall.function.name !== 'read') {
          continue;
        }

        // Extract file_paths from tool call arguments
        // Handle both array and single file_path formats
        const args = toolCall.function.arguments;
        let filePaths: string[] = [];

        if (args.file_paths) {
          filePaths = Array.isArray(args.file_paths) ? args.file_paths : [args.file_paths];
        } else if (args.file_path) {
          // Handle legacy single file_path argument
          filePaths = [args.file_path];
        }

        // Check if target file is in this read call
        if (!filePaths.includes(filePath)) {
          continue;
        }

        // Get the corresponding tool result message from index (O(1) lookup)
        const toolResult = this.toolResultIndex.get(toolCall.id);

        if (!toolResult) {
          logger.debug(
            '[CONVERSATION_MANAGER]',
            this.instanceId,
            'hasSuccessfulReadFor: No tool result found for tool_call_id',
            toolCall.id
          );
          continue;
        }

        // Parse tool result content and check for success
        try {
          const content = typeof toolResult.content === 'string' ? toolResult.content : JSON.stringify(toolResult.content);
          const result = JSON.parse(content);

          if (result.success === true) {
            logger.debug(
              '[CONVERSATION_MANAGER]',
              this.instanceId,
              'hasSuccessfulReadFor: Found successful read for',
              filePath
            );
            return true;
          }
        } catch (error) {
          // Malformed JSON or content - log and continue
          logger.debug(
            '[CONVERSATION_MANAGER]',
            this.instanceId,
            'hasSuccessfulReadFor: Failed to parse tool result for',
            filePath,
            '-',
            error instanceof Error ? error.message : 'Unknown error'
          );
          continue;
        }
      }
    }

    logger.debug(
      '[CONVERSATION_MANAGER]',
      this.instanceId,
      'hasSuccessfulReadFor: No successful read found for',
      filePath
    );
    return false;
  }

  /**
   * Rewind conversation to a specific user message
   *
   * Truncates the conversation history to just before the selected user message.
   * The selected message will be available for editing and re-submission.
   *
   * @param userMessageIndex - Index of the user message in the filtered user messages array
   * @returns The content of the target message for pre-filling the input
   */
  rewindToMessage(userMessageIndex: number): string {
    // Filter to user messages only
    const userMessages = this.messages.filter(m => m.role === 'user');

    if (userMessageIndex < 0 || userMessageIndex >= userMessages.length) {
      throw new Error(`Invalid message index: ${userMessageIndex}. Must be between 0 and ${userMessages.length - 1}`);
    }

    // Get the target user message
    const targetMessage = userMessages[userMessageIndex];
    if (!targetMessage) {
      throw new Error(`Target message at index ${userMessageIndex} not found`);
    }

    // Find its position in the full messages array
    const cutoffIndex = this.messages.findIndex(
      m => m.role === 'user' && m.timestamp === targetMessage.timestamp && m.content === targetMessage.content
    );

    if (cutoffIndex === -1) {
      throw new Error('Target message not found in conversation history');
    }

    // Remove tool results from index for messages being removed
    for (let i = cutoffIndex; i < this.messages.length; i++) {
      const msg = this.messages[i];
      if (msg && msg.role === 'tool' && msg.tool_call_id) {
        this.toolResultIndex.delete(msg.tool_call_id);
      }
    }

    // Preserve system message and truncate to just before the target message
    const systemMessage = this.messages[0]?.role === 'system' ? this.messages[0] : null;
    const truncatedMessages = this.messages.slice(systemMessage ? 1 : 0, cutoffIndex);

    // Update messages to the truncated version
    this.messages = systemMessage ? [systemMessage, ...truncatedMessages] : truncatedMessages;

    logger.debug(
      '[CONVERSATION_MANAGER]',
      this.instanceId,
      'Rewound to message',
      userMessageIndex,
      '- Total messages now:',
      this.messages.length
    );

    // Return the target message content for pre-filling the input
    return targetMessage.content;
  }

  /**
   * Get the last message in conversation
   *
   * @returns Last message or undefined if empty
   */
  getLastMessage(): Message | undefined {
    return this.messages[this.messages.length - 1];
  }

  /**
   * Get the last user message
   *
   * @returns Last user message or undefined if none found
   */
  getLastUserMessage(): Message | undefined {
    // Iterate backwards without copying the array
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i]?.role === 'user') {
        return this.messages[i];
      }
    }
    return undefined;
  }

  /**
   * Get the index of the most recent user message (turn boundary)
   *
   * A "turn" is defined as everything from a user message until the next user message.
   * This method finds the boundary of the current turn by locating the most recent
   * user message in the conversation.
   *
   * @returns Index of the most recent user message, or 0 if no user message exists
   */
  getCurrentTurnBoundaryIndex(): number {
    // Scan backwards to find the most recent user message
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i]?.role === 'user') {
        return i;
      }
    }
    // No user message found - everything is "current turn"
    return 0;
  }

  /**
   * Partition tool call IDs by turn (current vs prior)
   *
   * Takes an array of tool_call_ids and partitions them into two groups:
   * - currentTurn: Tool results that appear at or after the most recent user message
   * - priorTurns: Tool results that appear before the most recent user message
   *
   * Uses the toolResultIndex for O(1) message lookup. IDs not found in the index
   * are silently skipped (not included in either array).
   *
   * @param toolCallIds - Array of tool call IDs to partition
   * @returns Object with currentTurn and priorTurns arrays
   */
  partitionByTurn(toolCallIds: string[]): { currentTurn: string[]; priorTurns: string[] } {
    const turnBoundary = this.getCurrentTurnBoundaryIndex();
    const currentTurn: string[] = [];
    const priorTurns: string[] = [];

    for (const toolCallId of toolCallIds) {
      // O(1) lookup in toolResultIndex
      const toolResultMessage = this.toolResultIndex.get(toolCallId);

      if (!toolResultMessage) {
        // ID not found - skip silently
        continue;
      }

      // Find the message index in the messages array
      const messageIndex = this.messages.indexOf(toolResultMessage);

      if (messageIndex === -1) {
        // Message not found in array (shouldn't happen, but handle defensively)
        continue;
      }

      // Partition based on turn boundary
      if (messageIndex >= turnBoundary) {
        currentTurn.push(toolCallId);
      } else {
        priorTurns.push(toolCallId);
      }
    }

    return { currentTurn, priorTurns };
  }

  /**
   * Check if conversation has any user messages
   *
   * @returns True if at least one user message exists
   */
  hasUserMessages(): boolean {
    return this.messages.some(m => m.role === 'user');
  }

  /**
   * Get messages for compaction (exclude ephemeral, prepare for summarization)
   *
   * @returns Messages suitable for compaction
   */
  getMessagesForCompaction(): Message[] {
    // Get system message and other messages
    const systemMessage = this.getSystemMessage();
    let otherMessages = systemMessage ? this.messages.slice(1) : this.messages;

    // Filter out ephemeral messages before compaction
    otherMessages = otherMessages.filter(msg => !msg.metadata?.ephemeral);

    return systemMessage ? [systemMessage, ...otherMessages] : otherMessages;
  }

  /**
   * Rebuild the tool result index from current messages
   *
   * @private
   */
  private rebuildToolResultIndex(): void {
    this.toolResultIndex.clear();
    for (const msg of this.messages) {
      if (msg.role === 'tool' && msg.tool_call_id) {
        this.toolResultIndex.set(msg.tool_call_id, msg);
      }
    }
  }
}
