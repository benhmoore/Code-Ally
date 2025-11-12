/**
 * AgentCompactor - Handles conversation compaction and auto-compaction
 *
 * Core responsibilities:
 * - Check if auto-compaction should trigger based on context usage
 * - Perform automatic compaction when threshold is reached
 * - Execute compaction with summarization (used by both auto and manual compaction)
 * - Emit compaction events for UI updates
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
   * Auto-compaction only runs for main agents (not specialized agents).
   *
   * @param context - Compaction context with agent info
   * @returns true if compaction was performed, false otherwise
   */
  async checkAndPerformAutoCompaction(context: CompactionContext): Promise<boolean> {
    // Don't auto-compact for specialized agents
    if (context.isSpecializedAgent) {
      return false;
    }

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
        data: {},
      });

      // Perform compaction with auto-compact settings
      const compacted = await this.compactConversation(
        this.conversationManager.getMessages(),
        {
          preserveLastUserMessage: true,
          timestampLabel: 'auto-compacted',
        }
      );

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
      return false;
    }
  }

  /**
   * Compact conversation messages with summarization
   *
   * This is the single source of truth for compaction logic, used by both:
   * - Auto-compaction (when context reaches threshold)
   * - Manual /compact command (with optional custom instructions)
   *
   * @param messages - Messages to compact
   * @param options - Compaction options
   * @returns Compacted message array
   */
  async compactConversation(
    messages: Message[],
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
      return messages;
    }

    // Find the last user message (the one that triggered compaction or current user request)
    const lastUserMessage = preserveLastUserMessage
      ? [...otherMessages].reverse().find(m => m.role === 'user')
      : undefined;

    // Messages to summarize: everything except the last user message (if preserving it)
    const messagesToSummarize = lastUserMessage
      ? otherMessages.slice(0, otherMessages.lastIndexOf(lastUserMessage))
      : otherMessages;

    // Create summarization request
    const summarizationRequest: Message[] = [];

    // Add system message for summarization
    summarizationRequest.push({
      role: 'system',
      content:
        'You are an AI assistant summarizing a conversation to save context space. ' +
        'Preserve specific details about: (1) unresolved problems with error messages, stack traces, and file paths, ' +
        '(2) current investigation state, attempted solutions that failed, and next steps, (3) decisions made. ' +
        'Be extremely detailed about ongoing problems but brief about completed work. Use bullet points.',
    });

    // Add messages to be summarized
    summarizationRequest.push(...messagesToSummarize);

    // Build summarization request
    let finalRequest = 'Summarize this conversation, preserving technical details needed to continue work.';

    // Add custom instructions if provided (used by manual /compact command)
    if (customInstructions) {
      finalRequest += ` Additional instructions: ${customInstructions}`;
    }

    // Add context about the current user request if we're preserving it
    if (lastUserMessage) {
      finalRequest += `\n\nThe user's current request is: "${lastUserMessage.content}"`;
    }

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
