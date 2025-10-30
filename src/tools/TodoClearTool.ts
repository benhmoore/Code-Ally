/**
 * TodoClearTool - Clear all todos
 */

import { BaseTool } from './BaseTool.js';
import { ToolResult, FunctionDefinition } from '../types/index.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { ServiceRegistry } from '../services/ServiceRegistry.js';
import { TodoManager } from '../services/TodoManager.js';
import { formatError } from '../utils/errorUtils.js';

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
      const sessionManager = registry.get('session_manager');
      if (sessionManager && typeof (sessionManager as any).autoSave === 'function') {
        const agent = registry.get('agent');
        const messages =
          agent && typeof (agent as any).getMessages === 'function'
            ? (agent as any).getMessages()
            : [];
        const idleMessageGenerator = registry.get('idle_message_generator');
        const idleMessages =
          idleMessageGenerator && typeof (idleMessageGenerator as any).getQueue === 'function'
            ? (idleMessageGenerator as any).getQueue()
            : undefined;
        const projectContextDetector = registry.get('project_context_detector');
        const projectContext =
          projectContextDetector &&
          typeof (projectContextDetector as any).getCached === 'function'
            ? (projectContextDetector as any).getCached()
            : undefined;
        (sessionManager as any).autoSave(messages, [], idleMessages, projectContext).catch((error: Error) => {
          console.error('[TodoClearTool] Failed to auto-save session:', error);
        });
      }

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
