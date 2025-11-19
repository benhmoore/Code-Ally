/**
 * LineEditTool unit tests
 *
 * Tests line-based operations: insert, delete, replace
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { LineEditTool } from '../LineEditTool.js';
import { ActivityStream } from '@services/ActivityStream.js';

describe('LineEditTool', () => {
  let tempDir: string;
  let lineEditTool: LineEditTool;
  let activityStream: ActivityStream;

  beforeEach(async () => {
    // Create a temporary directory for test files
    tempDir = join(tmpdir(), `code-ally-line-edit-test-${Date.now()}-${Math.random().toString(36).substring(7)}`);
    await fs.mkdir(tempDir, { recursive: true });

    // Initialize tool
    activityStream = new ActivityStream();
    lineEditTool = new LineEditTool(activityStream);
  });

  afterEach(async () => {
    // Cleanup
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  describe('insert operation', () => {
    it('should insert line at beginning', async () => {
      const filePath = join(tempDir, 'insert-start.txt');
      const content = 'Line 2\nLine 3';
      await fs.writeFile(filePath, content);

      const result = await lineEditTool.execute({
        file_path: filePath,
        operation: 'insert',
        line_number: 1,
        content: 'Line 1',
      });

      expect(result.success).toBe(true);
      expect(result.lines_after).toBe(3);

      const newContent = await fs.readFile(filePath, 'utf-8');
      expect(newContent).toBe('Line 1\nLine 2\nLine 3');
    });

    it('should insert line in middle', async () => {
      const filePath = join(tempDir, 'insert-middle.txt');
      const content = 'Line 1\nLine 3';
      await fs.writeFile(filePath, content);

      const result = await lineEditTool.execute({
        file_path: filePath,
        operation: 'insert',
        line_number: 2,
        content: 'Line 2',
      });

      expect(result.success).toBe(true);
      expect(result.lines_after).toBe(3);

      const newContent = await fs.readFile(filePath, 'utf-8');
      expect(newContent).toBe('Line 1\nLine 2\nLine 3');
    });

    it('should insert line at end', async () => {
      const filePath = join(tempDir, 'insert-end.txt');
      const content = 'Line 1\nLine 2';
      await fs.writeFile(filePath, content);

      const result = await lineEditTool.execute({
        file_path: filePath,
        operation: 'insert',
        line_number: 3,
        content: 'Line 3',
      });

      expect(result.success).toBe(true);
      expect(result.lines_after).toBe(3);

      const newContent = await fs.readFile(filePath, 'utf-8');
      expect(newContent).toBe('Line 1\nLine 2\nLine 3');
    });

    it('should insert multiple lines', async () => {
      const filePath = join(tempDir, 'insert-multi.txt');
      const content = 'Line 1\nLine 4';
      await fs.writeFile(filePath, content);

      const result = await lineEditTool.execute({
        file_path: filePath,
        operation: 'insert',
        line_number: 2,
        content: 'Line 2\nLine 3',
      });

      expect(result.success).toBe(true);
      expect(result.lines_after).toBe(4);

      const newContent = await fs.readFile(filePath, 'utf-8');
      expect(newContent).toBe('Line 1\nLine 2\nLine 3\nLine 4');
    });
  });

  describe('delete operation', () => {
    it('should delete single line', async () => {
      const filePath = join(tempDir, 'delete-single.txt');
      const content = 'Line 1\nLine 2\nLine 3';
      await fs.writeFile(filePath, content);

      const result = await lineEditTool.execute({
        file_path: filePath,
        operation: 'delete',
        line_number: 2,
      });

      expect(result.success).toBe(true);
      expect(result.lines_after).toBe(2);

      const newContent = await fs.readFile(filePath, 'utf-8');
      expect(newContent).toBe('Line 1\nLine 3');
    });

    it('should delete multiple lines', async () => {
      const filePath = join(tempDir, 'delete-multi.txt');
      const content = 'Line 1\nLine 2\nLine 3\nLine 4';
      await fs.writeFile(filePath, content);

      const result = await lineEditTool.execute({
        file_path: filePath,
        operation: 'delete',
        line_number: 2,
        num_lines: 2,
      });

      expect(result.success).toBe(true);
      expect(result.lines_after).toBe(2);

      const newContent = await fs.readFile(filePath, 'utf-8');
      expect(newContent).toBe('Line 1\nLine 4');
    });

    it('should delete first line', async () => {
      const filePath = join(tempDir, 'delete-first.txt');
      const content = 'Line 1\nLine 2\nLine 3';
      await fs.writeFile(filePath, content);

      const result = await lineEditTool.execute({
        file_path: filePath,
        operation: 'delete',
        line_number: 1,
      });

      expect(result.success).toBe(true);

      const newContent = await fs.readFile(filePath, 'utf-8');
      expect(newContent).toBe('Line 2\nLine 3');
    });

    it('should delete last line', async () => {
      const filePath = join(tempDir, 'delete-last.txt');
      const content = 'Line 1\nLine 2\nLine 3';
      await fs.writeFile(filePath, content);

      const result = await lineEditTool.execute({
        file_path: filePath,
        operation: 'delete',
        line_number: 3,
      });

      expect(result.success).toBe(true);

      const newContent = await fs.readFile(filePath, 'utf-8');
      expect(newContent).toBe('Line 1\nLine 2');
    });

    it('should fail if deleting beyond file end', async () => {
      const filePath = join(tempDir, 'delete-beyond.txt');
      const content = 'Line 1\nLine 2';
      await fs.writeFile(filePath, content);

      const result = await lineEditTool.execute({
        file_path: filePath,
        operation: 'delete',
        line_number: 2,
        num_lines: 5,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Cannot delete');
    });
  });

  describe('replace operation', () => {
    it('should replace single line', async () => {
      const filePath = join(tempDir, 'replace-single.txt');
      const content = 'Line 1\nLine 2\nLine 3';
      await fs.writeFile(filePath, content);

      const result = await lineEditTool.execute({
        file_path: filePath,
        operation: 'replace',
        line_number: 2,
        content: 'New Line 2',
      });

      expect(result.success).toBe(true);

      const newContent = await fs.readFile(filePath, 'utf-8');
      expect(newContent).toBe('Line 1\nNew Line 2\nLine 3');
    });

    it('should replace line with multiple lines', async () => {
      const filePath = join(tempDir, 'replace-multi.txt');
      const content = 'Line 1\nLine 2\nLine 3';
      await fs.writeFile(filePath, content);

      const result = await lineEditTool.execute({
        file_path: filePath,
        operation: 'replace',
        line_number: 2,
        content: 'New Line 2a\nNew Line 2b',
      });

      expect(result.success).toBe(true);
      expect(result.lines_after).toBe(4);

      const newContent = await fs.readFile(filePath, 'utf-8');
      expect(newContent).toBe('Line 1\nNew Line 2a\nNew Line 2b\nLine 3');
    });

    it('should replace first line', async () => {
      const filePath = join(tempDir, 'replace-first.txt');
      const content = 'Line 1\nLine 2';
      await fs.writeFile(filePath, content);

      const result = await lineEditTool.execute({
        file_path: filePath,
        operation: 'replace',
        line_number: 1,
        content: 'New Line 1',
      });

      expect(result.success).toBe(true);

      const newContent = await fs.readFile(filePath, 'utf-8');
      expect(newContent).toBe('New Line 1\nLine 2');
    });

    it('should replace last line', async () => {
      const filePath = join(tempDir, 'replace-last.txt');
      const content = 'Line 1\nLine 2';
      await fs.writeFile(filePath, content);

      const result = await lineEditTool.execute({
        file_path: filePath,
        operation: 'replace',
        line_number: 2,
        content: 'New Line 2',
      });

      expect(result.success).toBe(true);

      const newContent = await fs.readFile(filePath, 'utf-8');
      expect(newContent).toBe('Line 1\nNew Line 2');
    });
  });

  describe('validation', () => {
    it('should require file_path parameter', async () => {
      const result = await lineEditTool.execute({
        operation: 'replace',
        line_number: 1,
        content: 'content',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('file_path parameter is required');
      expect(result.error_type).toBe('validation_error');
    });

    it('should require operation parameter', async () => {
      const result = await lineEditTool.execute({
        file_path: join(tempDir, 'test.txt'),
        line_number: 1,
        content: 'content',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('operation parameter is required');
    });

    it('should require line_number parameter', async () => {
      const result = await lineEditTool.execute({
        file_path: join(tempDir, 'test.txt'),
        operation: 'replace',
        content: 'content',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('line_number must be >= 1');
    });

    it('should validate operation type', async () => {
      const result = await lineEditTool.execute({
        file_path: join(tempDir, 'test.txt'),
        operation: 'invalid',
        line_number: 1,
        content: 'content',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid operation');
    });

    it('should require content for insert operation', async () => {
      const filePath = join(tempDir, 'test.txt');
      await fs.writeFile(filePath, 'Line 1');

      const result = await lineEditTool.execute({
        file_path: filePath,
        operation: 'insert',
        line_number: 1,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('content parameter is required');
    });

    it('should require content for replace operation', async () => {
      const filePath = join(tempDir, 'test.txt');
      await fs.writeFile(filePath, 'Line 1');

      const result = await lineEditTool.execute({
        file_path: filePath,
        operation: 'replace',
        line_number: 1,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('content parameter is required');
    });

    it('should fail if line_number is zero', async () => {
      const result = await lineEditTool.execute({
        file_path: join(tempDir, 'test.txt'),
        operation: 'replace',
        line_number: 0,
        content: 'content',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('line_number must be >= 1');
    });

    it('should fail if line_number exceeds file length', async () => {
      const filePath = join(tempDir, 'short.txt');
      await fs.writeFile(filePath, 'Line 1\nLine 2');

      const result = await lineEditTool.execute({
        file_path: filePath,
        operation: 'replace',
        line_number: 10,
        content: 'content',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('line_number 10 does not exist');
      expect(result.error).toContain('file has 2 lines');
    });

    it('should fail if file does not exist', async () => {
      const result = await lineEditTool.execute({
        file_path: join(tempDir, 'nonexistent.txt'),
        operation: 'replace',
        line_number: 1,
        content: 'content',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('File not found');
      expect(result.error_type).toBe('user_error');
    });

    it('should fail if path is a directory', async () => {
      const dirPath = join(tempDir, 'testdir');
      await fs.mkdir(dirPath);

      const result = await lineEditTool.execute({
        file_path: dirPath,
        operation: 'replace',
        line_number: 1,
        content: 'content',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Not a file');
    });

    it('should validate num_lines for delete operation', async () => {
      const filePath = join(tempDir, 'test.txt');
      await fs.writeFile(filePath, 'Line 1');

      const result = await lineEditTool.execute({
        file_path: filePath,
        operation: 'delete',
        line_number: 1,
        num_lines: 0,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('num_lines must be >= 1');
    });
  });

  describe('line ending preservation', () => {
    it('should preserve Unix line endings', async () => {
      const filePath = join(tempDir, 'unix.txt');
      const content = 'Line 1\nLine 2\nLine 3';
      await fs.writeFile(filePath, content);

      const result = await lineEditTool.execute({
        file_path: filePath,
        operation: 'replace',
        line_number: 2,
        content: 'New Line 2',
      });

      expect(result.success).toBe(true);

      const newContent = await fs.readFile(filePath, 'utf-8');
      expect(newContent).toBe('Line 1\nNew Line 2\nLine 3');
      expect(newContent).not.toContain('\r\n');
    });

    it('should preserve Windows line endings', async () => {
      const filePath = join(tempDir, 'windows.txt');
      const content = 'Line 1\r\nLine 2\r\nLine 3';
      await fs.writeFile(filePath, content);

      const result = await lineEditTool.execute({
        file_path: filePath,
        operation: 'replace',
        line_number: 2,
        content: 'New Line 2',
      });

      expect(result.success).toBe(true);

      const newContent = await fs.readFile(filePath, 'utf-8');
      expect(newContent).toBe('Line 1\r\nNew Line 2\r\nLine 3');
    });
  });

  describe('show_updated_context parameter', () => {
    it('should not include updated_content by default', async () => {
      const filePath = join(tempDir, 'test.txt');
      const content = 'Line 1\nLine 2\nLine 3';
      await fs.writeFile(filePath, content);

      const result = await lineEditTool.execute({
        file_path: filePath,
        operation: 'replace',
        line_number: 2,
        content: 'New Line 2',
      });

      expect(result.success).toBe(true);
      expect(result.updated_content).toBeUndefined();
    });

    it('should include updated_content when show_updated_context is true', async () => {
      const filePath = join(tempDir, 'test.txt');
      const content = 'Line 1\nLine 2\nLine 3';
      await fs.writeFile(filePath, content);

      const result = await lineEditTool.execute({
        file_path: filePath,
        operation: 'replace',
        line_number: 2,
        content: 'New Line 2',
        show_updated_context: true,
      });

      expect(result.success).toBe(true);
      expect(result.updated_content).toBe('Line 1\nNew Line 2\nLine 3');
    });

    it('should not include updated_content when show_updated_context is false', async () => {
      const filePath = join(tempDir, 'test.txt');
      const content = 'Line 1\nLine 2\nLine 3';
      await fs.writeFile(filePath, content);

      const result = await lineEditTool.execute({
        file_path: filePath,
        operation: 'replace',
        line_number: 2,
        content: 'New Line 2',
        show_updated_context: false,
      });

      expect(result.success).toBe(true);
      expect(result.updated_content).toBeUndefined();
    });

    it('should include updated_content for insert operation', async () => {
      const filePath = join(tempDir, 'test.txt');
      const content = 'Line 1\nLine 3';
      await fs.writeFile(filePath, content);

      const result = await lineEditTool.execute({
        file_path: filePath,
        operation: 'insert',
        line_number: 2,
        content: 'Line 2',
        show_updated_context: true,
      });

      expect(result.success).toBe(true);
      expect(result.updated_content).toBe('Line 1\nLine 2\nLine 3');
    });

    it('should include updated_content for delete operation', async () => {
      const filePath = join(tempDir, 'test.txt');
      const content = 'Line 1\nLine 2\nLine 3';
      await fs.writeFile(filePath, content);

      const result = await lineEditTool.execute({
        file_path: filePath,
        operation: 'delete',
        line_number: 2,
        show_updated_context: true,
      });

      expect(result.success).toBe(true);
      expect(result.updated_content).toBe('Line 1\nLine 3');
    });
  });

  describe('tool metadata', () => {
    it('should have correct tool name', () => {
      expect(lineEditTool.name).toBe('line-edit');
    });

    it('should require confirmation', () => {
      expect(lineEditTool.requiresConfirmation).toBe(true);
    });

    it('should have proper function definition', () => {
      const def = lineEditTool.getFunctionDefinition();

      expect(def.type).toBe('function');
      expect(def.function.name).toBe('line-edit');
      expect(def.function.parameters.required).toContain('file_path');
      expect(def.function.parameters.required).toContain('operation');
      expect(def.function.parameters.required).toContain('line_number');
      expect(def.function.parameters.properties.content).toBeDefined();
      expect(def.function.parameters.properties.num_lines).toBeDefined();
      expect(def.function.parameters.properties.show_updated_context).toBeDefined();
    });

    it('should provide custom result preview', () => {
      const result = {
        success: true,
        error: '',
        file_path: '/test/file.txt',
        operation: 'Replaced line 5',
        lines_before: 10,
        lines_after: 10,
      };

      const preview = lineEditTool.getResultPreview(result, 3);

      expect(preview).toContain('Replaced line 5');
    });

    it('should show line count changes in preview', () => {
      const result = {
        success: true,
        error: '',
        file_path: '/test/file.txt',
        operation: 'Inserted 2 lines',
        lines_before: 10,
        lines_after: 12,
      };

      const preview = lineEditTool.getResultPreview(result, 3);

      expect(preview.length).toBeGreaterThan(0);
      expect(preview[0]).toContain('Inserted 2 lines');
      // Check that at least one line contains the change info
      const hasChangeInfo = preview.some(
        (line) => line.includes('10') && line.includes('12') && line.includes('+2')
      );
      expect(hasChangeInfo).toBe(true);
    });
  });

  describe('Phase 2: Line shift tracking and updated context', () => {
    it('should show line shift information on INSERT operation', async () => {
      const filePath = join(tempDir, 'insert-shift.txt');
      await fs.writeFile(filePath, 'Line 1\nLine 2\nLine 3');

      const result = await lineEditTool.execute({
        file_path: filePath,
        operation: 'insert',
        line_number: 1,
        content: 'New Line',
      });

      expect(result.success).toBe(true);
      expect(result.content).toContain('shifted down');
    });

    it('should show updated_content when show_updated_context is true', async () => {
      const filePath = join(tempDir, 'updated-content.txt');
      await fs.writeFile(filePath, 'Line 1\nLine 2\nLine 3');

      const result = await lineEditTool.execute({
        file_path: filePath,
        operation: 'replace',
        line_number: 2,
        content: 'Modified',
        show_updated_context: true,
      });

      expect(result.success).toBe(true);
      expect(result.updated_content).toBeDefined();
      expect(result.updated_content).toContain('Modified');
    });

    it('should NOT show shift message when line count unchanged', async () => {
      const filePath = join(tempDir, 'no-shift.txt');
      await fs.writeFile(filePath, 'Line 1\nLine 2\nLine 3');

      const result = await lineEditTool.execute({
        file_path: filePath,
        operation: 'replace',
        line_number: 2,
        content: 'Modified',
        num_lines: 1,
      });

      expect(result.success).toBe(true);
      expect(result.content).not.toContain('shifted');
    });

    it('should NOT show shift message when inserting at end of file', async () => {
      const filePath = join(tempDir, 'insert-end.txt');
      await fs.writeFile(filePath, 'Line 1\nLine 2');

      const result = await lineEditTool.execute({
        file_path: filePath,
        operation: 'insert',
        line_number: 3,
        content: 'Line 3',
      });

      expect(result.success).toBe(true);
      expect(result.lines_after).toBe(3);
      expect(result.content).not.toContain('shifted');
    });

    it('should handle deleting only line in file', async () => {
      const filePath = join(tempDir, 'single-line.txt');
      await fs.writeFile(filePath, 'Only line');

      const result = await lineEditTool.execute({
        file_path: filePath,
        operation: 'delete',
        line_number: 1,
      });

      expect(result.success).toBe(true);
      expect(result.lines_after).toBe(0);
      expect(result.content).not.toContain('shifted');

      const newContent = await fs.readFile(filePath, 'utf-8');
      expect(newContent).toBe('');
    });
  });

  describe('Phase 3: Enhanced error and success messages', () => {
    it('should show invalidation guidance when edit fails after previous line-shifting edit', async () => {
      const { ServiceRegistry } = await import('@services/ServiceRegistry.js');
      const { ReadStateManager } = await import('@services/ReadStateManager.js');

      const registry = ServiceRegistry.getInstance();
      const readStateManager = new ReadStateManager();
      registry.registerInstance('read_state_manager', readStateManager);

      const filePath = join(tempDir, 'invalidation-test.txt');
      const content = 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5';
      await fs.writeFile(filePath, content);

      // Track that we've read lines 1-5
      readStateManager.trackRead(filePath, 1, 5);

      // First edit: insert at line 2 (shifts lines 2+ down)
      const result1 = await lineEditTool.execute({
        file_path: filePath,
        operation: 'insert',
        line_number: 2,
        content: 'New Line',
      });

      expect(result1.success).toBe(true);
      expect(result1.content).toContain('invalidated');

      // Second edit: try to edit line 3 (now invalidated)
      const result2 = await lineEditTool.execute({
        file_path: filePath,
        operation: 'replace',
        line_number: 3,
        content: 'Modified Line',
      });

      expect(result2.success).toBe(false);
      expect(result2.error_type).toBe('validation_error');
      expect(result2.suggestion).toContain('invalidated by a previous edit');
      expect(result2.suggestion).toContain('Re-read the file');
      expect(result2.suggestion).toContain('show_updated_context=true');

      // Cleanup
      (registry as any)._services?.clear();
    });

    it('should show basic read guidance when file has never been read', async () => {
      const { ServiceRegistry } = await import('@services/ServiceRegistry.js');
      const { ReadStateManager } = await import('@services/ReadStateManager.js');

      const registry = ServiceRegistry.getInstance();
      const readStateManager = new ReadStateManager();
      registry.registerInstance('read_state_manager', readStateManager);

      const filePath = join(tempDir, 'never-read.txt');
      const content = 'Line 1\nLine 2\nLine 3';
      await fs.writeFile(filePath, content);

      // Don't track any read - file has never been read

      // Try to edit
      const result = await lineEditTool.execute({
        file_path: filePath,
        operation: 'replace',
        line_number: 2,
        content: 'Modified',
      });

      expect(result.success).toBe(false);
      expect(result.error_type).toBe('validation_error');
      expect(result.suggestion).not.toContain('invalidated');
      expect(result.suggestion).toContain('Use read');

      // Cleanup
      (registry as any)._services?.clear();
    });

    it('should show proactive warning in success message when lines shift', async () => {
      const { ServiceRegistry } = await import('@services/ServiceRegistry.js');
      const { ReadStateManager } = await import('@services/ReadStateManager.js');

      const registry = ServiceRegistry.getInstance();
      const readStateManager = new ReadStateManager();
      registry.registerInstance('read_state_manager', readStateManager);

      const filePath = join(tempDir, 'proactive-warning.txt');
      const content = 'Line 1\nLine 2\nLine 3\nLine 4';
      await fs.writeFile(filePath, content);

      // Track read
      readStateManager.trackRead(filePath, 1, 4);

      const result = await lineEditTool.execute({
        file_path: filePath,
        operation: 'insert',
        line_number: 2,
        content: 'New Line',
      });

      expect(result.success).toBe(true);
      expect(result.content).toContain('⚠️');
      expect(result.content).toContain('invalidated due to line shift');
      expect(result.content).toContain('show_updated_context=true');

      // Cleanup
      (registry as any)._services?.clear();
    });

    it('should NOT show proactive warning when no lines shift (append to end)', async () => {
      const { ServiceRegistry } = await import('@services/ServiceRegistry.js');
      const { ReadStateManager } = await import('@services/ReadStateManager.js');

      const registry = ServiceRegistry.getInstance();
      const readStateManager = new ReadStateManager();
      registry.registerInstance('read_state_manager', readStateManager);

      const filePath = join(tempDir, 'no-warning.txt');
      const content = 'Line 1\nLine 2';
      await fs.writeFile(filePath, content);

      // Track read
      readStateManager.trackRead(filePath, 1, 2);

      const result = await lineEditTool.execute({
        file_path: filePath,
        operation: 'insert',
        line_number: 3,
        content: 'Line 3',
      });

      expect(result.success).toBe(true);
      expect(result.content).not.toContain('⚠️');
      expect(result.content).not.toContain('invalidated');

      // Cleanup
      (registry as any)._services?.clear();
    });
  });
});
