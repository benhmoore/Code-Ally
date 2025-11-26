/**
 * MessageHistory - Conversation state management
 *
 * Manages the message history for conversations with the LLM, including:
 * - Adding and retrieving messages
 * - Token estimation
 * - Context management
 * - Message truncation
 *
 * Messages follow the OpenAI format with roles: system, user, assistant, tool
 */

import { Message } from '../types/index.js';
import { TOKEN_MANAGEMENT } from '../config/constants.js';

/**
 * Options for message history management
 */
export interface MessageHistoryOptions {
  /** Maximum number of messages to retain */
  maxMessages?: number;
  /** Maximum tokens to keep in history */
  maxTokens?: number;
}

export class MessageHistory {
  private messages: Message[] = [];
  private readonly maxMessages: number;
  private readonly maxTokens: number;
  private cachedTokenCount = 0;

  /**
   * Initialize message history
   *
   * @param options - Configuration options
   *
   * @example
   * ```typescript
   * const history = new MessageHistory({
   *   maxMessages: 1000,
   *   maxTokens: 16000
   * });
   * ```
   */
  constructor(options: MessageHistoryOptions = {}) {
    this.maxMessages = options.maxMessages || 1000;
    this.maxTokens = options.maxTokens || 16000;
  }

  /**
   * Add a message to the history
   *
   * @param message - Message to add
   *
   * @example
   * ```typescript
   * history.addMessage({
   *   role: 'user',
   *   content: 'Hello, how are you?'
   * });
   * ```
   */
  addMessage(message: Message): void {
    this.messages.push(message);
    this.cachedTokenCount += this.estimateSingleMessage(message);
    this.enforceConstraints();
  }

  /**
   * Add multiple messages to the history
   *
   * @param messages - Messages to add
   */
  addMessages(messages: Message[]): void {
    for (const message of messages) {
      this.cachedTokenCount += this.estimateSingleMessage(message);
    }
    this.messages.push(...messages);
    this.enforceConstraints();
  }

  /**
   * Get all messages in the history
   *
   * @returns Array of messages
   */
  getMessages(): Message[] {
    return [...this.messages];
  }

  /**
   * Get the last N messages
   *
   * @param count - Number of messages to retrieve
   * @returns Array of messages
   */
  getLastMessages(count: number): Message[] {
    return this.messages.slice(-count);
  }

  /**
   * Clear all messages except system message
   */
  clearConversation(): void {
    const systemMessage = this.messages.find(m => m.role === 'system');
    this.messages = systemMessage ? [systemMessage] : [];
    this.recalculateTokens();
  }

  /**
   * Clear all messages including system message
   */
  clearAll(): void {
    this.messages = [];
    this.cachedTokenCount = 0;
  }

  /**
   * Get the current message count
   */
  get messageCount(): number {
    return this.messages.length;
  }

  /**
   * Estimate token count for the current history
   *
   * Uses a simple heuristic: ~4 characters per token
   * Returns cached value for O(1) performance
   *
   * @returns Estimated token count
   */
  estimateTokenCount(): number {
    return this.cachedTokenCount;
  }

  /**
   * Estimate token count for a single message
   *
   * @param message - Message to estimate
   * @returns Estimated token count
   */
  private estimateSingleMessage(message: Message): number {
    let totalChars = 0;

    // Count content characters
    if (message.content) {
      totalChars += message.content.length;
    }

    // Count tool call characters
    if (message.tool_calls) {
      totalChars += JSON.stringify(message.tool_calls).length;
    }

    // Add overhead for role and structure (~20 chars)
    totalChars += TOKEN_MANAGEMENT.MESSAGE_OVERHEAD_CHARS;

    // Estimate: ~4 chars per token
    return Math.ceil(totalChars / TOKEN_MANAGEMENT.CHARS_PER_TOKEN_ESTIMATE);
  }

  /**
   * Recalculate token count from scratch
   * Used when messages array is modified directly
   */
  private recalculateTokens(): void {
    this.cachedTokenCount = 0;
    for (const message of this.messages) {
      this.cachedTokenCount += this.estimateSingleMessage(message);
    }
  }

  /**
   * Get context usage as a percentage
   *
   * @returns Percentage (0-100)
   */
  getContextUsagePercent(): number {
    const currentTokens = this.estimateTokenCount();
    return Math.min(100, Math.round((currentTokens / this.maxTokens) * 100));
  }

  /**
   * Check if context is near capacity
   *
   * @param threshold - Percentage threshold (default: 80)
   * @returns True if usage is above threshold
   */
  isNearCapacity(threshold: number = TOKEN_MANAGEMENT.NEAR_CAPACITY_THRESHOLD): boolean {
    return this.getContextUsagePercent() >= threshold;
  }

  /**
   * Update system message
   *
   * @param content - New system message content
   */
  updateSystemMessage(content: string): void {
    const systemIndex = this.messages.findIndex(m => m.role === 'system');

    if (systemIndex !== -1) {
      const message = this.messages[systemIndex];
      if (message) {
        // Subtract old token count, add new token count
        this.cachedTokenCount -= this.estimateSingleMessage(message);
        message.content = content;
        this.cachedTokenCount += this.estimateSingleMessage(message);
      }
    } else {
      const newMessage: Message = {
        role: 'system',
        content,
      };
      this.messages.unshift(newMessage);
      this.cachedTokenCount += this.estimateSingleMessage(newMessage);
    }
  }

  /**
   * Get the system message if present
   */
  getSystemMessage(): Message | undefined {
    return this.messages.find(m => m.role === 'system');
  }

  /**
   * Enforce message count and token constraints
   *
   * Removes oldest messages (excluding system message) if limits are exceeded.
   * Never removes the system message.
   */
  private enforceConstraints(): void {
    // Separate system message from others
    const systemMessage = this.messages.find(m => m.role === 'system');
    let otherMessages = this.messages.filter(m => m.role !== 'system');

    // Enforce message count limit
    if (otherMessages.length > this.maxMessages - 1) {
      const excess = otherMessages.length - (this.maxMessages - 1);
      // Subtract removed messages from cached count
      for (let i = 0; i < excess; i++) {
        const removed = otherMessages[i];
        if (removed) {
          this.cachedTokenCount -= this.estimateSingleMessage(removed);
        }
      }
      otherMessages = otherMessages.slice(excess);
    }

    // Enforce token limit using cached count
    while (this.cachedTokenCount > this.maxTokens && otherMessages.length > 0) {
      // Remove oldest message
      const removed = otherMessages.shift();
      if (removed) {
        this.cachedTokenCount -= this.estimateSingleMessage(removed);
      }
    }

    // Reconstruct messages array
    this.messages = systemMessage ? [systemMessage, ...otherMessages] : otherMessages;
  }


  /**
   * Export messages to JSON
   */
  toJSON(): Message[] {
    return this.getMessages();
  }

  /**
   * Load messages from JSON
   */
  fromJSON(messages: Message[]): void {
    this.messages = messages;
    this.recalculateTokens();
    this.enforceConstraints();
  }

  /**
   * Get a formatted summary of the history
   */
  getSummary(): string {
    const tokenCount = this.estimateTokenCount();
    const usagePercent = this.getContextUsagePercent();

    return [
      `Messages: ${this.messageCount}`,
      `Tokens: ~${tokenCount}/${this.maxTokens} (${usagePercent}%)`,
      `System: ${this.getSystemMessage() ? 'Yes' : 'No'}`,
    ].join(' | ');
  }

  /**
   * Get message statistics
   */
  getStats(): {
    messageCount: number;
    tokenCount: number;
    contextUsage: number;
    hasSystemMessage: boolean;
    messagesByRole: Record<string, number>;
  } {
    const messagesByRole: Record<string, number> = {};

    for (const message of this.messages) {
      messagesByRole[message.role] = (messagesByRole[message.role] || 0) + 1;
    }

    return {
      messageCount: this.messageCount,
      tokenCount: this.estimateTokenCount(),
      contextUsage: this.getContextUsagePercent(),
      hasSystemMessage: !!this.getSystemMessage(),
      messagesByRole,
    };
  }
}
