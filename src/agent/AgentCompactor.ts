/**
 * AgentCompactor - Handles conversation compaction and auto-compaction
 *
 * Core responsibilities:
 * - Check if auto-compaction should trigger based on context usage
 * - Perform automatic compaction when threshold is reached
 * - Execute compaction with summarization (used by both auto and manual compaction)
 * - Emit compaction events for UI updates
 * - Emergency truncation when context is critically full (>98%)
 *
 * This class extracts compaction logic from Agent to maintain
 * separation of concerns and improve testability.
 */

import { ModelClient } from '../llm/ModelClient.js';
import { ConversationManager } from './ConversationManager.js';
import { TokenManager } from './TokenManager.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { Message, ActivityEventType } from '../types/index.js';
import { logger } from '../services/Logger.js';
import { BUFFER_SIZES } from '../config/constants.js';
import { CONTEXT_THRESHOLDS } from '../config/toolDefaults.js';

/**
 * Maximum percentage of context to use for the summarization request itself.
 * This ensures we have enough room for the LLM to process and generate a summary.
 * At 70%, we use 70% of context for input, leaving 30% for processing/output.
 */
const MAX_SUMMARIZATION_CONTEXT_PERCENT = 70;

/**
 * Context needed for compaction operations
 */
export interface CompactionContext {
  /** Agent instance ID for logging */
  instanceId: string;
  /** Whether this is a specialized/delegated agent */
  isSpecializedAgent: boolean;
  /** Compact threshold from config */
  compactThreshold?: number;
  /** Function to generate unique IDs for events */
  generateId: () => string;
  /** Parent tool call ID for nesting compaction events under delegated agent tool calls */
  parentCallId?: string;
}

/**
 * Options for compaction operation
 */
export interface CompactionOptions {
  /** Optional custom instructions for summarization */
  customInstructions?: string;
  /** Whether to preserve the last user message (default: true for auto-compact) */
  preserveLastUserMessage?: boolean;
  /** Label for the summary timestamp (e.g., "auto-compacted" or none for manual) */
  timestampLabel?: string;
}

/**
 * Coordinates conversation compaction with context usage monitoring
 */
export class AgentCompactor {
  constructor(
    private modelClient: ModelClient,
    private conversationManager: ConversationManager,
    private tokenManager: TokenManager,
    private activityStream: ActivityStream
  ) {}

  /**
   * Check if auto-compaction should trigger and perform it if needed
   *
   * This is called before each LLM request to ensure context stays within limits.
   * Uses two strategies:
   * - Normal compaction (95-98%): Summarize old messages using LLM
   * - Emergency truncation (98%+): Drop old messages without summarization
   *
   * @param context - Compaction context with agent info
   * @returns true if compaction was performed, false otherwise
   */
  async checkAndPerformAutoCompaction(context: CompactionContext): Promise<boolean> {

    // Get TokenManager (instance variable)
    if (typeof this.tokenManager.getContextUsagePercentage !== 'function') {
      return false;
    }

    // Check current context usage
    const contextUsage = this.tokenManager.getContextUsagePercentage();
    const threshold = context.compactThreshold || CONTEXT_THRESHOLDS.CRITICAL;

    // Check if context usage exceeds threshold (primary concern - do we need to compact?)
    if (contextUsage < threshold) {
      return false; // Context not full, no need to compact
    }

    // Context is full - validate we have enough messages for meaningful summarization (quality gate)
    if (this.conversationManager.getMessageCount() < BUFFER_SIZES.MIN_MESSAGES_TO_ATTEMPT_COMPACTION) {
      logger.debug('[AGENT_AUTO_COMPACT]', context.instanceId,
        `Context at ${contextUsage}% (threshold: ${threshold}%) but only ${this.conversationManager.getMessageCount()} messages - ` +
        `too few to compact meaningfully. Consider increasing context_size if this occurs frequently.`);
      return false;
    }

    // Both conditions met: context is full AND we have enough messages
    logger.debug('[AGENT_AUTO_COMPACT]', context.instanceId,
      `Context at ${contextUsage}%, threshold ${threshold}% - triggering compaction`);

    try {
      // Emit compaction start event
      this.emitEvent({
        id: context.generateId(),
        type: ActivityEventType.COMPACTION_START,
        timestamp: Date.now(),
        data: {
          parentId: context.parentCallId,
        },
      });

      let compacted: Message[];

      // Emergency truncation: at very high context (98%+), skip summarization entirely
      // LLM summarization would likely fail because the summarization request itself
      // would exceed context limits
      if (contextUsage >= CONTEXT_THRESHOLDS.EMERGENCY) {
        logger.debug('[AGENT_AUTO_COMPACT]', context.instanceId,
          `Emergency truncation at ${contextUsage}% - skipping LLM summarization`);
        compacted = this.performEmergencyTruncation(
          this.conversationManager.getMessages()
        );
      } else {
        // Normal compaction with summarization
        compacted = await this.compactConversation(
          this.conversationManager.getMessages(),
          {
            preserveLastUserMessage: true,
            timestampLabel: 'auto-compacted',
          }
        );
      }

      // Validate compaction result
      if (compacted.length === 0) {
        logger.error('[AGENT_AUTO_COMPACT]', context.instanceId, 'Compaction produced empty result');
        return false;
      }

      // Update messages
      this.conversationManager.setMessages(compacted);

      // Update token count
      this.tokenManager.updateTokenCount(this.conversationManager.getMessages());

      const newContextUsage = this.tokenManager.getContextUsagePercentage();

      // Get the last message's timestamp to place notice before it
      // Find the last non-system message timestamp
      const lastMessageTimestamp = this.conversationManager.getMessages()
        .filter(m => m.role !== 'system')
        .reduce((latest, msg) => Math.max(latest, msg.timestamp || 0), 0);

      // Place compaction notice right before the last message (timestamp - 1)
      const noticeTimestamp = lastMessageTimestamp > 0 ? lastMessageTimestamp - 1 : Date.now();

      // Emit compaction complete event with notice data and compacted messages
      this.emitEvent({
        id: context.generateId(),
        type: ActivityEventType.COMPACTION_COMPLETE,
        timestamp: noticeTimestamp,
        data: {
          parentId: context.parentCallId,
          oldContextUsage: contextUsage,
          newContextUsage,
          threshold,
          compactedMessages: this.conversationManager.getMessages(),
        },
      });

      logger.debug('[AGENT_AUTO_COMPACT]', context.instanceId, `Compaction complete - Context now at ${newContextUsage}%`);
      return true;
    } catch (error) {
      logger.error('[AGENT_AUTO_COMPACT]', context.instanceId, 'Compaction failed:', error);

      // Fallback: if summarization fails, try emergency truncation
      logger.debug('[AGENT_AUTO_COMPACT]', context.instanceId, 'Attempting emergency truncation fallback');
      try {
        const compacted = this.performEmergencyTruncation(
          this.conversationManager.getMessages()
        );
        this.conversationManager.setMessages(compacted);
        this.tokenManager.updateTokenCount(this.conversationManager.getMessages());
        const newContextUsage = this.tokenManager.getContextUsagePercentage();
        logger.debug('[AGENT_AUTO_COMPACT]', context.instanceId,
          `Emergency truncation fallback succeeded - Context now at ${newContextUsage}%`);
        return true;
      } catch (fallbackError) {
        logger.error('[AGENT_AUTO_COMPACT]', context.instanceId, 'Emergency truncation fallback also failed:', fallbackError);
        return false;
      }
    }
  }

  /**
   * Emergency truncation - drop old messages without LLM summarization
   *
   * Used when context is critically full (98%+) and we can't afford an LLM call
   * for summarization. Preserves system prompt and recent messages.
   *
   * @param messages - Messages to truncate
   * @returns Truncated message array
   */
  private performEmergencyTruncation(messages: readonly Message[]): Message[] {
    const result: Message[] = [];

    // Always preserve system message
    const systemMessage = messages[0]?.role === 'system' ? messages[0] : null;
    if (systemMessage) {
      result.push(systemMessage);
    }

    // Get non-system messages
    const otherMessages = systemMessage ? messages.slice(1) : [...messages];

    // Filter out ephemeral messages
    const nonEphemeralMessages = otherMessages.filter(msg => !msg.metadata?.ephemeral);

    if (nonEphemeralMessages.length === 0) {
      return result;
    }

    // Emergency truncation strategy: keep only the most recent messages
    // that fit within target context (50% to leave room for responses)
    const targetContextPercent = 50;
    const targetTokens = Math.floor(this.tokenManager.getContextSize() * targetContextPercent / 100);

    // Start from the end and work backwards, keeping messages until we exceed target
    const keptMessages: Message[] = [];
    let totalTokens = 0;

    for (let i = nonEphemeralMessages.length - 1; i >= 0; i--) {
      const msg = nonEphemeralMessages[i]!;
      const msgTokens = this.tokenManager.estimateMessageTokens(msg);

      if (totalTokens + msgTokens > targetTokens && keptMessages.length > 0) {
        // Would exceed target, stop adding more
        break;
      }

      keptMessages.push(msg);
      totalTokens += msgTokens;
    }

    // Reverse once at the end - O(n) instead of O(n²)
    keptMessages.reverse();

    // Add emergency truncation notice
    const droppedCount = nonEphemeralMessages.length - keptMessages.length;
    if (droppedCount > 0) {
      result.push({
        role: 'system',
        content: `CONVERSATION SUMMARY (emergency truncated at ${new Date().toLocaleTimeString()}): ` +
          `${droppedCount} older messages were dropped to free context space. ` +
          `Recent conversation history follows.`,
        metadata: {
          isConversationSummary: true,
        },
      });
    }

    result.push(...keptMessages);
    return result;
  }

  /**
   * Compact conversation messages with summarization
   *
   * This is the single source of truth for compaction logic, used by both:
   * - Auto-compaction (when context reaches threshold)
   * - Manual /compact command (with optional custom instructions)
   *
   * Size-aware: trims older messages if the summarization request would exceed
   * the available context budget (MAX_SUMMARIZATION_CONTEXT_PERCENT).
   *
   * @param messages - Messages to compact
   * @param options - Compaction options
   * @returns Compacted message array
   */
  async compactConversation(
    messages: readonly Message[],
    options: CompactionOptions = {}
  ): Promise<Message[]> {
    const {
      customInstructions,
      preserveLastUserMessage = true,
      timestampLabel = undefined,
    } = options;

    // Extract system message and other messages
    const systemMessage = messages[0]?.role === 'system' ? messages[0] : null;
    let otherMessages = systemMessage ? messages.slice(1) : messages;

    // Filter out ephemeral messages before compaction
    // Cleanup happens at end-of-turn (ResponseProcessor.processTextResponse), but compaction can trigger
    // mid-turn (during getLLMResponse after tool execution). This ensures ephemeral
    // content is never summarized into conversation history, regardless of timing.
    otherMessages = otherMessages.filter(msg => !msg.metadata?.ephemeral);

    // If we have fewer than 2 non-system messages to summarize, nothing to compact (Level 2: summarization threshold)
    if (otherMessages.length < BUFFER_SIZES.MIN_MESSAGES_TO_SUMMARIZE) {
      return [...messages];
    }

    // Find the last user message (the one that triggered compaction or current user request)
    const lastUserMessage = preserveLastUserMessage
      ? [...otherMessages].reverse().find(m => m.role === 'user')
      : undefined;

    // Messages to summarize: everything except the last user message (if preserving it)
    let messagesToSummarize = lastUserMessage
      ? otherMessages.slice(0, otherMessages.lastIndexOf(lastUserMessage))
      : [...otherMessages];

    // Build fixed parts of summarization request (system prompt + user request)
    const summarizationSystemContent =
      'You are an AI assistant summarizing a conversation to save context space. ' +
      'Preserve specific details about: (1) unresolved problems with error messages, stack traces, and file paths, ' +
      '(2) current investigation state, attempted solutions that failed, and next steps, (3) decisions made. ' +
      'Be extremely detailed about ongoing problems but brief about completed work. Use bullet points.';

    let finalRequest = 'Summarize this conversation, preserving technical details needed to continue work.';
    if (customInstructions) {
      finalRequest += ` Additional instructions: ${customInstructions}`;
    }
    if (lastUserMessage) {
      finalRequest += `\n\nThe user's current request is: "${lastUserMessage.content}"`;
    }

    // Calculate available budget for messages to summarize
    // Use MAX_SUMMARIZATION_CONTEXT_PERCENT of context, leaving room for LLM processing
    const maxSummarizationTokens = Math.floor(
      this.tokenManager.getContextSize() * MAX_SUMMARIZATION_CONTEXT_PERCENT / 100
    );

    // Account for fixed overhead (system prompt + final request + message structure)
    // 3 messages (system + user request + summary response) × ~4 tokens each = ~12 tokens
    const fixedOverhead =
      this.tokenManager.estimateTokens(summarizationSystemContent) +
      this.tokenManager.estimateTokens(finalRequest) +
      12;

    const availableForMessages = maxSummarizationTokens - fixedOverhead;

    // Guard: if budget is too small, fall back to emergency truncation
    if (availableForMessages < 500) {
      logger.debug('[AGENT_COMPACT]', 'Budget too small for summarization, using emergency truncation');
      return this.performEmergencyTruncation(messages);
    }

    // Size-aware trimming: if messages to summarize exceed budget, trim oldest ones
    let totalMessageTokens = 0;
    for (const msg of messagesToSummarize) {
      totalMessageTokens += this.tokenManager.estimateMessageTokens(msg);
    }

    if (totalMessageTokens > availableForMessages && messagesToSummarize.length > BUFFER_SIZES.MIN_MESSAGES_TO_SUMMARIZE) {
      logger.debug('[AGENT_COMPACT]', 'Summarization request exceeds budget',
        `(${totalMessageTokens} > ${availableForMessages} tokens), trimming older messages`);

      // Trim from the beginning (oldest messages) until we fit
      const trimmedMessages: Message[] = [];
      let trimmedTokens = 0;

      // Work backwards from newest to oldest
      for (let i = messagesToSummarize.length - 1; i >= 0; i--) {
        const msg = messagesToSummarize[i]!;
        const msgTokens = this.tokenManager.estimateMessageTokens(msg);

        if (trimmedTokens + msgTokens <= availableForMessages) {
          trimmedMessages.push(msg);
          trimmedTokens += msgTokens;
        } else if (trimmedMessages.length >= BUFFER_SIZES.MIN_MESSAGES_TO_SUMMARIZE) {
          // We have enough messages and hit the limit
          break;
        }
        // Continue even if we exceed - we need minimum messages
      }

      // Reverse once at the end - O(n) instead of O(n²)
      trimmedMessages.reverse();

      messagesToSummarize = trimmedMessages;
      logger.debug('[AGENT_COMPACT]', `Trimmed to ${messagesToSummarize.length} messages (${trimmedTokens} tokens)`);
    }

    // Create summarization request
    const summarizationRequest: Message[] = [];

    // Add system message for summarization
    summarizationRequest.push({
      role: 'system',
      content: summarizationSystemContent,
    });

    // Add messages to be summarized
    summarizationRequest.push(...messagesToSummarize);

    summarizationRequest.push({
      role: 'user',
      content: finalRequest,
    });

    // Generate summary
    const response = await this.modelClient.send(summarizationRequest, {
      stream: false,
    });

    const summary = response.content.trim();

    // Build compacted message list
    const compacted: Message[] = [];
    if (systemMessage) {
      compacted.push(systemMessage);
    }

    // Add summary as system message if we got a meaningful one
    // Simple truthy check: if LLM returns empty/whitespace, we skip it;
    // if it returns any real content, we include it. No magic strings needed.
    if (summary) {
      const summaryLabel = timestampLabel
        ? `CONVERSATION SUMMARY (${timestampLabel} at ${new Date().toLocaleTimeString()})`
        : 'CONVERSATION SUMMARY';

      compacted.push({
        role: 'system',
        content: `${summaryLabel}: ${summary}`,
        metadata: {
          isConversationSummary: true,
        },
      });
    }

    // Add the last user message if we're preserving it
    if (lastUserMessage) {
      compacted.push(lastUserMessage);
    }

    return compacted;
  }

  /**
   * Emit an activity event
   */
  private emitEvent(event: any): void {
    this.activityStream.emit(event);
  }
}
