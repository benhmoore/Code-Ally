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
      expect(todo.activeForm).toBe('Test task');
      expect(todo.created_at).toBeDefined();
    });

    it('should create todo with custom status', () => {
      const todo = todoManager.createTodoItem('Test task', 'in_progress');

      expect(todo.status).toBe('in_progress');
    });

    it('should create todo with custom activeForm', () => {
      const todo = todoManager.createTodoItem('Fix bug', 'pending', 'Fixing bug');

      expect(todo.task).toBe('Fix bug');
      expect(todo.activeForm).toBe('Fixing bug');
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

    it('should create todo with dependencies', () => {
      const todo = todoManager.createTodoItem('Task', 'pending', undefined, ['dep-1', 'dep-2']);

      expect(todo.dependencies).toEqual(['dep-1', 'dep-2']);
    });

    it('should create todo with subtasks', () => {
      const subtask1 = todoManager.createTodoItem('Subtask 1');
      const subtask2 = todoManager.createTodoItem('Subtask 2');

      const parent = todoManager.createTodoItem('Parent', 'pending', undefined, undefined, [
        subtask1,
        subtask2,
      ]);

      expect(parent.subtasks).toEqual([subtask1, subtask2]);
      expect(parent.subtasks).toHaveLength(2);
    });

    it('should not add empty dependencies array', () => {
      const todo = todoManager.createTodoItem('Task', 'pending', undefined, []);

      expect(todo.dependencies).toBeUndefined();
    });

    it('should not add empty subtasks array', () => {
      const todo = todoManager.createTodoItem('Task', 'pending', undefined, undefined, []);

      expect(todo.subtasks).toBeUndefined();
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

    it('should preserve tool call history for matching in_progress todo', () => {
      const todo1 = todoManager.createTodoItem('Task 1', 'in_progress');
      todo1.toolCalls = [
        { toolName: 'read', args: 'file.ts', timestamp: Date.now() },
      ];
      todoManager.setTodos([todo1]);

      // Update with same task content and status
      const todo2 = todoManager.createTodoItem('Task 1', 'in_progress');
      todoManager.setTodos([todo2]);

      const todos = todoManager.getTodos();
      expect(todos[0]?.toolCalls).toBeDefined();
      expect(todos[0]?.toolCalls).toHaveLength(1);
    });

    it('should not preserve tool call history if task changed', () => {
      const todo1 = todoManager.createTodoItem('Task 1', 'in_progress');
      todo1.toolCalls = [
        { toolName: 'read', args: 'file.ts', timestamp: Date.now() },
      ];
      todoManager.setTodos([todo1]);

      // Update with different task
      const todo2 = todoManager.createTodoItem('Task 2', 'in_progress');
      todoManager.setTodos([todo2]);

      const todos = todoManager.getTodos();
      expect(todos[0]?.toolCalls).toBeUndefined();
    });

    it('should not preserve tool call history if todo completed', () => {
      const todo1 = todoManager.createTodoItem('Task 1', 'in_progress');
      todo1.toolCalls = [
        { toolName: 'read', args: 'file.ts', timestamp: Date.now() },
      ];
      todoManager.setTodos([todo1]);

      // Update to completed
      const todo2 = todoManager.createTodoItem('Task 1', 'completed');
      todoManager.setTodos([todo2]);

      const todos = todoManager.getTodos();
      expect(todos[0]?.toolCalls).toBeUndefined();
    });

    it('should auto-complete parents when all subtasks complete', () => {
      const subtask1 = todoManager.createTodoItem('Subtask 1', 'completed');
      const subtask2 = todoManager.createTodoItem('Subtask 2', 'completed');
      const parent = todoManager.createTodoItem('Parent', 'in_progress', undefined, undefined, [
        subtask1,
        subtask2,
      ]);

      todoManager.setTodos([parent]);

      const todos = todoManager.getTodos();
      expect(todos[0]?.status).toBe('completed');
    });

    it('should not auto-complete parent if subtasks incomplete', () => {
      const subtask1 = todoManager.createTodoItem('Subtask 1', 'completed');
      const subtask2 = todoManager.createTodoItem('Subtask 2', 'pending');
      const parent = todoManager.createTodoItem('Parent', 'in_progress', undefined, undefined, [
        subtask1,
        subtask2,
      ]);

      todoManager.setTodos([parent]);

      const todos = todoManager.getTodos();
      expect(todos[0]?.status).toBe('in_progress');
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

    it('should clear tool call history when completing', () => {
      const todo = todoManager.createTodoItem('Task 1', 'in_progress');
      todo.toolCalls = [
        { toolName: 'read', args: 'file.ts', timestamp: Date.now() },
      ];
      todoManager.setTodos([todo]);

      todoManager.completeTodoById(todo.id);

      const todos = todoManager.getTodos();
      expect(todos[0]?.toolCalls).toBeUndefined();
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

  describe('recordToolCall', () => {
    it('should record tool call for in_progress todo', () => {
      const todo = todoManager.createTodoItem('Task 1', 'in_progress');
      todoManager.setTodos([todo]);

      todoManager.recordToolCall('read', { file_paths: ['test.ts'] });

      const inProgress = todoManager.getInProgressTodo();
      expect(inProgress?.toolCalls).toHaveLength(1);
      expect(inProgress?.toolCalls?.[0]?.toolName).toBe('read');
    });

    it('should not record when no in_progress todo', () => {
      const todo = todoManager.createTodoItem('Task 1', 'pending');
      todoManager.setTodos([todo]);

      todoManager.recordToolCall('read', { file_paths: ['test.ts'] });

      expect(todo.toolCalls).toBeUndefined();
    });

    it('should accumulate multiple tool calls', () => {
      const todo = todoManager.createTodoItem('Task 1', 'in_progress');
      todoManager.setTodos([todo]);

      todoManager.recordToolCall('read', { file_paths: ['test.ts'] });
      todoManager.recordToolCall('edit', { file_path: 'test.ts' });

      const inProgress = todoManager.getInProgressTodo();
      expect(inProgress?.toolCalls).toHaveLength(2);
    });

    it('should format read tool args correctly', () => {
      const todo = todoManager.createTodoItem('Task 1', 'in_progress');
      todoManager.setTodos([todo]);

      todoManager.recordToolCall('read', { file_paths: ['a.ts', 'b.ts'] });

      const inProgress = todoManager.getInProgressTodo();
      expect(inProgress?.toolCalls?.[0]?.args).toBe('a.ts, b.ts');
    });

    it('should format bash tool args correctly', () => {
      const todo = todoManager.createTodoItem('Task 1', 'in_progress');
      todoManager.setTodos([todo]);

      todoManager.recordToolCall('bash', { command: 'npm install' });

      const inProgress = todoManager.getInProgressTodo();
      expect(inProgress?.toolCalls?.[0]?.args).toBe('npm install');
    });

    it('should truncate long file paths', () => {
      const todo = todoManager.createTodoItem('Task 1', 'in_progress');
      todoManager.setTodos([todo]);

      const manyFiles = Array(10).fill('file.ts');
      todoManager.recordToolCall('read', { file_paths: manyFiles });

      const inProgress = todoManager.getInProgressTodo();
      // Should truncate and add '...'
      expect(inProgress?.toolCalls?.[0]?.args).toContain('...');
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

  describe('getBlockedTodoIds', () => {
    it('should identify todos with incomplete dependencies', () => {
      const dep1 = todoManager.createTodoItem('Dependency 1', 'pending');
      const dep2 = todoManager.createTodoItem('Dependency 2', 'completed');
      const blocked = todoManager.createTodoItem('Blocked', 'pending', undefined, [
        dep1.id,
        dep2.id,
      ]);
      todoManager.setTodos([dep1, dep2, blocked]);

      const blockedIds = todoManager.getBlockedTodoIds();

      expect(blockedIds.has(blocked.id)).toBe(true);
    });

    it('should not include todos with all dependencies complete', () => {
      const dep1 = todoManager.createTodoItem('Dependency 1', 'completed');
      const dep2 = todoManager.createTodoItem('Dependency 2', 'completed');
      const ready = todoManager.createTodoItem('Ready', 'pending', undefined, [dep1.id, dep2.id]);
      todoManager.setTodos([dep1, dep2, ready]);

      const blockedIds = todoManager.getBlockedTodoIds();

      expect(blockedIds.has(ready.id)).toBe(false);
    });

    it('should return empty set when no dependencies', () => {
      const todos = [
        todoManager.createTodoItem('Task 1', 'pending'),
        todoManager.createTodoItem('Task 2', 'pending'),
      ];
      todoManager.setTodos(todos);

      expect(todoManager.getBlockedTodoIds().size).toBe(0);
    });
  });

  describe('getDependencyNames', () => {
    it('should return names of dependencies', () => {
      const dep1 = todoManager.createTodoItem('Dependency 1');
      const dep2 = todoManager.createTodoItem('Dependency 2');
      const todo = todoManager.createTodoItem('Task', 'pending', undefined, [dep1.id, dep2.id]);
      todoManager.setTodos([dep1, dep2, todo]);

      const names = todoManager.getDependencyNames(todo.id);

      expect(names).toEqual(['Dependency 1', 'Dependency 2']);
    });

    it('should return empty array for todo without dependencies', () => {
      const todo = todoManager.createTodoItem('Task');
      todoManager.setTodos([todo]);

      expect(todoManager.getDependencyNames(todo.id)).toEqual([]);
    });

    it('should return empty array for non-existent todo', () => {
      expect(todoManager.getDependencyNames('non-existent')).toEqual([]);
    });

    it('should filter out non-existent dependencies', () => {
      const dep1 = todoManager.createTodoItem('Dependency 1');
      const todo = todoManager.createTodoItem('Task', 'pending', undefined, [
        dep1.id,
        'non-existent',
      ]);
      todoManager.setTodos([dep1, todo]);

      const names = todoManager.getDependencyNames(todo.id);

      expect(names).toEqual(['Dependency 1']);
    });
  });

  describe('validation', () => {
    describe('validateDependencies', () => {
      it('should pass when dependencies exist', () => {
        const dep = todoManager.createTodoItem('Dependency');
        const todo = todoManager.createTodoItem('Task', 'pending', undefined, [dep.id]);

        const error = todoManager.validateDependencies([dep, todo]);

        expect(error).toBeNull();
      });

      it('should fail when dependency does not exist', () => {
        const todo = todoManager.createTodoItem('Task', 'pending', undefined, ['non-existent']);

        const error = todoManager.validateDependencies([todo]);

        expect(error).toContain('non-existent todo ID');
      });

      it('should detect circular dependencies', () => {
        const todo1 = todoManager.createTodoItem('Task 1');
        const todo2 = todoManager.createTodoItem('Task 2');
        todo1.dependencies = [todo2.id];
        todo2.dependencies = [todo1.id];

        const error = todoManager.validateDependencies([todo1, todo2]);

        expect(error).toContain('Circular dependency');
      });
    });

    describe('validateSubtaskDepth', () => {
      it('should pass for subtasks at depth 1', () => {
        const subtask = todoManager.createTodoItem('Subtask');
        const parent = todoManager.createTodoItem('Parent', 'pending', undefined, undefined, [
          subtask,
        ]);

        const error = todoManager.validateSubtaskDepth([parent]);

        expect(error).toBeNull();
      });

      it('should fail for nested subtasks', () => {
        const nested = todoManager.createTodoItem('Nested');
        const subtask = todoManager.createTodoItem('Subtask', 'pending', undefined, undefined, [
          nested,
        ]);
        const parent = todoManager.createTodoItem('Parent', 'pending', undefined, undefined, [
          subtask,
        ]);

        const error = todoManager.validateSubtaskDepth([parent]);

        expect(error).toContain('Maximum depth is 1');
      });
    });

    describe('validateInProgressNotBlocked', () => {
      it('should pass when in_progress todo is not blocked', () => {
        const dep = todoManager.createTodoItem('Dependency', 'completed');
        const todo = todoManager.createTodoItem('Task', 'in_progress', undefined, [dep.id]);

        const error = todoManager.validateInProgressNotBlocked([dep, todo]);

        expect(error).toBeNull();
      });

      it('should fail when in_progress todo is blocked', () => {
        const dep = todoManager.createTodoItem('Dependency', 'pending');
        const todo = todoManager.createTodoItem('Task', 'in_progress', undefined, [dep.id]);

        const error = todoManager.validateInProgressNotBlocked([dep, todo]);

        expect(error).toContain('Cannot mark blocked todo as in_progress');
      });
    });

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

    describe('validateSubtaskInProgress', () => {
      it('should pass when one subtask is in_progress', () => {
        const subtask1 = todoManager.createTodoItem('Subtask 1', 'in_progress');
        const subtask2 = todoManager.createTodoItem('Subtask 2', 'pending');
        const parent = todoManager.createTodoItem('Parent', 'in_progress', undefined, undefined, [
          subtask1,
          subtask2,
        ]);

        const error = todoManager.validateSubtaskInProgress(parent);

        expect(error).toBeNull();
      });

      it('should fail when no subtasks are in_progress', () => {
        const subtask1 = todoManager.createTodoItem('Subtask 1', 'pending');
        const subtask2 = todoManager.createTodoItem('Subtask 2', 'pending');
        const parent = todoManager.createTodoItem('Parent', 'in_progress', undefined, undefined, [
          subtask1,
          subtask2,
        ]);

        const error = todoManager.validateSubtaskInProgress(parent);

        expect(error).toContain('none are in_progress');
      });

      it('should fail when multiple subtasks are in_progress', () => {
        const subtask1 = todoManager.createTodoItem('Subtask 1', 'in_progress');
        const subtask2 = todoManager.createTodoItem('Subtask 2', 'in_progress');
        const parent = todoManager.createTodoItem('Parent', 'in_progress', undefined, undefined, [
          subtask1,
          subtask2,
        ]);

        const error = todoManager.validateSubtaskInProgress(parent);

        expect(error).toContain('Only ONE subtask can be in_progress');
      });

      it('should pass when all subtasks are complete', () => {
        const subtask1 = todoManager.createTodoItem('Subtask 1', 'completed');
        const subtask2 = todoManager.createTodoItem('Subtask 2', 'completed');
        const parent = todoManager.createTodoItem('Parent', 'in_progress', undefined, undefined, [
          subtask1,
          subtask2,
        ]);

        const error = todoManager.validateSubtaskInProgress(parent);

        expect(error).toBeNull();
      });
    });

    describe('validateAllRules', () => {
      it('should pass when all rules satisfied', () => {
        const dep = todoManager.createTodoItem('Dependency', 'completed');
        const todo = todoManager.createTodoItem('Task', 'in_progress', undefined, [dep.id]);

        const error = todoManager.validateAllRules([dep, todo]);

        expect(error).toBeNull();
      });

      it('should return first error encountered', () => {
        // Create invalid state: multiple in_progress todos
        const todos = [
          todoManager.createTodoItem('Task 1', 'in_progress'),
          todoManager.createTodoItem('Task 2', 'in_progress'),
        ];

        const error = todoManager.validateAllRules(todos);

        expect(error).not.toBeNull();
        expect(error).toContain('Only ONE task');
      });

      it('should validate subtasks of in_progress parent', () => {
        const subtask1 = todoManager.createTodoItem('Subtask 1', 'pending');
        const subtask2 = todoManager.createTodoItem('Subtask 2', 'pending');
        const parent = todoManager.createTodoItem('Parent', 'in_progress', undefined, undefined, [
          subtask1,
          subtask2,
        ]);

        const error = todoManager.validateAllRules([parent]);

        expect(error).toContain('none are in_progress');
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

      expect(context).toContain('PENDING (READY)');
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

    it('should separate blocked pending tasks', () => {
      const dep = todoManager.createTodoItem('Dependency', 'pending');
      const blocked = todoManager.createTodoItem('Blocked', 'pending', undefined, [dep.id]);
      todoManager.setTodos([dep, blocked]);

      const context = todoManager.generateActiveContext();

      expect(context).toContain('PENDING (BLOCKED)');
      expect(context).toContain('waiting on');
    });

    it('should include subtasks', () => {
      const subtask = todoManager.createTodoItem('Subtask', 'pending');
      const parent = todoManager.createTodoItem('Parent', 'in_progress', undefined, undefined, [
        subtask,
      ]);
      todoManager.setTodos([parent]);

      const context = todoManager.generateActiveContext();

      expect(context).toContain('Parent');
      expect(context).toContain('Subtask');
    });

    it('should include proposed tasks', () => {
      const todos = [todoManager.createTodoItem('Task 1', 'proposed')];
      todoManager.setTodos(todos);

      const context = todoManager.generateActiveContext();

      expect(context).toContain('PROPOSED');
      expect(context).toContain('awaiting decision');
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
