/**
 * CreateAgentTool - Create custom specialized agents
 *
 * Delegates to an agent that researches existing agent patterns and creates
 * a new agent configuration file in the current profile.
 *
 * Key features:
 * - Researches existing agents to understand patterns
 * - Validates agent configuration (name, tools, etc.)
 * - Creates agent file using AgentManager
 * - Requires confirmation before creating
 */

import { BaseTool } from './BaseTool.js';
import { InjectableTool } from './InjectableTool.js';
import { ToolResult, FunctionDefinition, ActivityEventType } from '../types/index.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { ServiceRegistry } from '../services/ServiceRegistry.js';
import { Agent, AgentConfig } from '../agent/Agent.js';
import { ModelClient } from '../llm/ModelClient.js';
import { logger } from '../services/Logger.js';
import { ToolManager } from './ToolManager.js';
import { formatError } from '../utils/errorUtils.js';
import { TEXT_LIMITS, FORMATTING } from '../config/constants.js';
import { AgentPoolService, PooledAgent } from '../services/AgentPoolService.js';
import { getThoroughnessDuration, getThoroughnessMaxTokens } from '../ui/utils/timeUtils.js';
import { createAgentPersistenceReminder } from '../utils/messageUtils.js';
import { getAgentsDir, getActiveProfile } from '../config/paths.js';

// Tools available for agent creation (read-only + explore for research + write-agent for creating agent file)
const AGENT_CREATION_TOOLS = ['read', 'glob', 'grep', 'ls', 'tree', 'explore', 'write-agent'];

/**
 * Generate agent creation system prompt
 *
 * @param agentsDir - Absolute path to the agents directory for this profile
 * @param profileName - Name of the active profile (used for context in instructions)
 */
function getAgentCreationSystemPrompt(agentsDir: string, profileName: string): string {
  // profileName is used in the template string for context - referenced but not stored
  return `You are an expert agent designer for Ally (profile: ${profileName}). You create specialized agents by researching existing patterns and designing comprehensive agent configurations.

## Your Strengths

- Researching existing agent patterns and conventions
- Understanding agent architecture and tool capabilities
- Designing clear, effective system prompts
- Validating agent configurations for correctness
- Creating well-structured agent files

## Your Task

Create a custom specialized agent based on the user's requirements by:

1. **Research Existing Agents** - Explore ${agentsDir} to understand:
   - Naming conventions (kebab-case)
   - System prompt structure and style
   - Tool selection patterns
   - Visibility and delegation settings
   - Common agent patterns

2. **Design Agent Configuration** - Create complete agent spec with:
   - **name**: kebab-case identifier (e.g., "code-reviewer", "test-writer")
   - **description**: One-line summary of agent's purpose
   - **system_prompt**: Detailed instructions defining agent behavior and expertise
   - **tools** (optional): Array of tool names (e.g., ["read", "write", "bash"]). Omit for all tools.
   - **model** (optional): Specific model to use (haiku/sonnet/opus)
   - **temperature** (optional): Temperature 0-1 for response variability
   - **reasoning_effort** (optional): "low", "medium", "high", or "inherit"
   - **usage_guidelines** (optional): When to use this agent (markdown format)
   - **visible_from_agents** (optional): Array of agent names that can call this (empty = main only)
   - **can_delegate_to_agents** (optional): Boolean, whether agent can spawn sub-agents
   - **can_see_agents** (optional): Boolean, whether agent can see agent tools

3. **Validate Configuration**:
   - Agent name is kebab-case (lowercase, hyphens only)
   - Agent name doesn't conflict with existing agents
   - All specified tools exist in the system
   - visible_from_agents references valid agent names (if specified)

4. **Create Agent File**:
   - Use write-agent tool with filename only (e.g., "agent-name.md")
   - The tool automatically saves to: ${agentsDir}/{agent-name}.md
   - Format as markdown with YAML frontmatter (see format below)
   - Include comprehensive system prompt in body

5. **Confirm Creation**:
   - Report agent name, description, and file path
   - Summarize key configuration choices
   - Explain how to use the new agent

## Agent File Format

\`\`\`markdown
---
name: "agent-name"
description: "One-line description"
model: "sonnet"                              # Optional
temperature: 0.7                             # Optional
reasoning_effort: "medium"                   # Optional
tools: ["read", "write", "edit", "bash"]     # Optional (omit for all tools)
usage_guidelines: |                          # Optional
  **When to use:** Specific use cases
  **When NOT to use:** Cases to avoid
visible_from_agents: ["explore", "plan"]     # Optional
can_delegate_to_agents: true                 # Optional
can_see_agents: true                         # Optional
created_at: "2025-11-24T10:30:00Z"
updated_at: "2025-11-24T10:30:00Z"
---

System prompt content here.

This defines the agent's behavior, expertise, and instructions.
Can be multiple paragraphs with specific guidance.
\`\`\`

## Available Tools

You have access to:
- **read**: Read existing agent files and documentation
- **glob**: Find agent files and patterns
- **grep**: Search for specific patterns in agents
- **ls/tree**: Explore directory structure
- **explore**: Delegate research to exploration agent
- **write-agent**: Create the agent file with filename only (e.g., "my-agent.md"). Path is automatic.

## Validation Rules

1. **Agent Name**:
   - MUST be kebab-case: lowercase letters, numbers, hyphens only
   - MUST start with a letter
   - MUST NOT conflict with existing agents
   - Valid: "code-reviewer", "python-tester", "api-designer"
   - Invalid: "CodeReviewer", "code_reviewer", "code reviewer", "123-agent"

2. **Tool Names**:
   - All tools in "tools" array MUST exist
   - Common tools: read, write, edit, bash, glob, grep, ls, tree, explore, plan, agent
   - Note: write-agent is only for internal use during agent creation
   - Omit "tools" field for access to all tools

3. **Agent References**:
   - All names in "visible_from_agents" MUST be valid agent names
   - Common agents: explore, plan, agent

4. **File Creation**:
   - Use write-agent tool with JUST the filename (e.g., "my-agent.md")
   - The tool automatically saves to the correct profile directory: ${agentsDir}
   - DO NOT use write tool - use write-agent instead
   - Example: write-agent(filename="code-reviewer.md", content="...")

## Execution Guidelines

1. **Research First** (unless empty profile):
   - Check ${agentsDir} for existing agents
   - If directory is empty or doesn't exist, use best practices for design

2. **Design Thoughtfully**:
   - Create clear, focused system prompts
   - Choose tools that match the agent's purpose
   - Add usage guidelines to help users know when to use this agent
   - Consider delegation and visibility settings

3. **Validate Thoroughly**:
   - Verify name is kebab-case
   - Check for name conflicts
   - Ensure all tools exist
   - Validate agent references

4. **Create File**:
   - Format with proper YAML frontmatter
   - Include comprehensive system prompt
   - Add timestamps (created_at, updated_at)
   - Use write-agent tool with filename only

5. **Report Results**:
   - Confirm agent creation with details
   - Explain how to use the new agent
   - Mention any important configuration choices

## Important Constraints

- Use write-agent tool (NOT write) with filename only - path is automatic
- Agent name MUST be kebab-case (e.g., "code-reviewer.md")
- System prompt should be clear, comprehensive, and focused
- Avoid using emojis for clear communication

Create the agent following these guidelines and confirm when complete.`;
}

export class CreateAgentTool extends BaseTool implements InjectableTool {
  readonly name = 'create-agent';
  readonly description =
    'Create custom specialized agent for current profile. Delegates to agent creation specialist with research + write access. Returns agent details and usage instructions.';
  readonly requiresConfirmation = true; // Requires confirmation to create agent file
  readonly suppressExecutionAnimation = true; // Agent manages its own display
  readonly shouldCollapse = true; // Collapse after completion
  readonly hideOutput = false; // Agents never hide their own output

  readonly usageGuidance = `**When to use create-agent:**
Need specialized agent for recurring tasks (code review, testing, documentation, etc.).
Creates reusable agent with custom system prompt and tool access.
CRITICAL: Agent CANNOT see current conversation - include ALL context in request (purpose, tools needed, behavior).
Agent has NO internet access - only local agent research.
Skip for: One-time tasks, existing agents sufficient, simple tool calls.`;

  private activeDelegations: Map<string, any> = new Map();
  private _currentPooledAgent: PooledAgent | null = null;

  // InjectableTool interface properties
  get delegationState(): 'executing' | 'completing' | null {
    // Always null for CreateAgentTool - delegation state is managed by DelegationContextManager
    return null;
  }

  get activeCallId(): string | null {
    // Always null for CreateAgentTool - delegation tracking is done by DelegationContextManager
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
            request: {
              type: 'string',
              description: 'Complete description of agent to create with ALL necessary context. Agent cannot see current conversation - include purpose, required tools, behavior, and any specific requirements.',
            },
            thoroughness: {
              type: 'string',
              description: 'Agent creation thoroughness: "quick" (~1 min, minimal research), "medium" (~5 min, moderate research), "very thorough" (~10 min, extensive research), "uncapped" (no time limit, default). Controls research depth.',
            },
          },
          required: ['request'],
        },
      },
    };
  }

  protected async executeImpl(args: any): Promise<ToolResult> {
    this.captureParams(args);

    const request = args.request;
    const thoroughness = args.thoroughness ?? 'uncapped';

    // Validate request parameter
    if (!request || typeof request !== 'string') {
      return this.formatErrorResponse(
        'request parameter is required and must be a string',
        'validation_error',
        'Example: create-agent(request="Create a Python code reviewer that checks PEP8 compliance")'
      );
    }

    // Validate thoroughness parameter
    const validThoroughness = ['quick', 'medium', 'very thorough', 'uncapped'];
    if (!validThoroughness.includes(thoroughness)) {
      return this.formatErrorResponse(
        `thoroughness must be one of: ${validThoroughness.join(', ')}`,
        'validation_error',
        'Example: create-agent(request="...", thoroughness="uncapped")'
      );
    }

    // Execute agent creation - pass currentCallId to avoid race conditions
    const callId = this.currentCallId;
    if (!callId) {
      return this.formatErrorResponse(
        'Internal error: callId not set',
        'system_error'
      );
    }

    return await this.executeAgentCreation(request, thoroughness, callId);
  }

  /**
   * Execute agent creation with specialized agent
   *
   * Agent creation agents always persist in the agent pool for reuse.
   *
   * @param request - Description of agent to create
   * @param thoroughness - Creation thoroughness level (quick/medium/very thorough/uncapped)
   * @param callId - Unique call identifier for tracking
   */
  private async executeAgentCreation(
    request: string,
    thoroughness: string,
    callId: string
  ): Promise<ToolResult> {
    logger.debug('[CREATE_AGENT_TOOL] Starting agent creation, callId:', callId, 'thoroughness:', thoroughness);
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
        throw new Error('CreateAgentTool requires model_client to be registered');
      }
      if (!toolManager) {
        throw new Error('CreateAgentTool requires tool_manager to be registered');
      }
      if (!configManager) {
        throw new Error('CreateAgentTool requires config_manager to be registered');
      }
      if (!permissionManager) {
        throw new Error('CreateAgentTool requires permission_manager to be registered');
      }

      const config = configManager.getConfig();
      if (!config) {
        throw new Error('ConfigManager.getConfig() returned null/undefined');
      }

      // Determine target model - use agent_creation_model if configured, otherwise use main model
      const targetModel = config.agent_creation_model || config.model;

      // CreateAgent agent uses INHERIT - get reasoning_effort from config
      const resolvedReasoningEffort = config.reasoning_effort;
      logger.debug(`[CREATE_AGENT_TOOL] Using config reasoning_effort: ${resolvedReasoningEffort}`);

      // Calculate max tokens based on thoroughness
      const maxTokens = getThoroughnessMaxTokens(thoroughness as any, config.max_tokens);
      logger.debug(`[CREATE_AGENT_TOOL] Set maxTokens to ${maxTokens} for thoroughness: ${thoroughness}`);

      // Create appropriate model client
      let modelClient: ModelClient;

      // Use shared client only if model and max_tokens match config
      // (reasoning_effort already matches config since we use INHERIT)
      if (targetModel === config.model && maxTokens === config.max_tokens) {
        // Use shared global client
        logger.debug(`[CREATE_AGENT_TOOL] Using shared model client (model: ${targetModel}, reasoning_effort: ${resolvedReasoningEffort}, maxTokens: ${maxTokens})`);
        modelClient = mainModelClient;
      } else {
        // Create dedicated client with different model or token limit
        logger.debug(`[CREATE_AGENT_TOOL] Creating dedicated client (model: ${targetModel}, reasoning_effort: ${resolvedReasoningEffort}, maxTokens: ${maxTokens})`);

        const { OllamaClient } = await import('../llm/OllamaClient.js');
        modelClient = new OllamaClient({
          endpoint: config.endpoint,
          modelName: targetModel,
          temperature: config.temperature,
          contextSize: config.context_size,
          maxTokens: maxTokens,
          activityStream: this.activityStream,
          reasoningEffort: resolvedReasoningEffort,
        });
      }

      // Filter to agent creation tools (read-only + explore + write)
      logger.debug('[CREATE_AGENT_TOOL] Filtering to agent creation tools:', AGENT_CREATION_TOOLS);
      const allowedToolNames = new Set(AGENT_CREATION_TOOLS);
      const allTools = toolManager.getAllTools();
      const filteredTools = allTools.filter(tool => allowedToolNames.has(tool.name));
      const filteredToolManager = new ToolManager(filteredTools, this.activityStream);
      logger.debug('[CREATE_AGENT_TOOL] Filtered to', filteredTools.length, 'tools:', filteredTools.map(t => t.name).join(', '));

      // Emit agent creation start event
      this.emitEvent({
        id: callId,
        type: ActivityEventType.AGENT_START,
        timestamp: Date.now(),
        data: {
          agentName: 'create-agent',
          taskPrompt: request,
        },
      });

      // Map thoroughness to max duration
      const maxDuration = getThoroughnessDuration(thoroughness as any);

      // Get parent agent - the agent currently executing this tool
      const parentAgent = registry.get<any>('agent');

      // Calculate agent depth for nesting
      const currentDepth = parentAgent?.getAgentDepth?.() ?? 0;
      const newDepth = currentDepth + 1;

      // Get agents directory and profile name for system prompt
      const agentsDir = getAgentsDir();
      const profileName = getActiveProfile();

      // Create agent configuration with unique pool key per invocation
      // This ensures each create-agent() call gets its own persistent agent
      const agentConfig: AgentConfig = {
        isSpecializedAgent: true,
        verbose: false,
        baseAgentPrompt: getAgentCreationSystemPrompt(agentsDir, profileName),
        taskPrompt: request,
        config: config,
        parentCallId: callId,
        parentAgent: parentAgent, // Direct reference to parent agent
        _poolKey: `create-agent-${callId}`, // Unique key per invocation
        maxDuration,
        thoroughness: thoroughness, // Store for dynamic regeneration
        agentType: 'create-agent',
        agentDepth: newDepth,
      };

      // Always use pooled agent for persistence
      let creationAgent: Agent;
      let pooledAgent: PooledAgent | null = null;
      let agentId: string | null = null;

      // Use AgentPoolService for persistent agent
      const agentPoolService = registry.get<AgentPoolService>('agent_pool');

      if (!agentPoolService) {
        // Graceful fallback: AgentPoolService not available
        logger.warn('[CREATE_AGENT_TOOL] AgentPoolService not available, falling back to ephemeral agent');
        creationAgent = new Agent(
          modelClient,
          filteredToolManager,
          this.activityStream,
          agentConfig,
          configManager,
          permissionManager
        );
      } else {
        // Acquire agent from pool with filtered ToolManager
        logger.debug('[CREATE_AGENT_TOOL] Acquiring agent from pool with filtered ToolManager');
        // Pass custom modelClient only if agent creation uses a different model than global
        const customModelClient = targetModel !== config.model ? modelClient : undefined;
        pooledAgent = await agentPoolService.acquire(agentConfig, filteredToolManager, customModelClient);
        creationAgent = pooledAgent.agent;
        agentId = pooledAgent.agentId;
        this._currentPooledAgent = pooledAgent; // Track for interjection routing

        // Register delegation with DelegationContextManager
        try {
          const serviceRegistry = ServiceRegistry.getInstance();
          const toolManager = serviceRegistry.get<any>('tool_manager');
          const delegationManager = toolManager?.getDelegationContextManager();
          if (delegationManager) {
            delegationManager.register(callId, 'create-agent', pooledAgent);
            logger.debug(`[CREATE_AGENT_TOOL] Registered delegation: callId=${callId}`);
          }
        } catch (error) {
          // ServiceRegistry not available in tests - skip delegation registration
          logger.debug(`[CREATE_AGENT_TOOL] Delegation registration skipped: ${error}`);
        }

        logger.debug('[CREATE_AGENT_TOOL] Acquired pooled agent:', agentId);
      }

      // Track active delegation
      this.activeDelegations.set(callId, {
        agent: creationAgent,
        request,
        startTime: Date.now(),
      });

      // Update registry to point to sub-agent during its execution
      // This ensures nested tool calls get correct parent
      const previousAgent = registry.get<any>('agent');
      registry.registerInstance('agent', creationAgent);

      try {
        // Execute agent creation
        logger.debug('[CREATE_AGENT_TOOL] Sending task to agent creation agent...');
        // Pass fresh execution context to prevent stale state in pooled agents
        const response = await creationAgent.sendMessage(`Create an agent for: ${request}`, {
          parentCallId: callId,
          maxDuration,
          thoroughness,
        });
        logger.debug('[CREATE_AGENT_TOOL] Agent creation response received, length:', response?.length || 0);

        let finalResponse: string;

        // Ensure we have a substantial response
        if (!response || response.trim().length === 0) {
          logger.debug('[CREATE_AGENT_TOOL] Empty response, extracting from conversation');
          finalResponse = this.extractSummaryFromConversation(creationAgent) ||
            'Agent creation completed but no summary was provided.';
        } else if (response.includes('[Request interrupted') || response.length < TEXT_LIMITS.AGENT_RESPONSE_MIN) {
          logger.debug('[CREATE_AGENT_TOOL] Incomplete response, attempting to extract summary');
          const summary = this.extractSummaryFromConversation(creationAgent);
          finalResponse = (summary && summary.length > response.length) ? summary : response;
        } else {
          finalResponse = response;
        }

        const duration = (Date.now() - startTime) / 1000;

        // Emit agent creation end event
        this.emitEvent({
          id: callId,
          type: ActivityEventType.AGENT_END,
          timestamp: Date.now(),
          data: {
            agentName: 'create-agent',
            result: finalResponse,
            duration,
          },
        });

        // Append note that user cannot see this
        const content = finalResponse + '\n\nIMPORTANT: The user CANNOT see this output. You must share relevant agent details with the user in your own response.';

        // Build response with agent_used
        const successResponse: Record<string, any> = {
          content,
          duration_seconds: Math.round(duration * Math.pow(10, FORMATTING.DURATION_DECIMAL_PLACES)) / Math.pow(10, FORMATTING.DURATION_DECIMAL_PLACES),
          agent_used: 'create-agent',
        };

        // Always include agent_id when available (with explicit persistence flags)
        if (agentId) {
          successResponse.agent_id = agentId;
          // PERSIST: false - Ephemeral: Coaching about agent-ask for follow-ups
          // Cleaned up after turn since agent should integrate advice, not need constant reminding
          const reminder = createAgentPersistenceReminder(agentId);
          Object.assign(successResponse, reminder);
        }

        return this.formatSuccessResponse(successResponse);
      } finally {
        // Restore previous agent in registry
        try {
          registry.registerInstance('agent', previousAgent);
          logger.debug(`[CREATE_AGENT_TOOL] Restored registry 'agent': ${(previousAgent as any)?.instanceId || 'null'}`);
        } catch (registryError) {
          logger.error(`[CREATE_AGENT_TOOL] CRITICAL: Failed to restore registry agent:`, registryError);
          // Don't throw - continue with other cleanup
        }

        // Clean up delegation tracking
        logger.debug('[CREATE_AGENT_TOOL] Cleaning up agent creation agent...');
        this.activeDelegations.delete(callId);

        // Release agent back to pool or cleanup ephemeral agent
        if (pooledAgent) {
          // Release agent back to pool
          logger.debug('[CREATE_AGENT_TOOL] Releasing agent back to pool');
          pooledAgent.release();

          // Transition delegation to completing state
          try {
            const serviceRegistry = ServiceRegistry.getInstance();
            const toolManager = serviceRegistry.get<any>('tool_manager');
            const delegationManager = toolManager?.getDelegationContextManager();
            if (delegationManager) {
              delegationManager.transitionToCompleting(callId);
              logger.debug(`[CREATE_AGENT_TOOL] Transitioned delegation to completing: callId=${callId}`);
            }
          } catch (error) {
            logger.debug(`[CREATE_AGENT_TOOL] Delegation transition skipped: ${error}`);
          }

          this._currentPooledAgent = null; // Clear tracked pooled agent
        } else {
          // Cleanup ephemeral agent (only if AgentPoolService was unavailable)
          await creationAgent.cleanup();

          // Transition delegation to completing state
          try {
            const serviceRegistry = ServiceRegistry.getInstance();
            const toolManager = serviceRegistry.get<any>('tool_manager');
            const delegationManager = toolManager?.getDelegationContextManager();
            if (delegationManager) {
              delegationManager.transitionToCompleting(callId);
              logger.debug(`[CREATE_AGENT_TOOL] Transitioned delegation to completing: callId=${callId}`);
            }
          } catch (error) {
            logger.debug(`[CREATE_AGENT_TOOL] Delegation transition skipped: ${error}`);
          }
        }
      }
    } catch (error) {
      return this.formatErrorResponse(
        `Agent creation failed: ${formatError(error)}`,
        'execution_error',
        undefined,
        { agent_used: 'create-agent' }
      );
    }
  }

  /**
   * Extract summary from agent creation agent's conversation history
   */
  private extractSummaryFromConversation(agent: Agent): string | null {
    try {
      const messages = agent.getMessages();

      // Find all assistant messages
      const assistantMessages = messages
        .filter(msg => msg.role === 'assistant' && msg.content && msg.content.trim().length > 0)
        .map(msg => msg.content);

      if (assistantMessages.length === 0) {
        logger.debug('[CREATE_AGENT_TOOL] No assistant messages found in conversation');
        return null;
      }

      // Combine recent messages if multiple exist
      if (assistantMessages.length > 1) {
        const recentMessages = assistantMessages.slice(-3);
        const summary = recentMessages.join('\n\n');
        logger.debug('[CREATE_AGENT_TOOL] Extracted summary from', recentMessages.length, 'messages, length:', summary.length);
        return `Agent creation results:\n\n${summary}`;
      }

      // Single assistant message
      const summary = assistantMessages[0];
      if (summary) {
        logger.debug('[CREATE_AGENT_TOOL] Using single assistant message as summary, length:', summary.length);
        return summary;
      }

      return null;
    } catch (error) {
      logger.debug('[CREATE_AGENT_TOOL] Error extracting summary:', error);
      return null;
    }
  }

  /**
   * Interrupt all active agent creation sessions
   */
  interruptAll(): void {
    logger.debug('[CREATE_AGENT_TOOL] Interrupting', this.activeDelegations.size, 'active agent creation sessions');
    for (const [callId, delegation] of this.activeDelegations.entries()) {
      const agent = delegation.agent;
      if (agent && typeof agent.interrupt === 'function') {
        logger.debug('[CREATE_AGENT_TOOL] Interrupting agent creation:', callId);
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
      logger.warn('[CREATE_AGENT_TOOL] injectUserMessage called but no active pooled agent');
      return;
    }

    const agent = this._currentPooledAgent.agent;
    if (!agent) {
      logger.warn('[CREATE_AGENT_TOOL] injectUserMessage called but pooled agent has no agent instance');
      return;
    }

    logger.debug('[CREATE_AGENT_TOOL] Injecting user message into pooled agent:', this._currentPooledAgent.agentId);
    agent.addUserInterjection(message);
    agent.interrupt('interjection');
  }

  /**
   * Format subtext for display in UI
   * Shows full request (no truncation - displayed on separate indented lines)
   */
  formatSubtext(args: Record<string, any>): string | null {
    const request = args.request as string;

    if (!request) {
      return null;
    }

    return request;
  }

  /**
   * Get parameters shown in subtext
   * CreateAgentTool shows 'request' in subtext
   */
  getSubtextParameters(): string[] {
    return ['request'];
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
      lines.push(`Agent created in ${result.duration_seconds}s`);
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
