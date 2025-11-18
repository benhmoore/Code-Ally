/**
 * Tests for PromptLibraryManager
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PromptLibraryManager, type PromptInfo } from '../PromptLibraryManager.js';

describe('PromptLibraryManager', () => {
  let manager: PromptLibraryManager;
  let testDir: string;

  beforeEach(async () => {
    // Create a unique temporary directory for each test
    testDir = join(tmpdir(), `prompt-library-test-${Date.now()}-${Math.random().toString(36).substring(7)}`);
    await fs.mkdir(testDir, { recursive: true });

    // Create manager instance with test directory
    manager = new PromptLibraryManager(testDir);
    await manager.initialize();
  });

  afterEach(async () => {
    // Cleanup
    await manager.cleanup();
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  describe('initialization', () => {
    it('should create prompts directory', async () => {
      const promptsDir = join(testDir, 'prompts');
      const stats = await fs.stat(promptsDir);
      expect(stats.isDirectory()).toBe(true);
    });
  });

  describe('addPrompt', () => {
    it('should add a prompt without tags', async () => {
      const prompt = await manager.addPrompt(
        'Test Prompt',
        'This is a test prompt content'
      );

      expect(prompt.id).toBeDefined();
      expect(prompt.title).toBe('Test Prompt');
      expect(prompt.content).toBe('This is a test prompt content');
      expect(prompt.createdAt).toBeGreaterThan(0);
      expect(prompt.tags).toBeUndefined();
    });

    it('should add a prompt with tags', async () => {
      const prompt = await manager.addPrompt(
        'Tagged Prompt',
        'Content with tags',
        ['coding', 'review']
      );

      expect(prompt.tags).toEqual(['coding', 'review']);
    });

    it('should trim whitespace from title and content', async () => {
      const prompt = await manager.addPrompt(
        '  Whitespace Test  ',
        '  Content with spaces  '
      );

      expect(prompt.title).toBe('Whitespace Test');
      expect(prompt.content).toBe('Content with spaces');
    });

    it('should filter empty tags', async () => {
      const prompt = await manager.addPrompt(
        'Test',
        'Content',
        ['valid', '  ', '', 'another']
      );

      expect(prompt.tags).toEqual(['valid', 'another']);
    });
  });

  describe('getPrompts', () => {
    it('should return empty array when no prompts exist', async () => {
      const prompts = await manager.getPrompts();
      expect(prompts).toEqual([]);
    });

    it('should return all prompts sorted by creation time (newest first)', async () => {
      // Add prompts with small delay to ensure different timestamps
      const prompt1 = await manager.addPrompt('First', 'Content 1');
      await new Promise(resolve => setTimeout(resolve, 10));
      const prompt2 = await manager.addPrompt('Second', 'Content 2');
      await new Promise(resolve => setTimeout(resolve, 10));
      const prompt3 = await manager.addPrompt('Third', 'Content 3');

      const prompts = await manager.getPrompts();

      expect(prompts).toHaveLength(3);
      expect(prompts[0].id).toBe(prompt3.id);
      expect(prompts[1].id).toBe(prompt2.id);
      expect(prompts[2].id).toBe(prompt1.id);
    });
  });

  describe('getPrompt', () => {
    it('should return undefined for non-existent prompt', async () => {
      const prompt = await manager.getPrompt('non-existent-id');
      expect(prompt).toBeUndefined();
    });

    it('should return the correct prompt by ID', async () => {
      const added = await manager.addPrompt('Test', 'Content');
      const retrieved = await manager.getPrompt(added.id);

      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe(added.id);
      expect(retrieved?.title).toBe('Test');
      expect(retrieved?.content).toBe('Content');
    });
  });

  describe('deletePrompt', () => {
    it('should throw error when deleting non-existent prompt', async () => {
      await expect(manager.deletePrompt('non-existent-id')).rejects.toThrow(
        'Prompt not found: non-existent-id'
      );
    });

    it('should delete an existing prompt', async () => {
      const prompt = await manager.addPrompt('To Delete', 'Content');

      // Verify it exists
      expect(await manager.getPrompt(prompt.id)).toBeDefined();

      // Delete it
      await manager.deletePrompt(prompt.id);

      // Verify it's gone
      expect(await manager.getPrompt(prompt.id)).toBeUndefined();
    });

    it('should not affect other prompts when deleting one', async () => {
      const prompt1 = await manager.addPrompt('Keep 1', 'Content 1');
      const prompt2 = await manager.addPrompt('Delete', 'Content 2');
      const prompt3 = await manager.addPrompt('Keep 2', 'Content 3');

      await manager.deletePrompt(prompt2.id);

      const remaining = await manager.getPrompts();
      expect(remaining).toHaveLength(2);
      expect(remaining.find(p => p.id === prompt1.id)).toBeDefined();
      expect(remaining.find(p => p.id === prompt3.id)).toBeDefined();
      expect(remaining.find(p => p.id === prompt2.id)).toBeUndefined();
    });
  });

  describe('updatePrompt', () => {
    it('should throw error when updating non-existent prompt', async () => {
      await expect(
        manager.updatePrompt('non-existent-id', { title: 'New Title' })
      ).rejects.toThrow('Prompt not found: non-existent-id');
    });

    it('should update prompt title', async () => {
      const prompt = await manager.addPrompt('Old Title', 'Content');
      const updated = await manager.updatePrompt(prompt.id, { title: 'New Title' });

      expect(updated.title).toBe('New Title');
      expect(updated.content).toBe('Content');
      expect(updated.id).toBe(prompt.id);
    });

    it('should update prompt content', async () => {
      const prompt = await manager.addPrompt('Title', 'Old Content');
      const updated = await manager.updatePrompt(prompt.id, { content: 'New Content' });

      expect(updated.title).toBe('Title');
      expect(updated.content).toBe('New Content');
    });

    it('should update prompt tags', async () => {
      const prompt = await manager.addPrompt('Title', 'Content', ['old']);
      const updated = await manager.updatePrompt(prompt.id, { tags: ['new', 'tags'] });

      expect(updated.tags).toEqual(['new', 'tags']);
    });

    it('should update multiple fields at once', async () => {
      const prompt = await manager.addPrompt('Old', 'Old Content', ['old']);
      const updated = await manager.updatePrompt(prompt.id, {
        title: 'New',
        content: 'New Content',
        tags: ['new'],
      });

      expect(updated.title).toBe('New');
      expect(updated.content).toBe('New Content');
      expect(updated.tags).toEqual(['new']);
    });
  });

  describe('searchPrompts', () => {
    beforeEach(async () => {
      await manager.addPrompt('JavaScript Tips', 'Some JS tips', ['coding', 'javascript']);
      await manager.addPrompt('Python Guide', 'Python best practices', ['coding', 'python']);
      await manager.addPrompt('Code Review', 'Review checklist', ['review', 'coding']);
    });

    it('should return all prompts for empty query', async () => {
      const results = await manager.searchPrompts('');
      expect(results).toHaveLength(3);
    });

    it('should search by title (case-insensitive)', async () => {
      const results = await manager.searchPrompts('javascript');
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('JavaScript Tips');
    });

    it('should search by partial title match', async () => {
      const results = await manager.searchPrompts('guide');
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('Python Guide');
    });

    it('should search by tag', async () => {
      const results = await manager.searchPrompts('review');
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('Code Review');
    });

    it('should return multiple matches', async () => {
      const results = await manager.searchPrompts('coding');
      expect(results).toHaveLength(3);
    });
  });

  describe('getPromptsByTag', () => {
    beforeEach(async () => {
      await manager.addPrompt('JS Prompt', 'Content', ['javascript', 'coding']);
      await manager.addPrompt('Python Prompt', 'Content', ['python', 'coding']);
      await manager.addPrompt('Review Prompt', 'Content', ['review']);
    });

    it('should return prompts with specific tag', async () => {
      const results = await manager.getPromptsByTag('coding');
      expect(results).toHaveLength(2);
    });

    it('should be case-insensitive', async () => {
      const results = await manager.getPromptsByTag('CODING');
      expect(results).toHaveLength(2);
    });

    it('should return empty array for non-existent tag', async () => {
      const results = await manager.getPromptsByTag('nonexistent');
      expect(results).toEqual([]);
    });
  });

  describe('getAllTags', () => {
    it('should return empty array when no prompts exist', async () => {
      const tags = await manager.getAllTags();
      expect(tags).toEqual([]);
    });

    it('should return unique tags sorted alphabetically', async () => {
      await manager.addPrompt('P1', 'C1', ['zebra', 'alpha']);
      await manager.addPrompt('P2', 'C2', ['beta', 'alpha']);
      await manager.addPrompt('P3', 'C3', ['gamma']);

      const tags = await manager.getAllTags();
      expect(tags).toEqual(['alpha', 'beta', 'gamma', 'zebra']);
    });

    it('should handle prompts without tags', async () => {
      await manager.addPrompt('P1', 'C1', ['tag1']);
      await manager.addPrompt('P2', 'C2'); // No tags

      const tags = await manager.getAllTags();
      expect(tags).toEqual(['tag1']);
    });
  });

  describe('sequential operations', () => {
    it('should handle multiple writes sequentially', async () => {
      // Create multiple prompts sequentially (not concurrently)
      // Note: Concurrent addPrompt calls may result in race conditions
      // because each call loads the entire library, modifies it, and saves it back.
      // For concurrent operations, use a batch API or sequential processing.
      const results: PromptInfo[] = [];
      for (let i = 0; i < 10; i++) {
        const result = await manager.addPrompt(`Prompt ${i}`, `Content ${i}`);
        results.push(result);
      }

      expect(results).toHaveLength(10);

      // Verify all prompts were saved
      const prompts = await manager.getPrompts();
      expect(prompts).toHaveLength(10);
    });
  });

  describe('data persistence', () => {
    it('should persist data across manager instances', async () => {
      // Add prompt with first manager
      const prompt = await manager.addPrompt('Persistent', 'Content', ['tag']);
      await manager.cleanup();

      // Create new manager instance with same test directory
      const newManager = new PromptLibraryManager(testDir);
      await newManager.initialize();

      // Verify prompt exists
      const retrieved = await newManager.getPrompt(prompt.id);
      expect(retrieved).toBeDefined();
      expect(retrieved?.title).toBe('Persistent');
      expect(retrieved?.content).toBe('Content');
      expect(retrieved?.tags).toEqual(['tag']);

      await newManager.cleanup();
    });
  });
});
