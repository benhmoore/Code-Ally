/**
 * End-to-End Tests for ReadStateManager Integration
 *
 * Comprehensive validation of the entire read state tracking system
 * across all tools: ReadTool, EditTool, LineEditTool, WriteTool
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ReadTool } from '../ReadTool.js';
import { EditTool } from '../EditTool.js';
import { LineEditTool } from '../LineEditTool.js';
import { WriteTool } from '../WriteTool.js';
import { ActivityStream } from '../../services/ActivityStream.js';
import { ServiceRegistry } from '../../services/ServiceRegistry.js';
import { ReadStateManager } from '../../services/ReadStateManager.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

describe('ReadStateManager E2E Tests', () => {
  let readTool: ReadTool;
  let editTool: EditTool;
  let lineEditTool: LineEditTool;
  let writeTool: WriteTool;
  let activityStream: ActivityStream;
  let readStateManager: ReadStateManager;
  let testDir: string;
  let testFile: string;

  beforeEach(async () => {
    // Create isolated test environment
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'e2e-test-'));
    testFile = path.join(testDir, 'test.txt');

    // Create test file with 100 lines
    const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`);
    await fs.writeFile(testFile, lines.join('\n'), 'utf-8');

    // Initialize services
    activityStream = new ActivityStream();
    const registry = ServiceRegistry.getInstance();

    // Create fresh ReadStateManager
    readStateManager = new ReadStateManager();
    registry.registerInstance('read_state_manager', readStateManager);

    // Initialize tools
    readTool = new ReadTool(activityStream);
    editTool = new EditTool(activityStream);
    lineEditTool = new LineEditTool(activityStream);
    writeTool = new WriteTool(activityStream);
  });

  afterEach(async () => {
    // Cleanup
    await fs.rm(testDir, { recursive: true, force: true });
    await ServiceRegistry.getInstance().shutdown();
  });

  describe('Test 1: Basic Read → Edit Flow', () => {
    it('should allow LineEdit after Read', async () => {
      // 1. Read file (lines 1-100)
      const readResult = await readTool.execute({
        file_paths: [testFile],
        offset: 0,
        limit: 100,
      });

      expect(readResult.success).toBe(true);

      // 2. LineEdit replace line 50
      const editResult = await lineEditTool.execute({
        file_path: testFile,
        operation: 'replace',
        line_number: 50,
        content: 'Modified Line 50',
      });

      // Should succeed (line 50 was read)
      expect(editResult.success).toBe(true);
    });
  });

  describe('Test 2: Edit Without Read', () => {
    it('should reject LineEdit without prior read', async () => {
      // 1. LineEdit replace line 50 (without reading first)
      const editResult = await lineEditTool.execute({
        file_path: testFile,
        operation: 'replace',
        line_number: 50,
        content: 'Modified Line 50',
      });

      // Should FAIL with validation error
      expect(editResult.success).toBe(false);
      expect(editResult.error_type).toBe('validation_error');
      expect(editResult.error).toContain('File has not been read');
    });
  });

  describe('Test 3: Invalidation After Edit', () => {
    it('should invalidate lines after insert operation', async () => {
      // 1. Read file (lines 1-100)
      await readTool.execute({
        file_paths: [testFile],
        offset: 0,
        limit: 100,
      });

      // 2. LineEdit insert 2 lines at line 20
      const insertResult = await lineEditTool.execute({
        file_path: testFile,
        operation: 'insert',
        line_number: 20,
        content: 'New Line 1\nNew Line 2',
      });
      expect(insertResult.success).toBe(true);

      // 3. LineEdit replace line 25 (without re-reading)
      const replaceResult = await lineEditTool.execute({
        file_path: testFile,
        operation: 'replace',
        line_number: 25,
        content: 'Modified Line 25',
      });

      // Should FAIL (lines 20+ were invalidated)
      expect(replaceResult.success).toBe(false);
      expect(replaceResult.error_type).toBe('validation_error');
      expect(replaceResult.error).toContain('File has not been read');
    });
  });

  describe('Test 4: Write → Edit Flow', () => {
    it('should allow LineEdit after Write (without Read)', async () => {
      const newFile = path.join(testDir, 'new-file.txt');
      const lines = Array.from({ length: 10 }, (_, i) => `Line ${i + 1}`);

      // 1. Write new file with 10 lines
      const writeResult = await writeTool.execute({
        file_path: newFile,
        content: lines.join('\n'),
      });
      expect(writeResult.success).toBe(true);

      // 2. LineEdit replace line 5 (without reading)
      const editResult = await lineEditTool.execute({
        file_path: newFile,
        operation: 'replace',
        line_number: 5,
        content: 'Modified Line 5',
      });

      // Should SUCCEED (write tracked as read)
      expect(editResult.success).toBe(true);
    });
  });

  describe('Test 5: EditTool Full File Requirement', () => {
    it('should reject EditTool with partial read', async () => {
      // 1. Read file lines 1-50 (partial)
      await readTool.execute({
        file_paths: [testFile],
        offset: 0,
        limit: 50,
      });

      // 2. EditTool replace string
      const editResult = await editTool.execute({
        file_path: testFile,
        old_string: 'Line 25',
        new_string: 'Modified Line 25',
      });

      // Should FAIL (requires full file read)
      expect(editResult.success).toBe(false);
      expect(editResult.error_type).toBe('validation_error');
      expect(editResult.error).toContain('Lines not read');
    });
  });

  describe('Test 6: EditTool Clears State', () => {
    it('should clear read state after EditTool', async () => {
      // Get actual file size
      const content = await fs.readFile(testFile, 'utf-8');
      const lineCount = content.split('\n').length;

      // 1. Read full file
      await readTool.execute({
        file_paths: [testFile],
        offset: 0,
        limit: lineCount,
      });

      // 2. EditTool replace string
      const editResult = await editTool.execute({
        file_path: testFile,
        old_string: 'Line 25',
        new_string: 'Modified Line 25',
      });
      expect(editResult.success).toBe(true);

      // 3. LineEdit replace line 5 (without re-reading)
      const lineEditResult = await lineEditTool.execute({
        file_path: testFile,
        operation: 'replace',
        line_number: 5,
        content: 'Another Modification',
      });

      // Should FAIL (EditTool cleared state)
      expect(lineEditResult.success).toBe(false);
      expect(lineEditResult.error_type).toBe('validation_error');
      expect(lineEditResult.error).toContain('File has not been read');
    });

    it('should handle EditTool with replace_all and multi-line replacement', async () => {
      // Create test file with multiple instances of a pattern
      const testContent = `function foo() {
  return 'old';
}

function bar() {
  return 'old';
}

function baz() {
  return 'old';
}`;

      await fs.writeFile(testFile, testContent, 'utf-8');

      // Read the entire file to track read state
      await readTool.execute({
        file_paths: [testFile],
      });

      // Replace all instances of "return 'old';" with multi-line replacement
      const result = await editTool.execute({
        file_path: testFile,
        old_string: "return 'old';",
        new_string: "const result = process();\n  return result;",
        replace_all: true,
      });

      expect(result.success).toBe(true);

      // Verify read state was completely cleared
      // EditTool clears all read state after execution
      const validation = readStateManager.validateLinesRead(testFile, 1, 11);
      expect(validation.success).toBe(false); // All lines invalidated after EditTool
    });
  });

  describe('Test 7: Multiple Disjoint Reads', () => {
    it('should reject edits to unread lines', async () => {
      // 1. Read lines 1-20
      await readTool.execute({
        file_paths: [testFile],
        offset: 0,
        limit: 20,
      });

      // 2. Read lines 50-70
      await readTool.execute({
        file_paths: [testFile],
        offset: 49,
        limit: 21,
      });

      // 3. LineEdit replace line 30
      const editResult = await lineEditTool.execute({
        file_path: testFile,
        operation: 'replace',
        line_number: 30,
        content: 'Modified Line 30',
      });

      // Should FAIL (line 30 not in read ranges)
      expect(editResult.success).toBe(false);
      expect(editResult.error_type).toBe('validation_error');
    });
  });

  describe('Test 8: Range Merging', () => {
    it('should merge overlapping read ranges', async () => {
      // 1. Read lines 1-30
      await readTool.execute({
        file_paths: [testFile],
        offset: 0,
        limit: 30,
      });

      // 2. Read lines 25-50
      await readTool.execute({
        file_paths: [testFile],
        offset: 24,
        limit: 26,
      });

      // 3. LineEdit replace line 35
      const editResult = await lineEditTool.execute({
        file_path: testFile,
        operation: 'replace',
        line_number: 35,
        content: 'Modified Line 35',
      });

      // Should SUCCEED (ranges merged to 1-50)
      expect(editResult.success).toBe(true);
    });
  });

  describe('Additional Integration Tests', () => {
    it('should handle delete operation invalidation correctly', async () => {
      // Read full file
      const content = await fs.readFile(testFile, 'utf-8');
      const lineCount = content.split('\n').length;

      await readTool.execute({
        file_paths: [testFile],
        offset: 0,
        limit: lineCount,
      });

      // Delete line 30
      const deleteResult = await lineEditTool.execute({
        file_path: testFile,
        operation: 'delete',
        line_number: 30,
      });
      expect(deleteResult.success).toBe(true);

      // Try to edit line 50 (now line 49 after deletion)
      const editResult = await lineEditTool.execute({
        file_path: testFile,
        operation: 'replace',
        line_number: 50,
        content: 'Modified',
      });

      // Should FAIL (lines after deletion were invalidated)
      expect(editResult.success).toBe(false);
    });

    it('should allow edits to unaffected lines after insert', async () => {
      // Read full file
      const content = await fs.readFile(testFile, 'utf-8');
      const lineCount = content.split('\n').length;

      await readTool.execute({
        file_paths: [testFile],
        offset: 0,
        limit: lineCount,
      });

      // Insert after line 50
      await lineEditTool.execute({
        file_path: testFile,
        operation: 'insert',
        line_number: 50,
        content: 'New Line',
      });

      // Edit line 10 (before insert point - should still be valid)
      const editResult = await lineEditTool.execute({
        file_path: testFile,
        operation: 'replace',
        line_number: 10,
        content: 'Modified Line 10',
      });

      // Should SUCCEED (line 10 was not invalidated)
      expect(editResult.success).toBe(true);
    });

    it('should validate delete operation against read state', async () => {
      // Only read lines 1-50
      await readTool.execute({
        file_path: testFile,
        offset: 0,
        limit: 50,
      });

      // Try to delete line 75 (not read)
      const deleteResult = await lineEditTool.execute({
        file_path: testFile,
        operation: 'delete',
        line_number: 75,
      });

      // Should FAIL (line not read)
      expect(deleteResult.success).toBe(false);
      expect(deleteResult.error_type).toBe('validation_error');
    });

    it('should handle insert_before operation correctly', async () => {
      // Read full file
      const content = await fs.readFile(testFile, 'utf-8');
      const lineCount = content.split('\n').length;

      await readTool.execute({
        file_paths: [testFile],
        offset: 0,
        limit: lineCount,
      });

      // Insert before line 30
      const insertResult = await lineEditTool.execute({
        file_path: testFile,
        operation: 'insert',
        line_number: 30,
        content: 'New Line Before',
      });
      expect(insertResult.success).toBe(true);

      // Try to edit line 30 (now invalidated)
      const editResult = await lineEditTool.execute({
        file_path: testFile,
        operation: 'replace',
        line_number: 30,
        content: 'Modified',
      });

      // Should FAIL (line 30+ invalidated)
      expect(editResult.success).toBe(false);
    });
  });

  describe('Performance Tests', () => {
    it('should complete operations quickly', async () => {
      const start = Date.now();

      // Simulate realistic workflow
      await readTool.execute({ file_paths: [testFile], offset: 0, limit: 100 });
      await lineEditTool.execute({
        file_path: testFile,
        operation: 'replace',
        line_number: 50,
        content: 'Modified',
      });
      await readTool.execute({ file_paths: [testFile], offset: 0, limit: 100 });
      await lineEditTool.execute({
        file_path: testFile,
        operation: 'replace',
        line_number: 75,
        content: 'Modified',
      });

      const duration = Date.now() - start;

      // Should complete in under 100ms (very conservative)
      expect(duration).toBeLessThan(100);
    });
  });

  describe('Edge Cases', () => {
    it('should handle editing line 1', async () => {
      await readTool.execute({ file_paths: [testFile], offset: 0, limit: 10 });

      const editResult = await lineEditTool.execute({
        file_path: testFile,
        operation: 'replace',
        line_number: 1,
        content: 'Modified First Line',
      });

      expect(editResult.success).toBe(true);
    });

    it('should handle editing last line', async () => {
      const content = await fs.readFile(testFile, 'utf-8');
      const lineCount = content.split('\n').length;

      await readTool.execute({
        file_paths: [testFile],
        offset: 0,
        limit: lineCount,
      });

      const editResult = await lineEditTool.execute({
        file_path: testFile,
        operation: 'replace',
        line_number: lineCount,
        content: 'Modified Last Line',
      });

      expect(editResult.success).toBe(true);
    });

    it('should handle empty file write and edit', async () => {
      const emptyFile = path.join(testDir, 'empty.txt');

      // Write empty file
      await writeTool.execute({
        file_path: emptyFile,
        content: '',
      });

      // Should be able to insert at line 1
      const insertResult = await lineEditTool.execute({
        file_path: emptyFile,
        operation: 'insert',
        line_number: 1,
        content: 'First Line',
      });

      expect(insertResult.success).toBe(true);
    });

    it('should handle single-line file', async () => {
      const singleFile = path.join(testDir, 'single.txt');

      await writeTool.execute({
        file_path: singleFile,
        content: 'Single Line',
      });

      const editResult = await lineEditTool.execute({
        file_path: singleFile,
        operation: 'replace',
        line_number: 1,
        content: 'Modified Single Line',
      });

      expect(editResult.success).toBe(true);
    });
  });
});
