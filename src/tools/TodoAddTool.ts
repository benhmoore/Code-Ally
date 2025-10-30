/**
 * TodoAddTool - Append new todos to existing list
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

      // Validate dependencies exist and no circular refs
      const depError = todoManager.validateDependencies(combinedTodos);
      if (depError) {
        return this.formatErrorResponse(depError, 'validation_error');
      }

      // Validate subtask depth (max 1)
      const depthError = todoManager.validateSubtaskDepth(combinedTodos);
      if (depthError) {
        return this.formatErrorResponse(depthError, 'validation_error');
      }

      // Validate blocked todos not in_progress
      const blockedError = todoManager.validateInProgressNotBlocked(combinedTodos);
      if (blockedError) {
        return this.formatErrorResponse(blockedError, 'validation_error');
      }

      // Validate "exactly ONE in_progress" rule against FULL combined list
      const inProgressCount = combinedTodos.filter(t => t.status === 'in_progress').length;
      const incompleteCount = combinedTodos.filter(t => t.status === 'pending' || t.status === 'in_progress').length;

      if (incompleteCount > 0) {
        if (inProgressCount === 0) {
          return this.formatErrorResponse(
            'At least one incomplete task must be marked as "in_progress".',
            'validation_error'
          );
        }
        if (inProgressCount > 1) {
          return this.formatErrorResponse(
            `Only ONE task can be "in_progress" at a time. Found ${inProgressCount} in_progress tasks.`,
            'validation_error'
          );
        }
      }

      // Validate subtask in_progress rule
      const inProgressParent = combinedTodos.find(t => t.status === 'in_progress');
      if (inProgressParent) {
        const subtaskError = todoManager.validateSubtaskInProgress(inProgressParent);
        if (subtaskError) {
          return this.formatErrorResponse(subtaskError, 'validation_error');
        }
      }

      // Write combined list
      todoManager.setTodos(combinedTodos);

      // Auto-save
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
        (sessionManager as any).autoSave(messages, combinedTodos, idleMessages, projectContext).catch((error: Error) => {
          console.error('[TodoAddTool] Failed to auto-save session:', error);
        });
      }

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
