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
import { ActivityStream } from '../../services/ActivityStream.js';

describe('LineEditTool', () => {
  let tempDir: string;
  let lineEditTool: LineEditTool;
  let activityStream: ActivityStream;

  beforeEach(async () => {
    // Create a temporary directory for test files
    tempDir = join(tmpdir(), `code-ally-line-edit-test-${Date.now()}`);
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

  describe('tool metadata', () => {
    it('should have correct tool name', () => {
      expect(lineEditTool.name).toBe('line_edit');
    });

    it('should require confirmation', () => {
      expect(lineEditTool.requiresConfirmation).toBe(true);
    });

    it('should have proper function definition', () => {
      const def = lineEditTool.getFunctionDefinition();

      expect(def.type).toBe('function');
      expect(def.function.name).toBe('line_edit');
      expect(def.function.parameters.required).toContain('file_path');
      expect(def.function.parameters.required).toContain('operation');
      expect(def.function.parameters.required).toContain('line_number');
      expect(def.function.parameters.properties.content).toBeDefined();
      expect(def.function.parameters.properties.num_lines).toBeDefined();
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
});
