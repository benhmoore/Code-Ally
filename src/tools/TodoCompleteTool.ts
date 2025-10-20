/**
 * TodoCompleteTool - Mark tasks as complete
 *
 * Simple index-based completion with automatic next-task highlighting.
 * Index 0 refers to the first incomplete task (NEXT).
 */

import { BaseTool } from './BaseTool.js';
import { ToolResult, FunctionDefinition } from '../types/index.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { ServiceRegistry } from '../services/ServiceRegistry.js';
import { TodoManager } from '../services/TodoManager.js';

export class TodoCompleteTool extends BaseTool {
  readonly name = 'todo_complete';
  readonly description =
    'Mark a task as complete by index (0 = first incomplete task). Active todos are shown in your context automatically.';
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
            index: {
              type: 'integer',
              description: 'Index of the task to complete (0-based, counting only incomplete tasks)',
            },
          },
          required: ['index'],
        },
      },
    };
  }

  protected async executeImpl(args: any): Promise<ToolResult> {
    this.captureParams(args);

    const index = args.index;

    // Validate input
    if (typeof index !== 'number') {
      return this.formatErrorResponse(
        `index must be an integer, got ${typeof index}`,
        'validation_error'
      );
    }

    if (index < 0) {
      return this.formatErrorResponse('index must be non-negative', 'validation_error');
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

      // Get existing todos
      const todos = todoManager.getTodos();

      if (todos.length === 0) {
        return this.formatErrorResponse(
          'No todos in list. Use todo_add to create tasks first.',
          'validation_error'
        );
      }

      // Get incomplete todos
      const incompleteTodos = todoManager.getIncompleteTodos();

      if (incompleteTodos.length === 0) {
        return this.formatErrorResponse(
          'All tasks are already completed!',
          'validation_error'
        );
      }

      if (index >= incompleteTodos.length) {
        return this.formatErrorResponse(
          `index ${index} is out of range. Only ${incompleteTodos.length} incomplete task(s) available.`,
          'validation_error'
        );
      }

      // Mark the task as complete
      const completedTodo = todoManager.completeTodoByIndex(index);

      if (!completedTodo) {
        return this.formatErrorResponse(
          'Failed to complete task at index ' + index,
          'system_error'
        );
      }

      // Display the updated todo UI
      this.displayTodoUI(todoManager);

      const message = `✓ Completed: ${completedTodo.task}`;

      return this.formatSuccessResponse({
        content: message, // Human-readable output for LLM
        todos: todoManager.getTodos(),
        completed_task: completedTodo.task,
      });
    } catch (error) {
      return this.formatErrorResponse(
        `Error completing todo: ${error instanceof Error ? error.message : String(error)}`,
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

    const remainingIncomplete = result.todos?.filter((t: any) => !t.completed).length;
    if (remainingIncomplete !== undefined) {
      lines.push(`Remaining: ${remainingIncomplete} task(s)`);
    }

    return lines.slice(0, maxLines);
  }
}
