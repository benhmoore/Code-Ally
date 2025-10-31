/**
 * ModifyProposalTool - Modify proposed todos before acceptance
 *
 * Allows modifying the proposal by updating todos with modified content.
 * All todos remain with status="proposed" until confirmed.
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

export class ModifyProposalTool extends BaseTool {
  readonly name = 'modify_proposal';
  readonly description =
    'Modify proposed todos before acceptance. Updates the proposal with modified todos (still status="proposed"). Use to adjust, add, or remove tasks from the proposal.';
  readonly requiresConfirmation = false; // Only modifies todo list (internal state). User sees proposal in agent's message, and agent decides whether to accept/modify/decline.
  readonly visibleInChat = true;
  readonly requiresTodoId = false; // Proposal management tool doesn't need todo_id

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
              description: 'Modified array of todo items (all should have status="proposed")',
              items: {
                type: 'object',
                properties: {
                  content: {
                    type: 'string',
                    description: 'Task description in imperative form (e.g., "Run tests")',
                  },
                  status: {
                    type: 'string',
                    description: 'Task status - should be "proposed" for proposal modifications',
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

    // Validate input
    if (!Array.isArray(todos)) {
      return this.formatErrorResponse('todos must be an array', 'validation_error');
    }

    if (todos.length === 0) {
      return this.formatErrorResponse(
        'todos array cannot be empty. Provide at least one task.',
        'validation_error'
      );
    }

    // Validate each todo
    for (let i = 0; i < todos.length; i++) {
      const todo = todos[i];
      if (!todo.content || typeof todo.content !== 'string') {
        return this.formatErrorResponse(
          `Todo ${i}: content is required and must be a string`,
          'validation_error'
        );
      }
      if (!todo.status || !['proposed', 'pending', 'in_progress', 'completed'].includes(todo.status)) {
        return this.formatErrorResponse(
          `Todo ${i}: status must be proposed, pending, in_progress, or completed`,
          'validation_error'
        );
      }
      if (!todo.activeForm || typeof todo.activeForm !== 'string') {
        return this.formatErrorResponse(
          `Todo ${i}: activeForm is required and must be a string`,
          'validation_error'
        );
      }

      // Warn if status is not "proposed"
      if (todo.status !== 'proposed') {
        return this.formatErrorResponse(
          `Todo ${i}: status should be "proposed" when modifying a proposal. Use confirm_proposal to activate todos.`,
          'validation_error',
          'Set status="proposed" for all todos in the modification'
        );
      }
    }

    try {
      // Get TodoManager from registry
      const registry = ServiceRegistry.getInstance();
      const todoManager = registry.get<TodoManager>('todo_manager');

      if (!todoManager) {
        return this.formatErrorResponse('TodoManager not available', 'system_error');
      }

      // Get existing non-proposed todos (already active todos)
      const allTodos = todoManager.getTodos();
      const existingActiveTodos = allTodos.filter(todo => todo.status !== 'proposed');

      // Create new proposed todos
      const newProposedTodos = todos.map((t: TodoInput) =>
        todoManager.createTodoItem(t.content, 'proposed', t.activeForm)
      );

      // Combine existing active todos with new proposed todos
      const newTodoList = [...existingActiveTodos, ...newProposedTodos];

      // Update TodoManager
      todoManager.setTodos(newTodoList);

      return this.formatSuccessResponse({
        content: `Proposal modified with ${newProposedTodos.length} todo${newProposedTodos.length !== 1 ? 's' : ''}`,
        todos_count: newProposedTodos.length,
        todos_modified: newProposedTodos.map(t => t.task),
      });
    } catch (error) {
      return this.formatErrorResponse(
        `Error modifying proposal: ${formatError(error)}`,
        'system_error'
      );
    }
  }
}
