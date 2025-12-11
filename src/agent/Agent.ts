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
import { RequirementValidator } from './RequirementTracker.js';
import { MessageValidator } from './MessageValidator.js';
import { ConversationManager } from './ConversationManager.js';
import { TurnManager } from './TurnManager.js';
import { CheckpointTracker } from './CheckpointTracker.js';
import { ToolResultManager } from '../services/ToolResultManager.js';
import { ConfigManager } from '../services/ConfigManager.js';
import { PermissionManager } from '../security/PermissionManager.js';
import { isPermissionDeniedError } from '../security/PathSecurity.js';
import { ResponseProcessor, ResponseContext } from './ResponseProcessor.js';
import { SessionPersistence } from './SessionPersistence.js';
import { AgentCompactor } from './AgentCompactor.js';
import { AgentLifecycleHandler } from './AgentLifecycleHandler.js';
import { LoopDetector } from './LoopDetector.js';
import { LoopInfo } from './types/loopDetection.js';
import type { LinkedPluginWatcher } from '../plugins/LinkedPluginWatcher.js';
import {
  ReconstructionCyclePattern,
  RepeatedQuestionPattern,
  RepeatedActionPattern,
  CharacterRepetitionPattern,
  PhraseRepetitionPattern,
  SentenceRepetitionPattern,
} from './patterns/loopPatterns.js';
import { Message, ActivityEventType, Config } from '../types/index.js';
import { generateMessageId } from '../utils/id.js';
import { unwrapBatchToolCalls } from '../utils/toolCallUtils.js';
import { logger } from '../services/Logger.js';
import { formatError } from '../utils/errorUtils.js';
import { POLLING_INTERVALS, TEXT_LIMITS, PERMISSION_MESSAGES, PERMISSION_DENIED_TOOL_RESULT, AGENT_CONFIG, ID_GENERATION, TOKEN_MANAGEMENT, THINKING_LOOP_DETECTOR, RESPONSE_LOOP_DETECTOR } from '../config/constants.js';
import {
  createInterruptionReminder,
  createEmptyTodoReminder,
  createActiveTodoReminder,
  createActivityTimeoutContinuationReminder,
  createThinkingLoopContinuationReminder,
} from '../utils/messageUtils.js';
import { CONTEXT_THRESHOLDS, TOOL_NAMES } from '../config/toolDefaults.js';

/**
 * Minimal interface for parent agent references
 *
 * Used by specialized agents to pause/resume their parent's activity monitoring
 * during delegated work execution. This prevents false timeout triggers while
 * the child agent is actively working.
 */
export interface IParentAgent {
  /** Unique instance identifier for debugging */
  readonly instanceId: string;
  /** Pause the agent's activity monitoring timer */
  pauseActivityMonitoring(): void;
  /**
   * Resume the agent's activity monitoring timer
   * @param delegationSucceeded - Whether the delegated work succeeded (default: true)
   *                              true = record progress (reset timer)
   *                              false = don't record progress (preserve timer)
   */
  resumeActivityMonitoring(delegationSucceeded?: boolean): void;
  /** Get the agent's nesting depth (optional, for debugging) */
  getAgentDepth?(): number;
}

/**
 * Execution context for agent invocations
 *
 * Separates per-invocation context from agent identity (AgentConfig).
 * Passed fresh to each sendMessage() call to prevent stale state in pooled agents.
 *
 * @property parentCallId - Parent tool call ID for event nesting (undefined for root agent)
 * @property maxDuration - Maximum duration in minutes for this invocation
 * @property thoroughness - Thoroughness level: 'quick' | 'medium' | 'very thorough' | 'uncapped'
 */
export interface AgentExecutionContext {
  parentCallId?: string;
  maxDuration?: number;
  thoroughness?: string;
}

export interface AgentConfig {
  /** Whether this is a specialized/delegated agent */
  isSpecializedAgent?: boolean;
  /** Whether this agent can manage the global todo list (default: false for specialized agents) */
  allowTodoManagement?: boolean;
  /** Explicit list of allowed tools for this agent (if specified, ONLY these tools are available) */
  allowedTools?: string[];
  /** Enable verbose logging */
  verbose?: boolean;
  /** Base agent prompt for specialized agents (dynamic regeneration in sendMessage) */
  baseAgentPrompt?: string;
  /** Task prompt for specialized agents (for regeneration) */
  taskPrompt?: string;
  /** Application configuration */
  config: Config;
  /**
   * Parent tool call ID (for nested agents)
   * @deprecated Use execution context parameter in sendMessage() instead.
   *             This property is maintained for backward compatibility but will
   *             be removed in a future version. Pass via AgentExecutionContext.
   */
  parentCallId?: string;
  /** Parent agent instance (for activity monitor pause/resume) */
  parentAgent?: IParentAgent;
  /** Required tool calls that must be executed before agent can exit */
  requiredToolCalls?: string[];
  /** Agent requirements specification (new requirements system) */
  requirements?: import('./RequirementTracker.js').AgentRequirements;
  /**
   * Maximum duration in minutes the agent should run before wrapping up (optional)
   * @deprecated Use execution context parameter in sendMessage() instead.
   *             This property is maintained for backward compatibility but will
   *             be removed in a future version. Pass via AgentExecutionContext.
   */
  maxDuration?: number;
  /**
   * Dynamic thoroughness level for agent execution (for regeneration in agent-ask): 'quick', 'medium', 'very thorough', 'uncapped'
   * @deprecated Use execution context parameter in sendMessage() instead.
   *             This property is maintained for backward compatibility but will
   *             be removed in a future version. Pass via AgentExecutionContext.
   */
  thoroughness?: string;
  /** Internal: Unique key for pool matching (used by AgentTool to distinguish custom agents) */
  _poolKey?: string;
  /** Directory to restrict this agent's file operations to (optional) */
  focusDirectory?: string;
  /** Files to exclude from agent access (absolute paths) */
  excludeFiles?: string[];
  /** Initial messages to add to agent's conversation history (optional) */
  initialMessages?: Message[];
  /** Agent type identifier (e.g., 'explore', 'plan', 'agent') */
  agentType?: string;
  /** Nesting depth (0=root, 1-3=delegated agents) */
  agentDepth?: number;
  /** Agent call stack for circular delegation detection (tracks agent names in call chain) */
  agentCallStack?: string[];
  /** Internal: Scoped registry for this agent (shadows global for 'agent' key to prevent race conditions) */
  _scopedRegistry?: any; // ScopedServiceRegistryProxy - typed as 'any' to avoid circular dependency
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
  private readonly appConfig: Config; // Unwrapped application config for cleaner access

  // Agent name from agentType in config (for tool-agent binding)
  private agentName?: string;

  // Request state
  private requestInProgress: boolean = false;
  private agentEndEmitted: boolean = false;

  // Interruption management - delegated to InterruptionManager
  private interruptionManager: InterruptionManager;

  // Parent agent reference (for activity monitor pause/resume)
  private parentAgent: IParentAgent | null = null;

  // Context tracking (isolated per agent)
  private tokenManager: TokenManager;
  private toolResultManager: ToolResultManager; // ToolResultManager instance

  // Agent instance ID for debugging
  private readonly instanceId: string;

  // Agent depth tracking (0=root, 1-3=delegated agents)
  private readonly agentDepth: number;

  // Agent call stack for circular delegation detection
  private readonly agentCallStack: string[];

  // Scoped registry for this agent (prevents race conditions in parallel execution)
  private readonly scopedRegistry?: any; // ScopedServiceRegistryProxy

  // Activity monitoring - detects agents stuck generating tokens without tool calls
  private activityMonitor: ActivityMonitor;

  // Unified loop detection - detects repetitive patterns and tool call cycles
  private loopDetector: LoopDetector;

  // Required tool calls tracking - delegated to RequiredToolTracker
  private requiredToolTracker: RequiredToolTracker;

  // Requirement validation - delegated to RequirementValidator
  private requirementValidator: RequirementValidator;

  // Message validation - delegated to MessageValidator
  private messageValidator: MessageValidator;

  // Conversation management - delegated to ConversationManager
  private conversationManager: ConversationManager;

  // Turn management - delegated to TurnManager
  private turnManager: TurnManager;

  // Response processing - delegated to ResponseProcessor
  private responseProcessor: ResponseProcessor;

  // Session persistence - delegated to SessionPersistence
  private sessionPersistence: SessionPersistence;

  // Compaction - delegated to AgentCompactor
  private agentCompactor: AgentCompactor;

  // Lifecycle handling - idle coordinator, auto-cleanup
  private lifecycleHandler: AgentLifecycleHandler;

  // Timeout continuation tracking - counts attempts to continue after activity timeout
  private timeoutContinuationAttempts: number = 0;

  // Cleanup queue - tool call IDs to remove at end of turn
  // cleanup-call queues IDs here, they're removed after model completes response
  private pendingCleanupIds: string[] = [];

  // Checkpoint reminder tracking - monitors tool calls to inject progress reminders
  private checkpointTracker: CheckpointTracker;

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
    this.appConfig = config.config; // Unwrap application config once

    // Store agent name from agentType in config (for tool-agent binding)
    this.agentName = config.agentType;

    // Store agent depth from config (default to 0 if undefined)
    this.agentDepth = config.agentDepth ?? 0;

    // Store agent call stack from config (default to empty array)
    this.agentCallStack = config.agentCallStack ?? [];

    // Store scoped registry from config (for parallel execution safety)
    this.scopedRegistry = config._scopedRegistry;

    // Generate unique instance ID for debugging: agent-{timestamp}-{7-char-random} (base-36, skip '0.' prefix)
    this.instanceId = `agent-${Date.now()}-${Math.random().toString(ID_GENERATION.RANDOM_STRING_RADIX).substring(ID_GENERATION.RANDOM_STRING_SUBSTRING_START, ID_GENERATION.RANDOM_STRING_SUBSTRING_START + ID_GENERATION.RANDOM_STRING_LENGTH_SHORT)}`;
    logger.debug('[AGENT_CONTEXT]', this.instanceId, 'Created - isSpecialized:', config.isSpecializedAgent || false, 'parentCallId:', config.parentCallId || 'none', 'depth:', this.agentDepth, 'scopedRegistry:', this.scopedRegistry ? 'yes' : 'no');

    // Initialize parent agent reference from config during construction (eager initialization)
    // This is set directly from the config parameter when the agent is created by AgentTool,
    // ensuring proper activity monitor pause/resume coordination between parent and child agents
    this.parentAgent = config.parentAgent ?? null;

    // Validation: warn if specialized agent doesn't have parent
    if (config.isSpecializedAgent && !this.parentAgent) {
      logger.warn('[AGENT_CONTEXT]', this.instanceId, 'Specialized agent created without parent agent - activity monitoring will not pause parent');
    }

    // Create conversation manager
    this.conversationManager = new ConversationManager({
      instanceId: this.instanceId,
      initialMessages: [], // Will add system prompt and initial messages below
    });
    logger.debug('[AGENT_CONTEXT]', this.instanceId, 'ConversationManager created');

    // Connect ToolManager to ConversationManager for file tracking
    this.toolManager.setConversationManager(this.conversationManager);

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

    // Create checkpoint tracker
    this.checkpointTracker = new CheckpointTracker(this.instanceId);

    // Create required tool tracker
    this.requiredToolTracker = new RequiredToolTracker(this.instanceId);
    if (config.requiredToolCalls && config.requiredToolCalls.length > 0) {
      this.requiredToolTracker.setRequired(config.requiredToolCalls);
      logger.debug(`[REQUIRED_TOOLS_DEBUG] Agent ${this.instanceId} configured with required tools:`, config.requiredToolCalls);
    }

    // Create requirement validator
    this.requirementValidator = new RequirementValidator(this.instanceId);
    if (config.requirements) {
      this.requirementValidator.setRequirements(config.requirements);
      logger.debug('[REQUIREMENT_VALIDATOR]', this.instanceId, 'Agent configured with requirements:', config.requirements);
    }

    // Create message validator
    this.messageValidator = new MessageValidator({
      instanceId: this.instanceId,
    });

    // Create response processor
    this.responseProcessor = new ResponseProcessor(
      this.messageValidator,
      this.activityStream,
      this.interruptionManager,
      this.conversationManager,
      this.requiredToolTracker,
      this.requirementValidator
    );

    // Create session persistence handler
    this.sessionPersistence = new SessionPersistence(
      this.conversationManager,
      this.instanceId,
      this.agentDepth
    );

    // Create activity monitor for detecting agents stuck generating tokens
    // Only enabled for specialized agents (subagents) to detect infinite loops
    const activityTimeoutMs = this.appConfig.tool_call_activity_timeout * 1000;
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

    // Create unified loop detector
    this.loopDetector = new LoopDetector({
      instanceId: this.instanceId,
      thinkingLoopConfig: {
        eventType: ActivityEventType.THOUGHT_CHUNK,
        patterns: [
          new ReconstructionCyclePattern(),
          new RepeatedQuestionPattern(),
          new RepeatedActionPattern(),
        ],
        warmupPeriodMs: THINKING_LOOP_DETECTOR.WARMUP_PERIOD_MS,
        checkIntervalMs: THINKING_LOOP_DETECTOR.CHECK_INTERVAL_MS,
        onLoopDetected: (info) => this.handleThinkingLoop(info),
      },
      responseLoopConfig: {
        eventType: ActivityEventType.ASSISTANT_CHUNK,
        patterns: [
          new CharacterRepetitionPattern(),
          new PhraseRepetitionPattern(),
          new SentenceRepetitionPattern(),
        ],
        warmupPeriodMs: RESPONSE_LOOP_DETECTOR.WARMUP_PERIOD_MS,
        checkIntervalMs: RESPONSE_LOOP_DETECTOR.CHECK_INTERVAL_MS,
        onLoopDetected: (info) => this.handleResponseLoop(info),
      },
      maxToolHistory: AGENT_CONFIG.MAX_TOOL_HISTORY,
      cycleThreshold: AGENT_CONFIG.CYCLE_THRESHOLD,
    }, this.activityStream);
    logger.debug('[AGENT_CONTEXT]', this.instanceId, 'LoopDetector created');

    // Create agent's own TokenManager for isolated context tracking
    this.tokenManager = new TokenManager(this.appConfig.context_size);
    logger.debug('[AGENT_CONTEXT]', this.instanceId, 'TokenManager created with context size:', this.appConfig.context_size);

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

    // Create tool orchestrator
    this.toolOrchestrator = new ToolOrchestrator(
      toolManager,
      activityStream,
      this,
      config,
      this.toolResultManager,
      permissionManager
    );

    // Create lifecycle handler for peripheral concerns
    this.lifecycleHandler = new AgentLifecycleHandler(this.instanceId);

    // Setup focus if focusDirectory is provided
    if (config.focusDirectory) {
      // Store the promise so tool execution can wait for focus to be ready
      this.focusReady = this.setupFocus(config.focusDirectory).catch(error => {
        logger.warn('[AGENT_FOCUS]', this.instanceId, 'Async focus setup failed:', error);
      });
    }

    // System prompt is generated dynamically in sendMessage() with current context (todos, token usage, etc.)
    // This ensures resumed sessions and pooled agents always have proper system prompts

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
   * Get the unique instance identifier for this agent
   */
  public getInstanceId(): string {
    return this.instanceId;
  }

  /**
   * Get the current context usage as a percentage (0-100)
   * Used by delegation tools to report context usage in AGENT_END events.
   */
  public getContextUsagePercentage(): number {
    return this.tokenManager.getContextUsagePercentage();
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
   * Get the tool orchestrator (used by agent-ask to update parent call ID)
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
   * Get the agent name (used by ToolOrchestrator for tool-agent binding validation)
   */
  getAgentName(): string | undefined {
    return this.agentName;
  }

  /**
   * Get the scoped registry for this agent (used by ToolOrchestrator for tool execution context)
   */
  getScopedRegistry(): any | undefined {
    return this.scopedRegistry;
  }

  /**
   * Get the agent depth (used by AgentTool for nesting depth tracking)
   */
  getAgentDepth(): number {
    return this.agentDepth;
  }

  /**
   * Get the agent call stack (used by AgentTool for circular delegation detection)
   */
  getAgentCallStack(): string[] {
    return this.agentCallStack;
  }

  /**
   * Get the agent configuration (used by AgentTool for permission checks)
   */
  getAgentConfig(): AgentConfig {
    return this.config;
  }

  /**
   * Get the conversation manager (used by CleanupCallTool for removing tool results)
   */
  getConversationManager(): ConversationManager {
    return this.conversationManager;
  }

  /**
   * Get the conversation history (used by AgentSwitcher for history transfer)
   */
  public getConversationHistory(): Message[] {
    return this.conversationManager.getMessagesCopy();
  }

  /**
   * Load messages into the conversation (used by AgentSwitcher for history transfer)
   * Clears existing messages first, then loads the provided messages
   */
  public async loadMessages(messages: Message[]): Promise<void> {
    // Clear existing messages
    this.conversationManager.clearMessages();

    // Load provided messages
    this.conversationManager.addMessages(messages);

    // Recalculate token count after bulk load
    this.tokenManager.updateTokenCount(this.conversationManager.getMessages());

    logger.debug('[AGENT]', this.instanceId, 'Loaded', messages.length, 'messages');
  }


  /**
   * Queue tool call IDs for cleanup at end of turn
   * Used by cleanup-call tool to defer removals until after model's response completes
   * @param toolCallIds - Tool call IDs to remove
   */
  queueCleanup(toolCallIds: string[]): void {
    this.pendingCleanupIds.push(...toolCallIds);
    logger.debug('[AGENT_CLEANUP]', this.instanceId, 'Queued cleanup for IDs:', toolCallIds);
  }

  /**
   * Execute queued cleanups at end of turn
   * Removes tool results that were marked for cleanup during the turn
   */
  private executePendingCleanups(): void {
    if (this.pendingCleanupIds.length === 0) {
      return;
    }

    const idsToRemove = [...this.pendingCleanupIds];
    this.pendingCleanupIds = [];

    const result = this.conversationManager.removeToolResults(idsToRemove);

    // Recalculate token count after removal
    if (result.removed_count > 0) {
      this.tokenManager.updateTokenCount(this.conversationManager.getMessages());
    }

    logger.debug(
      '[AGENT_CLEANUP]',
      this.instanceId,
      'Executed pending cleanups:',
      result.removed_count,
      'removed,',
      result.not_found_ids.length,
      'not found'
    );
  }

  /**
   * Clear conversation history (used by AgentPoolService when reusing pooled agents)
   *
   * CRITICAL: This must be called when reusing a pooled agent to prevent context
   * seepage from previous tasks. Without this, agents retain their full conversation
   * history including tool calls and results from unrelated previous delegations.
   */
  clearConversationHistory(): void {
    this.conversationManager.clearMessages();
    this.checkpointTracker.reset();
    // Reset token count after clearing
    this.tokenManager.updateTokenCount(this.conversationManager.getMessages());
    logger.debug(`[AGENT] Cleared conversation history for agent ${this.instanceId}`);
  }

  /**
   * Reset agent state for reuse in pool
   *
   * Encapsulates all cleanup logic required when returning an agent to the pool
   * for reuse. This is the single source of truth for agent reset operations.
   *
   * Clears:
   * - Conversation history (messages, checkpoint tracking, token count)
   * - Nested delegation contexts (prevents routing to stale agent instances)
   * - Per-invocation state (timeouts, exploratory streaks, cleanup queue)
   * - Loop detectors (thinking and response loop detection)
   * - Interruption state
   *
   * Does NOT reset:
   * - Agent configuration (isSpecializedAgent, allowedTools, etc.)
   * - Agent identity (instanceId, agentDepth, agentCallStack)
   * - Service dependencies (modelClient, toolManager, activityStream)
   * - Readonly properties (agentDepth, agentCallStack, scopedRegistry)
   *
   * CRITICAL: This prevents context pollution when reusing pooled agents.
   * System prompts and execution contexts are regenerated fresh on each invocation.
   */
  resetForReuse(): void {
    // Clear conversation history (includes checkpoint tracking and token count)
    this.clearConversationHistory();

    // NOTE: Do NOT call delegationManager.clearAll() here!
    // The delegation manager is global/shared, so clearAll() would clear OTHER agents' delegations.
    // Individual delegation contexts are cleared via transitionToCompleting() and clear() when each
    // delegation completes in the tool code (AgentTool, BaseDelegationTool, etc.)

    // Reset per-invocation state counters
    this.timeoutContinuationAttempts = 0;
    this.toolOrchestrator.resetExploratoryStreak();
    this.pendingCleanupIds = [];

    // Reset ALL loop detection (text patterns + tool cycle history)
    this.loopDetector.reset();

    // Reset interruption state
    this.interruptionManager.reset();

    // Reset request state flags
    this.requestInProgress = false;
    this.agentEndEmitted = false;

    // Reset turn timing for fresh invocation
    this.turnManager.clearTurn();

    // Reset focus state for pool reuse (prevents context seepage)
    this.didSetFocus = false;
    this.previousFocus = null;
    this.focusReady = null;

    logger.debug(`[AGENT] Reset agent ${this.instanceId} for reuse`);
  }

  /**
   * Reset the tool call activity timer
   * Called by ToolOrchestrator when a tool call is executed
   */
  resetToolCallActivity(): void {
    this.activityMonitor.recordActivity();
  }

  /**
   * Pause activity monitoring
   *
   * Temporarily pauses the activity watchdog timer while preserving the last activity time.
   * This should be used when waiting for delegated work (e.g., nested agent execution) to
   * prevent false timeout triggers while the delegated agent is actively working.
   *
   * Safe to call multiple times - subsequent calls are ignored if already paused.
   */
  pauseActivityMonitoring(): void {
    this.activityMonitor.pause();
  }

  /**
   * Resume activity monitoring
   *
   * Resumes the activity watchdog timer after delegated work completes.
   * This should be called when delegated work finishes to continue monitoring
   * the parent agent for activity timeouts.
   *
   * Safe to call multiple times - subsequent calls are ignored if already running.
   *
   * @param delegationSucceeded - Whether the delegated work succeeded (default: true)
   *                              true = record progress (reset timer)
   *                              false = don't record progress (preserve timer)
   */
  resumeActivityMonitoring(delegationSucceeded: boolean = true): void {
    this.activityMonitor.resume(delegationSucceeded);
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
   * Unified handler for interruption events (timeouts, loops)
   * Prevents double interruption and sets appropriate context
   */
  private handleInterruptionEvent(tag: string, reason: string, isTimeout: boolean): void {
    if (this.interruptionManager.isInterrupted()) {
      logger.debug(tag, this.instanceId, 'Already interrupted, skipping handler');
      return;
    }

    logger.debug(tag, this.instanceId, reason);

    this.interruptionManager.setInterruptionContext({
      reason,
      isTimeout,
      canContinueAfterTimeout: true,
    });

    this.interrupt();
  }

  /** Handle activity timeout - invoked by ActivityMonitor */
  private handleActivityTimeout(elapsedMs: number): void {
    const elapsedSeconds = Math.round(elapsedMs / 1000);
    this.handleInterruptionEvent(
      '[AGENT_TIMEOUT]',
      `Activity timeout: no tool calls for ${elapsedSeconds} seconds`,
      true
    );
  }

  /** Handle thinking loop - invoked by LoopDetector */
  private handleThinkingLoop(info: LoopInfo): void {
    this.handleInterruptionEvent('[THINKING_LOOP]', `Thinking loop: ${info.reason}`, false);
  }

  /** Handle response loop - invoked by LoopDetector */
  private handleResponseLoop(info: LoopInfo): void {
    this.handleInterruptionEvent('[RESPONSE_LOOP]', `Response loop: ${info.reason}`, false);
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
   * @param executionContext - Optional execution context for this invocation
   * @returns Promise resolving to the assistant's final response
   */
  async sendMessage(
    message: string,
    executionContext?: AgentExecutionContext,
    images?: string[]
  ): Promise<string> {
    // Check for linked plugin changes on root agent prompts only
    if (this.agentDepth === 0) {
      await this.checkLinkedPluginsForChanges();
    }

    // Extract execution context (prefer parameter, fallback to config for backward compatibility)
    const parentCallId = executionContext?.parentCallId ?? this.config.parentCallId;
    const maxDuration = executionContext?.maxDuration ?? this.config.maxDuration;
    const thoroughness = executionContext?.thoroughness ?? this.config.thoroughness;

    // Update ToolOrchestrator with fresh parentCallId for pooled agent reuse
    if (parentCallId) {
      this.toolOrchestrator.setParentCallId(parentCallId);
    }

    // Runtime assertion: catch depth corruption bugs early
    // This should never happen if AgentTool validates depth correctly,
    // but if it does happen, fail fast with a clear error
    if (this.agentDepth > AGENT_CONFIG.MAX_AGENT_DEPTH) {
      throw new Error(`Agent depth corruption detected: ${this.agentDepth} exceeds maximum ${AGENT_CONFIG.MAX_AGENT_DEPTH}`);
    }

    // Wait for focus to be ready if it was set during construction
    if (this.focusReady) {
      await this.focusReady;
      this.focusReady = null; // Clear after first use
    }

    // Pause parent agent's activity monitoring before sub-agent execution
    // This prevents false timeout triggers while the sub-agent is actively working
    if (this.parentAgent) {
      this.parentAgent.pauseActivityMonitoring();
      logger.debug('[AGENT]', this.instanceId,
        `Pausing parent agent activity monitoring (parent: ${this.parentAgent.instanceId})`);
    }

    // Start activity monitoring for specialized agents
    this.startActivityMonitoring();

    // Reset all loop detection (tool cycles and text loops) on new user input
    this.loopDetector.reset();

    // Reset timeout continuation counter on new user input
    this.timeoutContinuationAttempts = 0;

    // Reset exploratory tool streak on new user input
    this.toolOrchestrator.resetExploratoryStreak();

    // Reset cleanup queue on new user input
    this.pendingCleanupIds = [];

    // Reset checkpoint counters at turn start
    // Ensures counters only track within this turn, not across turns
    // Counters accumulate across all tool calls in this turn (including continuation loops)
    this.checkpointTracker.reset();

    // Reset turn start time for specialized agents on each new turn
    if (this.config.isSpecializedAgent && this.turnManager.getMaxDuration() !== undefined) {
      this.turnManager.resetTurn();
    }

    // Parse and activate/deactivate plugins from the message
    const { systemMessage } = this.lifecycleHandler.parsePluginActivations(message);
    if (systemMessage) {
      this.conversationManager.addMessage(systemMessage);
    }

    // Notify lifecycle services about user message
    this.lifecycleHandler.notifyUserMessageStart();

    // Capture user prompt for this turn
    // Used for checkpoint reminders to remind agent of current turn's goal
    // Updated each turn since user messages provide natural cross-turn checkpoints
    this.checkpointTracker.setInitialPrompt(message);

    // Add user message
    const userMessage: Message = {
      role: 'user',
      content: message,
      timestamp: Date.now(),
      images,
    };
    this.conversationManager.addMessage(userMessage);

    // If the previous request was interrupted, add a system reminder
    if (this.interruptionManager.wasRequestInterrupted()) {
      // PERSIST: false - Ephemeral, one-time navigation signal after interruption
      const systemReminder = createInterruptionReminder();
      this.conversationManager.addMessage(systemReminder);
      logger.debug('[AGENT_INTERRUPTION]', this.instanceId, 'Injected system reminder after interruption');

      // Reset the flag after injecting the reminder
      this.interruptionManager.clearWasInterrupted();
    }

    // Auto-save after user message
    this.autoSaveSession();

    // Inject system reminder about todos (main agent only, and only if TodoWrite is available)
    // This nudges the model to consider updating the todo list without blocking
    const hasTodoWriteAccess = !this.config.allowedTools || this.config.allowedTools.includes('todo-write');
    if (!this.config.isSpecializedAgent && hasTodoWriteAccess) {
      const registry = ServiceRegistry.getInstance();
      const todoManager = registry.get<any>('todo_manager');

      if (todoManager) {
        const todos = todoManager.getTodos();
        let systemReminder: Message;

        if (todos.length === 0) {
          // PERSIST: false - Ephemeral: Dynamic todo state suggestion
          // Cleaned up after turn since todo list regenerated each message
          systemReminder = createEmptyTodoReminder();
        } else {
          // Build todo summary
          let todoSummary = '';
          todos.forEach((todo: any, idx: number) => {
            const status = todo.status === 'completed' ? 'DONE' : todo.status === 'in_progress' ? 'ACTIVE' : 'PENDING';
            todoSummary += `${idx + 1}. [${status}] ${todo.task}\n`;
          });

          const inProgressTodo = todos.find((t: any) => t.status === 'in_progress');
          const currentTask = inProgressTodo ? inProgressTodo.task : null;
          const guidance = 'Keep list clean: remove irrelevant tasks, maintain ONE in_progress task.\nUpdate list now if needed based on user request.';

          // PERSIST: false - Ephemeral: Current todo list state
          // Cleaned up after turn since todo state is dynamic and updated each message
          systemReminder = createActiveTodoReminder(todoSummary, currentTask, guidance);
        }

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
        agentName: this.config.agentType || 'ally',
      },
    });

    // Track whether delegation succeeded for parent activity monitoring
    // Assume success unless an exception occurs (catches errors/timeouts)
    let delegationSucceeded = true;

    try {
      // Reset interrupted flag and mark request in progress
      this.interruptionManager.reset();
      this.requestInProgress = true;
      this.agentEndEmitted = false;

      // Send to LLM and process response
      const response = await this.getLLMResponse({
        parentCallId,
        maxDuration,
        thoroughness,
      });

      // Process response (handles both tool calls and text responses)
      // Note: processLLMResponse handles interruptions internally (both cancel and interjection types)
      const finalResponse = await this.processLLMResponse(response, {
        parentCallId,
        maxDuration,
        thoroughness,
      });

      // Execute any pending cleanups before returning
      this.executePendingCleanups();

      // Handle post-response lifecycle tasks (idle coordinator, queued cleanups)
      await this.lifecycleHandler.handlePostResponse(
        this.conversationManager.getMessages(),
        (ids) => this.queueCleanup(ids)
      );

      return finalResponse;
    } catch (error) {
      logger.debug('[AGENT]', this.instanceId, 'sendMessage caught exception:', error instanceof Error ? error.message : String(error));
      // Mark delegation as failed for parent activity monitoring
      delegationSucceeded = false;

      // Handle permission denial - check if user provided instructions via INSTRUCT option
      if (isPermissionDeniedError(error)) {
        // Check if there's a pending user interjection (from INSTRUCT option)
        // Expected message order: [assistant with tool_use] → [user interjection] → [tool result: denied]
        // The interjection is added AFTER the assistant message but BEFORE the tool result
        const messages = this.conversationManager.getMessages();
        const lastAssistantIdx = this.findLastAssistantMessageIndex(messages);

        if (this.hasPendingInterjection(messages, lastAssistantIdx)) {
          // User provided instructions via INSTRUCT - continue processing with interjection loop
          return await this.continueWithInterjection({
            parentCallId,
            maxDuration,
            thoroughness,
          });
        }

        // No interjection - treat as critical interruption
        // Ensure interruption is marked
        this.interruptionManager.markRequestAsInterrupted();

        this.emitAgentEnd(true);

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

      // Resume parent agent's activity monitoring after sub-agent completes
      // This must be in finally block to guarantee execution even if sendMessage throws
      // Pass delegationSucceeded to conditionally record progress:
      // - true (default): child completed successfully, parent should record progress
      // - false: child threw error, parent should NOT record progress
      if (this.parentAgent) {
        this.parentAgent.resumeActivityMonitoring(delegationSucceeded);
        logger.debug('[AGENT]', this.instanceId,
          `Resuming parent agent activity monitoring (parent: ${this.parentAgent.instanceId}, succeeded: ${delegationSucceeded})`);
      }
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

    this.emitAgentEnd(true);

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
    this.agentEndEmitted = false;
    this.interruptionManager.cleanup();
    this.stopActivityMonitoring();
    this.loopDetector.stopTextDetectors();
    this.lifecycleHandler.notifyOllamaInactive();
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

      this.emitAgentEnd(true);
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
   * Allows updating the time budget for individual turns (e.g., in agent-ask)
   * @param minutes - Maximum duration in minutes
   */
  setMaxDuration(minutes: number | undefined): void {
    this.turnManager.setMaxDuration(minutes);
  }

  /**
   * Set the thoroughness level for this agent
   * Used by agent-ask to update thoroughness for follow-up interactions
   * @param thoroughness - Thoroughness level: 'quick', 'medium', 'very thorough', or 'uncapped'
   */
  setThoroughness(thoroughness: string | undefined): void {
    // Validate thoroughness value
    if (thoroughness !== undefined) {
      const validValues = ['quick', 'medium', 'very thorough', 'uncapped'];
      if (!validValues.includes(thoroughness)) {
        logger.warn('[AGENT_THOROUGHNESS]', this.instanceId, 'Invalid thoroughness value:', thoroughness, '- ignoring');
        return;
      }
    }

    this.config.thoroughness = thoroughness;
    logger.debug('[AGENT_THOROUGHNESS]', this.instanceId, 'Set thoroughness to:', thoroughness || 'undefined');
  }

  /**
   * Get response from LLM
   *
   * @param executionContext - Execution context for this invocation
   * @returns LLM response with potential tool calls
   */
  private async getLLMResponse(executionContext: AgentExecutionContext): Promise<LLMResponse> {
    // Get function definitions from tool manager
    // Exclude restricted tools based on agent type
    const allowTodoManagement = this.config.allowTodoManagement ?? !this.config.isSpecializedAgent;

    const excludeTools: string[] = [];
    if (!allowTodoManagement) {
      excludeTools.push(...TOOL_NAMES.TODO_MANAGEMENT_TOOLS);
    }

    const functions = this.toolManager.getFunctionDefinitions(
      excludeTools.length > 0 ? excludeTools : undefined,
      this.agentName,  // Pass agent name for visible_to filtering
      this.config.allowedTools  // Pass allowed tools list for restriction
    );

    // Generate or regenerate system prompt with current context (todos, etc.) before each LLM call
    // Works for both main agent and specialized agents
    // This ensures resumed sessions and new sessions both have proper system prompts
    let updatedSystemPrompt: string;

    if (this.config.baseAgentPrompt) {
      // Generate/regenerate custom agent prompt with current context
      // This works for both specialized agents (sub-agents) and root-level custom agents
      const { getAgentSystemPrompt } = await import('../prompts/systemMessages.js');
      updatedSystemPrompt = await getAgentSystemPrompt(
        this.config.baseAgentPrompt,
        this.config.taskPrompt || '', // Use empty string if no task prompt (for root-level custom agents)
        this.tokenManager,
        this.toolResultManager,
        this.appConfig.reasoning_effort,
        this.agentName,
        executionContext.thoroughness,
        this.config.agentType
      );
      logger.debug('[AGENT_CONTEXT]', this.instanceId, 'Custom agent prompt regenerated with current context');
    } else {
      // Generate/regenerate main agent prompt with current context
      const { getMainSystemPrompt } = await import('../prompts/systemMessages.js');
      updatedSystemPrompt = await getMainSystemPrompt(
        this.tokenManager,
        this.toolResultManager,
        false,
        this.appConfig.reasoning_effort
      );
      logger.debug('[AGENT_CONTEXT]', this.instanceId, 'Main agent prompt regenerated with current context');
    }

    // Update existing system message or create new one if missing
    const existingSystemMessage = this.conversationManager.getSystemMessage();
    if (existingSystemMessage?.role === 'system') {
      existingSystemMessage.content = updatedSystemPrompt;
      logger.debug('[AGENT_CONTEXT]', this.instanceId, 'Updated existing system prompt');
    } else {
      // No system message exists (e.g., after session resume) - create one
      const systemMessage = {
        role: 'system' as const,
        content: updatedSystemPrompt,
      };
      // Prepend system message to the beginning of conversation
      const currentMessages = this.conversationManager.getMessages();
      this.conversationManager.setMessages([systemMessage, ...currentMessages]);
      logger.debug('[AGENT_CONTEXT]', this.instanceId, 'Created new system prompt (missing after session resume)');
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
      parentId: executionContext.parentCallId,
      data: { text: 'Thinking...', thinking: true },
    });

    try {
      // Calculate dynamic max output tokens based on remaining context
      const remainingTokens = this.tokenManager.getRemainingTokens();
      const dynamicMaxTokens = Math.max(
        TOKEN_MANAGEMENT.MIN_OUTPUT_TOKENS,
        Math.floor(remainingTokens * TOKEN_MANAGEMENT.DYNAMIC_OUTPUT_PERCENT)
      );

      // Send to model (includes system-reminder if present)
      const response = await this.modelClient.send(this.conversationManager.getMessages(), {
        functions,
        // Disable streaming for subagents - only main agent should stream responses
        stream: !this.config.isSpecializedAgent && this.appConfig.parallel_tools,
        // Pass parentCallId for associating thinking events with tool calls
        parentId: executionContext.parentCallId,
        // Dynamic output token limit based on remaining context
        dynamicMaxTokens,
      });

      // Remove ephemeral system-reminder messages after receiving response
      // These are temporary context hints that should not persist
      const removedCount = this.conversationManager.removeEphemeralSystemReminders();
      if (removedCount > 0) {
        logger.debug('[AGENT_INTERRUPTION]', this.instanceId, 'Removed ephemeral system reminder(s) after LLM response');
      }

      return response;
    } catch (error) {
      // Remove ephemeral system-reminder messages even on error
      // These should not persist in conversation history
      this.conversationManager.removeEphemeralSystemReminders();

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
   * @param executionContext - Execution context for this invocation
   * @param isRetry - Whether this is a retry after empty response
   * @returns Final text response
   */
  private async processLLMResponse(
    response: LLMResponse,
    executionContext: AgentExecutionContext,
    isRetry: boolean = false
  ): Promise<string> {
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
            metadata: {
              partial: true,
              agentName: this.agentName,
            },
          });
        }

        // Reset flags
        this.interruptionManager.reset();

        // Reset loop detectors for fresh monitoring after interjection
        this.loopDetector.resetTextDetectors();

        // Resume with continuation call
        logger.debug('[AGENT_INTERJECTION]', this.instanceId, 'Processing interjection, continuing...');
        const continuationResponse = await this.getLLMResponse(executionContext);

        // Emit the full response from the continuation if present
        // This ensures the response is visible even for subagents with hideOutput=true
        const responseContent = continuationResponse.content?.trim();
        if (responseContent) {
          logger.debug('[AGENT_INTERJECTION]', this.instanceId, 'Interjection response:', responseContent.substring(0, 100));

          this.emitEvent({
            id: this.generateId(),
            type: ActivityEventType.INTERJECTION_ACKNOWLEDGMENT,
            timestamp: Date.now(),
            parentId: executionContext.parentCallId, // Use from execution context
            data: {
              acknowledgment: responseContent,
              agentType: this.agentName || (this.config.isSpecializedAgent ? 'agent' : 'main'),
            },
          });
        }

        return await this.processLLMResponse(continuationResponse, executionContext);
      } else {
        // Check if this is a continuation-eligible timeout
        const context = this.interruptionManager.getInterruptionContext();
        const canContinueAfterTimeout = (context as any).canContinueAfterTimeout === true;

        if (canContinueAfterTimeout) {
          // Increment continuation counter for logging/metrics
          // No longer enforcing a maximum - will continue indefinitely
          this.timeoutContinuationAttempts++;
          logger.debug('[AGENT_TIMEOUT_CONTINUATION]', this.instanceId,
            `Attempting continuation (attempt ${this.timeoutContinuationAttempts})`);

          // Ensure context room before adding continuation message
          const contextUsage = this.tokenManager.getContextUsagePercentage();
          if (contextUsage >= this.appConfig.compact_threshold) {
            logger.debug('[AGENT_RETRY]', this.instanceId,
              `Context at ${contextUsage}% (>= ${this.appConfig.compact_threshold}%), triggering auto-compaction before timeout continuation`);
            await this.checkAutoCompaction();
          }

          // PERSIST: false - Ephemeral: One-time prompt to continue after interruption
          // Distinguish between thinking loop and activity timeout
          const isThinkingLoop = context.reason?.includes('Thinking loop');
          const continuationPrompt = isThinkingLoop
            ? createThinkingLoopContinuationReminder(context.reason || '')
            : createActivityTimeoutContinuationReminder();
          this.conversationManager.addMessage(continuationPrompt);

          // Reset interruption state and retry
          this.interruptionManager.reset();
          this.requestInProgress = true;

          // Restart activity monitoring
          this.startActivityMonitoring();

          // Reset loop detectors for fresh monitoring on retry
          this.loopDetector.resetTextDetectors();

          // Get new response from LLM
          logger.debug('[AGENT_TIMEOUT_CONTINUATION]', this.instanceId, 'Requesting continuation after timeout...');
          const continuationResponse = await this.getLLMResponse(executionContext);

          // Process continuation
          return await this.processLLMResponse(continuationResponse, executionContext);
        }

        // Regular cancel - mark as interrupted for next request
        logger.debug('[AGENT]', this.instanceId, 'Returning USER_FACING_INTERRUPTION (regular cancel after timeout)');
        this.interruptionManager.markRequestAsInterrupted();

        this.emitAgentEnd(true);

        return PERMISSION_MESSAGES.USER_FACING_INTERRUPTION;
      }
    }

    // Delegate to ResponseProcessor for remaining logic
    const context = this.buildResponseContext(executionContext);
    const result = await this.responseProcessor.processLLMResponse(response, context, isRetry);

    // Stop activity monitoring immediately after getting result
    // This prevents race conditions where the watchdog timer fires after ResponseProcessor
    // completes but before the interruption check below, which would replace valid responses
    // with "Interrupted" message. Legitimate timeouts that occur DURING ResponseProcessor
    // execution are still caught because the interruption flag is already set.
    this.stopActivityMonitoring();

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

        // Reset loop detectors for fresh monitoring after interjection
        this.loopDetector.resetTextDetectors();

        // Resume with continuation call
        logger.debug('[AGENT_INTERJECTION]', this.instanceId, 'Processing interjection after ResponseProcessor, continuing...');
        const continuationResponse = await this.getLLMResponse(executionContext);

        // Process continuation
        return await this.processLLMResponse(continuationResponse, executionContext);
      } else {
        // Regular cancel - mark as interrupted for next request
        logger.debug('[AGENT]', this.instanceId, 'Returning USER_FACING_INTERRUPTION (interrupted after ResponseProcessor)');
        this.interruptionManager.markRequestAsInterrupted();

        this.emitAgentEnd(true);

        return PERMISSION_MESSAGES.USER_FACING_INTERRUPTION;
      }
    }

    return result;
  }

  /**
   * Build response context for ResponseProcessor
   * Contains callbacks and state needed for response processing
   * @param executionContext - Execution context for this invocation
   */
  private buildResponseContext(executionContext: AgentExecutionContext): ResponseContext {
    return {
      instanceId: this.instanceId,
      isSpecializedAgent: this.config.isSpecializedAgent || false,
      parentCallId: executionContext.parentCallId, // Use from execution context, not config
      baseAgentPrompt: this.config.baseAgentPrompt,
      agentName: this.agentName, // Agent name identifier from config.agentType
      generateId: () => this.generateId(),
      autoSaveSession: () => this.autoSaveSession(),
      getLLMResponse: () => this.getLLMResponse(executionContext),
      unwrapBatchToolCalls: (toolCalls) => unwrapBatchToolCalls(toolCalls),
      executeToolCalls: async (toolCalls, cycles) => {
        // Execute tool calls via orchestrator
        // Permission denied errors need special handling by Agent.ts
        try {
          const results = await this.toolOrchestrator.executeToolCalls(toolCalls, cycles);

          // Note: Exploratory tool tracking is handled inside ToolOrchestrator

          return results;
        } catch (error) {
          // Check if this is a permission denied error that triggered interruption
          if (isPermissionDeniedError(error)) {
            // Get unwrapped tool calls for adding permission denial results
            const unwrappedToolCalls = unwrapBatchToolCalls(toolCalls);

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
      detectCycles: (toolCalls) => this.loopDetector.detectCycles(toolCalls),
      recordToolCalls: (toolCalls, results) => {
        this.loopDetector.recordToolCalls(toolCalls, results);
        // Increment checkpoint counters after successful tool execution
        this.checkpointTracker.incrementToolCalls(toolCalls.length);
      },
      clearCyclesIfBroken: () => this.loopDetector.clearCyclesIfBroken(),
      clearCurrentTurn: () => this.toolManager.clearCurrentTurn(),
      startToolExecution: () => this.startToolExecution(),
      getContextUsagePercentage: () => this.tokenManager.getContextUsagePercentage(),
      contextWarningThreshold: CONTEXT_THRESHOLDS.WARNING,
      cleanupEphemeralMessages: () => this.cleanupEphemeralMessages(),
      ensureContextRoom: async () => {
        // Check if context usage is at or above compact threshold before adding retry messages
        // This prevents infinite loops where retry messages fill up context
        const contextUsage = this.tokenManager.getContextUsagePercentage();
        if (contextUsage >= this.appConfig.compact_threshold) {
          logger.debug('[AGENT_RETRY]', this.instanceId,
            `Context at ${contextUsage}% (>= ${this.appConfig.compact_threshold}%), triggering auto-compaction before retry`);
          await this.checkAutoCompaction();
        }
      },
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
      this.tokenManager.updateTokenCount(this.conversationManager.getMessages());

      // Auto-save after cleanup
      this.autoSaveSession();
    }
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

    // Update token count incrementally with new message (O(1) instead of O(n))
    this.tokenManager.addMessageTokens(messageWithMetadata);

    // Emit context usage update event for real-time UI updates
    const contextUsage = this.tokenManager.getContextUsagePercentage();
    this.emitEvent({
      id: this.generateId(),
      type: ActivityEventType.CONTEXT_USAGE_UPDATE,
      timestamp: Date.now(),
      data: {
        contextUsage,
        // Include parentCallId for specialized agents so UI can update the tool call
        parentCallId: this.config.isSpecializedAgent ? this.config.parentCallId : undefined,
      },
    });

    // Log message addition for context tracking
    const toolInfo = message.tool_calls ? ` toolCalls:${message.tool_calls.length}` : '';
    const toolCallId = message.tool_call_id ? ` toolCallId:${message.tool_call_id}` : '';
    const toolName = message.name ? ` name:${message.name}` : '';
    logger.debug('[AGENT_CONTEXT]', this.instanceId, 'Message added:', message.role, toolInfo, toolCallId, toolName, '- Total messages:', this.conversationManager.getMessageCount());

    // Auto-save session after adding message
    this.autoSaveSession();
  }

  /**
   * Get the current conversation history (readonly reference)
   *
   * @returns Readonly reference to message array
   */
  getMessages(): readonly Message[] {
    return this.conversationManager.getMessages();
  }

  /**
   * Get a copy of the conversation history for mutation
   *
   * @returns Copy of message array
   */
  getMessagesCopy(): Message[] {
    return this.conversationManager.getMessagesCopy();
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

    // Note: We do NOT extract initialUserPrompt from restored messages
    // It will be set by the next sendMessage() call with the current turn's prompt
    // Checkpoint tracking is per-turn only, not based on historical messages

    logger.debug('[AGENT_CONTEXT]', this.instanceId, 'Messages set, count:', this.conversationManager.getMessageCount());
  }

  /**
   * Remove ephemeral system reminder messages
   *
   * Used to clean up ephemeral reminders after session restore.
   *
   * @returns Number of messages affected
   */
  removeEphemeralSystemReminders(): number {
    return this.conversationManager.removeEphemeralSystemReminders();
  }

  /**
   * Clean up stale persistent reminders older than specified age
   *
   * This is a defensive mechanism to prevent persistent reminder accumulation.
   *
   * @param maxAge - Maximum age in milliseconds (default: 30 minutes)
   * @returns Number of stale persistent reminders removed
   */
  cleanupStaleReminders(maxAge?: number): number {
    return this.conversationManager.cleanupStaleReminders(maxAge);
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
    // Recalculate token count after compaction
    this.tokenManager.updateTokenCount(this.conversationManager.getMessages());
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

    // Recalculate token count after rewind
    this.tokenManager.updateTokenCount(this.conversationManager.getMessages());

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
      compactThreshold: this.appConfig.compact_threshold,
      generateId: () => this.generateId(),
      parentCallId: this.config.parentCallId,
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
    messages: readonly Message[] = this.conversationManager.getMessages(),
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
   * Emit AGENT_END event with interruption flag
   * Handles the agentEndEmitted guard internally to prevent duplicate emissions
   */
  private emitAgentEnd(interrupted: boolean = false): void {
    if (this.agentEndEmitted) return;
    this.emitEvent({
      id: this.generateId(),
      type: ActivityEventType.AGENT_END,
      timestamp: Date.now(),
      data: {
        interrupted,
        isSpecializedAgent: this.config.isSpecializedAgent || false,
        instanceId: this.instanceId,
        agentName: this.config.agentType || 'ally',
      },
    });
    this.agentEndEmitted = true;
  }

  /**
   * Generate a unique ID for events
   */
  private generateId(): string {
    // Generate agent ID: agent-{timestamp}-{7-char-random} (base-36, skip '0.' prefix)
    return `agent-${Date.now()}-${Math.random().toString(ID_GENERATION.RANDOM_STRING_RADIX).substring(ID_GENERATION.RANDOM_STRING_SUBSTRING_START, ID_GENERATION.RANDOM_STRING_SUBSTRING_START + ID_GENERATION.RANDOM_STRING_LENGTH_SHORT)}`;
  }

  /**
   * Find the index of the last assistant message in the conversation
   * Used for interjection detection after permission denials
   */
  private findLastAssistantMessageIndex(messages: readonly Message[]): number {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === 'assistant') {
        return i;
      }
    }
    return -1;
  }

  /**
   * Check if there's a pending user interjection after the given message index
   */
  private hasPendingInterjection(messages: readonly Message[], afterIndex: number): boolean {
    return messages.slice(afterIndex + 1).some(
      (msg) => msg?.role === 'user' && msg?.metadata?.isInterjection === true
    );
  }

  /**
   * Continue processing after permission denial when user provided interjection
   * Handles multiple consecutive interjections in a loop
   */
  private async continueWithInterjection(executionContext: AgentExecutionContext): Promise<string> {
    while (true) {
      logger.debug('[AGENT]', this.instanceId, 'Permission denied but user provided instructions - continuing with interjection');
      this.interruptionManager.reset();

      try {
        const response = await this.getLLMResponse(executionContext);
        return await this.processLLMResponse(response, executionContext);
      } catch (retryError) {
        // Check if this is another permission denial with interjection
        if (isPermissionDeniedError(retryError)) {
          const messages = this.conversationManager.getMessages();
          const lastAssistantIdx = this.findLastAssistantMessageIndex(messages);

          if (this.hasPendingInterjection(messages, lastAssistantIdx)) {
            continue; // Loop to handle the new interjection
          }
        }
        throw retryError; // No interjection or not a permission error
      }
    }
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
        logger.debug('[AGENT_FOCUS]', this.instanceId, 'FocusManager not available, skipping focus setup');
        return;
      }

      // Save previous focus state
      this.previousFocus = focusManager.getFocusDirectory();

      // Set excluded files if provided
      if (this.config.excludeFiles && this.config.excludeFiles.length > 0) {
        focusManager.setExcludedFiles(this.config.excludeFiles);
        logger.debug('[AGENT_FOCUS]', this.instanceId, 'Excluded', this.config.excludeFiles.length, 'files from access');
      }

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
        // Clear excluded files set by this agent
        if (this.config.excludeFiles && this.config.excludeFiles.length > 0) {
          focusManager.clearExcludedFiles();
          logger.debug('[AGENT_FOCUS]', this.instanceId, 'Cleared excluded files');
        }

        // Restore previous focus
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
   * Generate a checkpoint reminder for the agent
   *
   * NOTE: Phase 1 implementation - tracking and generation only
   * Phase 2 will integrate this into the response flow by calling this method
   * before tool execution and injecting the reminder into tool results
   *
   * @returns Checkpoint reminder string or null if not needed
   */
  public generateCheckpointReminder(): string | null {
    return this.checkpointTracker.generateReminder();
  }

  /**
   * Check if any linked plugins have changed and reload them if needed.
   * Only called for root agent (agentDepth === 0) to avoid redundant checks.
   */
  private async checkLinkedPluginsForChanges(): Promise<void> {
    try {
      const registry = ServiceRegistry.getInstance();
      const watcher = registry.get('linked_plugin_watcher') as LinkedPluginWatcher | undefined;
      if (watcher) {
        const reloadedPlugins = await watcher.checkAndReloadChangedPlugins();
        if (reloadedPlugins.length > 0) {
          // Log for developer visibility - they'll see this before their prompt is processed
          logger.info(
            `[Agent] Auto-reloaded ${reloadedPlugins.length} linked plugin(s): ${reloadedPlugins.join(', ')}`
          );
        }
      }
    } catch (error) {
      // Don't let plugin reload failures block message processing
      logger.warn(
        `[Agent] Failed to check linked plugins: ${error instanceof Error ? error.message : String(error)}`
      );
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
    // IMPORTANT: Specialized agents share an ActivityStream with the main agent
    // (via AgentPoolService), so they must NOT cleanup the shared stream.
    // Only the main/root agent (isSpecializedAgent=false) should cleanup.
    // This prevents destroying ALL UI subscriptions when any delegated agent finishes.
    if (!this.config.isSpecializedAgent && this.activityStream && typeof this.activityStream.cleanup === 'function') {
      this.activityStream.cleanup();
    }

    // Restore focus
    await this.restoreFocus();

    // Clear delegation state to prevent memory leaks
    // This breaks circular references: DelegationContext → PooledAgent → Agent → DelegationContextManager
    // NOTE: Do NOT call delegationManager.clearAll() here!
    // The delegation manager is global/shared, so clearAll() would clear OTHER agents' delegations.
    // Individual delegation contexts are cleared via transitionToCompleting() and clear() when each
    // delegation completes in the tool code (AgentTool, BaseDelegationTool, etc.)

    // Only close the model client if this is NOT a specialized subagent
    // Subagents share the client and shouldn't close it
    if (!this.config.isSpecializedAgent && this.modelClient.close) {
      await this.modelClient.close();
    }

    logger.debug('[AGENT_CLEANUP]', this.instanceId, 'Cleanup completed');
  }
}
