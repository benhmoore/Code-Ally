/**
 * MemoryManager tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MemoryManager } from '../MemoryManager.js';
import { promises as fs } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

describe('MemoryManager', () => {
  let memoryManager: MemoryManager;
  const testStoragePath = join(homedir(), '.code_ally', 'memory.test.json');

  beforeEach(async () => {
    memoryManager = new MemoryManager();
    // Override storage path for testing
    (memoryManager as any).storagePath = testStoragePath;
    await memoryManager.initialize();
  });

  afterEach(async () => {
    await memoryManager.cleanup();
    try {
      await fs.unlink(testStoragePath);
    } catch {
      // Ignore if file doesn't exist
    }
  });

  describe('addMemory', () => {
    it('should add a memory', async () => {
      const memory = await memoryManager.addMemory('Test memory fact');

      expect(memory.id).toBeDefined();
      expect(memory.content).toBe('Test memory fact');
      expect(memory.created).toBeInstanceOf(Date);
    });

    it('should add a memory with tags', async () => {
      const memory = await memoryManager.addMemory('Test fact', ['tag1', 'tag2']);

      expect(memory.tags).toEqual(['tag1', 'tag2']);
    });

    it('should trim content', async () => {
      const memory = await memoryManager.addMemory('  Test  ');

      expect(memory.content).toBe('Test');
    });
  });

  describe('listMemories', () => {
    it('should list all memories', async () => {
      await memoryManager.addMemory('First');
      await memoryManager.addMemory('Second');

      const memories = await memoryManager.listMemories();

      expect(memories).toHaveLength(2);
    });

    it('should sort by creation date (newest first)', async () => {
      const first = await memoryManager.addMemory('First');
      await new Promise(resolve => setTimeout(resolve, 10));
      const second = await memoryManager.addMemory('Second');

      const memories = await memoryManager.listMemories();

      expect(memories[0].id).toBe(second.id);
      expect(memories[1].id).toBe(first.id);
    });

    it('should return empty array if no memories', async () => {
      const memories = await memoryManager.listMemories();

      expect(memories).toEqual([]);
    });
  });

  describe('getMemory', () => {
    it('should get memory by ID', async () => {
      const added = await memoryManager.addMemory('Test');
      const retrieved = await memoryManager.getMemory(added.id);

      expect(retrieved).toEqual(added);
    });

    it('should return null for non-existent ID', async () => {
      const retrieved = await memoryManager.getMemory('non-existent');

      expect(retrieved).toBeNull();
    });
  });

  describe('removeMemory', () => {
    it('should remove memory by ID', async () => {
      const memory = await memoryManager.addMemory('Test');
      const removed = await memoryManager.removeMemory(memory.id);

      expect(removed).toBe(true);

      const retrieved = await memoryManager.getMemory(memory.id);
      expect(retrieved).toBeNull();
    });

    it('should return false for non-existent ID', async () => {
      const removed = await memoryManager.removeMemory('non-existent');

      expect(removed).toBe(false);
    });
  });

  describe('clearMemories', () => {
    it('should clear all memories', async () => {
      await memoryManager.addMemory('First');
      await memoryManager.addMemory('Second');

      await memoryManager.clearMemories();

      const memories = await memoryManager.listMemories();
      expect(memories).toHaveLength(0);
    });
  });

  describe('searchMemories', () => {
    beforeEach(async () => {
      await memoryManager.addMemory('JavaScript is great');
      await memoryManager.addMemory('Python is powerful');
      await memoryManager.addMemory('TypeScript is typed', ['typescript']);
    });

    it('should search by content', async () => {
      const results = await memoryManager.searchMemories('JavaScript');

      expect(results).toHaveLength(1);
      expect(results[0].content).toContain('JavaScript');
    });

    it('should search by tag', async () => {
      const results = await memoryManager.searchMemories('typescript');

      expect(results).toHaveLength(1);
      expect(results[0].content).toContain('TypeScript');
    });

    it('should be case-insensitive', async () => {
      const results = await memoryManager.searchMemories('PYTHON');

      expect(results).toHaveLength(1);
    });

    it('should return empty array for no matches', async () => {
      const results = await memoryManager.searchMemories('Rust');

      expect(results).toEqual([]);
    });
  });

  describe('persistence', () => {
    it('should persist memories to disk', async () => {
      await memoryManager.addMemory('Persistent memory');
      await memoryManager.save();

      // Create new instance
      const newManager = new MemoryManager();
      (newManager as any).storagePath = testStoragePath;
      await newManager.load();

      const memories = await newManager.listMemories();
      expect(memories).toHaveLength(1);
      expect(memories[0].content).toBe('Persistent memory');
    });
  });

  describe('getMemoriesForSystemPrompt', () => {
    it('should format memories for system prompt', async () => {
      await memoryManager.addMemory('First fact');
      await memoryManager.addMemory('Second fact');

      const formatted = await memoryManager.getMemoriesForSystemPrompt();

      expect(formatted).toContain('Project Memories');
      expect(formatted).toContain('First fact');
      expect(formatted).toContain('Second fact');
    });

    it('should return empty string if no memories', async () => {
      const formatted = await memoryManager.getMemoriesForSystemPrompt();

      expect(formatted).toBe('');
    });
  });
});
