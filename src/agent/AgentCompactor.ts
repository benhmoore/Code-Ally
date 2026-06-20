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
import { parseToolCallArguments } from '../llm/FunctionCalling.js';
import path from 'path';

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
 * Estimated token overhead for summarization request structure.
 * Accounts for message framing (system + user + response structure).
 */
const SUMMARIZATION_STRUCTURE_OVERHEAD = 12;

/**
 * Minimum transcript budget worth attempting after fixed summarization prompt
 * overhead is accounted for.
 */
const MIN_TRANSCRIPT_BUDGET = 500;

/**
 * Minimum budget for an excerpt of a single oversized message.
 */
const MIN_MESSAGE_EXCERPT_BUDGET = 80;

type CompactionVerification = 'below-threshold' | 'reduced';

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

export interface ApplyCompactionOptions extends CompactionOptions {
  /** Emit COMPACTION_START / COMPACTION_COMPLETE events (default: true) */
  emitEvents?: boolean;
  /** Force emergency truncation instead of LLM summarization */
  forceEmergency?: boolean;
  /** How to verify the resulting compacted history */
  verification?: CompactionVerification;
}

export interface AppliedCompactionResult {
  compactedMessages: Message[];
  oldContextUsage: number;
  newContextUsage: number;
  oldTokenCount: number;
  newTokenCount: number;
  threshold: number;
  noticeTimestamp: number;
  wasEmergencyFallback?: boolean;
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
    if (this.isCompacting) {
      logger.debug('[AGENT_AUTO_COMPACT]', context.instanceId, 'Skipping - compaction already in progress');
      return false;
    }

    if (typeof this.tokenManager.getContextUsagePercentage !== 'function') {
      return false;
    }

    const contextUsage = this.tokenManager.getContextUsagePercentage();
    const threshold = context.compactThreshold || CONTEXT_THRESHOLDS.CRITICAL;

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

    await this.compactAndApply(context, {
      preserveLastUserMessage: true,
      timestampLabel: 'auto-compacted',
      forceEmergency: contextUsage >= CONTEXT_THRESHOLDS.EMERGENCY,
      verification: 'below-threshold',
    });

    return true;
  }

  /**
   * Compact the current conversation, apply it to the ConversationManager,
   * update token accounting, verify the result, and emit UI events.
   *
   * This is the shared mutation path for both auto-compaction and manual
   * /compact so their behavior cannot drift.
   */
  async compactAndApply(
    context: CompactionContext,
    options: ApplyCompactionOptions = {}
  ): Promise<AppliedCompactionResult> {
    if (this.isCompacting) {
      throw new Error('Compaction already in progress');
    }

    const threshold = context.compactThreshold || CONTEXT_THRESHOLDS.CRITICAL;
    const emitEvents = options.emitEvents !== false;
    const verification = options.verification ?? 'below-threshold';

    this.tokenManager.updateTokenCount(this.conversationManager.getMessages());
    const oldContextUsage = this.tokenManager.getContextUsagePercentage();
    const oldTokenCount = this.tokenManager.getCurrentTokenCount();

    this.isCompacting = true;
    let compactionStarted = false;

    try {
      if (emitEvents) {
        this.emitEvent({
          id: context.generateId(),
          type: ActivityEventType.COMPACTION_START,
          timestamp: Date.now(),
          data: {
            parentId: context.parentCallId,
          },
        });
        compactionStarted = true;
      }

      let compacted: Message[];
      let wasEmergencyFallback = false;

      if (options.forceEmergency) {
        logger.debug('[AGENT_AUTO_COMPACT]', context.instanceId,
          `Emergency truncation at ${oldContextUsage}% - skipping LLM summarization`);
        compacted = this.performEmergencyTruncation(
          this.conversationManager.getMessages()
        );
      } else {
        try {
          compacted = await this.compactConversation(
            this.conversationManager.getMessages(),
            options
          );
        } catch (error) {
          logger.debug('[AGENT_AUTO_COMPACT]', context.instanceId, 'Compaction failed:', error);
          logger.debug('[AGENT_AUTO_COMPACT]', context.instanceId, 'Attempting emergency truncation fallback');
          compacted = this.performEmergencyTruncation(
            this.conversationManager.getMessages()
          );
          wasEmergencyFallback = true;
        }
      }

      // Validate compaction result
      if (compacted.length === 0) {
        logger.debug('[AGENT_AUTO_COMPACT]', context.instanceId, 'Compaction produced empty result');
        throw new Error('Compaction produced empty result');
      }

      let newTokenCount = this.estimateMessagesTokenCount(compacted);
      let newContextUsage = this.contextUsagePercentageFor(newTokenCount);

      if (verification === 'below-threshold' && newContextUsage >= threshold) {
        const contextSize = this.tokenManager.getContextSize();
        throw new Error(
          `Compaction did not reduce context usage meaningfully (${oldContextUsage}% -> ${newContextUsage}%). ` +
          `Context size (${contextSize} tokens) is too small for the current system prompt. ` +
          `Increase context_size in your configuration.`
        );
      }

      if (verification === 'reduced' && newTokenCount >= oldTokenCount) {
        throw new Error(
          `Compaction did not reduce token usage (${oldTokenCount} -> ${newTokenCount} tokens).`
        );
      }

      // Apply only after verification succeeds, so a failed compaction leaves
      // the active conversation untouched.
      this.conversationManager.setMessages(compacted);
      this.tokenManager.updateTokenCount(this.conversationManager.getMessages());

      newContextUsage = this.tokenManager.getContextUsagePercentage();
      newTokenCount = this.tokenManager.getCurrentTokenCount();

      // Get the last message's timestamp to place notice before it
      // Find the last non-system message timestamp
      const lastMessageTimestamp = this.conversationManager.getMessages()
        .filter(m => m.role !== 'system')
        .reduce((latest, msg) => Math.max(latest, msg.timestamp || 0), 0);

      // Place compaction notice right before the last message (timestamp - 1)
      const noticeTimestamp = lastMessageTimestamp > 0 ? lastMessageTimestamp - 1 : Date.now();

      if (emitEvents) {
        this.emitEvent({
          id: context.generateId(),
          type: ActivityEventType.COMPACTION_COMPLETE,
          timestamp: noticeTimestamp,
          data: {
            parentId: context.parentCallId,
            oldContextUsage,
            newContextUsage,
            threshold,
            compactedMessages: this.conversationManager.getMessages(),
            ...(wasEmergencyFallback ? { wasEmergencyFallback: true } : {}),
          },
        });
      }

      logger.debug('[AGENT_AUTO_COMPACT]', context.instanceId, `Compaction complete - Context now at ${newContextUsage}%`);
      return {
        compactedMessages: this.conversationManager.getMessagesCopy(),
        oldContextUsage,
        newContextUsage,
        oldTokenCount,
        newTokenCount,
        threshold,
        noticeTimestamp,
        ...(wasEmergencyFallback ? { wasEmergencyFallback: true } : {}),
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Check if this is a "context too small" error - these are unrecoverable
      if (errorMessage.includes('Context size too small') || errorMessage.includes('did not reduce context')) {
        // Use debug instead of error: error is communicated via throw + activity events.
        // logger.error uses console.error (stderr) which leaks into the TUI outside agent display.
        logger.debug('[AGENT_AUTO_COMPACT]', context.instanceId, 'Context size too small:', errorMessage);

        // Emit error completion to unstick UI before re-throwing
        if (emitEvents && compactionStarted) {
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

      logger.debug('[AGENT_AUTO_COMPACT]', context.instanceId, 'Compaction failed:', error);

      if (emitEvents && compactionStarted) {
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

      throw error;
    } finally {
      // Always reset guard flag
      this.isCompacting = false;
    }
  }

  private normalizeFileReference(filePath: unknown): string | null {
    if (typeof filePath !== 'string') {
      return null;
    }

    const trimmed = filePath.trim();
    if (!trimmed) {
      return null;
    }

    return path.normalize(path.isAbsolute(trimmed) ? trimmed : path.resolve(process.cwd(), trimmed));
  }

  private estimateMessagesTokenCount(messages: readonly Message[]): number {
    return messages.reduce((total, message) => total + this.tokenManager.estimateMessageTokens(message), 0);
  }

  private contextUsagePercentageFor(tokenCount: number): number {
    const contextSize = this.tokenManager.getContextSize();
    if (contextSize === 0) {
      return 0;
    }

    return Math.min(100, Math.floor((tokenCount / contextSize) * 100));
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

    const addPath = (target: Set<string>, filePath: unknown) => {
      const normalized = this.normalizeFileReference(filePath);
      if (normalized) {
        target.add(normalized);
      }
    };

    for (const message of messages) {
      // Extract from assistant tool calls
      if (message.role === 'assistant' && message.tool_calls) {
        for (const toolCall of message.tool_calls) {
          const toolName = toolCall.function.name;
          const args = parseToolCallArguments(toolCall.function.arguments as any);

          if (toolName === 'read' && args.file_paths && Array.isArray(args.file_paths)) {
            // Read tool uses file_paths array
            for (const filePath of args.file_paths) {
              addPath(readFiles, filePath);
            }
          } else if (toolName === 'read') {
            // Be tolerant of older sessions/tests that used a singular path key.
            addPath(readFiles, args.file_path ?? args.path);
          } else if ((toolName === 'edit' || toolName === 'line-edit') && args.file_path && typeof args.file_path === 'string') {
            // Edit and line-edit tools use file_path string
            addPath(editedFiles, args.file_path);
          } else if (toolName === 'write' && args.file_path && typeof args.file_path === 'string') {
            // Write tool uses file_path string
            addPath(writtenFiles, args.file_path);
          }
        }
      }

      // Extract from user message mentions
      if (message.role === 'user' && message.metadata?.mentions?.files) {
        for (const filePath of message.metadata.mentions.files) {
          addPath(readFiles, filePath);
        }
      }
    }

    // Deduplicate by priority: edited > written > read.
    for (const edited of editedFiles) {
      writtenFiles.delete(edited);
      readFiles.delete(edited);
    }
    for (const written of writtenFiles) {
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

  private formatMessageForSummary(message: Message, index: number): string {
    const labels = [`Message ${index + 1}`, message.role.toUpperCase()];
    if (message.name) {
      labels.push(message.name);
    }
    if (message.tool_call_id) {
      labels.push(`tool_call_id=${message.tool_call_id}`);
    }
    if (message.metadata?.isConversationSummary) {
      labels.push('conversation-summary');
    }

    const lines = [`### ${labels.join(' | ')}`];
    const content = message.content?.trim();
    lines.push(content ? content : '(empty content)');

    if (message.images?.length) {
      lines.push(`[${message.images.length} image(s) attached]`);
    }

    if (message.tool_calls?.length) {
      lines.push('Tool calls:');
      for (const toolCall of message.tool_calls) {
        const args = parseToolCallArguments(toolCall.function.arguments as any);
        lines.push(`- ${toolCall.id}: ${toolCall.function.name} ${JSON.stringify(args)}`);
      }
    }

    return lines.join('\n');
  }

  private truncateTextToTokenBudget(text: string, maxTokens: number): string {
    if (maxTokens <= 0 || !text) {
      return '';
    }

    if (this.tokenManager.estimateTokens(text) <= maxTokens) {
      return text;
    }

    const marker = '\n\n[... omitted middle content to fit compaction budget ...]\n\n';
    if (this.tokenManager.estimateTokens(marker) >= maxTokens) {
      return '[... omitted content ...]';
    }

    let low = 0;
    let high = text.length;
    let best = marker.trim();

    while (low <= high) {
      const keepChars = Math.floor((low + high) / 2);
      const headChars = Math.ceil(keepChars * 0.6);
      const tailChars = keepChars - headChars;
      const candidate = `${text.slice(0, headChars)}${marker}${tailChars > 0 ? text.slice(text.length - tailChars) : ''}`;
      const candidateTokens = this.tokenManager.estimateTokens(candidate);

      if (candidateTokens <= maxTokens) {
        best = candidate;
        low = keepChars + 1;
      } else {
        high = keepChars - 1;
      }
    }

    return best;
  }

  private buildTranscriptWithinBudget(
    messages: readonly Message[],
    tokenBudget: number
  ): { transcript: string; selectedCount: number; omittedCount: number } {
    const selectedSections: string[] = [];
    let usedTokens = 0;
    let omittedCount = 0;

    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]!;
      const section = this.formatMessageForSummary(msg, i);
      const sectionTokens = this.tokenManager.estimateTokens(section);
      const remainingBudget = tokenBudget - usedTokens;

      if (remainingBudget <= 0) {
        omittedCount = i + 1;
        break;
      }

      if (sectionTokens <= remainingBudget) {
        selectedSections.unshift(section);
        usedTokens += sectionTokens;
        continue;
      }

      if (selectedSections.length === 0 || remainingBudget >= MIN_MESSAGE_EXCERPT_BUDGET) {
        const excerpt = this.truncateTextToTokenBudget(section, remainingBudget);
        if (excerpt.trim()) {
          selectedSections.unshift(excerpt);
          usedTokens += this.tokenManager.estimateTokens(excerpt);
          omittedCount = i;
        } else {
          omittedCount = i + 1;
        }
      } else {
        omittedCount = i + 1;
      }
      break;
    }

    let transcript = selectedSections.join('\n\n');
    if (omittedCount > 0) {
      const omissionPrefix = `[${omittedCount} older message(s) omitted because the compaction input budget was limited.]\n\n`;
      const remainingBudget = tokenBudget - this.tokenManager.estimateTokens(omissionPrefix);
      transcript = `${omissionPrefix}${remainingBudget > 0 ? this.truncateTextToTokenBudget(transcript, remainingBudget) : ''}`;
    }

    return {
      transcript,
      selectedCount: selectedSections.length,
      omittedCount,
    };
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
    const messagesToSummarize = lastUserMessage
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

    let finalRequest = 'Summarize the conversation transcript using the exact format specified above.';
    if (customInstructions) {
      finalRequest += ` Additional instructions: ${customInstructions}`;
    }
    if (lastUserMessage) {
      const currentRequest = this.truncateTextToTokenBudget(
        lastUserMessage.content,
        Math.max(200, Math.floor(this.tokenManager.getContextSize() * 0.05))
      );
      finalRequest += `\n\nThe user's current request is: "${currentRequest}"`;
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
    if (availableForMessages < MIN_TRANSCRIPT_BUDGET) {
      logger.debug('[AGENT_COMPACT]', 'Budget too small for summarization, using emergency truncation');
      return this.performEmergencyTruncation(messages);
    }

    const transcriptResult = this.buildTranscriptWithinBudget(messagesToSummarize, availableForMessages);
    if (!transcriptResult.transcript.trim() || transcriptResult.selectedCount === 0) {
      logger.debug('[AGENT_COMPACT]', 'Transcript budget produced no summarizable content, using emergency truncation');
      return this.performEmergencyTruncation(messages);
    }

    if (transcriptResult.omittedCount > 0) {
      logger.debug('[AGENT_COMPACT]',
        `Summarization transcript omitted ${transcriptResult.omittedCount} older message(s) to fit budget`);
    }

    const summarizationRequest: Message[] = [
      {
        role: 'system',
        content: summarizationSystemContent,
      },
      {
        role: 'user',
        content:
          `Conversation transcript to summarize:\n\n${transcriptResult.transcript}\n\n${finalRequest}`,
      },
    ];

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

    // Extract file references from all messages being compacted away, including
    // older messages omitted from the bounded summarization transcript.
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
