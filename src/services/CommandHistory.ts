/**
 * CommandHistory - Manages command history with persistence
 *
 * Features:
 * - Persistent storage to ~/.ally/history.json
 * - Deduplication of consecutive commands
 * - Maximum history size management
 * - Search functionality
 * - Thread-safe file operations
 */

import { promises as fs } from 'fs';
import { join } from 'path';
import { ALLY_HOME } from '../config/paths.js';
import { BUFFER_SIZES, UI_DELAYS } from '../config/constants.js';

export interface CommandHistoryEntry {
  command: string;
  timestamp: number;
}

export interface CommandHistoryOptions {
  maxSize?: number;
  storagePath?: string;
}

/**
 * CommandHistory service for managing user input history
 */
export class CommandHistory {
  private history: CommandHistoryEntry[] = [];
  private maxSize: number;
  private storagePath: string;
  private saveDebounceTimer: NodeJS.Timeout | null = null;
  private loaded: boolean = false;

  constructor(options: CommandHistoryOptions = {}) {
    this.maxSize = options.maxSize || BUFFER_SIZES.COMMAND_HISTORY_MAX;
    this.storagePath = options.storagePath || join(ALLY_HOME, 'history.json');
  }

  /**
   * Load history from disk
   */
  async load(): Promise<void> {
    if (this.loaded) {
      return;
    }

    try {
      // Get directory from storagePath
      const dir = this.storagePath.substring(0, this.storagePath.lastIndexOf('/'));

      // Ensure parent directory exists
      if (dir) {
        await fs.mkdir(dir, { recursive: true });
      }

      // Try to load existing history
      const data = await fs.readFile(this.storagePath, 'utf-8');
      const parsed = JSON.parse(data);

      // Validate structure
      if (Array.isArray(parsed)) {
        this.history = parsed.filter(
          (entry): entry is CommandHistoryEntry =>
            typeof entry === 'object' &&
            entry !== null &&
            typeof entry.command === 'string' &&
            typeof entry.timestamp === 'number'
        );
      }

      this.loaded = true;
    } catch (error) {
      // File doesn't exist or is invalid - start with empty history
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error('Error loading command history:', error);
      }
      this.history = [];
      this.loaded = true;
    }
  }

  /**
   * Save history to disk (debounced)
   */
  async save(): Promise<void> {
    // Debounce saves to avoid excessive disk writes
    if (this.saveDebounceTimer) {
      clearTimeout(this.saveDebounceTimer);
    }

    return new Promise((resolve, reject) => {
      this.saveDebounceTimer = setTimeout(async () => {
        try {
          await this.saveImmediate();
          resolve();
        } catch (error) {
          reject(error);
        }
      }, UI_DELAYS.SAVE_DEBOUNCE);
    });
  }

  /**
   * Save immediately without debouncing
   */
  private async saveImmediate(): Promise<void> {
    try {
      // Get directory from storagePath (not using join with '..')
      const dir = this.storagePath.substring(0, this.storagePath.lastIndexOf('/'));

      // Ensure parent directory exists
      await fs.mkdir(dir, { recursive: true });

      // Write directly (atomic operation not strictly necessary for history)
      await fs.writeFile(this.storagePath, JSON.stringify(this.history, null, 2), 'utf-8');
    } catch (error) {
      console.error('Error saving command history:', error);
      throw error;
    }
  }

  /**
   * Add a command to history
   *
   * @param command - Command to add
   * @param skipDuplicateCheck - Skip consecutive duplicate check
   */
  addCommand(command: string, skipDuplicateCheck: boolean = false): void {
    const trimmed = command.trim();
    if (!trimmed) {
      return;
    }

    // Skip if same as last command (unless explicitly allowed)
    if (!skipDuplicateCheck && this.history.length > 0) {
      const lastEntry = this.history[this.history.length - 1];
      if (lastEntry && lastEntry.command === trimmed) {
        return;
      }
    }

    // Add new entry
    this.history.push({
      command: trimmed,
      timestamp: Date.now(),
    });

    // Trim to max size
    if (this.history.length > this.maxSize) {
      this.history = this.history.slice(-this.maxSize);
    }

    // Save to disk (debounced)
    this.save().catch(err => {
      console.error('Failed to save command history:', err);
    });
  }

  /**
   * Get all history entries
   */
  getHistory(): CommandHistoryEntry[] {
    return [...this.history];
  }

  /**
   * Get commands only (without timestamps)
   */
  getCommands(): string[] {
    return this.history.map(entry => entry.command);
  }

  /**
   * Get a command at specific index
   *
   * @param index - Index in history (0 = oldest, length-1 = newest)
   */
  getCommand(index: number): string | null {
    if (index < 0 || index >= this.history.length) {
      return null;
    }
    const entry = this.history[index];
    return entry ? entry.command : null;
  }

  /**
   * Get previous command relative to current index
   *
   * @param currentIndex - Current position in history (-1 = not in history)
   * @returns Command and new index, or null if at beginning
   */
  getPrevious(currentIndex: number): { command: string; index: number } | null {
    // If not in history, start from end
    if (currentIndex === -1) {
      const index = this.history.length - 1;
      const entry = this.history[index];
      return index >= 0 && entry ? { command: entry.command, index } : null;
    }

    // Move back one
    const index = currentIndex - 1;
    const entry = this.history[index];
    return index >= 0 && entry ? { command: entry.command, index } : null;
  }

  /**
   * Get next command relative to current index
   *
   * @param currentIndex - Current position in history
   * @returns Command and new index, or null if at end
   */
  getNext(currentIndex: number): { command: string; index: number } | null {
    // Move forward one
    const index = currentIndex + 1;
    if (index >= this.history.length) {
      // Reached end - return null to indicate "clear buffer"
      return null;
    }
    const entry = this.history[index];
    return entry ? { command: entry.command, index } : null;
  }

  /**
   * Search history for commands matching query
   *
   * @param query - Search query
   * @param limit - Maximum results to return
   * @returns Matching commands (most recent first)
   */
  search(query: string, limit: number = BUFFER_SIZES.DEFAULT_LIST_PREVIEW): string[] {
    const lowerQuery = query.toLowerCase();
    const matches: string[] = [];

    // Search backwards (most recent first)
    for (let i = this.history.length - 1; i >= 0 && matches.length < limit; i--) {
      const entry = this.history[i];
      if (entry && entry.command.toLowerCase().includes(lowerQuery)) {
        const cmd = entry.command;
        // Avoid duplicates
        if (!matches.includes(cmd)) {
          matches.push(cmd);
        }
      }
    }

    return matches;
  }

  /**
   * Clear all history
   */
  async clear(): Promise<void> {
    this.history = [];
    await this.saveImmediate();
  }

  /**
   * Get the size of the history
   */
  size(): number {
    return this.history.length;
  }

  /**
   * Check if history is empty
   */
  isEmpty(): boolean {
    return this.history.length === 0;
  }

  /**
   * Export history as JSON string
   */
  export(): string {
    return JSON.stringify(this.history, null, 2);
  }

  /**
   * Import history from JSON string
   */
  import(jsonString: string): void {
    try {
      const parsed = JSON.parse(jsonString);
      if (Array.isArray(parsed)) {
        this.history = parsed.filter(
          (entry): entry is CommandHistoryEntry =>
            typeof entry === 'object' &&
            entry !== null &&
            typeof entry.command === 'string' &&
            typeof entry.timestamp === 'number'
        );

        // Trim to max size
        if (this.history.length > this.maxSize) {
          this.history = this.history.slice(-this.maxSize);
        }

        this.save().catch(err => {
          console.error('Failed to save imported history:', err);
        });
      }
    } catch (error) {
      throw new Error(`Invalid history JSON: ${error}`);
    }
  }
}
