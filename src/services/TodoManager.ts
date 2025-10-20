/**
 * TodoManager - Shared todo list management service
 *
 * Provides centralized storage and operations for session-based todo lists.
 * Todo items are stored in-memory and persisted to session data.
 */

import { randomUUID } from 'crypto';

export interface TodoItem {
  id: string;
  task: string;
  completed: boolean;
  created_at: string;
}

export class TodoManager {
  private todos: TodoItem[] = [];

  /**
   * Create a new todo item
   *
   * @param task - Task description
   * @returns New todo item
   */
  createTodoItem(task: string): TodoItem {
    return {
      id: randomUUID().substring(0, 8), // Short UUID for display
      task: task.trim(),
      completed: false,
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
      .filter(({ todo }) => !todo.completed);

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
      todoToComplete.completed = true;
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
      this.todos = this.todos.filter(todo => !todo.completed);
      return originalCount - this.todos.length;
    }
  }

  /**
   * Get the index of the first incomplete task
   *
   * @returns Index or null if all completed
   */
  getNextTaskIndex(): number | null {
    const index = this.todos.findIndex(todo => !todo.completed);
    return index === -1 ? null : index;
  }

  /**
   * Get all incomplete todos
   *
   * @returns Array of incomplete todo items
   */
  getIncompleteTodos(): TodoItem[] {
    return this.todos.filter(todo => !todo.completed);
  }

  /**
   * Get all completed todos
   *
   * @returns Array of completed todo items
   */
  getCompletedTodos(): TodoItem[] {
    return this.todos.filter(todo => todo.completed);
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
    const incomplete = this.getIncompleteTodos();
    const completed = this.getCompletedTodos();

    // Display incomplete tasks first
    incomplete.forEach((todo, index) => {
      if (index === 0) {
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
   * @returns Formatted todo context or null if no incomplete tasks
   */
  generateActiveContext(): string | null {
    const incomplete = this.getIncompleteTodos();

    if (incomplete.length === 0) {
      return null;
    }

    const lines: string[] = [];
    incomplete.forEach((todo, index) => {
      if (index === 0) {
        lines.push(`  NEXT: ${todo.task}`);
      } else {
        lines.push(`  ${index}. ${todo.task}`);
      }
    });

    const tasksText = lines.join('\n');
    return `**Active Todo Items:**\n${tasksText}\n\n*Use todo_complete(0) to mark the NEXT task complete as you finish each step.*`;
  }
}
