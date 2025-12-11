/**
 * FileInteractionTracker - Tracks files touched by file tools
 *
 * Maintains a history of recently accessed files from read, write, edit,
 * and line-edit operations. Used by /open command for:
 * - Opening the last touched file when no argument is provided
 * - Suggesting recent files in tab completion
 */

import path from 'path';

/** Tools that interact with files and should be tracked */
const FILE_TOOLS = new Set(['read', 'write', 'edit', 'line-edit']);

/** Maximum number of recent files to track */
const MAX_HISTORY = 20;

export class FileInteractionTracker {
  /** Recent files, most recent first */
  private recentFiles: string[] = [];

  /**
   * Record a file interaction from a tool execution
   *
   * @param toolName - Name of the tool (read, write, edit, line-edit)
   * @param filePath - Absolute or relative file path
   */
  recordInteraction(toolName: string, filePath: string): void {
    if (!FILE_TOOLS.has(toolName) || !filePath) {
      return;
    }

    // Normalize to absolute path
    const absolutePath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(process.cwd(), filePath);

    // Remove if already in history (will re-add at front)
    const existingIndex = this.recentFiles.indexOf(absolutePath);
    if (existingIndex !== -1) {
      this.recentFiles.splice(existingIndex, 1);
    }

    // Add to front
    this.recentFiles.unshift(absolutePath);

    // Trim to max size
    if (this.recentFiles.length > MAX_HISTORY) {
      this.recentFiles.length = MAX_HISTORY;
    }
  }

  /**
   * Get the last touched file path
   *
   * @returns Absolute path to the last touched file, or null if none
   */
  getLastTouched(): string | null {
    return this.recentFiles[0] ?? null;
  }

  /**
   * Get recently touched files
   *
   * @param limit - Maximum number of files to return (default 10)
   * @returns Array of absolute paths, most recent first
   */
  getRecentFiles(limit: number = 10): string[] {
    return this.recentFiles.slice(0, limit);
  }

  /**
   * Check if a tool name is tracked by this service
   */
  static isTrackedTool(toolName: string): boolean {
    return FILE_TOOLS.has(toolName);
  }

  /**
   * Reset tracking state (e.g., on session switch)
   */
  reset(): void {
    this.recentFiles = [];
  }
}
