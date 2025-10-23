/**
 * Tests for TodoWriteTool - validates todo list management
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TodoWriteTool } from '../../tools/TodoWriteTool.js';
import { ActivityStream } from '../../services/ActivityStream.js';
import { ServiceRegistry } from '../../services/ServiceRegistry.js';
import { TodoManager } from '../../services/TodoManager.js';

describe('TodoWriteTool', () => {
  let activityStream: ActivityStream;
  let registry: ServiceRegistry;
  let todoManager: TodoManager;
  let todoWriteTool: TodoWriteTool;

  beforeEach(() => {
    activityStream = new ActivityStream();
    registry = ServiceRegistry.getInstance();
    todoManager = new TodoManager();
    registry.registerInstance('todo_manager', todoManager);

    todoWriteTool = new TodoWriteTool(activityStream);
  });

  afterEach(async () => {
    await registry.shutdown();
  });

  describe('Basic Functionality', () => {
    it('should have correct metadata', () => {
      expect(todoWriteTool.name).toBe('todo_write');
      expect(todoWriteTool.requiresConfirmation).toBe(false);
      expect(todoWriteTool.visibleInChat).toBe(false);
    });

    it('should create todos with all required fields', async () => {
      const result = await todoWriteTool.execute({
        todos: [
          { content: 'Task 1', status: 'pending', activeForm: 'Working on task 1' },
          { content: 'Task 2', status: 'in_progress', activeForm: 'Working on task 2' },
        ],
      });

      expect(result.success).toBe(true);
      expect(result.total_count).toBe(2);
      expect(result.incomplete_count).toBe(2);

      const todos = todoManager.getTodos();
      expect(todos).toHaveLength(2);
      expect(todos[0].task).toBe('Task 1');
      expect(todos[0].status).toBe('pending');
      expect(todos[0].activeForm).toBe('Working on task 1');
    });

    it('should reject empty todos array', async () => {
      const result = await todoWriteTool.execute({
        todos: [],
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('cannot be empty');
    });
  });

  describe('Field Validation', () => {
    it('should reject todos without content', async () => {
      const result = await todoWriteTool.execute({
        todos: [
          { status: 'pending', activeForm: 'Working' },
        ],
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('content is required');
    });

    it('should reject todos without status', async () => {
      const result = await todoWriteTool.execute({
        todos: [
          { content: 'Task 1', activeForm: 'Working on task 1' },
        ],
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('status must be');
    });

    it('should reject todos without activeForm', async () => {
      const result = await todoWriteTool.execute({
        todos: [
          { content: 'Task 1', status: 'pending' },
        ],
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('activeForm is required');
    });

    it('should reject invalid status values', async () => {
      const result = await todoWriteTool.execute({
        todos: [
          { content: 'Task 1', status: 'invalid', activeForm: 'Working' },
        ],
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('status must be');
    });
  });

  describe('Critical Constraint: Exactly One in_progress (C-1.1)', () => {
    it('should require at least one in_progress task when incomplete tasks exist', async () => {
      const result = await todoWriteTool.execute({
        todos: [
          { content: 'Task 1', status: 'pending', activeForm: 'Working on task 1' },
          { content: 'Task 2', status: 'pending', activeForm: 'Working on task 2' },
        ],
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('At least one incomplete task must be marked as "in_progress"');
    });

    it('should reject multiple in_progress tasks', async () => {
      const result = await todoWriteTool.execute({
        todos: [
          { content: 'Task 1', status: 'in_progress', activeForm: 'Working on task 1' },
          { content: 'Task 2', status: 'in_progress', activeForm: 'Working on task 2' },
        ],
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Only ONE task can be "in_progress" at a time');
      expect(result.error).toContain('Found 2 in_progress tasks');
    });

    it('should accept exactly one in_progress task', async () => {
      const result = await todoWriteTool.execute({
        todos: [
          { content: 'Task 1', status: 'pending', activeForm: 'Working on task 1' },
          { content: 'Task 2', status: 'in_progress', activeForm: 'Working on task 2' },
          { content: 'Task 3', status: 'pending', activeForm: 'Working on task 3' },
        ],
      });

      expect(result.success).toBe(true);
      expect(result.incomplete_count).toBe(3);
    });

    it('should accept all completed tasks with no in_progress', async () => {
      const result = await todoWriteTool.execute({
        todos: [
          { content: 'Task 1', status: 'completed', activeForm: 'Completed task 1' },
          { content: 'Task 2', status: 'completed', activeForm: 'Completed task 2' },
        ],
      });

      expect(result.success).toBe(true);
      expect(result.incomplete_count).toBe(0);
      expect(result.content).toContain('All todos completed');
    });

    it('should allow exactly one in_progress task even when others are completed', async () => {
      // This is valid: one incomplete (in_progress) task with completed tasks
      const result = await todoWriteTool.execute({
        todos: [
          { content: 'Task 1', status: 'completed', activeForm: 'Completed task 1' },
          { content: 'Task 2', status: 'in_progress', activeForm: 'Working on task 2' },
          { content: 'Task 3', status: 'completed', activeForm: 'Completed task 3' },
        ],
      });

      expect(result.success).toBe(true);
      expect(result.incomplete_count).toBe(1);
    });
  });

  describe('State Transitions', () => {
    it('should allow marking task as completed', async () => {
      // First create with one in_progress
      await todoWriteTool.execute({
        todos: [
          { content: 'Task 1', status: 'in_progress', activeForm: 'Working on task 1' },
          { content: 'Task 2', status: 'pending', activeForm: 'Working on task 2' },
        ],
      });

      // Mark first as completed, second as in_progress
      const result = await todoWriteTool.execute({
        todos: [
          { content: 'Task 1', status: 'completed', activeForm: 'Completed task 1' },
          { content: 'Task 2', status: 'in_progress', activeForm: 'Working on task 2' },
        ],
      });

      expect(result.success).toBe(true);
      expect(result.incomplete_count).toBe(1);

      const todos = todoManager.getTodos();
      expect(todos[0].status).toBe('completed');
      expect(todos[1].status).toBe('in_progress');
    });

    it('should allow adding new tasks dynamically', async () => {
      // Start with 2 tasks
      await todoWriteTool.execute({
        todos: [
          { content: 'Task 1', status: 'in_progress', activeForm: 'Working on task 1' },
          { content: 'Task 2', status: 'pending', activeForm: 'Working on task 2' },
        ],
      });

      // Complete first, add new task
      const result = await todoWriteTool.execute({
        todos: [
          { content: 'Task 1', status: 'completed', activeForm: 'Completed task 1' },
          { content: 'Task 2', status: 'in_progress', activeForm: 'Working on task 2' },
          { content: 'Task 3', status: 'pending', activeForm: 'Working on task 3' },
        ],
      });

      expect(result.success).toBe(true);
      expect(result.total_count).toBe(3);
      expect(result.incomplete_count).toBe(2);
    });
  });
});
