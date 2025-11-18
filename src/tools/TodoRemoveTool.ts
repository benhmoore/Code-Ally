/**
 * TodoRemoveTool - Remove specific todos from the list
 */

import { BaseTool } from './BaseTool.js';
import { ToolResult, FunctionDefinition } from '../types/index.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { ServiceRegistry } from '../services/ServiceRegistry.js';
import { TodoManager } from '../services/TodoManager.js';
import { formatError } from '../utils/errorUtils.js';
import { autoSaveTodos } from '../utils/todoUtils.js';

export class TodoRemoveTool extends BaseTool {
  readonly name = 'todo-remove';
  readonly description =
    'Remove specific todos from the list by id or content matching. Use when cleaning up completed tasks or removing no-longer-relevant todos.';
  readonly requiresConfirmation = false;
  readonly visibleInChat = false;
  readonly breaksExploratoryStreak = false; // Task management, not productive work

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
            identifiers: {
              type: 'array',
              description: 'Array of todo IDs or content strings to match and remove',
              items: {
                type: 'string',
              },
            },
          },
          required: ['identifiers'],
        },
      },
    };
  }

  protected async executeImpl(args: any): Promise<ToolResult> {
    this.captureParams(args);

    const identifiers = args.identifiers;

    if (!Array.isArray(identifiers)) {
      return this.formatErrorResponse('identifiers must be an array', 'validation_error');
    }

    if (identifiers.length === 0) {
      return this.formatErrorResponse('identifiers array cannot be empty', 'validation_error');
    }

    try {
      const registry = ServiceRegistry.getInstance();
      const todoManager = registry.get<TodoManager>('todo_manager');

      if (!todoManager) {
        return this.formatErrorResponse('TodoManager not available', 'system_error');
      }

      const currentTodos = todoManager.getTodos();
      const removedItems: string[] = [];

      // Filter out matching todos
      let remainingTodos = currentTodos.filter(todo => {
        const matchesId = identifiers.includes(todo.id);
        const matchesContent = identifiers.some(id =>
          todo.task.toLowerCase().includes(id.toLowerCase())
        );

        if (matchesId || matchesContent) {
          removedItems.push(todo.task);
          return false;
        }
        return true;
      });

      if (removedItems.length === 0) {
        return this.formatErrorResponse(
          `No matching todos found for: ${identifiers.join(', ')}`,
          'validation_error'
        );
      }

      // Auto-clean broken dependencies (remove references to deleted todos)
      const removedIds = new Set(
        currentTodos.filter(t => removedItems.includes(t.task)).map(t => t.id)
      );
      const cleanedWarnings: string[] = [];

      remainingTodos = remainingTodos.map(todo => {
        if (todo.dependencies) {
          const cleaned = todo.dependencies.filter(depId => !removedIds.has(depId));
          if (cleaned.length !== todo.dependencies.length) {
            cleanedWarnings.push(todo.task);
          }
          return { ...todo, dependencies: cleaned.length > 0 ? cleaned : undefined };
        }
        return todo;
      });

      // Validate all rules
      const validationError = todoManager.validateAllRules(remainingTodos);
      if (validationError) {
        return this.formatErrorResponse(validationError, 'validation_error');
      }

      // Write remaining todos
      todoManager.setTodos(remainingTodos);

      // Auto-save
      await autoSaveTodos(remainingTodos);

      const incompleteTodos = todoManager.getIncompleteTodos();
      const message = `Removed ${removedItems.length} todo(s):\n${removedItems.map(item => `  - ${item}`).join('\n')}\n\n${incompleteTodos.length} task(s) remaining.`;

      return this.formatSuccessResponse({
        content: message,
        removed_count: removedItems.length,
        total_count: remainingTodos.length,
        incomplete_count: incompleteTodos.length,
      });
    } catch (error) {
      return this.formatErrorResponse(
        `Error removing todos: ${formatError(error)}`,
        'system_error'
      );
    }
  }
}
