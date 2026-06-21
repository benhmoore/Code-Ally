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

interface MessageTokenCacheEntry {
  fingerprint: string;
  tokens: number;
}

/**
 * TokenManager manages token counting and context tracking
 */
/** Maximum entries in message token cache before cleanup triggers */
const MAX_CACHE_SIZE = 1000;

/** Target cache size after cleanup (keeps most recent entries) */
const CACHE_CLEANUP_TARGET = 500;

/** EMA weight applied to each new calibration sample after the first. */
const CALIBRATION_ALPHA = 0.4;

export class TokenManager {
  private contextSize: number;
  private currentTokenCount: number = 0;
  /**
   * Smoothed gap (in tokens) between the backend's actual prompt-token count and
   * our local message estimate. Captures the fixed overhead the estimate omits —
   * tool schemas, the chat template, and the model's own tokenizer vs Anthropic's.
   * Added to every reported count so budget decisions track what the server
   * actually sees. Starts at 0 (no correction) and converges within a turn or two.
   */
  private overheadTokens: number = 0;
  private calibrated: boolean = false;
  private seenFiles: Map<string, string> = new Map(); // path -> content hash
  private toolResultHashes: Map<string, string> = new Map(); // content hash -> tool_call_id (first occurrence)
  private messageTokenCache: Map<string, MessageTokenCacheEntry> = new Map(); // message id -> token count + content fingerprint

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

  private getMessageTokenFingerprint(message: Message): string {
    return JSON.stringify({
      role: message.role,
      content: message.content ?? '',
      name: message.name ?? '',
      tool_call_id: message.tool_call_id ?? '',
      tool_calls: message.tool_calls ?? null,
    });
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
      let tokens: number | undefined;
      const fingerprint = message.id ? this.getMessageTokenFingerprint(message) : undefined;
      const cached = message.id ? this.messageTokenCache.get(message.id) : undefined;
      if (cached && cached.fingerprint === fingerprint) {
        tokens = cached.tokens;
      }

      if (tokens === undefined) {
        // Not cached - calculate and store
        tokens = this.estimateMessageTokens(message);
        if (message.id && fingerprint) {
          this.messageTokenCache.set(message.id, { fingerprint, tokens });
        }
      }
      total += tokens;
    }
    return total;
  }

  /**
   * Update the current token count based on messages
   *
   * Also prunes stale cache entries that are no longer in the message array.
   * This prevents unbounded cache growth after compaction removes old messages.
   *
   * @param messages Current message array
   */
  updateTokenCount(messages: readonly Message[]): void {
    this.currentTokenCount = this.estimateMessagesTokens(messages);

    // Prune cache entries not in current messages to prevent memory leak
    // Only prune when cache is getting large to avoid overhead on every update
    if (this.messageTokenCache.size > MAX_CACHE_SIZE) {
      this.pruneCache(messages);
    }
  }

  /**
   * Prune stale cache entries, keeping only those for current messages
   *
   * Called automatically when cache exceeds MAX_CACHE_SIZE.
   * Can also be called manually after operations that remove many messages (e.g., compaction).
   *
   * @param messages Current message array to retain cache entries for
   */
  pruneCache(messages: readonly Message[]): void {
    // Build set of current message IDs for O(1) lookup
    const currentIds = new Set<string>();
    for (const msg of messages) {
      if (msg.id) {
        currentIds.add(msg.id);
      }
    }

    // Remove entries not in current messages
    const entriesToDelete: string[] = [];
    for (const id of this.messageTokenCache.keys()) {
      if (!currentIds.has(id)) {
        entriesToDelete.push(id);
      }
    }

    for (const id of entriesToDelete) {
      this.messageTokenCache.delete(id);
    }

    // If still above target after removing stale entries, trim oldest
    // (Map maintains insertion order, so oldest entries are first)
    if (this.messageTokenCache.size > CACHE_CLEANUP_TARGET) {
      const excess = this.messageTokenCache.size - CACHE_CLEANUP_TARGET;
      const iterator = this.messageTokenCache.keys();
      for (let i = 0; i < excess; i++) {
        const { value, done } = iterator.next();
        if (done) break;
        this.messageTokenCache.delete(value);
      }
    }
  }

  /**
   * Add tokens for a single message to the running total (O(1))
   * Use this when adding messages incrementally instead of full recalculation.
   * @param message Message to add tokens for
   */
  addMessageTokens(message: Message): void {
    const tokens = this.estimateMessageTokens(message);
    this.currentTokenCount += tokens;
    // Cache the result if message has ID
    if (message.id) {
      this.messageTokenCache.set(message.id, {
        fingerprint: this.getMessageTokenFingerprint(message),
        tokens,
      });
    }
  }

  /**
   * Calibrate the estimator against a backend-reported prompt-token count.
   *
   * Records the gap between what the server actually counted and what our local
   * estimate produced for the same request, smoothing it across turns. This gap
   * is then added to every reported count, so the message-only estimate (which
   * omits tool schemas and chat-template overhead, and uses a different
   * tokenizer than the served model) is corrected toward ground truth.
   *
   * @param estimatedPromptTokens Our raw estimate for the messages that were sent
   * @param actualPromptTokens The backend's reported prompt token count
   */
  calibrate(estimatedPromptTokens: number, actualPromptTokens: number): void {
    if (!Number.isFinite(estimatedPromptTokens) || !Number.isFinite(actualPromptTokens)) return;
    if (estimatedPromptTokens <= 0 || actualPromptTokens <= 0) return;

    const gap = actualPromptTokens - estimatedPromptTokens;
    // Snap to the first real sample, then smooth subsequent ones.
    const alpha = this.calibrated ? CALIBRATION_ALPHA : 1.0;
    this.overheadTokens = Math.round(this.overheadTokens * (1 - alpha) + gap * alpha);
    this.calibrated = true;
  }

  /** The current calibration overhead in tokens (0 until first calibrated). */
  getCalibrationOverhead(): number {
    return this.overheadTokens;
  }

  /** Apply the calibration overhead to a raw estimate (never below zero). */
  private effective(rawTokens: number): number {
    return Math.max(0, rawTokens + this.overheadTokens);
  }

  /**
   * Get the current token count (calibrated to the backend's accounting).
   *
   * @returns Current token count
   */
  getCurrentTokenCount(): number {
    return this.effective(this.currentTokenCount);
  }

  /**
   * Get context usage as a percentage (0-100)
   *
   * Uses Math.floor for conservative reporting - this prevents edge cases where
   * 94.5% rounds to 95% and falsely triggers "compaction didn't reduce context"
   * errors when actual usage is below threshold.
   *
   * @returns Usage percentage, capped at 100
   */
  getContextUsagePercentage(): number {
    if (this.contextSize === 0) {
      return 0;
    }
    const percentage = (this.effective(this.currentTokenCount) / this.contextSize) * 100;
    return Math.min(100, Math.floor(percentage));
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
    this.overheadTokens = 0;
    this.calibrated = false;
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
   * Update the maximum context size used for usage and remaining-token calculations.
   *
   * Existing token counts remain valid; changing the denominator immediately updates
   * percentages and tool budgets without needing to rebuild the manager.
   */
  setContextSize(contextSize: number): void {
    if (!Number.isFinite(contextSize) || contextSize <= 0) {
      throw new Error(`Invalid context size: ${contextSize}`);
    }

    this.contextSize = contextSize;
  }

  /**
   * Calculate remaining tokens in context window
   *
   * @returns Remaining token count
   */
  getRemainingTokens(): number {
    return Math.max(0, this.contextSize - this.effective(this.currentTokenCount));
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
    cacheSize: number;
  } {
    return {
      contextSize: this.contextSize,
      currentTokens: this.getCurrentTokenCount(),
      remainingTokens: this.getRemainingTokens(),
      usagePercentage: this.getContextUsagePercentage(),
      trackedFiles: this.seenFiles.size,
      cacheSize: this.messageTokenCache.size,
    };
  }
}
