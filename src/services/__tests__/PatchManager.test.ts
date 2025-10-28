/**
 * Tests for PatchManager - comprehensive patch management system
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PatchManager } from '../PatchManager.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

describe('PatchManager', () => {
  let patchManager: PatchManager;
  let testPatchesDir: string;

  beforeEach(async () => {
    // Create temporary patches directory for testing
    testPatchesDir = path.join(os.tmpdir(), `code-ally-test-patches-${Date.now()}`);
    await fs.mkdir(testPatchesDir, { recursive: true });

    // Create PatchManager with test directory
    patchManager = new PatchManager(testPatchesDir);
    await patchManager.initialize();
  });

  afterEach(async () => {
    // Cleanup
    await patchManager.cleanup();
    try {
      await fs.rm(testPatchesDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  describe('initialization', () => {
    it('should initialize successfully', async () => {
      expect(patchManager).toBeDefined();
    });

    it('should create patches directory if it does not exist', async () => {
      const newDir = path.join(os.tmpdir(), `code-ally-new-${Date.now()}`);
      const newManager = new PatchManager(newDir);
      await newManager.initialize();

      const exists = await fs
        .access(newDir)
        .then(() => true)
        .catch(() => false);

      expect(exists).toBe(true);

      await newManager.cleanup();
      await fs.rm(newDir, { recursive: true, force: true });
    });

    it('should create patch index file', async () => {
      const indexPath = path.join(testPatchesDir, 'patch_index.json');
      const exists = await fs
        .access(indexPath)
        .then(() => true)
        .catch(() => false);

      expect(exists).toBe(true);
    });

    it('should initialize with empty patch list', async () => {
      const indexPath = path.join(testPatchesDir, 'patch_index.json');
      const content = await fs.readFile(indexPath, 'utf-8');
      const index = JSON.parse(content);

      expect(index.patches).toEqual([]);
      expect(index.next_patch_number).toBe(1);
    });
  });

  describe('captureOperation', () => {
    it('should capture a simple edit operation', async () => {
      const filePath = '/test/file.txt';
      const original = 'Hello\nWorld\n';
      const modified = 'Hello\nCodeAlly\n';

      const patchNumber = await patchManager.captureOperation(
        'edit',
        filePath,
        original,
        modified
      );

      expect(patchNumber).toBe(1);
    });

    it('should create a patch file on disk', async () => {
      const filePath = '/test/file.txt';
      const original = 'Hello\n';
      const modified = 'World\n';

      await patchManager.captureOperation('edit', filePath, original, modified);

      const patchPath = path.join(testPatchesDir, 'patch_001.diff');
      const exists = await fs
        .access(patchPath)
        .then(() => true)
        .catch(() => false);

      expect(exists).toBe(true);
    });

    it('should update the patch index', async () => {
      const filePath = '/test/file.txt';
      const original = 'Hello\n';
      const modified = 'World\n';

      await patchManager.captureOperation('edit', filePath, original, modified);

      const indexPath = path.join(testPatchesDir, 'patch_index.json');
      const content = await fs.readFile(indexPath, 'utf-8');
      const index = JSON.parse(content);

      expect(index.patches.length).toBe(1);
      expect(index.patches[0].operation_type).toBe('edit');
      expect(index.patches[0].file_path).toBe(filePath);
      expect(index.patches[0].patch_number).toBe(1);
      expect(index.next_patch_number).toBe(2);
    });

    it('should increment patch numbers', async () => {
      await patchManager.captureOperation('edit', '/test/file1.txt', 'a', 'b');
      await patchManager.captureOperation('edit', '/test/file2.txt', 'c', 'd');
      const patchNumber = await patchManager.captureOperation(
        'edit',
        '/test/file3.txt',
        'e',
        'f'
      );

      expect(patchNumber).toBe(3);
    });

    it('should handle file creation (empty original)', async () => {
      const filePath = '/test/new.txt';
      const original = '';
      const modified = 'New content\n';

      const patchNumber = await patchManager.captureOperation(
        'write',
        filePath,
        original,
        modified
      );

      expect(patchNumber).toBeGreaterThan(0);
    });

    it('should handle file deletion (empty modified)', async () => {
      const filePath = '/test/deleted.txt';
      const original = 'Old content\n';
      const modified = '';

      const patchNumber = await patchManager.captureOperation(
        'edit',
        filePath,
        original,
        modified
      );

      expect(patchNumber).toBeGreaterThan(0);
    });

    it('should skip if no changes between original and modified', async () => {
      const filePath = '/test/same.txt';
      const content = 'Same content\n';

      const patchNumber = await patchManager.captureOperation(
        'edit',
        filePath,
        content,
        content
      );

      expect(patchNumber).toBeNull();
    });

    it('should store patch file with correct metadata', async () => {
      const filePath = '/test/file.txt';
      const original = 'Hello\n';
      const modified = 'World\n';

      await patchManager.captureOperation('line_edit', filePath, original, modified);

      const patchPath = path.join(testPatchesDir, 'patch_001.diff');
      const content = await fs.readFile(patchPath, 'utf-8');

      expect(content).toContain('# Code Ally Patch File');
      expect(content).toContain('# Operation: line_edit');
      expect(content).toContain(`# File: ${filePath}`);
      expect(content).toContain('# Timestamp:');
      expect(content).toContain('===================================================================');
    });
  });

  describe('previewUndoOperations', () => {
    it('should preview a single undo operation', async () => {
      const filePath = '/test/file.txt';
      const original = 'Hello\n';
      const modified = 'World\n';

      await patchManager.captureOperation('edit', filePath, original, modified);

      // Create test file with modified content
      const testFilePath = path.join(testPatchesDir, 'test_file.txt');
      await fs.writeFile(testFilePath, modified, 'utf-8');

      const preview = await patchManager.previewUndoOperations(1);

      expect(preview).toBeDefined();
      expect(preview?.length).toBe(1);
      expect(preview![0].operation_type).toBe('edit');
      expect(preview![0].file_path).toBe(filePath);
      expect(preview![0].current_content).toBeDefined();
      expect(preview![0].predicted_content).toBeDefined();
    });

    it('should preview multiple undo operations', async () => {
      await patchManager.captureOperation('edit', '/test/file1.txt', 'a', 'b');
      await patchManager.captureOperation('edit', '/test/file2.txt', 'c', 'd');
      await patchManager.captureOperation('edit', '/test/file3.txt', 'e', 'f');

      const preview = await patchManager.previewUndoOperations(3);

      expect(preview).toBeDefined();
      expect(preview?.length).toBe(3);
    });

    it('should return null if count exceeds available patches', async () => {
      await patchManager.captureOperation('edit', '/test/file.txt', 'a', 'b');

      const preview = await patchManager.previewUndoOperations(5);

      expect(preview).toBeNull();
    });

    it('should return null if no patches exist', async () => {
      const preview = await patchManager.previewUndoOperations(1);

      expect(preview).toBeNull();
    });

    it('should show file deletion in preview', async () => {
      const filePath = '/test/file.txt';
      const original = '';
      const modified = 'Content\n';

      await patchManager.captureOperation('write', filePath, original, modified);

      const preview = await patchManager.previewUndoOperations(1);

      expect(preview).toBeDefined();
      expect(preview![0].current_content).toBe(''); // File doesn't exist yet
      expect(preview![0].predicted_content).toBe(''); // Will be deleted
    });
  });

  describe('undoOperations', () => {
    it('should undo a single operation successfully', async () => {
      const filePath = path.join(testPatchesDir, 'test_file.txt');
      const original = 'Hello\n';
      const modified = 'World\n';

      // Create file with original content
      await fs.writeFile(filePath, original, 'utf-8');

      // Capture edit
      await patchManager.captureOperation('edit', filePath, original, modified);

      // Modify file
      await fs.writeFile(filePath, modified, 'utf-8');

      // Undo
      const result = await patchManager.undoOperations(1);

      expect(result.success).toBe(true);
      expect(result.operations_undone).toBe(1);
      expect(result.files_modified.length).toBe(1);

      // Verify file content restored
      const content = await fs.readFile(filePath, 'utf-8');
      expect(content).toBe(original);
    });

    it('should undo multiple operations', async () => {
      const file1 = path.join(testPatchesDir, 'file1.txt');
      const file2 = path.join(testPatchesDir, 'file2.txt');

      await fs.writeFile(file1, 'a', 'utf-8');
      await fs.writeFile(file2, 'c', 'utf-8');

      await patchManager.captureOperation('edit', file1, 'a', 'b');
      await patchManager.captureOperation('edit', file2, 'c', 'd');

      await fs.writeFile(file1, 'b', 'utf-8');
      await fs.writeFile(file2, 'd', 'utf-8');

      const result = await patchManager.undoOperations(2);

      expect(result.success).toBe(true);
      expect(result.operations_undone).toBe(2);

      const content1 = await fs.readFile(file1, 'utf-8');
      const content2 = await fs.readFile(file2, 'utf-8');
      expect(content1).toBe('a');
      expect(content2).toBe('c');
    });

    it('should remove patches from index after successful undo', async () => {
      const filePath = path.join(testPatchesDir, 'test.txt');
      await fs.writeFile(filePath, 'a', 'utf-8');
      await patchManager.captureOperation('edit', filePath, 'a', 'b');
      await fs.writeFile(filePath, 'b', 'utf-8');

      await patchManager.undoOperations(1);

      const indexPath = path.join(testPatchesDir, 'patch_index.json');
      const content = await fs.readFile(indexPath, 'utf-8');
      const index = JSON.parse(content);

      expect(index.patches.length).toBe(0);
    });

    it('should delete patch files after successful undo', async () => {
      const filePath = path.join(testPatchesDir, 'test.txt');
      await fs.writeFile(filePath, 'a', 'utf-8');
      await patchManager.captureOperation('edit', filePath, 'a', 'b');
      await fs.writeFile(filePath, 'b', 'utf-8');

      await patchManager.undoOperations(1);

      const patchPath = path.join(testPatchesDir, 'patch_001.diff');
      const exists = await fs
        .access(patchPath)
        .then(() => true)
        .catch(() => false);

      expect(exists).toBe(false);
    });

    it('should fail if count exceeds available patches', async () => {
      await patchManager.captureOperation('edit', '/test/file.txt', 'a', 'b');

      const result = await patchManager.undoOperations(5);

      expect(result.success).toBe(false);
      expect(result.error).toContain('only 1 available');
    });

    it('should fail if no patches exist', async () => {
      const result = await patchManager.undoOperations(1);

      expect(result.success).toBe(false);
      expect(result.error).toContain('No patches available');
    });

    it('should handle partial failure gracefully', async () => {
      const file1 = path.join(testPatchesDir, 'file1.txt');
      const file2 = path.join(testPatchesDir, 'nonexistent.txt');

      await fs.writeFile(file1, 'a', 'utf-8');
      await patchManager.captureOperation('edit', file1, 'a', 'b');
      await patchManager.captureOperation('edit', file2, 'c', 'd'); // File doesn't exist

      await fs.writeFile(file1, 'b', 'utf-8');

      const result = await patchManager.undoOperations(2);

      // Should report failure with details
      expect(result.success).toBe(false);
      expect(result.failed_operations.length).toBeGreaterThan(0);
    });
  });

  describe('edge cases', () => {
    it('should handle corrupted patch index', async () => {
      const indexPath = path.join(testPatchesDir, 'patch_index.json');
      await fs.writeFile(indexPath, 'invalid json', 'utf-8');

      // Re-initialize should handle corruption
      const newManager = new PatchManager(testPatchesDir);
      await expect(newManager.initialize()).resolves.not.toThrow();

      await newManager.cleanup();
    });

    it('should handle missing patch file', async () => {
      await patchManager.captureOperation('edit', '/test/file.txt', 'a', 'b');

      // Delete the patch file
      const patchPath = path.join(testPatchesDir, 'patch_001.diff');
      await fs.unlink(patchPath);

      // Undo should fail gracefully
      const result = await patchManager.undoOperations(1);
      expect(result.success).toBe(false);
    });

    it('should handle very large patches', async () => {
      const original = 'Line\n'.repeat(10000);
      const modified = 'Line\n'.repeat(5000) + 'Modified\n' + 'Line\n'.repeat(4999);

      const patchNumber = await patchManager.captureOperation(
        'edit',
        '/test/large.txt',
        original,
        modified
      );

      expect(patchNumber).toBeGreaterThan(0);
    });

    it('should handle unicode content', async () => {
      const original = 'Hello 世界\n';
      const modified = 'Hello 🌍\n';

      const patchNumber = await patchManager.captureOperation(
        'edit',
        '/test/unicode.txt',
        original,
        modified
      );

      expect(patchNumber).toBeGreaterThan(0);
    });

    it('should handle concurrent captures (sequential execution)', async () => {
      const promises = [];
      for (let i = 0; i < 10; i++) {
        promises.push(
          patchManager.captureOperation('edit', `/test/file${i}.txt`, 'a', 'b')
        );
      }

      const results = await Promise.all(promises);
      const uniqueNumbers = new Set(results);

      // All patch numbers should be unique
      expect(uniqueNumbers.size).toBe(10);
    });
  });

  describe('session isolation', () => {
    it('should clear patches on initialization', async () => {
      // Create some patches
      await patchManager.captureOperation('edit', '/test/file1.txt', 'a', 'b');
      await patchManager.captureOperation('edit', '/test/file2.txt', 'c', 'd');

      // Cleanup
      await patchManager.cleanup();

      // Re-initialize should clear patches
      const newManager = new PatchManager(testPatchesDir);
      await newManager.initialize();

      const indexPath = path.join(testPatchesDir, 'patch_index.json');
      const content = await fs.readFile(indexPath, 'utf-8');
      const index = JSON.parse(content);

      expect(index.patches.length).toBe(0);

      await newManager.cleanup();
    });
  });

  describe('file operations', () => {
    it('should handle absolute paths', async () => {
      const absolutePath = path.resolve('/tmp/test_file.txt');
      await patchManager.captureOperation('edit', absolutePath, 'a', 'b');

      const indexPath = path.join(testPatchesDir, 'patch_index.json');
      const content = await fs.readFile(indexPath, 'utf-8');
      const index = JSON.parse(content);

      expect(index.patches[0].file_path).toBe(absolutePath);
    });

    it('should handle paths with special characters', async () => {
      const specialPath = '/test/file with spaces & $pecial.txt';
      await patchManager.captureOperation('edit', specialPath, 'a', 'b');

      const indexPath = path.join(testPatchesDir, 'patch_index.json');
      const content = await fs.readFile(indexPath, 'utf-8');
      const index = JSON.parse(content);

      expect(index.patches[0].file_path).toBe(specialPath);
    });
  });
});
