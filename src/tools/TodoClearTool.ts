/**
 * TodoClearTool - Clear completed or all tasks
 *
 * Clears completed tasks by default, or all tasks if specified.
 */

import { BaseTool } from './BaseTool.js';
import { ToolResult, FunctionDefinition } from '../types/index.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { ServiceRegistry } from '../services/ServiceRegistry.js';
import { TodoManager } from '../services/TodoManager.js';

export class TodoClearTool extends BaseTool {
  readonly name = 'todo_clear';
  readonly description =
    'Clear completed tasks (default) or all tasks. Use all=True to clear everything.';
  readonly requiresConfirmation = false; // Non-destructive: in-memory todo list management

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
            all: {
              type: 'boolean',
              description: 'If true, clear all tasks; if false (default), only clear completed tasks',
            },
          },
        },
      },
    };
  }

  protected async executeImpl(args: any): Promise<ToolResult> {
    this.captureParams(args);

    const clearAll = args.all === true;

    try {
      // Get TodoManager from service registry
      const registry = ServiceRegistry.getInstance();
      const todoManager = registry.get<TodoManager>('todo_manager');

      if (!todoManager) {
        return this.formatErrorResponse(
          'TodoManager service not available',
          'system_error'
        );
      }

      // Get existing todos
      const todos = todoManager.getTodos();

      if (todos.length === 0) {
        return this.formatErrorResponse('No todos to clear', 'validation_error');
      }

      // Clear based on mode
      let clearedCount: number;
      let message: string;

      if (clearAll) {
        clearedCount = todoManager.clearTodos(true);
        message = `Cleared all ${clearedCount} task(s)`;
      } else {
        // Only clear completed tasks
        const completedCount = todoManager.getCompletedTodos().length;

        if (completedCount === 0) {
          return this.formatErrorResponse(
            'No completed tasks to clear',
            'validation_error'
          );
        }

        clearedCount = todoManager.clearTodos(false);
        message = `Cleared ${clearedCount} completed task(s)`;
      }

      // Get remaining todos
      const remainingTodos = todoManager.getTodos();

      // Display the updated todo UI
      this.displayTodoUI(todoManager);

      return this.formatSuccessResponse({
        content: message, // Human-readable output for LLM
        cleared_count: clearedCount,
        remaining_count: remainingTodos.length,
      });
    } catch (error) {
      return this.formatErrorResponse(
        `Error clearing todos: ${error instanceof Error ? error.message : String(error)}`,
        'system_error'
      );
    }
  }

  /**
   * Display todo UI using UI manager if available
   */
  private displayTodoUI(todoManager: TodoManager): void {
    try {
      const registry = ServiceRegistry.getInstance();
      const uiManager = registry.get<any>('ui_manager');

      if (uiManager && typeof uiManager.printContent === 'function') {
        const todoDisplay = todoManager.formatTodoUI();
        uiManager.printContent(`[cyan]→ Todo List[/]\n${todoDisplay}`);
      }
    } catch (error) {
      // Silently fail - UI display is not critical
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

    if (result.remaining_count !== undefined) {
      lines.push(`Remaining: ${result.remaining_count} task(s)`);
    }

    return lines.slice(0, maxLines);
  }
}
