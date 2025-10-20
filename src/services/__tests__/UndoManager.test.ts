/**
 * UndoManager tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { UndoManager } from '../UndoManager.js';
import { promises as fs } from 'fs';
import { join } from 'path';
import { homedir, tmpdir } from 'os';
import { randomUUID } from 'crypto';

describe('UndoManager', () => {
  let undoManager: UndoManager;
  let testDir: string;
  let testBackupDir: string;

  beforeEach(async () => {
    // Create temporary test directory
    testDir = join(tmpdir(), `undo-test-${randomUUID()}`);
    await fs.mkdir(testDir, { recursive: true });

    testBackupDir = join(homedir(), '.code_ally', `undo_test_${randomUUID()}`);

    undoManager = new UndoManager();
    // Override backup directory for testing
    (undoManager as any).backupDir = testBackupDir;
    await undoManager.initialize();
  });

  afterEach(async () => {
    await undoManager.cleanup();

    // Clean up test directories
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {}
    try {
      await fs.rm(testBackupDir, { recursive: true, force: true });
    } catch {}
  });

  describe('recordOperation', () => {
    it('should record a write operation', async () => {
      await undoManager.recordOperation('write', '/test.ts', 'original content');

      const history = undoManager.getHistory();

      expect(history).toHaveLength(1);
      expect(history[0].operation).toBe('write');
      expect(history[0].filePath).toBe('/test.ts');
    });

    it('should store small content inline', async () => {
      await undoManager.recordOperation('write', '/test.ts', 'small content');

      const history = undoManager.getHistory();

      expect(history[0].originalContent).toBe('small content');
      expect(history[0].backup).toBeUndefined();
    });

    it('should backup large content to file', async () => {
      const largeContent = 'x'.repeat(20000);
      await undoManager.recordOperation('write', '/test.ts', largeContent);

      const history = undoManager.getHistory();

      expect(history[0].backup).toBeDefined();
      expect(history[0].originalContent).toBeUndefined();
    });

    it('should maintain history limit', async () => {
      // Record more than max history size (10)
      for (let i = 0; i < 15; i++) {
        await undoManager.recordOperation('write', `/test${i}.ts`, `content ${i}`);
      }

      const history = undoManager.getHistory();

      expect(history).toHaveLength(10);
    });
  });

  describe('undo', () => {
    it('should undo a write operation', async () => {
      const testFile = join(testDir, 'test.ts');

      // Create initial file
      await fs.writeFile(testFile, 'original', 'utf-8');

      // Record operation
      await undoManager.recordOperation('write', testFile, 'original');

      // Modify file
      await fs.writeFile(testFile, 'modified', 'utf-8');

      // Undo
      const result = await undoManager.undo();

      expect(result.success).toBe(true);

      // Check file was restored
      const content = await fs.readFile(testFile, 'utf-8');
      expect(content).toBe('original');
    });

    it('should undo a create operation', async () => {
      const testFile = join(testDir, 'created.ts');

      // Create file
      await fs.writeFile(testFile, 'new content', 'utf-8');

      // Record creation
      await undoManager.recordOperation('create', testFile);

      // Undo
      const result = await undoManager.undo();

      expect(result.success).toBe(true);

      // File should be deleted
      await expect(fs.access(testFile)).rejects.toThrow();
    });

    it('should undo multiple operations', async () => {
      const testFile1 = join(testDir, 'test1.ts');
      const testFile2 = join(testDir, 'test2.ts');

      await fs.writeFile(testFile1, 'original1', 'utf-8');
      await fs.writeFile(testFile2, 'original2', 'utf-8');

      await undoManager.recordOperation('write', testFile1, 'original1');
      await undoManager.recordOperation('write', testFile2, 'original2');

      await fs.writeFile(testFile1, 'modified1', 'utf-8');
      await fs.writeFile(testFile2, 'modified2', 'utf-8');

      const result = await undoManager.undo(2);

      expect(result.success).toBe(true);
      expect(result.filesAffected).toHaveLength(2);

      const content1 = await fs.readFile(testFile1, 'utf-8');
      const content2 = await fs.readFile(testFile2, 'utf-8');

      expect(content1).toBe('original1');
      expect(content2).toBe('original2');
    });

    it('should return error if no operations to undo', async () => {
      const result = await undoManager.undo();

      expect(result.success).toBe(false);
      expect(result.message).toContain('No operations');
    });

    it('should handle invalid count', async () => {
      const result = await undoManager.undo(0);

      expect(result.success).toBe(false);
      expect(result.message).toContain('Invalid count');
    });
  });

  describe('getHistory', () => {
    it('should return history in reverse order (most recent first)', async () => {
      await undoManager.recordOperation('write', '/first.ts', 'content1');
      await undoManager.recordOperation('write', '/second.ts', 'content2');

      const history = undoManager.getHistory();

      expect(history[0].filePath).toBe('/second.ts');
      expect(history[1].filePath).toBe('/first.ts');
    });

    it('should limit history when requested', async () => {
      await undoManager.recordOperation('write', '/first.ts', 'content1');
      await undoManager.recordOperation('write', '/second.ts', 'content2');
      await undoManager.recordOperation('write', '/third.ts', 'content3');

      const history = undoManager.getHistory(2);

      expect(history).toHaveLength(2);
    });
  });

  describe('clearHistory', () => {
    it('should clear all history', async () => {
      await undoManager.recordOperation('write', '/test.ts', 'content');

      await undoManager.clearHistory();

      const history = undoManager.getHistory();

      expect(history).toHaveLength(0);
    });

    it('should clean up backup files', async () => {
      const largeContent = 'x'.repeat(20000);
      await undoManager.recordOperation('write', '/test.ts', largeContent);

      const history = undoManager.getHistory();
      const backupFile = history[0].backup;

      expect(backupFile).toBeDefined();

      // Verify backup file exists
      await fs.access(backupFile!);

      await undoManager.clearHistory();

      // Backup file should be deleted
      await expect(fs.access(backupFile!)).rejects.toThrow();
    });
  });

  describe('getFormattedHistory', () => {
    it('should format history for display', async () => {
      await undoManager.recordOperation('write', '/test.ts', 'content');

      const formatted = undoManager.getFormattedHistory();

      expect(formatted).toContain('Undo History');
      expect(formatted).toContain('write');
      expect(formatted).toContain('/test.ts');
    });

    it('should show message if no history', () => {
      const formatted = undoManager.getFormattedHistory();

      expect(formatted).toContain('No undo history');
    });
  });
});
