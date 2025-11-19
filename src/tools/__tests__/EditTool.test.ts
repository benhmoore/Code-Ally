/**
 * EditTool unit tests
 *
 * Tests find-and-replace functionality, multi-line support, and error handling
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { EditTool } from '../EditTool.js';
import { ActivityStream } from '@services/ActivityStream.js';
import { ServiceRegistry } from '@services/ServiceRegistry.js';
import { ReadStateManager } from '@services/ReadStateManager.js';

describe('EditTool', () => {
  let tempDir: string;
  let editTool: EditTool;
  let activityStream: ActivityStream;
  let readStateManager: ReadStateManager;
  let registry: ServiceRegistry;

  beforeEach(async () => {
    // Create a temporary directory for test files
    tempDir = join(tmpdir(), `code-ally-edit-test-${Date.now()}-${Math.random().toString(36).substring(7)}`);
    await fs.mkdir(tempDir, { recursive: true });

    // Initialize services
    activityStream = new ActivityStream();
    readStateManager = new ReadStateManager();
    registry = ServiceRegistry.getInstance();

    // Clear any existing services
    registry['_services'].clear();
    registry['_descriptors'].clear();

    // Register read state manager
    registry.registerInstance('read_state_manager', readStateManager);

    editTool = new EditTool(activityStream);
  });

  afterEach(async () => {
    // Cleanup
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }

    // Clear service registry
    registry['_services'].clear();
    registry['_descriptors'].clear();
  });

  describe('basic replacement', () => {
    it('should replace single occurrence of text', async () => {
      const filePath = join(tempDir, 'test.txt');
      const content = 'Hello World';
      await fs.writeFile(filePath, content);

      // Mark file as read
      readStateManager.trackRead(filePath, 1, 1);

      const result = await editTool.execute({
        file_path: filePath,
        old_string: 'World',
        new_string: 'Universe',
      });

      expect(result.success).toBe(true);
      expect(result.replacements_made).toBe(1);

      const newContent = await fs.readFile(filePath, 'utf-8');
      expect(newContent).toBe('Hello Universe');
    });

    it('should replace unique multi-line text', async () => {
      const filePath = join(tempDir, 'multiline.txt');
      const content = 'Line 1\nLine 2\nLine 3';
      await fs.writeFile(filePath, content);

      // Mark lines 2-3 as read (the multi-line match)
      readStateManager.trackRead(filePath, 2, 3);

      const result = await editTool.execute({
        file_path: filePath,
        old_string: 'Line 2\nLine 3',
        new_string: 'New Line',
      });

      expect(result.success).toBe(true);
      expect(result.replacements_made).toBe(1);

      const newContent = await fs.readFile(filePath, 'utf-8');
      expect(newContent).toBe('Line 1\nNew Line');
    });

    it('should handle exact whitespace matching', async () => {
      const filePath = join(tempDir, 'whitespace.txt');
      const content = 'function test() {\n  return true;\n}';
      await fs.writeFile(filePath, content);

      // Mark line 2 as read (contains the match)
      readStateManager.trackRead(filePath, 2, 2);

      const result = await editTool.execute({
        file_path: filePath,
        old_string: '  return true;',
        new_string: '  return false;',
      });

      expect(result.success).toBe(true);

      const newContent = await fs.readFile(filePath, 'utf-8');
      expect(newContent).toBe('function test() {\n  return false;\n}');
    });
  });

  describe('replace_all functionality', () => {
    it('should replace all occurrences when replace_all is true', async () => {
      const filePath = join(tempDir, 'multiple.txt');
      const content = 'foo bar foo baz foo';
      await fs.writeFile(filePath, content);

      // Mark line 1 as read (contains all matches)
      readStateManager.trackRead(filePath, 1, 1);

      const result = await editTool.execute({
        file_path: filePath,
        old_string: 'foo',
        new_string: 'qux',
        replace_all: true,
      });

      expect(result.success).toBe(true);
      expect(result.replacements_made).toBe(3);

      const newContent = await fs.readFile(filePath, 'utf-8');
      expect(newContent).toBe('qux bar qux baz qux');
    });

    it('should replace unique occurrence without replace_all', async () => {
      const filePath = join(tempDir, 'unique.txt');
      const content = 'foo bar baz';
      await fs.writeFile(filePath, content);

      // Mark line 1 as read
      readStateManager.trackRead(filePath, 1, 1);

      const result = await editTool.execute({
        file_path: filePath,
        old_string: 'foo',
        new_string: 'qux',
        replace_all: false,
      });

      expect(result.success).toBe(true);
      expect(result.replacements_made).toBe(1);

      const newContent = await fs.readFile(filePath, 'utf-8');
      expect(newContent).toBe('qux bar baz');
    });

    it('should fail if multiple occurrences exist without replace_all', async () => {
      const filePath = join(tempDir, 'non-unique.txt');
      const content = 'foo bar foo baz';
      await fs.writeFile(filePath, content);

      // Mark file as read
      readStateManager.trackRead(filePath, 1, 1);

      const result = await editTool.execute({
        file_path: filePath,
        old_string: 'foo',
        new_string: 'qux',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('appears 2 times');
      expect(result.error).toContain('Must be unique or use replace_all');
    });
  });

  describe('validation', () => {
    it('should require file_path parameter', async () => {
      const result = await editTool.execute({
        old_string: 'old',
        new_string: 'new',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('file_path parameter is required');
      expect(result.error_type).toBe('validation_error');
    });

    it('should require old_string parameter', async () => {
      const result = await editTool.execute({
        file_path: join(tempDir, 'test.txt'),
        new_string: 'new',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('old_string parameter is required');
    });

    it('should require new_string parameter', async () => {
      const result = await editTool.execute({
        file_path: join(tempDir, 'test.txt'),
        old_string: 'old',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('new_string parameter is required');
    });

    it('should reject same old_string and new_string', async () => {
      const result = await editTool.execute({
        file_path: join(tempDir, 'test.txt'),
        old_string: 'same',
        new_string: 'same',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('cannot be the same');
    });

    it('should fail if file does not exist', async () => {
      const result = await editTool.execute({
        file_path: join(tempDir, 'nonexistent.txt'),
        old_string: 'old',
        new_string: 'new',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('File not found');
      expect(result.error_type).toBe('user_error');
    });

    it('should fail if path is a directory', async () => {
      const dirPath = join(tempDir, 'testdir');
      await fs.mkdir(dirPath);

      const result = await editTool.execute({
        file_path: dirPath,
        old_string: 'old',
        new_string: 'new',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Not a file');
    });

    it('should fail if old_string not found', async () => {
      const filePath = join(tempDir, 'test.txt');
      await fs.writeFile(filePath, 'Hello World');

      const result = await editTool.execute({
        file_path: filePath,
        old_string: 'NotFound',
        new_string: 'New',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('old_string not found');
      expect(result.error_type).toBe('user_error');
    });
  });

  describe('similar string detection', () => {
    it('should suggest similar strings with case differences', async () => {
      const filePath = join(tempDir, 'case.txt');
      const content = 'HELLO WORLD';
      await fs.writeFile(filePath, content);

      const result = await editTool.execute({
        file_path: filePath,
        old_string: 'hello world',
        new_string: 'New',
      });

      expect(result.success).toBe(false);
      expect(result.suggestion).toContain('Similar strings found');
      expect(result.suggestion).toContain('Capitalization');
    });

    it('should find exact substring matches', async () => {
      const filePath = join(tempDir, 'partial.txt');
      const content = 'This is a longer string';
      await fs.writeFile(filePath, content);

      // Mark line 1 as read
      readStateManager.trackRead(filePath, 1, 1);

      const result = await editTool.execute({
        file_path: filePath,
        old_string: 'longer',
        new_string: 'shorter',
      });

      // "longer" should be found as exact substring, so this should succeed
      expect(result.success).toBe(true);
    });
  });

  describe('special cases', () => {
    it('should handle empty string replacement', async () => {
      const filePath = join(tempDir, 'delete.txt');
      const content = 'Remove this word from sentence';
      await fs.writeFile(filePath, content);

      // Mark line 1 as read
      readStateManager.trackRead(filePath, 1, 1);

      const result = await editTool.execute({
        file_path: filePath,
        old_string: 'this ',
        new_string: '',
      });

      expect(result.success).toBe(true);

      const newContent = await fs.readFile(filePath, 'utf-8');
      expect(newContent).toBe('Remove word from sentence');
    });

    it('should handle replacement with newlines', async () => {
      const filePath = join(tempDir, 'newline.txt');
      const content = 'Single line';
      await fs.writeFile(filePath, content);

      // Mark line 1 as read
      readStateManager.trackRead(filePath, 1, 1);

      const result = await editTool.execute({
        file_path: filePath,
        old_string: 'Single line',
        new_string: 'Multiple\nLines',
      });

      expect(result.success).toBe(true);

      const newContent = await fs.readFile(filePath, 'utf-8');
      expect(newContent).toBe('Multiple\nLines');
    });

    it('should handle special regex characters', async () => {
      const filePath = join(tempDir, 'regex.txt');
      const content = 'Price: $10.00 (special)';
      await fs.writeFile(filePath, content);

      // Mark line 1 as read
      readStateManager.trackRead(filePath, 1, 1);

      const result = await editTool.execute({
        file_path: filePath,
        old_string: '$10.00',
        new_string: '$20.00',
      });

      expect(result.success).toBe(true);

      const newContent = await fs.readFile(filePath, 'utf-8');
      expect(newContent).toBe('Price: $20.00 (special)');
    });

    it('should handle unicode characters', async () => {
      const filePath = join(tempDir, 'unicode.txt');
      const content = 'Hello 世界 🚀';
      await fs.writeFile(filePath, content);

      // Mark line 1 as read
      readStateManager.trackRead(filePath, 1, 1);

      const result = await editTool.execute({
        file_path: filePath,
        old_string: '世界',
        new_string: 'World',
      });

      expect(result.success).toBe(true);

      const newContent = await fs.readFile(filePath, 'utf-8');
      expect(newContent).toBe('Hello World 🚀');
    });
  });

  describe('show_updated_context parameter', () => {
    it('should not include updated_content by default', async () => {
      const filePath = join(tempDir, 'test.txt');
      const content = 'Hello World';
      await fs.writeFile(filePath, content);

      // Mark line 1 as read
      readStateManager.trackRead(filePath, 1, 1);

      const result = await editTool.execute({
        file_path: filePath,
        old_string: 'World',
        new_string: 'Universe',
      });

      expect(result.success).toBe(true);
      expect(result.updated_content).toBeUndefined();
    });

    it('should include updated_content when show_updated_context is true', async () => {
      const filePath = join(tempDir, 'test.txt');
      const content = 'Hello World';
      await fs.writeFile(filePath, content);

      // Mark line 1 as read
      readStateManager.trackRead(filePath, 1, 1);

      const result = await editTool.execute({
        file_path: filePath,
        old_string: 'World',
        new_string: 'Universe',
        show_updated_context: true,
      });

      expect(result.success).toBe(true);
      expect(result.updated_content).toBe('Hello Universe');
    });

    it('should not include updated_content when show_updated_context is false', async () => {
      const filePath = join(tempDir, 'test.txt');
      const content = 'Hello World';
      await fs.writeFile(filePath, content);

      // Mark line 1 as read
      readStateManager.trackRead(filePath, 1, 1);

      const result = await editTool.execute({
        file_path: filePath,
        old_string: 'World',
        new_string: 'Universe',
        show_updated_context: false,
      });

      expect(result.success).toBe(true);
      expect(result.updated_content).toBeUndefined();
    });

    it('should include updated_content with replace_all', async () => {
      const filePath = join(tempDir, 'multiple.txt');
      const content = 'foo bar foo baz foo';
      await fs.writeFile(filePath, content);

      // Mark line 1 as read
      readStateManager.trackRead(filePath, 1, 1);

      const result = await editTool.execute({
        file_path: filePath,
        old_string: 'foo',
        new_string: 'qux',
        replace_all: true,
        show_updated_context: true,
      });

      expect(result.success).toBe(true);
      expect(result.updated_content).toBe('qux bar qux baz qux');
    });
  });

  describe('tool metadata', () => {
    it('should have correct tool name', () => {
      expect(editTool.name).toBe('edit');
    });

    it('should require confirmation', () => {
      expect(editTool.requiresConfirmation).toBe(true);
    });

    it('should have proper function definition', () => {
      const def = editTool.getFunctionDefinition();

      expect(def.type).toBe('function');
      expect(def.function.name).toBe('edit');
      expect(def.function.parameters.required).toContain('file_path');
      expect(def.function.parameters.required).toContain('old_string');
      expect(def.function.parameters.required).toContain('new_string');
      expect(def.function.parameters.properties.replace_all).toBeDefined();
      expect(def.function.parameters.properties.show_updated_context).toBeDefined();
    });

    it('should provide custom result preview', () => {
      const result = {
        success: true,
        error: '',
        file_path: '/test/file.txt',
        replacements_made: 3,
      };

      const preview = editTool.getResultPreview(result, 3);

      expect(preview.length).toBeGreaterThan(0);
      expect(preview[0]).toContain('3 replacement');
      expect(preview[0]).toContain('/test/file.txt');
    });

    it('should handle singular replacement in preview', () => {
      const result = {
        success: true,
        error: '',
        file_path: '/test/file.txt',
        replacements_made: 1,
      };

      const preview = editTool.getResultPreview(result, 3);

      expect(preview.length).toBeGreaterThan(0);
      expect(preview[0]).toContain('1 replacement');
    });
  });

  describe('surgical validation - read state checking', () => {
    it('should validate only lines containing matches (not whole file)', async () => {
      const filePath = join(tempDir, 'test.txt');
      const content = 'Line 1\nLine 2\nLine 3\nTarget line\nLine 5';
      await fs.writeFile(filePath, content);

      // Mark only line 4 (containing "Target line") as read
      readStateManager.trackRead(filePath, 4, 4);

      const result = await editTool.execute({
        file_path: filePath,
        old_string: 'Target line',
        new_string: 'Modified line',
      });

      expect(result.success).toBe(true);
      expect(result.replacements_made).toBe(1);
    });

    it('should allow edit if match lines were read (even if whole file was not)', async () => {
      const filePath = join(tempDir, 'test.txt');
      const content = 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6\nLine 7\nLine 8\nLine 9\nLine 10';
      await fs.writeFile(filePath, content);

      // Read only lines 3-5 (not the entire file)
      readStateManager.trackRead(filePath, 3, 5);

      // Edit should succeed because line 4 (containing the match) was read
      const result = await editTool.execute({
        file_path: filePath,
        old_string: 'Line 4',
        new_string: 'Modified 4',
      });

      expect(result.success).toBe(true);
      expect(result.replacements_made).toBe(1);
    });

    it('should reject edit if any match line was not read', async () => {
      const filePath = join(tempDir, 'test.txt');
      const content = 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5';
      await fs.writeFile(filePath, content);

      // Read lines 1-2 but not line 3
      readStateManager.trackRead(filePath, 1, 2);

      const result = await editTool.execute({
        file_path: filePath,
        old_string: 'Line 3',
        new_string: 'Modified 3',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not all occurrences have been read');
      expect(result.suggestion).toContain('line 3');
    });

    it('should handle multi-line matches correctly', async () => {
      const filePath = join(tempDir, 'multiline.txt');
      const content = 'Line 1\nLine 2\nLine 3\nfunction foo() {\n  return true;\n}\nLine 7';
      await fs.writeFile(filePath, content);

      // Mark lines 4-6 (the multi-line match) as read
      readStateManager.trackRead(filePath, 4, 6);

      const result = await editTool.execute({
        file_path: filePath,
        old_string: 'function foo() {\n  return true;\n}',
        new_string: 'function bar() {\n  return false;\n}',
      });

      expect(result.success).toBe(true);
      expect(result.replacements_made).toBe(1);
    });

    it('should error with specific line numbers when validation fails', async () => {
      const filePath = join(tempDir, 'test.txt');
      const content = 'Line 1\nTarget\nLine 3\nTarget\nLine 5';
      await fs.writeFile(filePath, content);

      // Read only line 2 (first occurrence)
      readStateManager.trackRead(filePath, 2, 2);

      const result = await editTool.execute({
        file_path: filePath,
        old_string: 'Target',
        new_string: 'Modified',
        replace_all: true,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not all occurrences have been read');
      expect(result.suggestion).toContain('line 4');
    });

    it('should validate all match locations for replace_all', async () => {
      const filePath = join(tempDir, 'test.txt');
      const content = 'foo bar\nfoo baz\nfoo qux';
      await fs.writeFile(filePath, content);

      // Read all three lines
      readStateManager.trackRead(filePath, 1, 3);

      const result = await editTool.execute({
        file_path: filePath,
        old_string: 'foo',
        new_string: 'bar',
        replace_all: true,
      });

      expect(result.success).toBe(true);
      expect(result.replacements_made).toBe(3);
    });

    it('should fail if only some match locations were read (replace_all)', async () => {
      const filePath = join(tempDir, 'test.txt');
      const content = 'foo bar\nfoo baz\nfoo qux';
      await fs.writeFile(filePath, content);

      // Read only lines 1-2 (missing line 3)
      readStateManager.trackRead(filePath, 1, 2);

      const result = await editTool.execute({
        file_path: filePath,
        old_string: 'foo',
        new_string: 'bar',
        replace_all: true,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not all occurrences have been read');
      expect(result.suggestion).toContain('line 3');
    });

    it('should succeed when file has not been read and old_string not found', async () => {
      const filePath = join(tempDir, 'test.txt');
      const content = 'Line 1\nLine 2\nLine 3';
      await fs.writeFile(filePath, content);

      // No read state

      const result = await editTool.execute({
        file_path: filePath,
        old_string: 'NotFound',
        new_string: 'Modified',
      });

      // Should fail with "old_string not found" error, not read validation error
      expect(result.success).toBe(false);
      expect(result.error).toContain('old_string not found');
    });
  });

  describe('surgical invalidation - read state preservation', () => {
    it('should preserve read state for unaffected lines (replace_all=false)', async () => {
      const filePath = join(tempDir, 'test.txt');
      const content = 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5';
      await fs.writeFile(filePath, content);

      // Read entire file
      readStateManager.trackRead(filePath, 1, 5);

      // Edit line 3 without changing line count
      await editTool.execute({
        file_path: filePath,
        old_string: 'Line 3',
        new_string: 'Modified 3',
      });

      // Lines 1-2 should still be valid (before edit)
      const validation1 = readStateManager.validateLinesRead(filePath, 1, 2);
      expect(validation1.success).toBe(true);

      // Lines 4-5 should still be valid (after edit, no line count change)
      const validation2 = readStateManager.validateLinesRead(filePath, 4, 5);
      expect(validation2.success).toBe(true);
    });

    it('should invalidate only affected lines when line count changes (replace_all=false)', async () => {
      const filePath = join(tempDir, 'test.txt');
      const content = 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5';
      await fs.writeFile(filePath, content);

      // Read entire file
      readStateManager.trackRead(filePath, 1, 5);

      // Replace "Line 3" with multi-line content (adds lines)
      await editTool.execute({
        file_path: filePath,
        old_string: 'Line 3',
        new_string: 'Modified 3\nExtra line',
      });

      // Lines 1-2 should still be valid (before edit)
      const validation1 = readStateManager.validateLinesRead(filePath, 1, 2);
      expect(validation1.success).toBe(true);

      // Lines 3+ should be invalidated (line count changed)
      const validation2 = readStateManager.validateLinesRead(filePath, 3, 6);
      expect(validation2.success).toBe(false);
    });

    it('should invalidate all match locations when replace_all=true and line count changes', async () => {
      const filePath = join(tempDir, 'test.txt');
      const content = 'Line 1\nfoo\nLine 3\nfoo\nLine 5';
      await fs.writeFile(filePath, content);

      // Read entire file
      readStateManager.trackRead(filePath, 1, 5);

      // Replace all "foo" with multi-line content
      await editTool.execute({
        file_path: filePath,
        old_string: 'foo',
        new_string: 'bar\nbaz',
        replace_all: true,
      });

      // Line 1 should still be valid (before first edit)
      const validation1 = readStateManager.validateLinesRead(filePath, 1, 1);
      expect(validation1.success).toBe(true);

      // Line 2+ should be invalidated (first replacement affected line numbering)
      const validation2 = readStateManager.validateLinesRead(filePath, 2, 7);
      expect(validation2.success).toBe(false);
    });

    it('should skip invalidation when line count does not change', async () => {
      const filePath = join(tempDir, 'test.txt');
      const content = 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5';
      await fs.writeFile(filePath, content);

      // Read entire file
      readStateManager.trackRead(filePath, 1, 5);

      // Replace without changing line count
      await editTool.execute({
        file_path: filePath,
        old_string: 'Line 3',
        new_string: 'Modified',
      });

      // All lines should still be valid
      const validation = readStateManager.validateLinesRead(filePath, 1, 5);
      expect(validation.success).toBe(true);
    });

    it('should process matches in correct order for single replacement (first match)', async () => {
      const filePath = join(tempDir, 'test.txt');
      const content = 'foo\nLine 2\nfoo\nLine 4';
      await fs.writeFile(filePath, content);

      // Read entire file
      readStateManager.trackRead(filePath, 1, 4);

      // Replace first occurrence only (without replace_all)
      await editTool.execute({
        file_path: filePath,
        old_string: 'foo',
        new_string: 'bar\nbaz',
      });

      // Invalidation should happen from line 1 (first match)
      // Line 1+ should be invalidated
      const validation = readStateManager.validateLinesRead(filePath, 1, 5);
      expect(validation.success).toBe(false);
    });

    it('should process matches in reverse order for replace_all (to handle line shifts)', async () => {
      const filePath = join(tempDir, 'test.txt');
      const content = 'Line 1\nfoo\nLine 3\nfoo\nLine 5';
      await fs.writeFile(filePath, content);

      // Read entire file
      readStateManager.trackRead(filePath, 1, 5);

      // Replace all occurrences (should process in reverse)
      await editTool.execute({
        file_path: filePath,
        old_string: 'foo',
        new_string: 'bar\nbaz',
        replace_all: true,
      });

      // Line 1 should still be valid (before first edit)
      const validation1 = readStateManager.validateLinesRead(filePath, 1, 1);
      expect(validation1.success).toBe(true);

      // Lines after first replacement should be invalidated
      const validation2 = readStateManager.validateLinesRead(filePath, 2, 7);
      expect(validation2.success).toBe(false);
    });

    it('should handle line removal correctly', async () => {
      const filePath = join(tempDir, 'test.txt');
      const content = 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5';
      await fs.writeFile(filePath, content);

      // Read entire file
      readStateManager.trackRead(filePath, 1, 5);

      // Remove line 3 (replace with empty string that merges lines)
      await editTool.execute({
        file_path: filePath,
        old_string: 'Line 3\n',
        new_string: '',
      });

      // Lines 1-2 should still be valid
      const validation1 = readStateManager.validateLinesRead(filePath, 1, 2);
      expect(validation1.success).toBe(true);

      // Lines 3+ should be invalidated (line count changed)
      const validation2 = readStateManager.validateLinesRead(filePath, 3, 4);
      expect(validation2.success).toBe(false);
    });
  });

  describe('surgical validation and invalidation - integration tests', () => {
    it('should handle complete flow: read specific lines → edit → verify preservation', async () => {
      const filePath = join(tempDir, 'test.txt');
      const content = 'Line 1\nLine 2\nLine 3\nTarget\nLine 5\nLine 6\nLine 7';
      await fs.writeFile(filePath, content);

      // Simulate reading only lines 3-5
      readStateManager.trackRead(filePath, 3, 5);

      // Edit line 4 without changing line count
      const result = await editTool.execute({
        file_path: filePath,
        old_string: 'Target',
        new_string: 'Modified',
      });

      expect(result.success).toBe(true);

      // Lines 3-5 should still be valid (no line count change)
      const validation = readStateManager.validateLinesRead(filePath, 3, 5);
      expect(validation.success).toBe(true);
    });

    it('should handle multiple matches with partial reads correctly', async () => {
      const filePath = join(tempDir, 'test.txt');
      const content = 'Target\nLine 2\nTarget\nLine 4\nTarget';
      await fs.writeFile(filePath, content);

      // Read only lines 1 and 3 (missing line 5)
      readStateManager.trackRead(filePath, 1, 1);
      readStateManager.trackRead(filePath, 3, 3);

      const result = await editTool.execute({
        file_path: filePath,
        old_string: 'Target',
        new_string: 'Modified',
        replace_all: true,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not all occurrences have been read');
      expect(result.suggestion).toContain('line 5');
    });

    it('should handle replacement with line count change and surgical invalidation', async () => {
      const filePath = join(tempDir, 'test.txt');
      const content = 'Line 1\nLine 2\nShort\nLine 4\nLine 5';
      await fs.writeFile(filePath, content);

      // Read entire file
      readStateManager.trackRead(filePath, 1, 5);

      // Replace with multi-line content
      const result = await editTool.execute({
        file_path: filePath,
        old_string: 'Short',
        new_string: 'Much\nLonger\nReplacement',
      });

      expect(result.success).toBe(true);

      // Lines 1-2 should still be valid (before edit)
      const validation1 = readStateManager.validateLinesRead(filePath, 1, 2);
      expect(validation1.success).toBe(true);

      // Lines from edit point onward should be invalidated
      const validation2 = readStateManager.validateLinesRead(filePath, 3, 7);
      expect(validation2.success).toBe(false);
    });

    it('should validate multi-line match spanning multiple lines', async () => {
      const filePath = join(tempDir, 'test.txt');
      const content = 'Line 1\nLine 2\nStart\nMiddle\nEnd\nLine 6';
      await fs.writeFile(filePath, content);

      // Read lines 3-5 (the multi-line match)
      readStateManager.trackRead(filePath, 3, 5);

      const result = await editTool.execute({
        file_path: filePath,
        old_string: 'Start\nMiddle\nEnd',
        new_string: 'Replaced',
      });

      expect(result.success).toBe(true);
      expect(result.replacements_made).toBe(1);
    });

    it('should fail if only part of multi-line match was read', async () => {
      const filePath = join(tempDir, 'test.txt');
      const content = 'Line 1\nLine 2\nStart\nMiddle\nEnd\nLine 6';
      await fs.writeFile(filePath, content);

      // Read only lines 3-4 (missing line 5 which is part of the match)
      readStateManager.trackRead(filePath, 3, 4);

      const result = await editTool.execute({
        file_path: filePath,
        old_string: 'Start\nMiddle\nEnd',
        new_string: 'Replaced',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not all occurrences have been read');
      expect(result.suggestion).toContain('lines 3-5');
    });

    it('should handle overlapping read ranges correctly', async () => {
      const filePath = join(tempDir, 'test.txt');
      const content = 'Line 1\nLine 2\nTarget\nLine 4\nLine 5';
      await fs.writeFile(filePath, content);

      // Read overlapping ranges that cover line 3
      readStateManager.trackRead(filePath, 1, 3);
      readStateManager.trackRead(filePath, 3, 5);

      const result = await editTool.execute({
        file_path: filePath,
        old_string: 'Target',
        new_string: 'Modified',
      });

      expect(result.success).toBe(true);
      expect(result.replacements_made).toBe(1);
    });

    it('should preserve read state for lines far from edit location', async () => {
      const filePath = join(tempDir, 'test.txt');
      const lines = [];
      for (let i = 1; i <= 100; i++) {
        lines.push(`Line ${i}`);
      }
      const content = lines.join('\n');
      await fs.writeFile(filePath, content);

      // Read lines 1-20 and 80-100
      readStateManager.trackRead(filePath, 1, 20);
      readStateManager.trackRead(filePath, 80, 100);

      // Edit line 50 without changing line count
      await editTool.execute({
        file_path: filePath,
        old_string: 'Line 50',
        new_string: 'Modified 50',
      });

      // Lines 1-20 should still be valid
      const validation1 = readStateManager.validateLinesRead(filePath, 1, 20);
      expect(validation1.success).toBe(true);

      // Lines 80-100 should still be valid (no line count change)
      const validation2 = readStateManager.validateLinesRead(filePath, 80, 100);
      expect(validation2.success).toBe(true);
    });
  });

  describe('Enhanced error and success messages', () => {
    it('should show invalidation guidance when edit fails after previous edit', async () => {
      const registry = ServiceRegistry.getInstance();
      const readStateManager = new ReadStateManager();
      registry.registerInstance('read_state_manager', readStateManager);

      const filePath = join(tempDir, 'invalidation-test.txt');
      const content = 'line1\nfoo\nline3\nbar\nline5';
      await fs.writeFile(filePath, content);

      // Track that we've read entire file
      readStateManager.trackRead(filePath, 1, 5);

      // First edit: replace foo with multi-line (changes line count)
      const result1 = await editTool.execute({
        file_path: filePath,
        old_string: 'foo',
        new_string: 'foo\nnewline',
      });

      expect(result1.success).toBe(true);
      expect(result1.content).toContain('invalidated');

      // Second edit: try to edit bar (now on different line, invalidated)
      const result2 = await editTool.execute({
        file_path: filePath,
        old_string: 'bar',
        new_string: 'modified',
      });

      expect(result2.success).toBe(false);
      expect(result2.error_type).toBe('validation_error');
      expect(result2.suggestion).toContain('invalidated by a previous edit');
      expect(result2.suggestion).toContain('Re-read the file');
      expect(result2.suggestion).toContain('show_updated_context=true');

      // Cleanup
      (registry as any)._services?.clear();
    });

    it('should show basic read guidance when file has never been read', async () => {
      const registry = ServiceRegistry.getInstance();
      const readStateManager = new ReadStateManager();
      registry.registerInstance('read_state_manager', readStateManager);

      const filePath = join(tempDir, 'never-read.txt');
      const content = 'line1\nfoo\nline3';
      await fs.writeFile(filePath, content);

      // Don't track any read

      // Try to edit
      const result = await editTool.execute({
        file_path: filePath,
        old_string: 'foo',
        new_string: 'bar',
      });

      expect(result.success).toBe(false);
      expect(result.error_type).toBe('validation_error');
      expect(result.suggestion).not.toContain('invalidated');
      expect(result.suggestion).toContain('Use the Read tool');

      // Cleanup
      (registry as any)._services?.clear();
    });

    it('should show proactive warning when line count changes', async () => {
      const registry = ServiceRegistry.getInstance();
      const readStateManager = new ReadStateManager();
      registry.registerInstance('read_state_manager', readStateManager);

      const filePath = join(tempDir, 'proactive-warning.txt');
      const content = 'line1\nfoo\nline3';
      await fs.writeFile(filePath, content);

      // Track read
      readStateManager.trackRead(filePath, 1, 3);

      const result = await editTool.execute({
        file_path: filePath,
        old_string: 'foo',
        new_string: 'foo\nnewline',
      });

      expect(result.success).toBe(true);
      expect(result.content).toContain('⚠️');
      expect(result.content).toContain('invalidated');
      expect(result.content).toContain('show_updated_context=true');

      // Cleanup
      (registry as any)._services?.clear();
    });

    it('should NOT show proactive warning when line count does not change', async () => {
      const registry = ServiceRegistry.getInstance();
      const readStateManager = new ReadStateManager();
      registry.registerInstance('read_state_manager', readStateManager);

      const filePath = join(tempDir, 'no-warning.txt');
      const content = 'line1\nfoo\nline3';
      await fs.writeFile(filePath, content);

      // Track read
      readStateManager.trackRead(filePath, 1, 3);

      const result = await editTool.execute({
        file_path: filePath,
        old_string: 'foo',
        new_string: 'bar',
      });

      expect(result.success).toBe(true);
      expect(result.content).not.toContain('⚠️');
      expect(result.content).not.toContain('invalidated');

      // Cleanup
      (registry as any)._services?.clear();
    });

    it('should NOT show proactive warning when show_updated_context=true', async () => {
      const registry = ServiceRegistry.getInstance();
      const readStateManager = new ReadStateManager();
      registry.registerInstance('read_state_manager', readStateManager);

      const filePath = join(tempDir, 'with-context.txt');
      const content = 'line1\nfoo\nline3';
      await fs.writeFile(filePath, content);

      // Track read
      readStateManager.trackRead(filePath, 1, 3);

      const result = await editTool.execute({
        file_path: filePath,
        old_string: 'foo',
        new_string: 'foo\nnewline',
        show_updated_context: true,
      });

      expect(result.success).toBe(true);
      expect(result.updated_content).toBeDefined();
      expect(result.content).not.toContain('⚠️'); // No warning when context shown

      // Cleanup
      (registry as any)._services?.clear();
    });
  });
});
