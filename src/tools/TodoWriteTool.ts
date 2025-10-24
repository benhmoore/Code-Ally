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
import { formatError } from '../utils/errorUtils.js';

interface TodoInput {
  content: string;
  status: TodoStatus;
  activeForm: string;
}

export class TodoWriteTool extends BaseTool {
  readonly name = 'todo_write';
  readonly description =
    'Create or update the todo list for tracking multi-step tasks. Use for complex tasks requiring 3+ distinct steps or non-trivial operations requiring careful planning. Each todo needs: content (imperative form, e.g., "Run tests"), status (pending/in_progress/completed), activeForm (present continuous form, e.g., "Running tests"). Exactly ONE task must be in_progress when incomplete tasks exist.';
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

    // CRITICAL: Validate exactly ONE in_progress task when incomplete tasks exist (C-1.1)
    const inProgressCount = todos.filter(t => t.status === 'in_progress').length;
    const incompleteCount = todos.filter(t => t.status !== 'completed').length;

    if (incompleteCount > 0) {
      if (inProgressCount === 0) {
        return this.formatErrorResponse(
          'At least one incomplete task must be marked as "in_progress". ' +
          'Mark the task you are currently working on as in_progress.',
          'validation_error'
        );
      }
      if (inProgressCount > 1) {
        return this.formatErrorResponse(
          `Only ONE task can be "in_progress" at a time. Found ${inProgressCount} in_progress tasks. ` +
          'Mark only your current task as in_progress, others should be pending.',
          'validation_error'
        );
      }
    }

    if (incompleteCount === 0 && inProgressCount > 0) {
      return this.formatErrorResponse(
        'Cannot have in_progress tasks when all other tasks are completed. ' +
        'Mark the final task as completed.',
        'validation_error'
      );
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

      // Auto-save todos to session
      const sessionManager = registry.get('session_manager');
      if (sessionManager && typeof (sessionManager as any).autoSave === 'function') {
        const agent = registry.get('agent');
        const messages = agent && typeof (agent as any).getMessages === 'function'
          ? (agent as any).getMessages()
          : [];
        const idleMessageGenerator = registry.get('idle_message_generator');
        const idleMessages = idleMessageGenerator && typeof (idleMessageGenerator as any).getQueue === 'function'
          ? (idleMessageGenerator as any).getQueue()
          : undefined;
        const projectContextDetector = registry.get('project_context_detector');
        const projectContext = projectContextDetector && typeof (projectContextDetector as any).getCached === 'function'
          ? (projectContextDetector as any).getCached()
          : undefined;
        (sessionManager as any).autoSave(messages, newTodos, idleMessages, projectContext).catch((error: Error) => {
          console.error('[TodoWriteTool] Failed to auto-save session:', error);
        });
      }

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
        `Error updating todos: ${formatError(error)}`,
        'system_error'
      );
    }
  }
}
