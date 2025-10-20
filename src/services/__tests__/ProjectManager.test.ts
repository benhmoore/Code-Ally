/**
 * ProjectManager tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ProjectManager } from '../ProjectManager.js';
import { promises as fs } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

describe('ProjectManager', () => {
  let projectManager: ProjectManager;
  const testStoragePath = join(homedir(), '.code_ally', 'project.test.json');

  beforeEach(async () => {
    projectManager = new ProjectManager();
    // Override storage path for testing
    (projectManager as any).storagePath = testStoragePath;
    await projectManager.initialize();
  });

  afterEach(async () => {
    await projectManager.cleanup();
    try {
      await fs.unlink(testStoragePath);
    } catch {
      // Ignore if file doesn't exist
    }
  });

  describe('initProject', () => {
    it('should initialize a new project', async () => {
      await projectManager.initProject('Test Project', 'A test project');

      const context = await projectManager.getContext();

      expect(context).not.toBeNull();
      expect(context!.name).toBe('Test Project');
      expect(context!.description).toBe('A test project');
      expect(context!.files).toEqual([]);
      expect(context!.created).toBeInstanceOf(Date);
      expect(context!.updated).toBeInstanceOf(Date);
    });
  });

  describe('addFile', () => {
    beforeEach(async () => {
      await projectManager.initProject('Test', 'Test project');
    });

    it('should add a file to the project', async () => {
      await projectManager.addFile('/path/to/file.ts');

      const context = await projectManager.getContext();

      expect(context!.files).toContain('/path/to/file.ts');
    });

    it('should not add duplicate files', async () => {
      await projectManager.addFile('/path/to/file.ts');
      await projectManager.addFile('/path/to/file.ts');

      const context = await projectManager.getContext();

      expect(context!.files).toHaveLength(1);
    });

    it('should throw if no project initialized', async () => {
      await projectManager.clearContext();

      await expect(projectManager.addFile('/path/to/file.ts')).rejects.toThrow(
        'No project context initialized'
      );
    });
  });

  describe('removeFile', () => {
    beforeEach(async () => {
      await projectManager.initProject('Test', 'Test project');
      await projectManager.addFile('/path/to/file.ts');
    });

    it('should remove a file from the project', async () => {
      await projectManager.removeFile('/path/to/file.ts');

      const context = await projectManager.getContext();

      expect(context!.files).not.toContain('/path/to/file.ts');
    });

    it('should do nothing if file not in project', async () => {
      await projectManager.removeFile('/nonexistent.ts');

      const context = await projectManager.getContext();

      expect(context!.files).toHaveLength(1);
    });
  });

  describe('getContext', () => {
    it('should return null if no project initialized', async () => {
      const context = await projectManager.getContext();

      expect(context).toBeNull();
    });

    it('should return project context', async () => {
      await projectManager.initProject('Test', 'Test project');

      const context = await projectManager.getContext();

      expect(context).not.toBeNull();
      expect(context!.name).toBe('Test');
    });
  });

  describe('clearContext', () => {
    beforeEach(async () => {
      await projectManager.initProject('Test', 'Test project');
    });

    it('should clear the project context', async () => {
      await projectManager.clearContext();

      const context = await projectManager.getContext();

      expect(context).toBeNull();
    });
  });

  describe('metadata', () => {
    beforeEach(async () => {
      await projectManager.initProject('Test', 'Test project');
    });

    it('should set metadata', async () => {
      await projectManager.setMetadata('key', 'value');

      const value = projectManager.getMetadata('key');

      expect(value).toBe('value');
    });

    it('should return undefined for non-existent key', () => {
      const value = projectManager.getMetadata('nonexistent');

      expect(value).toBeUndefined();
    });

    it('should throw if no project initialized', async () => {
      await projectManager.clearContext();

      await expect(projectManager.setMetadata('key', 'value')).rejects.toThrow(
        'No project context initialized'
      );
    });
  });

  describe('persistence', () => {
    it('should persist project context to disk', async () => {
      await projectManager.initProject('Persistent Project', 'Test persistence');
      await projectManager.addFile('/test.ts');
      await projectManager.save();

      // Create new instance
      const newManager = new ProjectManager();
      (newManager as any).storagePath = testStoragePath;
      await newManager.load();

      const context = await newManager.getContext();

      expect(context).not.toBeNull();
      expect(context!.name).toBe('Persistent Project');
      expect(context!.files).toContain('/test.ts');
    });
  });

  describe('getContextForSystemPrompt', () => {
    it('should format context for system prompt', async () => {
      await projectManager.initProject('My Project', 'A great project');
      await projectManager.addFile('/file1.ts');
      await projectManager.addFile('/file2.ts');

      const formatted = await projectManager.getContextForSystemPrompt();

      expect(formatted).toContain('Project Context');
      expect(formatted).toContain('My Project');
      expect(formatted).toContain('A great project');
      expect(formatted).toContain('file1.ts');
    });

    it('should return empty string if no context', async () => {
      const formatted = await projectManager.getContextForSystemPrompt();

      expect(formatted).toBe('');
    });

    it('should limit files shown to 10', async () => {
      await projectManager.initProject('Test', 'Test');

      for (let i = 0; i < 15; i++) {
        await projectManager.addFile(`/file${i}.ts`);
      }

      const formatted = await projectManager.getContextForSystemPrompt();

      expect(formatted).toContain('and 5 more');
    });
  });
});
