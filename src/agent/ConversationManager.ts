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
 * Manages conversation message history
 */
export class ConversationManager {
  /** Conversation message array */
  private messages: Message[] = [];

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
   * Get the current conversation history
   *
   * @returns Copy of message array (to prevent external mutation)
   */
  getMessages(): Message[] {
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
      this.messages[0].content = content;
      logger.debug('[CONVERSATION_MANAGER]', this.instanceId, 'System message updated');
    }
  }

  /**
   * Filter messages by role
   *
   * @param role - Role to filter by ('user', 'assistant', 'system', 'tool')
   * @returns Array of messages with matching role
   */
  getMessagesByRole(role: string): Message[] {
    return this.messages.filter(msg => msg.role === role);
  }

  /**
   * Remove messages matching a predicate
   *
   * @param predicate - Function that returns true for messages to remove
   * @returns Number of messages removed
   */
  removeMessages(predicate: (msg: Message) => boolean): number {
    const originalLength = this.messages.length;
    this.messages = this.messages.filter(msg => !predicate(msg));
    const removedCount = originalLength - this.messages.length;

    if (removedCount > 0) {
      logger.debug('[CONVERSATION_MANAGER]', this.instanceId, `Removed ${removedCount} message(s)`);
    }

    return removedCount;
  }

  /**
   * Remove system reminder messages (temporary context hints)
   *
   * @returns Number of reminders removed
   */
  removeSystemReminders(): number {
    return this.removeMessages(msg => msg.role === 'system' && msg.content.includes('<system-reminder>'));
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
    return [...this.messages].reverse().find(m => m.role === 'user');
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
}
