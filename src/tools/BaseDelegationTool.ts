/**
 * BaseDelegationTool - Abstract base class for agent delegation tools
 *
 * Encapsulates common patterns across ExploreTool, PlanTool, and ManageAgentsTool.
 * These tools delegate to specialized agents with read-only + specific tool access.
 *
 * Key responsibilities:
 * - Service retrieval and validation
 * - Model client creation with thoroughness-based token limits
 * - Agent pool management (acquire/release)
 * - Registry management (register/restore agent)
 * - Delegation context registration
 * - Event emission (AGENT_START, AGENT_END)
 * - Response formatting with agent reminders
 * - Cleanup and error handling
 */

import { BaseTool } from './BaseTool.js';
import { InjectableTool } from './InjectableTool.js';
import { ToolResult, ActivityEventType } from '../types/index.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { ServiceRegistry, ScopedServiceRegistryProxy } from '../services/ServiceRegistry.js';
import { Agent, AgentConfig } from '../agent/Agent.js';
import { ModelClient } from '../llm/ModelClient.js';
import { logger } from '../services/Logger.js';
import { ToolManager } from './ToolManager.js';
import { formatError } from '../utils/errorUtils.js';
import { TEXT_LIMITS, FORMATTING } from '../config/constants.js';
import { AgentPoolService, PooledAgent } from '../services/AgentPoolService.js';
import { getThoroughnessDuration, getThoroughnessMaxTokens } from '../ui/utils/timeUtils.js';
import { createAgentPersistenceReminder } from '../utils/messageUtils.js';
import { getModelClientForAgent } from '../utils/modelClientUtils.js';
import { extractSummaryFromConversation } from '../utils/agentUtils.js';
import type { Config } from '../types/index.js';

/**
 * Configuration for a delegation tool
 */
export interface DelegationToolConfig {
  /** Agent type identifier (e.g., AGENT_TYPES.EXPLORE) */
  agentType: string;

  /** Array of tool names allowed for this agent */
  allowedTools: string[];

  /** Optional config key for model override (e.g., 'explore_model', 'plan_model') */
  modelConfigKey?: string;

  /** Optional array of tool names that MUST be called before agent exits */
  requiredToolCalls?: string[];

  /** Optional reasoning effort override (e.g., REASONING_EFFORT.HIGH for planning) */
  reasoningEffort?: string;

  /** Whether agent can manage todos (PlanTool needs this) */
  allowTodoManagement?: boolean;

  /** Default fallback text for empty responses */
  emptyResponseFallback?: string;

  /** Summary label for extracting conversation summaries */
  summaryLabel?: string;
}

/**
 * Abstract base class for agent delegation tools (Explore, Plan, ManageAgents)
 *
 * Implements common delegation patterns while allowing subclasses to customize
 * behavior through configuration and abstract methods.
 */
export abstract class BaseDelegationTool extends BaseTool implements InjectableTool {
  /** Map of active delegations by call ID */
  protected activeDelegations = new Map<string, { agent: Agent; startTime: number }>();

  /** Currently active pooled agent (for interjection routing) */
  protected _currentPooledAgent: PooledAgent | null = null;

  // InjectableTool interface properties
  get delegationState(): 'executing' | 'completing' | null {
    // Always null - delegation state is managed by DelegationContextManager
    return null;
  }

  get activeCallId(): string | null {
    // Always null - delegation tracking is done by DelegationContextManager
    return null;
  }

  get currentPooledAgent(): PooledAgent | null {
    return this._currentPooledAgent;
  }

  constructor(activityStream: ActivityStream) {
    super(activityStream);

    // Listen for global interrupt events
    this.activityStream.subscribe(ActivityEventType.INTERRUPT_ALL, () => {
      this.interruptAll();
    });
  }

  /**
   * Get tool configuration (agent type, allowed tools, model config, etc.)
   * Subclasses must implement this to define their specific configuration.
   */
  protected abstract getConfig(): DelegationToolConfig;

  /**
   * Get system prompt for the agent
   * Subclasses must implement this to provide agent-specific instructions.
   *
   * @param config - Application configuration
   * @param additionalContext - Optional additional context (e.g., agents directory)
   */
  protected abstract getSystemPrompt(config: Config, additionalContext?: any): string;

  /**
   * Extract task prompt from tool arguments
   * Subclasses must implement this to handle different parameter names.
   *
   * @param args - Tool execution arguments
   */
  protected abstract getTaskPromptFromArgs(args: any): string;

  /**
   * Optional: Perform additional setup before agent execution
   * Subclasses can override this to add custom setup logic.
   *
   * @param config - Application configuration
   * @returns Additional context to pass to getSystemPrompt
   */
  protected async performAdditionalSetup(_config: Config): Promise<any> {
    return undefined;
  }

  /**
   * Optional: Post-process the agent response before returning
   * Subclasses can override this to add custom response processing.
   *
   * @param response - Agent response
   * @param config - Tool configuration
   * @param registry - Service registry (can be scoped or global)
   */
  protected async postProcessResponse(
    response: string,
    _config: DelegationToolConfig,
    _registry: ServiceRegistry | ScopedServiceRegistryProxy
  ): Promise<string> {
    return response;
  }

  /**
   * Optional: Add custom fields to the success response
   * Subclasses can override this to add tool-specific response fields.
   *
   * @param successResponse - Success response object to augment
   * @param config - Tool configuration
   * @param agentId - Agent ID if available
   */
  protected augmentSuccessResponse(
    _successResponse: Record<string, any>,
    _config: DelegationToolConfig,
    _agentId: string | null
  ): void {
    // Default: no augmentation
  }

  /**
   * Execute delegation to specialized agent
   *
   * This is the common implementation extracted from all three delegation tools.
   * Handles service retrieval, agent creation, execution, and cleanup.
   *
   * @param taskPrompt - The task to delegate
   * @param thoroughness - Thoroughness level
   * @param callId - Unique call identifier
   */
  protected async executeDelegation(
    taskPrompt: string,
    thoroughness: string,
    callId: string
  ): Promise<ToolResult> {
    const config = this.getConfig();
    logger.debug(`[${this.name.toUpperCase()}_TOOL] Starting delegation, callId:`, callId, 'thoroughness:', thoroughness);
    const startTime = Date.now();

    try {
      // Get required services
      const registry = ServiceRegistry.getInstance();
      const mainModelClient = registry.get<ModelClient>('model_client');
      const toolManager = registry.get<ToolManager>('tool_manager');
      const configManager = registry.get<any>('config_manager');
      const permissionManager = registry.get<any>('permission_manager');

      // Enforce strict service availability
      if (!mainModelClient) {
        throw new Error(`${this.name} requires model_client to be registered`);
      }
      if (!toolManager) {
        throw new Error(`${this.name} requires tool_manager to be registered`);
      }
      if (!configManager) {
        throw new Error(`${this.name} requires config_manager to be registered`);
      }
      if (!permissionManager) {
        throw new Error(`${this.name} requires permission_manager to be registered`);
      }

      const appConfig = configManager.getConfig();
      if (!appConfig) {
        throw new Error('ConfigManager.getConfig() returned null/undefined');
      }

      // Perform any additional setup (e.g., fetching available models)
      const additionalContext = await this.performAdditionalSetup(appConfig);

      // Determine target model
      const targetModel = config.modelConfigKey
        ? (appConfig[config.modelConfigKey] || appConfig.model)
        : appConfig.model;

      // Calculate max tokens based on thoroughness
      const maxTokens = getThoroughnessMaxTokens(thoroughness as any, appConfig.max_tokens);
      logger.debug(`[${this.name.toUpperCase()}_TOOL] Set maxTokens to ${maxTokens} for thoroughness: ${thoroughness}`);

      // Create appropriate model client
      const agentData: any = { model: targetModel };
      if (config.reasoningEffort) {
        agentData.reasoning_effort = config.reasoningEffort;
      }
      const modelClient = await getModelClientForAgent({
        agentConfig: agentData,
        appConfig: appConfig,
        sharedClient: mainModelClient,
        activityStream: this.activityStream,
        maxTokens: maxTokens,
        context: `[${this.name.toUpperCase()}_TOOL]`,
      });

      // Emit agent start event
      this.emitEvent({
        id: callId,
        type: ActivityEventType.AGENT_START,
        timestamp: Date.now(),
        data: {
          agentName: config.agentType,
          taskPrompt: taskPrompt,
          model: targetModel,
        },
      });

      // Map thoroughness to max duration
      const maxDuration = getThoroughnessDuration(thoroughness as any);

      // Get parent agent - the agent currently executing this tool
      const parentAgent = registry.get<any>('agent');

      // Calculate agent depth for nesting
      const currentDepth = parentAgent?.getAgentDepth?.() ?? 0;
      const newDepth = currentDepth + 1;

      // Create agent configuration with unique pool key per invocation
      const agentConfig: AgentConfig = {
        isSpecializedAgent: true,
        verbose: false,
        baseAgentPrompt: this.getSystemPrompt(appConfig, additionalContext),
        taskPrompt: taskPrompt,
        config: appConfig,
        parentCallId: callId,
        parentAgent: parentAgent,
        _poolKey: `${this.name}-${callId}`,
        maxDuration,
        thoroughness: thoroughness,
        agentType: config.agentType,
        agentDepth: newDepth,
        allowedTools: config.allowedTools,
      };

      // Add optional config
      if (config.requiredToolCalls) {
        agentConfig.requiredToolCalls = config.requiredToolCalls;
      }
      if (config.allowTodoManagement) {
        agentConfig.allowTodoManagement = config.allowTodoManagement;
      }

      // Always use pooled agent for persistence
      let delegationAgent: Agent;
      let pooledAgent: PooledAgent | null = null;
      let agentId: string | null = null;

      // Use AgentPoolService for persistent agent
      const agentPoolService = registry.get<AgentPoolService>('agent_pool');

      if (!agentPoolService) {
        // Graceful fallback: AgentPoolService not available
        logger.warn(`[${this.name.toUpperCase()}_TOOL] AgentPoolService not available, falling back to ephemeral agent`);
        delegationAgent = new Agent(
          modelClient,
          toolManager,
          this.activityStream,
          agentConfig,
          configManager,
          permissionManager
        );
      } else {
        // Acquire agent from pool
        logger.debug(`[${this.name.toUpperCase()}_TOOL] Acquiring agent from pool`);
        // Pass custom modelClient only if using a different model than global
        const customModelClient = targetModel !== appConfig.model ? modelClient : undefined;
        pooledAgent = await agentPoolService.acquire(agentConfig, toolManager, customModelClient);
        delegationAgent = pooledAgent.agent;
        agentId = pooledAgent.agentId;
        this._currentPooledAgent = pooledAgent; // Track for interjection routing

        // Register delegation with DelegationContextManager
        try {
          const serviceRegistry = ServiceRegistry.getInstance();
          const toolManager = serviceRegistry.get<any>('tool_manager');
          const delegationManager = toolManager?.getDelegationContextManager();
          if (delegationManager) {
            delegationManager.register(callId, config.agentType, pooledAgent);
            logger.debug(`[${this.name.toUpperCase()}_TOOL] Registered delegation: callId=${callId}`);
          }
        } catch (error) {
          // ServiceRegistry not available in tests - skip delegation registration
          logger.debug(`[${this.name.toUpperCase()}_TOOL] Delegation registration skipped: ${error}`);
        }

        logger.debug(`[${this.name.toUpperCase()}_TOOL] Acquired pooled agent:`, agentId);
      }

      // Track active delegation
      this.activeDelegations.set(callId, {
        agent: delegationAgent,
        startTime: Date.now(),
      });

      // Create scoped registry for this delegation
      // This ensures nested tool calls get correct parent without global mutation
      const scopedRegistry = new ScopedServiceRegistryProxy(registry);
      scopedRegistry.registerInstance('agent', delegationAgent);

      try {
        // Execute delegation
        logger.debug(`[${this.name.toUpperCase()}_TOOL] Sending task to agent...`);
        const taskMessage = this.formatTaskMessage(taskPrompt);
        const response = await delegationAgent.sendMessage(taskMessage, {
          parentCallId: callId,
          maxDuration,
          thoroughness,
        });
        logger.debug(`[${this.name.toUpperCase()}_TOOL] Agent response received, length:`, response?.length || 0);

        let finalResponse: string;

        // Ensure we have a substantial response
        const fallback = config.emptyResponseFallback || 'Operation completed but no summary was provided.';
        const label = config.summaryLabel || 'Results:';

        if (!response || response.trim().length === 0) {
          logger.debug(`[${this.name.toUpperCase()}_TOOL] Empty response, extracting from conversation`);
          finalResponse = extractSummaryFromConversation(delegationAgent, `[${this.name.toUpperCase()}_TOOL]`, label) || fallback;
        } else if (response.includes('[Request interrupted') || response.length < TEXT_LIMITS.AGENT_RESPONSE_MIN) {
          logger.debug(`[${this.name.toUpperCase()}_TOOL] Incomplete response, attempting to extract summary`);
          const summary = extractSummaryFromConversation(delegationAgent, `[${this.name.toUpperCase()}_TOOL]`, label);
          finalResponse = (summary && summary.length > response.length) ? summary : response;
        } else {
          finalResponse = response;
        }

        // Allow subclass to post-process response (pass scoped registry)
        finalResponse = await this.postProcessResponse(finalResponse, config, scopedRegistry);

        const duration = (Date.now() - startTime) / 1000;

        // Emit agent end event
        this.emitEvent({
          id: callId,
          type: ActivityEventType.AGENT_END,
          timestamp: Date.now(),
          data: {
            agentName: config.agentType,
            result: finalResponse,
            duration,
          },
        });

        // Append note that user cannot see this
        const content = finalResponse + '\n\nIMPORTANT: The user CANNOT see this output! You must share relevant information, summarized or verbatim with the user in your own response, if appropriate.';

        // Build response with agent_used
        const successResponse: Record<string, any> = {
          content,
          duration_seconds: Math.round(duration * Math.pow(10, FORMATTING.DURATION_DECIMAL_PLACES)) / Math.pow(10, FORMATTING.DURATION_DECIMAL_PLACES),
          agent_used: config.agentType,
        };

        // Always include agent_id when available
        if (agentId) {
          successResponse.agent_id = agentId;
          const reminder = createAgentPersistenceReminder(agentId);
          Object.assign(successResponse, reminder);
        }

        // Allow subclass to augment response
        this.augmentSuccessResponse(successResponse, config, agentId);

        return this.formatSuccessResponse(successResponse);
      } finally {
        // Clean up delegation tracking
        logger.debug(`[${this.name.toUpperCase()}_TOOL] Cleaning up agent...`);
        this.activeDelegations.delete(callId);

        // Release agent back to pool or cleanup ephemeral agent
        if (pooledAgent) {
          // Release agent back to pool
          logger.debug(`[${this.name.toUpperCase()}_TOOL] Releasing agent back to pool`);
          pooledAgent.release();

          // Transition delegation to completing state
          try {
            const serviceRegistry = ServiceRegistry.getInstance();
            const toolManager = serviceRegistry.get<any>('tool_manager');
            const delegationManager = toolManager?.getDelegationContextManager();
            if (delegationManager) {
              delegationManager.transitionToCompleting(callId);
              logger.debug(`[${this.name.toUpperCase()}_TOOL] Transitioned delegation to completing: callId=${callId}`);
            }
          } catch (error) {
            logger.debug(`[${this.name.toUpperCase()}_TOOL] Delegation transition skipped: ${error}`);
          }

          this._currentPooledAgent = null; // Clear tracked pooled agent
        } else {
          // Cleanup ephemeral agent (only if AgentPoolService was unavailable)
          await delegationAgent.cleanup();

          // Transition delegation to completing state
          try {
            const serviceRegistry = ServiceRegistry.getInstance();
            const toolManager = serviceRegistry.get<any>('tool_manager');
            const delegationManager = toolManager?.getDelegationContextManager();
            if (delegationManager) {
              delegationManager.transitionToCompleting(callId);
              logger.debug(`[${this.name.toUpperCase()}_TOOL] Transitioned delegation to completing: callId=${callId}`);
            }
          } catch (error) {
            logger.debug(`[${this.name.toUpperCase()}_TOOL] Delegation transition skipped: ${error}`);
          }
        }
      }
    } catch (error) {
      const errorType = (error as any)?.error_type || 'execution_error';
      return this.formatErrorResponse(
        `Delegation failed: ${formatError(error)}`,
        errorType,
        undefined,
        { agent_used: config.agentType }
      );
    }
  }

  /**
   * Format the task message sent to the agent
   * Can be overridden by subclasses for custom formatting
   *
   * @param taskPrompt - The task prompt to format
   */
  protected formatTaskMessage(taskPrompt: string): string {
    return `Execute this task: ${taskPrompt}`;
  }

  /**
   * Interrupt all active delegations
   */
  interruptAll(): void {
    logger.debug(`[${this.name.toUpperCase()}_TOOL] Interrupting`, this.activeDelegations.size, 'active delegations');
    for (const [callId, delegation] of this.activeDelegations.entries()) {
      const agent = delegation.agent;
      if (agent && typeof agent.interrupt === 'function') {
        logger.debug(`[${this.name.toUpperCase()}_TOOL] Interrupting delegation:`, callId);
        agent.interrupt();
      }
    }
  }

  /**
   * Inject user message into active pooled agent
   * Used for routing interjections to subagents
   */
  injectUserMessage(message: string): void {
    if (!this._currentPooledAgent) {
      logger.warn(`[${this.name.toUpperCase()}_TOOL] injectUserMessage called but no active pooled agent`);
      return;
    }

    const agent = this._currentPooledAgent.agent;
    if (!agent) {
      logger.warn(`[${this.name.toUpperCase()}_TOOL] injectUserMessage called but pooled agent has no agent instance`);
      return;
    }

    logger.debug(`[${this.name.toUpperCase()}_TOOL] Injecting user message into pooled agent:`, this._currentPooledAgent.agentId);
    agent.addUserInterjection(message);
    agent.interrupt('interjection');
  }

  /**
   * Get a preview of the tool result for display
   * Common implementation for all delegation tools
   */
  getResultPreview(result: ToolResult, maxLines: number = 3): string[] {
    if (!result.success) {
      return super.getResultPreview(result, maxLines);
    }

    const lines: string[] = [];

    // Show duration if available
    if (result.duration_seconds !== undefined) {
      lines.push(`Completed in ${result.duration_seconds}s`);
    }

    // Show content preview
    if (result.content) {
      const contentPreview =
        result.content.length > TEXT_LIMITS.AGENT_RESULT_PREVIEW_MAX
          ? result.content.substring(0, TEXT_LIMITS.AGENT_RESULT_PREVIEW_MAX - 3) + '...'
          : result.content;
      lines.push(contentPreview);
    }

    return lines.slice(0, maxLines);
  }
}
