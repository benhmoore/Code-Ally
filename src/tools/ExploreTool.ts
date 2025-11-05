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
import { getThoroughnessDuration } from '../ui/utils/timeUtils.js';

// Hardcoded read-only tools for exploration
const READ_ONLY_TOOLS = ['read', 'glob', 'grep', 'ls', 'tree', 'batch'];

// Base prompt for exploration (without thoroughness-specific guidelines)
const EXPLORATION_BASE_PROMPT = `You are a specialized code exploration assistant. Your role is to analyze codebases, understand architecture, find patterns, and answer questions about code structure and implementation.

**Your Capabilities:**
- View directory tree structures (tree) - preferred for understanding hierarchy
- Search for files and patterns across the codebase (glob, grep)
- Read and analyze file contents (read)
- List directory contents (ls)
- Execute parallel operations for efficiency (batch)

**Your Approach:**
- Start with structure: Use tree() to understand directory hierarchy and organization
- Search for patterns: Use glob/grep to find relevant files and implementations
- Read for details: Use read() to examine specific file contents
- Be systematic: Trace dependencies, identify relationships, understand flow
- Use batch() for parallel operations when appropriate
- Build comprehensive understanding before summarizing`;

// Hardcoded system prompt optimized for exploration (for backward compatibility with baseAgentPrompt)
const EXPLORATION_SYSTEM_PROMPT = EXPLORATION_BASE_PROMPT + `

**Important Guidelines:**
- You have READ-ONLY access - you cannot modify files
- Be thorough but efficient with tool usage (aim for 5-10 tool calls)
- Always provide clear, structured summaries of findings
- Highlight key files, patterns, and architectural decisions
- If you can't find something, explain what you searched and what was missing

Execute your exploration systematically and provide comprehensive results.`;

export class ExploreTool extends BaseTool {
  readonly name = 'explore';
  readonly description =
    'Explore codebase with read-only access. Delegates to specialized exploration agent. Use when you need to understand code structure, find implementations, or analyze architecture. Returns comprehensive findings.';
  readonly requiresConfirmation = false; // Read-only operation
  readonly suppressExecutionAnimation = true; // Agent manages its own display
  readonly shouldCollapse = true; // Collapse after completion
  readonly hideOutput = true; // Hide detailed output

  readonly usageGuidance = `**When to use explore:**
Architectural/flow questions requiring synthesis: "Where is X displayed?", "How does Y work?"
Bug investigation, understanding unknown implementations.
PREFER over manual grep→analyze workflows—explore does this systematically.
NOT for: known file paths, simple counting, literal searches (use read/glob/grep).`;

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

      // Filter to read-only tools
      logger.debug('[EXPLORE_TOOL] Filtering to read-only tools:', READ_ONLY_TOOLS);
      const allowedToolNames = new Set(READ_ONLY_TOOLS);
      const allTools = toolManager.getAllTools();
      const filteredTools = allTools.filter(tool => allowedToolNames.has(tool.name));
      const filteredToolManager = new ToolManager(filteredTools, this.activityStream);
      logger.debug('[EXPLORE_TOOL] Filtered to', filteredTools.length, 'tools:', filteredTools.map(t => t.name).join(', '));

      // Create specialized system prompt
      const specializedPrompt = await this.createExplorationSystemPrompt(taskDescription, thoroughness);

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
          mainModelClient,
          filteredToolManager,
          this.activityStream,
          agentConfig,
          configManager,
          permissionManager
        );
      } else {
        // Acquire agent from pool with filtered ToolManager
        logger.debug('[EXPLORE_TOOL] Acquiring agent from pool with filtered ToolManager');
        pooledAgent = await agentPoolService.acquire(agentConfig, filteredToolManager);
        explorationAgent = pooledAgent.agent;
        agentId = pooledAgent.agentId;
        this.currentPooledAgent = pooledAgent; // Track for interjection routing
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
          successResponse.system_reminder = `Agent persists as ${agentId}. For follow-up questions, PREFER agent_ask(agent_id="${agentId}", message="...") over direct tools—agent has context for richer answers.`;
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
          this.currentPooledAgent = null; // Clear tracked pooled agent
        } else {
          // Cleanup ephemeral agent (only if AgentPoolService was unavailable)
          await explorationAgent.cleanup();
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
  private async createExplorationSystemPrompt(taskDescription: string, thoroughness: string): Promise<string> {
    logger.debug('[EXPLORE_TOOL] Creating exploration system prompt with thoroughness:', thoroughness);
    try {
      // Adjust the base prompt based on thoroughness level
      const adjustedPrompt = this.adjustPromptForThoroughness(thoroughness);

      const { getAgentSystemPrompt } = await import('../prompts/systemMessages.js');
      const result = await getAgentSystemPrompt(adjustedPrompt, taskDescription);
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
- You have READ-ONLY access - you cannot modify files
- **Time limit: ~1 minute maximum** - System reminders will notify you of remaining time
- Be efficient and focused (aim for 2-5 tool calls)
- Prioritize grep/glob over extensive file reading
- Provide quick, concise summaries of findings
- Focus on speed over comprehensiveness
- If you can't find something quickly, explain what you searched`;
        break;

      case 'medium':
        thoroughnessGuidelines = `**Important Guidelines:**
- You have READ-ONLY access - you cannot modify files
- **Time limit: ~5 minutes maximum** - System reminders will notify you of remaining time
- Be thorough but efficient with tool usage (aim for 5-10 tool calls)
- Always provide clear, structured summaries of findings
- Highlight key files, patterns, and architectural decisions
- If you can't find something, explain what you searched and what was missing`;
        break;

      case 'very thorough':
        thoroughnessGuidelines = `**Important Guidelines:**
- You have READ-ONLY access - you cannot modify files
- **Time limit: ~10 minutes maximum** - System reminders will notify you of remaining time
- Be comprehensive and meticulous (aim for 10-20 tool calls)
- Check multiple locations and consider various naming conventions
- Trace dependencies deeply and understand complete call chains
- Read extensively to build complete understanding
- Cross-reference findings across multiple files
- Investigate edge cases and alternative implementations
- Always provide detailed, structured summaries with extensive context
- Document all patterns, architectural decisions, and relationships found`;
        break;

      case 'uncapped':
      default:
        thoroughnessGuidelines = `**Important Guidelines:**
- You have READ-ONLY access - you cannot modify files
- **No time limit imposed** - Take the time needed to do a thorough job
- Be comprehensive and systematic with tool usage
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
    if (!this.currentPooledAgent) {
      logger.warn('[EXPLORE_TOOL] injectUserMessage called but no active pooled agent');
      return;
    }

    const agent = this.currentPooledAgent.agent;
    if (!agent) {
      logger.warn('[EXPLORE_TOOL] injectUserMessage called but pooled agent has no agent instance');
      return;
    }

    logger.debug('[EXPLORE_TOOL] Injecting user message into pooled agent:', this.currentPooledAgent.agentId);
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
