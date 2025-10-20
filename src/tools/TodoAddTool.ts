/**
 * TodoAddTool - Add tasks to session todo list
 *
 * Simple task addition with automatic ID generation and highlighting.
 * First incomplete task is automatically highlighted as NEXT.
 */

import { BaseTool } from './BaseTool.js';
import { ToolResult, FunctionDefinition } from '../types/index.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { ServiceRegistry } from '../services/ServiceRegistry.js';
import { TodoManager } from '../services/TodoManager.js';

export class TodoAddTool extends BaseTool {
  readonly name = 'todo_add';
  readonly description =
    "Add tasks to your todo list. Simple format: tasks=['Task 1', 'Task 2']. First incomplete task is auto-highlighted as NEXT.";
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
            tasks: {
              type: 'array',
              description: 'Array of task descriptions (strings)',
              items: {
                type: 'string',
              },
            },
          },
          required: ['tasks'],
        },
      },
    };
  }

  protected async executeImpl(args: any): Promise<ToolResult> {
    this.captureParams(args);

    const tasks = args.tasks;

    // Validate input
    if (!Array.isArray(tasks)) {
      return this.formatErrorResponse(
        'tasks parameter must be an array of strings',
        'validation_error'
      );
    }

    if (tasks.length === 0) {
      return this.formatErrorResponse('tasks array cannot be empty', 'validation_error');
    }

    // Validate all tasks are non-empty strings
    for (let i = 0; i < tasks.length; i++) {
      if (typeof tasks[i] !== 'string') {
        return this.formatErrorResponse(
          `Task ${i} must be a string, got ${typeof tasks[i]}`,
          'validation_error'
        );
      }

      if (!tasks[i].trim()) {
        return this.formatErrorResponse(`Task ${i} cannot be empty`, 'validation_error');
      }
    }

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

      // Add new tasks
      const newTodos = todoManager.addTodos(tasks);

      // Get merged list
      const mergedTodos = todoManager.getTodos();

      // Display the updated todo UI (if UI manager available)
      this.displayTodoUI(todoManager);

      const message = `Added ${newTodos.length} task(s) to todo list. Use todo_complete(index) to mark tasks as done.`;

      return this.formatSuccessResponse({
        content: message, // Human-readable output for LLM
        todos: mergedTodos,
        total_count: mergedTodos.length,
      });
    } catch (error) {
      return this.formatErrorResponse(
        `Error adding todos: ${error instanceof Error ? error.message : String(error)}`,
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

    if (result.total_count !== undefined) {
      lines.push(`Total tasks: ${result.total_count}`);
    }

    return lines.slice(0, maxLines);
  }
}
