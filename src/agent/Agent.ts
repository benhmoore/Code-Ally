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
import {
  InterruptionManager,
  isRecoverableInterruption,
  type RecoverableInterruptionCause,
  type UserInterruptionCause,
} from './InterruptionManager.js';
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
import { ConversationCompactor, type AppliedCompactionResult, type CompactionOptions } from './ConversationCompactor.js';
import { AgentLifecycleHandler } from './AgentLifecycleHandler.js';
import { LoopDetector } from './LoopDetector.js';
import { FocusScope } from './FocusScope.js';
import { AgentInvocationState } from './AgentInvocationState.js';
import { LoopInfo } from './types/loopDetection.js';
import {
  CharacterRepetitionPattern,
  PhraseRepetitionPattern,
  SentenceRepetitionPattern,
} from './patterns/loopPatterns.js';
import { Message, ActivityEventType, Config, type FunctionDefinition } from '../types/index.js';
import { generateMessageId } from '../utils/id.js';
import { logger } from '../services/Logger.js';
import { formatError } from '../utils/errorUtils.js';
import { POLLING_INTERVALS, TEXT_LIMITS, PERMISSION_MESSAGES, PERMISSION_DENIED_TOOL_RESULT, AGENT_CONFIG, ID_GENERATION, TOKEN_MANAGEMENT, THINKING_LOOP_DETECTOR, RESPONSE_LOOP_DETECTOR } from '../config/constants.js';
import {
  createInterruptionReminder,
  createEmptyTodoReminder,
  createActiveTodoReminder,
  createActivityTimeoutContinuationReminder,
  createThinkingLoopContinuationReminder,
  createResponseLoopContinuationReminder,
  createSystemReminder,
} from '../utils/messageUtils.js';
import { CONTEXT_THRESHOLDS, TOOL_NAMES } from '../config/toolDefaults.js';
import { TurnController, type TurnSnapshot } from './TurnController.js';

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

const MODEL_TEXT_STREAM_COMPLETION_EVENTS = [
  ActivityEventType.TOOL_CALL_START,
  ActivityEventType.ASSISTANT_MESSAGE_COMPLETE,
  ActivityEventType.AGENT_END,
] as const;

const THINKING_TEXT_STREAM_RESET_EVENTS = [
  ActivityEventType.THOUGHT_COMPLETE,
  ...MODEL_TEXT_STREAM_COMPLETION_EVENTS,
] as const;

const RESPONSE_TEXT_STREAM_RESET_EVENTS = [
  ...MODEL_TEXT_STREAM_COMPLETION_EVENTS,
] as const;

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
  /** Parent agent instance (for activity monitor pause/resume) */
  parentAgent?: IParentAgent;
  /** Required tool calls that must be executed before agent can exit */
  requiredToolCalls?: string[];
  /** Agent requirements specification (new requirements system) */
  requirements?: import('./RequirementTracker.js').AgentRequirements;
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
  /** Internal: this root agent is executing an unattended scheduled task. */
  isScheduledRun?: boolean;
  /** Internal: this root agent is executing a single noninteractive request. */
  isOnceMode?: boolean;
  /** Internal: scheduled task id for unattended scheduled task runs. */
  scheduledTaskId?: string;
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

  // Per-invocation state (request flags, recovery attempts, cleanup queue).
  // Single source of truth for what must be wiped when a pooled agent is reused.
  private readonly invocationState = new AgentInvocationState();

  // Interruption management - delegated to InterruptionManager
  private interruptionManager: InterruptionManager;

  // Parent agent reference (for activity monitor pause/resume)
  private parentAgent: IParentAgent | null = null;

  // Context tracking (isolated per agent)
  private tokenManager: TokenManager;
  private toolResultManager: ToolResultManager; // ToolResultManager instance

  // Agent instance ID for debugging. Public because IParentAgent exposes it:
  // an Agent handed to a sub-agent as its parent must satisfy that interface.
  readonly instanceId: string;

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

  // Transactional context checkpointing
  private agentCompactor: ConversationCompactor;

  // Lifecycle handling - idle coordinator, auto-cleanup
  private lifecycleHandler: AgentLifecycleHandler;

  private readonly turnController = new TurnController({
    maxModelCalls: AGENT_CONFIG.MAX_LLM_ROUNDTRIPS_PER_TURN,
    maxToolCalls: AGENT_CONFIG.MAX_TOOL_CALLS_PER_TURN,
  });
  private activeExecutionContext: AgentExecutionContext = {};
  /** Synchronous, whole-turn admission guard; broader than an in-flight model request. */
  private turnAdmissionActive = false;
  private nativeCompactionPending = false;
  private lastRequestFunctions: FunctionDefinition[] = [];

  // Checkpoint reminder tracking - monitors tool calls to inject progress reminders
  private checkpointTracker: CheckpointTracker;

  // Focus management - scoped acquire/release of the process-global focus state
  private readonly focusScope: FocusScope;
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
    logger.debug('[AGENT_CONTEXT]', this.instanceId, 'Created - isSpecialized:', config.isSpecializedAgent || false, 'depth:', this.agentDepth, 'scopedRegistry:', this.scopedRegistry ? 'yes' : 'no');

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

    // Create turn manager
    this.turnManager = new TurnManager({
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

    // Detect any agent stuck generating without taking a concrete tool action.
    // Main-agent requests need this too: transport retries and hidden reasoning
    // can otherwise keep an interactive or durable turn alive indefinitely.
    const activityTimeoutMs = this.appConfig.tool_call_activity_timeout * 1000;
    this.activityMonitor = new ActivityMonitor({
      timeoutMs: activityTimeoutMs,
      checkIntervalMs: POLLING_INTERVALS.AGENT_WATCHDOG,
      enabled: activityTimeoutMs > 0,
      instanceId: this.instanceId,
      onTimeout: (elapsedMs: number) => {
        this.handleActivityTimeout(elapsedMs);
      },
    });

    if (activityTimeoutMs > 0) {
      logger.debug('[AGENT_CONTEXT]', this.instanceId, 'Activity monitor enabled:', activityTimeoutMs, 'ms');
    }

    // Create unified loop detector
    this.loopDetector = new LoopDetector({
      instanceId: this.instanceId,
      thinkingLoopConfig: {
        eventType: ActivityEventType.THOUGHT_CHUNK,
        resetEventTypes: THINKING_TEXT_STREAM_RESET_EVENTS,
        patterns: [
          new CharacterRepetitionPattern(),
          new PhraseRepetitionPattern(),
          new SentenceRepetitionPattern(),
        ],
        warmupPeriodMs: THINKING_LOOP_DETECTOR.WARMUP_PERIOD_MS,
        checkIntervalMs: THINKING_LOOP_DETECTOR.CHECK_INTERVAL_MS,
        onLoopDetected: (info) => this.handleThinkingLoop(info),
      },
      responseLoopConfig: {
        eventType: ActivityEventType.ASSISTANT_CHUNK,
        resetEventTypes: RESPONSE_TEXT_STREAM_RESET_EVENTS,
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

    // Registered here, once both collaborators exist, so every append — however
    // it reaches the conversation — carries its bookkeeping with it.
    this.conversationManager.setMessageAddedObserver(message => this.onMessageAdded(message));

    // Create agent's own ToolResultManager using agent's TokenManager
    this.toolResultManager = new ToolResultManager(
      this.tokenManager,
      configManager, // Optional: uses defaults if not provided
      toolManager
    );

    // Wire tool result persistence for saving large outputs to disk
    const toolResultPersistence = ServiceRegistry.getInstance().get('tool_result_persistence');
    if (toolResultPersistence) {
      this.toolResultManager.setPersistence(toolResultPersistence);
    }

    // Create the transactional context checkpoint coordinator.
    this.agentCompactor = new ConversationCompactor(
      modelClient,
      this.conversationManager,
      this.tokenManager,
      activityStream,
      (messages, checkpoint) => this.sessionPersistence.commitCheckpoint(messages, checkpoint),
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

    // Focus is a process-global resource borrowed for this agent's lifetime.
    // The manager is resolved lazily: it may be registered after construction.
    this.focusScope = new FocusScope({
      resolveTarget: () => ServiceRegistry.getInstance().get('focus_manager'),
      label: this.instanceId,
    });

    // Setup focus if focusDirectory is provided
    if (config.focusDirectory) {
      // Store the promise so tool execution can wait for focus to be ready
      this.focusReady = this.focusScope.acquire(config.focusDirectory, this.config.excludeFiles).catch(error => {
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
   * Count the tool calls this agent has made across its conversation.
   *
   * Used by delegation tools to report a tool-use count in AGENT_END so the main
   * conversation can render a "Done (N tool uses)" summary without ingesting the
   * sub-agent's individual (now stream-isolated) tool calls.
   */
  public getToolUseCount(): number {
    return this.conversationManager.getMessages().reduce(
      (sum, msg) => sum + (msg.role === 'assistant' && msg.tool_calls ? msg.tool_calls.length : 0),
      0
    );
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

  /** Guard live transport changes and provider-native replay identity. */
  getModelIdentityChangeBlock(next: { provider?: Config['provider']; model?: string | null }): string | null {
    const providerChanged = next.provider !== undefined
      && next.provider !== (this.appConfig.provider ?? this.modelClient.providerId);
    if (providerChanged) {
      return 'Changing provider transports requires a restart. Start a new process/session with the desired provider so the live client and conversation state cannot diverge.';
    }
    if (this.conversationManager.getProviderState().kind === 'chat') return null;
    const modelChanged = next.model !== undefined
      && next.model !== (this.appConfig.model ?? this.modelClient.modelName);
    if (!modelChanged) return null;
    return 'This conversation has provider-native compacted state tied to its current model. Start a new session or rewind before switching the primary provider/model.';
  }

  /**
   * Apply runtime configuration updates to this agent.
   *
   * Agents receive a copied config at construction, so config changes must be
   * pushed into live agents explicitly for context accounting and thresholds to
   * reflect /config updates without restarting.
   */
  applyConfigUpdates(updates: Partial<Config>): void {
    Object.assign(this.appConfig, updates);

    const modelClient = this.modelClient as any;

    if (typeof updates.endpoint === 'string' && typeof modelClient.setEndpoint === 'function') {
      modelClient.setEndpoint(updates.endpoint);
    }
    if (typeof updates.temperature === 'number' && typeof modelClient.setTemperature === 'function') {
      modelClient.setTemperature(updates.temperature);
    }
    if (typeof updates.context_size === 'number') {
      this.tokenManager.setContextSize(updates.context_size);
      this.tokenManager.updateTokenCount(this.conversationManager.getMessages());

      if (typeof modelClient.setContextSize === 'function') {
        modelClient.setContextSize(updates.context_size);
      }
    }
    if (typeof updates.tool_result_max_context_percent === 'number' || typeof updates.tool_result_min_tokens === 'number') {
      this.toolResultManager.setLimits({
        maxContextPercent: updates.tool_result_max_context_percent,
        minTokens: updates.tool_result_min_tokens,
      });
    }
    if (typeof updates.tool_call_activity_timeout === 'number') {
      const timeoutMs = updates.tool_call_activity_timeout * 1000;
      this.activityMonitor.updateConfig({
        timeoutMs,
        enabled: timeoutMs > 0,
      });
    }
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
   * Get this agent's ActivityStream. For the main agent this is the root stream;
   * for a sub-agent it is the scoped child stream carrying only that agent's own
   * activity. The entered-agent ("fleet") view subscribes to this to render a
   * sub-agent's live transcript in isolation from the main conversation.
   */
  getActivityStream(): ActivityStream {
    return this.activityStream;
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
    this.invocationState.pendingCleanupIds.push(...toolCallIds);
    logger.debug('[AGENT_CLEANUP]', this.instanceId, 'Queued cleanup for IDs:', toolCallIds);
  }

  /**
   * Execute queued cleanups at end of turn
   * Removes tool results that were marked for cleanup during the turn
   */
  private executePendingCleanups(): void {
    if (this.invocationState.pendingCleanupIds.length === 0) {
      return;
    }

    const idsToRemove = [...this.invocationState.pendingCleanupIds];
    this.invocationState.pendingCleanupIds = [];

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
    // Reset all active-window references, not only the numeric token count.
    this.tokenManager.resetContextTracking(this.conversationManager.getMessages());
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

    // Reset every per-invocation field (counters, cleanup queue, request flags)
    this.invocationState.reset();
    this.turnAdmissionActive = false;
    this.toolOrchestrator.resetExploratoryStreak();

    // Reset ALL loop detection (text patterns + tool cycle history)
    this.loopDetector.reset();

    // Reset interruption state
    this.interruptionManager.reset();

    // Reset turn timing for fresh invocation
    this.turnManager.clearTurn();

    // Drop focus ownership for pool reuse (prevents context seepage)
    this.focusScope.reset();
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
   * Abort the current generation for an internal, recoverable condition.
   */
  private interruptForRecovery(tag: string, cause: RecoverableInterruptionCause): void {
    const alreadyInterrupted = this.interruptionManager.isInterrupted();

    logger.debug(tag, this.instanceId, cause.reason);

    if (!alreadyInterrupted) {
      this.interruptionManager.interrupt(cause);
      this.stopActivityMonitoring();
    }
  }

  /** Handle activity timeout - invoked by ActivityMonitor */
  private handleActivityTimeout(elapsedMs: number): void {
    const elapsedSeconds = Math.round(elapsedMs / 1000);
    this.interruptForRecovery(
      '[AGENT_TIMEOUT]',
      { kind: 'activity_timeout', reason: `Activity timeout: no tool calls for ${elapsedSeconds} seconds` }
    );
  }

  /** Handle thinking loop - invoked by LoopDetector */
  private handleThinkingLoop(info: LoopInfo): void {
    this.interruptForRecovery('[THINKING_LOOP]', { kind: 'thinking_loop', reason: info.reason });
  }

  /** Handle response loop - invoked by LoopDetector */
  private handleResponseLoop(info: LoopInfo): void {
    this.interruptForRecovery('[RESPONSE_LOOP]', { kind: 'response_loop', reason: info.reason });
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
    if (this.turnAdmissionActive) {
      throw new Error('Agent is already processing a turn; submit this message as an interjection instead.');
    }

    // Claim the agent before the first await. Preparation and finalization are
    // part of the turn too; allowing another sendMessage during either phase
    // corrupts the shared interruption, context, and lifecycle state.
    this.turnAdmissionActive = true;
    this.interruptionManager.reset();
    this.invocationState.requestInProgress = true;
    this.invocationState.agentEndEmitted = false;

    try {
      return await this.executeMessageTurn(message, executionContext, images);
    } finally {
      // executeMessageTurn owns normal cleanup. This covers failures during its
      // preparation phase, before the existing lifecycle try/finally begins.
      if (this.invocationState.requestInProgress) {
        this.cleanupRequestState();
      }
      this.turnAdmissionActive = false;
    }
  }

  private async executeMessageTurn(
    message: string,
    executionContext?: AgentExecutionContext,
    images?: string[]
  ): Promise<string> {
    const { parentCallId, maxDuration, thoroughness } = executionContext ?? {};
    this.activeExecutionContext = { parentCallId, maxDuration, thoroughness };

    if (!this.config.isSpecializedAgent) {
      const registry = ServiceRegistry.getInstance();
      const policyManager = registry.get('run_policy_manager');
      const supervisor = registry.get('run_supervisor');
      const policy = policyManager?.getPolicy();
      if (policy?.completion === 'durable_objective' && supervisor && !supervisor.isRunning()) {
        await supervisor.startRun(message, policy);
      }
    }

    // Reset all invocation-scoped state when a pooled agent is reused.
    this.toolOrchestrator.setParentCallId(parentCallId);
    this.turnManager.setMaxDuration(maxDuration);
    if (this.config.isSpecializedAgent) this.turnManager.resetTurn();

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

    // Capture parent reference at turn start to ensure paired pause/resume use same reference
    // This prevents count corruption if parentAgent changes during sendMessage execution
    const parentAgentRef = this.parentAgent;

    // Pause parent agent's activity monitoring before sub-agent execution
    // This prevents false timeout triggers while the sub-agent is actively working
    if (parentAgentRef) {
      parentAgentRef.pauseActivityMonitoring();
      logger.debug('[AGENT]', this.instanceId,
        `Pausing parent agent activity monitoring (parent: ${parentAgentRef.instanceId})`);
    }

    // Start activity monitoring for specialized agents
    this.startActivityMonitoring();

    // Reset all loop detection (tool cycles and text loops) on new user input
    this.loopDetector.reset();

    // Reset internal recovery tracking on new user input
    this.invocationState.recoveryAttempts = 0;

    this.turnController.start();

    // Reset exploratory tool streak on new user input
    this.toolOrchestrator.resetExploratoryStreak();

    // Reset cleanup queue on new user input
    this.invocationState.pendingCleanupIds = [];

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

    // The initiating user message is a durable run boundary. Commit it before
    // making an endpoint request so a crash cannot strand an unrecorded prompt.
    await this.sessionPersistence.commitTurnStart();

    // Inject system reminder about todos (main agent only, and only if TodoWrite is available)
    // This nudges the model to consider updating the todo list without blocking
    const hasTodoWriteAccess = !this.config.allowedTools || this.config.allowedTools.includes('todo-write');
    if (!this.config.isSpecializedAgent && hasTodoWriteAccess) {
      const registry = ServiceRegistry.getInstance();
      const todoManager = registry.get('todo_manager');

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

    // Surface relevant long-term memory as ephemeral background context (main agent only).
    // Stripped each turn so it never accumulates; the service applies strict caps.
    if (!this.config.isSpecializedAgent) {
      await this.injectRelevantMemory(message);
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
      // Send to LLM and process response
      const response = await this.getLLMResponse({
        parentCallId,
        maxDuration,
        thoroughness,
      });

      // Process response (handles both tool calls and text responses)
      // Note: processLLMResponse handles interruptions internally (both cancel and interjection types)
      const responseContext = {
        parentCallId,
        maxDuration,
        thoroughness,
      };
      let finalResponse = await this.processLLMResponse(response, responseContext);

      // Finalization contains awaits (native checkpoint adoption and lifecycle
      // services). An interjection can arrive during either one. Re-enter the
      // model loop before ending the turn so that message is never orphaned.
      const continuePendingInterruption = async (): Promise<boolean> => {
        if (!this.interruptionManager.isInterrupted()) return false;
        const cause = this.interruptionManager.getCause();
        if (cause?.kind === 'user_interjection') {
          this.interruptionManager.reset();
          this.loopDetector.resetTextDetectors();
          const continuation = await this.getLLMResponse(responseContext);
          finalResponse = await this.processLLMResponse(continuation, responseContext);
          return true;
        }
        if (isRecoverableInterruption(cause)) {
          finalResponse = await this.continueAfterRecovery(cause, responseContext);
          return true;
        }
        return false;
      };

      while (true) {
        await this.adoptPendingNativeCompaction();
        if (await continuePendingInterruption()) continue;
        if (this.interruptionManager.isInterrupted()) {
          this.turnController.finish('interrupted');
          return await this.handleInterruption();
        }

        this.executePendingCleanups();
        await this.lifecycleHandler.handlePostResponse(
          this.conversationManager.getMessages(),
          (ids) => this.queueCleanup(ids)
        );
        if (await continuePendingInterruption()) continue;
        if (this.interruptionManager.isInterrupted()) {
          this.turnController.finish('interrupted');
          return await this.handleInterruption();
        }
        break;
      }

      this.emitAgentEnd(false, undefined, finalResponse);
      this.turnController.finish('completed');
      return finalResponse;
    } catch (error) {
      logger.debug('[AGENT]', this.instanceId, 'sendMessage caught exception:', error instanceof Error ? error.message : String(error));
      // Mark delegation as failed for parent activity monitoring
      delegationSucceeded = false;
      this.turnController.finish(isPermissionDeniedError(error) ? 'interrupted' : 'failed');

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
      // Emit AGENT_END for this agent's lifecycle (ensures cleanup even on unhandled errors).
      // emitAgentEnd() has an internal guard to prevent duplicate emissions - error/interruption
      // handlers that already called emitAgentEnd(true) won't cause a second emission here.
      this.emitAgentEnd(!delegationSucceeded);

      this.cleanupRequestState();

      // Resume parent agent's activity monitoring after sub-agent completes
      // This must be in finally block to guarantee execution even if sendMessage throws
      // Pass delegationSucceeded to conditionally record progress:
      // - true (default): child completed successfully, parent should record progress
      // - false: child threw error, parent should NOT record progress
      // Use parentAgentRef captured at turn start to ensure paired pause/resume use same reference
      if (parentAgentRef) {
        parentAgentRef.resumeActivityMonitoring(delegationSucceeded);
        logger.debug('[AGENT]', this.instanceId,
          `Resuming parent agent activity monitoring (parent: ${parentAgentRef.instanceId}, succeeded: ${delegationSucceeded})`);
      }
    }
  }

  /**
   * Handle request interruption
   *
   * For timeouts on specialized agents, throws an error (tool failure).
   * For user interruptions or main agent, returns a message.
   */
  private async handleInterruption(): Promise<string> {
    this.interruptionManager.markRequestAsInterrupted();

    const cause = this.interruptionManager.getCause();
    const message = cause && 'reason' in cause ? cause.reason : PERMISSION_MESSAGES.USER_FACING_INTERRUPTION;

    if (!this.config.isSpecializedAgent) {
      await ServiceRegistry.getInstance().get('run_supervisor')?.cancel(message);
    }

    this.emitAgentEnd(true, cause?.kind);

    // Clear interruption state
    this.interruptionManager.reset();

    // Timeouts on subagents should fail as tool errors
    if (cause?.kind === 'activity_timeout' && this.config.isSpecializedAgent) {
      throw new Error(message);
    }

    // User interruptions return message gracefully
    return message;
  }

  /**
   * Clean up request state after completion or error
   */
  private cleanupRequestState(): void {
    this.invocationState.requestInProgress = false;
    this.invocationState.agentEndEmitted = false;
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
   * @param cause - User action that stopped generation
   */
  interrupt(cause: UserInterruptionCause = { kind: 'user_cancel' }): void {
    if (this.turnAdmissionActive) {
      // Set interruption state and abort this agent's request signal. Because the
      // signal handed to ModelClient.send() is owned by this agent's
      // InterruptionManager, this cancels the in-flight LLM request immediately
      // and scoped to this agent alone — no global client cancellation.
      this.interruptionManager.interrupt(cause);

      // Stop activity monitoring
      this.stopActivityMonitoring();

    }
  }

  /**
   * Check if a request is currently in progress
   */
  isProcessing(): boolean {
    return this.turnAdmissionActive;
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
    this.turnController.beginToolExecution();
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
   * Get response from LLM
   *
   * @param executionContext - Execution context for this invocation
   * @returns LLM response with potential tool calls
   */
  private async getLLMResponse(executionContext: AgentExecutionContext): Promise<LLMResponse> {
    // Per-turn round-trip backstop: stop a runaway loop (e.g. a model that keeps
    // emitting empty/malformed output or never satisfies a requirement) before it
    // fills the context window. Returns a plain text response with no tool calls,
    // so the loop terminates gracefully on the next processing pass.
    if (!this.turnController.beginModelCall()) {
      const snapshot = this.turnController.snapshot();

      const registry = ServiceRegistry.getInstance();
      const runPolicy = registry.get('run_policy_manager')?.getPolicy();
      const runSupervisor = registry.get('run_supervisor');
      if (!this.config.isSpecializedAgent && runPolicy?.completion === 'durable_objective' && runSupervisor?.isRunning()) {
        this.turnController.rollover();
        await runSupervisor.rolloverEpoch(snapshot.terminationReason ?? 'round_trip_budget');
        await this.checkAutoCompaction();
        if (this.turnController.beginModelCall()) {
          logger.info('[AGENT]', this.instanceId, 'Rolled durable objective into a new safety-budget epoch');
        } else {
          await runSupervisor.block('Unable to begin a new safety-budget epoch');
          return { role: 'assistant', content: 'The durable objective could not start a new execution epoch.', error: true };
        }
      } else {

        // Explain once. Any of the turn's many continuation/retry paths can
        // re-enter here after the budget trips; without this guard each one
        // appends another copy of the same notice.
        if (!this.turnController.claimBudgetNotice()) {
          return { role: 'assistant', content: '' };
        }

        logger.warn('[AGENT]', this.instanceId, `Reached per-turn round-trip limit (${AGENT_CONFIG.MAX_LLM_ROUNDTRIPS_PER_TURN}); stopping to avoid an unbounded loop`);
        return {
          role: 'assistant',
          content: `I stopped because this turn reached its ${snapshot.terminationReason === 'tool_budget' ? 'tool-call' : 'model-call'} safety budget. The task may be incomplete; review the completed work before continuing.`,
        };
      }
    }

    // Headless runs do not have the React wake hook. Drain completed delegated
    // work before every model request so results are delivered exactly once even
    // when the parent is otherwise idle or only producing progress prose.
    if (!this.config.isSpecializedAgent) {
      const completed = ServiceRegistry.getInstance()
        .get('background_agent_manager')
        ?.drainCompletedResults() ?? [];
      if (completed.length > 0) {
        const report = completed.map((task) => {
          const body = task.status === 'done'
            ? task.result ?? '(no output)'
            : `[${task.status}] ${task.error ?? task.result ?? 'no output'}`;
          return `Background agent ${task.id} (${task.agentType}) ${task.status}. Result:\n${body}`;
        }).join('\n\n');
        this.conversationManager.addMessage(createSystemReminder(report.slice(-200_000), false));
      }
    }

    // Get function definitions from tool manager
    // Exclude restricted tools based on agent type
    const allowTodoManagement = this.config.allowTodoManagement ?? !this.config.isSpecializedAgent;

    const excludeTools: string[] = [];
    if (!allowTodoManagement) {
      excludeTools.push(...TOOL_NAMES.TODO_MANAGEMENT_TOOLS);
    }

    // Main-agent-only tools (e.g. memory) are hidden from every delegated agent.
    // "Delegated" is isSpecializedAgent — NOT the agent name (the main agent is
    // named, typically 'ally'), which is why this keys off the same signal as todo tools.
    if (this.config.isSpecializedAgent) {
      excludeTools.push(...this.toolManager.getMainAgentOnlyToolNames());
    }

    // Human-input tools are unavailable in automatic runs. This is a schema
    // filter for model efficiency; FormManager/PlanModeManager enforce the same
    // invariant at runtime for defense in depth.
    const runPolicyManager = ServiceRegistry.getInstance().get('run_policy_manager');
    if (runPolicyManager?.getPolicy().completion !== 'durable_objective') {
      excludeTools.push('complete-objective', 'block-objective', 'reconcile-effect');
    }
    if (runPolicyManager && !runPolicyManager.isInteractionAvailable()) {
      excludeTools.push(
        ...this.toolManager.getInteractiveToolNames(),
        'enter-plan-mode',
        'write-plan',
        'exit-plan-mode'
      );
    }

    const functions = this.toolManager.getFunctionDefinitions(
      excludeTools.length > 0 ? excludeTools : undefined,
      this.agentName,  // Pass agent name for visible_to filtering
      this.config.allowedTools  // Pass allowed tools list for restriction
    );
    this.lastRequestFunctions = [...functions];

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
        this.config.agentType,
        this.conversationManager.getMessages(),
        this.agentDepth
      );
      logger.debug('[AGENT_CONTEXT]', this.instanceId, 'Custom agent prompt regenerated with current context');
    } else {
      // Generate/regenerate main agent prompt with current context
      const { getMainSystemPrompt } = await import('../prompts/systemMessages.js');
      updatedSystemPrompt = await getMainSystemPrompt(
        this.tokenManager,
        this.toolResultManager,
        this.config.isOnceMode ?? this.config.isScheduledRun ?? false,
        this.appConfig.reasoning_effort,
        this.conversationManager.getMessages(),
        this.config.isScheduledRun ?? false,
        this.config.scheduledTaskId
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
      this.conversationManager.replaceActiveMessages([systemMessage, ...currentMessages]);
      logger.debug('[AGENT_CONTEXT]', this.instanceId, 'Created new system prompt (missing after session resume)');
    }

    // Dynamic prompt generation can materially change the system message, so
    // refresh accounting before deciding whether auto-compaction is needed.
    this.tokenManager.updateTokenCount(this.conversationManager.getMessages());

    // Build volatile context before planning so the budget is the request the
    // model will actually receive, not a smaller approximation.
    const { getDynamicContextBlock } = await import('../prompts/systemMessages.js');
    const dynamicContext = await getDynamicContextBlock({
      tokenManager: this.tokenManager,
      toolResultManager: this.toolResultManager,
      includeTodos: !this.config.isSpecializedAgent,
      includePlanMode: !this.config.isSpecializedAgent,
    });

    // Auto-compaction: the budget planner decides from absolute request budgets.
    await this.checkAutoCompaction(functions, dynamicContext);

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
      // Append the volatile context as a trailing ephemeral system-reminder.
      // Keeping the date, todos, and plan-mode banner
      // OUT of msg[0] and at the END of the prompt is what lets the backend reuse
      // its KV cache for the stable system prefix + the entire conversation; only
      // this small trailing block is recomputed each round-trip. It is stripped
      // immediately after the response by removeEphemeralSystemReminders(). The
      // native Ollama transport preserves this position while mapping late
      // system reminders to user continuations for strict model templates.
      if (dynamicContext) {
        const dynamicReminder = createSystemReminder(dynamicContext, false);
        dynamicReminder.metadata = { ...(dynamicReminder.metadata ?? {}), ephemeral: true };
        this.conversationManager.addMessage(dynamicReminder);
      }

      // Send to model (includes system-reminder if present).
      // Hand the model client this agent's request signal so an interrupt cancels
      // ONLY this agent's request — never sibling/background agents that share the
      // same underlying client.
      // Last line of defence for the tool_call/tool_result pairing invariant.
      // Every producer funnels through here, so one check covers them all —
      // including ephemeral read results pruned at end of turn, which orphan a
      // tool call during entirely ordinary use.
      this.conversationManager.reconcileToolCalls();

      const sentMessages = this.conversationManager.getMessages();
      const estimatedRequestTokens = this.tokenManager.estimateMessagesTokens(sentMessages)
        + this.tokenManager.estimateTokens(JSON.stringify(functions))
        + this.tokenManager.getCalibrationOverhead();
      const remainingTokens = Math.max(0, this.tokenManager.getContextSize() - estimatedRequestTokens);
      const dynamicMaxTokens = Math.max(
        TOKEN_MANAGEMENT.MIN_OUTPUT_TOKENS,
        Math.floor(remainingTokens * TOKEN_MANAGEMENT.DYNAMIC_OUTPUT_PERCENT)
      );
      const response = await this.modelClient.send(sentMessages, {
        functions,
        // Disable streaming for subagents - only main agent should stream responses
        stream: !this.config.isSpecializedAgent && this.appConfig.stream_responses,
        // Pass parentCallId for associating thinking events with tool calls
        parentId: executionContext.parentCallId,
        // Route thinking/assistant events to THIS agent's stream. For a sub-agent
        // that is its scoped stream, keeping its reasoning isolated from the main
        // conversation (the shared model client otherwise emits on the root stream).
        activityStream: this.activityStream,
        // Dynamic output token limit based on remaining context
        dynamicMaxTokens,
        signal: this.interruptionManager.beginRequest(),
        retryPolicy: 'foreground',
        providerState: this.conversationManager.getProviderState(),
      });

      if (response.providerState) {
        this.conversationManager.setProviderState(response.providerState);
        const checkpoint = this.conversationManager.getCheckpoint();
        if (checkpoint) {
          checkpoint.providerState = structuredClone(response.providerState);
          if (response.nativeCompaction) checkpoint.strategy = 'openai-native';
          this.conversationManager.setCheckpoint(checkpoint);
        }
      }
      if (response.nativeCompaction) this.nativeCompactionPending = true;

      // Calibrate the token estimator against the backend's actual prompt-token
      // count. The gap (tool schemas, chat template, the model's own tokenizer)
      // is what the message-only estimate misses; feeding it back keeps budget
      // decisions accurate for whatever open model is running.
      if (response.usage?.promptTokens) {
        const estimated = this.tokenManager.estimateMessagesTokens(sentMessages)
          + this.tokenManager.estimateTokens(JSON.stringify(functions));
        this.tokenManager.calibrate(estimated, response.usage.promptTokens);
      }

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
    if (response.interrupted && !this.interruptionManager.isInterrupted()) {
      throw new Error('Model generation stopped without an agent interruption cause');
    }

    if (response.error && !this.config.isSpecializedAgent) {
      await ServiceRegistry.getInstance().get('run_supervisor')?.block(
        response.content || response.error_message || 'Non-retryable model endpoint error'
      );
    }

    // Check for interruption
    if (this.interruptionManager.isInterrupted() || response.interrupted) {
      // Handle interjection vs cancellation
      const cause = this.interruptionManager.getCause();
      if (cause?.kind === 'user_interjection') {
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
        // Internal detection stopped generation so it can be continued cleanly.
        if (isRecoverableInterruption(cause)) {
          return await this.continueAfterRecovery(cause, executionContext);
        }

        // Regular cancel - mark as interrupted for next request
        logger.debug('[AGENT]', this.instanceId, 'Returning USER_FACING_INTERRUPTION (regular cancel after timeout)');
        this.interruptionManager.markRequestAsInterrupted();

        this.emitAgentEnd(true, cause?.kind);

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
      const interruptionCause = this.interruptionManager.getCause();

      if (interruptionCause?.kind === 'user_interjection') {
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
      } else if (isRecoverableInterruption(interruptionCause)) {
        return await this.continueAfterRecovery(interruptionCause, executionContext);
      } else {
        // Regular cancel - mark as interrupted for next request
        logger.debug('[AGENT]', this.instanceId, 'Returning USER_FACING_INTERRUPTION (interrupted after ResponseProcessor)');
        this.interruptionManager.markRequestAsInterrupted();

        this.emitAgentEnd(true, interruptionCause?.kind);

        return PERMISSION_MESSAGES.USER_FACING_INTERRUPTION;
      }
    }

    if (!this.config.isSpecializedAgent && result.trim()) {
      const registry = ServiceRegistry.getInstance();
      const supervisor = registry.get('run_supervisor');
      const policy = registry.get('run_policy_manager')?.getPolicy();
      if (policy?.completion === 'durable_objective' && supervisor?.isRunning()) {
        await supervisor.recordProgress(result);
        this.conversationManager.addMessage(createSystemReminder(
          'The durable objective is still active. Continue working automatically. Do not ask the user. When all todos, required background work, and verification are complete, call complete-objective with concise evidence. If no safe automatic path remains, call block-objective with the concrete blocker.',
          false
        ));
        const continuation = await this.getLLMResponse(executionContext);
        return await this.processLLMResponse(continuation, executionContext);
      }
    }

    return result;
  }

  private async continueAfterRecovery(
    cause: RecoverableInterruptionCause,
    executionContext: AgentExecutionContext
  ): Promise<string> {
    if (this.invocationState.recoveryAttempts >= AGENT_CONFIG.MAX_AUTOMATIC_RECOVERY_ATTEMPTS) {
      const message =
        `I stopped because model generation repeatedly made no concrete progress after ` +
        `${AGENT_CONFIG.MAX_AUTOMATIC_RECOVERY_ATTEMPTS} automatic recovery attempt. ` +
        `The task may be incomplete. Last detected condition: ${cause.reason}`;
      logger.warn('[AGENT_RECOVERY]', this.instanceId, message);

      this.interruptionManager.reset();
      this.stopActivityMonitoring();
      this.loopDetector.resetTextDetectors();

      if (this.config.isSpecializedAgent) {
        throw new Error(message);
      }

      this.conversationManager.addMessage({
        role: 'assistant',
        content: message,
        timestamp: Date.now(),
        metadata: { agentName: this.agentName },
      });

      await ServiceRegistry.getInstance().get('run_supervisor')?.block(message);
      return message;
    }

    this.invocationState.recoveryAttempts++;
    logger.debug(
      '[AGENT_RECOVERY]',
      this.instanceId,
      `${cause.kind}: ${cause.reason} (attempt ${this.invocationState.recoveryAttempts})`
    );

    await this.checkAutoCompaction();

    const continuationPrompt = cause.kind === 'activity_timeout'
      ? createActivityTimeoutContinuationReminder()
      : cause.kind === 'response_loop'
        ? createResponseLoopContinuationReminder(cause.reason)
        : createThinkingLoopContinuationReminder(cause.reason);
    this.conversationManager.addMessage(continuationPrompt);

    this.interruptionManager.reset();
    this.invocationState.requestInProgress = true;
    this.startActivityMonitoring();
    this.loopDetector.resetTextDetectors();

    const continuationResponse = await this.getLLMResponse(executionContext);
    return await this.processLLMResponse(continuationResponse, executionContext);
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
      executeToolCalls: async (toolCalls, cycles) => {
        // The no-progress watchdog protects model generation, not legitimate
        // long-running tools (builds, tests, foreground commands, permission
        // waits). Pause it for the complete tool batch and resume afterward.
        this.pauseActivityMonitoring();
        let completed = false;
        // Execute tool calls via orchestrator
        // Permission denied errors need special handling by Agent.ts
        try {
          const results = await this.toolOrchestrator.executeToolCalls(toolCalls, cycles);

          // Note: Exploratory tool tracking is handled inside ToolOrchestrator

          completed = true;
          return results;
        } catch (error) {
          // Check if this is a permission denied error that triggered interruption
          if (isPermissionDeniedError(error)) {
            logger.debug('[AGENT_CONTEXT]', this.instanceId, 'Permission denied during tool execution - adding tool results before interruption');

            // Answer only the calls still unanswered. Sequential execution
            // appends each result as it completes, so an earlier tool in the
            // batch may already have one; appending a second result for the same
            // id would corrupt tool_call/result pairing.
            const added = this.conversationManager.addMissingToolResults(
              toolCalls,
              PERMISSION_DENIED_TOOL_RESULT,
              'permission_denied'
            );

            logger.debug('[AGENT_CONTEXT]', this.instanceId, `Added ${added} permission denial tool result(s). Total messages now:`, this.conversationManager.getMessageCount());

            // Save session with permission denial context
            this.autoSaveSession();
          }

          // Re-throw to propagate to Agent.ts error handler
          throw error;
        } finally {
          this.resumeActivityMonitoring(completed);
        }
      },
      detectCycles: (toolCalls) => this.loopDetector.detectCycles(toolCalls),
      recordToolCalls: (toolCalls, results) => {
        this.loopDetector.recordToolCalls(toolCalls, results);
        this.turnController.recordToolCalls(toolCalls.length);
        // Increment checkpoint counters after successful tool execution
        this.checkpointTracker.incrementToolCalls(toolCalls.length);
      },
      clearCyclesIfBroken: () => this.loopDetector.clearCyclesIfBroken(),
      clearCurrentTurn: () => this.toolManager.clearCurrentTurn(this.instanceId),
      startToolExecution: () => this.startToolExecution(),
      cleanupEphemeralMessages: () => this.cleanupEphemeralMessages(),
      ensureContextRoom: async () => {
        await this.checkAutoCompaction();
      },
    };
  }

  getTurnSnapshot(): TurnSnapshot {
    return this.turnController.snapshot();
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
    // Thin pass-through: the bookkeeping hangs off ConversationManager itself
    // (see onMessageAdded), so the 26 places that append directly through the
    // manager get it too.
    this.conversationManager.addMessage(message);
  }

  /**
   * Keep token accounting, the context-usage event, and autosave in step with
   * every appended message, whoever appended it.
   *
   * Registered on ConversationManager rather than performed in `addMessage`
   * because Agent and ResponseProcessor append 26 messages directly through the
   * manager. Were those writes to skip this, the token count the auto-compaction
   * threshold reads would drift until the next full recount.
   */
  private onMessageAdded(message: Message): void {
    // Incremental: O(1) rather than re-counting the whole conversation.
    this.tokenManager.addMessageTokens(message);

    const contextUsage = this.tokenManager.getContextUsagePercentage();
    this.emitEvent({
      id: this.generateId(),
      type: ActivityEventType.CONTEXT_USAGE_UPDATE,
      timestamp: Date.now(),
      data: {
        contextUsage,
        // Include parentCallId for specialized agents so UI can update the tool call
        parentCallId: this.config.isSpecializedAgent ? this.activeExecutionContext.parentCallId : undefined,
      },
    });

    const toolInfo = message.tool_calls ? ` toolCalls:${message.tool_calls.length}` : '';
    const toolCallId = message.tool_call_id ? ` toolCallId:${message.tool_call_id}` : '';
    const toolName = message.name ? ` name:${message.name}` : '';
    logger.debug('[AGENT_CONTEXT]', this.instanceId, 'Message added:', message.role, toolInfo, toolCallId, toolName, '- Total messages:', this.conversationManager.getMessageCount());

    this.autoSaveSession();
  }

  /**
   * Get the current conversation history (readonly reference)
   *
   * @returns Readonly reference to message array
   */
  getMessages(): readonly Message[] {
    return this.conversationManager.getTranscript();
  }

  /** Model-facing active window; unlike getMessages(), this may be compacted. */
  getContextMessages(): readonly Message[] {
    return this.conversationManager.getMessages();
  }

  /**
   * Get a copy of the conversation history for mutation
   *
   * @returns Copy of message array
   */
  getMessagesCopy(): Message[] {
    return this.conversationManager.getTranscriptCopy();
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

  /** Restore independently persisted transcript, active window, and checkpoint. */
  loadConversationState(
    messages: Message[],
    transcript: Message[],
    checkpoint: import('./compaction/types.js').ConversationCheckpointV1 | null,
    providerState: import('./compaction/types.js').ProviderCheckpointState = checkpoint?.providerState ?? { kind: 'chat' },
  ): void {
    const safeCheckpoint = checkpoint ? structuredClone(checkpoint) : null;
    let safeProviderState = structuredClone(providerState);
    const replayProvider = safeProviderState.kind === 'chat'
      ? undefined
      : safeProviderState.provider ?? safeCheckpoint?.provider;
    const replayModel = safeProviderState.kind === 'chat'
      ? undefined
      : safeProviderState.model ?? safeCheckpoint?.model;
    if (safeProviderState.kind !== 'chat'
      && (replayProvider !== this.modelClient.providerId
        || replayModel !== this.modelClient.modelName)) {
      logger.warn(
        '[COMPACTION] Ignoring provider-native replay state because the resumed provider/model differs; using the portable semantic checkpoint.',
      );
      safeProviderState = { kind: 'chat' };
      if (safeCheckpoint) {
        safeCheckpoint.providerState = { kind: 'chat' };
        safeCheckpoint.strategy = safeCheckpoint.portability === 'extractive'
          ? 'local-extractive'
          : 'local-structured';
      }
    }
    this.conversationManager.loadConversation(messages, transcript, safeCheckpoint, safeProviderState);
    this.tokenManager.updateTokenCount(this.conversationManager.getMessages());
  }

  /**
   * Inject relevant project memory for the current user message as an ephemeral,
   * background-context system reminder.
   *
   * Main agent only (the memory tool is hidden from sub-agents anyway). Skipped
   * when context is already tight — memory is frequently used with local models,
   * so this must not crowd a small window. MemoryService enforces strict caps and
   * returns null when nothing is relevant enough to surface.
   */
  private async injectRelevantMemory(message: string): Promise<void> {
    try {
      // Match the index-injection gate (skills/index disappear at the same ceiling);
      // auto-recall is heavier, so it should never outlive the index it elaborates on.
      if (
        this.tokenManager &&
        typeof this.tokenManager.getContextUsagePercentage === 'function' &&
        this.tokenManager.getContextUsagePercentage() >= CONTEXT_THRESHOLDS.INJECTION_CEILING
      ) {
        return;
      }

      const memoryService = ServiceRegistry.getInstance().get('memory_service');
      if (!memoryService || typeof memoryService.getAutoRecallContext !== 'function') {
        return;
      }

      const recall = await memoryService.getAutoRecallContext(message);
      if (!recall) {
        return;
      }

      // PERSIST: false - Ephemeral, recomputed from each user message and stripped after the turn.
      this.conversationManager.addMessage(createSystemReminder(recall, false));
      logger.debug('[AGENT_MEMORY]', this.instanceId, 'Injected relevant memory recall');
    } catch (error) {
      logger.warn('[AGENT_MEMORY] Failed to inject memory recall:', formatError(error));
    }
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
   * Compact, apply, verify, emit UI events, and persist the active conversation.
   * Used by manual /compact so it shares the same mutation path as auto-compaction.
   */
  async compactCurrentConversation(options: CompactionOptions = {}): Promise<AppliedCompactionResult> {
    const result = await this.agentCompactor.compactAndApply({
      instanceId: this.instanceId,
      isSpecializedAgent: this.config.isSpecializedAgent || false,
      generateId: () => this.generateId(),
      parentCallId: this.activeExecutionContext.parentCallId,
      signal: this.interruptionManager.beginRequest(),
      modelMaxOutput: this.appConfig.max_tokens,
      phase: 'manual',
    }, {
      ...options,
      trigger: 'manual',
      phase: 'manual',
    });

    await this.autoSaveSession();
    return result;
  }

  /** Mirror provider-triggered same-response compaction into the durable local window. */
  private async adoptPendingNativeCompaction(): Promise<void> {
    if (!this.nativeCompactionPending) return;
    const providerState = this.conversationManager.getProviderState();
    if (providerState.kind !== 'openai-responses') {
      this.nativeCompactionPending = false;
      return;
    }
    try {
      await this.agentCompactor.compactAndApply({
        instanceId: this.instanceId,
        isSpecializedAgent: this.config.isSpecializedAgent || false,
        generateId: () => this.generateId(),
        parentCallId: this.activeExecutionContext.parentCallId,
        signal: this.interruptionManager.beginRequest(),
        functions: this.lastRequestFunctions,
        modelMaxOutput: this.appConfig.max_tokens,
        phase: 'post-turn',
      }, {
        trigger: 'automatic',
        phase: 'post-turn',
        providerStateOverride: providerState,
      });
      this.nativeCompactionPending = false;
    } catch (error) {
      // The provider state remains valid and will be retried after a later turn.
      logger.warn('[COMPACTION] Could not mirror provider compaction into the local checkpoint yet:', error);
    }
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
    const transcript = this.conversationManager.getTranscript();
    const userMessages = transcript.filter(m => m.role === 'user');

    if (userMessageIndex < 0 || userMessageIndex >= userMessages.length) {
      throw new Error(`Invalid message index: ${userMessageIndex}. Must be between 0 and ${userMessages.length - 1}`);
    }

    // Get the target user message
    const targetMessage = userMessages[userMessageIndex];
    if (!targetMessage) {
      throw new Error(`Target message at index ${userMessageIndex} not found`);
    }

    const cutoffIndex = transcript.findIndex(m => m.id === targetMessage.id);

    if (cutoffIndex === -1) {
      throw new Error('Target message not found in conversation history');
    }

    const systemMessage = this.conversationManager.getSystemMessage()?.role === 'system' ? this.conversationManager.getSystemMessage() : null;
    const truncatedMessages = transcript.slice(0, cutoffIndex);

    this.conversationManager.setMessages(systemMessage ? [systemMessage, ...truncatedMessages] : truncatedMessages);
    this.conversationManager.setCheckpoint(null);
    this.conversationManager.setProviderState({ kind: 'chat' });

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
    return this.turnAdmissionActive;
  }

  /**
   * Check whether the current complete request exceeds its safe input budget.
   */
  private async checkAutoCompaction(
    functions?: readonly FunctionDefinition[],
    dynamicContext?: string
  ): Promise<void> {
    const lastRole = this.conversationManager.getLastMessage()?.role;
    const compacted = await this.agentCompactor.checkAndPerformAutoCompaction({
      instanceId: this.instanceId,
      isSpecializedAgent: this.config.isSpecializedAgent || false,
      generateId: () => this.generateId(),
      parentCallId: this.activeExecutionContext.parentCallId,
      signal: this.interruptionManager.beginRequest(),
      functions,
      dynamicContext,
      modelMaxOutput: this.appConfig.max_tokens,
      phase: lastRole === 'user' ? 'pre-turn' : 'mid-turn',
    });

    if (compacted) {
      await this.autoSaveSession();
    }
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
  private emitAgentEnd(
    interrupted: boolean = false,
    interruptionCause?: string,
    content?: string
  ): void {
    if (this.invocationState.agentEndEmitted) return;
    this.emitEvent({
      id: this.generateId(),
      type: ActivityEventType.AGENT_END,
      timestamp: Date.now(),
      data: {
        interrupted,
        interruptionCause,
        content,
        isSpecializedAgent: this.config.isSpecializedAgent || false,
        instanceId: this.instanceId,
        agentName: this.config.agentType || 'ally',
      },
    });
    this.invocationState.agentEndEmitted = true;
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
   * Handles multiple consecutive interjections with a retry limit
   */
  private async continueWithInterjection(executionContext: AgentExecutionContext): Promise<string> {
    let retryCount = 0;

    while (retryCount < AGENT_CONFIG.MAX_INTERJECTION_RETRIES) {
      retryCount++;
      logger.debug('[AGENT]', this.instanceId, `Permission denied but user provided instructions - continuing (attempt ${retryCount}/${AGENT_CONFIG.MAX_INTERJECTION_RETRIES})`);
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

    // Exceeded retry limit
    logger.warn('[AGENT]', this.instanceId, `Exceeded maximum interjection retries (${AGENT_CONFIG.MAX_INTERJECTION_RETRIES})`);
    this.interruptionManager.markRequestAsInterrupted();
    this.emitAgentEnd(true);
    return PERMISSION_MESSAGES.USER_FACING_DENIAL;
  }

  /**
   * Restore focus without full cleanup
   *
   * Used for pooled agents that need focus restored but shouldn't be fully cleaned up.
   * This is called before releasing agents back to the pool. Idempotent: cleanup()
   * calls it again and the second call is a no-op.
   */
  async restoreFocus(): Promise<void> {
    await this.focusScope.release();
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
    // This is critical for long-running sessions with many agents.
    //
    // Each agent owns its stream: the main/root agent owns the root stream (torn
    // down at shutdown), and a sub-agent owns a scoped child stream (parentId set)
    // that must be released on disposal. We must NEVER cleanup the shared root
    // stream from a sub-agent — but sub-agents no longer share it, so a scoped
    // stream is the precise signal that cleanup is safe and required.
    const ownsScopedStream = this.activityStream?.getParentId?.() !== undefined;
    if ((!this.config.isSpecializedAgent || ownsScopedStream) && this.activityStream && typeof this.activityStream.cleanup === 'function') {
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
