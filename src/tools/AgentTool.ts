/**
 * AgentTool - Delegate tasks to specialized agents
 *
 * Creates and manages sub-agents with specialized system prompts.
 * Agents can be loaded from ~/.code_ally/agents/ directory.
 * Sub-agents run in isolated contexts with their own tools and message history.
 */

import { BaseTool } from './BaseTool.js';
import { ToolResult, FunctionDefinition, ActivityEventType } from '../types/index.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { ServiceRegistry } from '../services/ServiceRegistry.js';
import { AgentManager } from '../services/AgentManager.js';
import { Agent, AgentConfig } from '../agent/Agent.js';
import { ModelClient } from '../llm/ModelClient.js';
import { ToolManager } from './ToolManager.js';

export class AgentTool extends BaseTool {
  readonly name = 'agent';
  readonly description =
    'Delegate a task to a specialized agent. Each call executes one agent. IMPORTANT: To run N agents concurrently, you MUST make N separate agent() calls in the same response (not an array). Example: For 2 concurrent agents, call agent(task_prompt="task 1") and agent(task_prompt="task 2") in parallel.';
  readonly requiresConfirmation = false; // Non-destructive: task delegation
  readonly suppressExecutionAnimation = true; // Agent manages its own display
  readonly shouldCollapse = true; // Collapse children when complete to show only summary

  private agentManager: AgentManager | null = null;
  private activeDelegations: Map<string, any> = new Map();

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
              description: 'Task instructions for the agent. NOTE: Each agent() call runs ONE agent. For concurrent execution, make multiple calls.',
            },
            agent_name: {
              type: 'string',
              description: 'Name of agent to use (default: "general")',
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

    return await this.executeSingleAgentWrapper(agentName, taskPrompt, callId);
  }

  /**
   * Execute a single agent and format the result
   */
  private async executeSingleAgentWrapper(
    agentName: string,
    taskPrompt: string,
    callId: string
  ): Promise<ToolResult> {
    console.log('[AGENT_TOOL] Executing single agent:', agentName, 'callId:', callId);

    try {
      const result = await this.executeSingleAgent(agentName, taskPrompt, callId);

      if (result.success) {
        return this.formatSuccessResponse({
          content: result.result, // Human-readable output for LLM
          agent_name: result.agent_used,
          duration_seconds: result.duration_seconds,
        });
      } else {
        return this.formatErrorResponse(
          result.error || 'Agent execution failed',
          'execution_error'
        );
      }
    } catch (error) {
      return this.formatErrorResponse(
        `Agent execution failed: ${error instanceof Error ? error.message : String(error)}`,
        'execution_error'
      );
    }
  }

  /**
   * Execute a single agent delegation
   */
  private async executeSingleAgent(
    agentName: string,
    taskPrompt: string,
    callId: string
  ): Promise<any> {
    console.log('[AGENT_TOOL] executeSingleAgent START:', agentName, 'callId:', callId);
    const startTime = Date.now();

    try {
      // Get agent manager
      console.log('[AGENT_TOOL] Getting agent manager...');
      const agentManager = this.getAgentManager();

      // Ensure default agent exists
      console.log('[AGENT_TOOL] Ensuring default agent exists...');
      await agentManager.ensureDefaultAgent();

      // Load agent data
      console.log('[AGENT_TOOL] Loading agent:', agentName);
      const agentData = await agentManager.loadAgent(agentName);
      console.log('[AGENT_TOOL] Agent data loaded:', agentData ? 'success' : 'null');

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
      console.log('[AGENT_TOOL] Executing agent task...');
      const result = await this.executeAgentTask(agentData, taskPrompt, callId);
      console.log('[AGENT_TOOL] Agent task completed. Result length:', result?.length || 0);

      const duration = (Date.now() - startTime) / 1000;

      // Emit agent end event
      this.emitEvent({
        id: callId,
        type: ActivityEventType.AGENT_END,
        timestamp: Date.now(),
        data: {
          agentName,
          result,
          duration,
        },
      });

      return {
        success: true,
        result,
        agent_used: agentName,
        duration_seconds: Math.round(duration * 10) / 10,
      };
    } catch (error) {
      return {
        success: false,
        error: `Error executing agent task: ${error instanceof Error ? error.message : String(error)}`,
        agent_used: agentName,
      };
    }
  }

  /**
   * Execute a task using the specified agent
   */
  private async executeAgentTask(
    agentData: any,
    taskPrompt: string,
    callId: string
  ): Promise<string> {
    console.log('[AGENT_TOOL] executeAgentTask START for callId:', callId);
    const registry = ServiceRegistry.getInstance();

    // Get required services - STRICT: no fallbacks
    console.log('[AGENT_TOOL] Getting services from registry...');
    const mainModelClient = registry.get<ModelClient>('model_client');
    const toolManager = registry.get<ToolManager>('tool_manager');
    const configManager = registry.get<any>('config_manager');

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

    const config = configManager.getConfig();
    if (!config) {
      throw new Error('ConfigManager.getConfig() returned null/undefined');
    }

    console.log('[AGENT_TOOL] All required services available');

    // Create specialized system prompt
    console.log('[AGENT_TOOL] Creating specialized prompt...');
    let specializedPrompt: string;
    try {
      specializedPrompt = await this.createAgentSystemPrompt(
        agentData.system_prompt,
        taskPrompt
      );
      console.log('[AGENT_TOOL] Specialized prompt created, length:', specializedPrompt?.length || 0);
    } catch (error) {
      console.log('[AGENT_TOOL] ERROR creating specialized prompt:', error);
      throw error;
    }

    // Create scoped registry for sub-agent (currently unused - for future extension)
    // const scopedRegistry = new ScopedServiceRegistryProxy(registry);

    // Create sub-agent with scoped context and parent relationship
    // IMPORTANT: Use callId parameter, not this.currentCallId (which can be overwritten by concurrent calls)
    console.log('[AGENT_TOOL] Creating sub-agent with parentCallId:', callId);
    const agentConfig: AgentConfig = {
      isSpecializedAgent: true,
      verbose: false,
      systemPrompt: specializedPrompt,
      config: config,
      parentCallId: callId, // Link nested tools to this agent call (use parameter, not this.currentCallId!)
    };

    const subAgent = new Agent(
      mainModelClient,
      toolManager,
      this.activityStream,
      agentConfig
    );

    // Track active delegation
    this.activeDelegations.set(callId, {
      subAgent,
      agentName: agentData.name,
      taskPrompt,
      startTime: Date.now(),
    });

    try {
      // Execute the task
      console.log('[AGENT_TOOL] Sending message to sub-agent...');
      const response = await subAgent.sendMessage(`Execute this task: ${taskPrompt}`);
      console.log('[AGENT_TOOL] Sub-agent response received, length:', response?.length || 0);

      return response || `Agent '${agentData.name}' completed the task.`;
    } catch (error) {
      console.log('[AGENT_TOOL] ERROR during sub-agent execution:', error);
      throw error;
    } finally {
      // Clean up delegation tracking
      console.log('[AGENT_TOOL] Cleaning up sub-agent...');
      this.activeDelegations.delete(callId);

      // Clean up sub-agent
      await subAgent.cleanup();
    }
  }

  /**
   * Create specialized system prompt for agent
   */
  private async createAgentSystemPrompt(agentPrompt: string, taskPrompt: string): Promise<string> {
    console.log('[AGENT_TOOL] Importing systemMessages module...');
    try {
      const { getAgentSystemPrompt } = await import('../prompts/systemMessages.js');
      console.log('[AGENT_TOOL] Calling getAgentSystemPrompt...');
      const result = await getAgentSystemPrompt(agentPrompt, taskPrompt);
      console.log('[AGENT_TOOL] getAgentSystemPrompt returned, length:', result?.length || 0);
      return result;
    } catch (error) {
      console.log('[AGENT_TOOL] ERROR in createAgentSystemPrompt:', error);
      throw error;
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
    console.log('[AGENT_TOOL] Interrupting', this.activeDelegations.size, 'active sub-agents');
    for (const [callId, delegation] of this.activeDelegations.entries()) {
      const subAgent = delegation.subAgent;
      if (subAgent && typeof subAgent.interrupt === 'function') {
        console.log('[AGENT_TOOL] Interrupting sub-agent:', callId);
        subAgent.interrupt();
      }
    }
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
        result.content.length > 100
          ? result.content.substring(0, 97) + '...'
          : result.content;
      lines.push(contentPreview);
    }

    return lines.slice(0, maxLines);
  }
}
