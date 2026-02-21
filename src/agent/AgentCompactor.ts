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
 * Target context percentage after emergency truncation.
 * Set to 50% to leave ample room for the conversation to continue.
 */
const EMERGENCY_TRUNCATION_TARGET_PERCENT = 50;

/**
 * Maximum number of file references to preserve during compaction.
 * Prioritizes edited > written > read files.
 */
const MAX_FILE_REFERENCES = 15;

/**
 * Minimum token budget required to attempt LLM summarization.
 * If available budget is below this, fall back to emergency truncation.
 */
const MIN_SUMMARIZATION_BUDGET = 500;

/**
 * Estimated token overhead for summarization request structure.
 * Accounts for message framing (system + user + response structure).
 */
const SUMMARIZATION_STRUCTURE_OVERHEAD = 12;

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
  /** Guard flag to prevent concurrent compaction operations */
  private isCompacting = false;

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
    // Guard: prevent concurrent compaction operations
    if (this.isCompacting) {
      logger.debug('[AGENT_AUTO_COMPACT]', context.instanceId, 'Skipping - compaction already in progress');
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

    // Set guard flag
    this.isCompacting = true;
    let compactionStarted = false;

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
      compactionStarted = true;

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
        logger.debug('[AGENT_AUTO_COMPACT]', context.instanceId, 'Compaction produced empty result');
        return false;
      }

      // Update messages
      this.conversationManager.setMessages(compacted);

      // Update token count
      this.tokenManager.updateTokenCount(this.conversationManager.getMessages());

      const newContextUsage = this.tokenManager.getContextUsagePercentage();

      // Verify compaction actually reduced context meaningfully
      // If we're still at or above threshold, compaction failed to help
      if (newContextUsage >= threshold) {
        const contextSize = this.tokenManager.getContextSize();
        throw new Error(
          `Compaction did not reduce context usage meaningfully (${contextUsage}% -> ${newContextUsage}%). ` +
          `Context size (${contextSize} tokens) is too small for the current system prompt. ` +
          `Increase context_size in your configuration.`
        );
      }

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
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Check if this is a "context too small" error - these are unrecoverable
      if (errorMessage.includes('Context size too small') || errorMessage.includes('did not reduce context')) {
        // Use debug instead of error: error is communicated via throw + activity events.
        // logger.error uses console.error (stderr) which leaks into the TUI outside agent display.
        logger.debug('[AGENT_AUTO_COMPACT]', context.instanceId, 'Context size too small:', errorMessage);

        // Emit error completion to unstick UI before re-throwing
        if (compactionStarted) {
          this.emitEvent({
            id: context.generateId(),
            type: ActivityEventType.COMPACTION_COMPLETE,
            timestamp: Date.now(),
            data: {
              parentId: context.parentCallId,
              error: true,
              errorMessage,
            },
          });
        }

        throw error; // Re-throw - this is unrecoverable, user must increase context_size
      }

      // Use debug: error is handled via fallback + throw. logger.error leaks to TUI via stderr.
      logger.debug('[AGENT_AUTO_COMPACT]', context.instanceId, 'Compaction failed:', error);

      // Fallback: if summarization fails, try emergency truncation
      logger.debug('[AGENT_AUTO_COMPACT]', context.instanceId, 'Attempting emergency truncation fallback');
      try {
        const compacted = this.performEmergencyTruncation(
          this.conversationManager.getMessages()
        );
        this.conversationManager.setMessages(compacted);
        this.tokenManager.updateTokenCount(this.conversationManager.getMessages());
        const newContextUsage = this.tokenManager.getContextUsagePercentage();

        // Verify fallback actually helped
        if (newContextUsage >= threshold) {
          const contextSize = this.tokenManager.getContextSize();
          throw new Error(
            `Emergency truncation fallback did not reduce context (${contextUsage}% -> ${newContextUsage}%). ` +
            `Context size (${contextSize} tokens) is too small. Increase context_size in your configuration.`
          );
        }

        // Emit success event for fallback path
        const lastMessageTimestamp = this.conversationManager.getMessages()
          .filter(m => m.role !== 'system')
          .reduce((latest, msg) => Math.max(latest, msg.timestamp || 0), 0);
        const noticeTimestamp = lastMessageTimestamp > 0 ? lastMessageTimestamp - 1 : Date.now();

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
            wasEmergencyFallback: true,
          },
        });

        logger.debug('[AGENT_AUTO_COMPACT]', context.instanceId,
          `Emergency truncation fallback succeeded - Context now at ${newContextUsage}%`);
        return true;
      } catch (fallbackError) {
        const fallbackErrorMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
        // Use debug: error is communicated via throw + activity events. logger.error leaks to TUI via stderr.
        logger.debug('[AGENT_AUTO_COMPACT]', context.instanceId, 'Emergency truncation fallback also failed:', fallbackError);

        // Emit error completion to unstick UI
        if (compactionStarted) {
          this.emitEvent({
            id: context.generateId(),
            type: ActivityEventType.COMPACTION_COMPLETE,
            timestamp: Date.now(),
            data: {
              parentId: context.parentCallId,
              error: true,
              errorMessage: fallbackErrorMessage,
            },
          });
        }

        throw fallbackError; // Re-throw - context_size errors are unrecoverable
      }
    } finally {
      // Always reset guard flag
      this.isCompacting = false;
    }
  }

  /**
   * Extract file references from messages for context preservation
   *
   * Scans assistant tool calls (read, edit, write) and user message mentions
   * to build a list of files that should be available for post-compaction context.
   *
   * @param messages - Messages to extract file references from
   * @returns Object with paths array and categorized sources
   */
  private extractFileReferences(messages: readonly Message[]): {
    paths: string[];
    sources: {
      read: string[];
      edited: string[];
      written: string[];
    };
  } {
    const readFiles = new Set<string>();
    const editedFiles = new Set<string>();
    const writtenFiles = new Set<string>();

    for (const message of messages) {
      // Extract from assistant tool calls
      if (message.role === 'assistant' && message.tool_calls) {
        for (const toolCall of message.tool_calls) {
          const toolName = toolCall.function.name;
          const args = toolCall.function.arguments;

          if (toolName === 'read' && args.file_paths && Array.isArray(args.file_paths)) {
            // Read tool uses file_paths array
            for (const path of args.file_paths) {
              if (typeof path === 'string') {
                readFiles.add(path);
              }
            }
          } else if ((toolName === 'edit' || toolName === 'line-edit') && args.file_path && typeof args.file_path === 'string') {
            // Edit and line-edit tools use file_path string
            editedFiles.add(args.file_path);
          } else if (toolName === 'write' && args.file_path && typeof args.file_path === 'string') {
            // Write tool uses file_path string
            writtenFiles.add(args.file_path);
          }
        }
      }

      // Extract from user message mentions
      if (message.role === 'user' && message.metadata?.mentions?.files) {
        for (const path of message.metadata.mentions.files) {
          readFiles.add(path);
        }
      }
    }

    // Deduplicate: edited files shouldn't appear in read list, written files shouldn't appear in edited or read
    for (const edited of editedFiles) {
      readFiles.delete(edited);
    }
    for (const written of writtenFiles) {
      editedFiles.delete(written);
      readFiles.delete(written);
    }

    // Convert to arrays for prioritization
    const editedArray = Array.from(editedFiles);
    const writtenArray = Array.from(writtenFiles);
    const readArray = Array.from(readFiles);

    // Cap file references, prioritizing edited > written > read
    let paths: string[] = [];

    if (editedArray.length >= MAX_FILE_REFERENCES) {
      paths = editedArray.slice(0, MAX_FILE_REFERENCES);
    } else {
      paths = [...editedArray];
      const remaining = MAX_FILE_REFERENCES - paths.length;

      if (writtenArray.length >= remaining) {
        paths.push(...writtenArray.slice(0, remaining));
      } else {
        paths.push(...writtenArray);
        const stillRemaining = MAX_FILE_REFERENCES - paths.length;
        paths.push(...readArray.slice(0, stillRemaining));
      }
    }

    return {
      paths,
      sources: {
        read: readArray,
        edited: editedArray,
        written: writtenArray,
      },
    };
  }

  /**
   * Emergency truncation - drop old messages without LLM summarization
   *
   * Used when context is critically full (98%+) and we can't afford an LLM call
   * for summarization. Preserves system prompt and recent messages.
   *
   * @param messages - Messages to truncate
   * @returns Truncated message array
   * @throws Error if system prompt alone exceeds target budget (context_size too small)
   */
  private performEmergencyTruncation(messages: readonly Message[]): Message[] {
    const result: Message[] = [];

    // Always preserve system message
    const systemMessage = messages[0]?.role === 'system' ? messages[0] : null;

    // Calculate system prompt tokens FIRST to ensure we have room for messages
    const systemPromptTokens = systemMessage
      ? this.tokenManager.estimateMessageTokens(systemMessage)
      : 0;

    // Target budget for the entire conversation after truncation
    const targetTokens = Math.floor(
      this.tokenManager.getContextSize() * EMERGENCY_TRUNCATION_TARGET_PERCENT / 100
    );

    // Check if system prompt alone exceeds target - this means context_size is too small
    if (systemPromptTokens >= targetTokens) {
      const contextSize = this.tokenManager.getContextSize();
      throw new Error(
        `Context size too small for operation. System prompt (${systemPromptTokens} tokens) ` +
        `exceeds emergency truncation target (${targetTokens} tokens, ${EMERGENCY_TRUNCATION_TARGET_PERCENT}% of ${contextSize}). ` +
        `Increase context_size in your configuration to at least ${Math.ceil(systemPromptTokens / (EMERGENCY_TRUNCATION_TARGET_PERCENT / 100))} tokens.`
      );
    }

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

    // Available budget for non-system messages (subtract system prompt from target)
    const availableForMessages = targetTokens - systemPromptTokens;

    // Start from the end and work backwards, keeping messages until we exceed available budget
    const keptMessages: Message[] = [];
    let totalTokens = 0;

    for (let i = nonEphemeralMessages.length - 1; i >= 0; i--) {
      const msg = nonEphemeralMessages[i]!;
      const msgTokens = this.tokenManager.estimateMessageTokens(msg);

      if (totalTokens + msgTokens > availableForMessages && keptMessages.length > 0) {
        // Would exceed available budget, stop adding more
        break;
      }

      keptMessages.push(msg);
      totalTokens += msgTokens;
    }

    // Reverse once at the end - O(n) instead of O(n²)
    keptMessages.reverse();

    // Add emergency truncation notice with file references
    const droppedCount = nonEphemeralMessages.length - keptMessages.length;
    if (droppedCount > 0) {
      // Extract file references from dropped messages
      const droppedMessages = nonEphemeralMessages.slice(0, nonEphemeralMessages.length - keptMessages.length);
      const fileRefs = this.extractFileReferences(droppedMessages);

      result.push({
        role: 'system',
        content: `CONVERSATION SUMMARY (emergency truncated at ${new Date().toLocaleTimeString()}): ` +
          `${droppedCount} older messages were dropped to free context space. ` +
          `Recent conversation history follows.`,
        metadata: {
          isConversationSummary: true,
          contextFileReferences: fileRefs.paths,
          contextFileSources: {
            read: fileRefs.sources.read,
            edited: fileRefs.sources.edited,
            written: fileRefs.sources.written,
          },
          contextCompactionTimestamp: Date.now(),
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

    // Guard: if we have no messages to actually summarize (e.g., lastUserMessage is first),
    // return unchanged - there's nothing meaningful to compact
    if (messagesToSummarize.length < BUFFER_SIZES.MIN_MESSAGES_TO_SUMMARIZE) {
      logger.debug('[AGENT_COMPACT]', 'Not enough messages to summarize after excluding last user message');
      return [...messages];
    }

    // Build fixed parts of summarization request (system prompt + user request)
    const summarizationSystemContent = `You are summarizing a coding conversation to save context space.

Output format (use this exact structure):

GOAL: [One sentence describing user's objective]

CHANGES MADE:
- /absolute/path/to/file.ts: what changed
- /another/file.py: what changed
[One line per file - be specific about what changed]

ACTIVE BLOCKERS:
- Error/failing test with exact file path and error message
- Unresolved issues that need attention
[Detailed - include stack traces, error messages, line numbers]

DECISIONS:
- User preference or architectural constraint
- Technology choice or approach decision
[Brief - capture what was decided and why]

NEXT STEP: [What was about to happen when compaction triggered]

Requirements:
- Use exact absolute file paths when referencing files
- Omit reasoning chains, exploration attempts, pleasantries
- Be detailed about blockers (include full error messages), brief about completed work
- Omit sections that don't apply (e.g., no ACTIVE BLOCKERS if none exist)
- Target <15% of original conversation length`;

    let finalRequest = 'Summarize the conversation using the exact format specified above.';
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
    const fixedOverhead =
      this.tokenManager.estimateTokens(summarizationSystemContent) +
      this.tokenManager.estimateTokens(finalRequest) +
      SUMMARIZATION_STRUCTURE_OVERHEAD;

    const availableForMessages = maxSummarizationTokens - fixedOverhead;

    // Guard: if budget is too small, fall back to emergency truncation
    if (availableForMessages < MIN_SUMMARIZATION_BUDGET) {
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

    // Validate LLM response - handle error responses and empty content
    if (response.error) {
      throw new Error(`LLM summarization failed: ${response.error_message || 'Unknown error'}`);
    }
    if (!response.content) {
      throw new Error('LLM summarization returned empty response');
    }

    const summary = response.content.trim();

    // Extract file references from summarized messages
    const fileRefs = this.extractFileReferences(messagesToSummarize);

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
          contextFileReferences: fileRefs.paths,
          contextFileSources: {
            read: fileRefs.sources.read,
            edited: fileRefs.sources.edited,
            written: fileRefs.sources.written,
          },
          contextCompactionTimestamp: Date.now(),
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
