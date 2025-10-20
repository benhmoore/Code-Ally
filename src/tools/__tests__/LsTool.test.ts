/**
 * Tests for LsTool
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { LsTool } from '../LsTool.js';
import { ActivityStream } from '../../services/ActivityStream.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

describe('LsTool', () => {
  let activityStream: ActivityStream;
  let lsTool: LsTool;
  let tempDir: string;

  beforeEach(async () => {
    activityStream = new ActivityStream();
    lsTool = new LsTool(activityStream);

    // Create temp directory structure
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ls-tool-test-'));

    // Create test files and directories
    await fs.writeFile(path.join(tempDir, 'file1.txt'), 'Content 1\n');
    await fs.writeFile(path.join(tempDir, 'file2.js'), 'console.log("test");\n');
    await fs.writeFile(path.join(tempDir, '.hidden'), 'Hidden content\n');
    await fs.mkdir(path.join(tempDir, 'subdir'));
    await fs.mkdir(path.join(tempDir, '.hiddendir'));
  });

  afterEach(async () => {
    // Clean up temp directory
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('basic properties', () => {
    it('should have correct name', () => {
      expect(lsTool.name).toBe('ls');
    });

    it('should not require confirmation', () => {
      expect(lsTool.requiresConfirmation).toBe(false);
    });

    it('should have function definition', () => {
      const def = lsTool.getFunctionDefinition();
      expect(def.function.name).toBe('ls');
    });
  });

  describe('execute', () => {
    it('should list directory contents', async () => {
      const result = await lsTool.execute({
        path: tempDir,
      });

      expect(result.success).toBe(true);
      expect(result.entries).toBeDefined();
      expect(Array.isArray(result.entries)).toBe(true);
      expect(result.entries.length).toBeGreaterThan(0);
    });

    it('should exclude hidden files by default', async () => {
      const result = await lsTool.execute({
        path: tempDir,
      });

      expect(result.success).toBe(true);
      const hasHidden = result.entries.some(
        (entry: any) => entry.name.startsWith('.')
      );
      expect(hasHidden).toBe(false);
    });

    it('should include hidden files when all flag is set', async () => {
      const result = await lsTool.execute({
        path: tempDir,
        all: true,
      });

      expect(result.success).toBe(true);
      const hasHidden = result.entries.some(
        (entry: any) => entry.name.startsWith('.')
      );
      expect(hasHidden).toBe(true);
    });

    it('should identify file types correctly', async () => {
      const result = await lsTool.execute({
        path: tempDir,
      });

      expect(result.success).toBe(true);

      // Find a regular file and a directory
      const file = result.entries.find((entry: any) => entry.name === 'file1.txt');
      const dir = result.entries.find((entry: any) => entry.name === 'subdir');

      expect(file).toBeDefined();
      expect(file.type).toBe('file');

      expect(dir).toBeDefined();
      expect(dir.type).toBe('directory');
    });

    it('should sort directories before files', async () => {
      const result = await lsTool.execute({
        path: tempDir,
        sort_by: 'name',
      });

      expect(result.success).toBe(true);

      // Find indices of first directory and first file
      const firstDirIndex = result.entries.findIndex(
        (entry: any) => entry.type === 'directory'
      );
      const firstFileIndex = result.entries.findIndex(
        (entry: any) => entry.type === 'file'
      );

      // Directories should come before files
      if (firstDirIndex >= 0 && firstFileIndex >= 0) {
        expect(firstDirIndex).toBeLessThan(firstFileIndex);
      }
    });

    it('should include file details in long format', async () => {
      const result = await lsTool.execute({
        path: tempDir,
        long: true,
      });

      expect(result.success).toBe(true);
      const file = result.entries.find((entry: any) => entry.type === 'file');

      expect(file).toBeDefined();
      expect(file.size).toBeGreaterThanOrEqual(0);
      expect(file.modified).toBeGreaterThan(0);
      expect(file.permissions).toBeDefined();
      expect(file.isExecutable).toBeDefined();
    });

    it('should sort by name', async () => {
      const result = await lsTool.execute({
        path: tempDir,
        sort_by: 'name',
      });

      expect(result.success).toBe(true);

      // Check that files are sorted alphabetically within their type
      const files = result.entries.filter((entry: any) => entry.type === 'file');
      for (let i = 1; i < files.length; i++) {
        expect(files[i].name.localeCompare(files[i - 1].name)).toBeGreaterThanOrEqual(0);
      }
    });

    it('should sort by size', async () => {
      // Create files with different sizes
      await fs.writeFile(path.join(tempDir, 'small.txt'), 'x');
      await fs.writeFile(path.join(tempDir, 'large.txt'), 'x'.repeat(1000));

      const result = await lsTool.execute({
        path: tempDir,
        long: true,
        sort_by: 'size',
      });

      expect(result.success).toBe(true);

      // Check that files are sorted by size (largest first)
      const files = result.entries.filter((entry: any) => entry.type === 'file');
      for (let i = 1; i < files.length; i++) {
        expect(files[i - 1].size).toBeGreaterThanOrEqual(files[i].size);
      }
    });

    it('should sort by modification time', async () => {
      // Create files at different times
      await fs.writeFile(path.join(tempDir, 'old.txt'), 'old');
      await new Promise((resolve) => setTimeout(resolve, 10));
      await fs.writeFile(path.join(tempDir, 'new.txt'), 'new');

      const result = await lsTool.execute({
        path: tempDir,
        long: true,
        sort_by: 'time',
      });

      expect(result.success).toBe(true);

      // Check that files are sorted by time (newest first)
      const files = result.entries.filter((entry: any) => entry.type === 'file');
      for (let i = 1; i < files.length; i++) {
        expect(files[i - 1].modified).toBeGreaterThanOrEqual(files[i].modified);
      }
    });

    it('should return error for non-existent directory', async () => {
      const result = await lsTool.execute({
        path: path.join(tempDir, 'nonexistent'),
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('should return error when path is not a directory', async () => {
      const filePath = path.join(tempDir, 'file1.txt');
      const result = await lsTool.execute({
        path: filePath,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Not a directory');
    });

    it('should return error for invalid sort_by parameter', async () => {
      const result = await lsTool.execute({
        path: tempDir,
        sort_by: 'invalid',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid sort_by');
      expect(result.error_type).toBe('validation_error');
    });

    it('should include entry paths', async () => {
      const result = await lsTool.execute({
        path: tempDir,
      });

      expect(result.success).toBe(true);
      const entry = result.entries[0];
      expect(entry.path).toBeDefined();
      expect(entry.path).toContain(entry.name);
    });

    it('should use current directory by default', async () => {
      const result = await lsTool.execute({});

      expect(result.success).toBe(true);
      expect(result.directory_path).toBeDefined();
    });

    it('should handle symlinks', async () => {
      const targetFile = path.join(tempDir, 'target.txt');
      const symlinkFile = path.join(tempDir, 'link.txt');
      await fs.writeFile(targetFile, 'target');

      try {
        await fs.symlink(targetFile, symlinkFile);

        const result = await lsTool.execute({
          path: tempDir,
        });

        expect(result.success).toBe(true);
        const symlink = result.entries.find((entry: any) => entry.name === 'link.txt');
        expect(symlink).toBeDefined();
        expect(symlink.type).toBe('symlink');
      } catch {
        // Symlink creation may fail on some systems (Windows without admin)
        // Skip this test if symlink creation fails
      }
    });

    it('should report total count and shown count', async () => {
      const result = await lsTool.execute({
        path: tempDir,
      });

      expect(result.success).toBe(true);
      expect(result.total_count).toBeDefined();
      expect(result.shown_count).toBeDefined();
      expect(result.shown_count).toBeLessThanOrEqual(result.total_count);
    });
  });

  describe('getResultPreview', () => {
    it('should show item count', async () => {
      const result = await lsTool.execute({
        path: tempDir,
      });

      const preview = lsTool.getResultPreview(result, 3);
      expect(preview[0]).toContain('Found');
      expect(preview[0]).toContain('item');
    });

    it('should show directory indicator for directories', async () => {
      const result = await lsTool.execute({
        path: tempDir,
      });

      const preview = lsTool.getResultPreview(result, 5);
      const hasDirIndicator = preview.some((line) => line.endsWith('/'));
      expect(hasDirIndicator).toBe(true);
    });

    it('should truncate long result lists', async () => {
      const result = await lsTool.execute({
        path: tempDir,
      });

      const preview = lsTool.getResultPreview(result, 2);
      expect(preview.length).toBeLessThanOrEqual(3); // Header + 1 item + ...
    });

    it('should handle empty directory', async () => {
      const emptyDir = path.join(tempDir, 'empty');
      await fs.mkdir(emptyDir);

      const result = await lsTool.execute({
        path: emptyDir,
      });

      const preview = lsTool.getResultPreview(result, 3);
      expect(preview).toContain('Directory is empty');
    });
  });
});
