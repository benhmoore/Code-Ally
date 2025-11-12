/**
 * ResponseProcessor - Handles LLM response parsing and validation
 *
 * Core responsibilities:
 * - Process LLM responses (text and tool calls)
 * - Handle partial responses and HTTP errors
 * - Validate tool calls and manage retry logic
 * - Process tool execution responses
 * - Handle empty responses with continuation prompts
 *
 * This class extracts response processing logic from Agent to maintain
 * separation of concerns and improve testability.
 */

import { LLMResponse } from '../llm/ModelClient.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { MessageValidator } from './MessageValidator.js';
import { RequiredToolTracker } from './RequiredToolTracker.js';
import { InterruptionManager } from './InterruptionManager.js';
import { ConversationManager } from './ConversationManager.js';
import { Message, ActivityEventType } from '../types/index.js';
import { logger } from '../services/Logger.js';
import { PERMISSION_MESSAGES } from '../config/constants.js';

/**
 * Context needed for processing LLM responses
 */
export interface ResponseContext {
  /** Agent instance ID for logging */
  instanceId: string;
  /** Whether this is a specialized/delegated agent */
  isSpecializedAgent: boolean;
  /** Parent tool call ID (for nested agents) */
  parentCallId?: string;
  /** Base agent prompt (for determining agent type in events) */
  baseAgentPrompt?: string;
  /** Function to generate unique IDs */
  generateId: () => string;
  /** Callback to save session after state changes */
  autoSaveSession: () => void;
  /** Callback to get LLM response for continuations/retries */
  getLLMResponse: () => Promise<LLMResponse>;
  /** Callback to unwrap batch tool calls */
  unwrapBatchToolCalls: (toolCalls: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: Record<string, any> };
  }>) => Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: Record<string, any> };
  }>;
  /** Callback to process tool execution (delegates to ToolOrchestrator) */
  executeToolCalls: (
    toolCalls: Array<{
      id: string;
      type: 'function';
      function: { name: string; arguments: Record<string, any> };
    }>,
    cycles: Map<string, any>
  ) => Promise<Array<{ success: boolean; [key: string]: any }>>;
  /** Callback to detect cycles before tool execution */
  detectCycles: (toolCalls: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: Record<string, any> };
  }>) => Map<string, any>;
  /** Callback to record tool calls for cycle detection */
  recordToolCalls: (
    toolCalls: Array<{
      id: string;
      type: 'function';
      function: { name: string; arguments: Record<string, any> };
    }>,
    results: Array<{ success: boolean; [key: string]: any }>
  ) => void;
  /** Callback to clear cycle detection if pattern broken */
  clearCyclesIfBroken: () => void;
  /** Callback to clear current turn (for redundancy detection) */
  clearCurrentTurn: () => void;
  /** Callback to start tool execution (creates abort controller) */
  startToolExecution: () => void;
  /** Callback to check context usage for specialized agents */
  getContextUsagePercentage: () => number;
  /** Context usage warning threshold */
  contextWarningThreshold: number;
  /** Callback to clean up ephemeral messages */
  cleanupEphemeralMessages: () => void;
}

/**
 * Result of processing an LLM response
 */
export interface ResponseResult {
  /** Final text response to return to caller */
  content: string;
  /** Whether the response was interrupted */
  interrupted?: boolean;
}

/**
 * Processes LLM responses and coordinates validation/retry logic
 */
export class ResponseProcessor {
  constructor(
    private messageValidator: MessageValidator,
    private activityStream: ActivityStream,
    private interruptionManager: InterruptionManager,
    private conversationManager: ConversationManager,
    private requiredToolTracker: RequiredToolTracker
  ) {}

  /**
   * Process LLM response (handles both tool calls and text)
   *
   * This is the main entry point for response processing. It handles:
   * - Partial response continuation (HTTP errors)
   * - Tool call validation with retry logic
   * - Empty response handling
   * - Tool call processing
   * - Text-only response processing
   *
   * NOTE: Interruptions (cancel, interjection, timeout) are handled by Agent.ts
   * before calling this method, as they require Agent-specific state management.
   *
   * @param response - LLM response to process
   * @param context - Processing context with callbacks
   * @param isRetry - Whether this is a retry after empty/error response
   * @returns Final text response
   */
  async processLLMResponse(
    response: LLMResponse,
    context: ResponseContext,
    isRetry: boolean = false
  ): Promise<string> {
    // Note: Interruption handling is done by Agent.ts before calling this method
    // (interjections need response parameter, timeouts need Agent state)

    // GAP 2: Partial response due to HTTP error (mid-stream interruption)
    // Detect partial responses that were interrupted by HTTP 500/503 errors
    // If we have partial content/tool_calls, continue from where we left off
    if (response.error && response.partial && !isRetry) {
      const hasContent = response.content && response.content.trim().length > 0;
      const hasToolCalls = response.tool_calls && response.tool_calls.length > 0;

      if (hasContent || hasToolCalls) {
        logger.debug(`[CONTINUATION] Gap 2: Partial response due to HTTP error - prodding model to continue (content=${hasContent}, toolCalls=${hasToolCalls})`);
        logger.debug('[AGENT_RESPONSE]', context.instanceId, 'Partial response due to HTTP error - attempting continuation');
        logger.debug(`[AGENT_RESPONSE] Partial response details: content=${hasContent}, toolCalls=${hasToolCalls}`);

        // Add the partial assistant response to conversation history
        const assistantMessage: Message = {
          role: 'assistant',
          content: response.content || '',
          tool_calls: response.tool_calls?.map(tc => ({
            id: tc.id,
            type: 'function' as const,
            function: {
              name: tc.function.name,
              arguments: tc.function.arguments,
            },
          })),
          thinking: response.thinking,
          timestamp: Date.now(),
        };
        this.conversationManager.addMessage(assistantMessage);

        // Add continuation prompt mentioning the error
        const continuationPrompt: Message = {
          role: 'user',
          content: `<system-reminder>\nYour previous response encountered an error and was interrupted: ${response.error_message || 'Unknown error'}. Please continue where you left off.\n</system-reminder>`,
          timestamp: Date.now(),
        };
        this.conversationManager.addMessage(continuationPrompt);

        // Check for interruption before requesting continuation
        if (this.interruptionManager.isInterrupted()) {
          logger.debug('[AGENT_RESPONSE]', context.instanceId, 'Agent interrupted before partial HTTP error continuation - stopping');
          this.interruptionManager.markRequestAsInterrupted();
          return PERMISSION_MESSAGES.USER_FACING_INTERRUPTION;
        }

        // Get continuation from LLM
        logger.debug('[AGENT_RESPONSE]', context.instanceId, 'Requesting continuation after partial HTTP error response...');
        const continuationResponse = await context.getLLMResponse();

        // Process continuation (mark as retry to prevent infinite loop)
        return await this.processLLMResponse(continuationResponse, context, true);
      }
    }

    // GAP 3: Tool call validation errors
    // Detect validation errors where tool calls are malformed (missing function name, invalid JSON, etc.)
    // Add assistant's response with malformed calls to history and request continuation with error details
    const validationResult = this.messageValidator.validate(response, isRetry);

    if (!validationResult.isValid && !isRetry) {
      // Log the validation attempt
      this.messageValidator.logAttempt(validationResult.errors);

      // Check if we've exceeded the max validation attempts
      if (validationResult.maxAttemptsExceeded) {
        // Reset counter for next request
        this.messageValidator.reset();

        // Return error message to user
        return this.messageValidator.createMaxAttemptsError(validationResult.errors);
      }

      // Add the assistant's response with malformed tool calls to conversation history
      const assistantMessage: Message = {
        role: 'assistant',
        content: response.content || '',
        tool_calls: response.tool_calls?.map(tc => ({
          id: tc.id,
          type: 'function' as const,
          function: {
            name: tc.function.name,
            arguments: tc.function.arguments,
          },
        })),
        thinking: response.thinking,
        timestamp: Date.now(),
      };
      this.conversationManager.addMessage(assistantMessage);

      // Add continuation prompt with validation error details
      const continuationPrompt = this.messageValidator.createValidationRetryMessage(validationResult.errors);
      this.conversationManager.addMessage(continuationPrompt);

      // Check for interruption before requesting continuation
      if (this.interruptionManager.isInterrupted()) {
        logger.debug('[AGENT_RESPONSE]', context.instanceId, 'Agent interrupted before validation error continuation - stopping');
        this.interruptionManager.markRequestAsInterrupted();
        return PERMISSION_MESSAGES.USER_FACING_INTERRUPTION;
      }

      // Get continuation from LLM
      logger.debug('[AGENT_RESPONSE]', context.instanceId, 'Requesting continuation after validation errors...');
      const continuationResponse = await context.getLLMResponse();

      // Process continuation (mark as retry to prevent infinite loop)
      return await this.processLLMResponse(continuationResponse, context, true);
    }

    // Check for error (non-partial, non-validation errors)
    if (response.error && !response.partial && !response.tool_call_validation_failed) {
      return response.content || 'An error occurred';
    }

    // Extract tool calls
    const toolCalls = response.tool_calls || [];
    const content = response.content || '';

    // Log LLM response to trace tool call origins
    logger.debug('[AGENT] LLM response - hasContent:', !!response.content, 'toolCallCount:', toolCalls.length);
    if (toolCalls.length > 0) {
      logger.debug('[AGENT] Tool calls from LLM:');
      toolCalls.forEach((tc, idx) => {
        logger.debug(`  [${idx}] ${tc.function.name}(${JSON.stringify(tc.function.arguments)}) id:${tc.id}`);
      });
    }

    // GAP 1: Truly empty response (no content AND no tool calls)
    // Detect when the model provides neither text nor tool calls
    // Note: Empty content WITH tool calls is valid - the model can directly call tools
    if (!content.trim() && toolCalls.length === 0 && !isRetry) {
      logger.debug('[CONTINUATION] Gap 1: Truly empty response (no content, no tools) - prodding model to continue');
      logger.debug('[AGENT_RESPONSE]', context.instanceId, 'Truly empty response (no content, no tools) - attempting continuation');

      // First, add the assistant's empty response to conversation history
      // This allows the model to see it provided nothing and should continue
      const assistantMessage: Message = {
        role: 'assistant',
        content: '', // Truly empty - no content, no tool calls
        // No tool_calls since toolCalls.length === 0
        thinking: response.thinking,
        timestamp: Date.now(),
      };
      this.conversationManager.addMessage(assistantMessage);

      // Add generic continuation prompt
      const continuationPrompt: Message = {
        role: 'user',
        content: '<system-reminder>\nYour response appears incomplete. Please continue where you left off.\n</system-reminder>',
        timestamp: Date.now(),
      };
      this.conversationManager.addMessage(continuationPrompt);

      // Check for interruption before requesting continuation
      if (this.interruptionManager.isInterrupted()) {
        logger.debug('[AGENT_RESPONSE]', context.instanceId, 'Agent interrupted before empty response continuation - stopping');
        this.interruptionManager.markRequestAsInterrupted();
        return PERMISSION_MESSAGES.USER_FACING_INTERRUPTION;
      }

      // Get continuation from LLM
      logger.debug('[AGENT_RESPONSE]', context.instanceId, 'Requesting continuation after truly empty response...');
      const continuationResponse = await context.getLLMResponse();

      // Process continuation (mark as retry to prevent infinite loop)
      return await this.processLLMResponse(continuationResponse, context, true);
    }

    if (toolCalls.length > 0) {
      // Check for interruption before processing tools
      if (this.interruptionManager.isInterrupted()) {
        return PERMISSION_MESSAGES.USER_FACING_INTERRUPTION;
      }
      // Reset validation counter on successful response with tool calls
      this.messageValidator.reset();
      // Response contains tool calls
      return await this.processToolResponse(response, toolCalls, context);
    } else {
      // Reset validation counter on successful text-only response
      this.messageValidator.reset();
      // Text-only response
      return await this.processTextResponse(response, context, isRetry);
    }
  }


  /**
   * Process a response that contains tool calls
   *
   * @param response - LLM response with tool calls
   * @param toolCalls - Parsed tool calls
   * @param context - Processing context
   * @returns Final response after tool execution and follow-up
   */
  async processToolResponse(
    response: LLMResponse,
    toolCalls: Array<{
      id: string;
      type: 'function';
      function: { name: string; arguments: Record<string, any> };
    }>,
    context: ResponseContext
  ): Promise<string> {
    logger.debug('[AGENT_CONTEXT]', context.instanceId, 'Processing tool response with', toolCalls.length, 'tool calls');

    // Unwrap batch calls before adding to conversation
    // This ensures the conversation history matches what was actually executed
    const unwrappedToolCalls = context.unwrapBatchToolCalls(toolCalls);
    logger.debug('[AGENT_CONTEXT]', context.instanceId, 'After unwrapping:', unwrappedToolCalls.length, 'tool calls');

    // Add assistant message with unwrapped tool calls to history
    const toolCallsForMessage = unwrappedToolCalls.map(tc => ({
      id: tc.id,
      type: 'function' as const,
      function: {
        name: tc.function.name,
        arguments: tc.function.arguments,
      },
    }));

    const assistantMessage: Message = {
      role: 'assistant',
      content: response.content || '',
      tool_calls: toolCallsForMessage,
      thinking: response.thinking,
      timestamp: Date.now(),
    };
    this.conversationManager.addMessage(assistantMessage);

    // Auto-save after assistant message with tool calls
    context.autoSaveSession();

    logger.debug('[AGENT_CONTEXT]', context.instanceId, 'Assistant message with tool calls added. Total messages:', this.conversationManager.getMessageCount());

    // Check context usage for specialized agents (subagents)
    // Enforce stricter limit (WARNING threshold) to ensure room for final summary
    const contextUsage = context.getContextUsagePercentage();
    if (context.isSpecializedAgent && contextUsage >= context.contextWarningThreshold) {
      logger.debug('[AGENT_CONTEXT]', context.instanceId, 'Specialized agent at', contextUsage + '% context - blocking tool execution to preserve space for summary');

      // Remove the assistant message with tool calls we just added
      this.conversationManager.getMessages().slice(0, -1);
      this.conversationManager.setMessages(this.conversationManager.getMessages().slice(0, -1));

      // Add a system reminder instructing the agent to provide final summary
      const systemReminder: Message = {
        role: 'system',
        content: '<system-reminder>\n' +
          `Context usage at ${contextUsage}% - too high for specialized agent to execute more tools. ` +
          'You MUST provide your final summary now. Do NOT request any more tool calls. ' +
          'Summarize your work, findings, and recommendations based on the information you have gathered.\n' +
          '</system-reminder>',
        timestamp: Date.now(),
      };
      this.conversationManager.addMessage(systemReminder);

      // Check for interruption before requesting final summary
      if (this.interruptionManager.isInterrupted()) {
        logger.debug('[AGENT_CONTEXT]', context.instanceId, 'Agent interrupted before final summary - stopping');
        this.interruptionManager.markRequestAsInterrupted();
        return PERMISSION_MESSAGES.USER_FACING_INTERRUPTION;
      }

      // Get final response from LLM (without executing tools)
      logger.debug('[AGENT_CONTEXT]', context.instanceId, 'Requesting final summary from specialized agent...');
      const finalResponse = await context.getLLMResponse();

      return await this.processLLMResponse(finalResponse, context);
    }

    // Detect cycles BEFORE executing tools
    const cycles = context.detectCycles(unwrappedToolCalls);
    if (cycles.size > 0) {
      logger.debug('[AGENT_CYCLE_DETECTION]', context.instanceId, `Detected ${cycles.size} potential cycles`);
    }

    // Execute tool calls via orchestrator (pass original calls for unwrapping)
    logger.debug('[AGENT_CONTEXT]', context.instanceId, 'Executing tool calls via orchestrator...');

    // Start tool execution and create abort controller
    context.startToolExecution();

    let toolResults: Array<{ success: boolean; [key: string]: any }> | undefined;

    // Execute tool calls and let any errors (including permission denied) propagate to Agent.ts
    toolResults = await context.executeToolCalls(toolCalls, cycles);
    logger.debug('[AGENT_CONTEXT]', context.instanceId, 'Tool calls completed. Total messages now:', this.conversationManager.getMessageCount());

    // Check if agent was interrupted during tool execution
    if (this.interruptionManager.isInterrupted()) {
      logger.debug('[AGENT_CONTEXT]', context.instanceId, 'Agent interrupted during tool execution - stopping follow-up');
      this.interruptionManager.markRequestAsInterrupted();
      return PERMISSION_MESSAGES.USER_FACING_INTERRUPTION;
    }

    // Add tool calls to history for cycle detection (AFTER execution)
    // Pass results to enable search hit rate tracking
    console.log('[PATTERN-DETECTION] Recording', toolResults.length, 'tool results for cycle detection');
    context.recordToolCalls(unwrappedToolCalls, toolResults);

    // Check if cycle pattern is broken (3 consecutive different calls)
    context.clearCyclesIfBroken();

    // Track required tool calls
    if (this.requiredToolTracker.hasRequiredTools()) {
      logger.debug(`[REQUIRED_TOOLS_DEBUG] Checking ${unwrappedToolCalls.length} tool calls for required tools`);
      unwrappedToolCalls.forEach(tc => {
        logger.debug(`[REQUIRED_TOOLS_DEBUG] Tool executed: ${tc.function.name}`);
        if (this.requiredToolTracker.markCalled(tc.function.name)) {
          logger.debug(`[REQUIRED_TOOLS_DEBUG] ✓ Tracked required tool call: ${tc.function.name}`);
          logger.debug(`[REQUIRED_TOOLS_DEBUG] Called so far:`, this.requiredToolTracker.getCalledTools());
        }
      });
    }

    // Clear current turn (for redundancy detection)
    context.clearCurrentTurn();

    // Check if agent was interrupted before requesting follow-up
    if (this.interruptionManager.isInterrupted()) {
      logger.debug('[AGENT_CONTEXT]', context.instanceId, 'Agent interrupted before follow-up LLM call - stopping');
      this.interruptionManager.markRequestAsInterrupted();
      return PERMISSION_MESSAGES.USER_FACING_INTERRUPTION;
    }

    // Get follow-up response from LLM
    logger.debug('[AGENT_CONTEXT]', context.instanceId, 'Getting follow-up response from LLM...');
    const followUpResponse = await context.getLLMResponse();

    // Recursively process the follow-up (it might contain more tool calls)
    return await this.processLLMResponse(followUpResponse, context);
  }

  /**
   * Process a text-only response (no tool calls)
   *
   * @param response - LLM response with text content
   * @param context - Processing context
   * @param isRetry - Whether this is a retry after empty response
   * @returns The text content
   */
  async processTextResponse(
    response: LLMResponse,
    context: ResponseContext,
    isRetry: boolean = false
  ): Promise<string> {
    // Validate that we have actual content
    const content = response.content || '';

    // Check if all required tool calls have been executed before allowing agent to exit
    // IMPORTANT: This check must happen BEFORE any fallback/retry logic to ensure required tools are always enforced
    if (this.requiredToolTracker.hasRequiredTools() && !this.interruptionManager.isInterrupted()) {
      logger.debug(`[REQUIRED_TOOLS_DEBUG] Agent attempting to exit with text response`);
      logger.debug(`[REQUIRED_TOOLS_DEBUG] Required tools:`, this.requiredToolTracker.getRequiredTools());
      logger.debug(`[REQUIRED_TOOLS_DEBUG] Called tools:`, this.requiredToolTracker.getCalledTools());

      const result = this.requiredToolTracker.checkAndWarn();
      logger.debug(`[REQUIRED_TOOLS_DEBUG] Missing tools:`, result.missingTools);

      if (result.shouldFail) {
        // Exceeded max warnings - fail the operation
        const errorMessage = this.requiredToolTracker.createFailureMessage(result.missingTools);
        logger.debug(`[REQUIRED_TOOLS_DEBUG] ✗ FAILING - exceeded max warnings (${result.warningCount}/${result.maxWarnings})`);
        logger.debug(`[REQUIRED_TOOLS_DEBUG] Error message:`, errorMessage);
        logger.error('[AGENT_REQUIRED_TOOLS]', context.instanceId, errorMessage);

        const assistantMessage: Message = {
          role: 'assistant',
          content: `[Error: ${errorMessage}]`,
          timestamp: Date.now(),
        };
        this.conversationManager.addMessage(assistantMessage);
        context.autoSaveSession();

        return `[Error: ${errorMessage}]`;
      }

      if (result.shouldWarn) {
        // Send reminder to call required tools
        logger.debug(`[REQUIRED_TOOLS_DEBUG] ⚠ ISSUING WARNING ${result.warningCount}/${result.maxWarnings}`);
        logger.debug(`[REQUIRED_TOOLS_DEBUG] Sending reminder to call: ${result.missingTools.join(', ')}`);

        const reminderMessage = this.requiredToolTracker.createWarningMessage(result.missingTools);
        this.requiredToolTracker.setWarningMessageIndex(this.conversationManager.getMessageCount()); // Track index before push
        this.conversationManager.addMessage(reminderMessage);

        // Check for interruption before requesting required tools
        if (this.interruptionManager.isInterrupted()) {
          logger.debug('[AGENT_REQUIRED_TOOLS]', context.instanceId, 'Agent interrupted before required tools retry - stopping');
          this.interruptionManager.markRequestAsInterrupted();
          return PERMISSION_MESSAGES.USER_FACING_INTERRUPTION;
        }

        // Get new response from LLM
        logger.debug('[AGENT_REQUIRED_TOOLS]', context.instanceId, 'Requesting LLM to call required tools...');
        const retryResponse = await context.getLLMResponse();

        // Recursively process the response
        return await this.processLLMResponse(retryResponse, context);
      }

      // All required tools have been called
      if (this.requiredToolTracker.areAllCalled()) {
        logger.debug(`[REQUIRED_TOOLS_DEBUG] ✓ SUCCESS - All required tools have been called`);
        logger.debug('[AGENT_REQUIRED_TOOLS]', context.instanceId, 'All required tools have been called:', this.requiredToolTracker.getCalledTools());

        // Remove the warning message from history if it exists
        const warningIndex = this.requiredToolTracker.getWarningMessageIndex();
        if (warningIndex >= 0 && warningIndex < this.conversationManager.getMessageCount()) {
          const messages = this.conversationManager.getMessages();
          const warningMessage = messages[warningIndex];
          if (warningMessage && warningMessage.role === 'system' && warningMessage.content.includes('must call the following required tool')) {
            logger.debug(`[REQUIRED_TOOLS_DEBUG] Removing satisfied warning from conversation history at index ${warningIndex}`);
            messages.splice(warningIndex, 1);
            this.conversationManager.setMessages(messages);
            this.requiredToolTracker.clearWarningMessageIndex();
          }
        }
      }
    }

    // Handle empty content - attempt continuation if appropriate
    if (!content.trim() && !isRetry) {
      // Check if previous message had tool calls (indicates we're in follow-up after tools)
      const lastMessage = this.conversationManager.getLastMessage();
      const isAfterToolExecution = lastMessage?.role === 'assistant' && lastMessage?.tool_calls && lastMessage.tool_calls.length > 0;

      if (isAfterToolExecution) {
        logger.debug('[AGENT_RESPONSE]', context.instanceId, 'Empty response after tool execution - attempting continuation');
        logger.debug(`[AGENT_RESPONSE] Empty response after ${lastMessage.tool_calls?.length || 0} tool calls`);

        // Add continuation prompt
        const continuationPrompt: Message = {
          role: 'user',
          content: '<system-reminder>\nYou just executed tool calls but did not provide any response. Please provide your response now based on the tool results.\n</system-reminder>',
          timestamp: Date.now(),
        };
        this.conversationManager.addMessage(continuationPrompt);

        // Check for interruption before requesting continuation
        if (this.interruptionManager.isInterrupted()) {
          logger.debug('[AGENT_RESPONSE]', context.instanceId, 'Agent interrupted before empty after tools continuation - stopping');
          this.interruptionManager.markRequestAsInterrupted();
          return PERMISSION_MESSAGES.USER_FACING_INTERRUPTION;
        }

        // Get continuation from LLM
        logger.debug('[AGENT_RESPONSE]', context.instanceId, 'Requesting continuation after empty response...');
        const retryResponse = await context.getLLMResponse();

        // Process retry (mark as retry to prevent infinite loop)
        return await this.processLLMResponse(retryResponse, context, true);
      } else {
        // Empty response but not after tool execution - just log debug
        logger.debug('[AGENT_RESPONSE]', context.instanceId, 'Model returned empty content');
      }
    } else if (!content.trim() && isRetry) {
      // Still empty after continuation attempt - use fallback
      logger.error('[AGENT_RESPONSE]', context.instanceId, 'Still empty after continuation attempt - using fallback message');
      const fallbackContent = context.isSpecializedAgent
        ? 'Task completed. Tool results are available in the conversation history.'
        : 'I apologize, but I encountered an issue generating a response. The requested operations have been completed.';

      const assistantMessage: Message = {
        role: 'assistant',
        content: fallbackContent,
        timestamp: Date.now(),
      };
      this.conversationManager.addMessage(assistantMessage);

      // Clean up ephemeral messages BEFORE auto-save
      context.cleanupEphemeralMessages();

      context.autoSaveSession();

      this.emitEvent({
        id: context.generateId(),
        type: ActivityEventType.AGENT_END,
        timestamp: Date.now(),
        data: {
          content: fallbackContent,
          isSpecializedAgent: context.isSpecializedAgent,
          instanceId: context.instanceId,
          agentName: context.baseAgentPrompt ? 'specialized' : 'main',
        },
      });

      return fallbackContent;
    }

    // Normal path - we have content and all required tools (if any) have been called
    const assistantMessage: Message = {
      role: 'assistant',
      content: content,
      timestamp: Date.now(),
    };
    this.conversationManager.addMessage(assistantMessage);

    // Clean up ephemeral messages BEFORE auto-save
    // This ensures ephemeral content doesn't persist in session files
    context.cleanupEphemeralMessages();

    // Auto-save after text response
    context.autoSaveSession();

    // Emit completion event
    this.emitEvent({
      id: context.generateId(),
      type: ActivityEventType.AGENT_END,
      timestamp: Date.now(),
      data: {
        content: content,
        isSpecializedAgent: context.isSpecializedAgent,
        instanceId: context.instanceId,
        agentName: context.baseAgentPrompt ? 'specialized' : 'main',
      },
    });

    return content;
  }

  /**
   * Emit an activity event
   */
  private emitEvent(event: any): void {
    this.activityStream.emit(event);
  }
}
