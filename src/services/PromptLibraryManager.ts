/**
 * PromptLibraryManager - Manages user's saved prompts library
 *
 * Handles creating, loading, saving, and deleting user prompts.
 * Prompts are stored as JSON in ~/.ally/profiles/{profile}/prompts/library.json.
 *
 * Features:
 * - CRUD operations for prompts
 * - Atomic writes to prevent data corruption
 * - Tag-based organization
 * - Sorted by creation time (newest first)
 *
 * Profile-aware: Uses profile-specific prompts directory via getPromptsDir()
 */

import { promises as fs } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { IService } from '../types/index.js';
import { logger } from './Logger.js';
import { getPromptsDir } from '../config/paths.js';
import { atomicWriteFile } from '../utils/atomicFile.js';
import { migrateRecord, stampVersion, SchemaTooNewError } from '../utils/versionedStore.js';
import { PROMPT_LIBRARY_SCHEMA } from '../config/schemas.js';

/**
 * Prompt data structure
 */
export interface PromptInfo {
  id: string;              // Unique identifier
  title: string;           // User-provided title
  content: string;         // The actual prompt text
  createdAt: number;       // Timestamp (milliseconds since epoch)
  tags?: string[];         // Optional tags for organization
}

/**
 * Storage container for prompts
 */
interface PromptLibraryData {
  /** Persisted schema version; see src/utils/versionedStore.ts. */
  schema_version?: number;
  /** Legacy free-form label kept for files written by older builds. */
  version?: string;
  prompts: PromptInfo[];
}

/**
 * PromptLibraryManager handles all prompt library persistence operations
 */
export class PromptLibraryManager implements IService {
  private promptsDir: string;
  private libraryFile: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(baseDir?: string) {
    // Profile-aware: getPromptsDir() returns profile-specific prompts directory
    // This is captured at construction time (launch-time), so profile switching
    // requires application restart
    // For testing: baseDir can override the default profile-specific directory
    this.promptsDir = baseDir ?? getPromptsDir();
    this.libraryFile = join(this.promptsDir, 'library.json');
  }

  /**
   * Initialize the prompt library manager (creates directory)
   */
  async initialize(): Promise<void> {
    await fs.mkdir(this.promptsDir, { recursive: true });
    logger.debug('[PROMPT_LIBRARY] Initialized prompt library manager');
  }

  /**
   * Cleanup resources (no-op for now, but required by IService)
   */
  async cleanup(): Promise<void> {
    // Wait for any pending writes to complete
    await this.writeQueue;
    logger.debug('[PROMPT_LIBRARY] Cleaned up prompt library manager');
  }

  /**
   * Load the prompt library from disk
   *
   * @returns PromptLibraryData or null if file doesn't exist
   */
  private async loadLibrary(): Promise<PromptLibraryData | null> {
    try {
      const content = await fs.readFile(this.libraryFile, 'utf-8');

      // Handle empty or corrupted files
      if (!content || content.trim().length === 0) {
        logger.warn('[PROMPT_LIBRARY] Library file is empty, returning empty library');
        return null;
      }

      // Libraries written before versioning carry no schema_version and read as
      // v0. One written by a newer build throws and is left untouched.
      return migrateRecord<PromptLibraryData>(JSON.parse(content), PROMPT_LIBRARY_SCHEMA);
    } catch (error) {
      if (error instanceof SchemaTooNewError) {
        logger.error(`[PROMPT_LIBRARY] ${error.message}`);
        throw error;
      }

      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // File doesn't exist yet - this is normal for first run
        return null;
      }

      // If JSON parse fails, the file is corrupted
      if (error instanceof SyntaxError) {
        logger.error('[PROMPT_LIBRARY] Corrupted library file, returning empty library:', error);
        return null;
      }

      logger.error('[PROMPT_LIBRARY] Failed to load library:', error);
      return null;
    }
  }

  /**
   * Save the prompt library to disk atomically with write serialization
   *
   * Uses atomic write (temp file + rename) and promise chaining to serialize writes.
   * This prevents race conditions and ensures data integrity.
   *
   * @param data - Complete library data to save
   */
  private async saveLibrary(data: PromptLibraryData): Promise<void> {
    // Capture the existing write promise synchronously
    const existingWrite = this.writeQueue;

    // Create our write promise that chains after the existing one
    const writePromise = (async () => {
      // Wait for the previous write to complete
      await existingWrite.catch(() => {
        // Ignore errors from previous writes
      });

      // Now perform our atomic file write
      await atomicWriteFile(
        this.libraryFile,
        JSON.stringify(stampVersion(data, PROMPT_LIBRARY_SCHEMA), null, 2)
      );
      logger.debug('[PROMPT_LIBRARY] Saved library atomically');
    })();

    // Update the queue with our promise
    this.writeQueue = writePromise;

    // Wait for our write to complete
    await writePromise;
  }

  /**
   * Get all prompts from the library
   *
   * @returns Array of prompts sorted by createdAt (newest first)
   */
  async getPrompts(): Promise<PromptInfo[]> {
    const library = await this.loadLibrary();

    if (!library || !library.prompts) {
      return [];
    }

    // Sort by creation time (newest first)
    return library.prompts.sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * Get a single prompt by ID
   *
   * @param id - Prompt ID
   * @returns Prompt info or undefined if not found
   */
  async getPrompt(id: string): Promise<PromptInfo | undefined> {
    const library = await this.loadLibrary();

    if (!library || !library.prompts) {
      return undefined;
    }

    return library.prompts.find(p => p.id === id);
  }

  /**
   * Add a new prompt to the library
   *
   * @param title - Prompt title
   * @param content - Prompt content
   * @param tags - Optional tags for organization
   * @returns The newly created prompt
   */
  async addPrompt(title: string, content: string, tags?: string[]): Promise<PromptInfo> {
    const library = await this.loadLibrary() ?? { prompts: [] };

    // Create new prompt with UUID
    const newPrompt: PromptInfo = {
      id: randomUUID(),
      title: title.trim(),
      content: content.trim(),
      createdAt: Date.now(),
    };

    // Add tags if provided
    if (tags && tags.length > 0) {
      newPrompt.tags = tags.map(tag => tag.trim()).filter(tag => tag.length > 0);
    }

    // Add to library
    library.prompts.push(newPrompt);

    // Save library
    await this.saveLibrary(library);

    logger.debug(`[PROMPT_LIBRARY] Added prompt: ${newPrompt.id} - "${newPrompt.title}"`);

    return newPrompt;
  }

  /**
   * Delete a prompt from the library
   *
   * @param id - Prompt ID to delete
   * @throws Error if prompt not found
   */
  async deletePrompt(id: string): Promise<void> {
    const library = await this.loadLibrary();

    if (!library || !library.prompts) {
      throw new Error(`Prompt not found: ${id}`);
    }

    const initialLength = library.prompts.length;
    library.prompts = library.prompts.filter(p => p.id !== id);

    if (library.prompts.length === initialLength) {
      throw new Error(`Prompt not found: ${id}`);
    }

    await this.saveLibrary(library);

    logger.debug(`[PROMPT_LIBRARY] Deleted prompt: ${id}`);
  }

  /**
   * Clear all prompts from the library
   *
   * @returns Number of prompts cleared
   */
  async clearAllPrompts(): Promise<number> {
    const library = await this.loadLibrary();

    if (!library || !library.prompts || library.prompts.length === 0) {
      return 0;
    }

    const count = library.prompts.length;

    // Clear prompts array but preserve schema version
    library.prompts = [];

    await this.saveLibrary(library);

    logger.debug(`[PROMPT_LIBRARY] Cleared ${count} prompts`);

    return count;
  }

  /**
   * Update an existing prompt
   *
   * @param id - Prompt ID to update
   * @param updates - Partial prompt data to update
   * @returns Updated prompt
   * @throws Error if prompt not found
   */
  async updatePrompt(id: string, updates: Partial<Omit<PromptInfo, 'id' | 'createdAt'>>): Promise<PromptInfo> {
    const library = await this.loadLibrary();

    if (!library || !library.prompts) {
      throw new Error(`Prompt not found: ${id}`);
    }

    const prompt = library.prompts.find(p => p.id === id);
    if (!prompt) {
      throw new Error(`Prompt not found: ${id}`);
    }

    // Apply updates
    if (updates.title !== undefined) {
      prompt.title = updates.title.trim();
    }
    if (updates.content !== undefined) {
      prompt.content = updates.content.trim();
    }
    if (updates.tags !== undefined) {
      prompt.tags = updates.tags.map(tag => tag.trim()).filter(tag => tag.length > 0);
    }

    await this.saveLibrary(library);

    logger.debug(`[PROMPT_LIBRARY] Updated prompt: ${id} - "${prompt.title}"`);

    return prompt;
  }

  /**
   * Search prompts by title or tags
   *
   * @param query - Search query (case-insensitive)
   * @returns Array of matching prompts sorted by createdAt (newest first)
   */
  async searchPrompts(query: string): Promise<PromptInfo[]> {
    const prompts = await this.getPrompts();
    const lowerQuery = query.toLowerCase().trim();

    if (!lowerQuery) {
      return prompts;
    }

    return prompts.filter(prompt => {
      // Search in title
      if (prompt.title.toLowerCase().includes(lowerQuery)) {
        return true;
      }

      // Search in tags
      if (prompt.tags && prompt.tags.some(tag => tag.toLowerCase().includes(lowerQuery))) {
        return true;
      }

      return false;
    });
  }

  /**
   * Get prompts by tag
   *
   * @param tag - Tag to filter by (case-insensitive)
   * @returns Array of prompts with the specified tag, sorted by createdAt (newest first)
   */
  async getPromptsByTag(tag: string): Promise<PromptInfo[]> {
    const prompts = await this.getPrompts();
    const lowerTag = tag.toLowerCase().trim();

    return prompts.filter(prompt =>
      prompt.tags && prompt.tags.some(t => t.toLowerCase() === lowerTag)
    );
  }

  /**
   * Get all unique tags from the library
   *
   * @returns Array of unique tags sorted alphabetically
   */
  async getAllTags(): Promise<string[]> {
    const prompts = await this.getPrompts();
    const tagSet = new Set<string>();

    for (const prompt of prompts) {
      if (prompt.tags) {
        for (const tag of prompt.tags) {
          tagSet.add(tag);
        }
      }
    }

    return Array.from(tagSet).sort();
  }
}
