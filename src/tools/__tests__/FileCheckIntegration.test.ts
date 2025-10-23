/**
 * Integration tests for automatic file checking after modifications
 *
 * Verifies that WriteTool, EditTool, and LineEditTool automatically
 * check files after modification, matching Python CodeAlly pattern.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { WriteTool } from '../WriteTool.js';
import { EditTool } from '../EditTool.js';
import { LineEditTool } from '../LineEditTool.js';
import { ActivityStream } from '../../services/ActivityStream.js';

describe('Automatic File Checking After Modification', () => {
  let writeTool: WriteTool;
  let editTool: EditTool;
  let lineEditTool: LineEditTool;
  let activityStream: ActivityStream;
  let tmpDir: string;

  beforeEach(async () => {
    activityStream = new ActivityStream();
    writeTool = new WriteTool(activityStream);
    editTool = new EditTool(activityStream);
    lineEditTool = new LineEditTool(activityStream);
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'file-check-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('WriteTool', () => {
    it('should include file_check for valid JSON', async () => {
      const jsonPath = path.join(tmpDir, 'test.json');
      const result = await writeTool.execute({
        file_path: jsonPath,
        content: '{"name": "test", "version": "1.0.0"}',
      });

      expect(result.success).toBe(true);
      expect(result.file_check).toBeDefined();
      expect(result.file_check.checker).toBe('json');
      expect(result.file_check.passed).toBe(true);
      expect(result.file_check.errors).toHaveLength(0);
    });

    it('should include file_check with errors for invalid JSON', async () => {
      const jsonPath = path.join(tmpDir, 'broken.json');
      const result = await writeTool.execute({
        file_path: jsonPath,
        content: '{"name": "test",}',
      });

      expect(result.success).toBe(true);
      expect(result.file_check).toBeDefined();
      expect(result.file_check.checker).toBe('json');
      expect(result.file_check.passed).toBe(false);
      expect(result.file_check.errors.length).toBeGreaterThan(0);

      // Verify error has line, message, and source
      const error = result.file_check.errors[0];
      expect(error.line).toBeGreaterThan(0);
      expect(error.message).toBeTruthy();
    });

    it('should not include file_check for unsupported file types', async () => {
      const txtPath = path.join(tmpDir, 'test.txt');
      const result = await writeTool.execute({
        file_path: txtPath,
        content: 'plain text file',
      });

      expect(result.success).toBe(true);
      expect(result.file_check).toBeUndefined();
    });
  });

  describe('EditTool', () => {
    it('should include file_check after editing JSON', async () => {
      const jsonPath = path.join(tmpDir, 'test.json');

      // First write a valid JSON file
      await fs.writeFile(jsonPath, '{"name": "original"}', 'utf-8');

      // Edit it
      const result = await editTool.execute({
        file_path: jsonPath,
        old_string: '"original"',
        new_string: '"modified"',
      });

      expect(result.success).toBe(true);
      expect(result.file_check).toBeDefined();
      expect(result.file_check.checker).toBe('json');
      expect(result.file_check.passed).toBe(true);
    });

    it('should detect errors introduced by edit', async () => {
      const jsonPath = path.join(tmpDir, 'test.json');

      // Write a valid JSON file
      await fs.writeFile(jsonPath, '{"name": "test"}', 'utf-8');

      // Edit it to make it invalid
      const result = await editTool.execute({
        file_path: jsonPath,
        old_string: '"test"',
        new_string: '"test",',
      });

      expect(result.success).toBe(true);
      expect(result.file_check).toBeDefined();
      expect(result.file_check.passed).toBe(false);
      expect(result.file_check.errors.length).toBeGreaterThan(0);
    });
  });

  describe('LineEditTool', () => {
    it('should include file_check after line edit', async () => {
      const jsonPath = path.join(tmpDir, 'test.json');

      // Write a multi-line JSON file
      await fs.writeFile(
        jsonPath,
        '{\n  "name": "test",\n  "version": "1.0.0"\n}',
        'utf-8'
      );

      // Replace a line
      const result = await lineEditTool.execute({
        file_path: jsonPath,
        operation: 'replace',
        line_number: 2,
        content: '  "name": "modified",',
      });

      expect(result.success).toBe(true);
      expect(result.file_check).toBeDefined();
      expect(result.file_check.checker).toBe('json');
      expect(result.file_check.passed).toBe(true);
    });

    it('should detect errors introduced by line edit', async () => {
      const jsonPath = path.join(tmpDir, 'test.json');

      // Write a valid JSON file
      await fs.writeFile(
        jsonPath,
        '{\n  "name": "test"\n}',
        'utf-8'
      );

      // Insert an invalid line
      const result = await lineEditTool.execute({
        file_path: jsonPath,
        operation: 'insert',
        line_number: 2,
        content: '  invalid syntax here,',
      });

      expect(result.success).toBe(true);
      expect(result.file_check).toBeDefined();
      expect(result.file_check.passed).toBe(false);
      expect(result.file_check.errors.length).toBeGreaterThan(0);
    });
  });

  describe('Error Context', () => {
    it('should include source code context in errors', async () => {
      const jsonPath = path.join(tmpDir, 'test.json');
      const result = await writeTool.execute({
        file_path: jsonPath,
        content: '{invalid}',
      });

      expect(result.success).toBe(true);
      expect(result.file_check).toBeDefined();
      expect(result.file_check.errors.length).toBeGreaterThan(0);

      const error = result.file_check.errors[0];
      expect(error.source).toBeDefined();
      expect(error.source).toContain('invalid');
    });

    it('should limit errors to 10 for context optimization', async () => {
      const jsonPath = path.join(tmpDir, 'test.json');

      // Create JSON with many errors
      const brokenJson = Array(20).fill('{invalid}').join('\n');

      const result = await writeTool.execute({
        file_path: jsonPath,
        content: brokenJson,
      });

      expect(result.success).toBe(true);

      // Should have file_check but errors limited to 10
      if (result.file_check && result.file_check.errors.length > 0) {
        // JSON parser typically stops at first error, but if we had multiple,
        // they should be limited to 10
        expect(result.file_check.errors.length).toBeLessThanOrEqual(10);
      }
    });
  });
});
