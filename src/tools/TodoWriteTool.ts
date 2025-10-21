/**
 * TodoWriteTool - Replace entire todo list
 *
 * Structured task planning with status tracking (pending/in_progress/completed).
 * Enforces clean task descriptions and activeForm for status display.
 */

import { BaseTool } from './BaseTool.js';
import { ToolResult, FunctionDefinition } from '../types/index.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { ServiceRegistry } from '../services/ServiceRegistry.js';
import { TodoManager, TodoStatus } from '../services/TodoManager.js';

interface TodoInput {
  content: string;
  status: TodoStatus;
  activeForm: string;
}

export class TodoWriteTool extends BaseTool {
  readonly name = 'todo_write';
  readonly description =
    'Create or update the todo list. Required before executing any tools. Each todo needs: content (imperative), status (pending/in_progress/completed), activeForm (present continuous for status display).';
  readonly requiresConfirmation = false;
  readonly visibleInChat = false; // Don't clutter chat with todo updates

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
              description: 'Array of todo items with content, status, and activeForm',
              items: {
                type: 'object',
                properties: {
                  content: {
                    type: 'string',
                    description: 'Task description in imperative form (e.g., "Run tests")',
                  },
                  status: {
                    type: 'string',
                    description: 'Task status: pending, in_progress, or completed',
                  },
                  activeForm: {
                    type: 'string',
                    description: 'Present continuous form for status display (e.g., "Running tests")',
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

    const todos = args.todos;

    if (!Array.isArray(todos)) {
      return this.formatErrorResponse('todos must be an array', 'validation_error');
    }

    if (todos.length === 0) {
      return this.formatErrorResponse('todos array cannot be empty. Provide at least one task.', 'validation_error');
    }

    // Validate each todo
    for (let i = 0; i < todos.length; i++) {
      const todo = todos[i];
      if (!todo.content || typeof todo.content !== 'string') {
        return this.formatErrorResponse(`Todo ${i}: content is required and must be a string`, 'validation_error');
      }
      if (!todo.status || !['pending', 'in_progress', 'completed'].includes(todo.status)) {
        return this.formatErrorResponse(`Todo ${i}: status must be pending, in_progress, or completed`, 'validation_error');
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

      // Replace entire todo list
      const newTodos = todos.map((t: TodoInput) =>
        todoManager.createTodoItem(t.content, t.status as TodoStatus, t.activeForm)
      );
      todoManager.setTodos(newTodos);

      // Check if all todos completed
      const incompleteTodos = todoManager.getIncompleteTodos();

      let message = `Todo list updated. ${incompleteTodos.length} task(s) remaining.`;

      if (incompleteTodos.length === 0) {
        message = 'Todo list updated successfully.\n\n⚠️  All todos completed! You must either:\n  1. Add more todos (if more work is needed), OR\n  2. End your turn and respond to the user';
      }

      return this.formatSuccessResponse({
        content: message,
        total_count: newTodos.length,
        incomplete_count: incompleteTodos.length,
      });
    } catch (error) {
      return this.formatErrorResponse(
        `Error updating todos: ${error instanceof Error ? error.message : String(error)}`,
        'system_error'
      );
    }
  }
}
