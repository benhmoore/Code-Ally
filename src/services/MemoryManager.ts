/**
 * MemoryManager - Persistent memory/facts system
 *
 * Manages long-term memory facts that persist across sessions.
 * Stores memories as JSON in ~/.code_ally/memory.json
 */

import { promises as fs } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { IService } from '../types/index.js';
import { randomUUID } from 'crypto';

export interface MemoryFact {
  id: string;
  content: string;
  created: Date;
  tags?: string[];
}

export class MemoryManager implements IService {
  private memories: Map<string, MemoryFact> = new Map();
  private readonly storagePath: string;
  private initialized: boolean = false;

  constructor() {
    this.storagePath = join(homedir(), '.code_ally', 'memory.json');
  }

  /**
   * Initialize the service - load memories from disk
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    await this.load();
    this.initialized = true;
  }

  /**
   * Cleanup the service - save memories to disk
   */
  async cleanup(): Promise<void> {
    await this.save();
  }

  /**
   * Load memories from disk
   */
  async load(): Promise<void> {
    try {
      const content = await fs.readFile(this.storagePath, 'utf-8');
      const data = JSON.parse(content);

      this.memories.clear();

      if (Array.isArray(data.memories)) {
        for (const memory of data.memories) {
          this.memories.set(memory.id, {
            id: memory.id,
            content: memory.content,
            created: new Date(memory.created),
            tags: memory.tags || [],
          });
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // File doesn't exist yet - that's fine
        this.memories.clear();
      } else {
        console.error('Error loading memories:', error);
      }
    }
  }

  /**
   * Save memories to disk
   */
  async save(): Promise<void> {
    try {
      // Ensure directory exists
      const dir = join(homedir(), '.code_ally');
      await fs.mkdir(dir, { recursive: true });

      const data = {
        version: 1,
        memories: Array.from(this.memories.values()).map(m => ({
          id: m.id,
          content: m.content,
          created: m.created.toISOString(),
          tags: m.tags || [],
        })),
      };

      const content = JSON.stringify(data, null, 2);
      await fs.writeFile(this.storagePath, content, 'utf-8');
    } catch (error) {
      console.error('Error saving memories:', error);
      throw error;
    }
  }

  /**
   * Add a new memory
   *
   * @param content - Memory content
   * @param tags - Optional tags
   * @returns Created memory fact
   */
  async addMemory(content: string, tags?: string[]): Promise<MemoryFact> {
    const memory: MemoryFact = {
      id: randomUUID(),
      content: content.trim(),
      created: new Date(),
      tags: tags || [],
    };

    this.memories.set(memory.id, memory);
    await this.save();

    return memory;
  }

  /**
   * Remove a memory by ID
   *
   * @param id - Memory ID
   * @returns True if removed, false if not found
   */
  async removeMemory(id: string): Promise<boolean> {
    const existed = this.memories.delete(id);

    if (existed) {
      await this.save();
    }

    return existed;
  }

  /**
   * Get a memory by ID
   *
   * @param id - Memory ID
   * @returns Memory fact or null if not found
   */
  async getMemory(id: string): Promise<MemoryFact | null> {
    return this.memories.get(id) || null;
  }

  /**
   * List all memories
   *
   * @returns Array of all memory facts, sorted by creation date (newest first)
   */
  async listMemories(): Promise<MemoryFact[]> {
    return Array.from(this.memories.values()).sort(
      (a, b) => b.created.getTime() - a.created.getTime()
    );
  }

  /**
   * Clear all memories
   */
  async clearMemories(): Promise<void> {
    this.memories.clear();
    await this.save();
  }

  /**
   * Search memories by content or tags
   *
   * @param query - Search query
   * @returns Matching memories
   */
  async searchMemories(query: string): Promise<MemoryFact[]> {
    const lowerQuery = query.toLowerCase();

    return Array.from(this.memories.values()).filter(memory => {
      // Search in content
      if (memory.content.toLowerCase().includes(lowerQuery)) {
        return true;
      }

      // Search in tags
      if (memory.tags?.some(tag => tag.toLowerCase().includes(lowerQuery))) {
        return true;
      }

      return false;
    });
  }

  /**
   * Get all memories formatted for system prompt
   *
   * @returns Formatted string for system prompt inclusion
   */
  async getMemoriesForSystemPrompt(): Promise<string> {
    const memories = await this.listMemories();

    if (memories.length === 0) {
      return '';
    }

    let output = '\n\n**Project Memories:**\n';

    for (const memory of memories) {
      output += `- ${memory.content}\n`;
    }

    return output;
  }
}
