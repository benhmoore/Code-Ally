/**
 * EnterPlanModeTool - Enters plan mode for structured read-only exploration
 *
 * When invoked, restricts the main agent to read-only tools for codebase
 * exploration before implementation. The agent can explore, ask clarifying
 * questions, and write a plan before presenting it for user approval.
 *
 * Only available to the main agent (not specialized agents).
 */

import { BaseTool } from './BaseTool.js';
import { ToolResult, FunctionDefinition } from '../types/index.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { ServiceRegistry } from '../services/ServiceRegistry.js';
import { PlanModeManager } from '../services/PlanModeManager.js';
import { ToolManager } from './ToolManager.js';
import { logger } from '../services/Logger.js';

export class EnterPlanModeTool extends BaseTool {
  readonly name = 'enter-plan-mode';
  readonly description =
    'Enter plan mode for structured read-only exploration before implementation. Restricts available tools to read-only operations until a plan is written and approved.';
  readonly requiresConfirmation = false;
  readonly hideOutput = true;
  readonly displayIcon = '◈';

  readonly usageGuidance = `**When to use enter-plan-mode (DEFAULT for planning):**
This is the primary way to plan. Use it when:
- The user asks you to plan, design, or think through an approach
- A non-trivial task needs structured planning before implementation
- Adding new features, multi-file changes, architectural decisions, or unclear requirements
In plan mode, you explore the codebase yourself with read-only tools, write your plan with write-plan, and present it for user approval with exit-plan-mode.
Skip for: Simple bug fixes, single-line changes, or tasks with very specific instructions.
Do NOT use the plan agent when the user asks you to plan — use enter-plan-mode instead.`;

  constructor(activityStream: ActivityStream) {
    super(activityStream);
  }

  getFunctionDefinition(): FunctionDefinition {
    return {
      type: 'function',
      function: {
        name: this.name,
        description: this.description,
        parameters: {
          type: 'object',
          properties: {},
        },
      },
    };
  }

  protected async executeImpl(_args: any): Promise<ToolResult> {
    const registry = ServiceRegistry.getInstance();
    const planModeManager = registry.get<PlanModeManager>('plan_mode_manager');

    if (!planModeManager) {
      return {
        success: false,
        error: 'PlanModeManager not available',
        error_type: 'system_error',
      };
    }

    if (planModeManager.isActive()) {
      return {
        success: false,
        error: 'Already in plan mode. Use write-plan to write your plan, then exit-plan-mode to present it for approval.',
        error_type: 'validation_error',
      };
    }

    // Enter plan mode
    planModeManager.enterPlanMode();

    // Invalidate tool definitions cache so next LLM call gets restricted tool set
    const toolManager = registry.get<ToolManager>('tool_manager');
    if (toolManager) {
      toolManager.clearDefinitionsCache();
    }

    logger.debug('[EnterPlanModeTool] Plan mode entered, tool definitions cache cleared');

    return {
      success: true,
      error: '',
      system_reminder: `**PLAN MODE ACTIVE**
You are in read-only plan mode. Only exploratory tools and write-plan are available.
- Explore the codebase to understand patterns and architecture
- Ask clarifying questions with ask-user-question
- Write your plan with write-plan when ready
- Call exit-plan-mode to present the plan for user approval
You CANNOT write, edit, or delete project files in this mode.`,
      system_reminder_persist: true,
    };
  }
}
