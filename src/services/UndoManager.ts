/**
 * UndoManager - File operation undo system
 *
 * Tracks file operations and allows undoing them.
 * Stores operation history with file backups for restoration.
 */

import { promises as fs } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { IService } from '../types/index.js';
import { randomUUID } from 'crypto';

export type OperationType = 'write' | 'edit' | 'delete' | 'create';

export interface UndoEntry {
  id: string;
  operation: OperationType;
  filePath: string;
  timestamp: Date;
  backup?: string; // Path to backup file
  originalContent?: string; // For small files, store inline
}

export interface UndoResult {
  success: boolean;
  message: string;
  filesAffected?: string[];
}

export class UndoManager implements IService {
  private history: UndoEntry[] = [];
  private readonly maxHistorySize: number = 10;
  private readonly backupDir: string;
  private initialized: boolean = false;

  constructor() {
    this.backupDir = join(homedir(), '.code_ally', 'undo_backups');
  }

  /**
   * Initialize the service - ensure backup directory exists
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    try {
      await fs.mkdir(this.backupDir, { recursive: true });
    } catch (error) {
      console.error('Error creating undo backup directory:', error);
    }

    this.initialized = true;
  }

  /**
   * Cleanup the service - clean old backups
   */
  async cleanup(): Promise<void> {
    await this.cleanOldBackups();
  }

  /**
   * Record a file operation
   *
   * @param operation - Operation type
   * @param filePath - File path affected
   * @param originalContent - Original file content (for undo)
   */
  async recordOperation(
    operation: OperationType,
    filePath: string,
    originalContent?: string
  ): Promise<void> {
    const entry: UndoEntry = {
      id: randomUUID(),
      operation,
      filePath,
      timestamp: new Date(),
    };

    // Store content inline if small, otherwise backup to file
    if (originalContent !== undefined) {
      if (originalContent.length < 10000) {
        entry.originalContent = originalContent;
      } else {
        // Save to backup file
        const backupPath = join(this.backupDir, `${entry.id}.backup`);
        await fs.writeFile(backupPath, originalContent, 'utf-8');
        entry.backup = backupPath;
      }
    }

    // Add to history
    this.history.push(entry);

    // Trim history if too long
    if (this.history.length > this.maxHistorySize) {
      const removed = this.history.shift();

      // Clean up old backup file
      if (removed?.backup) {
        try {
          await fs.unlink(removed.backup);
        } catch {
          // Ignore errors
        }
      }
    }
  }

  /**
   * Undo the last N operations
   *
   * @param count - Number of operations to undo (default: 1)
   * @returns Undo result
   */
  async undo(count: number = 1): Promise<UndoResult> {
    if (this.history.length === 0) {
      return {
        success: false,
        message: 'No operations to undo',
      };
    }

    if (count <= 0) {
      return {
        success: false,
        message: 'Invalid count',
      };
    }

    const actualCount = Math.min(count, this.history.length);
    const entries = this.history.slice(-actualCount).reverse();
    const filesAffected: string[] = [];
    const errors: string[] = [];

    for (const entry of entries) {
      try {
        await this.undoEntry(entry);
        filesAffected.push(entry.filePath);
      } catch (error) {
        errors.push(`${entry.filePath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // Remove successfully undone entries from history
    this.history = this.history.slice(0, -actualCount);

    if (errors.length > 0) {
      return {
        success: false,
        message: `Failed to undo some operations:\n${errors.join('\n')}`,
        filesAffected,
      };
    }

    const message =
      actualCount === 1
        ? `Undid operation on ${filesAffected[0]}`
        : `Undid ${actualCount} operations`;

    return {
      success: true,
      message,
      filesAffected,
    };
  }

  /**
   * Undo a single entry
   *
   * @param entry - Undo entry
   */
  private async undoEntry(entry: UndoEntry): Promise<void> {
    switch (entry.operation) {
      case 'write':
      case 'edit':
        // Restore original content
        await this.restoreContent(entry);
        break;

      case 'create':
        // Delete the created file
        await fs.unlink(entry.filePath);
        break;

      case 'delete':
        // Restore deleted file
        await this.restoreContent(entry);
        break;

      default:
        throw new Error(`Unknown operation type: ${entry.operation}`);
    }
  }

  /**
   * Restore original file content
   *
   * @param entry - Undo entry
   */
  private async restoreContent(entry: UndoEntry): Promise<void> {
    let content: string;

    if (entry.originalContent !== undefined) {
      content = entry.originalContent;
    } else if (entry.backup) {
      content = await fs.readFile(entry.backup, 'utf-8');
    } else {
      throw new Error('No backup content available');
    }

    await fs.writeFile(entry.filePath, content, 'utf-8');

    // Clean up backup file if it exists
    if (entry.backup) {
      try {
        await fs.unlink(entry.backup);
      } catch {
        // Ignore errors
      }
    }
  }

  /**
   * Get operation history
   *
   * @param limit - Maximum number of entries to return
   * @returns Array of undo entries (most recent first)
   */
  getHistory(limit?: number): UndoEntry[] {
    const entries = [...this.history].reverse();

    if (limit !== undefined && limit > 0) {
      return entries.slice(0, limit);
    }

    return entries;
  }

  /**
   * Clear all undo history
   */
  async clearHistory(): Promise<void> {
    // Clean up all backup files
    for (const entry of this.history) {
      if (entry.backup) {
        try {
          await fs.unlink(entry.backup);
        } catch {
          // Ignore errors
        }
      }
    }

    this.history = [];
  }

  /**
   * Clean up old backup files
   */
  private async cleanOldBackups(): Promise<void> {
    try {
      const files = await fs.readdir(this.backupDir);

      // Get all backup paths that are currently in history
      const activeBackups = new Set(
        this.history.map(e => e.backup).filter((b): b is string => b !== undefined)
      );

      // Delete files not in history
      for (const file of files) {
        const fullPath = join(this.backupDir, file);

        if (!activeBackups.has(fullPath)) {
          try {
            await fs.unlink(fullPath);
          } catch {
            // Ignore errors
          }
        }
      }
    } catch (error) {
      console.error('Error cleaning old backups:', error);
    }
  }

  /**
   * Get formatted history for display
   *
   * @returns Formatted string
   */
  getFormattedHistory(): string {
    if (this.history.length === 0) {
      return 'No undo history';
    }

    let output = 'Undo History:\n\n';

    const entries = [...this.history].reverse();

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (!entry) continue;
      const time = entry.timestamp.toLocaleTimeString();
      output += `${i + 1}. [${time}] ${entry.operation} - ${entry.filePath}\n`;
    }

    return output;
  }
}
