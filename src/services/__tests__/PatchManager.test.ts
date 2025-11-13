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
  let testSessionId: string;
  let testFilesDir: string;

  // Helper to get the actual patches directory
  const getPatchesDir = () => path.join(process.cwd(), '.ally-sessions', testSessionId, 'patches');

  beforeEach(async () => {
    // Create unique session ID for this test
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(7);
    testSessionId = `test-session-${timestamp}-${random}`;

    // Create temporary directory for test files
    testFilesDir = path.join(os.tmpdir(), `code-ally-test-files-${timestamp}-${random}`);
    await fs.mkdir(testFilesDir, { recursive: true });

    // Create PatchManager with test config
    patchManager = new PatchManager({
      getSessionId: () => testSessionId,
      maxPatchesPerSession: 100,
      maxPatchesSizeBytes: 10 * 1024 * 1024
    });
    await patchManager.initialize();
  });

  afterEach(async () => {
    // Cleanup
    await patchManager.cleanup();
    try {
      await fs.rm(path.join(process.cwd(), '.ally-sessions', testSessionId), { recursive: true, force: true });
      await fs.rm(testFilesDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  describe('initialization', () => {
    it('should initialize successfully', async () => {
      expect(patchManager).toBeDefined();
    });

    it('should create patches directory when capturing first operation', async () => {
      const newSessionId = `new-session-${Date.now()}`;
      const newManager = new PatchManager({
        getSessionId: () => newSessionId,
        maxPatchesPerSession: 100,
        maxPatchesSizeBytes: 10 * 1024 * 1024
      });
      await newManager.initialize();

      const newDir = path.join(process.cwd(), '.ally-sessions', newSessionId, 'patches');

      // Directory should not exist until we capture an operation
      const existsBefore = await fs
        .access(newDir)
        .then(() => true)
        .catch(() => false);
      expect(existsBefore).toBe(false);

      // Capture an operation - this should create the directory
      await newManager.captureOperation('edit', '/test/file.txt', 'a', 'b');

      // Now directory should exist
      const existsAfter = await fs
        .access(newDir)
        .then(() => true)
        .catch(() => false);
      expect(existsAfter).toBe(true);

      await newManager.cleanup();
      await fs.rm(path.join(process.cwd(), '.ally-sessions', newSessionId), { recursive: true, force: true });
    });

    it('should create patch index file when capturing first operation', async () => {
      // Index file should not exist until first operation
      const indexPath = path.join(getPatchesDir(), 'patch_index.json');
      const existsBefore = await fs
        .access(indexPath)
        .then(() => true)
        .catch(() => false);
      expect(existsBefore).toBe(false);

      // Capture an operation
      await patchManager.captureOperation('edit', '/test/file.txt', 'a', 'b');

      // Now index should exist
      const existsAfter = await fs
        .access(indexPath)
        .then(() => true)
        .catch(() => false);
      expect(existsAfter).toBe(true);
    });

    it('should initialize with empty patch list when no session exists', async () => {
      // Get patch history should return empty array
      const history = patchManager.getPatchHistory();
      expect(history).toEqual([]);
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

      const patchPath = path.join(getPatchesDir(), 'patch_001.diff');
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

      const indexPath = path.join(getPatchesDir(), 'patch_index.json');
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

    it('should still create patch even if no changes between original and modified', async () => {
      const filePath = '/test/same.txt';
      const content = 'Same content\n';

      const patchNumber = await patchManager.captureOperation(
        'edit',
        filePath,
        content,
        content
      );

      // PatchManager still creates a patch, even if diff has no hunks
      expect(patchNumber).toBeGreaterThan(0);
    });

    it('should store patch file with correct metadata', async () => {
      const filePath = '/test/file.txt';
      const original = 'Hello\n';
      const modified = 'World\n';

      await patchManager.captureOperation('line_edit', filePath, original, modified);

      const patchPath = path.join(getPatchesDir(), 'patch_001.diff');
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
      const testFilePath = path.join(testFilesDir, 'test_file.txt');
      const original = 'Hello\n';
      const modified = 'World\n';

      // Create file with original content first
      await fs.writeFile(testFilePath, original, 'utf-8');

      // Capture the operation
      await patchManager.captureOperation('edit', testFilePath, original, modified);

      // Modify the file to simulate the edit happening
      await fs.writeFile(testFilePath, modified, 'utf-8');

      const preview = await patchManager.previewUndoOperations(1);

      expect(preview).toBeDefined();
      expect(preview?.length).toBe(1);
      expect(preview![0].operation_type).toBe('edit');
      expect(preview![0].file_path).toBe(testFilePath);
      expect(preview![0].current_content).toBe(modified);
      expect(preview![0].predicted_content).toBe(original);
    });

    it('should preview multiple undo operations', async () => {
      const file1 = path.join(testFilesDir, 'file1.txt');
      const file2 = path.join(testFilesDir, 'file2.txt');
      const file3 = path.join(testFilesDir, 'file3.txt');

      // Create files and capture operations
      await fs.writeFile(file1, 'a', 'utf-8');
      await patchManager.captureOperation('edit', file1, 'a', 'b');
      await fs.writeFile(file1, 'b', 'utf-8');

      await fs.writeFile(file2, 'c', 'utf-8');
      await patchManager.captureOperation('edit', file2, 'c', 'd');
      await fs.writeFile(file2, 'd', 'utf-8');

      await fs.writeFile(file3, 'e', 'utf-8');
      await patchManager.captureOperation('edit', file3, 'e', 'f');
      await fs.writeFile(file3, 'f', 'utf-8');

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

    it('should show file creation reversal in preview', async () => {
      const testFilePath = path.join(testFilesDir, 'created_file.txt');
      const original = '';
      const modified = 'Content\n';

      // Capture file creation
      await patchManager.captureOperation('write', testFilePath, original, modified);

      // Create the file
      await fs.writeFile(testFilePath, modified, 'utf-8');

      const preview = await patchManager.previewUndoOperations(1);

      expect(preview).toBeDefined();
      expect(preview![0].current_content).toBe(modified);
      expect(preview![0].predicted_content).toBe('');
    });
  });

  describe('undoOperations', () => {
    it('should undo a single operation successfully', async () => {
      const filePath = path.join(testFilesDir, 'test_file.txt');
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
      expect(result.reverted_files.length).toBe(1);
      expect(result.failed_operations).toHaveLength(0);

      // Verify file content restored
      const content = await fs.readFile(filePath, 'utf-8');
      expect(content).toBe(original);
    });

    it('should undo multiple operations', async () => {
      const file1 = path.join(testFilesDir, 'file1.txt');
      const file2 = path.join(testFilesDir, 'file2.txt');

      await fs.writeFile(file1, 'a', 'utf-8');
      await fs.writeFile(file2, 'c', 'utf-8');

      await patchManager.captureOperation('edit', file1, 'a', 'b');
      await patchManager.captureOperation('edit', file2, 'c', 'd');

      await fs.writeFile(file1, 'b', 'utf-8');
      await fs.writeFile(file2, 'd', 'utf-8');

      const result = await patchManager.undoOperations(2);

      expect(result.success).toBe(true);
      expect(result.reverted_files.length).toBe(2);

      const content1 = await fs.readFile(file1, 'utf-8');
      const content2 = await fs.readFile(file2, 'utf-8');
      expect(content1).toBe('a');
      expect(content2).toBe('c');
    });

    it('should remove patches from index after successful undo', async () => {
      const filePath = path.join(testFilesDir, 'test.txt');
      await fs.writeFile(filePath, 'a', 'utf-8');
      await patchManager.captureOperation('edit', filePath, 'a', 'b');
      await fs.writeFile(filePath, 'b', 'utf-8');

      await patchManager.undoOperations(1);

      const indexPath = path.join(getPatchesDir(), 'patch_index.json');
      const content = await fs.readFile(indexPath, 'utf-8');
      const index = JSON.parse(content);

      expect(index.patches.length).toBe(0);
    });

    it('should delete patch files after successful undo', async () => {
      const filePath = path.join(testFilesDir, 'test.txt');
      await fs.writeFile(filePath, 'a', 'utf-8');
      await patchManager.captureOperation('edit', filePath, 'a', 'b');
      await fs.writeFile(filePath, 'b', 'utf-8');

      await patchManager.undoOperations(1);

      const patchPath = path.join(getPatchesDir(), 'patch_001.diff');
      const exists = await fs
        .access(patchPath)
        .then(() => true)
        .catch(() => false);

      expect(exists).toBe(false);
    });

    it('should fail if count exceeds available patches', async () => {
      await patchManager.captureOperation('edit', '/test/file.txt', 'a', 'b');

      const result = await patchManager.undoOperations(5);

      // Should warn that only 1 patch is available but still succeed in undoing that 1 patch
      expect(result.reverted_files.length).toBeLessThanOrEqual(1);
    });

    it('should fail if no patches exist', async () => {
      const result = await patchManager.undoOperations(1);

      expect(result.success).toBe(false);
      expect(result.failed_operations[0]).toContain('No operations to undo');
    });

    it('should handle partial failure gracefully', async () => {
      const file1 = path.join(testFilesDir, 'file1.txt');
      const file2 = path.join(testFilesDir, 'nonexistent.txt');

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
      // First create a patch to ensure directory exists
      await patchManager.captureOperation('edit', '/test/file.txt', 'a', 'b');

      const indexPath = path.join(getPatchesDir(), 'patch_index.json');
      await fs.writeFile(indexPath, 'invalid json', 'utf-8');

      // Re-initialize with same session should handle corruption
      const newManager = new PatchManager({
        getSessionId: () => testSessionId,
        maxPatchesPerSession: 100,
        maxPatchesSizeBytes: 10 * 1024 * 1024
      });
      await expect(newManager.initialize()).resolves.not.toThrow();

      await newManager.cleanup();
    });

    it('should handle missing patch file', async () => {
      await patchManager.captureOperation('edit', '/test/file.txt', 'a', 'b');

      // Delete the patch file
      const patchPath = path.join(getPatchesDir(), 'patch_001.diff');
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

    it('should handle sequential captures', async () => {
      // Capture patches sequentially to avoid race conditions
      const results = [];
      for (let i = 0; i < 10; i++) {
        const patchNumber = await patchManager.captureOperation(
          'edit',
          `/test/file${i}.txt`,
          `content${i}`,
          `modified${i}`
        );
        results.push(patchNumber);
      }

      const validResults = results.filter(r => r !== null);
      const uniqueNumbers = new Set(validResults);

      // All patch numbers should be unique and we should get 10 patches
      expect(validResults.length).toBe(10);
      expect(uniqueNumbers.size).toBe(10);
    });
  });

  describe('session isolation', () => {
    it('should maintain patches across re-initialization of same session', async () => {
      // Create some patches
      await patchManager.captureOperation('edit', '/test/file1.txt', 'a', 'b');
      await patchManager.captureOperation('edit', '/test/file2.txt', 'c', 'd');

      // Cleanup
      await patchManager.cleanup();

      // Re-initialize with same session should keep patches
      const newManager = new PatchManager({
        getSessionId: () => testSessionId,
        maxPatchesPerSession: 100,
        maxPatchesSizeBytes: 10 * 1024 * 1024
      });
      await newManager.initialize();

      const indexPath = path.join(getPatchesDir(), 'patch_index.json');
      const content = await fs.readFile(indexPath, 'utf-8');
      const index = JSON.parse(content);

      expect(index.patches.length).toBe(2);

      await newManager.cleanup();
    });
  });

  describe('file operations', () => {
    it('should handle absolute paths', async () => {
      const absolutePath = path.resolve('/tmp/test_file.txt');
      await patchManager.captureOperation('edit', absolutePath, 'a', 'b');

      const indexPath = path.join(getPatchesDir(), 'patch_index.json');
      const content = await fs.readFile(indexPath, 'utf-8');
      const index = JSON.parse(content);

      expect(index.patches[0].file_path).toBe(absolutePath);
    });

    it('should handle paths with special characters', async () => {
      const specialPath = '/test/file with spaces & $pecial.txt';
      await patchManager.captureOperation('edit', specialPath, 'a', 'b');

      const indexPath = path.join(getPatchesDir(), 'patch_index.json');
      const content = await fs.readFile(indexPath, 'utf-8');
      const index = JSON.parse(content);

      expect(index.patches[0].file_path).toBe(specialPath);
    });
  });

  describe('patch integrity validation', () => {
    it('should validate patches successfully when all files exist', async () => {
      // Create some patches
      await patchManager.captureOperation('edit', '/test/file1.txt', 'a', 'b');
      await patchManager.captureOperation('edit', '/test/file2.txt', 'c', 'd');

      // Trigger validation by session change
      await patchManager.onSessionChange();

      // All patches should still exist
      const indexPath = path.join(getPatchesDir(), 'patch_index.json');
      const content = await fs.readFile(indexPath, 'utf-8');
      const index = JSON.parse(content);

      expect(index.patches.length).toBe(2);
    });

    it('should quarantine patches with missing files', async () => {
      // Create patches
      await patchManager.captureOperation('edit', '/test/file1.txt', 'a', 'b');
      await patchManager.captureOperation('edit', '/test/file2.txt', 'c', 'd');
      await patchManager.captureOperation('edit', '/test/file3.txt', 'e', 'f');

      // Manually delete a patch file to simulate corruption
      const patchFile = path.join(getPatchesDir(), 'patch_002.diff');
      await fs.unlink(patchFile);

      // Trigger validation
      await patchManager.onSessionChange();

      // Check that corrupted patch was removed from index
      const indexPath = path.join(getPatchesDir(), 'patch_index.json');
      const content = await fs.readFile(indexPath, 'utf-8');
      const index = JSON.parse(content);

      expect(index.patches.length).toBe(2);
      expect(index.patches.find((p: any) => p.patch_number === 2)).toBeUndefined();

      // Check that quarantine file was created
      const quarantineDir = path.join(process.cwd(), '.ally-sessions', '.quarantine');
      const quarantineFiles = await fs.readdir(quarantineDir);
      const quarantineFile = quarantineFiles.find(f => f.startsWith(`patches_${testSessionId}_`));

      expect(quarantineFile).toBeDefined();

      // Verify quarantine file content
      const quarantinePath = path.join(quarantineDir, quarantineFile!);
      const quarantineContent = await fs.readFile(quarantinePath, 'utf-8');
      const quarantineData = JSON.parse(quarantineContent);

      expect(quarantineData.reason).toBe('missing_patch_file');
      expect(quarantineData.patches.length).toBe(1);
      expect(quarantineData.patches[0].patch_number).toBe(2);
    });

    it('should quarantine orphaned patch files not in index', async () => {
      // Create patches
      await patchManager.captureOperation('edit', '/test/file1.txt', 'a', 'b');
      await patchManager.captureOperation('edit', '/test/file2.txt', 'c', 'd');

      // Manually create an orphaned patch file
      const orphanedFile = path.join(getPatchesDir(), 'patch_9999.diff');
      await fs.writeFile(orphanedFile, 'orphaned patch content', 'utf-8');

      // Trigger validation
      await patchManager.onSessionChange();

      // Check that orphaned file was moved to quarantine
      const orphanedExists = await fs.access(orphanedFile).then(() => true).catch(() => false);
      expect(orphanedExists).toBe(false);

      // Check quarantine directory
      const quarantineDir = path.join(process.cwd(), '.ally-sessions', '.quarantine');
      const quarantineDirs = await fs.readdir(quarantineDir);
      const orphanedDir = quarantineDirs.find(d => d.startsWith(`orphaned_${testSessionId}_`));

      expect(orphanedDir).toBeDefined();

      // Verify orphaned file is in quarantine
      const quarantinePath = path.join(quarantineDir, orphanedDir!);
      const quarantinedFiles = await fs.readdir(quarantinePath);
      expect(quarantinedFiles).toContain('patch_9999.diff');

      // Verify manifest was created
      expect(quarantinedFiles).toContain('MANIFEST.json');
      const manifestPath = path.join(quarantinePath, 'MANIFEST.json');
      const manifestContent = await fs.readFile(manifestPath, 'utf-8');
      const manifest = JSON.parse(manifestContent);

      expect(manifest.reason).toBe('orphaned_files_not_in_index');
      expect(manifest.files).toContain('patch_9999.diff');
    });

    it('should handle multiple corrupted patches', async () => {
      // Create patches
      await patchManager.captureOperation('edit', '/test/file1.txt', 'a', 'b');
      await patchManager.captureOperation('edit', '/test/file2.txt', 'c', 'd');
      await patchManager.captureOperation('edit', '/test/file3.txt', 'e', 'f');
      await patchManager.captureOperation('edit', '/test/file4.txt', 'g', 'h');

      // Delete multiple patch files
      await fs.unlink(path.join(getPatchesDir(), 'patch_001.diff'));
      await fs.unlink(path.join(getPatchesDir(), 'patch_003.diff'));

      // Trigger validation
      await patchManager.onSessionChange();

      // Check that only valid patches remain
      const indexPath = path.join(getPatchesDir(), 'patch_index.json');
      const content = await fs.readFile(indexPath, 'utf-8');
      const index = JSON.parse(content);

      expect(index.patches.length).toBe(2);
      expect(index.patches.find((p: any) => p.patch_number === 1)).toBeUndefined();
      expect(index.patches.find((p: any) => p.patch_number === 2)).toBeDefined();
      expect(index.patches.find((p: any) => p.patch_number === 3)).toBeUndefined();
      expect(index.patches.find((p: any) => p.patch_number === 4)).toBeDefined();

      // Verify quarantine file
      const quarantineDir = path.join(process.cwd(), '.ally-sessions', '.quarantine');
      const quarantineFiles = await fs.readdir(quarantineDir);
      const quarantineFile = quarantineFiles.find(f => f.startsWith(`patches_${testSessionId}_`));

      expect(quarantineFile).toBeDefined();

      const quarantinePath = path.join(quarantineDir, quarantineFile!);
      const quarantineContent = await fs.readFile(quarantinePath, 'utf-8');
      const quarantineData = JSON.parse(quarantineContent);

      expect(quarantineData.patches.length).toBe(2);
    });

    it('should not fail if patches directory does not exist', async () => {
      // Create new session with no patches
      const newSessionId = `test-session-no-patches-${Date.now()}`;
      const newManager = new PatchManager({
        getSessionId: () => newSessionId,
        maxPatchesPerSession: 100,
        maxPatchesSizeBytes: 10 * 1024 * 1024
      });
      await newManager.initialize();

      // Trigger validation on empty session - should not throw
      await expect(newManager.onSessionChange()).resolves.not.toThrow();

      await newManager.cleanup();
      await fs.rm(path.join(process.cwd(), '.ally-sessions', newSessionId), { recursive: true, force: true }).catch(() => {});
    });

    it('should handle validation when no session is active', async () => {
      // Create manager with no session
      const noSessionManager = new PatchManager({
        getSessionId: () => null,
        maxPatchesPerSession: 100,
        maxPatchesSizeBytes: 10 * 1024 * 1024
      });
      await noSessionManager.initialize();

      // Trigger validation - should not throw
      await expect(noSessionManager.onSessionChange()).resolves.not.toThrow();

      await noSessionManager.cleanup();
    });

    it('should continue normal operation after validation', async () => {
      // Create patches
      await patchManager.captureOperation('edit', '/test/file1.txt', 'a', 'b');
      await patchManager.captureOperation('edit', '/test/file2.txt', 'c', 'd');

      // Delete a patch file
      await fs.unlink(path.join(getPatchesDir(), 'patch_001.diff'));

      // Trigger validation
      await patchManager.onSessionChange();

      // Should be able to create new patches after validation
      const newPatchNum = await patchManager.captureOperation('edit', '/test/file3.txt', 'e', 'f');
      expect(newPatchNum).toBeDefined();
      expect(newPatchNum).toBeGreaterThan(0);

      // Should be able to get history
      const history = patchManager.getPatchHistory();
      expect(history.length).toBeGreaterThan(0);
    });
  });
});
