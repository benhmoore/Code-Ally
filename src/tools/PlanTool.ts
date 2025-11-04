/**
 * PlanTool - Implementation planning with contextual research
 *
 * Creates detailed implementation plans by researching existing patterns,
 * architecture, and conventions in the codebase. Can delegate to explore
 * agent for complex pattern analysis.
 *
 * Key differences from ExploreTool:
 * - Has access to explore tool for nested research
 * - Output format: structured implementation plan
 * - Purpose: prescriptive (how to implement) vs descriptive (what exists)
 */

import { BaseTool } from './BaseTool.js';
import { ToolResult, FunctionDefinition, ActivityEventType } from '../types/index.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { ServiceRegistry } from '../services/ServiceRegistry.js';
import { Agent, AgentConfig } from '../agent/Agent.js';
import { ModelClient } from '../llm/ModelClient.js';
import { logger } from '../services/Logger.js';
import { ToolManager } from './ToolManager.js';
import { TodoManager } from '../services/TodoManager.js';
import { formatError } from '../utils/errorUtils.js';
import { TEXT_LIMITS, FORMATTING } from '../config/constants.js';
import { AgentPoolService, PooledAgent } from '../services/AgentPoolService.js';

// Planning tools: read-only tools + explore for nested research + todo_add for proposals
const PLANNING_TOOLS = ['read', 'glob', 'grep', 'ls', 'tree', 'batch', 'explore', 'todo_add'];

// Hardcoded system prompt optimized for implementation planning
const PLANNING_SYSTEM_PROMPT = `You are an expert implementation planner. Your role is to create detailed, actionable implementation plans by researching existing patterns, understanding architecture, and considering all necessary context.

**Your Capabilities:**
- View directory tree structures (tree) - understand project organization
- Search for files and patterns (glob, grep) - find similar implementations
- Read and analyze file contents (read) - study existing patterns
- List directory contents (ls)
- Execute parallel operations for efficiency (batch)
- Delegate complex exploration tasks (explore) - for deep pattern analysis
- Create proposed todo lists (todo_add) - draft structured implementation tasks with dependencies and subtasks when helpful

**Your Planning Process:**
1. **Understand Requirements** - Parse the task, identify key components
2. **Assess Codebase State** - Determine what exists
   - Use tree() for structure overview
   - Check if this is an empty/new project or has existing code
   - Identify relevant files if they exist (glob/grep)
3. **Research Patterns (if applicable)** - Find similar implementations
   - If similar features exist: use explore() for complex pattern analysis, read() to study details
   - If empty/new project: Note this and plan based on best practices
4. **Analyze Architecture** - Understand context
   - **If existing code**: Identify conventions, patterns, file organization, code style
   - **If empty/new**: Recommend modern best practices for the language/framework
5. **Create Plan** - Produce detailed, actionable steps (grounded in patterns OR best practices)
6. **Create Proposed Todos** - Use todo_add() to draft implementation tasks with status="proposed"

**Your Output Format (REQUIRED):**

## Implementation Plan

### Context
[Summarize the codebase state and relevant information]
- **Codebase state**: [Empty/new project OR existing project with X files]
- **Key files** (if any): [list with paths, or "None - starting from scratch"]
- **Patterns to follow**: [Existing conventions OR recommended best practices]
- **Architecture notes**: [Relevant decisions OR recommended approach for new project]

### Implementation Steps
1. [Specific, actionable step with file references]
2. [Include code pattern examples where helpful]
3. [Reference specific files as templates: src/example.ts:123]
...

### Considerations
- **Testing**: [How to test - follow existing patterns OR recommend testing approach]
- **Error Handling**: [Follow existing patterns OR recommend error handling strategy]
- **Edge Cases**: [Important edge cases to handle]
- **Integration**: [How this integrates with existing code OR how to structure new project]

### Files to Modify/Create
- \`path/to/file.ts\` - [what changes]
- \`path/to/new.ts\` - [new file, purpose]

### Proposed Todos
After providing the plan above, call todo_add() with proposed todos (status="proposed"):
- Each todo: content (imperative like "Set up project"), status="proposed", activeForm (continuous like "Setting up project")
- **Use dependencies** when tasks must complete in order (specify array of todo IDs that must finish first)
- **Use subtasks** for hierarchical breakdown (nested array, max depth 1) when a task has clear sub-steps
- Order logically with dependencies enforcing critical sequences
- Make actionable and represent meaningful milestones

**Important Guidelines:**
- Be efficient in research (use 5-15 tool calls depending on codebase complexity)
- **For existing codebases**: Ground recommendations in existing patterns, provide file references
- **For empty/new projects**: Ground recommendations in modern best practices for the language/framework
- **Don't waste time searching for patterns that don't exist** - recognize empty projects quickly
- Provide specific file references with line numbers when applicable
- Include code examples from codebase when relevant (or from best practices if starting fresh)
- Use explore() for complex multi-file pattern analysis (skip if empty project)
- Ensure plan is complete but not over-engineered
- Focus on artful implementation that fits the existing architecture (or establishes good architecture)

**Handling Different Scenarios:**
- **Empty directory/new project**: Recommend project structure, tech stack, and modern conventions
- **Existing project, new feature**: Research similar features and follow existing patterns
- **Existing project, novel feature**: Blend existing patterns with new best practices

Create comprehensive, actionable plans that enable confident implementation.`;

export class PlanTool extends BaseTool {
  readonly name = 'plan';
  readonly description =
    'Create implementation plan by researching codebase patterns. Delegates to planning agent with read-only + explore access. Returns detailed, actionable plan grounded in existing architecture.';
  readonly requiresConfirmation = false; // Read-only operation
  readonly suppressExecutionAnimation = true; // Agent manages its own display
  readonly shouldCollapse = true; // Collapse after completion
  readonly hideOutput = true; // Hide detailed output

  readonly usageGuidance = `**When to use plan:**
New features, following existing patterns, comprehensive roadmap before coding.
Creates proposed todos as drafts; use deny_proposal if misaligned.`;

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
            requirements: {
              type: 'string',
              description: 'Task or feature requirements. Can be minimal - planning agent will research and fill in details.',
            },
            persist: {
              type: 'boolean',
              description: 'Whether to persist the agent for reuse. If true, returns agent_id for tracking. Set to false for one-time ephemeral agents. Default: true.',
            },
          },
          required: ['requirements'],
        },
      },
    };
  }

  protected async executeImpl(args: any): Promise<ToolResult> {
    this.captureParams(args);

    const requirements = args.requirements;
    const persist = args.persist ?? true;

    // Validate requirements parameter
    if (!requirements || typeof requirements !== 'string') {
      return this.formatErrorResponse(
        'requirements parameter is required and must be a string',
        'validation_error',
        'Example: plan(requirements="Add user authentication with JWT")'
      );
    }

    // Validate persist parameter
    if (persist !== undefined && typeof persist !== 'boolean') {
      return this.formatErrorResponse(
        'persist parameter must be a boolean',
        'validation_error',
        'Example: plan(requirements="...", persist=true)'
      );
    }

    // Execute planning - pass currentCallId to avoid race conditions
    const callId = this.currentCallId;
    if (!callId) {
      return this.formatErrorResponse(
        'Internal error: callId not set',
        'system_error'
      );
    }

    return await this.executePlanning(requirements, persist, callId);
  }

  /**
   * Execute planning with specialized agent
   *
   * @param requirements - The requirements for the implementation plan
   * @param persist - Whether to use AgentPoolService for agent persistence
   * @param callId - Unique call identifier for tracking
   */
  private async executePlanning(
    requirements: string,
    persist: boolean,
    callId: string
  ): Promise<ToolResult> {
    logger.debug('[PLAN_TOOL] Starting planning, callId:', callId, 'persist:', persist);
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
        throw new Error('PlanTool requires model_client to be registered');
      }
      if (!toolManager) {
        throw new Error('PlanTool requires tool_manager to be registered');
      }
      if (!configManager) {
        throw new Error('PlanTool requires config_manager to be registered');
      }
      if (!permissionManager) {
        throw new Error('PlanTool requires permission_manager to be registered');
      }

      const config = configManager.getConfig();
      if (!config) {
        throw new Error('ConfigManager.getConfig() returned null/undefined');
      }

      // Filter to planning tools (read-only + explore)
      logger.debug('[PLAN_TOOL] Filtering to planning tools:', PLANNING_TOOLS);
      const allowedToolNames = new Set(PLANNING_TOOLS);
      const allTools = toolManager.getAllTools();
      const filteredTools = allTools.filter(tool => allowedToolNames.has(tool.name));
      const filteredToolManager = new ToolManager(filteredTools, this.activityStream);
      logger.debug('[PLAN_TOOL] Filtered to', filteredTools.length, 'tools:', filteredTools.map(t => t.name).join(', '));

      // Create specialized system prompt
      const specializedPrompt = await this.createPlanningSystemPrompt(requirements);

      // Emit planning start event
      this.emitEvent({
        id: callId,
        type: ActivityEventType.AGENT_START,
        timestamp: Date.now(),
        data: {
          agentName: 'plan',
          taskPrompt: requirements,
        },
      });

      // Create agent configuration
      const agentConfig: AgentConfig = {
        isSpecializedAgent: true,
        allowTodoManagement: true, // Planning agent can create proposed todos
        verbose: false,
        systemPrompt: specializedPrompt,
        baseAgentPrompt: PLANNING_SYSTEM_PROMPT,
        taskPrompt: requirements,
        config: config,
        parentCallId: callId,
        requiredToolCalls: ['todo_add'], // Planning agent MUST call todo_add before exiting
      };

      // Choose between pooled or ephemeral agent
      let planningAgent: Agent;
      let pooledAgent: PooledAgent | null = null;
      let agentId: string | null = null;

      if (persist) {
        // Use AgentPoolService for persistent agent
        const agentPoolService = registry.get<AgentPoolService>('agent_pool');

        if (!agentPoolService) {
          // Graceful fallback: AgentPoolService not available
          logger.warn('[PLAN_TOOL] AgentPoolService not available, falling back to ephemeral agent');
          planningAgent = new Agent(
            mainModelClient,
            filteredToolManager,
            this.activityStream,
            agentConfig,
            configManager,
            permissionManager
          );
        } else {
          // Acquire agent from pool with filtered ToolManager
          logger.debug('[PLAN_TOOL] Acquiring agent from pool with filtered ToolManager');
          pooledAgent = await agentPoolService.acquire(agentConfig, filteredToolManager);
          planningAgent = pooledAgent.agent;
          agentId = pooledAgent.agentId;
          this.currentPooledAgent = pooledAgent; // Track for interjection routing
          logger.debug('[PLAN_TOOL] Acquired pooled agent:', agentId);
        }
      } else {
        // Create ephemeral agent
        logger.debug('[PLAN_TOOL] Creating ephemeral planning agent with parentCallId:', callId);
        planningAgent = new Agent(
          mainModelClient,
          filteredToolManager,
          this.activityStream,
          agentConfig,
          configManager,
          permissionManager
        );
      }

      // Track active delegation
      this.activeDelegations.set(callId, {
        agent: planningAgent,
        requirements,
        startTime: Date.now(),
      });

      try {
        // Execute planning
        logger.debug('[PLAN_TOOL] Sending task to planning agent...');
        const response = await planningAgent.sendMessage(`Create an implementation plan for: ${requirements}`);
        logger.debug('[PLAN_TOOL] Planning agent response received, length:', response?.length || 0);

        let finalResponse: string;

        // Ensure we have a substantial response
        if (!response || response.trim().length === 0) {
          logger.debug('[PLAN_TOOL] Empty response, extracting from conversation');
          finalResponse = this.extractSummaryFromConversation(planningAgent) ||
            'Planning completed but no plan was provided.';
        } else if (response.includes('[Request interrupted') || response.length < TEXT_LIMITS.AGENT_RESPONSE_MIN) {
          logger.debug('[PLAN_TOOL] Incomplete response, attempting to extract summary');
          const summary = this.extractSummaryFromConversation(planningAgent);
          finalResponse = (summary && summary.length > response.length) ? summary : response;
        } else {
          finalResponse = response;
        }

        const duration = (Date.now() - startTime) / 1000;

        // Emit planning end event
        this.emitEvent({
          id: callId,
          type: ActivityEventType.AGENT_END,
          timestamp: Date.now(),
          data: {
            agentName: 'plan',
            result: finalResponse,
            duration,
          },
        });

        // Auto-accept proposed todos
        await this.autoAcceptProposedTodos(registry);

        // Get current todo summary to include in result
        const currentTodoManager = registry.get<TodoManager>('todo_manager');
        const todoSummary = currentTodoManager?.generateActiveContext();
        let content = finalResponse + '\n\nIMPORTANT: The user CANNOT see this plan. You must share the plan, summarized or verbatim, with the user in your own response.';

        if (todoSummary) {
          content += `\n\nActivated todos:\n${todoSummary}`;
        }

        // Build response with optional agent_id
        const successResponse: Record<string, any> = {
          content,
          duration_seconds: Math.round(duration * Math.pow(10, FORMATTING.DURATION_DECIMAL_PLACES)) / Math.pow(10, FORMATTING.DURATION_DECIMAL_PLACES),
          system_reminder: `The plan has been automatically accepted and todos activated. If this plan doesn't align with user intent, use deny_proposal to reject it and explain why.`,
        };

        // Include agent_id if agent was persisted
        if (agentId) {
          successResponse.agent_id = agentId;
        }

        return this.formatSuccessResponse(successResponse);
      } finally {
        // Clean up delegation tracking
        logger.debug('[PLAN_TOOL] Cleaning up planning agent...');
        this.activeDelegations.delete(callId);

        // Only cleanup if not using pooled agent
        if (pooledAgent) {
          // Release agent back to pool
          logger.debug('[PLAN_TOOL] Releasing agent back to pool');
          pooledAgent.release();
          this.currentPooledAgent = null; // Clear tracked pooled agent
        } else {
          // Cleanup ephemeral agent
          await planningAgent.cleanup();
        }
      }
    } catch (error) {
      return this.formatErrorResponse(
        `Planning failed: ${formatError(error)}`,
        'execution_error'
      );
    }
  }

  /**
   * Create specialized system prompt for planning
   */
  private async createPlanningSystemPrompt(requirements: string): Promise<string> {
    logger.debug('[PLAN_TOOL] Creating planning system prompt');
    try {
      const { getAgentSystemPrompt } = await import('../prompts/systemMessages.js');
      const result = await getAgentSystemPrompt(PLANNING_SYSTEM_PROMPT, requirements);
      logger.debug('[PLAN_TOOL] System prompt created, length:', result?.length || 0);
      return result;
    } catch (error) {
      logger.debug('[PLAN_TOOL] ERROR creating system prompt:', error);
      throw error;
    }
  }

  /**
   * Extract summary from planning agent's conversation history
   */
  private extractSummaryFromConversation(agent: Agent): string | null {
    try {
      const messages = agent.getMessages();

      // Find all assistant messages
      const assistantMessages = messages
        .filter(msg => msg.role === 'assistant' && msg.content && msg.content.trim().length > 0)
        .map(msg => msg.content);

      if (assistantMessages.length === 0) {
        logger.debug('[PLAN_TOOL] No assistant messages found in conversation');
        return null;
      }

      // Combine recent messages if multiple exist
      if (assistantMessages.length > 1) {
        const recentMessages = assistantMessages.slice(-3);
        const summary = recentMessages.join('\n\n');
        logger.debug('[PLAN_TOOL] Extracted summary from', recentMessages.length, 'messages, length:', summary.length);
        return `Implementation plan:\n\n${summary}`;
      }

      // Single assistant message
      const summary = assistantMessages[0];
      if (summary) {
        logger.debug('[PLAN_TOOL] Using single assistant message as summary, length:', summary.length);
        return summary;
      }

      return null;
    } catch (error) {
      logger.debug('[PLAN_TOOL] Error extracting summary:', error);
      return null;
    }
  }

  /**
   * Interrupt all active planning sessions
   */
  interruptAll(): void {
    logger.debug('[PLAN_TOOL] Interrupting', this.activeDelegations.size, 'active planning sessions');
    for (const [callId, delegation] of this.activeDelegations.entries()) {
      const agent = delegation.agent;
      if (agent && typeof agent.interrupt === 'function') {
        logger.debug('[PLAN_TOOL] Interrupting planning:', callId);
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
      logger.warn('[PLAN_TOOL] injectUserMessage called but no active pooled agent');
      return;
    }

    const agent = this.currentPooledAgent.agent;
    if (!agent) {
      logger.warn('[PLAN_TOOL] injectUserMessage called but pooled agent has no agent instance');
      return;
    }

    logger.debug('[PLAN_TOOL] Injecting user message into pooled agent:', this.currentPooledAgent.agentId);
    agent.addUserInterjection(message);
    agent.interrupt('interjection');
  }

  /**
   * Auto-accept proposed todos by converting them from proposed → pending/in_progress
   * First todo becomes in_progress if no existing in_progress todo exists
   */
  private async autoAcceptProposedTodos(registry: ServiceRegistry): Promise<void> {
    try {
      // Get TodoManager to retrieve proposed todos
      const todoManager = registry.get<TodoManager>('todo_manager');
      if (!todoManager) {
        logger.debug('[PLAN_TOOL] TodoManager not found in registry, skipping auto-accept');
        return;
      }

      // Get all todos and filter for proposed ones
      const allTodos = todoManager.getTodos();
      const proposedTodos = allTodos.filter(todo => todo.status === 'proposed');
      const existingTodos = allTodos.filter(todo => todo.status !== 'proposed');

      // If no proposed todos, nothing to do
      if (proposedTodos.length === 0) {
        logger.debug('[PLAN_TOOL] No proposed todos found, skipping auto-accept');
        return;
      }

      // Check if there's already an in_progress todo (to avoid violating "at most ONE in_progress" rule)
      const hasExistingInProgress = existingTodos.some(todo => todo.status === 'in_progress');

      // Convert proposed todos to pending/in_progress
      // First todo becomes in_progress ONLY if no existing in_progress todo exists
      const activatedTodos = proposedTodos.map((todo, index) => {
        const newStatus = index === 0 && !hasExistingInProgress ? 'in_progress' : 'pending';
        return {
          ...todo,
          status: newStatus as 'in_progress' | 'pending',
        };
      });

      // Combine existing todos with newly activated todos
      const newTodoList = [...existingTodos, ...activatedTodos];

      // Update TodoManager with new todo list
      todoManager.setTodos(newTodoList);

      logger.debug('[PLAN_TOOL] Auto-accepted', proposedTodos.length, 'proposed todos. New total:', newTodoList.length);
      logger.debug('[PLAN_TOOL] First 3 activated todos:', activatedTodos.slice(0, 3).map(t => ({ task: t.task, status: t.status })));
    } catch (error) {
      logger.debug('[PLAN_TOOL] Error auto-accepting proposed todos:', error);
      // Don't throw - this is non-critical, plan can still succeed
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

    // Show duration if available
    if (result.duration_seconds !== undefined) {
      lines.push(`Planned in ${result.duration_seconds}s`);
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
