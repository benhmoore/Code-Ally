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

import { BaseDelegationTool, DelegationToolConfig } from './BaseDelegationTool.js';
import { ToolResult, FunctionDefinition } from '../types/index.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { ServiceRegistry, ScopedServiceRegistryProxy } from '../services/ServiceRegistry.js';
import { TodoManager } from '../services/TodoManager.js';
import { REASONING_EFFORT, AGENT_TYPES, THOROUGHNESS_LEVELS, VALID_THOROUGHNESS } from '../config/constants.js';
import { createPlanAcceptedReminder } from '../utils/messageUtils.js';
import type { Config } from '../types/index.js';

// Planning tools: read-only tools + explore for nested research + TodoWrite for task creation + ask-user-question for clarification
const PLANNING_TOOLS = ['read', 'glob', 'grep', 'ls', 'tree', 'batch', 'explore', 'todo-write', 'ask-user-question'];

// Base prompt for planning (without thoroughness-specific guidelines)
const PLANNING_BASE_PROMPT = `You are an expert implementation planning assistant. READ-ONLY access plus todo-write - no code modifications.

## Process

1. **Clarify** - Use ask-user-question for ambiguous requirements or multiple valid approaches. Don't assume.
2. **Research** - Assess codebase state (empty vs existing), find similar implementations, identify patterns
3. **Plan** - Create actionable steps with absolute file paths and line numbers
4. **Create Todos** - MUST call todo-write() before completing

## Output Format

### Implementation Plan

#### Context
- **Codebase state**: [Empty/new OR existing with key files]
- **Patterns to follow**: [Existing conventions OR recommended best practices]

#### Implementation Steps
1. [Actionable step with file refs: /absolute/path/to/file.ts:123]
...

#### Considerations
- Testing, error handling, edge cases, integration points

#### Files to Modify/Create
- \`/absolute/path/to/file.ts\` - [what changes]

#### Task Breakdown
Call todo-write() with tasks in logical order. Each needs: content (imperative), status (pending/in_progress), activeForm (present continuous).

## Constraints

- All file paths MUST be absolute
- Use ask-user-question when you encounter ambiguity or trade-offs
- Use explore() for complex multi-file pattern analysis
- Recognize empty projects quickly - don't search for nonexistent patterns`;

export class PlanTool extends BaseDelegationTool {
  readonly name = 'plan';
  readonly description =
    'Create implementation plan by researching codebase patterns. Delegates to planning agent with read-only + explore access. Returns detailed, actionable plan grounded in existing architecture.';
  readonly requiresConfirmation = false; // Read-only operation
  readonly suppressExecutionAnimation = true; // Agent manages its own display
  readonly shouldCollapse = true; // Collapse after completion
  readonly hideOutput = false; // Agents never hide their own output

  readonly usageGuidance = `**When to use plan:**
Multi-step implementation/refactoring (>3 steps). Creates ordered task list.
Skip for: Quick fixes, continuing existing plans, simple changes.`;

  constructor(activityStream: ActivityStream) {
    super(activityStream);
  }

  /**
   * Get tool configuration
   */
  protected getConfig(): DelegationToolConfig {
    return {
      agentType: AGENT_TYPES.PLAN,
      allowedTools: PLANNING_TOOLS,
      modelConfigKey: 'plan_model',
      requiredToolCalls: ['todo-write'],
      reasoningEffort: REASONING_EFFORT.HIGH,
      allowTodoManagement: true,
      emptyResponseFallback: 'Planning completed but no plan was provided.',
      summaryLabel: 'Implementation plan:',
    };
  }

  /**
   * Get system prompt for planning agent
   */
  protected getSystemPrompt(_config: Config): string {
    return PLANNING_BASE_PROMPT;
  }

  /**
   * Extract task prompt from arguments
   */
  protected getTaskPromptFromArgs(args: any): string {
    return args.requirements;
  }

  /**
   * Format task message for planning
   */
  protected formatTaskMessage(taskPrompt: string): string {
    return `Create an implementation plan for: ${taskPrompt}`;
  }

  /**
   * Post-process response to include todo summary
   */
  protected async postProcessResponse(
    response: string,
    _config: DelegationToolConfig,
    registry: ServiceRegistry | ScopedServiceRegistryProxy
  ): Promise<string> {
    // Get current todo summary to include in result
    const currentTodoManager = registry.get<TodoManager>('todo_manager');
    const todoSummary = currentTodoManager?.generateActiveContext();

    if (todoSummary) {
      return response + `\n\nActivated todos:\n${todoSummary}`;
    }

    return response;
  }

  /**
   * Augment success response with plan accepted reminder
   */
  protected augmentSuccessResponse(
    successResponse: Record<string, any>,
    _config: DelegationToolConfig,
    agentId: string | null
  ): void {
    // Add plan accepted reminder (ephemeral - cleaned up after turn)
    const planAcceptedReminder = createPlanAcceptedReminder();

    if (agentId && successResponse.system_reminder) {
      // Append to existing system_reminder
      successResponse.system_reminder += '\n\n' + planAcceptedReminder.system_reminder;
      // Keep system_reminder_persist from agent persistence reminder (already ephemeral)
    } else {
      // No agent_id, just add plan accepted reminder
      Object.assign(successResponse, planAcceptedReminder);
    }
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
              description: 'Complete requirements: goals, constraints, affected files, and background.',
            },
            thoroughness: {
              type: 'string',
              description: '"quick", "medium", "very thorough", or "uncapped" (default)',
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
    const thoroughness = args.thoroughness ?? THOROUGHNESS_LEVELS.UNCAPPED;

    // Validate requirements parameter
    if (!requirements || typeof requirements !== 'string') {
      return this.formatErrorResponse(
        'requirements parameter is required and must be a string',
        'validation_error',
        'Example: plan(requirements="Add user authentication with JWT")'
      );
    }

    // Validate thoroughness parameter
    if (!VALID_THOROUGHNESS.includes(thoroughness)) {
      return this.formatErrorResponse(
        `thoroughness must be one of: ${VALID_THOROUGHNESS.join(', ')}`,
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

    return await this.executeDelegation(requirements, thoroughness, callId);
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
}
