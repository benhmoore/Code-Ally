/**
 * TodoRemoveTool - Remove specific todos from the list
 */

import { BaseTool } from './BaseTool.js';
import { ToolResult, FunctionDefinition } from '../types/index.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { ServiceRegistry } from '../services/ServiceRegistry.js';
import { TodoManager } from '../services/TodoManager.js';
import { formatError } from '../utils/errorUtils.js';

export class TodoRemoveTool extends BaseTool {
  readonly name = 'todo_remove';
  readonly description =
    'Remove specific todos from the list by id or content matching. Use when cleaning up completed tasks or removing no-longer-relevant todos.';
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

      // Validate dependencies exist and no circular refs
      const depError = todoManager.validateDependencies(remainingTodos);
      if (depError) {
        return this.formatErrorResponse(depError, 'validation_error');
      }

      // Validate subtask depth (max 1)
      const depthError = todoManager.validateSubtaskDepth(remainingTodos);
      if (depthError) {
        return this.formatErrorResponse(depthError, 'validation_error');
      }

      // Validate blocked todos not in_progress
      const blockedError = todoManager.validateInProgressNotBlocked(remainingTodos);
      if (blockedError) {
        return this.formatErrorResponse(blockedError, 'validation_error');
      }

      // Validate "exactly ONE in_progress" rule after removal
      const inProgressCount = remainingTodos.filter(t => t.status === 'in_progress').length;
      const incompleteCount = remainingTodos.filter(
        t => t.status === 'pending' || t.status === 'in_progress'
      ).length;

      if (incompleteCount > 0 && inProgressCount === 0) {
        return this.formatErrorResponse(
          'After removal, at least one incomplete task must be marked as "in_progress".',
          'validation_error',
          'Use todo_update to mark a task as in_progress before removing'
        );
      }

      if (inProgressCount > 1) {
        return this.formatErrorResponse(
          `After removal, only ONE task can be "in_progress". Found ${inProgressCount}.`,
          'validation_error'
        );
      }

      // Validate subtask in_progress rule
      const inProgressParent = remainingTodos.find(t => t.status === 'in_progress');
      if (inProgressParent) {
        const subtaskError = todoManager.validateSubtaskInProgress(inProgressParent);
        if (subtaskError) {
          return this.formatErrorResponse(subtaskError, 'validation_error');
        }
      }

      // Write remaining todos
      todoManager.setTodos(remainingTodos);

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
        (sessionManager as any).autoSave(messages, remainingTodos, idleMessages, projectContext).catch((error: Error) => {
          console.error('[TodoRemoveTool] Failed to auto-save session:', error);
        });
      }

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
