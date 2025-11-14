/**
 * TodoListTool - Display current todo list
 *
 * Read-only tool that displays all todos with their current status,
 * dependencies, and subtasks in a formatted, readable way.
 */

import { BaseTool } from './BaseTool.js';
import { ToolResult, FunctionDefinition } from '../types/index.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { ServiceRegistry } from '../services/ServiceRegistry.js';
import { TodoManager } from '../services/TodoManager.js';
import { formatError } from '../utils/errorUtils.js';

export class TodoListTool extends BaseTool {
  readonly name = 'todo-list';
  readonly description =
    'List all current todos with their status, dependencies, and subtasks. Use this to view the current todo list without modifying it.';
  readonly requiresConfirmation = false;
  readonly visibleInChat = true;

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
          required: [],
        },
      },
    };
  }

  protected async executeImpl(args: any): Promise<ToolResult> {
    this.captureParams(args);

    try {
      const registry = ServiceRegistry.getInstance();
      const todoManager = registry.get<TodoManager>('todo_manager');

      if (!todoManager) {
        return this.formatErrorResponse('TodoManager not available', 'system_error');
      }

      const todos = todoManager.getTodos();

      if (todos.length === 0) {
        return this.formatSuccessResponse({
          content: 'No todos in the list.',
          total_count: 0,
        });
      }

      // Use the TodoManager's formatting for consistency
      const todoSummary = todoManager.generateActiveContext();

      if (!todoSummary) {
        return this.formatSuccessResponse({
          content: 'No todos in the list.',
          total_count: 0,
        });
      }

      const incompleteTodos = todoManager.getIncompleteTodos();
      const completedTodos = todoManager.getCompletedTodos();

      return this.formatSuccessResponse({
        content: todoSummary,
        total_count: todos.length,
        incomplete_count: incompleteTodos.length,
        completed_count: completedTodos.length,
      });
    } catch (error) {
      return this.formatErrorResponse(
        `Error listing todos: ${formatError(error)}`,
        'system_error'
      );
    }
  }
}
