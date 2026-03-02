/**
 * WritePlanTool - Write a plan file during plan mode
 *
 * Only available during plan mode. Writes markdown content to
 * .ally-plans/{name}.md and updates PlanModeManager with the plan content.
 */

import * as fs from 'fs';
import * as path from 'path';
import { BaseTool } from './BaseTool.js';
import { ToolResult, FunctionDefinition } from '../types/index.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { ServiceRegistry } from '../services/ServiceRegistry.js';
import { PlanModeManager } from '../services/PlanModeManager.js';
import { logger } from '../services/Logger.js';

export class WritePlanTool extends BaseTool {
  readonly name = 'write-plan';
  readonly description =
    'Write an implementation plan to a file during plan mode. Creates a markdown file in .ally-plans/ directory.';
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
          properties: {
            name: {
              type: 'string',
              description: 'Plan name slug (e.g., "add-auth", "refactor-api"). Used as filename.',
            },
            content: {
              type: 'string',
              description: 'Plan content in markdown format. Should include implementation steps, critical files, and considerations.',
            },
          },
          required: ['name', 'content'],
        },
      },
    };
  }

  protected async executeImpl(args: any): Promise<ToolResult> {
    const { name, content } = args;

    if (!name || typeof name !== 'string') {
      return {
        success: false,
        error: 'name parameter is required and must be a string',
        error_type: 'validation_error',
      };
    }

    if (!content || typeof content !== 'string') {
      return {
        success: false,
        error: 'content parameter is required and must be a string',
        error_type: 'validation_error',
      };
    }

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
        error: 'write-plan is only available during plan mode. Call enter-plan-mode first.',
        error_type: 'validation_error',
      };
    }

    // Sanitize name to create safe filename
    const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
    const plansDir = path.join(process.cwd(), '.ally-plans');
    const filePath = path.join(plansDir, `${safeName}.md`);

    try {
      // Create .ally-plans directory if it doesn't exist
      if (!fs.existsSync(plansDir)) {
        fs.mkdirSync(plansDir, { recursive: true });
      }

      // Write the plan file
      fs.writeFileSync(filePath, content, 'utf-8');

      // Update PlanModeManager with the plan
      planModeManager.setPlan(filePath, content);

      logger.debug(`[WritePlanTool] Plan written to ${filePath}`);

      return {
        success: true,
        error: '',
        content: `Plan written to ${filePath}. Call exit-plan-mode to present it for user approval.`,
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to write plan: ${error instanceof Error ? error.message : String(error)}`,
        error_type: 'file_error',
      };
    }
  }

  formatSubtext(args: Record<string, any>): string | null {
    return args.name ? `${args.name}.md` : null;
  }
}
