/**
 * ConfirmProposalTool - Accept proposed todos and activate them
 *
 * Retrieves proposed todos from TodoManager, converts them to pending/in_progress,
 * and activates them for execution. First todo becomes in_progress, rest become pending.
 */

import { BaseTool } from './BaseTool.js';
import { ToolResult, FunctionDefinition } from '../types/index.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { ServiceRegistry } from '../services/ServiceRegistry.js';
import { TodoManager, TodoStatus } from '../services/TodoManager.js';
import { ToolManager } from './ToolManager.js';
import { formatError } from '../utils/errorUtils.js';

export class ConfirmProposalTool extends BaseTool {
  readonly name = 'confirm_proposal';
  readonly description =
    'Accept and activate proposed todos. Converts proposed todos to pending/in_progress (first one in_progress, rest pending) and activates them for execution.';
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
          properties: {},
          required: [],
        },
      },
    };
  }

  protected async executeImpl(_args: any): Promise<ToolResult> {
    this.captureParams({});

    try {
      // Get TodoManager from registry
      const registry = ServiceRegistry.getInstance();
      const todoManager = registry.get<TodoManager>('todo_manager');

      if (!todoManager) {
        return this.formatErrorResponse('TodoManager not available', 'system_error');
      }

      // Get all todos and filter for proposed ones
      const allTodos = todoManager.getTodos();
      const proposedTodos = allTodos.filter(todo => todo.status === 'proposed');

      // Validate we have proposed todos
      if (proposedTodos.length === 0) {
        return this.formatErrorResponse(
          'No proposed todos found to confirm',
          'validation_error',
          'Use todo_add with status="proposed" to create a proposal first'
        );
      }

      // Get non-proposed todos (already active todos)
      const existingTodos = allTodos.filter(todo => todo.status !== 'proposed');

      // Check if there's already an in_progress todo to avoid violating "exactly ONE in_progress" rule
      const hasExistingInProgress = existingTodos.some(todo => todo.status === 'in_progress');

      // Convert proposed todos to pending/in_progress
      // First todo becomes in_progress ONLY if no existing in_progress todo exists
      const activatedTodos = proposedTodos.map((todo, index) => ({
        ...todo,
        status: (index === 0 && !hasExistingInProgress ? 'in_progress' : 'pending') as TodoStatus,
      }));

      // Combine existing todos with newly activated todos
      const newTodoList = [...existingTodos, ...activatedTodos];

      // Update TodoManager with new todo list
      todoManager.setTodos(newTodoList);

      // Clear the tool context on main agent
      const agent = registry.get<any>('agent');
      if (agent && agent.setCurrentToolContext) {
        agent.setCurrentToolContext(null);
      }

      // Unregister all three proposal tools
      try {
        const toolManager = registry.get<ToolManager>('tool_manager');
        if (toolManager) {
          console.debug('[CONFIRM_PROPOSAL] Unregistering proposal tools');
          toolManager.unregisterTool('confirm_proposal');
          toolManager.unregisterTool('modify_proposal');
          toolManager.unregisterTool('decline_proposal');
        } else {
          console.debug('[CONFIRM_PROPOSAL] ToolManager not available for unregistering tools');
        }
      } catch (error) {
        // Non-fatal: log but continue
        console.debug(`[CONFIRM_PROPOSAL] Error unregistering proposal tools: ${formatError(error)}`);
      }

      return this.formatSuccessResponse({
        content: `Successfully accepted ${proposedTodos.length} proposed todo${proposedTodos.length !== 1 ? 's' : ''}`,
        todos_accepted: proposedTodos.length,
        todos_activated: activatedTodos.map(t => t.task),
      });
    } catch (error) {
      return this.formatErrorResponse(
        `Error confirming proposal: ${formatError(error)}`,
        'system_error'
      );
    }
  }
}
