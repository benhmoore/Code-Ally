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
import { ServiceRegistry } from '../services/ServiceRegistry.js';
import { TodoManager } from '../services/TodoManager.js';
import { REASONING_EFFORT, AGENT_TYPES, THOROUGHNESS_LEVELS, VALID_THOROUGHNESS } from '../config/constants.js';
import { createPlanAcceptedReminder } from '../utils/messageUtils.js';
import type { Config } from '../types/index.js';

// Planning tools: read-only tools + explore for nested research + TodoWrite for task creation
const PLANNING_TOOLS = ['read', 'glob', 'grep', 'ls', 'tree', 'batch', 'explore', 'todo-write'];

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
- Use todo-write to create implementation tasks in logical order
- Adapt your research depth based on the thoroughness level specified

## Planning Process

1. **Understand Requirements** - Parse the task, identify key components and scope
2. **Assess Codebase State** - Determine if this is an empty/new project or existing codebase
3. **Research Patterns** - Find similar implementations (or note if starting from scratch)
4. **Analyze Architecture** - Identify conventions, patterns, file organization, and code style
5. **Create Detailed Plan** - Produce actionable steps with specific file references
6. **Create Todo List** - Break down plan into ordered tasks

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

#### Task Breakdown
After providing the plan above, call todo-write() to create implementation tasks:
- Each todo needs: content (imperative like "Set up project"), status (pending or in_progress), activeForm (present continuous like "Setting up project")
- Create tasks in logical order - first task will be in_progress, rest pending
- Make each task actionable and represent meaningful milestones
- Tasks should follow the implementation sequence outlined in your plan

## Core Objective

Create comprehensive, actionable implementation plans that enable confident development, grounded in existing patterns for existing codebases or modern best practices for new projects.

## Important Constraints

- You have READ-ONLY access plus todo - you cannot modify code files
- All file paths in your response MUST be absolute, NOT relative
- **For existing codebases**: Ground recommendations in actual patterns found via exploration
- **For new projects**: Ground recommendations in modern best practices for the language/framework
- **Don't waste time searching for patterns that don't exist** - recognize empty projects quickly
- Provide specific file references with line numbers when applicable
- Include code examples from codebase when relevant (or from best practices if starting fresh)
- Use explore() for complex multi-file pattern analysis (skip if empty project)
- **MUST call todo-write() before completing** - planning without todos is incomplete
- Avoid using emojis for clear communication

**Handling Different Scenarios:**
- **Empty directory/new project**: Recommend project structure, tech stack, and modern conventions
- **Existing project, new feature**: Research similar features and follow existing patterns
- **Existing project, novel feature**: Blend existing patterns with new best practices

Create plans that are complete but not over-engineered, focusing on artful implementation.

Remember: You MUST call todo-write() before completing to create implementation tasks.

**Execution Guidelines:**
- Be efficient in research (use 5-15 tool calls depending on codebase complexity)
- Recognize project type quickly (empty vs existing) to avoid wasted searches
- For existing codebases: provide file references with line numbers
- For new projects: provide clear rationale for recommended approaches
- Use explore() for complex pattern analysis across multiple files
- Ensure plan is complete but not over-engineered
- Focus on implementation that fits existing architecture (or establishes good architecture)`;

export class PlanTool extends BaseDelegationTool {
  readonly name = 'plan';
  readonly description =
    'Create implementation plan by researching codebase patterns. Delegates to planning agent with read-only + explore access. Returns detailed, actionable plan grounded in existing architecture.';
  readonly requiresConfirmation = false; // Read-only operation
  readonly suppressExecutionAnimation = true; // Agent manages its own display
  readonly shouldCollapse = true; // Collapse after completion
  readonly hideOutput = false; // Agents never hide their own output

  readonly usageGuidance = `**When to use plan:**
Implementation/refactoring with multiple steps (>3 steps), needs structured approach.
Creates ordered task list for systematic execution.
CRITICAL: Agent CANNOT see current conversation - include ALL context in requirements (goals, constraints, files involved).
Agent has NO internet access - only local codebase research.
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
    registry: ServiceRegistry
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
