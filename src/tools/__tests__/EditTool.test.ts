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

  // Helper function: EditTool requires full file to be read
  const trackFullFile = async (filePath: string) => {
    const content = await fs.readFile(filePath, 'utf-8');
    const lines = content.split('\n').length;
    readStateManager.trackRead(filePath, 1, lines);
  };

  describe('basic replacement', () => {
    it('should replace single occurrence of text', async () => {
      const filePath = join(tempDir, 'test.txt');
      const content = 'Hello World';
      await fs.writeFile(filePath, content);

      // EditTool requires full file to be read
      await trackFullFile(filePath);

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

      // EditTool requires full file to be read
      await trackFullFile(filePath);

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

      // EditTool requires full file to be read
      await trackFullFile(filePath);

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

      // EditTool requires full file to be read
      await trackFullFile(filePath);

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

      // EditTool requires full file to be read
      await trackFullFile(filePath);

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

      // EditTool requires full file to be read
      await trackFullFile(filePath);

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

      // EditTool requires full file to be read
      await trackFullFile(filePath);

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

      // EditTool requires full file to be read
      await trackFullFile(filePath);

      const result = await editTool.execute({
        file_path: filePath,
        old_string: 'hello world',
        new_string: 'New',
      });

      expect(result.success).toBe(false);
      expect(result.suggestion).toBeDefined();
      expect(result.suggestion).toContain('Similar strings found');
      expect(result.suggestion).toContain('Capitalization');
    });

    it('should find exact substring matches', async () => {
      const filePath = join(tempDir, 'partial.txt');
      const content = 'This is a longer string';
      await fs.writeFile(filePath, content);

      // EditTool requires full file to be read
      await trackFullFile(filePath);

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

      // EditTool requires full file to be read
      await trackFullFile(filePath);

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

      // EditTool requires full file to be read
      await trackFullFile(filePath);

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

      // EditTool requires full file to be read
      await trackFullFile(filePath);

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

      // EditTool requires full file to be read
      await trackFullFile(filePath);

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

      // EditTool requires full file to be read
      await trackFullFile(filePath);

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

      // EditTool requires full file to be read
      await trackFullFile(filePath);

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

      // EditTool requires full file to be read
      await trackFullFile(filePath);

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

      // EditTool requires full file to be read
      await trackFullFile(filePath);

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

  describe('Enhanced error and success messages', () => {
    it('should fail when edit is attempted after previous edit cleared read state', async () => {
      const registry = ServiceRegistry.getInstance();
      const readStateManager = new ReadStateManager();
      registry.registerInstance('read_state_manager', readStateManager);

      const filePath = join(tempDir, 'invalidation-test.txt');
      const content = 'line1\nfoo\nline3\nbar\nline5';
      await fs.writeFile(filePath, content);

      // Track that we've read entire file
      readStateManager.trackRead(filePath, 1, 5);

      // First edit: replace foo (clears all read state)
      const result1 = await editTool.execute({
        file_path: filePath,
        old_string: 'foo',
        new_string: 'modified_foo',
      });

      expect(result1.success).toBe(true);

      // Second edit: try to edit bar (should fail because read state was cleared)
      const result2 = await editTool.execute({
        file_path: filePath,
        old_string: 'bar',
        new_string: 'modified',
      });

      expect(result2.success).toBe(false);
      expect(result2.error_type).toBe('validation_error');
      expect(result2.error).toContain('Lines not read');
      if (result2.suggestion) {
        expect(result2.suggestion).toContain('Use the Read tool');
      }

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
      if (result.suggestion) {
        expect(result.suggestion).not.toContain('invalidated');
        expect(result.suggestion).toContain('Use the Read tool');
      }

      // Cleanup
      (registry as any)._services?.clear();
    });

    it('should clear all read state after successful edit', async () => {
      const registry = ServiceRegistry.getInstance();
      const readStateManager = new ReadStateManager();
      registry.registerInstance('read_state_manager', readStateManager);

      const filePath = join(tempDir, 'clear-state.txt');
      const content = 'line1\nfoo\nline3';
      await fs.writeFile(filePath, content);

      // Track read
      readStateManager.trackRead(filePath, 1, 3);

      // Verify read state exists before edit
      const validationBefore = readStateManager.validateLinesRead(filePath, 1, 3);
      expect(validationBefore.success).toBe(true);

      // Execute edit
      const result = await editTool.execute({
        file_path: filePath,
        old_string: 'foo',
        new_string: 'bar',
      });

      expect(result.success).toBe(true);

      // Verify read state was cleared after edit
      const validationAfter = readStateManager.validateLinesRead(filePath, 1, 3);
      expect(validationAfter.success).toBe(false);

      // Cleanup
      (registry as any)._services?.clear();
    });
  });
});
