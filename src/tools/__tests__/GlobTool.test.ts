/**
 * Tests for GlobTool
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { GlobTool } from '../GlobTool.js';
import { ActivityStream } from '@services/ActivityStream.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

describe('GlobTool', () => {
  let activityStream: ActivityStream;
  let globTool: GlobTool;
  let tempDir: string;
  let subDir1: string;
  let subDir2: string;

  beforeEach(async () => {
    activityStream = new ActivityStream();
    globTool = new GlobTool(activityStream);

    // Create temp directory structure
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'glob-tool-test-'));
    subDir1 = path.join(tempDir, 'src');
    subDir2 = path.join(tempDir, 'tests');
    await fs.mkdir(subDir1);
    await fs.mkdir(subDir2);

    // Create test files with various extensions
    await fs.writeFile(path.join(tempDir, 'index.ts'), 'export default {};\n');
    await fs.writeFile(path.join(tempDir, 'config.json'), '{}\n');
    await fs.writeFile(path.join(subDir1, 'app.ts'), 'const app = {};\n');
    await fs.writeFile(path.join(subDir1, 'utils.js'), 'module.exports = {};\n');
    await fs.writeFile(path.join(subDir2, 'app.test.ts'), 'describe("test");\n');
    await fs.writeFile(path.join(subDir2, 'utils.test.js'), 'test("utils");\n');
  });

  afterEach(async () => {
    // Clean up temp directory
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('basic properties', () => {
    it('should have correct name', () => {
      expect(globTool.name).toBe('glob');
    });

    it('should not require confirmation', () => {
      expect(globTool.requiresConfirmation).toBe(false);
    });

    it('should have function definition', () => {
      const def = globTool.getFunctionDefinition();
      expect(def.function.name).toBe('glob');
      expect(def.function.parameters.required).toContain('pattern');
    });
  });

  describe('execute', () => {
    it('should find TypeScript files', async () => {
      const result = await globTool.execute({
        pattern: '*.ts',
        path: tempDir,
      });

      expect(result.success).toBe(true);
      expect(result.files).toBeDefined();
      expect(Array.isArray(result.files)).toBe(true);
      expect(result.files.length).toBeGreaterThan(0);
      expect(result.files.some((f: string) => f.endsWith('.ts'))).toBe(true);
    });

    it('should find files recursively', async () => {
      const result = await globTool.execute({
        pattern: '**/*.ts',
        path: tempDir,
      });

      expect(result.success).toBe(true);
      expect(result.total_matches).toBeGreaterThan(1);
      expect(result.files.some((f: string) => f.includes('src'))).toBe(true);
    });

    it('should find test files', async () => {
      const result = await globTool.execute({
        pattern: '**/*.test.*',
        path: tempDir,
      });

      expect(result.success).toBe(true);
      expect(result.total_matches).toBe(2);
      expect(result.files.every((f: string) => f.includes('.test.'))).toBe(true);
    });

    it('should match multiple extensions', async () => {
      const result = await globTool.execute({
        pattern: '**/*.{ts,js}',
        path: tempDir,
      });

      expect(result.success).toBe(true);
      expect(result.total_matches).toBeGreaterThan(2);
      expect(
        result.files.every((f: string) => f.endsWith('.ts') || f.endsWith('.js'))
      ).toBe(true);
    });

    it('should respect max_results parameter', async () => {
      const result = await globTool.execute({
        pattern: '**/*',
        path: tempDir,
        max_results: 2,
      });

      expect(result.success).toBe(true);
      expect(result.files.length).toBeLessThanOrEqual(2);
      expect(result.limited_results).toBe(true);
    });

    it('should respect exclude patterns', async () => {
      await fs.mkdir(path.join(tempDir, 'node_modules'));
      await fs.writeFile(path.join(tempDir, 'node_modules', 'lib.js'), 'module.exports = {};\n');

      const result = await globTool.execute({
        pattern: '**/*.js',
        path: tempDir,
        exclude: ['**/node_modules/**'],
      });

      expect(result.success).toBe(true);
      expect(result.files.every((f: string) => !f.includes('node_modules'))).toBe(true);
    });

    it('should return error when pattern is missing', async () => {
      const result = await globTool.execute({
        path: tempDir,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('pattern');
      expect(result.error_type).toBe('validation_error');
    });

    it('should return error for non-existent path', async () => {
      const result = await globTool.execute({
        pattern: '*.ts',
        path: path.join(tempDir, 'nonexistent'),
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('should return error for path traversal attempts', async () => {
      const result = await globTool.execute({
        pattern: '../*.ts',
        path: tempDir,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('path traversal');
      expect(result.error_type).toBe('security_error');
    });

    it('should return error when path is not a directory', async () => {
      const filePath = path.join(tempDir, 'index.ts');
      const result = await globTool.execute({
        pattern: '*.ts',
        path: filePath,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Not a directory');
    });

    it('should sort files by modification time', async () => {
      // Create files with different modification times
      const oldFile = path.join(tempDir, 'old.ts');
      const newFile = path.join(tempDir, 'new.ts');

      await fs.writeFile(oldFile, 'old');
      await new Promise((resolve) => setTimeout(resolve, 10));
      await fs.writeFile(newFile, 'new');

      const result = await globTool.execute({
        pattern: '*.ts',
        path: tempDir,
      });

      expect(result.success).toBe(true);
      expect(result.file_details).toBeDefined();

      // First file should be newest
      const firstFile = result.file_details[0];
      const lastFile = result.file_details[result.file_details.length - 1];
      expect(firstFile.modified).toBeGreaterThanOrEqual(lastFile.modified);
    });

    it('should include file details', async () => {
      const result = await globTool.execute({
        pattern: '*.ts',
        path: tempDir,
      });

      expect(result.success).toBe(true);
      expect(result.file_details).toBeDefined();
      expect(result.file_details.length).toBeGreaterThan(0);

      const detail = result.file_details[0];
      expect(detail.path).toBeDefined();
      expect(detail.relativePath).toBeDefined();
      expect(detail.size).toBeGreaterThanOrEqual(0);
      expect(detail.modified).toBeGreaterThan(0);
    });

    it('should handle empty results', async () => {
      const result = await globTool.execute({
        pattern: '*.nonexistent',
        path: tempDir,
      });

      expect(result.success).toBe(true);
      expect(result.files).toEqual([]);
      expect(result.total_matches).toBe(0);
    });
  });

  describe('getResultPreview', () => {
    it('should show file count', async () => {
      const result = await globTool.execute({
        pattern: '**/*.ts',
        path: tempDir,
      });

      const preview = globTool.getResultPreview(result, 3);
      expect(preview[0]).toContain('Found');
      expect(preview[0]).toContain('file');
    });

    it('should show file paths', async () => {
      const result = await globTool.execute({
        pattern: '*.ts',
        path: tempDir,
      });

      const preview = globTool.getResultPreview(result, 5);
      expect(preview.length).toBeGreaterThan(1);
      const hasFilePath = preview.some((line) => line.endsWith('.ts'));
      expect(hasFilePath).toBe(true);
    });

    it('should truncate long result lists', async () => {
      const result = await globTool.execute({
        pattern: '**/*',
        path: tempDir,
      });

      const preview = globTool.getResultPreview(result, 2);
      expect(preview.length).toBeLessThanOrEqual(3); // Header + 1 file + ...
    });

    it('should handle empty results', async () => {
      const result = await globTool.execute({
        pattern: '*.nonexistent',
        path: tempDir,
      });

      const preview = globTool.getResultPreview(result, 3);
      expect(preview).toContain('No files found');
    });
  });
});
