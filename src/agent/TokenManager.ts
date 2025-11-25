/**
 * TokenManager - Tracks token usage and manages conversation context
 *
 * Responsibilities:
 * - Estimate token counts for messages
 * - Track total context usage
 * - Calculate usage percentage
 * - Detect when near context limit
 * - Simple file content deduplication (track seen content hashes)
 */

import { Message } from '../types/index.js';
import { createHash } from 'crypto';
import { tokenCounter } from '../services/TokenCounter.js';

/**
 * TokenManager manages token counting and context tracking
 */
export class TokenManager {
  private contextSize: number;
  private currentTokenCount: number = 0;
  private seenFiles: Map<string, string> = new Map(); // path -> content hash
  private toolResultHashes: Map<string, string> = new Map(); // content hash -> tool_call_id (first occurrence)
  private messageTokenCache: Map<string, number> = new Map(); // message id -> token count

  /**
   * Create a new TokenManager
   * @param contextSize Maximum context window size in tokens
   */
  constructor(contextSize: number) {
    this.contextSize = contextSize;
  }

  /**
   * Count tokens in text using Anthropic's official tokenizer
   *
   * @param text Text to count tokens for
   * @returns Actual token count
   */
  estimateTokens(text: string): number {
    return tokenCounter.count(text);
  }

  /**
   * Estimate token count for a single message
   * Includes:
   * - Content tokens
   * - Role/metadata overhead
   * - Tool call tokens if present
   *
   * @param message Message to estimate
   * @returns Estimated token count
   */
  estimateMessageTokens(message: Message): number {
    let tokens = 0;

    // Base overhead per message (role, structure, etc.)
    tokens += 4;

    // Content tokens
    if (message.content) {
      tokens += this.estimateTokens(message.content);
    }

    // Name field tokens
    if (message.name) {
      tokens += this.estimateTokens(message.name) + 1;
    }

    // Tool call tokens
    if (message.tool_calls) {
      for (const toolCall of message.tool_calls) {
        // Tool call ID
        tokens += this.estimateTokens(toolCall.id);
        // Function name
        tokens += this.estimateTokens(toolCall.function.name);
        // Arguments (as JSON string for estimation)
        tokens += this.estimateTokens(JSON.stringify(toolCall.function.arguments));
      }
    }

    // Tool call ID for tool messages
    if (message.tool_call_id) {
      tokens += this.estimateTokens(message.tool_call_id);
    }

    return tokens;
  }

  /**
   * Estimate total token count for an array of messages
   *
   * Uses cached token counts for messages that have already been counted.
   * This provides O(1) performance for repeated counts of the same message array.
   *
   * @param messages Array of messages
   * @returns Total estimated token count
   */
  estimateMessagesTokens(messages: readonly Message[]): number {
    let total = 0;
    for (const message of messages) {
      // Check cache first (skip caching if message has no id)
      let tokens = message.id ? this.messageTokenCache.get(message.id) : undefined;
      if (tokens === undefined) {
        // Not cached - calculate and store
        tokens = this.estimateMessageTokens(message);
        if (message.id) {
          this.messageTokenCache.set(message.id, tokens);
        }
      }
      total += tokens;
    }
    return total;
  }

  /**
   * Update the current token count based on messages
   *
   * @param messages Current message array
   */
  updateTokenCount(messages: readonly Message[]): void {
    this.currentTokenCount = this.estimateMessagesTokens(messages);
  }

  /**
   * Get the current token count
   *
   * @returns Current token count
   */
  getCurrentTokenCount(): number {
    return this.currentTokenCount;
  }

  /**
   * Get context usage as a percentage (0-100)
   *
   * @returns Usage percentage, capped at 100
   */
  getContextUsagePercentage(): number {
    if (this.contextSize === 0) {
      return 0;
    }
    const percentage = (this.currentTokenCount / this.contextSize) * 100;
    return Math.min(100, Math.round(percentage));
  }

  /**
   * Track file content and check if it's new or changed
   * Uses MD5 hashing for content deduplication
   *
   * @param path File path
   * @param content File content
   * @returns true if content is new or changed, false if duplicate
   */
  trackFileContent(path: string, content: string): boolean {
    // Calculate MD5 hash of content
    const hash = this.hashContent(content);

    // Check if we've seen this file before
    const previousHash = this.seenFiles.get(path);

    // Update stored hash
    this.seenFiles.set(path, hash);

    // Return true if content changed or is new
    return previousHash !== hash;
  }

  /**
   * Check if we've seen content for this file path
   *
   * @param path File path
   * @returns true if file has been tracked
   */
  hasSeenContent(path: string): boolean {
    return this.seenFiles.has(path);
  }

  /**
   * Get the hash of previously seen content
   *
   * @param path File path
   * @returns Content hash or undefined if not seen
   */
  getSeenContentHash(path: string): string | undefined {
    return this.seenFiles.get(path);
  }

  /**
   * Track tool result content for deduplication
   *
   * @param toolCallId The tool call ID
   * @param content The tool result content
   * @returns The ID of the first tool call with identical content, or null if this is unique
   */
  trackToolResult(toolCallId: string, content: string): string | null {
    const hash = this.hashContent(content);

    // O(1) lookup: check if we've seen this exact content before
    const existingId = this.toolResultHashes.get(hash);

    if (existingId !== undefined && existingId !== toolCallId) {
      // Found a duplicate - return the existing ID (first occurrence)
      return existingId;
    }

    // No duplicate found - store this as the first occurrence for this hash
    if (existingId === undefined) {
      this.toolResultHashes.set(hash, toolCallId);
    }

    return null;
  }

  /**
   * Check if a tool result is a duplicate of a previous result
   *
   * @param content The tool result content to check
   * @returns true if this exact content has been seen before
   */
  isToolResultDuplicate(content: string): boolean {
    const hash = this.hashContent(content);
    // O(1) lookup: check if hash exists in map
    return this.toolResultHashes.has(hash);
  }

  /**
   * Reset all tracking state
   * Clears token count and file content tracking
   */
  reset(): void {
    this.currentTokenCount = 0;
    this.seenFiles.clear();
    this.toolResultHashes.clear();
    this.messageTokenCache.clear();
  }

  /**
   * Get the maximum context size
   *
   * @returns Context size in tokens
   */
  getContextSize(): number {
    return this.contextSize;
  }

  /**
   * Calculate remaining tokens in context window
   *
   * @returns Remaining token count
   */
  getRemainingTokens(): number {
    return Math.max(0, this.contextSize - this.currentTokenCount);
  }

  /**
   * Check if context usage is above a threshold
   *
   * @param thresholdPercent Threshold percentage (0-100)
   * @returns true if usage exceeds threshold
   */
  isAboveThreshold(thresholdPercent: number): boolean {
    return this.getContextUsagePercentage() >= thresholdPercent;
  }

  /**
   * Hash content using MD5 for deduplication
   *
   * @param content Content to hash
   * @returns MD5 hash as hex string
   */
  hashContent(content: string): string {
    return createHash('md5').update(content, 'utf8').digest('hex');
  }

  /**
   * Truncate content to fit within a specified token limit
   *
   * @param content Content to truncate
   * @param maxTokens Maximum tokens allowed
   * @returns Truncated content that fits within the token limit
   */
  truncateContentToTokens(content: string, maxTokens: number): string {
    if (!content || content.length === 0) {
      return content;
    }

    // Quick check if content is already under the limit
    const actualTokens = this.estimateTokens(content);
    if (actualTokens <= maxTokens) {
      return content;
    }

    // Binary search for the right truncation point
    let low = 0;
    let high = content.length;
    let bestLength = 0;

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const truncated = content.slice(0, mid) + '...';
      const tokens = this.estimateTokens(truncated);

      if (tokens <= maxTokens) {
        bestLength = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    return content.slice(0, bestLength) + '...';
  }

  /**
   * Get statistics about current token usage
   * Useful for debugging and monitoring
   *
   * @returns Statistics object
   */
  getStats(): {
    contextSize: number;
    currentTokens: number;
    remainingTokens: number;
    usagePercentage: number;
    trackedFiles: number;
  } {
    return {
      contextSize: this.contextSize,
      currentTokens: this.currentTokenCount,
      remainingTokens: this.getRemainingTokens(),
      usagePercentage: this.getContextUsagePercentage(),
      trackedFiles: this.seenFiles.size,
    };
  }
}
