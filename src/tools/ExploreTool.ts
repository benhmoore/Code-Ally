/**
 * ExploreTool - Simplified read-only codebase exploration
 *
 * Provides a focused, lightweight agent for codebase exploration with hardcoded
 * read-only tool access. Simpler alternative to AgentTool for exploration tasks.
 *
 * Key differences from AgentTool:
 * - No AgentManager dependency (hardcoded prompt and tools)
 * - Single purpose: codebase exploration
 * - Guaranteed read-only access
 * - Zero configuration needed
 * - Agents always persist in the pool for reuse
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

// Tools available for exploration (read-only + write-temp for note-taking)
const EXPLORATION_TOOLS = ['read', 'glob', 'grep', 'ls', 'tree', 'batch', 'write-temp'];

// Base prompt for exploration (without thoroughness-specific guidelines)
const EXPLORATION_BASE_PROMPT = `You are a specialized codebase exploration assistant. You excel at thoroughly navigating and exploring codebases to understand structure, find implementations, and analyze architecture.

## Your Strengths

- Rapidly finding files using glob patterns
- Searching code and text with powerful regex patterns
- Reading and analyzing file contents
- Understanding directory structures with tree visualization
- Executing parallel operations for efficiency

## Tool Usage Guidelines

- Use Tree to understand directory hierarchy and project organization
- Use Glob for broad file pattern matching (e.g., "**/*.ts", "src/components/**")
- Use Grep for searching file contents with regex patterns
- Use Read when you know specific file paths you need to examine
- Use Ls for listing directory contents when exploring structure
- Use Batch to execute multiple operations in parallel for efficiency
- Use WriteTemp to save temporary notes for organizing findings during exploration
- Adapt your search approach based on the thoroughness level specified

## Organizing Your Findings

- WriteTemp creates temporary notes in /tmp (e.g., write-temp(content="...", filename="notes.txt"))
- Use separate files to organize by category: architecture.txt, patterns.txt, issues.txt
- Read your notes before generating final response to ensure comprehensive coverage
- Especially useful for medium/very thorough explorations with many findings

## Core Objective

Complete the exploration request efficiently and report your findings clearly with absolute file paths and relevant code snippets.

## Important Constraints

- You have READ-ONLY access - you cannot modify files
- Agent threads have cwd reset between bash calls - always use absolute file paths
- In your final response, always share relevant file names and code snippets
- All file paths in your response MUST be absolute, NOT relative
- Avoid using emojis for clear communication
- Be systematic: trace dependencies, identify relationships, understand flow`;

// System prompt optimized for exploration
const EXPLORATION_SYSTEM_PROMPT = EXPLORATION_BASE_PROMPT + `

**Execution Guidelines:**
- Be thorough but efficient with tool usage (aim for 5-10 tool calls)
- Start with structure (tree/ls) before diving into specific files
- Use parallel operations (batch) when searching multiple patterns
- Always provide clear, structured summaries of findings
- Highlight key files, patterns, and architectural decisions
- If you can't find something, explain what you searched and what was missing

Execute your exploration systematically and provide comprehensive results.`;

export class ExploreTool extends BaseTool implements InjectableTool {
  readonly name = 'explore';
  readonly description =
    'Explore codebase with read-only access. Delegates to specialized exploration agent. Use when you need to understand code structure, find implementations, or analyze architecture. Returns comprehensive findings.';
  readonly requiresConfirmation = false; // Read-only operation
  readonly suppressExecutionAnimation = true; // Agent manages its own display
  readonly shouldCollapse = true; // Collapse after completion
  readonly hideOutput = false; // Show detailed output

  readonly usageGuidance = `**When to use explore:**
Unknown scope/location: Don't know where to start or how much code is involved.
Multi-file synthesis: Understanding patterns, relationships, or architecture across codebase.
Preserves your context - investigation happens in separate agent context.
NOT for: Known file paths, single-file questions, simple lookups.

Note: Multiple independent explorations can be batched for efficiency.`;

  private activeDelegations: Map<string, any> = new Map();
  private _currentPooledAgent: PooledAgent | null = null;

  // InjectableTool interface properties
  get delegationState(): 'executing' | 'completing' | null {
    // Always null for ExploreTool - delegation state is managed by DelegationContextManager
    return null;
  }

  get activeCallId(): string | null {
    // Always null for ExploreTool - delegation tracking is done by DelegationContextManager
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
            task_description: {
              type: 'string',
              description: 'Description of what to explore or find in the codebase. Be specific about what you want to understand.',
            },
            thoroughness: {
              type: 'string',
              description: 'Level of thoroughness for exploration: "quick" (~1 min, 2-5 tool calls), "medium" (~5 min, 5-10 tool calls), "very thorough" (~10 min, 10-20 tool calls), "uncapped" (no time limit, default). Controls time budget and depth.',
            },
          },
          required: ['task_description'],
        },
      },
    };
  }

  protected async executeImpl(args: any): Promise<ToolResult> {
    this.captureParams(args);

    const taskDescription = args.task_description;
    const thoroughness = args.thoroughness ?? 'uncapped';

    // Validate task_description parameter
    if (!taskDescription || typeof taskDescription !== 'string') {
      return this.formatErrorResponse(
        'task_description parameter is required and must be a string',
        'validation_error',
        'Example: explore(task_description="Find how error handling is implemented")'
      );
    }

    // Validate thoroughness parameter
    const validThoroughness = ['quick', 'medium', 'very thorough', 'uncapped'];
    if (!validThoroughness.includes(thoroughness)) {
      return this.formatErrorResponse(
        `thoroughness parameter must be one of: ${validThoroughness.join(', ')}`,
        'validation_error',
        'Example: explore(task_description="...", thoroughness="uncapped")'
      );
    }

    // Execute exploration - pass currentCallId to avoid race conditions
    const callId = this.currentCallId;
    if (!callId) {
      return this.formatErrorResponse(
        'Internal error: callId not set',
        'system_error'
      );
    }

    return await this.executeExploration(taskDescription, thoroughness, callId);
  }

  /**
   * Execute exploration with read-only agent
   *
   * All exploration agents are persisted in the agent pool for reuse.
   *
   * @param taskDescription - The exploration task to execute
   * @param thoroughness - Level of thoroughness: "quick", "medium", or "very thorough"
   * @param callId - Unique call identifier for tracking
   */
  private async executeExploration(
    taskDescription: string,
    thoroughness: string,
    callId: string
  ): Promise<ToolResult> {
    logger.debug('[EXPLORE_TOOL] Starting exploration, callId:', callId);
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
        throw new Error('ExploreTool requires model_client to be registered');
      }
      if (!toolManager) {
        throw new Error('ExploreTool requires tool_manager to be registered');
      }
      if (!configManager) {
        throw new Error('ExploreTool requires config_manager to be registered');
      }
      if (!permissionManager) {
        throw new Error('ExploreTool requires permission_manager to be registered');
      }

      const config = configManager.getConfig();
      if (!config) {
        throw new Error('ConfigManager.getConfig() returned null/undefined');
      }

      // Determine target model
      const targetModel = config.explore_model || config.model;

      // Explore agent uses INHERIT - get reasoning_effort from config
      const resolvedReasoningEffort = config.reasoning_effort;
      logger.debug(`[EXPLORE_TOOL] Using config reasoning_effort: ${resolvedReasoningEffort}`);

      // Calculate max tokens based on thoroughness
      const maxTokens = getThoroughnessMaxTokens(thoroughness as any, config.max_tokens);
      logger.debug(`[EXPLORE_TOOL] Set maxTokens to ${maxTokens} for thoroughness: ${thoroughness}`);

      // Create appropriate model client
      let modelClient: ModelClient;

      // Use shared client only if model, reasoning_effort, AND max_tokens all match config
      if (targetModel === config.model && resolvedReasoningEffort === config.reasoning_effort && maxTokens === config.max_tokens) {
        // Use shared global client
        logger.debug(`[EXPLORE_TOOL] Using shared model client (model: ${targetModel}, reasoning_effort: ${resolvedReasoningEffort}, maxTokens: ${maxTokens})`);
        modelClient = mainModelClient;
      } else {
        // Explore specifies different model OR different reasoning_effort - create dedicated client
        logger.debug(`[EXPLORE_TOOL] Creating dedicated client (model: ${targetModel}, reasoning_effort: ${resolvedReasoningEffort})`);

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

      // Filter to exploration tools (read-only + write-temp)
      logger.debug('[EXPLORE_TOOL] Filtering to exploration tools:', EXPLORATION_TOOLS);
      const allowedToolNames = new Set(EXPLORATION_TOOLS);
      const allTools = toolManager.getAllTools();
      const filteredTools = allTools.filter(tool => allowedToolNames.has(tool.name));
      const filteredToolManager = new ToolManager(filteredTools, this.activityStream);
      logger.debug('[EXPLORE_TOOL] Filtered to', filteredTools.length, 'tools:', filteredTools.map(t => t.name).join(', '));

      // Create specialized system prompt
      const specializedPrompt = await this.createExplorationSystemPrompt(taskDescription, thoroughness, resolvedReasoningEffort);

      // Emit exploration start event
      this.emitEvent({
        id: callId,
        type: ActivityEventType.AGENT_START,
        timestamp: Date.now(),
        data: {
          agentName: 'explore',
          taskPrompt: taskDescription,
        },
      });

      // Map thoroughness to max duration
      const maxDuration = getThoroughnessDuration(thoroughness as any);

      // Create agent configuration
      const agentConfig: AgentConfig = {
        isSpecializedAgent: true,
        verbose: false,
        systemPrompt: specializedPrompt,
        baseAgentPrompt: EXPLORATION_SYSTEM_PROMPT,
        taskPrompt: taskDescription,
        config: config,
        parentCallId: callId,
        maxDuration,
        agentType: 'explore',
      };

      // Always use pooled agent for persistence
      let explorationAgent: Agent;
      let pooledAgent: PooledAgent | null = null;
      let agentId: string | null = null;

      // Use AgentPoolService for persistent agent
      const agentPoolService = registry.get<AgentPoolService>('agent_pool');

      if (!agentPoolService) {
        // Graceful fallback: AgentPoolService not available
        logger.warn('[EXPLORE_TOOL] AgentPoolService not available, falling back to ephemeral agent');
        explorationAgent = new Agent(
          modelClient,
          filteredToolManager,
          this.activityStream,
          agentConfig,
          configManager,
          permissionManager
        );
      } else {
        // Acquire agent from pool with filtered ToolManager
        logger.debug('[EXPLORE_TOOL] Acquiring agent from pool with filtered ToolManager');
        // Pass custom modelClient only if explore uses a different model than global
        const customModelClient = targetModel !== config.model ? modelClient : undefined;
        pooledAgent = await agentPoolService.acquire(agentConfig, filteredToolManager, customModelClient);
        explorationAgent = pooledAgent.agent;
        agentId = pooledAgent.agentId;
        this._currentPooledAgent = pooledAgent; // Track for interjection routing

        // Register delegation with DelegationContextManager
        try {
          const serviceRegistry = ServiceRegistry.getInstance();
          const toolManager = serviceRegistry.get<any>('tool_manager');
          const delegationManager = toolManager?.getDelegationContextManager();
          if (delegationManager) {
            delegationManager.register(callId, 'explore', pooledAgent);
            logger.debug(`[EXPLORE_TOOL] Registered delegation: callId=${callId}`);
          }
        } catch (error) {
          // ServiceRegistry not available in tests - skip delegation registration
          logger.debug(`[EXPLORE_TOOL] Delegation registration skipped: ${error}`);
        }

        logger.debug('[EXPLORE_TOOL] Acquired pooled agent:', agentId);
      }

      // Track active delegation
      this.activeDelegations.set(callId, {
        agent: explorationAgent,
        taskDescription,
        startTime: Date.now(),
      });

      try {
        // Execute exploration
        logger.debug('[EXPLORE_TOOL] Sending task to exploration agent...');
        const response = await explorationAgent.sendMessage(`Execute this exploration task: ${taskDescription}`);
        logger.debug('[EXPLORE_TOOL] Exploration agent response received, length:', response?.length || 0);

        let finalResponse: string;

        // Ensure we have a substantial response
        if (!response || response.trim().length === 0) {
          logger.debug('[EXPLORE_TOOL] Empty response, extracting from conversation');
          finalResponse = this.extractSummaryFromConversation(explorationAgent) ||
            'Exploration completed but no summary was provided.';
        } else if (response.includes('[Request interrupted') || response.length < TEXT_LIMITS.AGENT_RESPONSE_MIN) {
          logger.debug('[EXPLORE_TOOL] Incomplete response, attempting to extract summary');
          const summary = this.extractSummaryFromConversation(explorationAgent);
          finalResponse = (summary && summary.length > response.length) ? summary : response;
        } else {
          finalResponse = response;
        }

        const duration = (Date.now() - startTime) / 1000;

        // Emit exploration end event
        this.emitEvent({
          id: callId,
          type: ActivityEventType.AGENT_END,
          timestamp: Date.now(),
          data: {
            agentName: 'explore',
            result: finalResponse,
            duration,
          },
        });

        // Append note that user cannot see this
        const result = finalResponse + '\n\nIMPORTANT: The user CANNOT see this output! You must share relevant information, summarized or verbatim with the user in your own response, if appropriate.';

        // Build response with agent_id (always returned since agents always persist)
        const successResponse: Record<string, any> = {
          content: result,
          duration_seconds: Math.round(duration * Math.pow(10, FORMATTING.DURATION_DECIMAL_PLACES)) / Math.pow(10, FORMATTING.DURATION_DECIMAL_PLACES),
        };

        // Always include agent_id when available
        if (agentId) {
          successResponse.agent_id = agentId;
          successResponse.system_reminder = `Agent persists as ${agentId}. For related follow-ups, USE agent-ask(agent_id="${agentId}", message="...") - dramatically more efficient than starting fresh. Start new agents only for unrelated problems.`;
        }

        return this.formatSuccessResponse(successResponse);
      } finally {
        // Clean up delegation tracking
        logger.debug('[EXPLORE_TOOL] Cleaning up exploration agent...');
        this.activeDelegations.delete(callId);

        // Release agent back to pool or cleanup ephemeral agent
        if (pooledAgent) {
          // Release agent back to pool
          logger.debug('[EXPLORE_TOOL] Releasing agent back to pool');
          pooledAgent.release();

          // Transition delegation to completing state
          try {
            const serviceRegistry = ServiceRegistry.getInstance();
            const toolManager = serviceRegistry.get<any>('tool_manager');
            const delegationManager = toolManager?.getDelegationContextManager();
            if (delegationManager) {
              delegationManager.transitionToCompleting(callId);
              logger.debug(`[EXPLORE_TOOL] Transitioned delegation to completing: callId=${callId}`);
            }
          } catch (error) {
            logger.debug(`[EXPLORE_TOOL] Delegation transition skipped: ${error}`);
          }

          this._currentPooledAgent = null; // Clear tracked pooled agent
        } else {
          // Cleanup ephemeral agent (only if AgentPoolService was unavailable)
          await explorationAgent.cleanup();

          // Transition delegation to completing state
          try {
            const serviceRegistry = ServiceRegistry.getInstance();
            const toolManager = serviceRegistry.get<any>('tool_manager');
            const delegationManager = toolManager?.getDelegationContextManager();
            if (delegationManager) {
              delegationManager.transitionToCompleting(callId);
              logger.debug(`[EXPLORE_TOOL] Transitioned delegation to completing: callId=${callId}`);
            }
          } catch (error) {
            logger.debug(`[EXPLORE_TOOL] Delegation transition skipped: ${error}`);
          }
        }
      }
    } catch (error) {
      return this.formatErrorResponse(
        `Exploration failed: ${formatError(error)}`,
        'execution_error'
      );
    }
  }

  /**
   * Create specialized system prompt for exploration
   */
  private async createExplorationSystemPrompt(taskDescription: string, thoroughness: string, reasoningEffort?: string): Promise<string> {
    logger.debug('[EXPLORE_TOOL] Creating exploration system prompt with thoroughness:', thoroughness);
    try {
      // Adjust the base prompt based on thoroughness level
      const adjustedPrompt = this.adjustPromptForThoroughness(thoroughness);

      const { getAgentSystemPrompt } = await import('../prompts/systemMessages.js');
      const result = await getAgentSystemPrompt(adjustedPrompt, taskDescription, undefined, undefined, reasoningEffort);
      logger.debug('[EXPLORE_TOOL] System prompt created, length:', result?.length || 0);
      return result;
    } catch (error) {
      logger.debug('[EXPLORE_TOOL] ERROR creating system prompt:', error);
      throw error;
    }
  }

  /**
   * Adjust exploration system prompt based on thoroughness level
   */
  private adjustPromptForThoroughness(thoroughness: string): string {
    let thoroughnessGuidelines: string;

    switch (thoroughness) {
      case 'quick':
        thoroughnessGuidelines = `**Important Guidelines:**
- You have READ-ONLY access to codebase - you cannot modify project files
- You CAN write temporary notes to /tmp using write-temp to organize findings
- **Time limit: ~1 minute maximum** - System reminders will notify you of remaining time
- Be efficient and focused (aim for 2-5 tool calls)
- Prioritize grep/glob over extensive file reading
- Use write-temp if you need to track findings across searches
- Provide quick, concise summaries of findings
- Focus on speed over comprehensiveness
- If you can't find something quickly, explain what you searched`;
        break;

      case 'medium':
        thoroughnessGuidelines = `**Important Guidelines:**
- You have READ-ONLY access to codebase - you cannot modify project files
- You CAN write temporary notes to /tmp using write-temp to organize findings
- **Time limit: ~5 minutes maximum** - System reminders will notify you of remaining time
- Be thorough but efficient with tool usage (aim for 5-10 tool calls)
- Consider using write-temp to organize findings by category as you discover them
- Review your notes before summarizing to ensure comprehensive coverage
- Always provide clear, structured summaries of findings
- Highlight key files, patterns, and architectural decisions
- If you can't find something, explain what you searched and what was missing`;
        break;

      case 'very thorough':
        thoroughnessGuidelines = `**Important Guidelines:**
- You have READ-ONLY access to codebase - you cannot modify project files
- You CAN write temporary notes to /tmp using write-temp to organize findings
- **Time limit: ~10 minutes maximum** - System reminders will notify you of remaining time
- Be comprehensive and meticulous (aim for 10-20 tool calls)
- Use write-temp extensively to organize findings as you discover them
- Create separate note files for different aspects (architecture.txt, patterns.txt, dependencies.txt)
- Check multiple locations and consider various naming conventions
- Trace dependencies deeply and understand complete call chains
- Read extensively to build complete understanding
- Cross-reference findings across multiple files
- Investigate edge cases and alternative implementations
- Review and synthesize all notes before providing final detailed summary
- Always provide detailed, structured summaries with extensive context
- Document all patterns, architectural decisions, and relationships found`;
        break;

      case 'uncapped':
      default:
        thoroughnessGuidelines = `**Important Guidelines:**
- You have READ-ONLY access to codebase - you cannot modify project files
- You CAN write temporary notes to /tmp using write-temp to organize findings
- **No time limit imposed** - Take the time needed to do a thorough job
- Be comprehensive and systematic with tool usage
- Use write-temp to organize extensive findings into separate note files
- Review your accumulated notes before generating final response
- Always provide clear, structured summaries of findings
- Highlight key files, patterns, and architectural decisions
- If you can't find something, explain what you searched and what was missing`;
        break;
    }

    // Compose the full prompt with thoroughness-specific guidelines
    return EXPLORATION_BASE_PROMPT + '\n\n' + thoroughnessGuidelines + '\n\nExecute your exploration systematically and provide comprehensive results.';
  }

  /**
   * Extract summary from exploration agent's conversation history
   */
  private extractSummaryFromConversation(agent: Agent): string | null {
    try {
      const messages = agent.getMessages();

      // Find all assistant messages
      const assistantMessages = messages
        .filter(msg => msg.role === 'assistant' && msg.content && msg.content.trim().length > 0)
        .map(msg => msg.content);

      if (assistantMessages.length === 0) {
        logger.debug('[EXPLORE_TOOL] No assistant messages found in conversation');
        return null;
      }

      // Combine recent messages if multiple exist
      if (assistantMessages.length > 1) {
        const recentMessages = assistantMessages.slice(-3);
        const summary = recentMessages.join('\n\n');
        logger.debug('[EXPLORE_TOOL] Extracted summary from', recentMessages.length, 'messages, length:', summary.length);
        return `Exploration findings:\n\n${summary}`;
      }

      // Single assistant message
      const summary = assistantMessages[0];
      if (summary) {
        logger.debug('[EXPLORE_TOOL] Using single assistant message as summary, length:', summary.length);
        return summary;
      }

      return null;
    } catch (error) {
      logger.debug('[EXPLORE_TOOL] Error extracting summary:', error);
      return null;
    }
  }

  /**
   * Interrupt all active explorations
   */
  interruptAll(): void {
    logger.debug('[EXPLORE_TOOL] Interrupting', this.activeDelegations.size, 'active explorations');
    for (const [callId, delegation] of this.activeDelegations.entries()) {
      const agent = delegation.agent;
      if (agent && typeof agent.interrupt === 'function') {
        logger.debug('[EXPLORE_TOOL] Interrupting exploration:', callId);
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
      logger.warn('[EXPLORE_TOOL] injectUserMessage called but no active pooled agent');
      return;
    }

    const agent = this._currentPooledAgent.agent;
    if (!agent) {
      logger.warn('[EXPLORE_TOOL] injectUserMessage called but pooled agent has no agent instance');
      return;
    }

    logger.debug('[EXPLORE_TOOL] Injecting user message into pooled agent:', this._currentPooledAgent.agentId);
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

    // Show duration if available
    if (result.duration_seconds !== undefined) {
      lines.push(`Explored in ${result.duration_seconds}s`);
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
