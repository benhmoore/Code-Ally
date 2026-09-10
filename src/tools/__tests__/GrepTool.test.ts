/**
 * Tests for GrepTool
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { GrepTool } from '../GrepTool.js';
import { ActivityStream } from '@services/ActivityStream.js';
import { resolveDisplayContent, toModelToolResult } from '../../utils/toolResultContent.js';
import { ServiceRegistry } from '../../services/ServiceRegistry.js';
import { ReadStateManager } from '../../services/ReadStateManager.js';
import { tokenCounter } from '../../services/TokenCounter.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

describe('GrepTool', () => {
  let activityStream: ActivityStream;
  let grepTool: GrepTool;
  let tempDir: string;
  let testFile1: string;
  let testFile2: string;
  let subDir: string;

  beforeEach(async () => {
    activityStream = new ActivityStream();
    grepTool = new GrepTool(activityStream);

    // Create temp directory structure
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'grep-tool-test-'));
    subDir = path.join(tempDir, 'subdir');
    await fs.mkdir(subDir);

    // Create test files
    testFile1 = path.join(tempDir, 'test1.ts');
    await fs.writeFile(
      testFile1,
      'class TestClass {\n  constructor() {}\n  testMethod() {}\n}\n'
    );

    testFile2 = path.join(subDir, 'test2.js');
    await fs.writeFile(testFile2, 'function testFunc() {\n  return "test";\n}\n');

    const readmeFile = path.join(tempDir, 'README.md');
    await fs.writeFile(readmeFile, '# Test Project\nThis is a test.\n');
  });

  afterEach(async () => {
    // Clean up temp directory
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('basic properties', () => {
    it('should have correct name', () => {
      expect(grepTool.name).toBe('grep');
    });

    it('should not require confirmation', () => {
      expect(grepTool.requiresConfirmation({})).toBe(false);
    });

    it('should have function definition', () => {
      const def = grepTool.getFunctionDefinition();
      expect(def.function.name).toBe('grep');
      expect(def.function.parameters.required).toContain('pattern');
      expect(def.function.parameters.properties).toHaveProperty('case_insensitive');
      expect(def.function.parameters.properties).toHaveProperty('after_context');
      expect(def.function.parameters.properties).not.toHaveProperty('-i');
    });
  });

  describe('execute', () => {
    it.each(['content', 'count', 'files_with_matches'])(
      'admits complete %s records within the assigned allowance', async output_mode => {
        const registry = ServiceRegistry.getInstance();
        const reads = new ReadStateManager();
        const previous = registry.get('read_state_manager');
        registry.registerInstance('read_state_manager', reads);
        try {
          await fs.writeFile(testFile1, Array.from({ length: 80 }, (_, i) => `match ${i} ${'value '.repeat(10)}`).join('\n'));
          const result = await grepTool.execute(
            { pattern: 'match', path: testFile1, output_mode, after_context: 1 }, 'bounded-search', undefined, false, false,
            { outputBudget: { limitTokens: 350, maxResultTokensByCallId: new Map([['bounded-search', 350]]) } },
          );
          expect(result.success).toBe(true);
          expect(result._non_truncatable).toBe(true);
          expect(tokenCounter.count(JSON.stringify(toModelToolResult(result)))).toBeLessThanOrEqual(350);
          if (output_mode === 'content') {
            expect(result.limited_results).toBe(true);
            expect(result.matches.length).toBeGreaterThan(0);
            expect(result.matches.length).toBeLessThan(80);
            for (let line = 1; line <= 80; line++) {
              expect(reads.validateLinesRead(testFile1, line, line).success)
                .toBe(result.matches.some((match: { line: number; after?: string[] }) =>
                  line >= match.line && line <= match.line + (match.after?.length ?? 0)));
            }
          } else {
            expect(reads.validateLinesRead(testFile1, 1, 1).success).toBe(false);
          }
        } finally {
          if (previous) registry.registerInstance('read_state_manager', previous);
          else registry['_services'].delete('read_state_manager');
        }
      },
    );

    it('does not authorize a line that cannot fit in the output allowance', async () => {
      const registry = ServiceRegistry.getInstance();
      const reads = new ReadStateManager();
      const previous = registry.get('read_state_manager');
      registry.registerInstance('read_state_manager', reads);
      try {
        await fs.writeFile(testFile1, `match ${'oversized '.repeat(1000)}`);
        const result = await grepTool.execute(
          { pattern: 'match', path: testFile1, output_mode: 'content' }, 'small-search', undefined, false, false,
          { outputBudget: { limitTokens: 100, maxResultTokensByCallId: new Map([['small-search', 100]]) } },
        );
        expect(result.success).toBe(false);
        expect(reads.validateLinesRead(testFile1, 1, 1).success).toBe(false);
      } finally {
        if (previous) registry.registerInstance('read_state_manager', previous);
        else registry['_services'].delete('read_state_manager');
      }
    });

    it.each(['content', 'count', 'files_with_matches'])('separates readable display from structured %s output', async output_mode => {
      const result = await grepTool.execute({ pattern: 'test', path: tempDir, output_mode });
      expect(result.success).toBe(true);
      expect(resolveDisplayContent(result).length).toBeGreaterThan(0);
      const wire = toModelToolResult(result);
      expect(wire.display_content).toBeUndefined();
      expect(wire.content ?? '').toBe('');
      const field = output_mode === 'content' ? 'matches' : output_mode === 'count' ? 'file_counts' : 'files';
      expect(wire[field].length).toBeGreaterThan(0);
      expect(JSON.stringify(wire).length).toBeLessThan(JSON.stringify(result).length);
    });

    it('should find matches in files', async () => {
      const result = await grepTool.execute({
        pattern: 'test',
        path: tempDir,
        output_mode: 'content',
      });

      expect(result.success).toBe(true);
      expect(result.total_matches).toBeGreaterThan(0);
      expect(result.matches).toBeDefined();
      expect(Array.isArray(result.matches)).toBe(true);
    });

    it('should match class keyword', async () => {
      const result = await grepTool.execute({
        pattern: 'class',
        path: tempDir,
        output_mode: 'content',
      });

      expect(result.success).toBe(true);
      expect(result.total_matches).toBeGreaterThan(0);
      const match = result.matches[0];
      expect(match.content).toContain('class');
    });

    it('should perform case-insensitive search', async () => {
      const result = await grepTool.execute({
        pattern: 'TEST',
        path: tempDir,
        case_insensitive: true,
        output_mode: 'content',
      });

      expect(result.success).toBe(true);
      expect(result.total_matches).toBeGreaterThan(0);
    });

    it('should respect file_pattern filter', async () => {
      const result = await grepTool.execute({
        pattern: 'test',
        path: tempDir,
        file_pattern: '*.ts',
      });

      expect(result.success).toBe(true);
      if (result.matches && result.matches.length > 0) {
        const match = result.matches[0];
        expect(match.file).toMatch(/\.ts$/);
      }
    });

    it('should include context lines when requested', async () => {
      const result = await grepTool.execute({
        pattern: 'constructor',
        path: tempDir,
        context_lines: 1,
      });

      expect(result.success).toBe(true);
      if (result.matches && result.matches.length > 0) {
        const match = result.matches[0];
        expect(match.before || match.after).toBeDefined();
      }
    });

    it('should respect max_results parameter', async () => {
      const result = await grepTool.execute({
        pattern: 'test',
        path: tempDir,
        max_results: 2,
        output_mode: 'content',
      });

      expect(result.success).toBe(true);
      expect(result.matches.length).toBeLessThanOrEqual(2);
    });

    it('should search recursively in subdirectories', async () => {
      const result = await grepTool.execute({
        pattern: 'testFunc',
        path: tempDir,
        output_mode: 'content',
      });

      expect(result.success).toBe(true);
      expect(result.total_matches).toBeGreaterThan(0);
      const match = result.matches.find((m: any) => m.content.includes('testFunc'));
      expect(match).toBeDefined();
      expect(match.file).toContain('subdir');
    });

    it('should handle regex patterns', async () => {
      const result = await grepTool.execute({
        pattern: 'test.*\\(',
        path: tempDir,
        output_mode: 'content',
      });

      expect(result.success).toBe(true);
      expect(result.total_matches).toBeGreaterThan(0);
    });

    it('should return error for invalid regex', async () => {
      const result = await grepTool.execute({
        pattern: '[invalid',
        path: tempDir,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid regex');
      expect(result.error_type).toBe('validation_error');
    });

    it('should return error when pattern is missing', async () => {
      const result = await grepTool.execute({
        path: tempDir,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('pattern');
      expect(result.error_type).toBe('validation_error');
    });

    it('should return error for non-existent path', async () => {
      const result = await grepTool.execute({
        pattern: 'test',
        path: path.join(tempDir, 'nonexistent'),
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('should skip binary files', async () => {
      const binaryFile = path.join(tempDir, 'binary.bin');
      await fs.writeFile(binaryFile, Buffer.from([0x00, 0x01, 0x02, 0xff]));

      const result = await grepTool.execute({
        pattern: 'test',
        path: tempDir,
        output_mode: 'content',
      });

      // Should succeed but not match the binary file
      expect(result.success).toBe(true);
      const binaryMatch = result.matches.find((m: any) => m.file === binaryFile);
      expect(binaryMatch).toBeUndefined();
    });

    it('should include line numbers in matches', async () => {
      const result = await grepTool.execute({
        pattern: 'constructor',
        path: tempDir,
        output_mode: 'content',
      });

      expect(result.success).toBe(true);
      if (result.matches && result.matches.length > 0) {
        const match = result.matches[0];
        expect(match.line).toBeGreaterThan(0);
      }
    });
  });

  describe('getResultPreview', () => {
    it('should show match count', async () => {
      const result = await grepTool.execute({
        pattern: 'test',
        path: tempDir,
      });

      const preview = grepTool.getResultPreview(result, 3);
      expect(preview[0]).toContain('Found');
      expect(preview[0]).toContain('match');
    });

    it('should show file paths and line numbers', async () => {
      const result = await grepTool.execute({
        pattern: 'class',
        path: tempDir,
        output_mode: 'content',
      });

      const preview = grepTool.getResultPreview(result, 5);
      const hasLineNumbers = preview.some((line) => line.includes(':'));
      expect(hasLineNumbers).toBe(true);
    });

    it('should truncate long result lists', async () => {
      const result = await grepTool.execute({
        pattern: 'test',
        path: tempDir,
      });

      const preview = grepTool.getResultPreview(result, 2);
      expect(preview.length).toBeLessThanOrEqual(3); // Header + 1 match + ...
    });
  });
});
