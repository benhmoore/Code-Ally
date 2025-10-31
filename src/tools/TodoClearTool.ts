/**
 * TodoClearTool - Clear all todos
 */

import { BaseTool } from './BaseTool.js';
import { ToolResult, FunctionDefinition } from '../types/index.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { ServiceRegistry } from '../services/ServiceRegistry.js';
import { TodoManager } from '../services/TodoManager.js';
import { formatError } from '../utils/errorUtils.js';
import { autoSaveTodos } from '../utils/todoUtils.js';

export class TodoClearTool extends BaseTool {
  readonly name = 'todo_clear';
  readonly description =
    'Clear all todos. Use when starting fresh or when all work is complete and you want to clean up.';
  readonly requiresConfirmation = false;
  readonly visibleInChat = false;

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

      const previousCount = todoManager.getTodos().length;
      todoManager.setTodos([]);

      // Auto-save
      await autoSaveTodos([]);

      return this.formatSuccessResponse({
        content: `Cleared ${previousCount} todo(s)`,
        cleared_count: previousCount,
      });
    } catch (error) {
      return this.formatErrorResponse(
        `Error clearing todos: ${formatError(error)}`,
        'system_error'
      );
    }
  }
}
