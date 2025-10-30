/**
 * DeclineProposalTool - Reject proposed todos
 *
 * Removes proposed todos from TodoManager and clears Agent's currentToolContext.
 * Optionally accepts a reason for declining.
 */

import { BaseTool } from './BaseTool.js';
import { ToolResult, FunctionDefinition } from '../types/index.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { ServiceRegistry } from '../services/ServiceRegistry.js';
import { TodoManager } from '../services/TodoManager.js';
import { ToolManager } from './ToolManager.js';
import { formatError } from '../utils/errorUtils.js';

export class DeclineProposalTool extends BaseTool {
  readonly name = 'decline_proposal';
  readonly description =
    'Decline and remove proposed todos. Clears proposed todos from the list and resets proposal state. Optionally provide a reason for declining.';
  readonly requiresConfirmation = false; // Only modifies todo list (internal state). User sees proposal in agent's message, and agent decides whether to accept/modify/decline.
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
              description: 'Optional reason for declining the proposal',
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

      // Validate we have proposed todos to decline
      if (proposedTodos.length === 0) {
        return this.formatErrorResponse(
          'No proposed todos found to decline',
          'validation_error',
          'There are no pending proposals to reject'
        );
      }

      // Update TodoManager with only non-proposed todos
      todoManager.setTodos(remainingTodos);

      // Clear the tool context on main agent
      const agent = registry.get<any>('agent');
      if (agent && agent.setCurrentToolContext) {
        agent.setCurrentToolContext(null);
      }

      // Unregister all three proposal tools
      try {
        const toolManager = registry.get<ToolManager>('tool_manager');
        if (toolManager) {
          console.debug('[DECLINE_PROPOSAL] Unregistering proposal tools');
          toolManager.unregisterTool('confirm_proposal');
          toolManager.unregisterTool('modify_proposal');
          toolManager.unregisterTool('decline_proposal');
        } else {
          console.debug('[DECLINE_PROPOSAL] ToolManager not available for unregistering tools');
        }
      } catch (error) {
        // Non-fatal: log but continue
        console.debug(`[DECLINE_PROPOSAL] Error unregistering proposal tools: ${formatError(error)}`);
      }

      // Build response message
      let message = `Declined proposal with ${proposedTodos.length} todo${proposedTodos.length !== 1 ? 's' : ''}`;
      if (reason) {
        message += `\nReason: ${reason}`;
      }

      return this.formatSuccessResponse({
        content: message,
        todos_declined: proposedTodos.length,
        todos_removed: proposedTodos.map(t => t.task),
        reason: reason || undefined,
      });
    } catch (error) {
      return this.formatErrorResponse(
        `Error declining proposal: ${formatError(error)}`,
        'system_error'
      );
    }
  }
}
