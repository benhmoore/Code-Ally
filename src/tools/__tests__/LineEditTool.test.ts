/**
 * LineEditTool unit tests
 *
 * Tests line-based operations: insert, delete, replace
 * Updated for batch-only API
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { LineEditTool } from '../LineEditTool.js';
import { ActivityStream } from '@services/ActivityStream.js';
import { ServiceRegistry } from '@services/ServiceRegistry.js';
import { ReadStateManager } from '@services/ReadStateManager.js';

describe('LineEditTool', () => {
  let tempDir: string;
  let lineEditTool: LineEditTool;
  let activityStream: ActivityStream;
  let readStateManager: ReadStateManager;
  let registry: ServiceRegistry;

  beforeEach(async () => {
    // Create a temporary directory for test files
    tempDir = join(tmpdir(), `code-ally-line-edit-test-${Date.now()}-${Math.random().toString(36).substring(7)}`);
    await fs.mkdir(tempDir, { recursive: true });

    // Initialize services
    activityStream = new ActivityStream();
    readStateManager = new ReadStateManager();
    registry = ServiceRegistry.getInstance();

    // Clear any existing services
    registry['_services'].clear();
    registry['_descriptors'].clear();

    // Register read state manager
    registry.registerInstance('read_state_manager', readStateManager);

    lineEditTool = new LineEditTool(activityStream);
  });

  afterEach(async () => {
    // Cleanup
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }

    // Clear service registry
    registry['_services'].clear();
    registry['_descriptors'].clear();
  });

  // Helper function: LineEditTool requires lines to be read first
  const trackFullFile = async (filePath: string) => {
    const content = await fs.readFile(filePath, 'utf-8');
    const lines = content.split('\n').length;
    readStateManager.trackRead(filePath, 1, lines);
  };

  describe('insert operation', () => {
    it('should insert line at beginning', async () => {
      const filePath = join(tempDir, 'insert-start.txt');
      const content = 'Line 2\nLine 3';
      await fs.writeFile(filePath, content);
      await trackFullFile(filePath);

      const result = await lineEditTool.execute({
        file_path: filePath,
        edits: [{ operation: 'insert', line_number: 1, content: 'Line 1' }],
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
      await trackFullFile(filePath);

      const result = await lineEditTool.execute({
        file_path: filePath,
        edits: [{ operation: 'insert', line_number: 2, content: 'Line 2' }],
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
      await trackFullFile(filePath);

      const result = await lineEditTool.execute({
        file_path: filePath,
        edits: [{ operation: 'insert', line_number: 3, content: 'Line 3' }],
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
      await trackFullFile(filePath);

      const result = await lineEditTool.execute({
        file_path: filePath,
        edits: [{ operation: 'insert', line_number: 2, content: 'Line 2\nLine 3' }],
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
      await trackFullFile(filePath);

      const result = await lineEditTool.execute({
        file_path: filePath,
        edits: [{ operation: 'delete', line_number: 2 }],
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
      await trackFullFile(filePath);

      const result = await lineEditTool.execute({
        file_path: filePath,
        edits: [{ operation: 'delete', line_number: 2, num_lines: 2 }],
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
      await trackFullFile(filePath);

      const result = await lineEditTool.execute({
        file_path: filePath,
        edits: [{ operation: 'delete', line_number: 1 }],
      });

      expect(result.success).toBe(true);

      const newContent = await fs.readFile(filePath, 'utf-8');
      expect(newContent).toBe('Line 2\nLine 3');
    });

    it('should delete last line', async () => {
      const filePath = join(tempDir, 'delete-last.txt');
      const content = 'Line 1\nLine 2\nLine 3';
      await fs.writeFile(filePath, content);
      await trackFullFile(filePath);

      const result = await lineEditTool.execute({
        file_path: filePath,
        edits: [{ operation: 'delete', line_number: 3 }],
      });

      expect(result.success).toBe(true);

      const newContent = await fs.readFile(filePath, 'utf-8');
      expect(newContent).toBe('Line 1\nLine 2');
    });

    it('should fail if deleting beyond file end', async () => {
      const filePath = join(tempDir, 'delete-beyond.txt');
      const content = 'Line 1\nLine 2';
      await fs.writeFile(filePath, content);
      await trackFullFile(filePath);

      const result = await lineEditTool.execute({
        file_path: filePath,
        edits: [{ operation: 'delete', line_number: 2, num_lines: 5 }],
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
      await trackFullFile(filePath);

      const result = await lineEditTool.execute({
        file_path: filePath,
        edits: [{ operation: 'replace', line_number: 2, content: 'New Line 2' }],
      });

      expect(result.success).toBe(true);

      const newContent = await fs.readFile(filePath, 'utf-8');
      expect(newContent).toBe('Line 1\nNew Line 2\nLine 3');
    });

    it('should replace line with multiple lines', async () => {
      const filePath = join(tempDir, 'replace-multi.txt');
      const content = 'Line 1\nLine 2\nLine 3';
      await fs.writeFile(filePath, content);
      await trackFullFile(filePath);

      const result = await lineEditTool.execute({
        file_path: filePath,
        edits: [{ operation: 'replace', line_number: 2, content: 'New Line 2a\nNew Line 2b' }],
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
      await trackFullFile(filePath);

      const result = await lineEditTool.execute({
        file_path: filePath,
        edits: [{ operation: 'replace', line_number: 1, content: 'New Line 1' }],
      });

      expect(result.success).toBe(true);

      const newContent = await fs.readFile(filePath, 'utf-8');
      expect(newContent).toBe('New Line 1\nLine 2');
    });

    it('should replace last line', async () => {
      const filePath = join(tempDir, 'replace-last.txt');
      const content = 'Line 1\nLine 2';
      await fs.writeFile(filePath, content);
      await trackFullFile(filePath);

      const result = await lineEditTool.execute({
        file_path: filePath,
        edits: [{ operation: 'replace', line_number: 2, content: 'New Line 2' }],
      });

      expect(result.success).toBe(true);

      const newContent = await fs.readFile(filePath, 'utf-8');
      expect(newContent).toBe('Line 1\nNew Line 2');
    });
  });

  describe('validation', () => {
    it('should require file_path parameter', async () => {
      const result = await lineEditTool.execute({
        edits: [{ operation: 'replace', line_number: 1, content: 'content' }],
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('file_path parameter is required');
      expect(result.error_type).toBe('validation_error');
    });

    it('should require edits array', async () => {
      const result = await lineEditTool.execute({
        file_path: join(tempDir, 'test.txt'),
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('edits array required');
    });

    it('should require operation in edit', async () => {
      const filePath = join(tempDir, 'test.txt');
      await fs.writeFile(filePath, 'Line 1');
      await trackFullFile(filePath);

      const result = await lineEditTool.execute({
        file_path: filePath,
        edits: [{ line_number: 1, content: 'content' }],
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('operation');
    });

    it('should require line_number in edit', async () => {
      const filePath = join(tempDir, 'test.txt');
      await fs.writeFile(filePath, 'Line 1');
      await trackFullFile(filePath);

      const result = await lineEditTool.execute({
        file_path: filePath,
        edits: [{ operation: 'replace', content: 'content' }],
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('line_number');
    });

    it('should validate operation type', async () => {
      const filePath = join(tempDir, 'test.txt');
      await fs.writeFile(filePath, 'Line 1');
      await trackFullFile(filePath);

      const result = await lineEditTool.execute({
        file_path: filePath,
        edits: [{ operation: 'invalid', line_number: 1, content: 'content' }],
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid operation');
    });

    it('should require content for insert operation', async () => {
      const filePath = join(tempDir, 'test.txt');
      await fs.writeFile(filePath, 'Line 1');
      await trackFullFile(filePath);

      const result = await lineEditTool.execute({
        file_path: filePath,
        edits: [{ operation: 'insert', line_number: 1 }],
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('content');
    });

    it('should require content for replace operation', async () => {
      const filePath = join(tempDir, 'test.txt');
      await fs.writeFile(filePath, 'Line 1');
      await trackFullFile(filePath);

      const result = await lineEditTool.execute({
        file_path: filePath,
        edits: [{ operation: 'replace', line_number: 1 }],
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('content');
    });

    it('should fail if line_number is zero', async () => {
      const filePath = join(tempDir, 'test.txt');
      await fs.writeFile(filePath, 'Line 1');
      await trackFullFile(filePath);

      const result = await lineEditTool.execute({
        file_path: filePath,
        edits: [{ operation: 'replace', line_number: 0, content: 'content' }],
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('line_number');
    });

    it('should fail if line_number exceeds file length for replace', async () => {
      const filePath = join(tempDir, 'short.txt');
      await fs.writeFile(filePath, 'Line 1\nLine 2');
      await trackFullFile(filePath);

      const result = await lineEditTool.execute({
        file_path: filePath,
        edits: [{ operation: 'replace', line_number: 10, content: 'content' }],
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('line_number 10');
    });

    it('should fail if file does not exist', async () => {
      const result = await lineEditTool.execute({
        file_path: join(tempDir, 'nonexistent.txt'),
        edits: [{ operation: 'replace', line_number: 1, content: 'content' }],
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
        edits: [{ operation: 'replace', line_number: 1, content: 'content' }],
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Not a file');
    });

    it('should validate num_lines for delete operation', async () => {
      const filePath = join(tempDir, 'test.txt');
      await fs.writeFile(filePath, 'Line 1');
      await trackFullFile(filePath);

      const result = await lineEditTool.execute({
        file_path: filePath,
        edits: [{ operation: 'delete', line_number: 1, num_lines: 0 }],
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('num_lines');
    });
  });

  describe('line ending preservation', () => {
    it('should preserve Unix line endings', async () => {
      const filePath = join(tempDir, 'unix.txt');
      const content = 'Line 1\nLine 2\nLine 3';
      await fs.writeFile(filePath, content);
      await trackFullFile(filePath);

      const result = await lineEditTool.execute({
        file_path: filePath,
        edits: [{ operation: 'replace', line_number: 2, content: 'New Line 2' }],
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
      await trackFullFile(filePath);

      const result = await lineEditTool.execute({
        file_path: filePath,
        edits: [{ operation: 'replace', line_number: 2, content: 'New Line 2' }],
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
      await trackFullFile(filePath);

      const result = await lineEditTool.execute({
        file_path: filePath,
        edits: [{ operation: 'replace', line_number: 2, content: 'New Line 2' }],
      });

      expect(result.success).toBe(true);
      expect(result.updated_content).toBeUndefined();
    });

    it('should include updated_content when show_updated_context is true', async () => {
      const filePath = join(tempDir, 'test.txt');
      const content = 'Line 1\nLine 2\nLine 3';
      await fs.writeFile(filePath, content);
      await trackFullFile(filePath);

      const result = await lineEditTool.execute({
        file_path: filePath,
        edits: [{ operation: 'replace', line_number: 2, content: 'New Line 2' }],
        show_updated_context: true,
      });

      expect(result.success).toBe(true);
      expect(result.updated_content).toBe('Line 1\nNew Line 2\nLine 3');
    });

    it('should not include updated_content when show_updated_context is false', async () => {
      const filePath = join(tempDir, 'test.txt');
      const content = 'Line 1\nLine 2\nLine 3';
      await fs.writeFile(filePath, content);
      await trackFullFile(filePath);

      const result = await lineEditTool.execute({
        file_path: filePath,
        edits: [{ operation: 'replace', line_number: 2, content: 'New Line 2' }],
        show_updated_context: false,
      });

      expect(result.success).toBe(true);
      expect(result.updated_content).toBeUndefined();
    });

    it('should include updated_content for insert operation', async () => {
      const filePath = join(tempDir, 'test.txt');
      const content = 'Line 1\nLine 3';
      await fs.writeFile(filePath, content);
      await trackFullFile(filePath);

      const result = await lineEditTool.execute({
        file_path: filePath,
        edits: [{ operation: 'insert', line_number: 2, content: 'Line 2' }],
        show_updated_context: true,
      });

      expect(result.success).toBe(true);
      expect(result.updated_content).toBe('Line 1\nLine 2\nLine 3');
    });

    it('should include updated_content for delete operation', async () => {
      const filePath = join(tempDir, 'test.txt');
      const content = 'Line 1\nLine 2\nLine 3';
      await fs.writeFile(filePath, content);
      await trackFullFile(filePath);

      const result = await lineEditTool.execute({
        file_path: filePath,
        edits: [{ operation: 'delete', line_number: 2 }],
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
      expect(def.function.parameters.required).toContain('edits');
      expect(def.function.parameters.properties.edits).toBeDefined();
      expect(def.function.parameters.properties.show_updated_context).toBeDefined();
    });

    it('should provide custom result preview', () => {
      const result = {
        success: true,
        error: '',
        file_path: '/test/file.txt',
        operations_applied: 1,
        lines_before: 10,
        lines_after: 10,
      };

      const preview = lineEditTool.getResultPreview(result, 3);

      expect(preview.length).toBeGreaterThan(0);
    });

    it('should show line count changes in preview', () => {
      const result = {
        success: true,
        error: '',
        file_path: '/test/file.txt',
        operations_applied: 1,
        lines_before: 10,
        lines_after: 12,
      };

      const preview = lineEditTool.getResultPreview(result, 3);

      expect(preview.length).toBeGreaterThan(0);
    });
  });

  describe('diff output', () => {
    it('should include unified diff in response', async () => {
      const filePath = join(tempDir, 'diff-test.txt');
      const content = 'Line 1\nLine 2\nLine 3\n';
      await fs.writeFile(filePath, content);
      await trackFullFile(filePath);

      const result = await lineEditTool.execute({
        file_path: filePath,
        edits: [{ operation: 'insert', line_number: 2, content: 'New Line' }],
      });

      expect(result.success).toBe(true);
      expect(result.diff).toBeDefined();
      expect(result.diff).toContain('--- a/diff-test.txt');
      expect(result.diff).toContain('+++ b/diff-test.txt');
      expect(result.diff).toContain('+New Line');
    });
  });
});
