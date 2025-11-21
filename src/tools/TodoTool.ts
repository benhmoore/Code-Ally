/**
 * TodoTool - Unified stateless todo management
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

/**
 * Actions supported by the todo tool
 */
type TodoAction = 'set' | 'clear' | 'list';

/**
 * Todo item as provided by the agent (without ID)
 */
interface TodoInput {
  content: string;
  status: TodoStatus;
}

export class TodoTool extends BaseTool {
  readonly name = 'todo';
  readonly description =
    'Manage todo list. Use action=set to replace entire list, clear to remove all, list to show current todos.';
  readonly requiresConfirmation = false;
  readonly visibleInChat = true;
  readonly hideOutput = true; // Todo updates shown in status bar, not chat
  readonly breaksExploratoryStreak = false; // Task management, not productive work

  constructor(activityStream: ActivityStream) {
    super(activityStream);
  }

  /**
   * Get the function definition for LLM
   *
   * Defines a clean schema where:
   * - action='set' replaces the entire todo list with new state
   * - action='clear' removes all todos
   * - action='list' shows current todos
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
              enum: ['set', 'clear', 'list'],
              description:
                'Operation: set (replace todos), clear (remove all), list (show current)',
            },
            todos: {
              type: 'array',
              description: 'Complete list of todos (for action=set only)',
              items: {
                type: 'object',
                properties: {
                  content: {
                    type: 'string',
                    description: 'Task description',
                  },
                  status: {
                    type: 'string',
                    enum: ['pending', 'in_progress', 'completed'],
                    description: 'Status: pending|in_progress|completed',
                  },
                },
                required: ['content', 'status'],
              },
            },
          },
          required: ['action'],
        },
      },
    };
  }

  /**
   * Execute the todo tool
   *
   * Handles three actions:
   * - set: Replace entire todo list
   * - clear: Remove all todos
   * - list: Show current todos
   *
   * @param args - Tool arguments
   * @returns Tool result
   */
  protected async executeImpl(args: any): Promise<ToolResult> {
    this.captureParams(args);

    const action = args.action as TodoAction;

    // Validate action
    if (!action) {
      return this.formatErrorResponse(
        'action is required',
        'validation_error',
        'Specify action as "set", "clear", or "list"'
      );
    }

    if (!['set', 'clear', 'list'].includes(action)) {
      return this.formatErrorResponse(
        `Invalid action: ${action}`,
        'validation_error',
        'Action must be "set", "clear", or "list"'
      );
    }

    try {
      // Get TodoManager from registry
      const registry = ServiceRegistry.getInstance();
      const todoManager = registry.get<TodoManager>('todo_manager');

      if (!todoManager) {
        return this.formatErrorResponse('TodoManager not available', 'system_error');
      }

      // Dispatch to action handler
      switch (action) {
        case 'set':
          return await this.handleSet(args, todoManager);
        case 'clear':
          return await this.handleClear(todoManager);
        case 'list':
          return this.handleList(todoManager);
        default:
          return this.formatErrorResponse(
            `Unknown action: ${action}`,
            'validation_error'
          );
      }
    } catch (error) {
      return this.formatErrorResponse(
        `Error executing todo action: ${formatError(error)}`,
        'system_error'
      );
    }
  }

  /**
   * Handle action='set' - Replace entire todo list
   *
   * Validates the input todos, generates IDs, validates business rules,
   * then replaces the entire todo list with the new state.
   *
   * @param args - Tool arguments
   * @param todoManager - TodoManager instance
   * @returns Tool result
   */
  private async handleSet(args: any, todoManager: TodoManager): Promise<ToolResult> {
    const todos = args.todos;

    // Validate todos parameter
    if (!todos) {
      return this.formatErrorResponse(
        'todos is required for action=set',
        'validation_error',
        'Provide a todos array with the complete desired list'
      );
    }

    if (!Array.isArray(todos)) {
      return this.formatErrorResponse(
        'todos must be an array',
        'validation_error',
        'Provide todos as an array of {content, status} objects'
      );
    }

    // Validate each todo
    for (let i = 0; i < todos.length; i++) {
      const todo = todos[i];

      // Validate content
      if (!todo.content || typeof todo.content !== 'string') {
        return this.formatErrorResponse(
          `Todo ${i}: content is required and must be a string`,
          'validation_error'
        );
      }

      if (todo.content.trim().length === 0) {
        return this.formatErrorResponse(
          `Todo ${i}: content cannot be empty`,
          'validation_error'
        );
      }

      // Validate status
      if (!todo.status || typeof todo.status !== 'string') {
        return this.formatErrorResponse(
          `Todo ${i}: status is required and must be a string`,
          'validation_error'
        );
      }

      if (!['pending', 'in_progress', 'completed'].includes(todo.status)) {
        return this.formatErrorResponse(
          `Todo ${i}: status must be pending, in_progress, or completed (got: ${todo.status})`,
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
   * Handle action='clear' - Remove all todos
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

  /**
   * Handle action='list' - Show current todos
   *
   * Retrieves and formats the current todo list for display.
   *
   * @param todoManager - TodoManager instance
   * @returns Tool result
   */
  private handleList(todoManager: TodoManager): ToolResult {
    const todos = todoManager.getTodos();

    if (todos.length === 0) {
      return this.formatSuccessResponse({
        content: 'No todos in the list.',
        total_count: 0,
        todos: [],
      });
    }

    // Get formatted context
    const todoSummary = todoManager.generateActiveContext();
    const pendingCount = todos.filter(t => t.status === 'pending').length;
    const inProgressCount = todos.filter(t => t.status === 'in_progress').length;
    const completedCount = todos.filter(t => t.status === 'completed').length;
    const incompleteCount = pendingCount + inProgressCount;

    let message = `Current todos (${todos.length} total):\n\n`;
    message += todoSummary || '(empty)';
    message += `\n\nSummary: ${pendingCount} pending, ${inProgressCount} in progress, ${completedCount} completed.`;

    return this.formatSuccessResponse({
      content: message,
      total_count: todos.length,
      pending_count: pendingCount,
      in_progress_count: inProgressCount,
      completed_count: completedCount,
      incomplete_count: incompleteCount,
      todos: todos.map(t => ({
        id: t.id,
        content: t.task,
        status: t.status,
      })),
    });
  }
}
