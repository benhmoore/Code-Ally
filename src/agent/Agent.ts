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
import { FocusManager } from '../services/FocusManager.js';
import { ToolOrchestrator } from './ToolOrchestrator.js';
import { TokenManager } from './TokenManager.js';
import { InterruptionManager } from './InterruptionManager.js';
import { ActivityMonitor } from './ActivityMonitor.js';
import { RequiredToolTracker } from './RequiredToolTracker.js';
import { MessageValidator } from './MessageValidator.js';
import { ConversationManager } from './ConversationManager.js';
import { CycleDetector } from './CycleDetector.js';
import { TurnManager } from './TurnManager.js';
import { ToolResultManager } from '../services/ToolResultManager.js';
import { ConfigManager } from '../services/ConfigManager.js';
import { PermissionManager } from '../security/PermissionManager.js';
import { isPermissionDeniedError } from '../security/PathSecurity.js';
import { Message, ActivityEventType, Config } from '../types/index.js';
import { generateMessageId } from '../utils/id.js';
import { logger } from '../services/Logger.js';
import { formatError } from '../utils/errorUtils.js';
import { POLLING_INTERVALS, TEXT_LIMITS, BUFFER_SIZES, PERMISSION_MESSAGES, PERMISSION_DENIED_TOOL_RESULT, AGENT_CONFIG, ID_GENERATION } from '../config/constants.js';
import { CONTEXT_THRESHOLDS, TOOL_NAMES } from '../config/toolDefaults.js';
import * as crypto from 'crypto';

export interface AgentConfig {
  /** Whether this is a specialized/delegated agent */
  isSpecializedAgent?: boolean;
  /** Whether this agent can manage the global todo list (default: false for specialized agents) */
  allowTodoManagement?: boolean;
  /** Whether this agent can access exploration-only tools (default: true for specialized agents only) */
  allowExplorationTools?: boolean;
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
  /** Maximum duration in minutes the agent should run before wrapping up (optional) */
  maxDuration?: number;
  /** Internal: Unique key for pool matching (used by AgentTool to distinguish custom agents) */
  _poolKey?: string;
  /** Directory to restrict this agent's file operations to (optional) */
  focusDirectory?: string;
  /** Initial messages to add to agent's conversation history (optional) */
  initialMessages?: Message[];
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

  // Request state
  private requestInProgress: boolean = false;

  // Interruption management - delegated to InterruptionManager
  private interruptionManager: InterruptionManager;

  // Context tracking (isolated per agent)
  private tokenManager: TokenManager;
  private toolResultManager: ToolResultManager; // ToolResultManager instance

  // Agent instance ID for debugging
  private readonly instanceId: string;

  // Activity monitoring - detects agents stuck generating tokens without tool calls
  private activityMonitor: ActivityMonitor;

  // Required tool calls tracking - delegated to RequiredToolTracker
  private requiredToolTracker: RequiredToolTracker;

  // Message validation - delegated to MessageValidator
  private messageValidator: MessageValidator;

  // Conversation management - delegated to ConversationManager
  private conversationManager: ConversationManager;

  // Cycle detection - delegated to CycleDetector
  private cycleDetector: CycleDetector;

  // Turn management - delegated to TurnManager
  private turnManager: TurnManager;

  // Timeout continuation tracking - counts attempts to continue after activity timeout
  private timeoutContinuationAttempts: number = 0;

  // Focus management - tracks if this agent set focus and needs to restore it
  private previousFocus: string | null = null;
  private didSetFocus: boolean = false;
  private focusReady: Promise<void> | null = null;

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
    this.instanceId = `agent-${Date.now()}-${Math.random().toString(ID_GENERATION.RANDOM_STRING_RADIX).substring(ID_GENERATION.RANDOM_STRING_SUBSTRING_START, ID_GENERATION.RANDOM_STRING_SUBSTRING_START + ID_GENERATION.RANDOM_STRING_LENGTH_SHORT)}`;
    logger.debug('[AGENT_CONTEXT]', this.instanceId, 'Created - isSpecialized:', config.isSpecializedAgent || false, 'parentCallId:', config.parentCallId || 'none');

    // Create conversation manager
    this.conversationManager = new ConversationManager({
      instanceId: this.instanceId,
      initialMessages: [], // Will add system prompt and initial messages below
    });
    logger.debug('[AGENT_CONTEXT]', this.instanceId, 'ConversationManager created');

    // Create cycle detector
    this.cycleDetector = new CycleDetector({
      maxHistory: AGENT_CONFIG.MAX_TOOL_HISTORY,
      cycleThreshold: AGENT_CONFIG.CYCLE_THRESHOLD,
      instanceId: this.instanceId,
    });
    logger.debug('[AGENT_CONTEXT]', this.instanceId, 'CycleDetector created');

    // Create turn manager
    this.turnManager = new TurnManager({
      maxDuration: config.maxDuration,
      instanceId: this.instanceId,
    });

    // Initialize turn start time for specialized agents
    if (config.isSpecializedAgent) {
      this.turnManager.startTurn();
    }

    // Create interruption manager
    this.interruptionManager = new InterruptionManager();
    logger.debug('[AGENT_CONTEXT]', this.instanceId, 'InterruptionManager created');

    // Create required tool tracker
    this.requiredToolTracker = new RequiredToolTracker(this.instanceId);
    if (config.requiredToolCalls && config.requiredToolCalls.length > 0) {
      this.requiredToolTracker.setRequired(config.requiredToolCalls);
      logger.debug(`[REQUIRED_TOOLS_DEBUG] Agent ${this.instanceId} configured with required tools:`, config.requiredToolCalls);
    }

    // Create message validator
    this.messageValidator = new MessageValidator({
      maxAttempts: AGENT_CONFIG.MAX_VALIDATION_ATTEMPTS,
      instanceId: this.instanceId,
    });

    // Create activity monitor for detecting agents stuck generating tokens
    // Only enabled for specialized agents (subagents) to detect infinite loops
    const activityTimeoutMs = config.config.tool_call_activity_timeout * 1000;
    this.activityMonitor = new ActivityMonitor({
      timeoutMs: activityTimeoutMs,
      checkIntervalMs: POLLING_INTERVALS.AGENT_WATCHDOG,
      enabled: config.isSpecializedAgent === true && activityTimeoutMs > 0,
      instanceId: this.instanceId,
      onTimeout: (elapsedMs: number) => {
        this.handleActivityTimeout(elapsedMs);
      },
    });

    if (config.isSpecializedAgent && activityTimeoutMs > 0) {
      logger.debug('[AGENT_CONTEXT]', this.instanceId, 'Activity monitor enabled:', activityTimeoutMs, 'ms');
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

    // Setup focus if focusDirectory is provided
    if (config.focusDirectory) {
      // Store the promise so tool execution can wait for focus to be ready
      this.focusReady = this.setupFocus(config.focusDirectory).catch(error => {
        logger.warn('[AGENT_FOCUS]', this.instanceId, 'Async focus setup failed:', error);
      });
    }

    // Initialize with system prompt if provided
    if (config.systemPrompt) {
      const systemMessage = {
        role: 'system' as const,
        content: config.systemPrompt,
      };
      this.conversationManager.addMessage(systemMessage);
      logger.debug('[AGENT_CONTEXT]', this.instanceId, 'System prompt added, length:', config.systemPrompt.length);

      // Emit system prompt event if configured
      // Use setImmediate to ensure UI listeners are attached first
      if (config.config.show_system_prompt_in_chat) {
        const agentType = config.isSpecializedAgent
          ? (config.baseAgentPrompt?.includes('Explore') ? 'Explore Agent'
             : config.baseAgentPrompt?.includes('Plan') ? 'Plan Agent'
             : 'Specialized Agent')
          : 'Main Agent (Ally)';

        setImmediate(() => {
          activityStream.emit({
            id: crypto.randomUUID(),
            type: ActivityEventType.SYSTEM_PROMPT_DISPLAY,
            timestamp: Date.now(),
            data: {
              agentType,
              systemPrompt: config.systemPrompt,
              instanceId: this.instanceId,
            },
          });
          logger.debug('[AGENT_CONTEXT]', this.instanceId, 'System prompt event emitted');
        });
      }

      // Update token count with initial system message
      this.tokenManager.updateTokenCount(this.conversationManager.getMessages());
      const initialUsage = this.tokenManager.getContextUsagePercentage();
      logger.debug('[AGENT_CONTEXT]', this.instanceId, 'Initial context usage:', initialUsage + '%');
    }

    // Add initial messages if provided (e.g., context files for agents)
    if (config.initialMessages && config.initialMessages.length > 0) {
      this.conversationManager.addMessages(config.initialMessages);
      logger.debug('[AGENT_CONTEXT]', this.instanceId, 'Added', config.initialMessages.length, 'initial messages');

      // Update token count after adding initial messages
      this.tokenManager.updateTokenCount(this.conversationManager.getMessages());
      const contextUsage = this.tokenManager.getContextUsagePercentage();
      logger.debug('[AGENT_CONTEXT]', this.instanceId, 'Context usage after initial messages:', contextUsage + '%');
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
   * Get the tool orchestrator (used by agent_ask to update parent call ID)
   */
  getToolOrchestrator(): ToolOrchestrator {
    return this.toolOrchestrator;
  }

  /**
   * Get the interruption manager (used by ToolOrchestrator for permission denial handling)
   */
  getInterruptionManager(): InterruptionManager {
    return this.interruptionManager;
  }


  /**
   * Reset the tool call activity timer
   * Called by ToolOrchestrator when a tool call is executed
   */
  resetToolCallActivity(): void {
    this.activityMonitor.recordActivity();
  }

  /**
   * Start activity monitoring
   *
   * Monitors specialized agents (subagents) for token generation without tool calls.
   * If no tool calls occur within the timeout period, the agent is interrupted.
   */
  private startActivityMonitoring(): void {
    this.activityMonitor.start();
  }

  /**
   * Stop activity monitoring
   */
  private stopActivityMonitoring(): void {
    this.activityMonitor.stop();
  }

  /**
   * Handle activity timeout by interrupting the agent
   *
   * This is invoked by ActivityMonitor when timeout is detected.
   *
   * @param elapsedMs - Milliseconds elapsed since last activity
   */
  private handleActivityTimeout(elapsedMs: number): void {
    const elapsedSeconds = Math.round(elapsedMs / 1000);

    // Check if we should attempt continuation or fail completely
    const canContinue = this.timeoutContinuationAttempts < BUFFER_SIZES.AGENT_TIMEOUT_MAX_CONTINUATIONS;

    // Set interruption context
    this.interruptionManager.setInterruptionContext({
      reason: canContinue
        ? `Activity timeout: no tool calls for ${elapsedSeconds} seconds (attempt ${this.timeoutContinuationAttempts + 1}/${BUFFER_SIZES.AGENT_TIMEOUT_MAX_CONTINUATIONS})`
        : `Agent stuck: no tool calls for ${elapsedSeconds} seconds (max continuation attempts exceeded)`,
      isTimeout: true,
      canContinueAfterTimeout: canContinue,
    });

    // Interrupt current request (cancels LLM streaming)
    this.interrupt();

    // Only stop monitoring if we're failing completely
    // Otherwise, monitoring will restart when we retry
    if (!canContinue) {
      this.stopActivityMonitoring();
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
    // Wait for focus to be ready if it was set during construction
    if (this.focusReady) {
      await this.focusReady;
      this.focusReady = null; // Clear after first use
    }

    // Start activity monitoring for specialized agents
    this.startActivityMonitoring();

    // Clear tool call cycle history on new user input
    this.cycleDetector.clearHistory();

    // Reset timeout continuation counter on new user input
    this.timeoutContinuationAttempts = 0;

    // Reset turn start time for specialized agents on each new turn
    if (this.config.isSpecializedAgent && this.turnManager.getMaxDuration() !== undefined) {
      this.turnManager.resetTurn();
    }

    // Parse and activate/deactivate plugins from the message
    try {
      const registry = ServiceRegistry.getInstance();
      const activationManager = registry.getPluginActivationManager();
      const { activated, deactivated } = activationManager.parseAndActivateTags(message);

      // Build system message if any plugins were activated or deactivated
      const messageParts: string[] = [];
      if (activated.length > 0) {
        messageParts.push(`Activated plugins: ${activated.join(', ')}`);
      }
      if (deactivated.length > 0) {
        messageParts.push(`Deactivated plugins: ${deactivated.join(', ')}`);
      }

      if (messageParts.length > 0) {
        const systemMessage: Message = {
          role: 'system',
          content: `[System: ${messageParts.join('. ')}. Tools from active plugins are now available.]`,
          timestamp: Date.now(),
        };
        this.conversationManager.addMessage(systemMessage);
      } else {
        logger.debug('[AGENT_PLUGIN_ACTIVATION] No plugins activated or deactivated from tags');
      }
    } catch (error) {
      // If PluginActivationManager is not registered, just log and continue
      // This ensures backward compatibility and doesn't break existing functionality
      logger.debug(
        `[AGENT_PLUGIN_ACTIVATION] Could not parse plugin tags: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }

    // Add user message
    const userMessage: Message = {
      role: 'user',
      content: message,
      timestamp: Date.now(),
    };
    this.conversationManager.addMessage(userMessage);

    // If the previous request was interrupted, add a system reminder
    if (this.interruptionManager.wasRequestInterrupted()) {
      const systemReminder: Message = {
        role: 'system',
        content: '<system-reminder>\nUser interrupted. Prioritize answering their new prompt over continuing your todo list. After responding, reassess if the todo list is still relevant. Do not blindly continue with pending todos.\n</system-reminder>',
        timestamp: Date.now(),
      };
      this.conversationManager.addMessage(systemReminder);
      logger.debug('[AGENT_INTERRUPTION]', this.instanceId, 'Injected system reminder after interruption');

      // Reset the flag after injecting the reminder
      this.interruptionManager.clearWasInterrupted();
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
          reminderContent += 'Todo list empty. For multi-step tasks, use todo_add to track progress.\n';
        } else {
          reminderContent += 'Current todos:\n';
          todos.forEach((todo: any, idx: number) => {
            const status = todo.status === 'completed' ? 'DONE' : todo.status === 'in_progress' ? 'ACTIVE' : 'PENDING';
            reminderContent += `${idx + 1}. [${status}] ${todo.task}\n`;
          });

          const inProgressTodo = todos.find((t: any) => t.status === 'in_progress');
          if (inProgressTodo) {
            reminderContent += `\nCurrently working on: "${inProgressTodo.task}". Stay focused unless blocked.\n`;
          }

          reminderContent += '\nKeep list clean: remove irrelevant tasks, maintain ONE in_progress task.\n';
          reminderContent += 'Update list now if needed based on user request.\n';
        }

        reminderContent += '</system-reminder>';

        const systemReminder: Message = {
          role: 'system',
          content: reminderContent,
          timestamp: Date.now(),
        };
        this.conversationManager.addMessage(systemReminder);
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
        instanceId: this.instanceId,
        agentName: this.config.baseAgentPrompt ? 'specialized' : 'main',
      },
    });

    try {
      // Reset interrupted flag and mark request in progress
      this.interruptionManager.reset();
      this.requestInProgress = true;

      // Send to LLM and process response
      const response = await this.getLLMResponse();

      // Process response (handles both tool calls and text responses)
      // Note: processLLMResponse handles interruptions internally (both cancel and interjection types)
      const finalResponse = await this.processLLMResponse(response);

      return finalResponse;
    } catch (error) {
      // Treat permission denial as critical interruption
      if (isPermissionDeniedError(error)) {
        // Ensure interruption is marked
        this.interruptionManager.markRequestAsInterrupted();

        // Emit agent end event with interruption
        this.emitEvent({
          id: this.generateId(),
          type: ActivityEventType.AGENT_END,
          timestamp: Date.now(),
          data: {
            interrupted: true,
            isSpecializedAgent: this.config.isSpecializedAgent || false,
            instanceId: this.instanceId,
            agentName: this.config.baseAgentPrompt ? 'specialized' : 'main',
          },
        });

        // Return concise message to user
        return PERMISSION_MESSAGES.USER_FACING_DENIAL;
      }

      if (this.interruptionManager.isInterrupted() || (error instanceof Error && error.message.includes('interrupted'))) {
        // Handle interruption (user cancel or unexpected interruption during error)
        // Note: Activity timeouts are handled in processLLMResponse, not here,
        // because they return successfully with interrupted:true rather than throwing
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
    this.interruptionManager.markRequestAsInterrupted();

    const context = this.interruptionManager.getInterruptionContext();
    const message = context.reason || PERMISSION_MESSAGES.USER_FACING_INTERRUPTION;
    const wasTimeout = context.isTimeout;

    // Clear interruption state
    this.interruptionManager.reset();

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
    this.interruptionManager.cleanup();
    this.stopActivityMonitoring();
  }

  /**
   * Interrupt the current request
   *
   * Called when user presses Ctrl+C or submits a message during an ongoing request.
   * Immediately cancels the LLM request and sets interrupt flag for graceful cleanup.
   *
   * @param type - Type of interruption: 'cancel' (default) or 'interjection'
   */
  interrupt(type: 'cancel' | 'interjection' = 'cancel'): void {
    if (this.requestInProgress) {
      // Set interruption state via InterruptionManager (handles abort controller)
      this.interruptionManager.interrupt(type);

      // Cancel ongoing LLM request immediately
      this.cancel();

      // Stop activity monitoring
      this.stopActivityMonitoring();

      this.emitEvent({
        id: this.generateId(),
        type: ActivityEventType.AGENT_END,
        timestamp: Date.now(),
        data: {
          interrupted: true,
          isSpecializedAgent: this.config.isSpecializedAgent || false,
          instanceId: this.instanceId,
          agentName: this.config.baseAgentPrompt ? 'specialized' : 'main',
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
   * Add user interjection message
   * Called when user submits message mid-response
   */
  addUserInterjection(message: string): void {
    this.conversationManager.addMessage({
      role: 'user',
      content: message,
      timestamp: Date.now(),
      metadata: { isInterjection: true },
    });

    logger.debug('[AGENT_INTERJECTION]', this.instanceId, 'User interjection added:', message.substring(0, 50));
  }

  /**
   * Start tool execution by creating a fresh AbortController
   * Called at the beginning of each tool execution batch
   * @returns AbortSignal for the tool execution
   */
  private startToolExecution(): AbortSignal {
    return this.interruptionManager.startToolExecution();
  }

  /**
   * Get the current tool abort signal
   * Used by ToolOrchestrator to pass signal to tools
   * @returns AbortSignal if available, undefined otherwise
   */
  getToolAbortSignal(): AbortSignal | undefined {
    return this.interruptionManager.getToolAbortSignal();
  }

  /**
   * Get the turn start time for specialized agents
   * Used by ToolOrchestrator to calculate elapsed turn duration
   * @returns Turn start timestamp (ms since epoch) if specialized agent, undefined otherwise
   */
  getTurnStartTime(): number | undefined {
    return this.turnManager.getTurnStartTime();
  }

  /**
   * Get the maximum duration for this agent in minutes
   * Used by ToolOrchestrator to inject time reminder system messages
   * @returns Maximum duration in minutes if set, undefined otherwise
   */
  getMaxDuration(): number | undefined {
    return this.turnManager.getMaxDuration();
  }

  /**
   * Set the maximum duration for this agent in minutes
   * Allows updating the time budget for individual turns (e.g., in agent_ask)
   * @param minutes - Maximum duration in minutes
   */
  setMaxDuration(minutes: number | undefined): void {
    this.turnManager.setMaxDuration(minutes);
  }

  /**
   * Get response from LLM
   *
   * @returns LLM response with potential tool calls
   */
  private async getLLMResponse(): Promise<LLMResponse> {
    // Get function definitions from tool manager
    // Exclude restricted tools based on agent type
    const allowTodoManagement = this.config.allowTodoManagement ?? !this.config.isSpecializedAgent;
    const allowExplorationTools = this.config.allowExplorationTools ?? this.config.isSpecializedAgent ?? false;

    const excludeTools: string[] = [];
    if (!allowTodoManagement) {
      excludeTools.push(...TOOL_NAMES.TODO_MANAGEMENT_TOOLS);
    }
    if (!allowExplorationTools) {
      excludeTools.push(...TOOL_NAMES.EXPLORATION_ONLY_TOOLS);
    }

    const functions = this.toolManager.getFunctionDefinitions(excludeTools.length > 0 ? excludeTools : undefined);

    // Regenerate system prompt with current context (todos, etc.) before each LLM call
    // Works for both main agent and specialized agents
    if (this.conversationManager.getSystemMessage()?.role === 'system') {
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
        updatedSystemPrompt = await getMainSystemPrompt(
          this.tokenManager,
          this.toolResultManager,
          false,
          this.config.config.reasoning_effort
        );
        logger.debug('[AGENT_CONTEXT]', this.instanceId, 'Main agent prompt regenerated with current context');
      }

      this.conversationManager.getSystemMessage()!.content = updatedSystemPrompt;
    }

    // Auto-compaction: check if context usage exceeds threshold
    await this.checkAutoCompaction();

    // Log conversation state before sending to LLM
    logger.debug('[AGENT_CONTEXT]', this.instanceId, 'Sending', this.conversationManager.getMessageCount(), 'messages to LLM');
    if (logger.isDebugEnabled()) {
      this.conversationManager.getMessages().forEach((msg, idx) => {
        const preview = msg.content.length > TEXT_LIMITS.MESSAGE_PREVIEW_MAX ? msg.content.slice(0, TEXT_LIMITS.MESSAGE_PREVIEW_MAX - 3) + '...' : msg.content;
        const toolInfo = msg.tool_calls ? ` toolCalls:${msg.tool_calls.length}` : '';
        const toolCallId = msg.tool_call_id ? ` toolCallId:${msg.tool_call_id}` : '';
        logger.debug(`  [${idx}] ${msg.role}${toolInfo}${toolCallId} - ${preview}`);
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
      const response = await this.modelClient.send(this.conversationManager.getMessages(), {
        functions,
        // Disable streaming for subagents - only main agent should stream responses
        stream: !this.config.isSpecializedAgent && this.config.config.parallel_tools,
      });

      // Remove system-reminder messages after receiving response
      // These are temporary context hints that should not persist
      const removedCount = this.conversationManager.removeSystemReminders();
      if (removedCount > 0) {
        logger.debug('[AGENT_INTERRUPTION]', this.instanceId, 'Removed system reminder after LLM response');
      }

      return response;
    } catch (error) {
      // Remove system-reminder messages even on error
      // These should not persist in conversation history
      this.conversationManager.removeSystemReminders();

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
    if (this.interruptionManager.isInterrupted() || response.interrupted) {
      // Handle interjection vs cancellation
      if (this.interruptionManager.getInterruptionType() === 'interjection') {
        // Preserve partial response if we have content
        if (response.content || response.tool_calls) {
          this.conversationManager.addMessage({
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
            metadata: { partial: true },
          });
        }

        // Reset flags
        this.interruptionManager.reset();

        // Resume with continuation call
        logger.debug('[AGENT_INTERJECTION]', this.instanceId, 'Processing interjection, continuing...');
        const continuationResponse = await this.getLLMResponse();

        // Emit the full response from the continuation if present
        // This ensures the response is visible even for subagents with hideOutput=true
        const responseContent = continuationResponse.content?.trim();
        if (responseContent) {
          logger.debug('[AGENT_INTERJECTION]', this.instanceId, 'Interjection response:', responseContent.substring(0, 100));

          this.emitEvent({
            id: this.generateId(),
            type: ActivityEventType.INTERJECTION_ACKNOWLEDGMENT,
            timestamp: Date.now(),
            parentId: this.config.parentCallId, // Set for subagents, undefined for main agent
            data: {
              acknowledgment: responseContent,
              agentType: this.config.isSpecializedAgent ? 'specialized' : 'main',
            },
          });
        }

        return await this.processLLMResponse(continuationResponse);
      } else {
        // Check if this is a continuation-eligible timeout
        const context = this.interruptionManager.getInterruptionContext();
        const canContinueAfterTimeout = (context as any).canContinueAfterTimeout === true;

        if (canContinueAfterTimeout) {
          // Increment continuation counter
          this.timeoutContinuationAttempts++;
          logger.warn('[AGENT_TIMEOUT_CONTINUATION]', this.instanceId,
            `Attempting continuation ${this.timeoutContinuationAttempts}/${BUFFER_SIZES.AGENT_TIMEOUT_MAX_CONTINUATIONS}`);

          // Add continuation prompt to conversation
          const continuationPrompt: Message = {
            role: 'user',
            content: '<system-reminder>\nYou exceeded the activity timeout without making tool calls. Please continue your work and make progress by calling tools or providing a response.\n</system-reminder>',
            timestamp: Date.now(),
          };
          this.conversationManager.addMessage(continuationPrompt);

          // Reset interruption state and retry
          this.interruptionManager.reset();
          this.requestInProgress = true;

          // Restart activity monitoring
          this.startActivityMonitoring();

          // Get new response from LLM
          logger.debug('[AGENT_TIMEOUT_CONTINUATION]', this.instanceId, 'Requesting continuation after timeout...');
          const continuationResponse = await this.getLLMResponse();

          // Process continuation
          return await this.processLLMResponse(continuationResponse);
        }

        // Regular cancel - mark as interrupted for next request
        this.interruptionManager.markRequestAsInterrupted();
        return PERMISSION_MESSAGES.USER_FACING_INTERRUPTION;
      }
    }

    // GAP 2: Partial response due to HTTP error (mid-stream interruption)
    // Detect partial responses that were interrupted by HTTP 500/503 errors
    // If we have partial content/tool_calls, continue from where we left off
    if (response.error && response.partial && !isRetry) {
      const hasContent = response.content && response.content.trim().length > 0;
      const hasToolCalls = response.tool_calls && response.tool_calls.length > 0;

      if (hasContent || hasToolCalls) {
        logger.debug(`[CONTINUATION] Gap 2: Partial response due to HTTP error - prodding model to continue (content=${hasContent}, toolCalls=${hasToolCalls})`);
        logger.debug('[AGENT_RESPONSE]', this.instanceId, 'Partial response due to HTTP error - attempting continuation');
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

        // Get continuation from LLM
        logger.debug('[AGENT_RESPONSE]', this.instanceId, 'Requesting continuation after partial HTTP error response...');
        const continuationResponse = await this.getLLMResponse();

        // Process continuation (mark as retry to prevent infinite loop)
        return await this.processLLMResponse(continuationResponse, true);
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

      // Get continuation from LLM
      logger.debug('[AGENT_RESPONSE]', this.instanceId, 'Requesting continuation after validation errors...');
      const continuationResponse = await this.getLLMResponse();

      // Process continuation (mark as retry to prevent infinite loop)
      return await this.processLLMResponse(continuationResponse, true);
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
      logger.debug('[AGENT_RESPONSE]', this.instanceId, 'Truly empty response (no content, no tools) - attempting continuation');

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

      // Get continuation from LLM
      logger.debug('[AGENT_RESPONSE]', this.instanceId, 'Requesting continuation after truly empty response...');
      const continuationResponse = await this.getLLMResponse();

      // Process continuation (mark as retry to prevent infinite loop)
      return await this.processLLMResponse(continuationResponse, true);
    }

    if (toolCalls.length > 0) {
      // Check for interruption before processing tools
      if (this.interruptionManager.isInterrupted()) {
        return PERMISSION_MESSAGES.USER_FACING_INTERRUPTION;
      }
      // Reset validation counter on successful response with tool calls
      this.messageValidator.reset();
      // Response contains tool calls
      return await this.processToolResponse(response, toolCalls);
    } else {
      // Reset validation counter on successful text-only response
      this.messageValidator.reset();
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
      thinking: response.thinking,
      timestamp: Date.now(),
    };
    this.conversationManager.addMessage(assistantMessage);

    // Auto-save after assistant message with tool calls
    this.autoSaveSession();

    logger.debug('[AGENT_CONTEXT]', this.instanceId, 'Assistant message with tool calls added. Total messages:', this.conversationManager.getMessageCount());

    // Check context usage for specialized agents (subagents)
    // Enforce stricter limit (WARNING threshold) to ensure room for final summary
    const contextUsage = this.tokenManager.getContextUsagePercentage();
    if (this.config.isSpecializedAgent && contextUsage >= CONTEXT_THRESHOLDS.WARNING) {
      logger.debug('[AGENT_CONTEXT]', this.instanceId, 'Specialized agent at', contextUsage + '% context - blocking tool execution to preserve space for summary');

      // Remove the assistant message with tool calls we just added
      this.conversationManager.getMessages().slice(0, -1); this.conversationManager.setMessages(this.conversationManager.getMessages().slice(0, -1));

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

      // Get final response from LLM (without executing tools)
      logger.debug('[AGENT_CONTEXT]', this.instanceId, 'Requesting final summary from specialized agent...');
      const finalResponse = await this.getLLMResponse();

      return await this.processLLMResponse(finalResponse);
    }

    // Detect cycles BEFORE executing tools
    const cycles = this.cycleDetector.detectCycles(unwrappedToolCalls);
    if (cycles.size > 0) {
      logger.debug('[AGENT_CYCLE_DETECTION]', this.instanceId, `Detected ${cycles.size} potential cycles`);
    }

    // Execute tool calls via orchestrator (pass original calls for unwrapping)
    logger.debug('[AGENT_CONTEXT]', this.instanceId, 'Executing tool calls via orchestrator...');

    // Start tool execution and create abort controller
    this.startToolExecution();

    try {
      await this.toolOrchestrator.executeToolCalls(toolCalls, cycles);
      logger.debug('[AGENT_CONTEXT]', this.instanceId, 'Tool calls completed. Total messages now:', this.conversationManager.getMessageCount());
    } catch (error) {
      // Check if this is a permission denied error that triggered interruption
      if (isPermissionDeniedError(error)) {
        logger.debug('[AGENT_CONTEXT]', this.instanceId, 'Permission denied during tool execution - adding tool results before interruption');

        // Add tool result messages to conversation history so model knows what happened
        // This ensures the conversation is complete before we interrupt
        for (const toolCall of unwrappedToolCalls) {
          const toolResultMessage: Message = {
            role: 'tool',
            tool_call_id: toolCall.id,
            name: toolCall.function.name,
            content: JSON.stringify(PERMISSION_DENIED_TOOL_RESULT),
            timestamp: Date.now(),
          };
          this.conversationManager.addMessage(toolResultMessage);
        }

        logger.debug('[AGENT_CONTEXT]', this.instanceId, 'Added permission denial tool results. Total messages now:', this.conversationManager.getMessageCount());

        // Save session with permission denial context
        this.autoSaveSession();

        throw error; // Re-throw to be caught by sendMessage's error handler
      }
      // Re-throw any other errors
      throw error;
    }

    // Check if agent was interrupted during tool execution
    if (this.interruptionManager.isInterrupted()) {
      logger.debug('[AGENT_CONTEXT]', this.instanceId, 'Agent interrupted during tool execution - stopping follow-up');
      this.interruptionManager.markRequestAsInterrupted();
      return PERMISSION_MESSAGES.USER_FACING_INTERRUPTION;
    }

    // Add tool calls to history for cycle detection (AFTER execution)
    this.cycleDetector.recordToolCalls(unwrappedToolCalls);

    // Check if cycle pattern is broken (3 consecutive different calls)
    this.cycleDetector.clearIfBroken();

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
    this.toolManager.clearCurrentTurn();

    // Check if agent was interrupted before requesting follow-up
    if (this.interruptionManager.isInterrupted()) {
      logger.debug('[AGENT_CONTEXT]', this.instanceId, 'Agent interrupted before follow-up LLM call - stopping');
      this.interruptionManager.markRequestAsInterrupted();
      return PERMISSION_MESSAGES.USER_FACING_INTERRUPTION;
    }

    // Get follow-up response from LLM
    logger.debug('[AGENT_CONTEXT]', this.instanceId, 'Getting follow-up response from LLM...');
    const followUpResponse = await this.getLLMResponse();

    // Recursively process the follow-up (it might contain more tool calls)
    return await this.processLLMResponse(followUpResponse);
  }

  /**
   * Clean up ephemeral messages from conversation history
   * Called after assistant provides final text response for a turn
   * Removes all messages marked as ephemeral
   */
  private cleanupEphemeralMessages(): void {
    const removedCount = this.conversationManager.cleanupEphemeralMessages();

    if (removedCount > 0) {
      logger.debug('[AGENT_EPHEMERAL]', this.instanceId,
        `Cleaned up ${removedCount} ephemeral message(s)`);

      // Update token count after cleanup
      this.tokenManager.updateTokenCount(this.conversationManager.getMessages());

      // Auto-save after cleanup
      this.autoSaveSession();
    }
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
        logger.error('[AGENT_REQUIRED_TOOLS]', this.instanceId, errorMessage);

        const assistantMessage: Message = {
          role: 'assistant',
          content: `[Error: ${errorMessage}]`,
          timestamp: Date.now(),
        };
        this.conversationManager.addMessage(assistantMessage);
        this.autoSaveSession();

        return `[Error: ${errorMessage}]`;
      }

      if (result.shouldWarn) {
        // Send reminder to call required tools
        logger.debug(`[REQUIRED_TOOLS_DEBUG] ⚠ ISSUING WARNING ${result.warningCount}/${result.maxWarnings}`);
        logger.debug(`[REQUIRED_TOOLS_DEBUG] Sending reminder to call: ${result.missingTools.join(', ')}`);

        const reminderMessage = this.requiredToolTracker.createWarningMessage(result.missingTools);
        this.requiredToolTracker.setWarningMessageIndex(this.conversationManager.getMessageCount()); // Track index before push
        this.conversationManager.addMessage(reminderMessage);

        // Get new response from LLM
        logger.debug('[AGENT_REQUIRED_TOOLS]', this.instanceId, 'Requesting LLM to call required tools...');
        const retryResponse = await this.getLLMResponse();

        // Recursively process the response
        return await this.processLLMResponse(retryResponse);
      }

      // All required tools have been called
      if (this.requiredToolTracker.areAllCalled()) {
        logger.debug(`[REQUIRED_TOOLS_DEBUG] ✓ SUCCESS - All required tools have been called`);
        logger.debug('[AGENT_REQUIRED_TOOLS]', this.instanceId, 'All required tools have been called:', this.requiredToolTracker.getCalledTools());

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
        logger.debug('[AGENT_RESPONSE]', this.instanceId, 'Empty response after tool execution - attempting continuation');
        logger.debug(`[AGENT_RESPONSE] Empty response after ${lastMessage.tool_calls?.length || 0} tool calls`);

        // Add continuation prompt
        const continuationPrompt: Message = {
          role: 'user',
          content: '<system-reminder>\nYou just executed tool calls but did not provide any response. Please provide your response now based on the tool results.\n</system-reminder>',
          timestamp: Date.now(),
        };
        this.conversationManager.addMessage(continuationPrompt);

        // Get continuation from LLM
        logger.debug('[AGENT_RESPONSE]', this.instanceId, 'Requesting continuation after empty response...');
        const retryResponse = await this.getLLMResponse();

        // Process retry (mark as retry to prevent infinite loop)
        return await this.processLLMResponse(retryResponse, true);
      } else {
        // Empty response but not after tool execution - just log debug
        logger.debug('[AGENT_RESPONSE]', this.instanceId, 'Model returned empty content');
      }
    } else if (!content.trim() && isRetry) {
      // Still empty after continuation attempt - use fallback
      logger.error('[AGENT_RESPONSE]', this.instanceId, 'Still empty after continuation attempt - using fallback message');
      const fallbackContent = this.config.isSpecializedAgent
        ? 'Task completed. Tool results are available in the conversation history.'
        : 'I apologize, but I encountered an issue generating a response. The requested operations have been completed.';

      const assistantMessage: Message = {
        role: 'assistant',
        content: fallbackContent,
        timestamp: Date.now(),
      };
      this.conversationManager.addMessage(assistantMessage);

      // Clean up ephemeral messages BEFORE auto-save
      this.cleanupEphemeralMessages();

      this.autoSaveSession();

      this.emitEvent({
        id: this.generateId(),
        type: ActivityEventType.AGENT_END,
        timestamp: Date.now(),
        data: {
          content: fallbackContent,
          isSpecializedAgent: this.config.isSpecializedAgent || false,
          instanceId: this.instanceId,
          agentName: this.config.baseAgentPrompt ? 'specialized' : 'main',
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
    this.cleanupEphemeralMessages();

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
        instanceId: this.instanceId,
        agentName: this.config.baseAgentPrompt ? 'specialized' : 'main',
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
    // Exclude restricted tools based on agent type
    const allowTodoManagement = this.config.allowTodoManagement ?? !this.config.isSpecializedAgent;
    const allowExplorationTools = this.config.allowExplorationTools ?? this.config.isSpecializedAgent ?? false;

    const excludeTools: string[] = [];
    if (!allowTodoManagement) {
      excludeTools.push(...TOOL_NAMES.TODO_MANAGEMENT_TOOLS);
    }
    if (!allowExplorationTools) {
      excludeTools.push(...TOOL_NAMES.EXPLORATION_ONLY_TOOLS);
    }

    const functions = this.toolManager.getFunctionDefinitions(excludeTools.length > 0 ? excludeTools : undefined);

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
      const hasUserMessages = this.conversationManager.getMessages().some(m => m.role === 'user');
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
    (sessionManager as any).autoSave(this.conversationManager.getMessages(), todos, idleMessages, projectContext).catch((error: Error) => {
      logger.error('[AGENT_SESSION]', this.instanceId, 'Failed to auto-save session:', error);
    });
  }

  /**
   * Add a message to conversation history
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
    this.conversationManager.addMessage(messageWithMetadata);

    // Update TokenManager with new message count
    this.tokenManager.updateTokenCount(this.conversationManager.getMessages());

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
    logger.debug('[AGENT_CONTEXT]', this.instanceId, 'Message added:', message.role, toolInfo, toolCallId, toolName, '- Total messages:', this.conversationManager.getMessageCount());

    // Auto-save session after adding message
    this.autoSaveSession();
  }

  /**
   * Get the current conversation history
   *
   * @returns Array of messages
   */
  getMessages(): Message[] {
    return this.conversationManager.getMessages();
  }

  /**
   * Set messages (used for compaction, rewind, and session loading)
   * @param messages - New message array to replace current messages
   */
  setMessages(messages: Message[]): void {
    // Ensure all messages have IDs
    this.conversationManager.setMessages(messages.map(msg => ({
      ...msg,
      id: msg.id || generateMessageId(),
    })));
    logger.debug('[AGENT_CONTEXT]', this.instanceId, 'Messages set, count:', this.conversationManager.getMessageCount());
  }

  /**
   * Update messages after compaction
   * Used by manual /compact command
   * @param compactedMessages - Compacted message array
   */
  updateMessagesAfterCompaction(compactedMessages: Message[]): void {
    // Ensure all messages have IDs
    this.conversationManager.setMessages(compactedMessages.map(msg => ({
      ...msg,
      id: msg.id || generateMessageId(),
    })));
    logger.debug('[AGENT_CONTEXT]', this.instanceId, 'Messages updated after compaction, count:', this.conversationManager.getMessageCount());
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
    const userMessages = this.conversationManager.getMessages().filter(m => m.role === 'user');

    if (userMessageIndex < 0 || userMessageIndex >= userMessages.length) {
      throw new Error(`Invalid message index: ${userMessageIndex}. Must be between 0 and ${userMessages.length - 1}`);
    }

    // Get the target user message
    const targetMessage = userMessages[userMessageIndex];
    if (!targetMessage) {
      throw new Error(`Target message at index ${userMessageIndex} not found`);
    }

    // Find its position in the full messages array
    const cutoffIndex = this.conversationManager.getMessages().findIndex(
      m => m.role === 'user' && m.timestamp === targetMessage.timestamp && m.content === targetMessage.content
    );

    if (cutoffIndex === -1) {
      throw new Error('Target message not found in conversation history');
    }

    // Preserve system message and truncate to just before the target message
    const systemMessage = this.conversationManager.getSystemMessage()?.role === 'system' ? this.conversationManager.getSystemMessage() : null;
    const truncatedMessages = this.conversationManager.getMessages().slice(systemMessage ? 1 : 0, cutoffIndex);

    // Update messages to the truncated version
    this.conversationManager.setMessages(systemMessage ? [systemMessage, ...truncatedMessages] : truncatedMessages);

    logger.debug('[AGENT_CONTEXT]', this.instanceId, 'Rewound to message', userMessageIndex, '- Total messages now:', this.conversationManager.getMessageCount());

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

    // Check if context usage exceeds threshold (primary concern - do we need to compact?)
    if (contextUsage < threshold) {
      return; // Context not full, no need to compact
    }

    // Context is full - validate we have enough messages for meaningful summarization (quality gate)
    if (this.conversationManager.getMessageCount() < BUFFER_SIZES.MIN_MESSAGES_TO_ATTEMPT_COMPACTION) {
      logger.debug('[AGENT_AUTO_COMPACT]', this.instanceId,
        `Context at ${contextUsage}% (threshold: ${threshold}%) but only ${this.conversationManager.getMessageCount()} messages - ` +
        `too few to compact meaningfully. Consider increasing context_size if this occurs frequently.`);
      return;
    }

    // Both conditions met: context is full AND we have enough messages
    logger.debug('[AGENT_AUTO_COMPACT]', this.instanceId,
      `Context at ${contextUsage}%, threshold ${threshold}% - triggering compaction`);

    try {
      // Emit compaction start event
      this.emitEvent({
        id: this.generateId(),
        type: ActivityEventType.COMPACTION_START,
        timestamp: Date.now(),
        data: {},
      });

      // Perform compaction
      const compacted = await this.performCompaction();

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
        id: this.generateId(),
        type: ActivityEventType.COMPACTION_COMPLETE,
        timestamp: noticeTimestamp,
        data: {
          oldContextUsage: contextUsage,
          newContextUsage,
          threshold,
          compactedMessages: this.conversationManager.getMessages(),
        },
      });

      logger.debug('[AGENT_AUTO_COMPACT]', this.instanceId, `Compaction complete - Context now at ${newContextUsage}%`);
    } catch (error) {
      logger.error('[AGENT_AUTO_COMPACT]', this.instanceId, 'Compaction failed:', error);
    }
  }

  /**
   * Compact conversation messages with summarization
   *
   * This is the single source of truth for compaction logic, used by both:
   * - Auto-compaction (when context reaches threshold)
   * - Manual /compact command (with optional custom instructions)
   *
   * @param messages - Messages to compact (defaults to this.messages)
   * @param options - Compaction options
   * @param options.customInstructions - Optional additional instructions for summarization
   * @param options.preserveLastUserMessage - Whether to preserve the last user message (default: true for auto-compact)
   * @param options.timestampLabel - Label for the summary timestamp (e.g., "auto-compacted" or none for manual)
   * @returns Compacted message array
   */
  async compactConversation(
    messages: Message[] = this.conversationManager.getMessages(),
    options: {
      customInstructions?: string;
      preserveLastUserMessage?: boolean;
      timestampLabel?: string;
    } = {}
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
    // Cleanup happens at end-of-turn (processTextResponse), but compaction can trigger
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
   * Perform conversation compaction (internal auto-compaction)
   * Delegates to compactConversation with auto-compact specific options
   */
  private async performCompaction(): Promise<Message[]> {
    return this.compactConversation(this.conversationManager.getMessages(), {
      preserveLastUserMessage: true,
      timestampLabel: 'auto-compacted',
    });
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
    return `agent-${Date.now()}-${Math.random().toString(ID_GENERATION.RANDOM_STRING_RADIX).substring(ID_GENERATION.RANDOM_STRING_SUBSTRING_START, ID_GENERATION.RANDOM_STRING_SUBSTRING_START + ID_GENERATION.RANDOM_STRING_LENGTH_SHORT)}`;
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
   * Setup focus for this agent
   * Called during constructor if focusDirectory is provided
   */
  private async setupFocus(focusDirectory: string): Promise<void> {
    try {
      const registry = ServiceRegistry.getInstance();
      const focusManager = registry.get<FocusManager>('focus_manager');

      if (!focusManager) {
        logger.warn('[AGENT_FOCUS]', this.instanceId, 'FocusManager not available, skipping focus setup');
        return;
      }

      // Save previous focus state
      this.previousFocus = focusManager.getFocusDirectory();

      // Set new focus
      const result = await focusManager.setFocus(focusDirectory);

      if (result.success) {
        this.didSetFocus = true;
        logger.debug('[AGENT_FOCUS]', this.instanceId, 'Focus set to:', focusDirectory);
      } else {
        logger.warn('[AGENT_FOCUS]', this.instanceId, 'Failed to set focus:', result.message);
      }
    } catch (error) {
      logger.warn('[AGENT_FOCUS]', this.instanceId, 'Error setting up focus:', error);
    }
  }

  /**
   * Restore focus without full cleanup
   *
   * Used for pooled agents that need focus restored but shouldn't be fully cleaned up.
   * This is called before releasing agents back to the pool.
   */
  async restoreFocus(): Promise<void> {
    if (!this.didSetFocus) {
      return; // Nothing to restore
    }

    try {
      const registry = ServiceRegistry.getInstance();
      const focusManager = registry.get<FocusManager>('focus_manager');

      if (focusManager) {
        if (this.previousFocus) {
          await focusManager.setFocus(this.previousFocus);
          logger.debug('[AGENT_FOCUS]', this.instanceId, 'Restored previous focus:', this.previousFocus);
        } else {
          focusManager.clearFocus();
          logger.debug('[AGENT_FOCUS]', this.instanceId, 'Cleared focus');
        }
      }
    } catch (error) {
      logger.warn('[AGENT_FOCUS]', this.instanceId, 'Error restoring focus:', error);
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

    // Stop activity monitoring
    this.stopActivityMonitoring();

    // Clean up ActivityStream listeners to prevent memory leaks
    // This is critical for long-running sessions with many agents
    //
    // WARNING: If this agent shares an ActivityStream with other components
    // (e.g., via AgentPoolService), this will clear ALL listeners from the
    // shared stream. Ensure this agent is the last user of the stream, or
    // use scoped streams (ActivityStream.createScoped()) for isolation.
    if (this.activityStream && typeof this.activityStream.cleanup === 'function') {
      this.activityStream.cleanup();
    }

    // Restore focus
    await this.restoreFocus();

    // Only close the model client if this is NOT a specialized subagent
    // Subagents share the client and shouldn't close it
    if (!this.config.isSpecializedAgent && this.modelClient.close) {
      await this.modelClient.close();
    }

    logger.debug('[AGENT_CLEANUP]', this.instanceId, 'Cleanup completed');
  }
}
