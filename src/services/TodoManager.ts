/**
 * TodoManager - Shared todo list management service
 *
 * Provides centralized storage and operations for session-based todo lists.
 * Todo items are stored in-memory and persisted to session data.
 */

import { randomUUID } from 'crypto';

export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export interface TodoItem {
  id: string;
  task: string;
  status: TodoStatus;
  activeForm: string; // Present continuous form: "Running tests", "Fixing bug"
  created_at: string;
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
      id: randomUUID().substring(0, 8),
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
   * @param todos - New todo list
   */
  setTodos(todos: TodoItem[]): void {
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
   * Mark a task as complete by index (0-based, counting only incomplete tasks)
   *
   * @param index - Index of incomplete task to complete
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
