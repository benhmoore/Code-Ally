/**
 * TodoCommand - Manage session todo list
 *
 * Provides subcommands for adding, completing, and clearing todos.
 * Shows multi-line todo list display when invoked without arguments.
 */

import { Command } from './Command.js';
import type { Message } from '@shared/index.js';
import type { ServiceRegistry } from '@services/ServiceRegistry.js';
import type { CommandResult } from '../CommandHandler.js';
import type { TodoManager } from '@services/TodoManager.js';
import { CommandRegistry } from './CommandRegistry.js';
import type { CommandMetadata } from './types.js';

export class TodoCommand extends Command {
  static readonly metadata: CommandMetadata = {
    name: '/todo',
    description: 'Manage todo list',
    helpCategory: 'Todos',
    subcommands: [
      { name: 'add', description: 'Add a todo', args: '<task>' },
      { name: 'complete', description: 'Complete a todo', args: '<n>' },
      { name: 'clear', description: 'Clear completed todos' },
      { name: 'clear all', description: 'Clear all todos' },
    ],
    useYellowOutput: true,
  };

  static {
    CommandRegistry.register(TodoCommand.metadata);
  }

  readonly name = TodoCommand.metadata.name;
  readonly description = TodoCommand.metadata.description;
  protected readonly useYellowOutput = TodoCommand.metadata.useYellowOutput ?? false;

  async execute(
    args: string[],
    _messages: Message[],
    serviceRegistry: ServiceRegistry
  ): Promise<CommandResult> {
    const argString = args.join(' ').trim();

    // No args → show todos (multi-line display, not yellow)
    if (!argString) {
      return await this.handleTodoShow(serviceRegistry);
    }

    // Parse subcommand
    const parts = argString.split(/\s+/);
    const subcommand = parts[0];

    if (!subcommand) {
      return this.createError('Invalid todo command');
    }

    // Get TodoManager
    const todoManager = serviceRegistry.get<TodoManager>('todo_manager');

    if (!todoManager) {
      return this.createError('Todo manager not available.');
    }

    // Route to subcommand handlers
    switch (subcommand.toLowerCase()) {
      case 'add':
        return this.handleTodoAdd(todoManager, parts.slice(1).join(' '));

      case 'complete':
        return this.handleTodoComplete(todoManager, parts.length > 1 ? parts[1] : undefined);

      case 'clear':
        // Check for "clear all" vs "clear"
        const clearAll = parts.length > 1 && parts[1]?.toLowerCase() === 'all';
        return this.handleTodoClear(todoManager, clearAll);

      default:
        return this.createError(`Unknown todo subcommand: ${subcommand}. Type /help for usage.`);
    }
  }

  /**
   * Show the todo list with in-progress, pending, and completed sections
   */
  private async handleTodoShow(serviceRegistry: ServiceRegistry): Promise<CommandResult> {
    const todoManager = serviceRegistry.get<TodoManager>('todo_manager');

    if (!todoManager) {
      return this.createError('Todo manager not available.');
    }

    const todos = todoManager.getTodos();

    if (todos.length === 0) {
      // Not using yellow output for this message (it's not a status update)
      return {
        handled: true,
        response: 'No todos. Use `/todo add <task>` to add one.',
      };
    }

    const inProgress = todoManager.getInProgressTodo();
    const pending = todos.filter(t => t.status === 'pending');
    const completed = todoManager.getCompletedTodos();

    let output = '**Todo List**\n\n';

    // Show in-progress task (highlighted)
    if (inProgress) {
      output += `**In Progress**\n→ ${inProgress.task}\n\n`;
    }

    // Show pending tasks with indices
    if (pending.length > 0) {
      output += '**Pending**\n';
      pending.forEach((todo, index) => {
        output += `\`${index}\`  ${todo.task}\n`;
      });
      output += '\n';
    }

    // Show completed tasks
    if (completed.length > 0) {
      output += '**Completed**\n';
      completed.forEach(todo => {
        output += `✓ ${todo.task}\n`;
      });
    }

    // Multi-line display should not use yellow output
    return {
      handled: true,
      response: output,
    };
  }

  /**
   * Add a new todo to the list
   */
  private async handleTodoAdd(todoManager: TodoManager, task: string): Promise<CommandResult> {
    if (!task || task.trim() === '') {
      return this.createError('Task description required. Usage: /todo add <task>');
    }

    const newTodo = todoManager.createTodoItem(task.trim(), 'pending');
    const todos = todoManager.getTodos();
    todos.push(newTodo);
    todoManager.setTodos(todos);

    return this.createResponse(`Todo added: ${task.trim()}`);
  }

  /**
   * Complete a todo by index
   */
  private async handleTodoComplete(
    todoManager: TodoManager,
    indexStr: string | undefined
  ): Promise<CommandResult> {
    if (!indexStr) {
      return this.createError('Index required. Usage: /todo complete <index>');
    }

    const index = parseInt(indexStr, 10);

    if (isNaN(index) || index < 0) {
      return this.createError('Invalid index. Use /todo to see indices.');
    }

    const completedTodo = todoManager.completeTodoByIndex(index);

    if (!completedTodo) {
      return this.createError(`No pending todo at index ${index}. Use /todo to see current list.`);
    }

    return this.createResponse(`Completed: ${completedTodo.task}`);
  }

  /**
   * Clear completed or all todos
   */
  private async handleTodoClear(
    todoManager: TodoManager,
    clearAll: boolean
  ): Promise<CommandResult> {
    const cleared = todoManager.clearTodos(clearAll);

    if (cleared === 0) {
      return this.createResponse(clearAll ? 'No todos to clear.' : 'No completed todos to clear.');
    }

    return this.createResponse(`Cleared ${cleared} todo(s).`);
  }
}
