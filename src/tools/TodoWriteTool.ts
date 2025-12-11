/**
 * TodoWriteTool - Unified stateless todo management
 *
 * Provides a clean, stateless interface for managing todos where the agent
 * provides the complete desired todo list state in each call. This replaces
 * the previous 5 separate todo tools (add, update, remove, clear, list) with
 * a single elegant interface.
 *
 * Core principle: The agent always specifies the complete desired state of
 * the todo list. No incremental operations, no state tracking complexity.
 */

import { BaseTool } from './BaseTool.js';
import { ToolResult, FunctionDefinition } from '../types/index.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { ServiceRegistry } from '../services/ServiceRegistry.js';
import { TodoManager, TodoStatus } from '../services/TodoManager.js';
import { formatError } from '../utils/errorUtils.js';
import { autoSaveTodos } from '../utils/todoUtils.js';
import { UI_COLORS } from '../ui/constants/colors.js';

/**
 * Todo item as provided by the agent (without ID)
 */
interface TodoInput {
  content: string;
  status: TodoStatus;
  activeForm: string;
}

export class TodoWriteTool extends BaseTool {
  readonly name = 'todo-write';
  readonly description =
    'Manage todo list. Each todo must have: content (imperative task), status (pending/in_progress/completed), activeForm (present continuous). Example: [{content: "Fix bug", status: "pending", activeForm: "Fixing bug"}]. Empty array clears list.';
  readonly requiresConfirmation = false;
  readonly visibleInChat = true;
  readonly hideOutput = true; // Todo updates shown in status bar, not chat
  readonly breaksExploratoryStreak = false; // Task management, not productive work

  // Custom display
  readonly displayName = 'Update Todos';
  readonly displayColor = UI_COLORS.META;
  readonly displayIcon = '✎';

  constructor(activityStream: ActivityStream) {
    super(activityStream);
  }

  /**
   * Get the function definition for LLM
   *
   * Defines a clean schema where the todos array represents the complete desired state.
   * - Empty array [] clears all todos
   * - Non-empty array replaces entire todo list with provided todos
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
            todos: {
              type: 'array',
              description: 'Array of todo items representing complete desired state. Pass empty array [] to clear all todos. Each item must include all three fields: content, status, and activeForm.',
              items: {
                type: 'object',
                properties: {
                  content: {
                    type: 'string',
                    description: 'Task description in imperative form. Examples: "Fix authentication bug", "Write unit tests", "Deploy to staging". This is what appears in the todo list.',
                  },
                  status: {
                    type: 'string',
                    enum: ['pending', 'in_progress', 'completed'],
                    description: 'Current status of the task. Use "pending" for upcoming tasks, "in_progress" for active work (only ONE task should be in_progress at a time), "completed" for finished tasks.',
                  },
                  activeForm: {
                    type: 'string',
                    description: 'Present continuous form for progress display. Convert imperative to -ing form: "Fix bug" → "Fixing bug", "Write tests" → "Writing tests", "Deploy" → "Deploying". Shown in status bar during execution.',
                  },
                },
                required: ['content', 'status', 'activeForm'],
              },
            },
          },
          required: ['todos'],
        },
      },
    };
  }

  /**
   * Execute the todo tool
   *
   * Replaces the entire todo list with the provided todos.
   * - Empty array [] clears all todos
   * - Non-empty array replaces entire todo list
   *
   * @param args - Tool arguments containing todos array
   * @returns Tool result
   */
  protected async executeImpl(args: any): Promise<ToolResult> {
    this.captureParams(args);

    const todos = args.todos;

    // Validate todos parameter
    if (!todos) {
      return this.formatErrorResponse(
        'todos parameter is required',
        'validation_error',
        'Provide a todos array with the complete desired list (or empty array to clear)'
      );
    }

    if (!Array.isArray(todos)) {
      return this.formatErrorResponse(
        'todos must be an array',
        'validation_error',
        'Provide todos as an array of {content, status, activeForm} objects'
      );
    }

    try {
      // Get TodoManager from registry
      const registry = ServiceRegistry.getInstance();
      const todoManager = registry.get<TodoManager>('todo_manager');

      if (!todoManager) {
        return this.formatErrorResponse('TodoManager not available', 'system_error');
      }

      // Handle empty array (clear all todos)
      if (todos.length === 0) {
        return await this.handleClear(todoManager);
      }

      // Handle non-empty array (set todos)
      return await this.handleSet(todos, todoManager);
    } catch (error) {
      return this.formatErrorResponse(
        `Error executing TodoWrite: ${formatError(error)}`,
        'system_error'
      );
    }
  }

  /**
   * Handle todo list replacement
   *
   * Validates the input todos, generates IDs, validates business rules,
   * then replaces the entire todo list with the new state.
   *
   * @param todos - Array of todo items
   * @param todoManager - TodoManager instance
   * @returns Tool result
   */
  private async handleSet(todos: TodoInput[], todoManager: TodoManager): Promise<ToolResult> {
    // Validate each todo
    for (let i = 0; i < todos.length; i++) {
      const todo = todos[i];

      // Null check for TypeScript
      if (!todo) {
        return this.formatErrorResponse(
          `Task at index ${i} is null or undefined`,
          'validation_error'
        );
      }

      // Validate content
      if (!todo.content || typeof todo.content !== 'string') {
        return this.formatErrorResponse(
          `Task "${todo.content || '(empty)'}": content is required and must be a string`,
          'validation_error'
        );
      }

      if (todo.content.trim().length === 0) {
        return this.formatErrorResponse(
          `Task at index ${i}: content cannot be empty`,
          'validation_error'
        );
      }

      // Validate status
      if (!todo.status || typeof todo.status !== 'string') {
        return this.formatErrorResponse(
          `Task "${todo.content}": status is required and must be a string`,
          'validation_error'
        );
      }

      if (!['pending', 'in_progress', 'completed'].includes(todo.status)) {
        return this.formatErrorResponse(
          `Task "${todo.content}": status must be pending, in_progress, or completed (got: ${todo.status})`,
          'validation_error'
        );
      }

      // Validate activeForm
      if (!todo.activeForm || typeof todo.activeForm !== 'string') {
        return this.formatErrorResponse(
          `Task "${todo.content}": activeForm is required and must be a string`,
          'validation_error'
        );
      }

      if (todo.activeForm.trim().length === 0) {
        return this.formatErrorResponse(
          `Task "${todo.content}": activeForm cannot be empty`,
          'validation_error'
        );
      }
    }

    // Generate IDs for todos (agent doesn't provide IDs)
    const todoItems = todos.map((todo: TodoInput) =>
      todoManager.createTodoItem(todo.content, todo.status)
    );

    // Validate business rules (e.g., at most one in_progress)
    const validationError = todoManager.validateAllRules(todoItems);
    if (validationError) {
      return this.formatErrorResponse(validationError, 'validation_error');
    }

    // Replace the todo list
    todoManager.setTodos(todoItems);

    // Auto-save to session
    await autoSaveTodos(todoItems);

    // Build response message
    const pendingCount = todoItems.filter(t => t.status === 'pending').length;
    const inProgressCount = todoItems.filter(t => t.status === 'in_progress').length;
    const completedCount = todoItems.filter(t => t.status === 'completed').length;
    const totalCount = todoItems.length;
    const incompleteCount = pendingCount + inProgressCount;

    let message = `Set ${totalCount} todo(s): ${pendingCount} pending, ${inProgressCount} in progress, ${completedCount} completed.`;

    if (incompleteCount === 0 && totalCount > 0) {
      message +=
        '\n\n✓ All todos completed! Next steps:\n  1. Add more todos if there\'s more work, OR\n  2. End your turn and respond to the user';
    } else if (incompleteCount > 0) {
      const inProgressTodo = todoManager.getInProgressTodo();
      if (inProgressTodo) {
        message += `\n\n→ Currently working on: "${inProgressTodo.task}"`;
      } else {
        const nextTodo = todoManager.getNextPendingTodo();
        if (nextTodo) {
          message += `\n\n→ Next task: "${nextTodo.task}"`;
        }
      }
    }

    // Include current todos summary
    const todoSummary = todoManager.generateActiveContext();
    if (todoSummary) {
      message += `\n\n${todoSummary}`;
    }

    return this.formatSuccessResponse({
      content: message,
      total_count: totalCount,
      pending_count: pendingCount,
      in_progress_count: inProgressCount,
      completed_count: completedCount,
      incomplete_count: incompleteCount,
    });
  }

  /**
   * Handle clearing all todos
   *
   * Clears the entire todo list and saves the empty state.
   *
   * @param todoManager - TodoManager instance
   * @returns Tool result
   */
  private async handleClear(todoManager: TodoManager): Promise<ToolResult> {
    const clearedCount = todoManager.clearTodos(true);

    // Auto-save empty list to session
    await autoSaveTodos([]);

    const message =
      clearedCount === 0
        ? 'Todo list is already empty.'
        : `Cleared ${clearedCount} todo(s). List is now empty.`;

    return this.formatSuccessResponse({
      content: message,
      cleared_count: clearedCount,
    });
  }
}
