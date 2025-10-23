/**
 * Comprehensive tests for LintTool and FormatTool
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { LintTool } from '../LintTool.js';
import { FormatTool } from '../FormatTool.js';
import { ActivityStream } from '../../services/ActivityStream.js';

describe('LintTool', () => {
  let lintTool: LintTool;
  let activityStream: ActivityStream;
  let tmpDir: string;

  beforeEach(async () => {
    activityStream = new ActivityStream();
    lintTool = new LintTool(activityStream);
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lint-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('basic properties', () => {
    it('should have correct name', () => {
      expect(lintTool.name).toBe('lint');
    });

    it('should not require confirmation', () => {
      expect(lintTool.requiresConfirmation).toBe(false);
    });

    it('should have function definition', () => {
      const def = lintTool.getFunctionDefinition();
      expect(def.function.name).toBe('lint');
      expect(def.function.parameters.properties).toHaveProperty('file_paths');
      expect(def.function.parameters.required).toContain('file_paths');
    });
  });

  describe('execute', () => {
    it('should require file_paths parameter', async () => {
      const result = await lintTool.execute({});

      expect(result.success).toBe(false);
      expect(result.error).toContain('file_paths');
    });

    it('should reject empty file_paths array', async () => {
      const result = await lintTool.execute({ file_paths: [] });

      expect(result.success).toBe(false);
      expect(result.error).toContain('at least one');
    });

    it('should lint valid JSON file', async () => {
      const jsonPath = path.join(tmpDir, 'test.json');
      await fs.writeFile(jsonPath, '{"name": "test", "version": "1.0.0"}', 'utf-8');

      const result = await lintTool.execute({ file_paths: [jsonPath] });

      expect(result.success).toBe(true);
      expect(result.files_checked).toBe(1);
      expect(result.total_errors).toBe(0);
      expect(result.files).toHaveLength(1);
      expect(result.files[0].checker_available).toBe(true);
      expect(result.files[0].checker).toBe('json');
      expect(result.files[0].passed).toBe(true);
    });

    it('should detect JSON syntax errors', async () => {
      const jsonPath = path.join(tmpDir, 'invalid.json');
      await fs.writeFile(jsonPath, '{"name": "test",}', 'utf-8');

      const result = await lintTool.execute({ file_paths: [jsonPath] });

      expect(result.success).toBe(true);
      expect(result.files_checked).toBe(1);
      expect(result.files[0].checker_available).toBe(true);
      expect(result.files[0].passed).toBe(false);
      expect(result.files[0].errors!.length).toBeGreaterThan(0);
      expect(result.total_errors).toBeGreaterThan(0);
    });

    it('should lint multiple files', async () => {
      const json1Path = path.join(tmpDir, 'file1.json');
      const json2Path = path.join(tmpDir, 'file2.json');

      await fs.writeFile(json1Path, '{"valid": true}', 'utf-8');
      await fs.writeFile(json2Path, '{"also": "valid"}', 'utf-8');

      const result = await lintTool.execute({ file_paths: [json1Path, json2Path] });

      expect(result.success).toBe(true);
      expect(result.files_checked).toBe(2);
      expect(result.files).toHaveLength(2);
      expect(result.total_errors).toBe(0);
    });

    it('should handle files with no available checker', async () => {
      const txtPath = path.join(tmpDir, 'test.txt');
      await fs.writeFile(txtPath, 'plain text file', 'utf-8');

      const result = await lintTool.execute({ file_paths: [txtPath] });

      expect(result.success).toBe(true);
      expect(result.files_checked).toBe(0);
      expect(result.files[0].checker_available).toBe(false);
      expect(result.files[0].message).toContain('No linter available');
    });

    it('should handle non-existent files', async () => {
      const result = await lintTool.execute({
        file_paths: ['/nonexistent/file.json'],
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid file path');
    });

    it('should include error details', async () => {
      const jsonPath = path.join(tmpDir, 'error.json');
      await fs.writeFile(jsonPath, '{invalid}', 'utf-8');

      const result = await lintTool.execute({ file_paths: [jsonPath] });

      expect(result.success).toBe(true);
      expect(result.files[0].errors!.length).toBeGreaterThan(0);

      const error = result.files[0].errors![0];
      expect(error.line).toBeGreaterThan(0);
      expect(error.message).toBeTruthy();
      expect(error.severity).toBe('error');
    });
  });

  describe('getResultPreview', () => {
    it('should show summary for successful checks', () => {
      const result = {
        success: true,
        error: '',
        files_checked: 3,
        total_errors: 0,
        total_warnings: 0,
      };

      const preview = lintTool.getResultPreview(result);

      expect(preview).toContain('Checked 3 files');
      expect(preview).toContain('All files passed');
    });

    it('should show error count', () => {
      const result = {
        success: true,
        error: '',
        files_checked: 2,
        total_errors: 5,
        total_warnings: 0,
      };

      const preview = lintTool.getResultPreview(result);

      expect(preview).toContain('5 errors found');
    });
  });
});

describe('FormatTool', () => {
  let formatTool: FormatTool;
  let activityStream: ActivityStream;
  let tmpDir: string;

  beforeEach(async () => {
    activityStream = new ActivityStream();
    formatTool = new FormatTool(activityStream);
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'format-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('basic properties', () => {
    it('should have correct name', () => {
      expect(formatTool.name).toBe('format');
    });

    it('should require confirmation', () => {
      expect(formatTool.requiresConfirmation).toBe(true);
    });

    it('should have function definition', () => {
      const def = formatTool.getFunctionDefinition();
      expect(def.function.name).toBe('format');
      expect(def.function.parameters.properties).toHaveProperty('file_paths');
      expect(def.function.parameters.required).toContain('file_paths');
    });
  });

  describe('execute', () => {
    it('should require file_paths parameter', async () => {
      const result = await formatTool.execute({});

      expect(result.success).toBe(false);
      expect(result.error).toContain('file_paths');
    });

    it('should format JSON file', async () => {
      const jsonPath = path.join(tmpDir, 'test.json');
      const uglyJson = '{"name":"test","version":"1.0.0","scripts":{"start":"node index.js"}}';
      await fs.writeFile(jsonPath, uglyJson, 'utf-8');

      const result = await formatTool.execute({ file_paths: [jsonPath] });

      expect(result.success).toBe(true);
      expect(result.files_formatted).toBe(1);
      expect(result.total_changes).toBe(1);

      const formatted = await fs.readFile(jsonPath, 'utf-8');
      expect(formatted).toContain('\n');
      expect(formatted).toContain('  ');
      expect(JSON.parse(formatted)).toEqual(JSON.parse(uglyJson));
    });

    it('should not modify already formatted files', async () => {
      const jsonPath = path.join(tmpDir, 'formatted.json');
      const prettyJson = '{\n  "name": "test",\n  "version": "1.0.0"\n}\n';
      await fs.writeFile(jsonPath, prettyJson, 'utf-8');

      const result = await formatTool.execute({ file_paths: [jsonPath] });

      expect(result.success).toBe(true);
      expect(result.total_changes).toBe(0);
      expect(result.files[0].changes_made).toBe(false);
    });

    it('should format multiple files', async () => {
      const json1Path = path.join(tmpDir, 'file1.json');
      const json2Path = path.join(tmpDir, 'file2.json');

      await fs.writeFile(json1Path, '{"a":1}', 'utf-8');
      await fs.writeFile(json2Path, '{"b":2}', 'utf-8');

      const result = await formatTool.execute({ file_paths: [json1Path, json2Path] });

      expect(result.success).toBe(true);
      expect(result.files_formatted).toBe(2);
      expect(result.files).toHaveLength(2);
    });

    it('should include formatters_applied in result', async () => {
      const jsonPath = path.join(tmpDir, 'test.json');
      await fs.writeFile(jsonPath, '{"test":true}', 'utf-8');

      const result = await formatTool.execute({ file_paths: [jsonPath] });

      expect(result.success).toBe(true);
      expect(result.files[0].formatters_applied).toContain('json');
    });

    it('should handle files with no available formatter', async () => {
      const txtPath = path.join(tmpDir, 'test.txt');
      await fs.writeFile(txtPath, 'plain text', 'utf-8');

      const result = await formatTool.execute({ file_paths: [txtPath] });

      expect(result.success).toBe(true);
      expect(result.files[0].error).toContain('No formatters available');
    });

    it('should validate files after formatting', async () => {
      const jsonPath = path.join(tmpDir, 'test.json');
      await fs.writeFile(jsonPath, '{"test":true}', 'utf-8');

      const result = await formatTool.execute({ file_paths: [jsonPath] });

      expect(result.success).toBe(true);

      // If changes were made, file_check should be present
      if (result.files[0].changes_made) {
        expect(result.files[0].file_check).toBeDefined();
        expect(result.files[0].file_check?.checker).toBe('json');
        expect(result.files[0].file_check?.passed).toBe(true);
      }
    });

    it('should handle YAML formatting', async () => {
      const yamlPath = path.join(tmpDir, 'test.yaml');
      const uglyYaml = 'name: test\nversion: 1.0.0\nscripts: {start: "node index.js"}';
      await fs.writeFile(yamlPath, uglyYaml, 'utf-8');

      const result = await formatTool.execute({ file_paths: [yamlPath] });

      expect(result.success).toBe(true);
      // Result depends on yaml library availability
      expect(result.files).toHaveLength(1);
    });
  });

  describe('getResultPreview', () => {
    it('should show summary for successful formatting', () => {
      const result = {
        success: true,
        error: '',
        files_formatted: 3,
        total_changes: 2,
      };

      const preview = formatTool.getResultPreview(result);

      expect(preview).toContain('Formatted 3 files');
      expect(preview).toContain('2 files with changes');
    });

    it('should handle no changes', () => {
      const result = {
        success: true,
        error: '',
        files_formatted: 0,
        total_changes: 0,
      };

      const preview = formatTool.getResultPreview(result);

      expect(preview).toContain('All files already formatted correctly');
    });
  });

  describe('previewChanges', () => {
    it('should not throw errors', async () => {
      const jsonPath = path.join(tmpDir, 'test.json');
      await fs.writeFile(jsonPath, '{"test":true}', 'utf-8');

      await expect(
        formatTool.previewChanges({ file_paths: [jsonPath] }, 'test-call-id')
      ).resolves.not.toThrow();
    });
  });
});

describe('Integration', () => {
  let lintTool: LintTool;
  let formatTool: FormatTool;
  let activityStream: ActivityStream;
  let tmpDir: string;

  beforeEach(async () => {
    activityStream = new ActivityStream();
    lintTool = new LintTool(activityStream);
    formatTool = new FormatTool(activityStream);
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'integration-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('should format and then lint successfully', async () => {
    const jsonPath = path.join(tmpDir, 'test.json');
    await fs.writeFile(jsonPath, '{"name":"test","version":"1.0.0"}', 'utf-8');

    // Format
    const formatResult = await formatTool.execute({ file_paths: [jsonPath] });
    expect(formatResult.success).toBe(true);

    // Lint
    const lintResult = await lintTool.execute({ file_paths: [jsonPath] });
    expect(lintResult.success).toBe(true);
    expect(lintResult.files[0].passed).toBe(true);
    expect(lintResult.total_errors).toBe(0);
  });

  it('should detect errors after failed formatting', async () => {
    const jsonPath = path.join(tmpDir, 'broken.json');
    await fs.writeFile(jsonPath, '{broken}', 'utf-8');

    // Try to format (will fail)
    const formatResult = await formatTool.execute({ file_paths: [jsonPath] });
    expect(formatResult.success).toBe(true);
    expect(formatResult.files[0].error).toBeTruthy();

    // Lint should detect the errors
    const lintResult = await lintTool.execute({ file_paths: [jsonPath] });
    expect(lintResult.success).toBe(true);
    expect(lintResult.files[0].passed).toBe(false);
    expect(lintResult.total_errors).toBeGreaterThan(0);
  });
});
