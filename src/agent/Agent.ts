/**
 * Agent - Main orchestrator for LLM conversation and tool execution
 *
 * Core responsibilities:
 * - Manages conversation message history
 * - Sends messages to LLM with function definitions
 * - Parses tool calls from LLM responses
 * - Orchestrates tool execution (via ToolOrchestrator)
 * - Emits events via ActivityStream for UI updates
 * - Handles follow-up responses after tool execution
 *
 * Based on Python implementation patterns adapted for TypeScript/async.
 */

import { ModelClient, LLMResponse } from '../llm/ModelClient.js';
import { ToolManager } from '../tools/ToolManager.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { ServiceRegistry } from '../services/ServiceRegistry.js';
import { ToolOrchestrator } from './ToolOrchestrator.js';
import { TokenManager } from './TokenManager.js';
import { ToolResultManager } from '../services/ToolResultManager.js';
import { ConfigManager } from '../services/ConfigManager.js';
import { PermissionManager } from '../security/PermissionManager.js';
import { Message, ActivityEventType, Config } from '../types/index.js';
import { logger } from '../services/Logger.js';
import { formatError } from '../utils/errorUtils.js';
import { POLLING_INTERVALS, TEXT_LIMITS, BUFFER_SIZES } from '../config/constants.js';
import { CONTEXT_THRESHOLDS, TOOL_NAMES } from '../config/toolDefaults.js';

export interface AgentConfig {
  /** Whether this is a specialized/delegated agent */
  isSpecializedAgent?: boolean;
  /** Whether this agent can manage the global todo list (default: false for specialized agents) */
  allowTodoManagement?: boolean;
  /** Enable verbose logging */
  verbose?: boolean;
  /** System prompt to prepend (initial/static version) */
  systemPrompt?: string;
  /** Base agent prompt for specialized agents (for regeneration) */
  baseAgentPrompt?: string;
  /** Task prompt for specialized agents (for regeneration) */
  taskPrompt?: string;
  /** Application configuration */
  config: Config;
  /** Parent tool call ID (for nested agents) */
  parentCallId?: string;
  /** Required tool calls that must be executed before agent can exit */
  requiredToolCalls?: string[];
}

/**
 * Tool context for controlling agent behavior during specific tool operations.
 * Used to restrict tool availability and inject system reminders.
 */
export interface ToolContext {
  /** The tool that triggered this context (e.g., "plan") */
  triggerTool: string;
  /** If set, ONLY these tools are allowed - exclusive mode */
  availableTools?: string[];
  /** If set, these tools are preferred - soft suggestion mode */
  suggestedTools?: string[];
  /** Context message to inject as system reminder */
  systemReminder: string;
  /** Arbitrary contextual data (e.g., proposed todos) */
  data?: any;
}

/**
 * Agent orchestrates the entire conversation flow
 */
export class Agent {
  private modelClient: ModelClient;
  private toolManager: ToolManager;
  private activityStream: ActivityStream;
  private toolOrchestrator: ToolOrchestrator;
  private config: AgentConfig;

  // Conversation state
  private messages: Message[] = [];
  private requestInProgress: boolean = false;

  // Interruption state - consolidated for clarity
  private interrupted: boolean = false;
  private wasInterrupted: boolean = false;
  private interruptionContext: {
    reason: string;
    isTimeout: boolean;
  } = { reason: '', isTimeout: false };

  // Tool execution abort controller
  private toolAbortController?: AbortController;

  // Context tracking (isolated per agent)
  private tokenManager: TokenManager;
  private toolResultManager: any; // ToolResultManager instance

  // Agent instance ID for debugging
  private readonly instanceId: string;

  // Activity watchdog - detects agents stuck generating tokens without tool calls
  private lastToolCallTime: number = Date.now();
  private activityWatchdogInterval: NodeJS.Timeout | null = null;
  private readonly activityTimeoutMs: number;

  // Required tool calls tracking
  private calledRequiredTools: Set<string> = new Set();
  private requiredToolWarningCount: number = 0;

  // Tool context tracking - used for dynamic tool filtering
  private currentToolContext: ToolContext | null = null;

  constructor(
    modelClient: ModelClient,
    toolManager: ToolManager,
    activityStream: ActivityStream,
    config: AgentConfig,
    configManager?: ConfigManager,
    permissionManager?: PermissionManager
  ) {
    this.modelClient = modelClient;
    this.toolManager = toolManager;
    this.activityStream = activityStream;
    this.config = config;

    // Generate unique instance ID for debugging: agent-{timestamp}-{7-char-random} (base-36, skip '0.' prefix)
    this.instanceId = `agent-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    logger.debug('[AGENT_CONTEXT]', this.instanceId, 'Created - isSpecialized:', config.isSpecializedAgent || false, 'parentCallId:', config.parentCallId || 'none');

    // Debug log for required tools configuration
    if (config.requiredToolCalls && config.requiredToolCalls.length > 0) {
      console.log(`[REQUIRED_TOOLS_DEBUG] Agent ${this.instanceId} configured with required tools:`, config.requiredToolCalls);
    }

    // Set activity timeout (convert seconds to milliseconds)
    // Only enable for specialized agents (subagents) to detect infinite loops
    this.activityTimeoutMs = config.config.tool_call_activity_timeout * 1000;
    if (config.isSpecializedAgent && this.activityTimeoutMs > 0) {
      logger.debug('[AGENT_CONTEXT]', this.instanceId, 'Activity timeout enabled:', this.activityTimeoutMs, 'ms');
    }

    // Create agent's own TokenManager for isolated context tracking
    this.tokenManager = new TokenManager(config.config.context_size);
    logger.debug('[AGENT_CONTEXT]', this.instanceId, 'TokenManager created with context size:', config.config.context_size);

    // Create agent's own ToolResultManager using agent's TokenManager
    this.toolResultManager = new ToolResultManager(
      this.tokenManager,
      configManager, // Optional: uses defaults if not provided
      toolManager
    );

    // Create tool orchestrator
    this.toolOrchestrator = new ToolOrchestrator(
      toolManager,
      activityStream,
      this,
      config,
      this.toolResultManager,
      permissionManager
    );

    // Initialize with system prompt if provided
    if (config.systemPrompt) {
      const systemMessage = {
        role: 'system' as const,
        content: config.systemPrompt,
      };
      this.messages.push(systemMessage);
      logger.debug('[AGENT_CONTEXT]', this.instanceId, 'System prompt added, length:', config.systemPrompt.length);

      // Update token count with initial system message
      this.tokenManager.updateTokenCount(this.messages);
      const initialUsage = this.tokenManager.getContextUsagePercentage();
      logger.debug('[AGENT_CONTEXT]', this.instanceId, 'Initial context usage:', initialUsage + '%');
    }
  }

  /**
   * Get the model client (used by CommandHandler for /compact)
   */
  getModelClient(): ModelClient {
    return this.modelClient;
  }

  /**
   * Get the token manager (used by cli.ts for ServiceRegistry)
   */
  getTokenManager(): TokenManager {
    return this.tokenManager;
  }

  /**
   * Set the current tool context
   * Used to control tool availability and inject system reminders
   */
  setCurrentToolContext(context: ToolContext | null): void {
    this.currentToolContext = context;
    if (context) {
      logger.debug('[AGENT_TOOL_CONTEXT]', this.instanceId, 'Tool context set:', context.triggerTool);
    } else {
      logger.debug('[AGENT_TOOL_CONTEXT]', this.instanceId, 'Tool context cleared');
    }
  }

  /**
   * Reset the tool call activity timer
   * Called by ToolOrchestrator when a tool call is executed
   */
  resetToolCallActivity(): void {
    this.lastToolCallTime = Date.now();
    logger.debug('[AGENT_ACTIVITY]', this.instanceId, 'Tool call activity reset');
  }

  /**
   * Start watchdog timer for tool call activity
   *
   * Monitors specialized agents (subagents) for token generation without tool calls.
   * If no tool calls occur within the timeout period, the agent is interrupted.
   */
  private startActivityWatchdog(): void {
    // Only enable for specialized agents (subagents)
    if (!this.config.isSpecializedAgent || this.activityTimeoutMs <= 0) {
      return;
    }

    // Reset activity timer at start
    this.lastToolCallTime = Date.now();

    this.activityWatchdogInterval = setInterval(() => {
      const elapsedMs = Date.now() - this.lastToolCallTime;

      if (elapsedMs > this.activityTimeoutMs) {
        this.handleActivityTimeout(elapsedMs);
      }
    }, POLLING_INTERVALS.AGENT_WATCHDOG);

    logger.debug('[AGENT_ACTIVITY]', this.instanceId, 'Activity watchdog started');
  }

  /**
   * Handle activity timeout by interrupting the agent
   */
  private handleActivityTimeout(elapsedMs: number): void {
    const elapsedSeconds = Math.round(elapsedMs / 1000);
    const timeoutSeconds = this.activityTimeoutMs / 1000;

    logger.warn(
      '[AGENT_ACTIVITY]', this.instanceId,
      `Activity timeout: ${elapsedSeconds}s since last tool call (limit: ${timeoutSeconds}s)`
    );

    // Set interruption context
    this.interruptionContext = {
      reason: `Agent stuck: no tool calls for ${elapsedSeconds} seconds (timeout: ${timeoutSeconds}s)`,
      isTimeout: true,
    };

    // Interrupt and stop watchdog
    this.interrupt();
    this.stopActivityWatchdog();
  }

  /**
   * Stop the activity watchdog timer
   */
  private stopActivityWatchdog(): void {
    if (this.activityWatchdogInterval) {
      clearInterval(this.activityWatchdogInterval);
      this.activityWatchdogInterval = null;
      logger.debug('[AGENT_ACTIVITY]', this.instanceId, 'Activity watchdog stopped');
    }
  }

  /**
   * Send a user message and get a response
   *
   * Main entry point for conversation turns. Handles:
   * - Adding user message to history
   * - Sending to LLM with function definitions
   * - Processing tool calls (if any)
   * - Returning final response
   *
   * @param message - User's message
   * @returns Promise resolving to the assistant's final response
   */
  async sendMessage(message: string): Promise<string> {
    // Start activity watchdog for specialized agents
    this.startActivityWatchdog();

    // Add user message
    const userMessage: Message = {
      role: 'user',
      content: message,
      timestamp: Date.now(),
    };
    this.messages.push(userMessage);

    // If the previous request was interrupted, add a system reminder
    if (this.wasInterrupted) {
      const systemReminder: Message = {
        role: 'system',
        content: '<system-reminder>\nUser interrupted. Prioritize answering their new prompt over continuing your todo list. After responding, reassess if the todo list is still relevant. Do not blindly continue with pending todos.\n</system-reminder>',
        timestamp: Date.now(),
      };
      this.messages.push(systemReminder);
      logger.debug('[AGENT_INTERRUPTION]', this.instanceId, 'Injected system reminder after interruption');

      // Reset the flag after injecting the reminder
      this.wasInterrupted = false;
    }

    // Auto-save after user message
    this.autoSaveSession();

    // Inject system reminder about todos (main agent only)
    // This nudges the model to consider updating the todo list without blocking
    if (!this.config.isSpecializedAgent) {
      const registry = ServiceRegistry.getInstance();
      const todoManager = registry.get<any>('todo_manager');

      if (todoManager) {
        const todos = todoManager.getTodos();
        let reminderContent = '<system-reminder>\n';

        if (todos.length === 0) {
          reminderContent += 'IMPORTANT: The todo list is currently empty. Create a todo list using todo_add for ANY task - even simple single-step tasks. Breaking work into tracked tasks dramatically improves your effectiveness by:\n';
          reminderContent += '• Providing focus reminders after each tool use\n';
          reminderContent += '• Helping you stay on track and avoid tangents\n';
          reminderContent += '• Giving the user visibility into your progress\n';
          reminderContent += '• Making it clear when work is complete\n\n';
          reminderContent += 'Examples of good single-task todos:\n';
          reminderContent += '- "Fix failing tests in PathSecurity"\n';
          reminderContent += '- "Debug memory leak in WebSocket handler"\n';
          reminderContent += '- "Add error handling to login endpoint"\n\n';
          reminderContent += 'Use todo_add at the start of your turn, even for "simple" tasks. It only takes one tool call.\n';
        } else {
          reminderContent += 'Current todos:\n';
          todos.forEach((todo: any, idx: number) => {
            const status = todo.status === 'completed' ? '✓' : todo.status === 'in_progress' ? '→' : '○';
            reminderContent += `${idx + 1}. [${status}] ${todo.task}\n`;
          });

          const inProgressTodo = todos.find((t: any) => t.status === 'in_progress');
          if (inProgressTodo) {
            reminderContent += `\nYou are currently working on: "${inProgressTodo.task}". Stay focused on completing this task - don't get distracted by tangential findings in tool results unless they directly block your progress.\n`;
          }

          reminderContent += '\nHousekeeping: Keep the todo list clean and focused.\n';
          reminderContent += '• Remove completed tasks that are no longer relevant to the conversation\n';
          reminderContent += '• Remove pending tasks that are no longer needed\n';
          reminderContent += '• Update task descriptions if they\'ve changed\n';
          reminderContent += '• Remember: exactly ONE task must be in_progress when working\n\n';
          reminderContent += 'Update the list now if needed based on the user\'s request.\n';
        }

        reminderContent += '</system-reminder>';

        const systemReminder: Message = {
          role: 'system',
          content: reminderContent,
          timestamp: Date.now(),
        };
        this.messages.push(systemReminder);
        logger.debug('[AGENT_TODO_REMINDER]', this.instanceId, 'Injected todo reminder system message');
      }
    }

    // Emit user message event
    this.emitEvent({
      id: this.generateId(),
      type: ActivityEventType.AGENT_START,
      timestamp: Date.now(),
      data: {
        message,
        isSpecializedAgent: this.config.isSpecializedAgent || false,
      },
    });

    try {
      // Reset interrupted flag and mark request in progress
      this.interrupted = false;
      this.requestInProgress = true;

      // Send to LLM and process response
      const response = await this.getLLMResponse();

      // Check if interrupted before processing
      if (this.interrupted) {
        throw new Error('Request interrupted by user');
      }

      // Process response (handles both tool calls and text responses)
      const finalResponse = await this.processLLMResponse(response);

      return finalResponse;
    } catch (error) {
      if (this.interrupted || (error instanceof Error && error.message.includes('interrupted'))) {
        return this.handleInterruption();
      }
      throw error;
    } finally {
      this.cleanupRequestState();
    }
  }

  /**
   * Handle request interruption
   *
   * For timeouts on specialized agents, throws an error (tool failure).
   * For user interruptions or main agent, returns a message.
   */
  private handleInterruption(): string {
    this.wasInterrupted = true;

    const message = this.interruptionContext.reason || '[Request interrupted by user]';
    const wasTimeout = this.interruptionContext.isTimeout;

    // Clear interruption state
    this.interruptionContext = { reason: '', isTimeout: false };

    // Timeouts on subagents should fail as tool errors
    if (wasTimeout && this.config.isSpecializedAgent) {
      throw new Error(message);
    }

    // User interruptions return message gracefully
    return message;
  }

  /**
   * Clean up request state after completion or error
   */
  private cleanupRequestState(): void {
    this.requestInProgress = false;
    this.interrupted = false;
    this.interruptionContext = { reason: '', isTimeout: false };
    this.stopActivityWatchdog();
  }

  /**
   * Interrupt the current request
   *
   * Called when user presses Ctrl+C during an ongoing request.
   * Immediately cancels the LLM request and sets interrupt flag for graceful cleanup.
   */
  interrupt(): void {
    if (this.requestInProgress) {
      this.interrupted = true;

      // Cancel ongoing LLM request immediately
      this.cancel();

      // Abort any ongoing tool executions
      if (this.toolAbortController) {
        this.toolAbortController.abort();
        this.toolAbortController = undefined;
      }

      // Stop activity watchdog
      this.stopActivityWatchdog();

      this.emitEvent({
        id: this.generateId(),
        type: ActivityEventType.AGENT_END,
        timestamp: Date.now(),
        data: {
          interrupted: true,
          isSpecializedAgent: this.config.isSpecializedAgent || false,
        },
      });
    }
  }

  /**
   * Check if a request is currently in progress
   */
  isProcessing(): boolean {
    return this.requestInProgress;
  }

  /**
   * Start tool execution by creating a fresh AbortController
   * Called at the beginning of each tool execution batch
   * @returns AbortSignal for the tool execution
   */
  private startToolExecution(): AbortSignal {
    this.toolAbortController = new AbortController();
    return this.toolAbortController.signal;
  }

  /**
   * Get the current tool abort signal
   * Used by ToolOrchestrator to pass signal to tools
   * @returns AbortSignal if available, undefined otherwise
   */
  getToolAbortSignal(): AbortSignal | undefined {
    return this.toolAbortController?.signal;
  }

  /**
   * Get response from LLM
   *
   * @returns LLM response with potential tool calls
   */
  private async getLLMResponse(): Promise<LLMResponse> {
    // Get function definitions from tool manager
    // Exclude todo management tools from specialized agents (only main agent can manage todos)
    const allowTodoManagement = this.config.allowTodoManagement ?? !this.config.isSpecializedAgent;
    let excludeTools = allowTodoManagement ? undefined : ([...TOOL_NAMES.TODO_MANAGEMENT_TOOLS] as string[]);

    // Handle currentToolContext for tool filtering
    if (this.currentToolContext) {
      if (this.currentToolContext.availableTools) {
        // Exclusive mode: Only allow tools in availableTools
        // Get all registered tool names
        const allTools = this.toolManager.getAllTools().map(tool => tool.name);

        // Compute tools to exclude (all tools NOT in availableTools)
        const contextExclusions = allTools.filter(
          toolName => !this.currentToolContext!.availableTools!.includes(toolName)
        );

        // Merge with existing excludeTools
        const existingExclusions = excludeTools || [];
        excludeTools = [...new Set([...existingExclusions, ...contextExclusions])];

        logger.debug(
          '[TOOL_CONTEXT]',
          this.instanceId,
          'Context filtering active (exclusive mode):',
          'available=', this.currentToolContext.availableTools,
          'excluded=', contextExclusions
        );
      } else if (this.currentToolContext.suggestedTools) {
        // Soft mode: Don't restrict tools (we'll use this for system reminder in next task)
        logger.debug(
          '[TOOL_CONTEXT]',
          this.instanceId,
          'Context filtering active (soft mode):',
          'suggested=', this.currentToolContext.suggestedTools
        );
      }
    }

    const functions = this.toolManager.getFunctionDefinitions(excludeTools);

    // Regenerate system prompt with current context (todos, etc.) before each LLM call
    // Works for both main agent and specialized agents
    if (this.messages[0]?.role === 'system') {
      let updatedSystemPrompt: string;

      if (this.config.isSpecializedAgent && this.config.baseAgentPrompt && this.config.taskPrompt) {
        // Regenerate specialized agent prompt with current context
        const { getAgentSystemPrompt } = await import('../prompts/systemMessages.js');
        updatedSystemPrompt = await getAgentSystemPrompt(
          this.config.baseAgentPrompt,
          this.config.taskPrompt,
          this.tokenManager,
          this.toolResultManager
        );
        logger.debug('[AGENT_CONTEXT]', this.instanceId, 'Specialized agent prompt regenerated with current context');
      } else {
        // Regenerate main agent prompt with current context
        const { getMainSystemPrompt } = await import('../prompts/systemMessages.js');
        updatedSystemPrompt = await getMainSystemPrompt(this.tokenManager, this.toolResultManager);
        logger.debug('[AGENT_CONTEXT]', this.instanceId, 'Main agent prompt regenerated with current context');
      }

      this.messages[0].content = updatedSystemPrompt;
    }

    // Inject context-aware system reminder if currentToolContext is set
    if (this.currentToolContext) {
      const contextReminder: Message = {
        role: 'system',
        content: `<system-reminder>\n${this.currentToolContext.systemReminder}\n</system-reminder>`,
        timestamp: Date.now(),
      };
      this.messages.push(contextReminder);
      logger.debug(
        '[TOOL_CONTEXT]',
        this.instanceId,
        'Injected context-aware system reminder:',
        this.currentToolContext.triggerTool
      );
      console.log(`[TOOL_CONTEXT_DEBUG] Injected system reminder for context: ${this.currentToolContext.triggerTool}`);
    }

    // Auto-compaction: check if context usage exceeds threshold
    await this.checkAutoCompaction();

    // Log conversation state before sending to LLM
    logger.debug('[AGENT_CONTEXT]', this.instanceId, 'Sending', this.messages.length, 'messages to LLM');
    if (logger.isDebugEnabled()) {
      this.messages.forEach((msg, idx) => {
        const preview = msg.content.length > TEXT_LIMITS.MESSAGE_PREVIEW_MAX ? msg.content.slice(0, TEXT_LIMITS.MESSAGE_PREVIEW_MAX - 3) + '...' : msg.content;
        const toolInfo = msg.tool_calls ? ` toolCalls:${msg.tool_calls.length}` : '';
        const toolCallId = msg.tool_call_id ? ` toolCallId:${msg.tool_call_id}` : '';
        console.log(`  [${idx}] ${msg.role}${toolInfo}${toolCallId} - ${preview}`);
      });
    }

    // Emit thinking indicator
    this.emitEvent({
      id: this.generateId(),
      type: ActivityEventType.THOUGHT_CHUNK,
      timestamp: Date.now(),
      data: { text: 'Thinking...', thinking: true },
    });

    try {
      // Send to model (includes system-reminder if present)
      const response = await this.modelClient.send(this.messages, {
        functions,
        // Disable streaming for subagents - only main agent should stream responses
        stream: !this.config.isSpecializedAgent && this.config.config.parallel_tools,
      });

      // Remove system-reminder messages after receiving response
      // These are temporary context hints that should not persist
      const originalLength = this.messages.length;
      this.messages = this.messages.filter(msg =>
        !(msg.role === 'system' && msg.content.includes('<system-reminder>'))
      );
      if (this.messages.length !== originalLength) {
        logger.debug('[AGENT_INTERRUPTION]', this.instanceId, 'Removed system reminder after LLM response');
      }

      return response;
    } catch (error) {
      // Remove system-reminder messages even on error
      // These should not persist in conversation history
      this.messages = this.messages.filter(msg =>
        !(msg.role === 'system' && msg.content.includes('<system-reminder>'))
      );

      // Emit error event
      this.emitEvent({
        id: this.generateId(),
        type: ActivityEventType.ERROR,
        timestamp: Date.now(),
        data: { error: formatError(error) },
      });

      throw error;
    }
  }

  /**
   * Process LLM response (handles both tool calls and text)
   *
   * @param response - LLM response
   * @param isRetry - Whether this is a retry after empty response
   * @returns Final text response
   */
  private async processLLMResponse(response: LLMResponse, isRetry: boolean = false): Promise<string> {
    // Check for interruption
    if (this.interrupted || response.interrupted) {
      return '[Request interrupted by user]';
    }

    // Check for error
    if (response.error) {
      return response.content || 'An error occurred';
    }

    // Extract tool calls
    const toolCalls = response.tool_calls || [];

    // Log LLM response to trace tool call origins
    logger.debug('[AGENT] LLM response - hasContent:', !!response.content, 'toolCallCount:', toolCalls.length);
    if (toolCalls.length > 0) {
      logger.debug('[AGENT] Tool calls from LLM:');
      toolCalls.forEach((tc, idx) => {
        logger.debug(`  [${idx}] ${tc.function.name}(${JSON.stringify(tc.function.arguments)}) id:${tc.id}`);
      });
    }

    if (toolCalls.length > 0) {
      // Check for interruption before processing tools
      if (this.interrupted) {
        return '[Request interrupted by user]';
      }
      // Response contains tool calls
      return await this.processToolResponse(response, toolCalls);
    } else {
      // Text-only response
      return await this.processTextResponse(response, isRetry);
    }
  }

  /**
   * Process a response that contains tool calls
   *
   * @param response - LLM response with tool calls
   * @param toolCalls - Parsed tool calls
   * @returns Final response after tool execution and follow-up
   */
  private async processToolResponse(
    response: LLMResponse,
    toolCalls: Array<{
      id: string;
      type: 'function';
      function: { name: string; arguments: Record<string, any> };
    }>
  ): Promise<string> {
    logger.debug('[AGENT_CONTEXT]', this.instanceId, 'Processing tool response with', toolCalls.length, 'tool calls');

    // Unwrap batch calls before adding to conversation
    // This ensures the conversation history matches what was actually executed
    const unwrappedToolCalls = this.unwrapBatchToolCalls(toolCalls);
    logger.debug('[AGENT_CONTEXT]', this.instanceId, 'After unwrapping:', unwrappedToolCalls.length, 'tool calls');

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
      timestamp: Date.now(),
    };
    this.messages.push(assistantMessage);

    // Auto-save after assistant message with tool calls
    this.autoSaveSession();

    logger.debug('[AGENT_CONTEXT]', this.instanceId, 'Assistant message with tool calls added. Total messages:', this.messages.length);

    // Check context usage for specialized agents (subagents)
    // Enforce stricter limit (WARNING threshold) to ensure room for final summary
    const contextUsage = this.tokenManager.getContextUsagePercentage();
    if (this.config.isSpecializedAgent && contextUsage >= CONTEXT_THRESHOLDS.WARNING) {
      logger.debug('[AGENT_CONTEXT]', this.instanceId, 'Specialized agent at', contextUsage + '% context - blocking tool execution to preserve space for summary');

      // Remove the assistant message with tool calls we just added
      this.messages.pop();

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
      this.messages.push(systemReminder);

      // Get final response from LLM (without executing tools)
      logger.debug('[AGENT_CONTEXT]', this.instanceId, 'Requesting final summary from specialized agent...');
      const finalResponse = await this.getLLMResponse();

      return await this.processLLMResponse(finalResponse);
    }

    // Execute tool calls via orchestrator (pass original calls for unwrapping)
    logger.debug('[AGENT_CONTEXT]', this.instanceId, 'Executing tool calls via orchestrator...');

    // Start tool execution and create abort controller
    this.startToolExecution();

    await this.toolOrchestrator.executeToolCalls(toolCalls);
    logger.debug('[AGENT_CONTEXT]', this.instanceId, 'Tool calls completed. Total messages now:', this.messages.length);

    // Track required tool calls
    if (this.config.requiredToolCalls && this.config.requiredToolCalls.length > 0) {
      console.log(`[REQUIRED_TOOLS_DEBUG] Checking ${unwrappedToolCalls.length} tool calls for required tools`);
      unwrappedToolCalls.forEach(tc => {
        console.log(`[REQUIRED_TOOLS_DEBUG] Tool executed: ${tc.function.name}`);
        if (this.config.requiredToolCalls?.includes(tc.function.name)) {
          this.calledRequiredTools.add(tc.function.name);
          console.log(`[REQUIRED_TOOLS_DEBUG] ✓ Tracked required tool call: ${tc.function.name}`);
          console.log(`[REQUIRED_TOOLS_DEBUG] Called so far:`, Array.from(this.calledRequiredTools));
          logger.debug('[AGENT_REQUIRED_TOOLS]', this.instanceId, `Tracked required tool call: ${tc.function.name}`);
        }
      });
    }

    // Clear current turn (for redundancy detection)
    this.toolManager.clearCurrentTurn();

    // Get follow-up response from LLM
    logger.debug('[AGENT_CONTEXT]', this.instanceId, 'Getting follow-up response from LLM...');
    const followUpResponse = await this.getLLMResponse();

    // Recursively process the follow-up (it might contain more tool calls)
    return await this.processLLMResponse(followUpResponse);
  }

  /**
   * Process a text-only response (no tool calls)
   *
   * @param response - LLM response with text content
   * @param isRetry - Whether this is a retry after empty response
   * @returns The text content
   */
  private async processTextResponse(response: LLMResponse, isRetry: boolean = false): Promise<string> {
    // Validate that we have actual content
    const content = response.content || '';

    // Check if empty AND we just executed tools AND this is not already a retry
    if (!content.trim() && !isRetry) {
      // Check if previous message had tool calls (indicates we're in follow-up after tools)
      const lastMessage = this.messages[this.messages.length - 1];
      const isAfterToolExecution = lastMessage?.role === 'assistant' && lastMessage?.tool_calls && lastMessage.tool_calls.length > 0;

      if (isAfterToolExecution) {
        logger.warn('[AGENT_RESPONSE]', this.instanceId, 'Empty response after tool execution - attempting recovery');

        // Add continuation prompt
        const continuationPrompt: Message = {
          role: 'user',
          content: '<system-reminder>\nYou just executed tool calls but did not provide any response. Please provide your response now based on the tool results.\n</system-reminder>',
          timestamp: Date.now(),
        };
        this.messages.push(continuationPrompt);

        // Retry LLM call
        logger.debug('[AGENT_RESPONSE]', this.instanceId, 'Retrying LLM call after empty response...');
        const retryResponse = await this.getLLMResponse();

        // Process retry (mark as retry to prevent infinite loop)
        return await this.processLLMResponse(retryResponse, true);
      } else {
        // Empty response but not after tool execution - just log debug
        logger.debug('[AGENT_RESPONSE]', this.instanceId, 'Model returned empty content');
      }
    } else if (!content.trim() && isRetry) {
      // Still empty after retry - use fallback
      logger.error('[AGENT_RESPONSE]', this.instanceId, 'Still empty after retry - using fallback message');
      const fallbackContent = this.config.isSpecializedAgent
        ? 'Task completed. Tool results are available in the conversation history.'
        : 'I apologize, but I encountered an issue generating a response. The requested operations have been completed.';

      const assistantMessage: Message = {
        role: 'assistant',
        content: fallbackContent,
        timestamp: Date.now(),
      };
      this.messages.push(assistantMessage);
      this.autoSaveSession();

      this.emitEvent({
        id: this.generateId(),
        type: ActivityEventType.AGENT_END,
        timestamp: Date.now(),
        data: {
          content: fallbackContent,
          isSpecializedAgent: this.config.isSpecializedAgent || false,
        },
      });

      return fallbackContent;
    }

    // Check if all required tool calls have been executed before allowing agent to exit
    if (this.config.requiredToolCalls && this.config.requiredToolCalls.length > 0 && !this.interrupted) {
      console.log(`[REQUIRED_TOOLS_DEBUG] Agent attempting to exit with text response`);
      console.log(`[REQUIRED_TOOLS_DEBUG] Required tools:`, this.config.requiredToolCalls);
      console.log(`[REQUIRED_TOOLS_DEBUG] Called tools:`, Array.from(this.calledRequiredTools));

      const missingTools = this.config.requiredToolCalls.filter(tool => !this.calledRequiredTools.has(tool));
      console.log(`[REQUIRED_TOOLS_DEBUG] Missing tools:`, missingTools);

      if (missingTools.length > 0) {
        // Not all required tools have been called
        if (this.requiredToolWarningCount >= BUFFER_SIZES.AGENT_REQUIRED_TOOL_MAX_WARNINGS) {
          // Exceeded max warnings - fail the operation
          const errorMessage = `Agent failed to call required tools after ${BUFFER_SIZES.AGENT_REQUIRED_TOOL_MAX_WARNINGS} warnings. Missing tools: ${missingTools.join(', ')}`;
          console.log(`[REQUIRED_TOOLS_DEBUG] ✗ FAILING - exceeded max warnings (${this.requiredToolWarningCount}/${BUFFER_SIZES.AGENT_REQUIRED_TOOL_MAX_WARNINGS})`);
          console.log(`[REQUIRED_TOOLS_DEBUG] Error message:`, errorMessage);
          logger.error('[AGENT_REQUIRED_TOOLS]', this.instanceId, errorMessage);

          const assistantMessage: Message = {
            role: 'assistant',
            content: `[Error: ${errorMessage}]`,
            timestamp: Date.now(),
          };
          this.messages.push(assistantMessage);
          this.autoSaveSession();

          return `[Error: ${errorMessage}]`;
        }

        // Send reminder to call required tools
        this.requiredToolWarningCount++;
        console.log(`[REQUIRED_TOOLS_DEBUG] ⚠ ISSUING WARNING ${this.requiredToolWarningCount}/${BUFFER_SIZES.AGENT_REQUIRED_TOOL_MAX_WARNINGS}`);
        console.log(`[REQUIRED_TOOLS_DEBUG] Sending reminder to call: ${missingTools.join(', ')}`);
        logger.warn('[AGENT_REQUIRED_TOOLS]', this.instanceId,
          `Agent attempting to exit without calling required tools (warning ${this.requiredToolWarningCount}/${BUFFER_SIZES.AGENT_REQUIRED_TOOL_MAX_WARNINGS}). Missing: ${missingTools.join(', ')}`);

        const reminderMessage: Message = {
          role: 'system',
          content: '<system-reminder>\n' +
            `You must call the following required tool(s) before completing your task: ${missingTools.join(', ')}\n` +
            `Please call ${missingTools.length === 1 ? 'this tool' : 'these tools'} now.\n` +
            '</system-reminder>',
          timestamp: Date.now(),
        };
        this.messages.push(reminderMessage);

        // Get new response from LLM
        logger.debug('[AGENT_REQUIRED_TOOLS]', this.instanceId, 'Requesting LLM to call required tools...');
        const retryResponse = await this.getLLMResponse();

        // Recursively process the response
        return await this.processLLMResponse(retryResponse);
      } else {
        // All required tools have been called
        console.log(`[REQUIRED_TOOLS_DEBUG] ✓ SUCCESS - All required tools have been called`);
        logger.debug('[AGENT_REQUIRED_TOOLS]', this.instanceId, 'All required tools have been called:', Array.from(this.calledRequiredTools));
      }
    }

    // Normal path - we have content and all required tools (if any) have been called
    const assistantMessage: Message = {
      role: 'assistant',
      content: content,
      timestamp: Date.now(),
    };
    this.messages.push(assistantMessage);

    // Auto-save after text response
    this.autoSaveSession();

    // Emit completion event
    this.emitEvent({
      id: this.generateId(),
      type: ActivityEventType.AGENT_END,
      timestamp: Date.now(),
      data: {
        content: content,
        isSpecializedAgent: this.config.isSpecializedAgent || false,
      },
    });

    return content;
  }

  /**
   * Generate system prompt with tool descriptions
   *
   * Creates a system prompt that includes descriptions of all available tools.
   *
   * @returns System prompt string
   */
  generateSystemPrompt(): string {
    // Exclude todo management tools from specialized agents (only main agent can manage todos)
    const allowTodoManagement = this.config.allowTodoManagement ?? !this.config.isSpecializedAgent;
    const excludeTools = allowTodoManagement ? undefined : ([...TOOL_NAMES.TODO_MANAGEMENT_TOOLS] as string[]);
    const functions = this.toolManager.getFunctionDefinitions(excludeTools);

    let prompt = this.config.systemPrompt || 'You are a helpful AI assistant.';
    prompt += '\n\nYou have access to the following tools:\n\n';

    for (const func of functions) {
      prompt += `- **${func.function.name}**: ${func.function.description}\n`;

      // Add parameter descriptions
      const params = func.function.parameters.properties;
      if (params && Object.keys(params).length > 0) {
        prompt += '  Parameters:\n';
        for (const [paramName, paramSchema] of Object.entries(params)) {
          const required = func.function.parameters.required?.includes(paramName) ? ' (required)' : '';
          const desc = paramSchema.description || 'No description';
          prompt += `    - ${paramName}${required}: ${desc}\n`;
        }
      }

      prompt += '\n';
    }

    prompt += '\nUse these tools to complete tasks effectively.';

    return prompt;
  }

  /**
   * Unwrap batch tool calls into individual tool calls
   *
   * Batch is a transparent wrapper - we extract its children so the conversation
   * history shows the actual tools that were executed.
   */
  private unwrapBatchToolCalls(
    toolCalls: Array<{
      id: string;
      type: 'function';
      function: { name: string; arguments: Record<string, any> };
    }>
  ): Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: Record<string, any> };
  }> {
    const unwrapped: Array<{
      id: string;
      type: 'function';
      function: { name: string; arguments: Record<string, any> };
    }> = [];

    for (const toolCall of toolCalls) {
      // Check if this is a batch call
      if (toolCall.function.name === 'batch') {
        const tools = toolCall.function.arguments.tools;

        if (Array.isArray(tools)) {
          // Convert each tool spec into a proper tool call
          tools.forEach((spec: any, index: number) => {
            unwrapped.push({
              id: `${toolCall.id}-unwrapped-${index}`,
              type: 'function',
              function: {
                name: spec.name,
                arguments: spec.arguments,
              },
            });
          });
        }
      } else {
        // Not a batch call, keep as-is
        unwrapped.push(toolCall);
      }
    }

    return unwrapped;
  }

  /**
   * Auto-save session to disk (messages and todos)
   */
  private async autoSaveSession(): Promise<void> {
    const registry = ServiceRegistry.getInstance();
    const sessionManager = registry.get('session_manager');
    const todoManager = registry.get('todo_manager');

    if (!sessionManager || typeof (sessionManager as any).autoSave !== 'function') {
      return; // Session manager not available
    }

    // Get current session
    const currentSession = (sessionManager as any).getCurrentSession();

    // Create a new session if none exists and we have user messages
    if (!currentSession) {
      const hasUserMessages = this.messages.some(m => m.role === 'user');
      if (hasUserMessages && typeof (sessionManager as any).generateSessionName === 'function') {
        const sessionName = (sessionManager as any).generateSessionName();
        await (sessionManager as any).createSession(sessionName);
        (sessionManager as any).setCurrentSession(sessionName);
        logger.debug('[AGENT_SESSION]', this.instanceId, 'Created new session:', sessionName);
      } else {
        return; // No user messages yet, don't create session
      }
    }

    // Get todos if TodoManager is available
    let todos: any[] | undefined;
    if (todoManager && typeof (todoManager as any).getTodos === 'function') {
      todos = (todoManager as any).getTodos();
    }

    // Get idle messages if IdleMessageGenerator is available
    let idleMessages: string[] | undefined;
    const idleMessageGenerator = registry.get('idle_message_generator');
    if (idleMessageGenerator && typeof (idleMessageGenerator as any).getQueue === 'function') {
      idleMessages = (idleMessageGenerator as any).getQueue();
    }

    // Get project context if ProjectContextDetector is available
    let projectContext: any | undefined;
    const projectContextDetector = registry.get('project_context_detector');
    if (projectContextDetector && typeof (projectContextDetector as any).getCached === 'function') {
      projectContext = (projectContextDetector as any).getCached();
    }

    // Auto-save (non-blocking, fire and forget)
    (sessionManager as any).autoSave(this.messages, todos, idleMessages, projectContext).catch((error: Error) => {
      logger.error('[AGENT_SESSION]', this.instanceId, 'Failed to auto-save session:', error);
    });
  }

  /**
   * Add a message to conversation history
   *
   * @param message - Message to add
   */
  addMessage(message: Message): void {
    // Ensure message has a timestamp
    const messageWithTimestamp = {
      ...message,
      timestamp: message.timestamp || Date.now(),
    };
    this.messages.push(messageWithTimestamp);

    // Update TokenManager with new message count
    this.tokenManager.updateTokenCount(this.messages);

    // Emit context usage update event for real-time UI updates
    // Only emit for main agent, not specialized agents (subagents)
    if (!this.config.isSpecializedAgent) {
      const contextUsage = this.tokenManager.getContextUsagePercentage();
      this.emitEvent({
        id: this.generateId(),
        type: ActivityEventType.CONTEXT_USAGE_UPDATE,
        timestamp: Date.now(),
        data: { contextUsage },
      });
    }

    // Log message addition for context tracking
    const toolInfo = message.tool_calls ? ` toolCalls:${message.tool_calls.length}` : '';
    const toolCallId = message.tool_call_id ? ` toolCallId:${message.tool_call_id}` : '';
    const toolName = message.name ? ` name:${message.name}` : '';
    logger.debug('[AGENT_CONTEXT]', this.instanceId, 'Message added:', message.role, toolInfo, toolCallId, toolName, '- Total messages:', this.messages.length);

    // Auto-save session after adding message
    this.autoSaveSession();
  }

  /**
   * Get the current conversation history
   *
   * @returns Array of messages
   */
  getMessages(): Message[] {
    return [...this.messages];
  }

  /**
   * Set messages (used for compaction, rewind, and session loading)
   * @param messages - New message array to replace current messages
   */
  setMessages(messages: Message[]): void {
    this.messages = [...messages];
    logger.debug('[AGENT_CONTEXT]', this.instanceId, 'Messages set, count:', this.messages.length);
  }

  /**
   * Update messages after compaction
   * Used by manual /compact command
   * @param compactedMessages - Compacted message array
   */
  updateMessagesAfterCompaction(compactedMessages: Message[]): void {
    this.messages = [...compactedMessages];
    logger.debug('[AGENT_CONTEXT]', this.instanceId, 'Messages updated after compaction, count:', this.messages.length);
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
  async rewindToMessage(userMessageIndex: number): Promise<string> {
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

    logger.debug('[AGENT_CONTEXT]', this.instanceId, 'Rewound to message', userMessageIndex, '- Total messages now:', this.messages.length);

    // Return the target message content for pre-filling the input
    return targetMessage.content;
  }

  /**
   * Check if a request is currently in progress
   */
  isRequestInProgress(): boolean {
    return this.requestInProgress;
  }

  /**
   * Check if auto-compaction should trigger based on context usage
   */
  private async checkAutoCompaction(): Promise<void> {
    // Don't auto-compact for specialized agents
    if (this.config.isSpecializedAgent) {
      return;
    }

    // Get TokenManager (instance variable)
    if (typeof this.tokenManager.getContextUsagePercentage !== 'function') {
      return;
    }

    // Check current context usage
    const contextUsage = this.tokenManager.getContextUsagePercentage();
    const threshold = this.config.config.compact_threshold || CONTEXT_THRESHOLDS.CRITICAL;

    // Only compact if we exceed threshold and have enough messages
    if (contextUsage < threshold || this.messages.length < BUFFER_SIZES.MIN_MESSAGES_FOR_COMPACTION) {
      return;
    }

    logger.info('[AGENT_AUTO_COMPACT]', this.instanceId, `Context at ${contextUsage}%, threshold ${threshold}% - triggering auto-compaction`);

    try {
      // Emit compaction start event
      this.emitEvent({
        id: this.generateId(),
        type: ActivityEventType.AUTO_COMPACTION_START,
        timestamp: Date.now(),
        data: {},
      });

      // Perform compaction
      const compacted = await this.performCompaction();

      // Update messages
      this.messages = compacted;

      // Update token count
      this.tokenManager.updateTokenCount(this.messages);

      const newContextUsage = this.tokenManager.getContextUsagePercentage();

      // Emit compaction complete event with notice data and compacted messages
      this.emitEvent({
        id: this.generateId(),
        type: ActivityEventType.AUTO_COMPACTION_COMPLETE,
        timestamp: Date.now(),
        data: {
          oldContextUsage: contextUsage,
          newContextUsage,
          threshold,
          compactedMessages: this.messages,
        },
      });

      logger.info('[AGENT_AUTO_COMPACT]', this.instanceId, `Auto-compaction complete - Context now at ${newContextUsage}%`);
    } catch (error) {
      logger.error('[AGENT_AUTO_COMPACT]', this.instanceId, 'Auto-compaction failed:', error);
    }
  }

  /**
   * Perform conversation compaction
   * Similar to CommandHandler's compactConversation but simplified
   */
  private async performCompaction(): Promise<Message[]> {
    // Extract system message and other messages
    const systemMessage = this.messages[0]?.role === 'system' ? this.messages[0] : null;
    const otherMessages = systemMessage ? this.messages.slice(1) : this.messages;

    // If we have fewer than 2 messages to summarize, nothing to compact
    if (otherMessages.length < BUFFER_SIZES.MIN_MESSAGES_FOR_HISTORY) {
      return this.messages;
    }

    // Find the last user message (the one that triggered compaction)
    const lastUserMessage = [...otherMessages].reverse().find(m => m.role === 'user');

    // Messages to summarize: everything except the last user message
    const messagesToSummarize = lastUserMessage
      ? otherMessages.slice(0, otherMessages.lastIndexOf(lastUserMessage))
      : otherMessages;

    // Create summarization request
    const summarizationRequest: Message[] = [];

    // Add system message for summarization
    summarizationRequest.push({
      role: 'system',
      content:
        'You are an AI assistant helping to summarize a conversation while preserving critical context for ongoing work. ' +
        'Focus heavily on:\n' +
        '• UNRESOLVED ISSUES: Any bugs, errors, or problems currently being investigated or fixed\n' +
        '• DEBUGGING CONTEXT: Error messages, stack traces, failed attempts, and partial solutions\n' +
        '• CURRENT INVESTIGATION: What is being analyzed, hypotheses being tested, next steps planned\n' +
        '• TECHNICAL STATE: File paths, function names, variable values, configuration details relevant to ongoing work\n' +
        '• ATTEMPTED SOLUTIONS: What has been tried and why it didn\'t work\n' +
        '• BREAKTHROUGH FINDINGS: Recent discoveries or insights that advance the investigation\n\n' +
        'Be extremely detailed about ongoing problems but brief about completed/resolved topics. ' +
        'Use bullet points and preserve specific technical details (file paths, error messages, code snippets).',
    });

    // Add messages to be summarized (excluding the last user message)
    summarizationRequest.push(...messagesToSummarize);

    // Build summarization request, including the user's current request if present
    let finalRequest =
      'Summarize this conversation with special attention to any ongoing debugging, ' +
      'problem-solving, or issue resolution. Prioritize unresolved problems, current ' +
      'investigations, and technical context needed to continue work seamlessly. ' +
      'Include specific error messages, file paths, and attempted solutions.';

    if (lastUserMessage) {
      finalRequest += `\n\nThe user's current request that needs a response is: "${lastUserMessage.content}"`;
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

    // Add summary as system message if we got one
    if (summary && summary !== 'Conversation history has been compacted to save context space.') {
      compacted.push({
        role: 'system',
        content: `CONVERSATION SUMMARY (auto-compacted at ${new Date().toLocaleTimeString()}): ${summary}`,
      });
    }

    // Add the last user message (the one that triggered compaction) so the model can respond to it
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

  /**
   * Generate a unique ID for events
   */
  private generateId(): string {
    // Generate agent ID: agent-{timestamp}-{7-char-random} (base-36, skip '0.' prefix)
    return `agent-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  }

  /**
   * Cancel any ongoing request
   */
  cancel(): void {
    if (this.modelClient.cancel) {
      this.modelClient.cancel();
    }
  }

  /**
   * Cleanup resources
   *
   * NOTE: Subagents share the ModelClient with the main agent, so they should
   * NOT close it. Only the main agent should close the shared client.
   */
  async cleanup(): Promise<void> {
    logger.debug('[AGENT_CLEANUP]', this.instanceId, 'Cleanup started');

    // Stop activity watchdog
    this.stopActivityWatchdog();

    // Only close the model client if this is NOT a specialized subagent
    // Subagents share the client and shouldn't close it
    if (!this.config.isSpecializedAgent && this.modelClient.close) {
      await this.modelClient.close();
    }

    logger.debug('[AGENT_CLEANUP]', this.instanceId, 'Cleanup completed');
  }
}
