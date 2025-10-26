/**
 * ProjectManager - Project context management
 *
 * Manages project-specific context and metadata.
 * Stores project context as JSON in ~/.code_ally/project.json
 */

import { promises as fs } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { IService } from '../types/index.js';
import { BUFFER_SIZES } from '../config/constants.js';

export interface ProjectContext {
  name: string;
  description: string;
  files: string[];
  created: Date;
  updated: Date;
  metadata?: Record<string, any>;
}

export class ProjectManager implements IService {
  private context: ProjectContext | null = null;
  private readonly storagePath: string;
  private initialized: boolean = false;

  constructor() {
    this.storagePath = join(homedir(), '.code_ally', 'project.json');
  }

  /**
   * Initialize the service - load project context from disk
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    await this.load();
    this.initialized = true;
  }

  /**
   * Cleanup the service - save project context to disk
   */
  async cleanup(): Promise<void> {
    if (this.context) {
      await this.save();
    }
  }

  /**
   * Load project context from disk
   */
  async load(): Promise<void> {
    try {
      const content = await fs.readFile(this.storagePath, 'utf-8');
      const data = JSON.parse(content);

      this.context = {
        name: data.name,
        description: data.description,
        files: data.files || [],
        created: new Date(data.created),
        updated: new Date(data.updated),
        metadata: data.metadata || {},
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // File doesn't exist yet - that's fine
        this.context = null;
      } else {
        console.error('Error loading project context:', error);
      }
    }
  }

  /**
   * Save project context to disk
   */
  async save(): Promise<void> {
    if (!this.context) {
      return;
    }

    try {
      // Ensure directory exists
      const dir = join(homedir(), '.code_ally');
      await fs.mkdir(dir, { recursive: true });

      const data = {
        version: 1,
        name: this.context.name,
        description: this.context.description,
        files: this.context.files,
        created: this.context.created.toISOString(),
        updated: this.context.updated.toISOString(),
        metadata: this.context.metadata || {},
      };

      const content = JSON.stringify(data, null, 2);
      await fs.writeFile(this.storagePath, content, 'utf-8');
    } catch (error) {
      console.error('Error saving project context:', error);
      throw error;
    }
  }

  /**
   * Initialize a new project context
   *
   * @param name - Project name
   * @param description - Project description
   */
  async initProject(name: string, description: string): Promise<void> {
    this.context = {
      name,
      description,
      files: [],
      created: new Date(),
      updated: new Date(),
      metadata: {},
    };

    await this.save();
  }

  /**
   * Add a file to the project context
   *
   * @param filePath - File path to add
   */
  async addFile(filePath: string): Promise<void> {
    if (!this.context) {
      throw new Error('No project context initialized');
    }

    if (!this.context.files.includes(filePath)) {
      this.context.files.push(filePath);
      this.context.updated = new Date();
      await this.save();
    }
  }

  /**
   * Remove a file from the project context
   *
   * @param filePath - File path to remove
   */
  async removeFile(filePath: string): Promise<void> {
    if (!this.context) {
      return;
    }

    const index = this.context.files.indexOf(filePath);

    if (index !== -1) {
      this.context.files.splice(index, 1);
      this.context.updated = new Date();
      await this.save();
    }
  }

  /**
   * Get the current project context
   *
   * @returns Project context or null if not initialized
   */
  async getContext(): Promise<ProjectContext | null> {
    return this.context ? { ...this.context } : null;
  }

  /**
   * Clear the project context
   */
  async clearContext(): Promise<void> {
    this.context = null;

    // Delete the file
    try {
      await fs.unlink(this.storagePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error('Error deleting project context:', error);
      }
    }
  }

  /**
   * Update project metadata
   *
   * @param key - Metadata key
   * @param value - Metadata value
   */
  async setMetadata(key: string, value: any): Promise<void> {
    if (!this.context) {
      throw new Error('No project context initialized');
    }

    if (!this.context.metadata) {
      this.context.metadata = {};
    }

    this.context.metadata[key] = value;
    this.context.updated = new Date();
    await this.save();
  }

  /**
   * Get project metadata
   *
   * @param key - Metadata key
   * @returns Metadata value or undefined
   */
  getMetadata(key: string): any {
    return this.context?.metadata?.[key];
  }

  /**
   * Get project context formatted for system prompt
   *
   * @returns Formatted string for system prompt inclusion
   */
  async getContextForSystemPrompt(): Promise<string> {
    if (!this.context) {
      return '';
    }

    let output = '\n\n**Project Context:**\n';
    output += `Name: ${this.context.name}\n`;
    output += `Description: ${this.context.description}\n`;

    if (this.context.files.length > 0) {
      output += `\nKey Files (${this.context.files.length}):\n`;
      for (const file of this.context.files.slice(0, BUFFER_SIZES.DEFAULT_LIST_PREVIEW)) {
        output += `- ${file}\n`;
      }

      if (this.context.files.length > BUFFER_SIZES.DEFAULT_LIST_PREVIEW) {
        output += `... and ${this.context.files.length - BUFFER_SIZES.DEFAULT_LIST_PREVIEW} more\n`;
      }
    }

    return output;
  }
}
