/**
 * ExitPlanModeTool - Exit plan mode and present plan for user approval
 *
 * Validates that a plan has been written, then requests user approval.
 * Blocks until the user approves, requests changes, or provides feedback.
 * On approval, restores full tool access for implementation.
 */

import { BaseTool } from './BaseTool.js';
import { ToolResult, FunctionDefinition } from '../types/index.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { ServiceRegistry } from '../services/ServiceRegistry.js';
import { PlanModeManager } from '../services/PlanModeManager.js';
import { ToolManager } from './ToolManager.js';
import { logger } from '../services/Logger.js';

export class ExitPlanModeTool extends BaseTool {
  readonly name = 'exit-plan-mode';
  readonly description =
    'Exit plan mode and present the plan for user approval. The user can approve, approve with context clearing, or provide feedback for revision.';
  readonly requiresConfirmation = false;
  readonly hideOutput = true;

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

    if (!planModeManager.isActive()) {
      return {
        success: false,
        error: 'Not in plan mode. Call enter-plan-mode first.',
        error_type: 'validation_error',
      };
    }

    if (!planModeManager.hasPlan()) {
      return {
        success: false,
        error: 'No plan has been written yet. Use write-plan to write your plan before exiting plan mode.',
        error_type: 'validation_error',
      };
    }

    try {
      // Request user approval (blocks until response)
      const response = await planModeManager.requestApproval();

      // Exit plan mode regardless of response
      planModeManager.exitPlanMode();

      // Invalidate tool definitions cache to restore full tool access
      const toolManager = registry.get<ToolManager>('tool_manager');
      if (toolManager) {
        toolManager.clearDefinitionsCache();
      }

      logger.debug(`[ExitPlanModeTool] Plan mode exited, approval: ${response.choice}`);

      switch (response.choice) {
        case 'approve':
          return {
            success: true,
            error: '',
            content: 'Plan approved. Proceed with implementation.',
            system_reminder: 'The user has approved your plan. Proceed with implementation following the plan you wrote.',
          };

        case 'approve_clear_context':
          return {
            success: true,
            error: '',
            content: 'Plan approved with context clearing. Proceed with implementation.',
            system_reminder: 'The user has approved your plan and requested context clearing. Proceed with implementation following the plan you wrote.',
            _requestCompaction: true,
          };

        case 'feedback':
          return {
            success: true,
            error: '',
            content: `User provided feedback on your plan:\n\n${response.feedback || '(no feedback text)'}`,
            system_reminder: `The user wants you to revise the plan based on their feedback: "${response.feedback || '(no feedback text)'}". You can enter plan mode again to make revisions.`,
          };

        default:
          return {
            success: true,
            error: '',
            content: 'Plan mode exited.',
          };
      }
    } catch (error) {
      // On error, still exit plan mode
      planModeManager.exitPlanMode();

      const toolManager = registry.get<ToolManager>('tool_manager');
      if (toolManager) {
        toolManager.clearDefinitionsCache();
      }

      return {
        success: false,
        error: `Plan approval failed: ${error instanceof Error ? error.message : String(error)}`,
        error_type: 'system_error',
      };
    }
  }
}
