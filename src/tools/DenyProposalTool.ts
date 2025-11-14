/**
 * DenyProposalTool - Reject proposed todos
 *
 * Removes proposed todos from TodoManager. Always available (not dynamically registered).
 * Gracefully handles case when no proposals exist.
 * Optionally accepts a reason for denying.
 */

import { BaseTool } from './BaseTool.js';
import { ToolResult, FunctionDefinition } from '../types/index.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { ServiceRegistry } from '../services/ServiceRegistry.js';
import { TodoManager } from '../services/TodoManager.js';
import { formatError } from '../utils/errorUtils.js';

export class DenyProposalTool extends BaseTool {
  readonly name = 'deny-proposal';
  readonly description =
    'Deny and remove proposed todos. Clears proposed todos from the list. Optionally provide a reason for denying. No-ops gracefully if no proposals exist.';
  readonly requiresConfirmation = false; // Only modifies todo list (internal state)
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
            reason: {
              type: 'string',
              description: 'Optional reason for denying the proposal',
            },
          },
          required: [],
        },
      },
    };
  }

  protected async executeImpl(args: any): Promise<ToolResult> {
    this.captureParams(args);

    const reason = args.reason as string | undefined;

    try {
      // Get TodoManager from registry
      const registry = ServiceRegistry.getInstance();
      const todoManager = registry.get<TodoManager>('todo_manager');

      if (!todoManager) {
        return this.formatErrorResponse('TodoManager not available', 'system_error');
      }

      // Get all todos and filter out proposed ones
      const allTodos = todoManager.getTodos();
      const proposedTodos = allTodos.filter(todo => todo.status === 'proposed');
      const remainingTodos = allTodos.filter(todo => todo.status !== 'proposed');

      // Gracefully handle no proposals case (no-op)
      if (proposedTodos.length === 0) {
        return this.formatSuccessResponse({
          content: 'No proposed todos to deny',
          todos_denied: 0,
          todos_removed: [],
        });
      }

      // Update TodoManager with only non-proposed todos
      todoManager.setTodos(remainingTodos);

      // Build response message
      let message = `Denied proposal with ${proposedTodos.length} todo${proposedTodos.length !== 1 ? 's' : ''}`;
      if (reason) {
        message += `\nReason: ${reason}`;
      }

      return this.formatSuccessResponse({
        content: message,
        todos_denied: proposedTodos.length,
        todos_removed: proposedTodos.map(t => t.task),
        reason: reason || undefined,
      });
    } catch (error) {
      return this.formatErrorResponse(
        `Error denying proposal: ${formatError(error)}`,
        'system_error'
      );
    }
  }
}
