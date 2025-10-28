/**
 * TodoManager - Shared todo list management service
 *
 * Provides centralized storage and operations for session-based todo lists.
 * Todo items are stored in-memory and persisted to session data.
 */

import { randomUUID } from 'crypto';
import { TEXT_LIMITS, BUFFER_SIZES, ID_GENERATION } from '../config/constants.js';

export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export interface ToolCallRecord {
  toolName: string;
  args: string; // Brief description of arguments
  timestamp: number;
}

export interface TodoItem {
  id: string;
  task: string;
  status: TodoStatus;
  activeForm: string; // Present continuous form: "Running tests", "Fixing bug"
  created_at: string;
  toolCalls?: ToolCallRecord[]; // Track tool calls made while working on this todo
}

export class TodoManager {
  private todos: TodoItem[] = [];

  /**
   * Create a new todo item
   *
   * @param task - Task description
   * @param status - Todo status (default: pending)
   * @param activeForm - Present continuous form of task
   * @returns New todo item
   */
  createTodoItem(task: string, status: TodoStatus = 'pending', activeForm?: string): TodoItem {
    return {
      id: randomUUID().substring(0, ID_GENERATION.TODO_ID_LENGTH),
      task: task.trim(),
      status,
      activeForm: activeForm || task.trim(), // Default to task if not provided
      created_at: new Date().toISOString(),
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
   * Preserves tool call history for todos that remain in_progress with the same task content.
   *
   * @param todos - New todo list
   */
  setTodos(todos: TodoItem[]): void {
    // Preserve tool call history for matching in_progress todos
    const oldInProgress = this.todos.find(t => t.status === 'in_progress');

    if (oldInProgress && oldInProgress.toolCalls && oldInProgress.toolCalls.length > 0) {
      // Find matching todo in new list (same task content and still in_progress)
      const matchingTodo = todos.find(
        t => t.status === 'in_progress' && t.task === oldInProgress.task
      );

      if (matchingTodo) {
        // Preserve tool call history
        matchingTodo.toolCalls = oldInProgress.toolCalls;
      }
      // If no match (todo was completed, changed, or removed), history is lost (intentional)
    }

    this.todos = todos;
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
    // Clear tool call history when marking complete
    if (todo.toolCalls) {
      delete todo.toolCalls;
    }
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
      return originalCount;
    } else {
      this.todos = this.todos.filter(todo => todo.status !== 'completed');
      return originalCount - this.todos.length;
    }
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
   * Record a tool call for the current in-progress todo
   *
   * @param toolName - Name of the tool
   * @param args - Tool arguments (will be truncated for display)
   */
  recordToolCall(toolName: string, args: Record<string, any>): void {
    const inProgressTodo = this.getInProgressTodo();
    if (!inProgressTodo) {
      return; // No in-progress todo to track against
    }

    // Initialize toolCalls array if it doesn't exist
    if (!inProgressTodo.toolCalls) {
      inProgressTodo.toolCalls = [];
    }

    // Create brief description of args (similar to chat display)
    const argStr = this.formatToolArgs(toolName, args);

    inProgressTodo.toolCalls.push({
      toolName,
      args: argStr,
      timestamp: Date.now(),
    });
  }

  /**
   * Format tool arguments for brief display
   *
   * @param toolName - Name of the tool
   * @param args - Tool arguments
   * @returns Brief string representation
   */
  private formatToolArgs(toolName: string, args: Record<string, any>): string {
    // Extract key parameters based on tool type
    if (toolName === 'read' && args.file_paths) {
      const paths = Array.isArray(args.file_paths) ? args.file_paths : [args.file_paths];
      return paths.slice(0, BUFFER_SIZES.TODO_FILE_PATHS_DISPLAY).join(', ') + (paths.length > BUFFER_SIZES.TODO_FILE_PATHS_DISPLAY ? '...' : '');
    } else if (toolName === 'write' && args.file_path) {
      return args.file_path;
    } else if (toolName === 'edit' && args.file_path) {
      return args.file_path;
    } else if (toolName === 'bash' && args.command) {
      return args.command.substring(0, TEXT_LIMITS.COMMAND_DISPLAY_MAX) + (args.command.length > TEXT_LIMITS.COMMAND_DISPLAY_MAX ? '...' : '');
    } else if (toolName === 'grep' && args.pattern) {
      return `"${args.pattern}"`;
    } else if (toolName === 'glob' && args.pattern) {
      return args.pattern;
    } else if (toolName === 'ls' && args.path) {
      return args.path;
    }

    // Generic fallback: show first key-value pair
    const keys = Object.keys(args);
    if (keys.length > 0 && keys[0]) {
      const firstKey = keys[0];
      const value = String(args[firstKey]);
      return value.substring(0, TEXT_LIMITS.VALUE_DISPLAY_MAX) + (value.length > TEXT_LIMITS.VALUE_DISPLAY_MAX ? '...' : '');
    }

    return '';
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
      lines.push(`  → IN PROGRESS: ${inProgress.task}`);
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
    return `**Your Current Tasks:**\n${tasksText}\n\n*Update your todo list with todo_write, marking tasks as 'in_progress' or 'completed' as you work.*`;
  }
}
