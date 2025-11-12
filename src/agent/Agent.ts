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
import { ResponseProcessor, ResponseContext } from './ResponseProcessor.js';
import { SessionPersistence } from './SessionPersistence.js';
import { AgentCompactor } from './AgentCompactor.js';
import { ContextCoordinator } from './ContextCoordinator.js';
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

  // Response processing - delegated to ResponseProcessor
  private responseProcessor: ResponseProcessor;

  // Session persistence - delegated to SessionPersistence
  private sessionPersistence: SessionPersistence;

  // Compaction - delegated to AgentCompactor
  private agentCompactor: AgentCompactor;

  // Context coordination - delegated to ContextCoordinator
  private contextCoordinator: ContextCoordinator;

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

    // Create response processor
    this.responseProcessor = new ResponseProcessor(
      this.messageValidator,
      this.activityStream,
      this.interruptionManager,
      this.conversationManager,
      this.requiredToolTracker
    );

    // Create session persistence handler
    this.sessionPersistence = new SessionPersistence(
      this.conversationManager,
      this.instanceId
    );

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

    // Create agent compactor for conversation compaction
    this.agentCompactor = new AgentCompactor(
      modelClient,
      this.conversationManager,
      this.tokenManager,
      activityStream
    );

    // Create context coordinator for context usage tracking
    this.contextCoordinator = new ContextCoordinator(
      this.tokenManager,
      this.conversationManager,
      this.instanceId
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
      this.contextCoordinator.updateTokenCount();
      const initialUsage = this.contextCoordinator.getContextUsagePercentage();
      logger.debug('[AGENT_CONTEXT]', this.instanceId, 'Initial context usage:', initialUsage + '%');
    }

    // Add initial messages if provided (e.g., context files for agents)
    if (config.initialMessages && config.initialMessages.length > 0) {
      this.conversationManager.addMessages(config.initialMessages);
      logger.debug('[AGENT_CONTEXT]', this.instanceId, 'Added', config.initialMessages.length, 'initial messages');

      // Update token count after adding initial messages
      this.contextCoordinator.updateTokenCount();
      const contextUsage = this.contextCoordinator.getContextUsagePercentage();
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
   * Process LLM response (handles interruptions and delegates to ResponseProcessor)
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

    // Delegate to ResponseProcessor for remaining logic
    const context = this.buildResponseContext();
    const result = await this.responseProcessor.processLLMResponse(response, context, isRetry);

    // Check if an interruption happened during ResponseProcessor execution
    // This handles interjections that occur during tool execution or continuation logic
    if (this.interruptionManager.isInterrupted()) {
      const interruptionType = this.interruptionManager.getInterruptionType();

      if (interruptionType === 'interjection') {
        // Preserve partial response from ResponseProcessor if we have content
        if (result && result.trim()) {
          this.conversationManager.addMessage({
            role: 'assistant',
            content: result,
            timestamp: Date.now(),
            metadata: { partial: true },
          });
        }

        // Reset flags
        this.interruptionManager.reset();

        // Resume with continuation call
        logger.debug('[AGENT_INTERJECTION]', this.instanceId, 'Processing interjection after ResponseProcessor, continuing...');
        const continuationResponse = await this.getLLMResponse();

        // Process continuation
        return await this.processLLMResponse(continuationResponse);
      } else {
        // Regular cancel - mark as interrupted for next request
        this.interruptionManager.markRequestAsInterrupted();
        return PERMISSION_MESSAGES.USER_FACING_INTERRUPTION;
      }
    }

    return result;
  }

  /**
   * Build response context for ResponseProcessor
   * Contains callbacks and state needed for response processing
   */
  private buildResponseContext(): ResponseContext {
    return {
      instanceId: this.instanceId,
      isSpecializedAgent: this.config.isSpecializedAgent || false,
      parentCallId: this.config.parentCallId,
      baseAgentPrompt: this.config.baseAgentPrompt,
      generateId: () => this.generateId(),
      autoSaveSession: () => this.autoSaveSession(),
      getLLMResponse: () => this.getLLMResponse(),
      unwrapBatchToolCalls: (toolCalls) => this.unwrapBatchToolCalls(toolCalls),
      executeToolCalls: async (toolCalls, cycles) => {
        // Execute tool calls via orchestrator
        // Permission denied errors need special handling by Agent.ts
        try {
          const results = await this.toolOrchestrator.executeToolCalls(toolCalls, cycles);
          return results;
        } catch (error) {
          // Check if this is a permission denied error that triggered interruption
          if (isPermissionDeniedError(error)) {
            // Get unwrapped tool calls for adding permission denial results
            const unwrappedToolCalls = this.unwrapBatchToolCalls(toolCalls);

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
          }

          // Re-throw to propagate to Agent.ts error handler
          throw error;
        }
      },
      detectCycles: (toolCalls) => this.cycleDetector.detectCycles(toolCalls),
      recordToolCalls: (toolCalls, results) => this.cycleDetector.recordToolCalls(toolCalls, results),
      clearCyclesIfBroken: () => this.cycleDetector.clearIfBroken(),
      clearCurrentTurn: () => this.toolManager.clearCurrentTurn(),
      startToolExecution: () => this.startToolExecution(),
      getContextUsagePercentage: () => this.contextCoordinator.getContextUsagePercentage(),
      contextWarningThreshold: CONTEXT_THRESHOLDS.WARNING,
      cleanupEphemeralMessages: () => this.cleanupEphemeralMessages(),
    };
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
      this.contextCoordinator.updateTokenCount();

      // Auto-save after cleanup
      this.autoSaveSession();
    }
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
   * Delegates to SessionPersistence
   */
  private async autoSaveSession(): Promise<void> {
    await this.sessionPersistence.autoSave();
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

    // Update token count with new message
    this.contextCoordinator.updateTokenCount();

    // Emit context usage update event for real-time UI updates
    // Only emit for main agent, not specialized agents (subagents)
    if (!this.config.isSpecializedAgent) {
      const contextUsage = this.contextCoordinator.getContextUsagePercentage();
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
   * Delegates to AgentCompactor
   */
  private async checkAutoCompaction(): Promise<void> {
    await this.agentCompactor.checkAndPerformAutoCompaction({
      instanceId: this.instanceId,
      isSpecializedAgent: this.config.isSpecializedAgent || false,
      compactThreshold: this.config.config.compact_threshold,
      generateId: () => this.generateId(),
    });
  }

  /**
   * Compact conversation messages with summarization
   *
   * This is the single source of truth for compaction logic, used by both:
   * - Auto-compaction (when context reaches threshold)
   * - Manual /compact command (with optional custom instructions)
   *
   * Delegates to AgentCompactor.
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
    return this.agentCompactor.compactConversation(messages, options);
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
