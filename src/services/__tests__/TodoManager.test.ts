/**
 * TodoManager unit tests
 *
 * Tests todo item creation, updates, removal, and complex validation rules
 * including dependencies, subtasks, and state management.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TodoManager, TodoItem, TodoStatus } from '../TodoManager.js';
import { ActivityStream } from '../ActivityStream.js';
import { ActivityEventType } from '@shared/index.js';

describe('TodoManager', () => {
  let todoManager: TodoManager;
  let activityStream: ActivityStream;

  beforeEach(() => {
    activityStream = new ActivityStream();
    todoManager = new TodoManager(activityStream);
  });

  afterEach(() => {
    activityStream.cleanup();
  });

  describe('createTodoItem', () => {
    it('should create todo with default status', () => {
      const todo = todoManager.createTodoItem('Test task');

      expect(todo.id).toBeDefined();
      expect(todo.task).toBe('Test task');
      expect(todo.status).toBe('pending');
    });

    it('should create todo with custom status', () => {
      const todo = todoManager.createTodoItem('Test task', 'in_progress');

      expect(todo.status).toBe('in_progress');
    });

    it('should trim task text', () => {
      const todo = todoManager.createTodoItem('  Test task  ');

      expect(todo.task).toBe('Test task');
    });

    it('should generate unique IDs', () => {
      const todo1 = todoManager.createTodoItem('Task 1');
      const todo2 = todoManager.createTodoItem('Task 2');

      expect(todo1.id).not.toBe(todo2.id);
    });
  });

  describe('getTodos', () => {
    it('should return empty array when no todos', () => {
      expect(todoManager.getTodos()).toEqual([]);
    });

    it('should return all todos', () => {
      const todos = [
        todoManager.createTodoItem('Task 1'),
        todoManager.createTodoItem('Task 2'),
      ];
      todoManager.setTodos(todos);

      expect(todoManager.getTodos()).toEqual(todos);
    });

    it('should return copy of todos array', () => {
      const todos = [todoManager.createTodoItem('Task 1')];
      todoManager.setTodos(todos);

      const returned = todoManager.getTodos();
      returned.push(todoManager.createTodoItem('Task 2'));

      // Original should not be modified
      expect(todoManager.getTodos()).toHaveLength(1);
    });
  });

  describe('setTodos', () => {
    it('should set todos list', () => {
      const todos = [
        todoManager.createTodoItem('Task 1'),
        todoManager.createTodoItem('Task 2'),
      ];

      todoManager.setTodos(todos);

      expect(todoManager.getTodos()).toEqual(todos);
    });

    it('should emit TODO_UPDATE event', () => {
      const callback = vi.fn();
      activityStream.subscribe(ActivityEventType.TODO_UPDATE, callback);

      const todos = [todoManager.createTodoItem('Task 1')];
      todoManager.setTodos(todos);

      expect(callback).toHaveBeenCalled();
      expect(callback.mock.calls[0]?.[0].data.todos).toEqual(todos);
    });
  });

  describe('addTodos', () => {
    it('should add new todos to list', () => {
      const newTodos = todoManager.addTodos(['Task 1', 'Task 2']);

      expect(newTodos).toHaveLength(2);
      expect(todoManager.getTodos()).toHaveLength(2);
    });

    it('should emit TODO_UPDATE event', () => {
      const callback = vi.fn();
      activityStream.subscribe(ActivityEventType.TODO_UPDATE, callback);

      todoManager.addTodos(['Task 1']);

      expect(callback).toHaveBeenCalled();
    });

    it('should preserve existing todos', () => {
      const existing = [todoManager.createTodoItem('Existing')];
      todoManager.setTodos(existing);

      todoManager.addTodos(['New task']);

      expect(todoManager.getTodos()).toHaveLength(2);
      expect(todoManager.getTodos()[0]?.task).toBe('Existing');
    });

    it('should return created todo items', () => {
      const newTodos = todoManager.addTodos(['Task 1', 'Task 2']);

      expect(newTodos[0]?.task).toBe('Task 1');
      expect(newTodos[1]?.task).toBe('Task 2');
      expect(newTodos[0]?.id).toBeDefined();
    });
  });

  describe('completeTodoByIndex', () => {
    it('should complete todo by incomplete index', () => {
      const todos = [
        todoManager.createTodoItem('Task 1', 'pending'),
        todoManager.createTodoItem('Task 2', 'pending'),
      ];
      todoManager.setTodos(todos);

      const completed = todoManager.completeTodoByIndex(0);

      expect(completed).toBeDefined();
      expect(completed?.task).toBe('Task 1');
      expect(todoManager.getTodos()[0]?.status).toBe('completed');
    });

    it('should skip completed todos when counting index', () => {
      const todos = [
        todoManager.createTodoItem('Task 1', 'completed'),
        todoManager.createTodoItem('Task 2', 'pending'),
        todoManager.createTodoItem('Task 3', 'pending'),
      ];
      todoManager.setTodos(todos);

      // Index 0 should refer to "Task 2" (first incomplete)
      const completed = todoManager.completeTodoByIndex(0);

      expect(completed?.task).toBe('Task 2');
      expect(todoManager.getTodos()[1]?.status).toBe('completed');
    });

    it('should return null for invalid index', () => {
      const todos = [todoManager.createTodoItem('Task 1', 'pending')];
      todoManager.setTodos(todos);

      expect(todoManager.completeTodoByIndex(5)).toBeNull();
      expect(todoManager.completeTodoByIndex(-1)).toBeNull();
    });

    it('should return null for empty list', () => {
      expect(todoManager.completeTodoByIndex(0)).toBeNull();
    });
  });

  describe('completeTodoById', () => {
    it('should complete todo by ID', () => {
      const todo = todoManager.createTodoItem('Task 1', 'pending');
      todoManager.setTodos([todo]);

      const completed = todoManager.completeTodoById(todo.id);

      expect(completed).toBeDefined();
      expect(completed?.status).toBe('completed');
      expect(todoManager.getTodos()[0]?.status).toBe('completed');
    });

    it('should return null for non-existent ID', () => {
      expect(todoManager.completeTodoById('non-existent')).toBeNull();
    });

    it('should preserve other todo fields', () => {
      const todo = todoManager.createTodoItem('Task 1', 'pending');
      const originalId = todo.id;
      const originalTask = todo.task;
      todoManager.setTodos([todo]);

      todoManager.completeTodoById(todo.id);

      const todos = todoManager.getTodos();
      expect(todos[0]?.id).toBe(originalId);
      expect(todos[0]?.task).toBe(originalTask);
    });
  });

  describe('clearTodos', () => {
    it('should clear all todos when clearAll is true', () => {
      const todos = [
        todoManager.createTodoItem('Task 1', 'pending'),
        todoManager.createTodoItem('Task 2', 'completed'),
      ];
      todoManager.setTodos(todos);

      const cleared = todoManager.clearTodos(true);

      expect(cleared).toBe(2);
      expect(todoManager.getTodos()).toEqual([]);
    });

    it('should clear only completed todos when clearAll is false', () => {
      const todos = [
        todoManager.createTodoItem('Task 1', 'pending'),
        todoManager.createTodoItem('Task 2', 'completed'),
        todoManager.createTodoItem('Task 3', 'in_progress'),
      ];
      todoManager.setTodos(todos);

      const cleared = todoManager.clearTodos(false);

      expect(cleared).toBe(1);
      expect(todoManager.getTodos()).toHaveLength(2);
      expect(todoManager.getTodos().find(t => t.task === 'Task 2')).toBeUndefined();
    });

    it('should default to clearing only completed', () => {
      const todos = [
        todoManager.createTodoItem('Task 1', 'pending'),
        todoManager.createTodoItem('Task 2', 'completed'),
      ];
      todoManager.setTodos(todos);

      const cleared = todoManager.clearTodos();

      expect(cleared).toBe(1);
      expect(todoManager.getTodos()).toHaveLength(1);
    });

    it('should return 0 when no todos to clear', () => {
      expect(todoManager.clearTodos()).toBe(0);
    });
  });

  describe('getNextTaskIndex', () => {
    it('should return index of first incomplete task', () => {
      const todos = [
        todoManager.createTodoItem('Task 1', 'completed'),
        todoManager.createTodoItem('Task 2', 'pending'),
        todoManager.createTodoItem('Task 3', 'in_progress'),
      ];
      todoManager.setTodos(todos);

      expect(todoManager.getNextTaskIndex()).toBe(1);
    });

    it('should return null when all completed', () => {
      const todos = [
        todoManager.createTodoItem('Task 1', 'completed'),
        todoManager.createTodoItem('Task 2', 'completed'),
      ];
      todoManager.setTodos(todos);

      expect(todoManager.getNextTaskIndex()).toBeNull();
    });

    it('should return null for empty list', () => {
      expect(todoManager.getNextTaskIndex()).toBeNull();
    });
  });

  describe('getIncompleteTodos', () => {
    it('should return only incomplete todos', () => {
      const todos = [
        todoManager.createTodoItem('Task 1', 'pending'),
        todoManager.createTodoItem('Task 2', 'completed'),
        todoManager.createTodoItem('Task 3', 'in_progress'),
      ];
      todoManager.setTodos(todos);

      const incomplete = todoManager.getIncompleteTodos();

      expect(incomplete).toHaveLength(2);
      expect(incomplete.find(t => t.task === 'Task 2')).toBeUndefined();
    });

    it('should return empty array when all completed', () => {
      const todos = [todoManager.createTodoItem('Task 1', 'completed')];
      todoManager.setTodos(todos);

      expect(todoManager.getIncompleteTodos()).toEqual([]);
    });
  });

  describe('getCompletedTodos', () => {
    it('should return only completed todos', () => {
      const todos = [
        todoManager.createTodoItem('Task 1', 'pending'),
        todoManager.createTodoItem('Task 2', 'completed'),
        todoManager.createTodoItem('Task 3', 'completed'),
      ];
      todoManager.setTodos(todos);

      const completed = todoManager.getCompletedTodos();

      expect(completed).toHaveLength(2);
      expect(completed.every(t => t.status === 'completed')).toBe(true);
    });

    it('should return empty array when none completed', () => {
      const todos = [todoManager.createTodoItem('Task 1', 'pending')];
      todoManager.setTodos(todos);

      expect(todoManager.getCompletedTodos()).toEqual([]);
    });
  });

  describe('getInProgressTodo', () => {
    it('should return in_progress todo', () => {
      const todos = [
        todoManager.createTodoItem('Task 1', 'pending'),
        todoManager.createTodoItem('Task 2', 'in_progress'),
        todoManager.createTodoItem('Task 3', 'completed'),
      ];
      todoManager.setTodos(todos);

      const inProgress = todoManager.getInProgressTodo();

      expect(inProgress?.task).toBe('Task 2');
    });

    it('should return null when no in_progress todo', () => {
      const todos = [todoManager.createTodoItem('Task 1', 'pending')];
      todoManager.setTodos(todos);

      expect(todoManager.getInProgressTodo()).toBeNull();
    });

    it('should return first in_progress when multiple exist', () => {
      const todos = [
        todoManager.createTodoItem('Task 1', 'in_progress'),
        todoManager.createTodoItem('Task 2', 'in_progress'),
      ];
      todoManager.setTodos(todos);

      expect(todoManager.getInProgressTodo()?.task).toBe('Task 1');
    });
  });


  describe('getNextPendingTodo', () => {
    it('should return first pending todo', () => {
      const todos = [
        todoManager.createTodoItem('Task 1', 'completed'),
        todoManager.createTodoItem('Task 2', 'pending'),
        todoManager.createTodoItem('Task 3', 'pending'),
      ];
      todoManager.setTodos(todos);

      expect(todoManager.getNextPendingTodo()?.task).toBe('Task 2');
    });

    it('should return null when no pending todos', () => {
      const todos = [
        todoManager.createTodoItem('Task 1', 'completed'),
        todoManager.createTodoItem('Task 2', 'in_progress'),
      ];
      todoManager.setTodos(todos);

      expect(todoManager.getNextPendingTodo()).toBeNull();
    });
  });


  describe('validation', () => {
    describe('validateAtMostOneInProgress', () => {
      it('should pass when zero in_progress', () => {
        const todos = [todoManager.createTodoItem('Task', 'pending')];

        const error = todoManager.validateAtMostOneInProgress(todos);

        expect(error).toBeNull();
      });

      it('should pass when one in_progress', () => {
        const todos = [
          todoManager.createTodoItem('Task 1', 'in_progress'),
          todoManager.createTodoItem('Task 2', 'pending'),
        ];

        const error = todoManager.validateAtMostOneInProgress(todos);

        expect(error).toBeNull();
      });

      it('should fail when multiple in_progress', () => {
        const todos = [
          todoManager.createTodoItem('Task 1', 'in_progress'),
          todoManager.createTodoItem('Task 2', 'in_progress'),
        ];

        const error = todoManager.validateAtMostOneInProgress(todos);

        expect(error).toContain('Only ONE task can be "in_progress"');
      });
    });

    describe('validateAllRules', () => {
      it('should pass when all rules satisfied', () => {
        const todos = [
          todoManager.createTodoItem('Task 1', 'in_progress'),
          todoManager.createTodoItem('Task 2', 'pending'),
        ];

        const error = todoManager.validateAllRules(todos);

        expect(error).toBeNull();
      });

      it('should return error when multiple in_progress', () => {
        const todos = [
          todoManager.createTodoItem('Task 1', 'in_progress'),
          todoManager.createTodoItem('Task 2', 'in_progress'),
        ];

        const error = todoManager.validateAllRules(todos);

        expect(error).not.toBeNull();
        expect(error).toContain('Only ONE task');
      });
    });
  });

  describe('generateActiveContext', () => {
    it('should return null for empty list', () => {
      expect(todoManager.generateActiveContext()).toBeNull();
    });

    it('should include in_progress task', () => {
      const todos = [todoManager.createTodoItem('Task 1', 'in_progress')];
      todoManager.setTodos(todos);

      const context = todoManager.generateActiveContext();

      expect(context).toContain('[ACTIVE]');
      expect(context).toContain('Task 1');
    });

    it('should include pending tasks', () => {
      const todos = [
        todoManager.createTodoItem('Task 1', 'in_progress'),
        todoManager.createTodoItem('Task 2', 'pending'),
      ];
      todoManager.setTodos(todos);

      const context = todoManager.generateActiveContext();

      expect(context).toContain('PENDING');
      expect(context).toContain('Task 2');
    });

    it('should include completed tasks', () => {
      const todos = [
        todoManager.createTodoItem('Task 1', 'completed'),
        todoManager.createTodoItem('Task 2', 'pending'),
      ];
      todoManager.setTodos(todos);

      const context = todoManager.generateActiveContext();

      expect(context).toContain('COMPLETED');
      expect(context).toContain('Task 1');
    });
  });

  describe('without ActivityStream', () => {
    it('should work without ActivityStream', () => {
      const manager = new TodoManager();
      const todos = [manager.createTodoItem('Task 1')];

      // Should not throw
      expect(() => manager.setTodos(todos)).not.toThrow();
      expect(manager.getTodos()).toEqual(todos);
    });

    it('should not emit events without ActivityStream', () => {
      const manager = new TodoManager();
      const todos = [manager.createTodoItem('Task 1')];

      // Should not throw
      expect(() => manager.addTodos(['Task 2'])).not.toThrow();
    });
  });

  describe('formatTodoUI', () => {
    it('should return dimmed message for empty list', () => {
      const ui = todoManager.formatTodoUI();
      expect(ui).toContain('No todos');
    });

    it('should format todos for display', () => {
      const todos = [
        todoManager.createTodoItem('Task 1', 'in_progress'),
        todoManager.createTodoItem('Task 2', 'pending'),
        todoManager.createTodoItem('Task 3', 'completed'),
      ];
      todoManager.setTodos(todos);

      const ui = todoManager.formatTodoUI();

      expect(ui).toContain('IN PROGRESS');
      expect(ui).toContain('Task 1');
      expect(ui).toContain('Task 2');
      expect(ui).toContain('Task 3');
    });
  });

  describe('logTodosIfChanged', () => {
    it('should log when context changes', async () => {
      const { logger } = await import('../Logger.js');
      const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});

      const todos = [todoManager.createTodoItem('Task 1')];
      todoManager.setTodos(todos);
      todoManager.logTodosIfChanged();

      expect(debugSpy).toHaveBeenCalledWith(
        '[TODO_CONTEXT]',
        expect.stringContaining('Task 1')
      );

      debugSpy.mockRestore();
    });

    it('should not log when context unchanged', async () => {
      const { logger } = await import('../Logger.js');
      const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});

      const todos = [todoManager.createTodoItem('Task 1')];
      todoManager.setTodos(todos);
      todoManager.logTodosIfChanged();

      debugSpy.mockClear();

      // Log again without changes
      todoManager.logTodosIfChanged();

      expect(debugSpy).not.toHaveBeenCalled();

      debugSpy.mockRestore();
    });
  });
});
