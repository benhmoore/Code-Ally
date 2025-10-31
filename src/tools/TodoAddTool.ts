/**
 * TodoAddTool - Append new todos to existing list
 */

import { BaseTool } from './BaseTool.js';
import { ToolResult, FunctionDefinition } from '../types/index.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { ServiceRegistry } from '../services/ServiceRegistry.js';
import { TodoManager, TodoStatus } from '../services/TodoManager.js';
import { formatError } from '../utils/errorUtils.js';
import { autoSaveTodos } from '../utils/todoUtils.js';

interface TodoInput {
  content: string;
  status: TodoStatus;
  activeForm: string;
}

export class TodoAddTool extends BaseTool {
  readonly name = 'todo_add';
  readonly description =
    'Add new todos to the existing list without replacing it. Validates "exactly ONE in_progress" rule against the complete combined list. Use this when adding tasks to ongoing work.';
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
          properties: {
            todos: {
              type: 'array',
              description: 'Array of new todos to add',
              items: {
                type: 'object',
                properties: {
                  content: {
                    type: 'string',
                    description: 'Task description in imperative form (e.g., "Run tests")',
                  },
                  status: {
                    type: 'string',
                    description: 'Task status: proposed, pending, in_progress, or completed',
                  },
                  activeForm: {
                    type: 'string',
                    description: 'Present continuous form (e.g., "Running tests")',
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
      const createdTodos = newTodos.map((t: TodoInput) =>
        todoManager.createTodoItem(
          t.content,
          t.status as TodoStatus,
          t.activeForm,
          (t as any).dependencies,
          (t as any).subtasks
        )
      );
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
        message += '\n\n⚠️  All todos completed! You must either:\n  1. Add more todos (if more work is needed), OR\n  2. End your turn and respond to the user';
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
