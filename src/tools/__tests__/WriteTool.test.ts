/**
 * WriteTool unit tests
 *
 * Tests file writing, backup creation, and error handling
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { WriteTool } from '../WriteTool.js';
import { ActivityStream } from '../../services/ActivityStream.js';

describe('WriteTool', () => {
  let tempDir: string;
  let writeTool: WriteTool;
  let activityStream: ActivityStream;

  beforeEach(async () => {
    // Create a temporary directory for test files
    tempDir = join(tmpdir(), `code-ally-write-test-${Date.now()}`);
    await fs.mkdir(tempDir, { recursive: true });

    // Initialize tool
    activityStream = new ActivityStream();
    writeTool = new WriteTool(activityStream);
  });

  afterEach(async () => {
    // Cleanup
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  describe('basic functionality', () => {
    it('should create a new file with content', async () => {
      const filePath = join(tempDir, 'test.txt');
      const content = 'Hello, World!';

      const result = await writeTool.execute({
        file_path: filePath,
        content,
      });

      expect(result.success).toBe(true);
      expect(result.file_path).toBe(filePath);
      expect(result.bytes_written).toBeGreaterThan(0);

      // Verify file was created
      const fileContent = await fs.readFile(filePath, 'utf-8');
      expect(fileContent).toBe(content);
    });

    it('should fail when trying to overwrite existing file', async () => {
      const filePath = join(tempDir, 'existing.txt');

      // Create initial file
      await fs.writeFile(filePath, 'Original content');

      // Try to overwrite - should fail
      const newContent = 'New content';
      const result = await writeTool.execute({
        file_path: filePath,
        content: newContent,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('already exists');
      expect(result.suggestion).toContain('edit or line_edit');
    });

    it('should write multi-line content', async () => {
      const filePath = join(tempDir, 'multiline.txt');
      const content = 'Line 1\nLine 2\nLine 3';

      const result = await writeTool.execute({
        file_path: filePath,
        content,
      });

      expect(result.success).toBe(true);

      const fileContent = await fs.readFile(filePath, 'utf-8');
      expect(fileContent).toBe(content);
      expect(fileContent.split('\n').length).toBe(3);
    });

    it('should write empty content', async () => {
      const filePath = join(tempDir, 'empty.txt');
      const content = '';

      const result = await writeTool.execute({
        file_path: filePath,
        content,
      });

      expect(result.success).toBe(true);
      expect(result.bytes_written).toBe(0);

      const fileContent = await fs.readFile(filePath, 'utf-8');
      expect(fileContent).toBe('');
    });
  });


  describe('path handling', () => {
    it('should create parent directories if they do not exist', async () => {
      const filePath = join(tempDir, 'nested', 'dir', 'file.txt');
      const content = 'Nested file';

      const result = await writeTool.execute({
        file_path: filePath,
        content,
      });

      expect(result.success).toBe(true);

      // Verify file was created
      const fileContent = await fs.readFile(filePath, 'utf-8');
      expect(fileContent).toBe(content);
    });

    it('should handle absolute paths', async () => {
      const filePath = join(tempDir, 'absolute.txt');
      const content = 'Absolute path';

      const result = await writeTool.execute({
        file_path: filePath,
        content,
      });

      expect(result.success).toBe(true);
      expect(result.file_path).toBe(filePath);
    });
  });

  describe('validation', () => {
    it('should require file_path parameter', async () => {
      const result = await writeTool.execute({
        content: 'Content',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('file_path parameter is required');
      expect(result.error_type).toBe('validation_error');
    });

    it('should require content parameter', async () => {
      const result = await writeTool.execute({
        file_path: join(tempDir, 'test.txt'),
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('content parameter is required');
      expect(result.error_type).toBe('validation_error');
    });

    it('should handle null content', async () => {
      const result = await writeTool.execute({
        file_path: join(tempDir, 'test.txt'),
        content: null,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('content parameter is required');
    });

    it('should handle empty file_path', async () => {
      const result = await writeTool.execute({
        file_path: '',
        content: 'Content',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('file_path parameter is required');
    });
  });

  describe('special content', () => {
    it('should write content with special characters', async () => {
      const filePath = join(tempDir, 'special.txt');
      const content = 'Special: \t\n\r"\'`$@#%^&*()';

      const result = await writeTool.execute({
        file_path: filePath,
        content,
      });

      expect(result.success).toBe(true);

      const fileContent = await fs.readFile(filePath, 'utf-8');
      expect(fileContent).toBe(content);
    });

    it('should write unicode content', async () => {
      const filePath = join(tempDir, 'unicode.txt');
      const content = 'Unicode: 你好世界 🚀 ñáéíóú';

      const result = await writeTool.execute({
        file_path: filePath,
        content,
      });

      expect(result.success).toBe(true);

      const fileContent = await fs.readFile(filePath, 'utf-8');
      expect(fileContent).toBe(content);
    });

    it('should write large content', async () => {
      const filePath = join(tempDir, 'large.txt');
      const content = 'x'.repeat(100000); // 100KB

      const result = await writeTool.execute({
        file_path: filePath,
        content,
      });

      expect(result.success).toBe(true);
      expect(result.bytes_written).toBeGreaterThan(99000);

      const fileContent = await fs.readFile(filePath, 'utf-8');
      expect(fileContent.length).toBe(100000);
    });
  });

  describe('tool metadata', () => {
    it('should have correct tool name', () => {
      expect(writeTool.name).toBe('write');
    });

    it('should require confirmation', () => {
      expect(writeTool.requiresConfirmation).toBe(true);
    });

    it('should have proper function definition', () => {
      const def = writeTool.getFunctionDefinition();

      expect(def.type).toBe('function');
      expect(def.function.name).toBe('write');
      expect(def.function.parameters.required).toContain('file_path');
      expect(def.function.parameters.required).toContain('content');
    });

    it('should provide custom result preview', () => {
      const result = {
        success: true,
        error: '',
        file_path: '/test/file.txt',
        bytes_written: 123,
        backup_created: true,
      };

      const preview = writeTool.getResultPreview(result, 3);

      expect(preview).toContain('Wrote 123 bytes to /test/file.txt');
      expect(preview).toContain('Backup created: .bak');
    });
  });
});
