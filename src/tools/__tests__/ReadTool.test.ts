/**
 * Tests for ReadTool
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ReadTool } from '@tools/ReadTool.js';
import { ActivityStream } from '@services/ActivityStream.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

describe('ReadTool', () => {
  let activityStream: ActivityStream;
  let readTool: ReadTool;
  let tempDir: string;
  let testFile: string;

  beforeEach(async () => {
    activityStream = new ActivityStream();
    readTool = new ReadTool(activityStream);

    // Create temp directory and test file
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'read-tool-test-'));
    testFile = path.join(tempDir, 'test.txt');
    await fs.writeFile(testFile, 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5\n');
  });

  afterEach(async () => {
    // Clean up temp directory
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('basic properties', () => {
    it('should have correct name', () => {
      expect(readTool.name).toBe('read');
    });

    it('should not require confirmation', () => {
      expect(readTool.requiresConfirmation).toBe(false);
    });

    it('should have function definition', () => {
      const def = readTool.getFunctionDefinition();
      expect(def.function.name).toBe('read');
      expect(def.function.parameters.required).toContain('file_paths');
    });
  });

  describe('execute', () => {
    it('should read single file', async () => {
      const result = await readTool.execute({
        file_paths: [testFile],
      });

      expect(result.success).toBe(true);
      expect(result.content).toContain('Line 1');
      expect(result.content).toContain('Line 5');
      expect(result.files_read).toBe(1);
    });

    it('should read multiple files', async () => {
      const testFile2 = path.join(tempDir, 'test2.txt');
      await fs.writeFile(testFile2, 'File 2 content\n');

      const result = await readTool.execute({
        file_paths: [testFile, testFile2],
      });

      expect(result.success).toBe(true);
      expect(result.content).toContain('Line 1');
      expect(result.content).toContain('File 2 content');
      expect(result.files_read).toBe(2);
    });

    it('should include line numbers', async () => {
      const result = await readTool.execute({
        file_paths: [testFile],
      });

      expect(result.success).toBe(true);
      // Line numbers should be present (padded to 6 chars)
      expect(result.content).toMatch(/\s+1\t/);
      expect(result.content).toMatch(/\s+2\t/);
    });

    it('should respect limit parameter', async () => {
      const result = await readTool.execute({
        file_paths: [testFile],
        limit: 2,
      });

      expect(result.success).toBe(true);
      expect(result.content).toContain('Line 1');
      expect(result.content).toContain('Line 2');
      expect(result.content).not.toContain('Line 3');
    });

    it('should respect offset parameter', async () => {
      const result = await readTool.execute({
        file_paths: [testFile],
        offset: 3, // Start from line 3
      });

      expect(result.success).toBe(true);
      expect(result.content).not.toContain('Line 1');
      expect(result.content).not.toContain('Line 2');
      expect(result.content).toContain('Line 3');
    });

    it('should handle non-existent file', async () => {
      const result = await readTool.execute({
        file_paths: [path.join(tempDir, 'nonexistent.txt')],
      });

      expect(result.success).toBe(false); // Tool fails when ALL files fail
      expect(result.error).toBeDefined();
      expect(result.error).toContain('Failed to read');
    });

    it('should require file_paths parameter', async () => {
      const result = await readTool.execute({});

      expect(result.success).toBe(false);
      expect(result.error).toContain('file_paths');
      expect(result.error_type).toBe('validation_error');
    });

    it('should reject empty file_paths array', async () => {
      const result = await readTool.execute({
        file_paths: [],
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('non-empty array');
    });

    it('should detect binary files', async () => {
      const binaryFile = path.join(tempDir, 'binary.bin');
      // Write binary content with null bytes
      await fs.writeFile(binaryFile, Buffer.from([0x00, 0x01, 0x02, 0xff]));

      const result = await readTool.execute({
        file_paths: [binaryFile],
      });

      expect(result.success).toBe(true);
      expect(result.content).toContain('Binary file');
    });
  });

  describe('getResultPreview', () => {
    it('should show files read count', async () => {
      const result = await readTool.execute({
        file_paths: [testFile],
      });

      const preview = readTool.getResultPreview(result, 3);
      expect(preview[0]).toContain('Read 1 file');
    });

    it('should show content preview', async () => {
      const result = await readTool.execute({
        file_paths: [testFile],
      });

      const preview = readTool.getResultPreview(result, 3);
      expect(preview.length).toBeGreaterThan(1);
      expect(preview.some((line) => line.includes('Line 1'))).toBe(true);
    });
  });
});
