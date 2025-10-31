/**
 * TodoUpdateTool - Update specific todos without replacing entire list
 *
 * Safely marks todos as completed or updates their status by reading current
 * state from TodoManager. Prevents race conditions where stale state overwrites
 * recent changes (e.g., after confirm_proposal).
 */

import { BaseTool } from './BaseTool.js';
import { ToolResult, FunctionDefinition } from '../types/index.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { ServiceRegistry } from '../services/ServiceRegistry.js';
import { TodoManager, TodoStatus } from '../services/TodoManager.js';
import { formatError } from '../utils/errorUtils.js';
import { autoSaveTodos } from '../utils/todoUtils.js';

export class TodoUpdateTool extends BaseTool {
  readonly name = 'todo_update';
  readonly description =
    'Update status of specific todos. Safely marks todos as completed or changes their status by finding them by id or content. Use when you need to update a few todos, especially after other tools have modified the todo list (e.g., after confirm_proposal). This prevents accidentally overwriting recent changes.';
  readonly requiresConfirmation = false;
  readonly visibleInChat = false;
  readonly requiresTodoId = false; // Todo management tools don't need todo_id

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
            updates: {
              type: 'array',
              description: 'Array of todo updates. Each update identifies a todo by id or content and specifies the new status.',
              items: {
                type: 'object',
                properties: {
                  id: {
                    type: 'string',
                    description: 'Todo ID (preferred for exact matching)',
                  },
                  content: {
                    type: 'string',
                    description: 'Todo content to match (used if id not provided)',
                  },
                  status: {
                    type: 'string',
                    description: 'New status for the todo: pending, in_progress, or completed',
                  },
                },
                required: ['status'],
              },
            },
          },
          required: ['updates'],
        },
      },
    };
  }

  protected async executeImpl(args: any): Promise<ToolResult> {
    this.captureParams(args);

    const updates = args.updates;

    if (!Array.isArray(updates)) {
      return this.formatErrorResponse('updates must be an array', 'validation_error');
    }

    if (updates.length === 0) {
      return this.formatErrorResponse('updates array cannot be empty', 'validation_error');
    }

    // Validate each update
    for (let i = 0; i < updates.length; i++) {
      const update = updates[i];
      if (!update.id && !update.content) {
        return this.formatErrorResponse(
          `Update ${i}: must provide either id or content to identify the todo`,
          'validation_error'
        );
      }
      if (!update.status || !['pending', 'in_progress', 'completed'].includes(update.status)) {
        return this.formatErrorResponse(
          `Update ${i}: status must be pending, in_progress, or completed`,
          'validation_error'
        );
      }
    }

    try {
      const registry = ServiceRegistry.getInstance();
      const todoManager = registry.get<TodoManager>('todo_manager');

      if (!todoManager) {
        return this.formatErrorResponse('TodoManager not available', 'system_error');
      }

      // Read CURRENT state from TodoManager (not a snapshot)
      const currentTodos = todoManager.getTodos();
      const updatedTodos = [...currentTodos];
      const updatedItems: string[] = [];
      const notFoundItems: string[] = [];

      // Apply each update
      for (const update of updates) {
        let foundIndex = -1;

        // Find by ID first (exact match)
        if (update.id) {
          foundIndex = updatedTodos.findIndex(t => t.id === update.id);
        }

        // Fall back to content matching
        if (foundIndex === -1 && update.content) {
          const searchContent = update.content.toLowerCase();
          foundIndex = updatedTodos.findIndex(
            t => t.task.toLowerCase().includes(searchContent)
          );
        }

        if (foundIndex !== -1) {
          const todo = updatedTodos[foundIndex];
          if (todo) {
            const oldStatus = todo.status;
            updatedTodos[foundIndex] = {
              ...todo,
              status: update.status as TodoStatus,
            };
            updatedItems.push(
              `"${todo.task}" (${oldStatus} → ${update.status})`
            );
          }
        } else {
          notFoundItems.push(update.id || update.content || 'unknown');
        }
      }

      if (updatedItems.length === 0) {
        return this.formatErrorResponse(
          `No matching todos found for: ${notFoundItems.join(', ')}`,
          'validation_error',
          'Check todo IDs or content strings'
        );
      }

      // Validate all rules
      const validationError = todoManager.validateAllRules(updatedTodos);
      if (validationError) {
        return this.formatErrorResponse(validationError, 'validation_error');
      }

      // Write back the updated list
      todoManager.setTodos(updatedTodos);

      // Auto-save to session
      await autoSaveTodos(updatedTodos);

      const incompleteTodos = todoManager.getIncompleteTodos();
      let message = `Updated ${updatedItems.length} todo(s):\n${updatedItems.map(item => `  - ${item}`).join('\n')}`;

      if (notFoundItems.length > 0) {
        message += `\n\nWarning: Could not find ${notFoundItems.length} todo(s): ${notFoundItems.join(', ')}`;
      }

      message += `\n\n${incompleteTodos.length} task(s) remaining.`;

      if (incompleteTodos.length === 0) {
        message +=
          '\n\n⚠️  All todos completed! You must either:\n  1. Add more todos (if more work is needed), OR\n  2. End your turn and respond to the user';
      }

      return this.formatSuccessResponse({
        content: message,
        updated_count: updatedItems.length,
        not_found_count: notFoundItems.length,
        incomplete_count: incompleteTodos.length,
      });
    } catch (error) {
      return this.formatErrorResponse(
        `Error updating todos: ${formatError(error)}`,
        'system_error'
      );
    }
  }
}
