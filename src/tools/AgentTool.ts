/**
 * AgentTool - Delegate tasks to specialized agents
 *
 * Creates and manages sub-agents with specialized system prompts.
 * Agents can be loaded from built-in library (dist/agents/) or user directory (~/.ally/agents/).
 * Sub-agents run in isolated contexts with their own tools and message history.
 *
 * IMPORTANT: Sub-agents inherit the same permission screening as the main agent.
 * All tool calls (writes, edits, bash commands, etc.) will prompt for user permission.
 */

import { BaseTool } from './BaseTool.js';
import { ToolResult, FunctionDefinition, ActivityEventType, Message } from '../types/index.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { ServiceRegistry } from '../services/ServiceRegistry.js';
import { AgentManager } from '../services/AgentManager.js';
import { Agent, AgentConfig } from '../agent/Agent.js';
import { ModelClient } from '../llm/ModelClient.js';
import { logger } from '../services/Logger.js';
import { ToolManager } from './ToolManager.js';
import { formatError } from '../utils/errorUtils.js';
import { BUFFER_SIZES, TEXT_LIMITS, FORMATTING, REASONING_EFFORT, ID_GENERATION } from '../config/constants.js';
import { AgentPoolService, PooledAgent } from '../services/AgentPoolService.js';
import { getThoroughnessDuration, getThoroughnessMaxTokens } from '../ui/utils/timeUtils.js';

export class AgentTool extends BaseTool {
  readonly name = 'agent';
  readonly description =
    'Delegate task to specialized agent. Each call runs ONE agent. For concurrent execution, make multiple agent() calls in same response';
  readonly requiresConfirmation = false; // Non-destructive: task delegation
  readonly suppressExecutionAnimation = true; // Agent manages its own display
  readonly shouldCollapse = true; // Collapse after completion - hide output and nested tools
  readonly hideOutput = false; // Show agent tool output in chat

  private agentManager: AgentManager | null = null;
  private activeDelegations: Map<string, any> = new Map();
  private currentPooledAgent: PooledAgent | null = null;

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
              description: 'Task instructions. For concurrent tasks, make multiple agent() calls.',
            },
            agent_name: {
              type: 'string',
              description: 'Agent name (default: general)',
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

    const agentName = args.agent_name || 'general';
    const taskPrompt = args.task_prompt;
    const thoroughness = args.thoroughness ?? 'uncapped';
    const contextFiles = args.context_files;

    // Validate task_prompt parameter
    if (!taskPrompt || typeof taskPrompt !== 'string') {
      return this.formatErrorResponse(
        'task_prompt parameter is required and must be a string',
        'validation_error',
        'Example: agent(task_prompt="Analyze this code")'
      );
    }

    // Validate agent_name if provided
    if (args.agent_name && typeof args.agent_name !== 'string') {
      return this.formatErrorResponse(
        'agent_name must be a string',
        'validation_error'
      );
    }

    // Validate thoroughness parameter
    const validThoroughness = ['quick', 'medium', 'very thorough', 'uncapped'];
    if (!validThoroughness.includes(thoroughness)) {
      return this.formatErrorResponse(
        `thoroughness must be one of: ${validThoroughness.join(', ')}`,
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
          { file_paths: contextFiles },
          toolCallId,
          false, // isRetry
          undefined, // abort signal (agent doesn't exist yet)
          false, // isUserInitiated
          true   // isContextFile - enables 40% limit
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

        // Create tool result message
        const toolResultMessage: Message = {
          role: 'tool' as const,
          content: JSON.stringify(result),
          tool_call_id: toolCallId,
          name: 'read',
        };

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

    return await this.executeSingleAgentWrapper(agentName, taskPrompt, thoroughness, callId, initialMessages);
  }

  /**
   * Execute a single agent and format the result
   */
  private async executeSingleAgentWrapper(
    agentName: string,
    taskPrompt: string,
    thoroughness: string,
    callId: string,
    initialMessages?: Message[]
  ): Promise<ToolResult> {
    logger.debug('[AGENT_TOOL] Executing single agent:', agentName, 'callId:', callId, 'thoroughness:', thoroughness);

    try {
      const result = await this.executeSingleAgent(agentName, taskPrompt, thoroughness, callId, initialMessages);

      if (result.success) {
        // Build response with agent_id (always returned since agents always persist)
        const successResponse: Record<string, any> = {
          content: result.result, // Human-readable output for LLM
          agent_name: result.agent_used,
          duration_seconds: result.duration_seconds,
        };

        // Always include agent_id when available
        if (result.agent_id) {
          successResponse.agent_id = result.agent_id;
          successResponse.system_reminder = `Agent persists as ${result.agent_id}. For follow-up questions, PREFER agent_ask(agent_id="${result.agent_id}", message="...") over direct tools—agent has context for richer answers.`;
        }

        return this.formatSuccessResponse(successResponse);
      } else {
        return this.formatErrorResponse(
          result.error || 'Agent execution failed',
          'execution_error'
        );
      }
    } catch (error) {
      return this.formatErrorResponse(
        `Agent execution failed: ${formatError(error)}`,
        'execution_error'
      );
    }
  }

  /**
   * Execute a single agent delegation
   *
   * Agents always persist in the agent pool for reuse.
   */
  private async executeSingleAgent(
    agentName: string,
    taskPrompt: string,
    thoroughness: string,
    callId: string,
    initialMessages?: Message[]
  ): Promise<any> {
    logger.debug('[AGENT_TOOL] executeSingleAgent START:', agentName, 'callId:', callId, 'thoroughness:', thoroughness);
    const startTime = Date.now();

    try {
      // Get agent manager
      logger.debug('[AGENT_TOOL] Getting agent manager...');
      const agentManager = this.getAgentManager();

      // Load agent data (from built-in or user directory)
      logger.debug('[AGENT_TOOL] Loading agent:', agentName);
      const agentData = await agentManager.loadAgent(agentName);
      logger.debug('[AGENT_TOOL] Agent data loaded:', agentData ? 'success' : 'null');

      if (!agentData) {
        return {
          success: false,
          error: `Agent '${agentName}' not found`,
          agent_used: agentName,
        };
      }

      // Emit agent start event
      this.emitEvent({
        id: callId,
        type: ActivityEventType.AGENT_START,
        timestamp: Date.now(),
        data: {
          agentName,
          taskPrompt,
        },
      });

      // Execute the agent task
      logger.debug('[AGENT_TOOL] Executing agent task...');
      const taskResult = await this.executeAgentTask(agentData, taskPrompt, thoroughness, callId, initialMessages);
      logger.debug('[AGENT_TOOL] Agent task completed. Result length:', taskResult.result?.length || 0);

      const duration = (Date.now() - startTime) / 1000;

      // Emit agent end event
      this.emitEvent({
        id: callId,
        type: ActivityEventType.AGENT_END,
        timestamp: Date.now(),
        data: {
          agentName,
          result: taskResult.result,
          duration,
        },
      });

      const response: any = {
        success: true,
        result: taskResult.result,
        agent_used: agentName,
        duration_seconds: Math.round(duration * Math.pow(10, FORMATTING.DURATION_DECIMAL_PLACES)) / Math.pow(10, FORMATTING.DURATION_DECIMAL_PLACES),
      };

      // Include agent_id if available
      if (taskResult.agent_id) {
        response.agent_id = taskResult.agent_id;
      }

      return response;
    } catch (error) {
      return {
        success: false,
        error: `Error executing agent task: ${formatError(error)}`,
        agent_used: agentName,
      };
    }
  }

  /**
   * Execute a task using the specified agent
   *
   * Agents always persist in the agent pool for reuse.
   */
  private async executeAgentTask(
    agentData: any,
    taskPrompt: string,
    thoroughness: string,
    callId: string,
    initialMessages?: Message[]
  ): Promise<{ result: string; agent_id?: string }> {
    logger.debug('[AGENT_TOOL] executeAgentTask START for callId:', callId, 'thoroughness:', thoroughness);
    const registry = ServiceRegistry.getInstance();

    // Get required services - STRICT: no fallbacks
    logger.debug('[AGENT_TOOL] Getting services from registry...');
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

    // Determine target model
    const targetModel = agentData.model || config.model;

    // Resolve reasoning_effort: use agent's value if set and not "inherit", otherwise use config
    let resolvedReasoningEffort: string | undefined;
    if (agentData.reasoning_effort && agentData.reasoning_effort !== REASONING_EFFORT.INHERIT) {
      resolvedReasoningEffort = agentData.reasoning_effort;
      logger.debug(`[AGENT_TOOL] Using agent reasoning_effort: ${resolvedReasoningEffort}`);
    } else {
      resolvedReasoningEffort = config.reasoning_effort;
      logger.debug(`[AGENT_TOOL] Using config reasoning_effort: ${resolvedReasoningEffort}`);
    }

    // Calculate max tokens based on thoroughness
    const maxTokens = getThoroughnessMaxTokens(thoroughness as any, config.max_tokens);
    logger.debug(`[AGENT_TOOL] Set maxTokens to ${maxTokens} for thoroughness: ${thoroughness}`);

    // Create appropriate model client
    let modelClient: ModelClient;

    // Use shared client only if model, reasoning_effort, AND max_tokens all match config
    if (targetModel === config.model && resolvedReasoningEffort === config.reasoning_effort && maxTokens === config.max_tokens) {
      // Use shared global client
      logger.debug(`[AGENT_TOOL] Using shared model client (model: ${targetModel}, reasoning_effort: ${resolvedReasoningEffort}, maxTokens: ${maxTokens})`);
      modelClient = mainModelClient;
    } else {
      // Agent specifies different model OR different reasoning_effort - create dedicated client
      logger.debug(`[AGENT_TOOL] Creating dedicated client (model: ${targetModel}, reasoning_effort: ${resolvedReasoningEffort})`);

      // Create dedicated client for this model
      // Note: Model tool support was validated during agent creation
      const { OllamaClient } = await import('../llm/OllamaClient.js');
      modelClient = new OllamaClient({
        endpoint: config.endpoint,
        modelName: targetModel,
        temperature: agentData.temperature ?? config.temperature,
        contextSize: config.context_size,
        maxTokens: maxTokens,
        activityStream: this.activityStream,
        reasoningEffort: resolvedReasoningEffort,
      });
    }

    // Map thoroughness to max duration
    const maxDuration = getThoroughnessDuration(thoroughness as any);
    logger.debug('[AGENT_TOOL] Set maxDuration to', maxDuration, 'minutes for thoroughness:', thoroughness);

    // Create specialized system prompt
    logger.debug('[AGENT_TOOL] Creating specialized prompt...');
    let specializedPrompt: string;
    try {
      specializedPrompt = await this.createAgentSystemPrompt(
        agentData.system_prompt,
        taskPrompt,
        resolvedReasoningEffort
      );
      logger.debug('[AGENT_TOOL] Specialized prompt created, length:', specializedPrompt?.length || 0);
    } catch (error) {
      logger.debug('[AGENT_TOOL] ERROR creating specialized prompt:', error);
      throw error;
    }

    // Filter tools based on agent configuration
    let filteredToolManager = toolManager;
    if (agentData.tools !== undefined && agentData.tools.length > 0) {
      // Agent has specific tool restrictions - create filtered tool manager
      logger.debug('[AGENT_TOOL] Filtering tools for agent:', agentData.tools);
      const allowedToolNames = new Set(agentData.tools);
      const allTools = toolManager.getAllTools();
      const filteredTools = allTools.filter(tool => allowedToolNames.has(tool.name));
      filteredToolManager = new ToolManager(filteredTools, this.activityStream);
      logger.debug('[AGENT_TOOL] Filtered to', filteredTools.length, 'tools:', filteredTools.map(t => t.name).join(', '));
    } else {
      logger.debug('[AGENT_TOOL] Agent has access to all tools (unrestricted)');
    }

    // Create scoped registry for sub-agent (currently unused - for future extension)
    // const scopedRegistry = new ScopedServiceRegistryProxy(registry);

    // Create sub-agent with scoped context and parent relationship
    // IMPORTANT: Use callId parameter, not this.currentCallId (which can be overwritten by concurrent calls)
    logger.debug('[AGENT_TOOL] Creating sub-agent with parentCallId:', callId);

    // Always use pooled agent for persistence
    let subAgent: Agent;
    let pooledAgent: PooledAgent | null = null;
    let agentId: string | null = null;

    // Use AgentPoolService for persistent agent
    const agentPoolService = registry.get<AgentPoolService>('agent_pool');

    if (!agentPoolService) {
      // Graceful fallback: AgentPoolService not available
      logger.warn('[AGENT_TOOL] AgentPoolService not available, falling back to ephemeral agent');
      const agentConfig: AgentConfig = {
        isSpecializedAgent: true,
        verbose: false,
        systemPrompt: specializedPrompt,
        baseAgentPrompt: agentData.system_prompt,
        taskPrompt: taskPrompt,
        config: config,
        parentCallId: callId,
        maxDuration,
        initialMessages,
      };

      subAgent = new Agent(
        modelClient,
        filteredToolManager,
        this.activityStream,
        agentConfig,
        configManager,
        permissionManager
      );
    } else {
      // IMPORTANT: Create unique pool key for this agent config
      // Must include agent_name to avoid mixing different custom agents
      const poolKey = `agent-${agentData.name}`;

      // Create config with pool metadata
      const agentConfig: AgentConfig = {
        isSpecializedAgent: true,
        verbose: false,
        systemPrompt: specializedPrompt,
        baseAgentPrompt: agentData.system_prompt,
        taskPrompt: taskPrompt,
        config: config,
        parentCallId: callId,
        _poolKey: poolKey, // CRITICAL: Add this for pool matching
        maxDuration,
        initialMessages,
      };

      // Acquire agent from pool
      logger.debug('[AGENT_TOOL] Acquiring agent from pool with poolKey:', poolKey);
      // Pass custom modelClient only if agent uses a different model than global
      const customModelClient = targetModel !== config.model ? modelClient : undefined;
      pooledAgent = await agentPoolService.acquire(agentConfig, filteredToolManager, customModelClient);
      subAgent = pooledAgent.agent;
      agentId = pooledAgent.agentId;
      this.currentPooledAgent = pooledAgent; // Track for interjection routing
      logger.debug(`[AGENT_TOOL] Using pooled agent ${agentId} for ${agentData.name}`);
    }

    // Track active delegation
    this.activeDelegations.set(callId, {
      subAgent,
      agentName: agentData.name,
      taskPrompt,
      startTime: Date.now(),
    });

    try {
      // Execute the task
      logger.debug('[AGENT_TOOL] Sending message to sub-agent...');
      const response = await subAgent.sendMessage(`Execute this task: ${taskPrompt}`);
      logger.debug('[AGENT_TOOL] Sub-agent response received, length:', response?.length || 0);

      let finalResponse: string;

      // Ensure we have a substantial response
      if (!response || response.trim().length === 0) {
        logger.debug('[AGENT_TOOL] Sub-agent returned empty response, attempting to extract summary from conversation');
        const summary = this.extractSummaryFromConversation(subAgent, agentData.name);
        if (summary) {
          finalResponse = summary;
        } else {
          // Last resort: try to get a summary by asking explicitly
          logger.debug('[AGENT_TOOL] Attempting to request explicit summary from sub-agent');
          try {
            const explicitSummary = await subAgent.sendMessage(
              'Please provide a concise summary of what you accomplished, found, or determined while working on this task.'
            );
            if (explicitSummary && explicitSummary.trim().length > 0) {
              finalResponse = explicitSummary;
            } else {
              finalResponse = `Agent '${agentData.name}' completed the task but did not provide a summary.`;
            }
          } catch (summaryError) {
            logger.debug('[AGENT_TOOL] Failed to get explicit summary:', summaryError);
            finalResponse = `Agent '${agentData.name}' completed the task but did not provide a summary.`;
          }
        }
      } else {
        // Check if response is just an interruption or error message
        if (response.includes('[Request interrupted') || response.length < TEXT_LIMITS.AGENT_RESPONSE_MIN) {
          logger.debug('[AGENT_TOOL] Sub-agent response seems incomplete, attempting to extract summary');
          const summary = this.extractSummaryFromConversation(subAgent, agentData.name);
          if (summary && summary.length > response.length) {
            finalResponse = summary;
          } else {
            finalResponse = response;
          }
        } else {
          finalResponse = response;
        }
      }

      // Append note to all agent responses
      const result = finalResponse + '\n\nIMPORTANT: The user CANNOT see this summary. You must share relevant information, summarized or verbatim with the user in your own response, if appropriate.';

      // Return result with agent_id (always returned since agents always persist)
      const returnValue: { result: string; agent_id?: string } = { result };
      if (agentId) {
        returnValue.agent_id = agentId;
      }
      return returnValue;
    } catch (error) {
      logger.debug('[AGENT_TOOL] ERROR during sub-agent execution:', error);
      throw error;
    } finally {
      // Clean up delegation tracking
      logger.debug('[AGENT_TOOL] Cleaning up sub-agent...');
      this.activeDelegations.delete(callId);

      // Release agent back to pool or cleanup ephemeral agent
      if (pooledAgent) {
        logger.debug('[AGENT_TOOL] Releasing agent back to pool');
        pooledAgent.release();
        this.currentPooledAgent = null; // Clear tracked pooled agent
      } else {
        // Cleanup ephemeral agent (only if AgentPoolService was unavailable)
        await subAgent.cleanup();
      }
    }
  }

  /**
   * Create specialized system prompt for agent
   */
  private async createAgentSystemPrompt(agentPrompt: string, taskPrompt: string, reasoningEffort?: string): Promise<string> {
    logger.debug('[AGENT_TOOL] Importing systemMessages module...');
    try {
      const { getAgentSystemPrompt } = await import('../prompts/systemMessages.js');
      logger.debug('[AGENT_TOOL] Calling getAgentSystemPrompt...');
      const result = await getAgentSystemPrompt(agentPrompt, taskPrompt, undefined, undefined, reasoningEffort);
      logger.debug('[AGENT_TOOL] getAgentSystemPrompt returned, length:', result?.length || 0);
      return result;
    } catch (error) {
      logger.debug('[AGENT_TOOL] ERROR in createAgentSystemPrompt:', error);
      throw error;
    }
  }

  /**
   * Extract a summary from the subagent's conversation history
   * Used when the subagent doesn't provide a final response
   */
  private extractSummaryFromConversation(subAgent: Agent, agentName: string): string | null {
    try {
      const messages = subAgent.getMessages();

      // Find all assistant messages (excluding system/user/tool messages)
      const assistantMessages = messages
        .filter(msg => msg.role === 'assistant' && msg.content && msg.content.trim().length > 0)
        .map(msg => msg.content);

      if (assistantMessages.length === 0) {
        logger.debug('[AGENT_TOOL] No assistant messages found in conversation');
        return null;
      }

      // If we have multiple assistant messages, combine the last few
      if (assistantMessages.length > 1) {
        // Take the last 3 assistant messages (or all if less than 3)
        const recentMessages = assistantMessages.slice(-BUFFER_SIZES.AGENT_RECENT_MESSAGES);
        const summary = recentMessages.join('\n\n');
        logger.debug('[AGENT_TOOL] Extracted summary from', recentMessages.length, 'assistant messages, length:', summary.length);
        return `Agent '${agentName}' work summary:\n\n${summary}`;
      }

      // Single assistant message
      const summary = assistantMessages[0];
      if (summary) {
        logger.debug('[AGENT_TOOL] Using single assistant message as summary, length:', summary.length);
        return summary;
      }

      return null;
    } catch (error) {
      logger.debug('[AGENT_TOOL] Error extracting summary from conversation:', error);
      return null;
    }
  }

  /**
   * Get or create agent manager instance
   */
  private getAgentManager(): AgentManager {
    if (!this.agentManager) {
      this.agentManager = new AgentManager();
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
    if (!this.currentPooledAgent) {
      logger.warn('[AGENT_TOOL] injectUserMessage called but no active pooled agent');
      return;
    }

    const agent = this.currentPooledAgent.agent;
    if (!agent) {
      logger.warn('[AGENT_TOOL] injectUserMessage called but pooled agent has no agent instance');
      return;
    }

    logger.debug('[AGENT_TOOL] Injecting user message into pooled agent:', this.currentPooledAgent.agentId);
    agent.addUserInterjection(message);
    agent.interrupt('interjection');
  }

  /**
   * Custom result preview
   */
  getResultPreview(result: ToolResult, maxLines: number = 3): string[] {
    if (!result.success) {
      return super.getResultPreview(result, maxLines);
    }

    const lines: string[] = [];

    // Show agent name if available
    if (result.agent_name) {
      lines.push(`Agent: ${result.agent_name}`);
    }

    // Show duration if available
    if (result.duration_seconds !== undefined) {
      lines.push(`Duration: ${result.duration_seconds}s`);
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
