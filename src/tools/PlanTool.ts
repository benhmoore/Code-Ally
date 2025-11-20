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
import { InjectableTool } from './InjectableTool.js';
import { ToolResult, FunctionDefinition, ActivityEventType } from '../types/index.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { ServiceRegistry } from '../services/ServiceRegistry.js';
import { Agent, AgentConfig } from '../agent/Agent.js';
import { ModelClient } from '../llm/ModelClient.js';
import { logger } from '../services/Logger.js';
import { ToolManager } from './ToolManager.js';
import { TodoManager } from '../services/TodoManager.js';
import { formatError } from '../utils/errorUtils.js';
import { TEXT_LIMITS, FORMATTING, REASONING_EFFORT } from '../config/constants.js';
import { AgentPoolService, PooledAgent } from '../services/AgentPoolService.js';
import { getThoroughnessDuration, getThoroughnessMaxTokens } from '../ui/utils/timeUtils.js';
import { createAgentPersistenceReminder, createPlanAcceptedReminder } from '../utils/messageUtils.js';

// Planning tools: read-only tools + explore for nested research + todo-add for proposals
const PLANNING_TOOLS = ['read', 'glob', 'grep', 'ls', 'tree', 'batch', 'explore', 'todo-add'];

// Base prompt for planning (without thoroughness-specific guidelines)
const PLANNING_BASE_PROMPT = `You are an expert implementation planning assistant. You excel at researching codebases to create detailed, actionable implementation plans grounded in existing patterns and architecture.

## Your Strengths

- Analyzing existing code patterns and architectural decisions
- Finding similar implementations to guide new development work
- Creating structured, actionable implementation plans with concrete steps
- Breaking down complex features into manageable tasks with dependencies
- Recommending best practices and modern conventions for new projects

## Tool Usage Guidelines

- Use Tree to understand project structure and organization
- Use Glob for broad file pattern matching to find similar implementations
- Use Grep for searching code patterns, conventions, and specific implementations
- Use Read to study specific files and understand implementation details in depth
- Use Explore to delegate complex multi-file pattern analysis and architectural investigations
- Use Batch to execute multiple searches in parallel for efficiency
- Use TodoAdd to create proposed implementation tasks with dependencies and subtasks
- Adapt your research depth based on the thoroughness level specified

## Planning Process

1. **Understand Requirements** - Parse the task, identify key components and scope
2. **Assess Codebase State** - Determine if this is an empty/new project or existing codebase
3. **Research Patterns** - Find similar implementations (or note if starting from scratch)
4. **Analyze Architecture** - Identify conventions, patterns, file organization, and code style
5. **Create Detailed Plan** - Produce actionable steps with specific file references
6. **Propose Todo List** - Create structured tasks with dependencies and subtasks

## Required Output Format

### Implementation Plan

#### Context
[Summarize the codebase state and relevant information]
- **Codebase state**: [Empty/new project OR existing project with X files]
- **Key files**: [List with absolute paths, or "None - starting from scratch"]
- **Patterns to follow**: [Existing conventions OR recommended best practices]
- **Architecture notes**: [Relevant decisions OR recommended approach for new project]

#### Implementation Steps
1. [Specific, actionable step with file references and line numbers]
2. [Include code pattern examples where helpful]
3. [Reference specific files as templates: /absolute/path/to/file.ts:123]
...

#### Considerations
- **Testing**: [How to test - follow existing patterns OR recommend testing approach]
- **Error Handling**: [Follow existing patterns OR recommend error handling strategy]
- **Edge Cases**: [Important edge cases to handle]
- **Integration**: [How this integrates with existing code OR how to structure new project]

#### Files to Modify/Create
- \`/absolute/path/to/file.ts\` - [what changes]
- \`/absolute/path/to/new.ts\` - [new file, purpose]

#### Proposed Todos
After providing the plan above, call todo-add() with proposed todos (status="proposed"):
- Each todo: content (imperative like "Set up project"), status="proposed", activeForm (continuous like "Setting up project")
- **Use dependencies** when tasks must complete in order (specify array of todo IDs that must finish first)
- **Use subtasks** for hierarchical breakdown (nested array, max depth 1) when a task has clear sub-steps
- Order logically with dependencies enforcing critical sequences
- Make actionable and represent meaningful milestones

## Core Objective

Create comprehensive, actionable implementation plans that enable confident development, grounded in existing patterns for existing codebases or modern best practices for new projects.

## Important Constraints

- You have READ-ONLY access plus todo-add - you cannot modify code files
- All file paths in your response MUST be absolute, NOT relative
- **For existing codebases**: Ground recommendations in actual patterns found via exploration
- **For new projects**: Ground recommendations in modern best practices for the language/framework
- **Don't waste time searching for patterns that don't exist** - recognize empty projects quickly
- Provide specific file references with line numbers when applicable
- Include code examples from codebase when relevant (or from best practices if starting fresh)
- Use explore() for complex multi-file pattern analysis (skip if empty project)
- **MUST call todo-add() before completing** - planning without todos is incomplete
- Avoid using emojis for clear communication`;

const PLANNING_CLOSING = `

**Handling Different Scenarios:**
- **Empty directory/new project**: Recommend project structure, tech stack, and modern conventions
- **Existing project, new feature**: Research similar features and follow existing patterns
- **Existing project, novel feature**: Blend existing patterns with new best practices

Create plans that are complete but not over-engineered, focusing on artful implementation.`;

// System prompt optimized for implementation planning
const PLANNING_SYSTEM_PROMPT = PLANNING_BASE_PROMPT + `

**Execution Guidelines:**
- Be efficient in research (use 5-15 tool calls depending on codebase complexity)
- Recognize project type quickly (empty vs existing) to avoid wasted searches
- For existing codebases: provide file references with line numbers
- For new projects: provide clear rationale for recommended approaches
- Use explore() for complex pattern analysis across multiple files
- Ensure plan is complete but not over-engineered
- Focus on implementation that fits existing architecture (or establishes good architecture)

` + PLANNING_CLOSING;

export class PlanTool extends BaseTool implements InjectableTool {
  readonly name = 'plan';
  readonly description =
    'Create implementation plan by researching codebase patterns. Delegates to planning agent with read-only + explore access. Returns detailed, actionable plan grounded in existing architecture.';
  readonly requiresConfirmation = false; // Read-only operation
  readonly suppressExecutionAnimation = true; // Agent manages its own display
  readonly shouldCollapse = true; // Collapse after completion
  readonly hideOutput = true; // Hide nested non-agent tool outputs (agent tools still shown)

  readonly usageGuidance = `**When to use plan:**
Implementation/refactoring with multiple steps (>3 steps), needs structured approach.
Creates proposed todos with dependencies and subtasks for systematic execution.
CRITICAL: Agent CANNOT see current conversation - include ALL context in requirements (goals, constraints, files involved).
Use deny-proposal if plan doesn't align with user intent.
Skip for: Quick fixes, continuing existing plans, simple changes.`;

  private activeDelegations: Map<string, any> = new Map();
  private _currentPooledAgent: PooledAgent | null = null;

  // InjectableTool interface properties
  get delegationState(): 'executing' | 'completing' | null {
    // Always null for PlanTool - delegation state is managed by DelegationContextManager
    return null;
  }

  get activeCallId(): string | null {
    // Always null for PlanTool - delegation tracking is done by DelegationContextManager
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
            requirements: {
              type: 'string',
              description: 'Complete requirements with ALL necessary context. Agent cannot see current conversation - include goals, constraints, affected files, and background. Can be high-level - planning agent will research details.',
            },
            thoroughness: {
              type: 'string',
              description: 'Planning thoroughness level: "quick" (~1 min, 5-10 tool calls), "medium" (~5 min, 10-15 tool calls), "very thorough" (~10 min, 15-20+ tool calls), "uncapped" (no time limit, default). Controls time budget and depth.',
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
    const thoroughness = args.thoroughness ?? 'uncapped';

    // Validate requirements parameter
    if (!requirements || typeof requirements !== 'string') {
      return this.formatErrorResponse(
        'requirements parameter is required and must be a string',
        'validation_error',
        'Example: plan(requirements="Add user authentication with JWT")'
      );
    }

    // Validate thoroughness parameter
    const validThoroughness = ['quick', 'medium', 'very thorough', 'uncapped'];
    if (!validThoroughness.includes(thoroughness)) {
      return this.formatErrorResponse(
        `thoroughness must be one of: ${validThoroughness.join(', ')}`,
        'validation_error',
        'Example: plan(requirements="...", thoroughness="uncapped")'
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

    return await this.executePlanning(requirements, thoroughness, callId);
  }

  /**
   * Execute planning with specialized agent
   *
   * Planning agents always persist in the agent pool for reuse.
   *
   * @param requirements - The requirements for the implementation plan
   * @param thoroughness - Planning thoroughness level (quick/medium/very thorough)
   * @param callId - Unique call identifier for tracking
   */
  private async executePlanning(
    requirements: string,
    thoroughness: string,
    callId: string
  ): Promise<ToolResult> {
    logger.debug('[PLAN_TOOL] Starting planning, callId:', callId, 'thoroughness:', thoroughness);
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

      // Determine target model
      const targetModel = config.plan_model || config.model;

      // Plan agent ALWAYS uses HIGH reasoning effort
      const resolvedReasoningEffort = REASONING_EFFORT.HIGH;
      logger.debug(`[PLAN_TOOL] Using hardcoded HIGH reasoning_effort: ${resolvedReasoningEffort}`);

      // Calculate max tokens based on thoroughness
      const maxTokens = getThoroughnessMaxTokens(thoroughness as any, config.max_tokens);
      logger.debug(`[PLAN_TOOL] Set maxTokens to ${maxTokens} for thoroughness: ${thoroughness}`);

      // Create appropriate model client
      let modelClient: ModelClient;

      // Use shared client only if model, reasoning_effort, AND max_tokens all match config
      if (targetModel === config.model && resolvedReasoningEffort === config.reasoning_effort && maxTokens === config.max_tokens) {
        // Use shared global client
        logger.debug(`[PLAN_TOOL] Using shared model client (model: ${targetModel}, reasoning_effort: ${resolvedReasoningEffort}, maxTokens: ${maxTokens})`);
        modelClient = mainModelClient;
      } else{
        // Plan specifies different model OR different reasoning_effort - create dedicated client
        logger.debug(`[PLAN_TOOL] Creating dedicated client (model: ${targetModel}, reasoning_effort: ${resolvedReasoningEffort})`);

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

      // Filter to planning tools (read-only + explore)
      logger.debug('[PLAN_TOOL] Filtering to planning tools:', PLANNING_TOOLS);
      const allowedToolNames = new Set(PLANNING_TOOLS);
      const allTools = toolManager.getAllTools();
      const filteredTools = allTools.filter(tool => allowedToolNames.has(tool.name));
      const filteredToolManager = new ToolManager(filteredTools, this.activityStream);
      logger.debug('[PLAN_TOOL] Filtered to', filteredTools.length, 'tools:', filteredTools.map(t => t.name).join(', '));

      // System prompt will be generated dynamically in sendMessage()

      // Map thoroughness to max duration
      const maxDuration = getThoroughnessDuration(thoroughness as any);

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

      // Get parent agent - the agent currently executing this tool
      const parentAgent = registry.get<any>('agent');

      // Calculate agent depth for nesting
      const currentDepth = parentAgent?.getAgentDepth?.() ?? 0;
      const newDepth = currentDepth + 1;

      // Create agent configuration with unique pool key per invocation
      // This ensures each plan() call gets its own persistent agent
      const agentConfig: AgentConfig = {
        isSpecializedAgent: true,
        allowTodoManagement: true, // Planning agent can create proposed todos
        verbose: false,
        baseAgentPrompt: PLANNING_SYSTEM_PROMPT,
        taskPrompt: requirements,
        config: config,
        parentCallId: callId,
        parentAgent: parentAgent, // Direct reference to parent agent
        _poolKey: `plan-${callId}`, // Unique key per invocation
        requiredToolCalls: ['todo-add'], // Planning agent MUST call todo-add before exiting
        maxDuration,
        thoroughness: thoroughness, // Store for dynamic regeneration
        agentType: 'plan',
        agentDepth: newDepth,
      };

      // Always use pooled agent for persistence
      let planningAgent: Agent;
      let pooledAgent: PooledAgent | null = null;
      let agentId: string | null = null;

      // Use AgentPoolService for persistent agent
      const agentPoolService = registry.get<AgentPoolService>('agent_pool');

      if (!agentPoolService) {
        // Graceful fallback: AgentPoolService not available
        logger.warn('[PLAN_TOOL] AgentPoolService not available, falling back to ephemeral agent');
        planningAgent = new Agent(
          modelClient,
          filteredToolManager,
          this.activityStream,
          agentConfig,
          configManager,
          permissionManager
        );
      } else {
        // Acquire agent from pool with filtered ToolManager
        logger.debug('[PLAN_TOOL] Acquiring agent from pool with filtered ToolManager');
        // Pass custom modelClient only if plan uses a different model than global
        const customModelClient = targetModel !== config.model ? modelClient : undefined;
        pooledAgent = await agentPoolService.acquire(agentConfig, filteredToolManager, customModelClient);
        planningAgent = pooledAgent.agent;
        agentId = pooledAgent.agentId;
        this._currentPooledAgent = pooledAgent; // Track for interjection routing

        // Register delegation with DelegationContextManager
        try {
          const serviceRegistry = ServiceRegistry.getInstance();
          const toolManager = serviceRegistry.get<any>('tool_manager');
          const delegationManager = toolManager?.getDelegationContextManager();
          if (delegationManager) {
            delegationManager.register(callId, 'plan', pooledAgent);
            logger.debug(`[PLAN_TOOL] Registered delegation: callId=${callId}`);
          }
        } catch (error) {
          // ServiceRegistry not available in tests - skip delegation registration
          logger.debug(`[PLAN_TOOL] Delegation registration skipped: ${error}`);
        }

        logger.debug('[PLAN_TOOL] Acquired pooled agent:', agentId);
      }

      // Track active delegation
      this.activeDelegations.set(callId, {
        agent: planningAgent,
        requirements,
        startTime: Date.now(),
      });

      // Update registry to point to sub-agent during its execution
      // This ensures nested tool calls (plan spawning other agents) get correct parent
      const previousAgent = registry.get<any>('agent');
      registry.registerInstance('agent', planningAgent);
      console.log(`[DEBUG-REGISTRY] Updated registry 'agent': ${(previousAgent as any)?.instanceId} → ${(planningAgent as any)?.instanceId}`);

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

        // Build response with agent_used
        // PERSIST: false - Ephemeral: One-time notification about plan activation
        // Cleaned up after turn since agent should acknowledge and move on
        const planAcceptedReminder = createPlanAcceptedReminder();
        const successResponse: Record<string, any> = {
          content,
          duration_seconds: Math.round(duration * Math.pow(10, FORMATTING.DURATION_DECIMAL_PLACES)) / Math.pow(10, FORMATTING.DURATION_DECIMAL_PLACES),
          agent_used: 'plan',
        };

        // Add plan accepted reminder (with explicit persistence flags)
        Object.assign(successResponse, planAcceptedReminder);

        // Always include agent_id when available (with explicit persistence flags)
        if (agentId) {
          successResponse.agent_id = agentId;
          // PERSIST: false - Ephemeral: Coaching about agent-ask for follow-ups
          // Cleaned up after turn since agent should integrate advice, not need constant reminding
          const agentReminder = createAgentPersistenceReminder(agentId);
          // Append agent-ask reminder text to existing system_reminder
          successResponse.system_reminder += '\n\n' + agentReminder.system_reminder;
          // Keep system_reminder_persist from plan accepted (ephemeral)
          // Both reminders are ephemeral, so persistence flag stays false
        }

        return this.formatSuccessResponse(successResponse);
      } finally {
        // Restore previous agent in registry
        registry.registerInstance('agent', previousAgent);
        console.log(`[DEBUG-REGISTRY] Restored registry 'agent': ${(planningAgent as any)?.instanceId} → ${(previousAgent as any)?.instanceId}`);

        // Clean up delegation tracking
        logger.debug('[PLAN_TOOL] Cleaning up planning agent...');
        this.activeDelegations.delete(callId);

        // Release agent back to pool or cleanup ephemeral agent
        if (pooledAgent) {
          // Release agent back to pool
          logger.debug('[PLAN_TOOL] Releasing agent back to pool');
          pooledAgent.release();

          // Transition delegation to completing state
          try {
            const serviceRegistry = ServiceRegistry.getInstance();
            const toolManager = serviceRegistry.get<any>('tool_manager');
            const delegationManager = toolManager?.getDelegationContextManager();
            if (delegationManager) {
              delegationManager.transitionToCompleting(callId);
              logger.debug(`[PLAN_TOOL] Transitioned delegation to completing: callId=${callId}`);
            }
          } catch (error) {
            logger.debug(`[PLAN_TOOL] Delegation transition skipped: ${error}`);
          }

          this._currentPooledAgent = null; // Clear tracked pooled agent
        } else {
          // Cleanup ephemeral agent (only if AgentPoolService was unavailable)
          await planningAgent.cleanup();

          // Transition delegation to completing state
          try {
            const serviceRegistry = ServiceRegistry.getInstance();
            const toolManager = serviceRegistry.get<any>('tool_manager');
            const delegationManager = toolManager?.getDelegationContextManager();
            if (delegationManager) {
              delegationManager.transitionToCompleting(callId);
              logger.debug(`[PLAN_TOOL] Transitioned delegation to completing: callId=${callId}`);
            }
          } catch (error) {
            logger.debug(`[PLAN_TOOL] Delegation transition skipped: ${error}`);
          }
        }
      }
    } catch (error) {
      return this.formatErrorResponse(
        `Planning failed: ${formatError(error)}`,
        'execution_error',
        undefined,
        { agent_used: 'plan' }
      );
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
    if (!this._currentPooledAgent) {
      logger.warn('[PLAN_TOOL] injectUserMessage called but no active pooled agent');
      return;
    }

    const agent = this._currentPooledAgent.agent;
    if (!agent) {
      logger.warn('[PLAN_TOOL] injectUserMessage called but pooled agent has no agent instance');
      return;
    }

    logger.debug('[PLAN_TOOL] Injecting user message into pooled agent:', this._currentPooledAgent.agentId);
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
   * Format subtext for display in UI
   * Shows full requirements (no truncation - displayed on separate indented lines)
   */
  formatSubtext(args: Record<string, any>): string | null {
    const requirements = args.requirements as string;

    if (!requirements) {
      return null;
    }

    return requirements;
  }

  /**
   * Get parameters shown in subtext
   * PlanTool shows both 'requirements' and 'description' in subtext
   */
  getSubtextParameters(): string[] {
    return ['requirements', 'description'];
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
