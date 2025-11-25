/**
 * AgentTool - Delegate tasks to specialized agents
 *
 * Creates and manages sub-agents with specialized system prompts.
 * Agents can be loaded from built-in library (dist/agents/) or user directory (~/.ally/profiles/{profile}/agents/).
 * Sub-agents run in isolated contexts with their own tools and message history.
 *
 * IMPORTANT: Sub-agents inherit the same permission screening as the main agent.
 * All tool calls (writes, edits, bash commands, etc.) will prompt for user permission.
 */

import { BaseTool } from './BaseTool.js';
import { InjectableTool } from './InjectableTool.js';
import { ToolResult, FunctionDefinition, ActivityEventType, Message } from '../types/index.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { ServiceRegistry } from '../services/ServiceRegistry.js';
import { AgentManager } from '../services/AgentManager.js';
import { Agent, AgentConfig } from '../agent/Agent.js';
import { ModelClient } from '../llm/ModelClient.js';
import { logger } from '../services/Logger.js';
import { ToolManager } from './ToolManager.js';
import { formatError } from '../utils/errorUtils.js';
import { BUFFER_SIZES, TEXT_LIMITS, FORMATTING, ID_GENERATION, AGENT_CONFIG, PERMISSION_MESSAGES, AGENT_TYPES, THOROUGHNESS_LEVELS, VALID_THOROUGHNESS } from '../config/constants.js';
import { AgentPoolService, PooledAgent } from '../services/AgentPoolService.js';
import { getThoroughnessDuration, getThoroughnessMaxTokens, formatElapsed } from '../ui/utils/timeUtils.js';
import { createAgentPersistenceReminder } from '../utils/messageUtils.js';
import { getModelClientForAgent } from '../utils/modelClientUtils.js';
import { extractSummaryFromConversation } from '../utils/agentUtils.js';

/**
 * Parameters for agent execution
 */
interface AgentExecutionParams {
  agentType: string;
  taskPrompt: string;
  thoroughness: string;
  callId: string;
  depth: number;
  parentAgentName?: string;
  initialMessages?: Message[];
}

/**
 * Parameters for executing an agent task
 */
interface AgentTaskExecutionParams extends AgentExecutionParams {
  agentData: any;
}

export class AgentTool extends BaseTool implements InjectableTool {
  readonly name = 'agent';
  readonly description =
    'Delegate task to specialized agent. Each call runs ONE agent sequentially';
  readonly requiresConfirmation = false; // Non-destructive: task delegation
  readonly suppressExecutionAnimation = true; // Agent manages its own display
  readonly shouldCollapse = true; // Collapse after completion
  readonly hideOutput = false; // Agents never hide their own output
  readonly usageGuidance = `**When to use agent:**
Complex tasks requiring specialized expertise or distinct workflows.
CRITICAL: Agent CANNOT see current conversation - include ALL context in task_prompt (file paths, errors, requirements).
NOT for: Exploration (use explore), planning (use plan), tasks needing conversation context.`;

  private agentManager: AgentManager | null = null;
  private activeDelegations: Map<string, any> = new Map();
  private _currentPooledAgent: PooledAgent | null = null;

  // InjectableTool interface properties
  get delegationState(): 'executing' | 'completing' | null {
    // Always null for AgentTool - delegation state is managed by DelegationContextManager
    return null;
  }

  get activeCallId(): string | null {
    // Always null for AgentTool - delegation tracking is done by DelegationContextManager
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
   * Provide custom function definition
   */
  getFunctionDefinition(): FunctionDefinition {
    return {
      type: 'function',
      function: {
        name: this.name,
        description: this.description,
        parameters: {
          type: 'object',
          properties: {
            task_prompt: {
              type: 'string',
              description: 'Complete task instructions with ALL necessary context. Agent cannot see current conversation - include file paths, errors, requirements, and background.',
            },
            agent_type: {
              type: 'string',
              description: `Agent type to use (e.g., '${AGENT_TYPES.TASK}'). Defaults to '${AGENT_TYPES.TASK}'.`,
            },
            thoroughness: {
              type: 'string',
              description: 'Thoroughness: quick|medium|very thorough|uncapped (default)',
            },
            context_files: {
              type: 'array',
              description: 'Optional files to load into agent context (limit: 40% of context). Use sparingly.',
              items: {
                type: 'string',
              },
            },
          },
          required: ['task_prompt'],
        },
      },
    };
  }

  protected async executeImpl(args: any): Promise<ToolResult> {
    this.captureParams(args);

    const agentType = (args.agent_type || AGENT_TYPES.TASK).trim();
    const taskPrompt = args.task_prompt;
    const thoroughness = args.thoroughness ?? THOROUGHNESS_LEVELS.UNCAPPED;
    const contextFiles = args.context_files;

    // Validate task_prompt parameter
    if (!taskPrompt || typeof taskPrompt !== 'string') {
      return this.formatErrorResponse(
        'task_prompt parameter is required and must be a string',
        'validation_error',
        'Example: agent(task_prompt="Analyze this code")'
      );
    }

    // Validate agent_type if provided
    if (args.agent_type && typeof args.agent_type !== 'string') {
      return this.formatErrorResponse(
        'agent_type must be a string',
        'validation_error'
      );
    }

    // Validate agent_type is not empty after trimming
    if (agentType.length === 0) {
      return this.formatErrorResponse(
        'agent_type cannot be empty',
        'validation_error'
      );
    }

    // Validate thoroughness parameter
    if (!VALID_THOROUGHNESS.includes(thoroughness)) {
      return this.formatErrorResponse(
        `thoroughness must be one of: ${VALID_THOROUGHNESS.join(', ')}`,
        'validation_error',
        'Example: agent(task_prompt="...", thoroughness="uncapped")'
      );
    }

    // Validate context_files parameter if provided
    if (contextFiles !== undefined) {
      if (!Array.isArray(contextFiles)) {
        return this.formatErrorResponse(
          'context_files must be an array of file paths',
          'validation_error',
          'Example: agent(task_prompt="...", context_files=["src/file1.ts", "src/file2.ts"])'
        );
      }
      // Validate each item is a string
      if (!contextFiles.every((f: any) => typeof f === 'string')) {
        return this.formatErrorResponse(
          'context_files must contain only strings',
          'validation_error',
          'Example: agent(task_prompt="...", context_files=["src/file1.ts", "src/file2.ts"])'
        );
      }
    }

    // Extract current agent depth and validate nesting limit
    const registry = ServiceRegistry.getInstance();
    const currentAgent = registry.get<any>('agent');
    const currentDepth = currentAgent?.getAgentDepth?.() ?? 0;
    const newDepth = currentDepth + 1;

    // Validate depth limit
    if (newDepth > AGENT_CONFIG.MAX_AGENT_DEPTH) {
      return this.formatErrorResponse(
        `Cannot delegate to agent '${agentType}': maximum nesting depth (${AGENT_CONFIG.MAX_AGENT_DEPTH}) exceeded. Current depth: ${currentDepth}, attempted depth: ${newDepth}. Maximum structure: Ally → Agent1 → Agent2 → Agent3.`,
        'depth_limit_exceeded'
      );
    }

    // Prevent deep cycles (allow cycles up to MAX_AGENT_CYCLE_DEPTH)
    // Example allowed (with MAX=2): explore → explore (depth 2)
    // Example blocked (with MAX=2): explore → explore → explore (depth 3)
    const currentAgentName = currentAgent?.getAgentName?.();
    const currentCallStack = currentAgent?.getAgentCallStack?.() ?? [];

    // Count how many times the target agent already appears in the call stack
    const occurrenceCount = currentCallStack.filter((name: string) => name === agentType).length;

    if (occurrenceCount >= AGENT_CONFIG.MAX_AGENT_CYCLE_DEPTH) {
      // Agent already appears MAX_AGENT_CYCLE_DEPTH+ times, adding it again would exceed limit
      const fullChain = currentAgentName
        ? [...currentCallStack, currentAgentName, agentType]
        : [...currentCallStack, agentType];
      const chainVisualization = fullChain.join(' → ');
      return this.formatErrorResponse(
        `Cannot delegate to agent '${agentType}': it already appears ${occurrenceCount} times in the call chain (${chainVisualization}). Maximum cycle depth is ${AGENT_CONFIG.MAX_AGENT_CYCLE_DEPTH}.`,
        'validation_error'
      );
    }

    // Execute single agent - pass currentCallId to avoid race conditions
    // IMPORTANT: this.currentCallId is set by BaseTool.execute() before executeImpl is called
    // We capture it here to avoid it being overwritten by concurrent executions
    const callId = this.currentCallId;
    if (!callId) {
      return this.formatErrorResponse(
        'Internal error: callId not set',
        'system_error'
      );
    }

    // Handle context_files: Read files before creating agent
    let initialMessages: Message[] | undefined;

    if (contextFiles && contextFiles.length > 0) {
      try {
        // Get ToolManager and ReadTool from ServiceRegistry
        const serviceRegistry = ServiceRegistry.getInstance();
        const toolManager = serviceRegistry.get<ToolManager>('tool_manager');

        if (!toolManager) {
          return this.formatErrorResponse(
            'Tool manager not available for context file reading',
            'system_error'
          );
        }

        const readTool = toolManager.getTool('read');
        if (!readTool) {
          return this.formatErrorResponse(
            'Read tool not available for context file reading',
            'system_error'
          );
        }

        // Generate tool call ID
        const toolCallId = `read-context-${Date.now()}-${Math.random().toString(ID_GENERATION.RANDOM_STRING_RADIX).substring(ID_GENERATION.RANDOM_STRING_SUBSTRING_START, ID_GENERATION.RANDOM_STRING_SUBSTRING_START + ID_GENERATION.RANDOM_STRING_LENGTH_LONG)}`;

        // Create assistant message with tool_calls
        const assistantMessage: Message = {
          role: 'assistant' as const,
          content: '',
          tool_calls: [{
            id: toolCallId,
            type: 'function' as const,
            function: {
              name: 'read',
              arguments: { file_paths: contextFiles },
            },
          }],
        };

        // Execute read tool
        const result = await toolManager.executeTool(
          'read',
          {
            file_paths: contextFiles,
            description: 'Load context files for agent',
          },
          toolCallId,
          false, // isRetry
          undefined, // abort signal (agent doesn't exist yet)
          false, // isUserInitiated
          true,  // isContextFile - enables 40% limit
          undefined // currentAgentName (agent doesn't exist yet)
        );

        // Validate read result before adding to conversation
        if (!result || (!result.success && !result.error)) {
          return this.formatErrorResponse(
            'Failed to read context files: Invalid result from ReadTool',
            'execution_error'
          );
        }

        // If read failed, return the error
        if (!result.success) {
          return this.formatErrorResponse(
            `Failed to read context files: ${result.error || 'Unknown error'}`,
            result.error_type || 'execution_error'
          );
        }

        // Create tool result message using centralized function
        const { createToolResultMessage } = await import('../llm/FunctionCalling.js');
        const toolResultMessage: Message = createToolResultMessage(
          toolCallId,
          'read',
          result
        );

        // Store messages to pass to agent creation
        initialMessages = [assistantMessage, toolResultMessage];

      } catch (error) {
        // If file reading fails, return error
        return this.formatErrorResponse(
          `Failed to read context files: ${error instanceof Error ? error.message : 'Unknown error'}`,
          'execution_error'
        );
      }
    }

    return await this.executeSingleAgentWrapper({
      agentType,
      taskPrompt,
      thoroughness,
      callId,
      depth: newDepth,
      parentAgentName: currentAgentName,
      initialMessages,
    });
  }

  /**
   * Execute a single agent and format the result
   */
  private async executeSingleAgentWrapper(params: AgentExecutionParams): Promise<ToolResult> {
    const { agentType, callId, thoroughness } = params;

    logger.debug('[AGENT_TOOL] Executing single agent:', agentType, 'callId:', callId, 'thoroughness:', thoroughness);

    try {
      const result = await this.executeSingleAgent(params);

      if (result.success) {
        // Build response with agent_id (always returned since agents always persist)
        const successResponse: Record<string, any> = {
          content: result.result, // Human-readable output for LLM
          agent_used: result.agent_used,
          duration_seconds: result.duration_seconds,
        };

        // Always include agent_id when available (with explicit persistence flags)
        if (result.agent_id) {
          successResponse.agent_id = result.agent_id;
          // PERSIST: false - Ephemeral: Coaching about agent-ask for follow-ups
          // Cleaned up after turn since agent should integrate advice, not need constant reminding
          const reminder = createAgentPersistenceReminder(result.agent_id);
          Object.assign(successResponse, reminder);
        }

        return this.formatSuccessResponse(successResponse);
      } else {
        return this.formatErrorResponse(
          result.error || 'Agent execution failed',
          result.error_type || 'execution_error',
          undefined,
          {
            agent_used: result.agent_used,
          }
        );
      }
    } catch (error) {
      const errorType = (error as any)?.error_type || 'execution_error';
      return this.formatErrorResponse(
        `Agent execution failed: ${formatError(error)}`,
        errorType,
        undefined,
        {
          agent_used: agentType,
        }
      );
    }
  }

  /**
   * Execute a single agent delegation
   *
   * Agents always persist in the agent pool for reuse.
   */
  private async executeSingleAgent(params: AgentExecutionParams): Promise<any> {
    const { agentType, taskPrompt, thoroughness, callId, depth, parentAgentName, initialMessages } = params;

    logger.debug('[AGENT_TOOL] executeSingleAgent START:', agentType, 'callId:', callId, 'thoroughness:', thoroughness);
    const startTime = Date.now();

    try {
      // Get agent manager
      logger.debug('[AGENT_TOOL] Getting agent manager...');
      const agentManager = this.getAgentManager();

      // Load agent data (from built-in or user directory)
      // Pass current agent name for visibility filtering, but treat 'ally' as undefined (main assistant)
      // This ensures agents with visible_from_agents: [] can be accessed from main ally
      const callerForVisibility = parentAgentName === AGENT_TYPES.ALLY ? undefined : parentAgentName;
      logger.debug('[AGENT_TOOL] Loading agent:', agentType, 'caller:', parentAgentName || 'main', '(visibility caller:', callerForVisibility || 'main', ')');
      let agentData = await agentManager.loadAgent(agentType, callerForVisibility);
      logger.debug('[AGENT_TOOL] Agent data loaded:', agentData ? 'success' : 'null');

      if (!agentData) {
        // Fall back to task agent - allowing the model to create named aliases
        logger.debug('[AGENT_TOOL] Agent not found, creating alias for task agent with name:', agentType);
        const taskAgentData = await agentManager.loadAgent(AGENT_TYPES.TASK, parentAgentName);

        if (!taskAgentData) {
          const result = this.formatErrorResponse(
            `Agent '${agentType}' not found and fallback to '${AGENT_TYPES.TASK}' agent also failed`,
            'system_error',
            undefined,
            { agent_used: agentType }
          );
          return result;
        }

        // Use task agent but preserve requested agent type name (creating an alias)
        agentData = { ...taskAgentData, name: agentType };
        logger.debug('[AGENT_TOOL] Created alias:', agentType, '-> task');
      }

      // Check if current agent has permission to delegate to sub-agents
      if (parentAgentName) {
        // Load current agent data to check can_delegate_to_agents permission
        const currentAgentData = await agentManager.loadAgent(parentAgentName);

        if (currentAgentData && currentAgentData.can_delegate_to_agents === false) {
          logger.debug('[AGENT_TOOL] Agent', parentAgentName, 'cannot delegate to sub-agents (can_delegate_to_agents: false)');
          const result = this.formatErrorResponse(
            `Agent '${parentAgentName}' cannot delegate to sub-agents (can_delegate_to_agents: false)`,
            'permission_denied',
            undefined,
            { agent_used: agentType }
          );
          return result;
        }
      }

      // Determine the model that will be used for this agent
      // Need to get config to resolve the fallback model
      const registry = ServiceRegistry.getInstance();
      const configManager = registry.get<any>('config_manager');
      const config = configManager?.getConfig();
      const agentModel = agentData.model || config?.model || 'unknown';

      // Emit agent start event
      this.emitEvent({
        id: callId,
        type: ActivityEventType.AGENT_START,
        timestamp: Date.now(),
        data: {
          agentName: agentType,
          taskPrompt,
          model: agentModel,
        },
      });

      // Execute the agent task
      logger.debug('[AGENT_TOOL] Executing agent task...');
      const taskResult = await this.executeAgentTask({
        agentData,
        agentType,
        taskPrompt,
        thoroughness,
        callId,
        depth,
        parentAgentName,
        initialMessages,
      });
      logger.debug('[AGENT_TOOL] Agent task completed. Result length:', taskResult.result?.length || 0);

      const duration = (Date.now() - startTime) / 1000;

      // Emit agent end event
      this.emitEvent({
        id: callId,
        type: ActivityEventType.AGENT_END,
        timestamp: Date.now(),
        data: {
          agentName: agentType,
          result: taskResult.result,
          duration,
        },
      });

      const response: any = {
        success: true,
        result: taskResult.result,
        agent_used: agentType,
        duration_seconds: Math.round(duration * Math.pow(10, FORMATTING.DURATION_DECIMAL_PLACES)) / Math.pow(10, FORMATTING.DURATION_DECIMAL_PLACES),
        // Store agent model for session persistence (enables model tracking on resume)
        _agentModel: agentModel,
      };

      // Include agent_id if available
      if (taskResult.agent_id) {
        response.agent_id = taskResult.agent_id;
      }

      return response;
    } catch (error) {
      const errorType = (error as any)?.error_type || 'system_error';
      const result = this.formatErrorResponse(
        `Error executing agent task: ${formatError(error)}`,
        errorType,
        undefined,
        { agent_used: agentType }
      );
      return result;
    }
  }

  /**
   * Validate all required services are available
   */
  private validateRequiredServices(): {
    registry: ServiceRegistry;
    mainModelClient: ModelClient;
    toolManager: ToolManager;
    config: any;
    configManager: any;
    permissionManager: any;
  } {
    logger.debug('[AGENT_TOOL] Getting services from registry...');
    const registry = ServiceRegistry.getInstance();
    const mainModelClient = registry.get<ModelClient>('model_client');
    const toolManager = registry.get<ToolManager>('tool_manager');
    const configManager = registry.get<any>('config_manager');
    const permissionManager = registry.get<any>('permission_manager');

    // Enforce strict service availability
    if (!mainModelClient) {
      throw new Error('AgentTool requires model_client to be registered in ServiceRegistry');
    }
    if (!toolManager) {
      throw new Error('AgentTool requires tool_manager to be registered in ServiceRegistry');
    }
    if (!configManager) {
      throw new Error('AgentTool requires config_manager to be registered in ServiceRegistry');
    }
    if (!permissionManager) {
      throw new Error('AgentTool requires permission_manager to be registered in ServiceRegistry');
    }

    const config = configManager.getConfig();
    if (!config) {
      throw new Error('ConfigManager.getConfig() returned null/undefined');
    }

    logger.debug('[AGENT_TOOL] All required services available');
    return { registry, mainModelClient, toolManager, config, configManager, permissionManager };
  }

  /**
   * Build agent configuration for execution
   */
  private buildAgentConfig(params: {
    agentData: any;
    agentType: string;
    taskPrompt: string;
    config: any;
    callId: string;
    depth: number;
    maxDuration: number | undefined;
    thoroughness: string;
    allowedTools: string[] | undefined;
    parentAgentName?: string;
    initialMessages?: Message[];
  }): AgentConfig {
    const {
      agentData,
      agentType,
      taskPrompt,
      config,
      callId,
      depth,
      maxDuration,
      thoroughness,
      allowedTools,
      parentAgentName,
      initialMessages,
    } = params;

    // Build updated agent call stack for circular delegation detection
    const registry = ServiceRegistry.getInstance();
    const currentAgent = registry.get<any>('agent');
    const currentCallStack = currentAgent?.getAgentCallStack?.() ?? [];
    const newCallStack = parentAgentName ? [...currentCallStack, parentAgentName] : currentCallStack;

    // Get parent agent reference
    const parentAgent = registry.get<any>('agent');

    // Create unique pool key for this agent config
    const poolKey = agentData._pluginName
      ? `plugin-${agentData._pluginName}-${agentType}-${callId}`
      : `agent-${agentType}-${callId}`;

    return {
      isSpecializedAgent: true,
      verbose: false,
      baseAgentPrompt: agentData.system_prompt,
      taskPrompt: taskPrompt,
      config: config,
      parentCallId: callId,
      parentAgent: parentAgent,
      _poolKey: poolKey,
      maxDuration,
      thoroughness: thoroughness,
      initialMessages,
      agentType: agentType,
      requirements: agentData.requirements,
      agentDepth: depth,
      agentCallStack: newCallStack,
      allowedTools: allowedTools,
    };
  }

  /**
   * Acquire agent from pool or create ephemeral agent
   */
  private async acquireOrCreateAgent(params: {
    agentConfig: AgentConfig;
    toolManager: ToolManager;
    modelClient: ModelClient;
    targetModel: string;
    config: any;
    configManager: any;
    permissionManager: any;
    agentType: string;
  }): Promise<{ agent: Agent; pooledAgent: PooledAgent | null; agentId: string | null }> {
    const { agentConfig, toolManager, modelClient, targetModel, config, configManager, permissionManager, agentType } =
      params;

    const registry = ServiceRegistry.getInstance();
    const agentPoolService = registry.get<AgentPoolService>('agent_pool');

    if (!agentPoolService) {
      // Graceful fallback: AgentPoolService not available
      logger.warn('[AGENT_TOOL] AgentPoolService not available, falling back to ephemeral agent');
      const agent = new Agent(modelClient, toolManager, this.activityStream, agentConfig, configManager, permissionManager);
      return { agent, pooledAgent: null, agentId: null };
    }

    // Acquire agent from pool
    logger.debug('[AGENT_TOOL] Acquiring agent from pool with poolKey:', agentConfig._poolKey);
    const customModelClient = targetModel !== config.model ? modelClient : undefined;
    const pooledAgent = await agentPoolService.acquire(agentConfig, toolManager, customModelClient);
    const agentId = pooledAgent.agentId;
    this._currentPooledAgent = pooledAgent; // Track for interjection routing

    logger.debug(`[AGENT_TOOL] Using pooled agent ${agentId} for ${agentType}`);
    return { agent: pooledAgent.agent, pooledAgent, agentId };
  }

  /**
   * Register delegation with context manager
   */
  private registerDelegation(callId: string, pooledAgent: PooledAgent): void {
    try {
      const serviceRegistry = ServiceRegistry.getInstance();
      const toolManager = serviceRegistry.get<any>('tool_manager');
      const delegationManager = toolManager?.getDelegationContextManager();
      if (delegationManager) {
        delegationManager.register(callId, 'agent', pooledAgent);
        logger.debug(`[AGENT_TOOL] Registered delegation: callId=${callId}`);
      }
    } catch (error) {
      // ServiceRegistry not available in tests - skip delegation registration
      logger.debug(`[AGENT_TOOL] Delegation registration skipped: ${error}`);
    }
  }

  /**
   * Execute agent and capture result
   */
  private async executeAgent(params: {
    agent: Agent;
    agentType: string;
    taskPrompt: string;
    callId: string;
    maxDuration: number | undefined;
    thoroughness: string;
  }): Promise<string> {
    const { agent, agentType, taskPrompt, callId, maxDuration, thoroughness } = params;

    logger.debug('[AGENT_TOOL] Sending message to sub-agent...');
    const response = await agent.sendMessage(`Execute this task: ${taskPrompt}`, {
      parentCallId: callId,
      maxDuration,
      thoroughness,
    });
    logger.debug('[AGENT_TOOL] Sub-agent response received, length:', response?.length || 0);

    // Ensure we have a substantial response
    if (!response || response.trim().length === 0) {
      logger.debug('[AGENT_TOOL] Sub-agent returned empty response, attempting to extract summary from conversation');
      const summary = extractSummaryFromConversation(
        agent,
        '[AGENT_TOOL]',
        `Agent '${agentType}' work summary:`,
        BUFFER_SIZES.AGENT_RECENT_MESSAGES
      );
      if (summary) {
        return summary;
      }

      // Last resort: try to get a summary by asking explicitly
      logger.debug('[AGENT_TOOL] Attempting to request explicit summary from sub-agent');
      try {
        const explicitSummary = await agent.sendMessage(
          'Please provide a concise summary of what you accomplished, found, or determined while working on this task.',
          {
            parentCallId: callId,
            maxDuration,
            thoroughness,
          }
        );
        if (explicitSummary && explicitSummary.trim().length > 0) {
          return explicitSummary;
        }
      } catch (summaryError) {
        logger.debug('[AGENT_TOOL] Failed to get explicit summary:', summaryError);
      }
      return `Agent '${agentType}' completed the task but did not provide a summary.`;
    }

    // Check if response is just an interruption or error message
    if (
      response.includes('[Request interrupted') ||
      response.includes('Interrupted. Tell Ally what to do instead.') ||
      response.includes('Permission denied. Tell Ally what to do instead.') ||
      response === PERMISSION_MESSAGES.USER_FACING_INTERRUPTION ||
      response === PERMISSION_MESSAGES.USER_FACING_DENIAL ||
      response.length < TEXT_LIMITS.AGENT_RESPONSE_MIN
    ) {
      logger.debug('[AGENT_TOOL] Sub-agent response seems incomplete, attempting to extract summary');
      const summary = extractSummaryFromConversation(
        agent,
        '[AGENT_TOOL]',
        `Agent '${agentType}' work summary:`,
        BUFFER_SIZES.AGENT_RECENT_MESSAGES
      );
      if (summary && summary.length > response.length) {
        return summary;
      }
    }

    return response;
  }

  /**
   * Format execution response with agent metadata
   */
  private formatExecutionResponse(params: {
    finalResponse: string;
    agentId: string | null;
  }): { result: string; agent_id?: string } {
    const { finalResponse, agentId } = params;

    // Append note to all agent responses
    const result =
      finalResponse +
      '\n\nIMPORTANT: The user CANNOT see this summary. You must share relevant information, summarized or verbatim with the user in your own response, if appropriate.';

    // Return result with agent_id (always returned since agents always persist)
    const returnValue: { result: string; agent_id?: string } = { result };
    if (agentId) {
      returnValue.agent_id = agentId;
    }
    return returnValue;
  }

  /**
   * Cleanup after agent execution
   */
  private cleanupAfterExecution(params: {
    registry: ServiceRegistry;
    previousAgent: any;
    pooledAgent: PooledAgent | null;
    callId: string;
    subAgent: Agent;
  }): void {
    const { registry, previousAgent } = params;

    // Restore previous agent in registry
    try {
      registry.registerInstance('agent', previousAgent);

      // VALIDATION: Ensure registry restoration succeeded
      const restoredAgent = registry.get<any>('agent');
      if (restoredAgent !== previousAgent) {
        // CRITICAL: Registry corruption detected - fail fast
        const error = new Error(
          `[AGENT_TOOL] CRITICAL: Registry corruption detected! ` +
            `Expected agent ${(previousAgent as any)?.instanceId || 'null'} ` +
            `but registry contains ${(restoredAgent as any)?.instanceId || 'null'}. ` +
            `This indicates a race condition or double-release bug in agent management.`
        );
        logger.error(error.message);
        throw error;
      }

      logger.debug(`[AGENT_TOOL] Restored registry 'agent': ${(previousAgent as any)?.instanceId || 'null'}`);
    } catch (registryError) {
      logger.error(`[AGENT_TOOL] CRITICAL: Failed to restore registry agent:`, registryError);
      if (registryError instanceof Error && registryError.message.includes('Registry corruption')) {
        throw registryError;
      }
    }
  }

  /**
   * Cleanup and release agent resources
   */
  private async releaseAgent(params: {
    pooledAgent: PooledAgent | null;
    subAgent: Agent;
    callId: string;
  }): Promise<void> {
    const { pooledAgent, subAgent, callId } = params;

    if (pooledAgent) {
      logger.debug('[AGENT_TOOL] Releasing agent back to pool');
      pooledAgent.release();

      // Transition delegation to completing state
      try {
        const serviceRegistry = ServiceRegistry.getInstance();
        const toolManager = serviceRegistry.get<any>('tool_manager');
        const delegationManager = toolManager?.getDelegationContextManager();
        if (delegationManager) {
          delegationManager.transitionToCompleting(callId);
          logger.debug(`[AGENT_TOOL] Transitioned delegation to completing: callId=${callId}`);
        }
      } catch (error) {
        logger.debug(`[AGENT_TOOL] Delegation transition skipped: ${error}`);
      }
    } else {
      // Cleanup ephemeral agent (only if AgentPoolService was unavailable)
      await subAgent.cleanup();

      // Transition delegation to completing state
      try {
        const serviceRegistry = ServiceRegistry.getInstance();
        const toolManager = serviceRegistry.get<any>('tool_manager');
        const delegationManager = toolManager?.getDelegationContextManager();
        if (delegationManager) {
          delegationManager.transitionToCompleting(callId);
          logger.debug(`[AGENT_TOOL] Transitioned delegation to completing: callId=${callId}`);
        }
      } catch (error) {
        logger.debug(`[AGENT_TOOL] Delegation transition skipped: ${error}`);
      }
    }
  }

  /**
   * Execute a task using the specified agent
   *
   * Agents always persist in the agent pool for reuse.
   */
  private async executeAgentTask(params: AgentTaskExecutionParams): Promise<{ result: string; agent_id?: string }> {
    const { agentData, agentType, taskPrompt, thoroughness, callId, depth, initialMessages } = params;

    logger.debug('[AGENT_TOOL] executeAgentTask START for callId:', callId, 'thoroughness:', thoroughness);

    // 1. Validate services
    const services = this.validateRequiredServices();
    const { registry, mainModelClient, toolManager, config, configManager, permissionManager } = services;

    logger.debug('[AGENT_TOOL] Agent depth:', depth);

    // 2. Determine target model and create model client
    const targetModel = agentData.model || config.model;
    const maxTokens = getThoroughnessMaxTokens(thoroughness as any, config.max_tokens);
    logger.debug(`[AGENT_TOOL] Set maxTokens to ${maxTokens} for thoroughness: ${thoroughness}`);

    const modelClient = await getModelClientForAgent({
      agentConfig: agentData,
      appConfig: config,
      sharedClient: mainModelClient,
      activityStream: this.activityStream,
      maxTokens: maxTokens,
      context: '[AGENT_TOOL]',
    });

    // 3. Map thoroughness to max duration
    const maxDuration = getThoroughnessDuration(thoroughness as any) ?? 0;
    logger.debug('[AGENT_TOOL] Set maxDuration to', maxDuration, 'minutes for thoroughness:', thoroughness);

    // 4. Compute allowed tools
    const agentManager = registry.get<AgentManager>('agent_manager');
    if (!agentManager) {
      throw new Error('AgentManager not found in registry');
    }

    const allToolNames = toolManager.getAllTools().map((t) => t.name);
    const allowedTools = agentManager.computeAllowedTools(agentData, toolManager, allToolNames);

    if (allowedTools !== undefined) {
      logger.debug('[AGENT_TOOL] Agent has access to', allowedTools.length, 'tools:', allowedTools.join(', '));
    } else {
      logger.debug('[AGENT_TOOL] Agent has access to all tools (unrestricted)');
    }

    // 5. Build agent config
    const agentConfig = this.buildAgentConfig({
      agentData,
      agentType,
      taskPrompt,
      config,
      callId,
      depth,
      maxDuration,
      thoroughness,
      allowedTools,
      parentAgentName: params.parentAgentName,
      initialMessages,
    });

    // 6. Acquire/create agent
    logger.debug('[AGENT_TOOL] Creating sub-agent with parentCallId:', callId);
    const { agent: subAgent, pooledAgent, agentId } = await this.acquireOrCreateAgent({
      agentConfig,
      toolManager,
      modelClient,
      targetModel,
      config,
      configManager,
      permissionManager,
      agentType,
    });

    // 7. Register delegation
    if (pooledAgent) {
      this.registerDelegation(callId, pooledAgent);
    }

    // 8. Track active delegation
    this.activeDelegations.set(callId, {
      subAgent,
      agentName: agentType,
      taskPrompt,
      startTime: Date.now(),
    });

    // 9. Store previous agent for restoration
    const previousAgent = registry.get<any>('agent');

    try {
      // 10. Update registry to point to sub-agent during execution
      registry.registerInstance('agent', subAgent);

      try {
        // 11. Execute agent
        const finalResponse = await this.executeAgent({
          agent: subAgent,
          agentType,
          taskPrompt,
          callId,
          maxDuration,
          thoroughness,
        });

        // 12. Format response
        return this.formatExecutionResponse({ finalResponse, agentId });
      } finally {
        // 13. Restore registry
        this.cleanupAfterExecution({ registry, previousAgent, pooledAgent, callId, subAgent });
      }
    } catch (error) {
      logger.debug('[AGENT_TOOL] ERROR during sub-agent execution:', error);
      throw error;
    } finally {
      // 14. Cleanup delegation and release agent
      logger.debug('[AGENT_TOOL] Cleaning up sub-agent...');
      this.activeDelegations.delete(callId);
      await this.releaseAgent({ pooledAgent, subAgent, callId });
    }
  }

  /**
   * Get or create agent manager instance
   */
  private getAgentManager(): AgentManager {
    if (!this.agentManager) {
      const registry = ServiceRegistry.getInstance();
      const agentManager = registry.get<AgentManager>('agent_manager');
      if (!agentManager) {
        throw new Error('AgentManager not registered in ServiceRegistry');
      }
      this.agentManager = agentManager;
    }
    return this.agentManager;
  }

  /**
   * Get currently active delegations
   */
  getActiveDelegations(): Map<string, any> {
    return new Map(this.activeDelegations);
  }

  /**
   * Interrupt all active sub-agents
   * Called when user presses Ctrl+C
   */
  interruptAll(): void {
    logger.debug('[AGENT_TOOL] Interrupting', this.activeDelegations.size, 'active sub-agents');
    for (const [callId, delegation] of this.activeDelegations.entries()) {
      const subAgent = delegation.subAgent;
      if (subAgent && typeof subAgent.interrupt === 'function') {
        logger.debug('[AGENT_TOOL] Interrupting sub-agent:', callId);
        subAgent.interrupt();
      }
    }
  }

  /**
   * Inject user message into active pooled agent
   * Used for routing interjections to subagents
   */
  injectUserMessage(message: string): void {
    if (!this._currentPooledAgent) {
      logger.warn('[AGENT_TOOL] injectUserMessage called but no active pooled agent');
      return;
    }

    const agent = this._currentPooledAgent.agent;
    if (!agent) {
      logger.warn('[AGENT_TOOL] injectUserMessage called but pooled agent has no agent instance');
      return;
    }

    logger.debug('[AGENT_TOOL] Injecting user message into pooled agent:', this._currentPooledAgent.agentId);
    agent.addUserInterjection(message);
    agent.interrupt('interjection');
  }

  /**
   * Format subtext for display in UI
   * Shows full task_prompt (no truncation - displayed on separate indented lines)
   */
  formatSubtext(args: Record<string, any>): string | null {
    const taskPrompt = args.task_prompt as string;

    if (!taskPrompt) {
      return null;
    }

    return taskPrompt;
  }

  /**
   * Get parameters shown in subtext
   * AgentTool shows both 'task_prompt' and 'description' in subtext
   */
  getSubtextParameters(): string[] {
    return ['task_prompt', 'description'];
  }

  /**
   * Custom result preview
   */
  getResultPreview(result: ToolResult, maxLines: number = 3): string[] {
    if (!result.success) {
      return super.getResultPreview(result, maxLines);
    }

    const lines: string[] = [];


    // Show duration if available
    if (result.duration_seconds !== undefined) {
      lines.push(`Duration: ${formatElapsed(result.duration_seconds)}`);
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
