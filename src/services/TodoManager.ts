/**
 * TodoManager - Shared todo list management service
 *
 * Provides centralized storage and operations for session-based todo lists.
 * Todo items are stored in-memory and persisted to session data.
 * Emits events when todos change for immediate UI updates.
 */

import { randomUUID } from 'crypto';
import { TEXT_LIMITS, BUFFER_SIZES, ID_GENERATION } from '../config/constants.js';
import { ActivityStream } from './ActivityStream.js';
import { ActivityEventType } from '../types/index.js';

export type TodoStatus = 'proposed' | 'pending' | 'in_progress' | 'completed';

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
  dependencies?: string[]; // IDs of todos that must complete first
  subtasks?: TodoItem[]; // Nested subtasks (max depth 1)
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
   * @param activeForm - Present continuous form of task
   * @param dependencies - Optional array of todo IDs that must complete first
   * @param subtasks - Optional array of nested subtasks
   * @returns New todo item
   */
  createTodoItem(
    task: string,
    status: TodoStatus = 'pending',
    activeForm?: string,
    dependencies?: string[],
    subtasks?: TodoItem[]
  ): TodoItem {
    const item: TodoItem = {
      id: randomUUID().substring(0, ID_GENERATION.TODO_ID_LENGTH),
      task: task.trim(),
      status,
      activeForm: activeForm || task.trim(),
      created_at: new Date().toISOString(),
    };

    if (dependencies && dependencies.length > 0) {
      item.dependencies = dependencies;
    }
    if (subtasks && subtasks.length > 0) {
      item.subtasks = subtasks;
    }

    return item;
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
   * Auto-completes parents when all subtasks are complete.
   *
   * @param todos - New todo list
   */
  setTodos(todos: TodoItem[]): void {
    // Auto-complete parents when all subtasks complete
    todos = this.autoCompleteParents(todos);

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
    // Clear tool call history when marking complete
    if (todo.toolCalls) {
      delete todo.toolCalls;
    }
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
    const firstKey = keys[0];
    if (firstKey !== undefined) {
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
    const proposed = this.todos.filter(t => t.status === 'proposed');
    const completed = this.getCompletedTodos();
    const blockedIds = this.getBlockedTodoIds();

    // Show in-progress task with subtasks
    if (inProgress) {
      lines.push(`  [ACTIVE] ${inProgress.task}`);
      if (inProgress.subtasks && inProgress.subtasks.length > 0) {
        inProgress.subtasks.forEach(subtask => {
          const prefix = subtask.status === 'in_progress' ? 'ACTIVE' : subtask.status === 'completed' ? 'DONE' : 'PENDING';
          lines.push(`    - [${prefix}] ${subtask.task}`);
        });
      }
    }

    // Split pending into ready and blocked
    const readyPending = pending.filter(t => !blockedIds.has(t.id));
    const blockedPending = pending.filter(t => blockedIds.has(t.id));

    // Show ready pending tasks
    if (readyPending.length > 0) {
      lines.push(`  PENDING (READY):`);
      readyPending.forEach((todo, index) => {
        lines.push(`    ${index + 1}. ${todo.task}`);
      });
    }

    // Show blocked pending tasks
    if (blockedPending.length > 0) {
      lines.push(`  PENDING (BLOCKED):`);
      blockedPending.forEach((todo, index) => {
        const depNames = this.getDependencyNames(todo.id);
        lines.push(`    ${index + 1}. ${todo.task} (waiting on: ${depNames.join(', ')})`);
      });
    }

    // Show proposed tasks (awaiting decision)
    if (proposed.length > 0) {
      lines.push(`  PROPOSED (awaiting decision):`);
      proposed.forEach((todo, index) => {
        lines.push(`    ${index + 1}. ${todo.task}`);
      });
    }

    // Show completed tasks with subtasks
    if (completed.length > 0) {
      lines.push(`  COMPLETED:`);
      completed.forEach(todo => {
        lines.push(`    ✓ ${todo.task}`);
        if (todo.subtasks && todo.subtasks.length > 0) {
          todo.subtasks.forEach(subtask => {
            lines.push(`      ✓ ${subtask.task}`);
          });
        }
      });
    }

    const tasksText = lines.join('\n');
    const helperText = proposed.length > 0
      ? '*Manage todos with todo_add/todo_update/todo_remove/todo_clear. Proposed todos must be confirmed, modified, or declined. Blocked todos cannot be in_progress until dependencies complete. Completing all subtasks auto-completes the parent.*'
      : '*Manage todos with todo_add/todo_update/todo_remove/todo_clear. Blocked todos cannot be in_progress until dependencies complete. Completing all subtasks auto-completes the parent.*';
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
      console.log('[TODO_CONTEXT]', contextString.substring(0, 150) + (contextString.length > 150 ? '...' : ''));
      this.lastLoggedContext = contextString;
    }
  }

  /**
   * Get IDs of blocked todos (have incomplete dependencies)
   */
  getBlockedTodoIds(todos?: TodoItem[]): Set<string> {
    const todoList = todos || this.todos;
    const completedIds = new Set(todoList.filter(t => t.status === 'completed').map(t => t.id));
    const blocked = new Set<string>();

    for (const todo of todoList) {
      if (todo.dependencies && todo.dependencies.length > 0) {
        const hasIncompleteDeps = todo.dependencies.some(depId => !completedIds.has(depId));
        if (hasIncompleteDeps) {
          blocked.add(todo.id);
        }
      }
    }

    return blocked;
  }

  /**
   * Get names of dependencies for a todo
   */
  getDependencyNames(todoId: string): string[] {
    const todo = this.todos.find(t => t.id === todoId);
    if (!todo || !todo.dependencies) return [];

    return todo.dependencies
      .map(depId => this.todos.find(t => t.id === depId)?.task)
      .filter((name): name is string => name !== undefined);
  }

  /**
   * Auto-complete parents when all subtasks complete
   */
  autoCompleteParents(todos: TodoItem[]): TodoItem[] {
    return todos.map(todo => {
      if (todo.subtasks && todo.subtasks.length > 0) {
        const allSubtasksComplete = todo.subtasks.every(st => st.status === 'completed');
        if (allSubtasksComplete && todo.status !== 'completed') {
          return { ...todo, status: 'completed' as TodoStatus };
        }
      }
      return todo;
    });
  }

  /**
   * Validate dependencies exist and no circular references
   */
  validateDependencies(todos: TodoItem[]): string | null {
    const todoIds = new Set(todos.map(t => t.id));

    // Check all dependencies exist
    for (const todo of todos) {
      if (todo.dependencies) {
        for (const depId of todo.dependencies) {
          if (!todoIds.has(depId)) {
            return `Todo "${todo.task}" depends on non-existent todo ID: ${depId}`;
          }
        }
      }
    }

    // Check for circular dependencies
    const visited = new Set<string>();
    const recursionStack = new Set<string>();

    const hasCycle = (todoId: string): boolean => {
      if (recursionStack.has(todoId)) return true;
      if (visited.has(todoId)) return false;

      visited.add(todoId);
      recursionStack.add(todoId);

      const todo = todos.find(t => t.id === todoId);
      if (todo?.dependencies) {
        for (const depId of todo.dependencies) {
          if (hasCycle(depId)) return true;
        }
      }

      recursionStack.delete(todoId);
      return false;
    };

    for (const todo of todos) {
      if (hasCycle(todo.id)) {
        return `Circular dependency detected involving todo: "${todo.task}"`;
      }
    }

    return null;
  }

  /**
   * Validate subtask depth (max 1 level)
   */
  validateSubtaskDepth(todos: TodoItem[]): string | null {
    for (const todo of todos) {
      if (todo.subtasks) {
        for (const subtask of todo.subtasks) {
          if (subtask.subtasks && subtask.subtasks.length > 0) {
            return `Subtasks cannot have nested subtasks. Maximum depth is 1. Parent: "${todo.task}"`;
          }
        }
      }
    }
    return null;
  }

  /**
   * Validate blocked todos are not in_progress
   *
   * Ensures todos with incomplete dependencies cannot be marked as in_progress.
   */
  validateInProgressNotBlocked(todos: TodoItem[]): string | null {
    const blockedIds = this.getBlockedTodoIds(todos);
    const blockedInProgress = todos.filter(t =>
      t.status === 'in_progress' && blockedIds.has(t.id)
    );

    if (blockedInProgress.length > 0 && blockedInProgress[0]) {
      const todo = blockedInProgress[0];
      const depNames = this.getDependencyNames(todo.id);
      return `Cannot mark blocked todo as in_progress: "${todo.task}" (id: ${todo.id}). Complete dependencies first: ${depNames.join(', ')}. Use todo_update to mark this as pending until dependencies complete.`;
    }

    return null;
  }

  /**
   * Validate subtask in_progress rule
   *
   * When a parent has incomplete subtasks, ensures exactly one subtask is in_progress
   * to maintain focus and clarity about which subtask is being actively worked on.
   */
  validateSubtaskInProgress(parent: TodoItem): string | null {
    if (!parent.subtasks || parent.subtasks.length === 0) return null;

    const incompleteSubtasks = parent.subtasks.filter(
      st => st.status === 'pending' || st.status === 'in_progress'
    );
    const inProgressSubtasks = parent.subtasks.filter(st => st.status === 'in_progress');

    if (incompleteSubtasks.length > 0) {
      if (inProgressSubtasks.length === 0) {
        const pendingNames = incompleteSubtasks.map(st => `"${st.task}"`).join(', ');
        return `Parent "${parent.task}" has incomplete subtasks but none are in_progress. Mark one of these as in_progress: ${pendingNames}`;
      }
      if (inProgressSubtasks.length > 1) {
        const inProgressNames = inProgressSubtasks.map(st => `"${st.task}"`).join(', ');
        return `Parent "${parent.task}" has ${inProgressSubtasks.length} subtasks in_progress: ${inProgressNames}. Only ONE subtask can be in_progress at a time. Mark all but one as pending.`;
      }
    }

    return null;
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
      return `Only ONE task can be "in_progress" at a time. Found ${inProgressCount} in_progress tasks: ${taskDetails}. Use todo_update to mark all but one as pending.`;
    }

    return null;
  }

  /**
   * Validate all todo rules in a single method
   * Returns the first validation error encountered, or null if all validations pass
   */
  validateAllRules(todos: TodoItem[]): string | null {
    // Validate dependencies exist and no circular refs
    const depError = this.validateDependencies(todos);
    if (depError) return depError;

    // Validate subtask depth (max 1)
    const depthError = this.validateSubtaskDepth(todos);
    if (depthError) return depthError;

    // Validate blocked todos not in_progress
    const blockedError = this.validateInProgressNotBlocked(todos);
    if (blockedError) return blockedError;

    // Validate "at most ONE in_progress" rule
    const inProgressError = this.validateAtMostOneInProgress(todos);
    if (inProgressError) return inProgressError;

    // Validate subtask in_progress rule for the current in_progress parent
    const inProgressParent = todos.find(t => t.status === 'in_progress');
    if (inProgressParent) {
      const subtaskError = this.validateSubtaskInProgress(inProgressParent);
      if (subtaskError) return subtaskError;
    }

    return null;
  }
}
