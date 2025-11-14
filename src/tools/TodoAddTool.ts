/**
 * TodoAddTool - Append new todos to existing list
 */

import { BaseTool } from './BaseTool.js';
import { ToolResult, FunctionDefinition } from '../types/index.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { ServiceRegistry } from '../services/ServiceRegistry.js';
import { TodoManager, TodoStatus, TodoItem } from '../services/TodoManager.js';
import { formatError } from '../utils/errorUtils.js';
import { autoSaveTodos } from '../utils/todoUtils.js';

interface TodoInput {
  content: string;
  status: TodoStatus;
  activeForm: string;
}

export class TodoAddTool extends BaseTool {
  readonly name = 'todo-add';
  readonly description =
    'Add new todos to existing list. Validates at most ONE in_progress task.';
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
          properties: {
            todos: {
              type: 'array',
              description: 'Array of new todos',
              items: {
                type: 'object',
                properties: {
                  content: {
                    type: 'string',
                    description: 'Task (imperative, e.g. "Run tests")',
                  },
                  status: {
                    type: 'string',
                    description: 'Status: proposed|pending|in_progress|completed',
                  },
                  activeForm: {
                    type: 'string',
                    description: 'Active form (e.g. "Running tests")',
                  },
                  dependencies: {
                    type: 'array',
                    description: 'Todo IDs that must complete first',
                    items: {
                      type: 'string',
                    },
                  },
                  subtasks: {
                    type: 'array',
                    description: 'Optional subtasks (max depth 1)',
                    items: {
                      type: 'object',
                      properties: {
                        content: {
                          type: 'string',
                          description: 'Task (imperative)',
                        },
                        status: {
                          type: 'string',
                          description: 'Status',
                        },
                        activeForm: {
                          type: 'string',
                          description: 'Active form',
                        },
                      },
                      required: ['content', 'status', 'activeForm'],
                    },
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

  protected async executeImpl(args: any): Promise<ToolResult> {
    this.captureParams(args);

    const newTodos = args.todos;

    if (!Array.isArray(newTodos)) {
      return this.formatErrorResponse('todos must be an array', 'validation_error');
    }

    if (newTodos.length === 0) {
      return this.formatErrorResponse('todos array cannot be empty', 'validation_error');
    }

    // Validate each todo
    for (let i = 0; i < newTodos.length; i++) {
      const todo = newTodos[i];
      if (!todo.content || typeof todo.content !== 'string') {
        return this.formatErrorResponse(`Todo ${i}: content is required and must be a string`, 'validation_error');
      }
      if (!todo.status || !['proposed', 'pending', 'in_progress', 'completed'].includes(todo.status)) {
        return this.formatErrorResponse(`Todo ${i}: status must be proposed, pending, in_progress, or completed`, 'validation_error');
      }
      if (!todo.activeForm || typeof todo.activeForm !== 'string') {
        return this.formatErrorResponse(`Todo ${i}: activeForm is required and must be a string`, 'validation_error');
      }
    }

    try {
      const registry = ServiceRegistry.getInstance();
      const todoManager = registry.get<TodoManager>('todo_manager');

      if (!todoManager) {
        return this.formatErrorResponse('TodoManager not available', 'system_error');
      }

      // Get current todos and append new ones
      const existingTodos = todoManager.getTodos();
      const createdTodos = newTodos.map((t: TodoInput) => {
        // Process subtasks if provided
        let processedSubtasks: TodoItem[] | undefined;
        if ((t as any).subtasks && Array.isArray((t as any).subtasks)) {
          processedSubtasks = (t as any).subtasks.map((st: any) =>
            todoManager.createTodoItem(
              st.content,
              st.status as TodoStatus,
              st.activeForm
            )
          );
        }

        return todoManager.createTodoItem(
          t.content,
          t.status as TodoStatus,
          t.activeForm,
          (t as any).dependencies,
          processedSubtasks
        );
      });
      const combinedTodos = [...existingTodos, ...createdTodos];

      // Validate all rules
      const validationError = todoManager.validateAllRules(combinedTodos);
      if (validationError) {
        return this.formatErrorResponse(validationError, 'validation_error');
      }

      // Write combined list
      todoManager.setTodos(combinedTodos);

      // Auto-save
      await autoSaveTodos(combinedTodos);

      const incompleteTodos = todoManager.getIncompleteTodos();
      let message = `Added ${createdTodos.length} todo(s). ${incompleteTodos.length} task(s) remaining.`;

      if (incompleteTodos.length === 0) {
        message += '\n\n✓ All todos completed! Next steps:\n  1. Add more todos if there\'s more work, OR\n  2. End your turn and respond to the user';
      }

      // Include summary of current todos so agent can see what exists
      const todoSummary = todoManager.generateActiveContext();
      if (todoSummary) {
        message += `\n\nCurrent todos:\n${todoSummary}`;
      }

      return this.formatSuccessResponse({
        content: message,
        added_count: createdTodos.length,
        total_count: combinedTodos.length,
        incomplete_count: incompleteTodos.length,
      });
    } catch (error) {
      return this.formatErrorResponse(
        `Error adding todos: ${formatError(error)}`,
        'system_error'
      );
    }
  }
}
