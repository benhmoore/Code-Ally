/**
 * FocusManagerTool - Set or clear directory focus restriction
 *
 * Restricts file operations to a specific directory when focus is set.
 * Integrates with FocusManager service and PathResolver.
 */

import { BaseTool } from './BaseTool.js';
import { ToolResult, FunctionDefinition } from '../types/index.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { ServiceRegistry } from '../services/ServiceRegistry.js';
import { FocusManager } from '../services/FocusManager.js';

export class FocusManagerTool extends BaseTool {
  readonly name = 'focus';
  readonly description =
    'Set or clear directory focus restriction. When focus is active, file operations are restricted to the focused directory tree.';
  readonly requiresConfirmation = false; // Non-destructive: state management only

  constructor(activityStream: ActivityStream) {
    super(activityStream);
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
            action: {
              type: 'string',
              description: 'Action to perform: "set", "clear", or "show"',
            },
            path: {
              type: 'string',
              description: 'Directory path (required for "set" action, relative to cwd)',
            },
          },
          required: ['action'],
        },
      },
    };
  }

  protected async executeImpl(args: any): Promise<ToolResult> {
    this.captureParams(args);

    const action = args.action as string;
    const path = args.path as string | undefined;

    // Validate action
    if (!action) {
      return this.formatErrorResponse(
        'action parameter is required',
        'validation_error',
        'Valid actions: "set", "clear", "show"'
      );
    }

    const validActions = ['set', 'clear', 'show'];
    if (!validActions.includes(action)) {
      return this.formatErrorResponse(
        `Invalid action: ${action}`,
        'validation_error',
        `Valid actions: ${validActions.join(', ')}`
      );
    }

    try {
      // Get FocusManager from service registry
      const registry = ServiceRegistry.getInstance();
      const focusManager = registry.get<FocusManager>('focus_manager');

      if (!focusManager) {
        return this.formatErrorResponse(
          'FocusManager service not available',
          'system_error'
        );
      }

      // Handle different actions
      switch (action) {
        case 'set':
          return await this.handleSetAction(focusManager, path);

        case 'clear':
          return this.handleClearAction(focusManager);

        case 'show':
          return this.handleShowAction(focusManager);

        default:
          return this.formatErrorResponse(
            `Unknown action: ${action}`,
            'validation_error'
          );
      }
    } catch (error) {
      return this.formatErrorResponse(
        `Error executing focus action: ${error instanceof Error ? error.message : String(error)}`,
        'system_error'
      );
    }
  }

  /**
   * Handle "set" action
   */
  private async handleSetAction(
    focusManager: FocusManager,
    path: string | undefined
  ): Promise<ToolResult> {
    if (!path) {
      return this.formatErrorResponse(
        'path parameter is required for "set" action',
        'validation_error',
        'Example: focus(action="set", path="src")'
      );
    }

    const result = await focusManager.setFocus(path);

    if (result.success) {
      // Update UI status line if available
      this.updateStatusLine(focusManager);

      return this.formatSuccessResponse({
        content: result.message, // Human-readable output for LLM
        action: 'set',
        focus_path: focusManager.getFocusDisplay(),
      });
    } else {
      return this.formatErrorResponse(result.message, 'validation_error');
    }
  }

  /**
   * Handle "clear" action
   */
  private handleClearAction(focusManager: FocusManager): ToolResult {
    const result = focusManager.clearFocus();

    if (result.success) {
      // Update UI status line if available
      this.updateStatusLine(focusManager);

      return this.formatSuccessResponse({
        content: result.message, // Human-readable output for LLM
        action: 'clear',
      });
    } else {
      return this.formatErrorResponse(result.message, 'validation_error');
    }
  }

  /**
   * Handle "show" action
   */
  private handleShowAction(focusManager: FocusManager): ToolResult {
    const focusPath = focusManager.getFocusDisplay();

    if (focusPath === null) {
      return this.formatSuccessResponse({
        content: 'No focus is currently set. All directories are accessible.', // Human-readable output for LLM
        action: 'show',
        focused: false,
      });
    } else {
      return this.formatSuccessResponse({
        content: `Currently focused on: ${focusPath}`, // Human-readable output for LLM
        action: 'show',
        focused: true,
        focus_path: focusPath,
      });
    }
  }

  /**
   * Update UI status line if available
   */
  private updateStatusLine(focusManager: FocusManager): void {
    try {
      const registry = ServiceRegistry.getInstance();
      const uiManager = registry.get<any>('ui_manager');

      if (uiManager && typeof uiManager.updateStatusLine === 'function') {
        const statusText = focusManager.getStatusLineText();
        uiManager.updateStatusLine(statusText);
      }
    } catch (error) {
      // Silently fail - UI update is not critical
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

    if (result.message) {
      lines.push(result.message);
    }

    if (result.action === 'set' && result.focus_path) {
      lines.push(`Focus: ${result.focus_path}/`);
    } else if (result.action === 'clear') {
      lines.push('All directories accessible');
    }

    return lines.slice(0, maxLines);
  }
}
