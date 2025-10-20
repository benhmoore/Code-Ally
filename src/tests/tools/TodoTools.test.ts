/**
 * Tests for Todo tools (TodoAddTool, TodoCompleteTool, TodoClearTool)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TodoAddTool } from '../../tools/TodoAddTool.js';
import { TodoCompleteTool } from '../../tools/TodoCompleteTool.js';
import { TodoClearTool } from '../../tools/TodoClearTool.js';
import { ActivityStream } from '../../services/ActivityStream.js';
import { ServiceRegistry } from '../../services/ServiceRegistry.js';
import { TodoManager } from '../../services/TodoManager.js';

describe('Todo Tools', () => {
  let activityStream: ActivityStream;
  let registry: ServiceRegistry;
  let todoManager: TodoManager;
  let addTool: TodoAddTool;
  let completeTool: TodoCompleteTool;
  let clearTool: TodoClearTool;

  beforeEach(() => {
    activityStream = new ActivityStream();
    registry = ServiceRegistry.getInstance();
    todoManager = new TodoManager();
    registry.registerInstance('todo_manager', todoManager);

    addTool = new TodoAddTool(activityStream);
    completeTool = new TodoCompleteTool(activityStream);
    clearTool = new TodoClearTool(activityStream);
  });

  afterEach(async () => {
    await registry.shutdown();
  });

  describe('TodoAddTool', () => {
    it('should have correct metadata', () => {
      expect(addTool.name).toBe('todo_add');
      expect(addTool.requiresConfirmation).toBe(false);
    });

    it('should add tasks to todo list', async () => {
      const result = await addTool.execute({
        tasks: ['Task 1', 'Task 2', 'Task 3'],
      });

      expect(result.success).toBe(true);
      expect(result.total_count).toBe(3);
      expect(result.todos).toHaveLength(3);
      expect(result.todos[0].task).toBe('Task 1');
    });

    it('should reject empty task array', async () => {
      const result = await addTool.execute({ tasks: [] });

      expect(result.success).toBe(false);
      expect(result.error).toContain('cannot be empty');
    });

    it('should reject non-array tasks parameter', async () => {
      const result = await addTool.execute({ tasks: 'not an array' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('must be an array');
    });

    it('should reject non-string tasks', async () => {
      const result = await addTool.execute({ tasks: ['Valid', 123, 'Also valid'] });

      expect(result.success).toBe(false);
      expect(result.error).toContain('must be a string');
    });

    it('should reject empty string tasks', async () => {
      const result = await addTool.execute({ tasks: ['Valid', '   ', 'Also valid'] });

      expect(result.success).toBe(false);
      expect(result.error).toContain('cannot be empty');
    });

    it('should append to existing todos', async () => {
      await addTool.execute({ tasks: ['Task 1'] });
      const result = await addTool.execute({ tasks: ['Task 2'] });

      expect(result.success).toBe(true);
      expect(result.total_count).toBe(2);
      expect(result.todos).toHaveLength(2);
    });
  });

  describe('TodoCompleteTool', () => {
    beforeEach(async () => {
      // Add some tasks
      await addTool.execute({ tasks: ['Task 1', 'Task 2', 'Task 3'] });
    });

    it('should have correct metadata', () => {
      expect(completeTool.name).toBe('todo_complete');
      expect(completeTool.requiresConfirmation).toBe(false);
    });

    it('should complete task by index', async () => {
      const result = await completeTool.execute({ index: 0 });

      expect(result.success).toBe(true);
      expect(result.completed_task).toBe('Task 1');

      const todos = todoManager.getTodos();
      expect(todos[0].completed).toBe(true);
    });

    it('should complete second incomplete task', async () => {
      await completeTool.execute({ index: 0 }); // Complete Task 1
      const result = await completeTool.execute({ index: 0 }); // Complete Task 2 (now first incomplete)

      expect(result.success).toBe(true);
      expect(result.completed_task).toBe('Task 2');
    });

    it('should reject negative index', async () => {
      const result = await completeTool.execute({ index: -1 });

      expect(result.success).toBe(false);
      expect(result.error).toContain('non-negative');
    });

    it('should reject index out of range', async () => {
      const result = await completeTool.execute({ index: 10 });

      expect(result.success).toBe(false);
      expect(result.error).toContain('out of range');
    });

    it('should reject non-integer index', async () => {
      const result = await completeTool.execute({ index: 'not a number' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('must be an integer');
    });

    it('should fail when all tasks are completed', async () => {
      await completeTool.execute({ index: 0 });
      await completeTool.execute({ index: 0 });
      await completeTool.execute({ index: 0 });

      const result = await completeTool.execute({ index: 0 });

      expect(result.success).toBe(false);
      expect(result.error).toContain('already completed');
    });
  });

  describe('TodoClearTool', () => {
    beforeEach(async () => {
      // Add and complete some tasks
      await addTool.execute({ tasks: ['Task 1', 'Task 2', 'Task 3'] });
      await completeTool.execute({ index: 0 }); // Complete Task 1
    });

    it('should have correct metadata', () => {
      expect(clearTool.name).toBe('todo_clear');
      expect(clearTool.requiresConfirmation).toBe(false);
    });

    it('should clear completed tasks by default', async () => {
      const result = await clearTool.execute({});

      expect(result.success).toBe(true);
      expect(result.cleared_count).toBe(1);
      expect(result.remaining_count).toBe(2);

      const todos = todoManager.getTodos();
      expect(todos).toHaveLength(2);
      expect(todos.every(t => !t.completed)).toBe(true);
    });

    it('should clear all tasks when all=true', async () => {
      const result = await clearTool.execute({ all: true });

      expect(result.success).toBe(true);
      expect(result.cleared_count).toBe(3);
      expect(result.remaining_count).toBe(0);

      const todos = todoManager.getTodos();
      expect(todos).toHaveLength(0);
    });

    it('should fail when no completed tasks to clear', async () => {
      // Clear completed tasks first
      await clearTool.execute({});

      // Try to clear again
      const result = await clearTool.execute({});

      expect(result.success).toBe(false);
      expect(result.error).toContain('No completed tasks');
    });

    it('should fail when no todos exist', async () => {
      await clearTool.execute({ all: true }); // Clear all

      const result = await clearTool.execute({});

      expect(result.success).toBe(false);
      expect(result.error).toContain('No todos to clear');
    });
  });

  describe('Todo workflow integration', () => {
    it('should support full todo lifecycle', async () => {
      // Add tasks
      const addResult = await addTool.execute({
        tasks: ['Write tests', 'Run tests', 'Fix bugs'],
      });
      expect(addResult.success).toBe(true);
      expect(addResult.total_count).toBe(3);

      // Complete first task
      const complete1 = await completeTool.execute({ index: 0 });
      expect(complete1.success).toBe(true);
      expect(complete1.completed_task).toBe('Write tests');

      // Complete second task (index 0 now refers to "Run tests")
      const complete2 = await completeTool.execute({ index: 0 });
      expect(complete2.success).toBe(true);
      expect(complete2.completed_task).toBe('Run tests');

      // Clear completed tasks
      const clearResult = await clearTool.execute({});
      expect(clearResult.success).toBe(true);
      expect(clearResult.cleared_count).toBe(2);
      expect(clearResult.remaining_count).toBe(1);

      // Verify remaining task
      const todos = todoManager.getTodos();
      expect(todos).toHaveLength(1);
      expect(todos[0].task).toBe('Fix bugs');
      expect(todos[0].completed).toBe(false);
    });
  });
});
