/**
 * TodoManager - Shared todo list management service
 *
 * Provides centralized storage and operations for session-based todo lists.
 * Todo items are stored in-memory and persisted to session data.
 * Emits events when todos change for immediate UI updates.
 */

import { randomUUID } from 'crypto';
import { ID_GENERATION } from '../config/constants.js';
import { ActivityStream } from './ActivityStream.js';
import { ActivityEventType } from '../types/index.js';
import { logger } from './Logger.js';

export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export interface TodoItem {
  id: string;
  task: string;
  status: TodoStatus;
}

/**
 * Generate active form (present continuous) from a task description
 * This is used for UI display when a task is in progress
 */
export function getActiveForm(task: string): string {
  // Simple heuristic: if task starts with a verb, convert to -ing form
  // Otherwise, just return the task as-is
  // Examples: "Fix bug" -> "Fixing bug", "Update tests" -> "Updating tests"
  const words = task.trim().split(/\s+/);
  if (words.length === 0) return task;

  const firstWord = words[0]!.toLowerCase();

  // Common verb mappings
  const verbMappings: Record<string, string> = {
    'fix': 'Fixing',
    'add': 'Adding',
    'update': 'Updating',
    'create': 'Creating',
    'remove': 'Removing',
    'delete': 'Deleting',
    'implement': 'Implementing',
    'refactor': 'Refactoring',
    'test': 'Testing',
    'write': 'Writing',
    'read': 'Reading',
    'check': 'Checking',
    'verify': 'Verifying',
    'build': 'Building',
    'run': 'Running',
    'install': 'Installing',
    'configure': 'Configuring',
    'setup': 'Setting up',
    'clean': 'Cleaning',
    'deploy': 'Deploying',
  };

  if (verbMappings[firstWord]) {
    return `${verbMappings[firstWord]} ${words.slice(1).join(' ')}`;
  }

  // Default: just return the task
  return task;
}

export class TodoManager {
  private todos: TodoItem[] = [];
  private activityStream: ActivityStream | null = null;
  private lastLoggedContext: string | null = null; // Track last logged context to avoid duplicates

  constructor(activityStream?: ActivityStream) {
    this.activityStream = activityStream || null;
  }

  /**
   * Create a new todo item
   *
   * @param task - Task description
   * @param status - Todo status (default: pending)
   * @returns New todo item
   */
  createTodoItem(
    task: string,
    status: TodoStatus = 'pending'
  ): TodoItem {
    return {
      id: randomUUID().substring(0, ID_GENERATION.TODO_ID_LENGTH),
      task: task.trim(),
      status,
    };
  }

  /**
   * Get all todos
   *
   * @returns Array of todo items
   */
  getTodos(): TodoItem[] {
    return [...this.todos];
  }

  /**
   * Set the entire todo list
   *
   * @param todos - New todo list
   */
  setTodos(todos: TodoItem[]): void {
    this.todos = todos;

    // Emit event for immediate UI update
    if (this.activityStream) {
      this.activityStream.emit({
        id: `todo-update-${Date.now()}`,
        type: ActivityEventType.TODO_UPDATE,
        timestamp: Date.now(),
        data: { todos: this.todos },
      });
    }

    // Log todos when they are updated
    this.logTodosIfChanged();
  }

  /**
   * Add new todos to the list
   *
   * @param tasks - Array of task descriptions
   * @returns Array of created todo items
   */
  addTodos(tasks: string[]): TodoItem[] {
    const newTodos = tasks.map(task => this.createTodoItem(task));
    this.todos.push(...newTodos);

    // Emit event for immediate UI update
    if (this.activityStream) {
      this.activityStream.emit({
        id: `todo-update-${Date.now()}`,
        type: ActivityEventType.TODO_UPDATE,
        timestamp: Date.now(),
        data: { todos: this.todos },
      });
    }

    // Log todos when they are updated
    this.logTodosIfChanged();

    return newTodos;
  }

  /**
   * Mark a task as complete by index
   *
   * IMPORTANT: Index refers to INCOMPLETE tasks only, not absolute array position.
   * This means index 0 refers to the first pending/in_progress task, regardless of
   * how many completed tasks appear before it in the array.
   *
   * Example:
   *   todos = [
   *     {task: "A", status: "completed"},
   *     {task: "B", status: "pending"},     // ← index 0 for completion
   *     {task: "C", status: "in_progress"}  // ← index 1 for completion
   *   ]
   *
   * @param index - Index of incomplete task to complete (0-based)
   * @returns Completed todo item or null if index out of bounds
   */
  completeTodoByIndex(index: number): TodoItem | null {
    const incompleteTodos = this.todos
      .map((todo, i) => ({ todo, originalIndex: i }))
      .filter(({ todo }) => todo.status !== 'completed');

    if (index < 0 || index >= incompleteTodos.length) {
      return null;
    }

    const item = incompleteTodos[index];
    if (!item) {
      return null;
    }

    const { todo, originalIndex } = item;
    const todoToComplete = this.todos[originalIndex];
    if (todoToComplete) {
      todoToComplete.status = 'completed';
      // Log todos when they are modified
      this.logTodosIfChanged();
    }

    return todo;
  }

  /**
   * Mark a task as complete by ID
   *
   * @param id - ID of todo to complete
   * @returns Completed todo item or null if not found
   */
  completeTodoById(id: string): TodoItem | null {
    const todo = this.todos.find(t => t.id === id);
    if (!todo) {
      return null;
    }

    todo.status = 'completed';
    // Log todos when they are modified
    this.logTodosIfChanged();
    return todo;
  }

  /**
   * Clear completed or all tasks
   *
   * @param clearAll - If true, clear all tasks; if false, only clear completed
   * @returns Number of tasks cleared
   */
  clearTodos(clearAll: boolean = false): number {
    const originalCount = this.todos.length;

    if (clearAll) {
      this.todos = [];
    } else {
      this.todos = this.todos.filter(todo => todo.status !== 'completed');
    }

    // Log todos when they are cleared
    this.logTodosIfChanged();

    return originalCount - this.todos.length;
  }

  /**
   * Get the index of the first incomplete task
   *
   * @returns Index or null if all completed
   */
  getNextTaskIndex(): number | null {
    const index = this.todos.findIndex(todo => todo.status !== 'completed');
    return index === -1 ? null : index;
  }

  /**
   * Get all incomplete todos
   *
   * @returns Array of incomplete todo items
   */
  getIncompleteTodos(): TodoItem[] {
    return this.todos.filter(todo => todo.status !== 'completed');
  }

  /**
   * Get all completed todos
   *
   * @returns Array of completed todo items
   */
  getCompletedTodos(): TodoItem[] {
    return this.todos.filter(todo => todo.status === 'completed');
  }

  /**
   * Get the currently in-progress todo
   *
   * @returns In-progress todo or null
   */
  getInProgressTodo(): TodoItem | null {
    return this.todos.find(todo => todo.status === 'in_progress') || null;
  }


  /**
   * Get the next pending todo
   *
   * @returns Next pending todo or null
   */
  getNextPendingTodo(): TodoItem | null {
    return this.todos.find(todo => todo.status === 'pending') || null;
  }

  /**
   * Format todos for UI display
   *
   * @returns Formatted string for display
   */
  formatTodoUI(): string {
    if (this.todos.length === 0) {
      return '     [dim]No todos[/]';
    }

    const lines: string[] = [];
    const inProgress = this.getInProgressTodo();
    const pending = this.todos.filter(t => t.status === 'pending');
    const completed = this.getCompletedTodos();

    // Display in-progress task (highlighted)
    if (inProgress) {
      lines.push(`  [yellow]→ IN PROGRESS:[/] ${inProgress.task}`);
    }

    // Display pending tasks
    pending.forEach((todo, index) => {
      if (!inProgress && index === 0) {
        lines.push(`  [yellow]NEXT →[/] ${todo.task}`);
      } else {
        lines.push(`    ${index + 1}. ${todo.task}`);
      }
    });

    // Display completed tasks (dimmed)
    completed.forEach(todo => {
      lines.push(`  [dim green]✓[/] [dim]${todo.task}[/]`);
    });

    return lines.join('\n');
  }

  /**
   * Generate context string for system prompt injection
   *
   * @returns Formatted todo context or null if no tasks
   */
  generateActiveContext(): string | null {
    if (this.todos.length === 0) {
      return null;
    }

    const lines: string[] = [];
    const inProgress = this.getInProgressTodo();
    const pending = this.todos.filter(t => t.status === 'pending');
    const completed = this.getCompletedTodos();

    // Show in-progress task
    if (inProgress) {
      lines.push(`  [ACTIVE] ${inProgress.task}`);
    }

    // Show pending tasks
    if (pending.length > 0) {
      lines.push(`  PENDING:`);
      pending.forEach((todo, index) => {
        lines.push(`    ${index + 1}. ${todo.task}`);
      });
    }

    // Show completed tasks
    if (completed.length > 0) {
      lines.push(`  COMPLETED:`);
      completed.forEach(todo => {
        lines.push(`    ✓ ${todo.task}`);
      });
    }

    const tasksText = lines.join('\n');
    const helperText = '*Manage todos with the todo tool.*';
    return `**Your Current Tasks:**\n${tasksText}\n\n${helperText}`;
  }

  /**
   * Log todos to console if they have changed since last log
   * Called once per turn OR when todos are updated, whichever comes first
   */
  logTodosIfChanged(): void {
    const currentContext = this.generateActiveContext();
    const contextString = currentContext || '(empty todo list)';

    // Only log if context changed since last log
    if (contextString !== this.lastLoggedContext) {
      logger.debug('[TODO_CONTEXT]', contextString.substring(0, 150) + (contextString.length > 150 ? '...' : ''));
      this.lastLoggedContext = contextString;
    }
  }


  /**
   * Validate "at most ONE in_progress" rule
   *
   * Allows 0 or 1 in_progress todos to prevent confusion.
   * Only blocks when multiple todos are marked in_progress simultaneously.
   */
  validateAtMostOneInProgress(todos: TodoItem[]): string | null {
    const inProgressTodos = todos.filter(t => t.status === 'in_progress');
    const inProgressCount = inProgressTodos.length;

    // Allow 0 or 1 in_progress - only block when >1 (ambiguous state)
    if (inProgressCount > 1) {
      const taskDetails = inProgressTodos
        .map(t => `"${t.task}" (id: ${t.id})`)
        .join(', ');
      return `Only ONE task can be "in_progress" at a time. Found ${inProgressCount} in_progress tasks: ${taskDetails}. Use the todo tool to mark all but one as pending.`;
    }

    return null;
  }

  /**
   * Validate all todo rules in a single method
   * Returns the first validation error encountered, or null if all validations pass
   */
  validateAllRules(todos: TodoItem[]): string | null {
    // Validate "at most ONE in_progress" rule
    return this.validateAtMostOneInProgress(todos);
  }
}
