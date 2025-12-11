/**
 * FileInteractionTracker - Tracks the last file touched by file tools
 *
 * Simple, focused service that remembers the most recent file path
 * from read, write, edit, and line-edit operations. Used by /open
 * command to open the last touched file when no argument is provided.
 */

import path from 'path';

/** Tools that interact with files and should be tracked */
const FILE_TOOLS = new Set(['read', 'write', 'edit', 'line-edit']);

export class FileInteractionTracker {
  private lastTouchedPath: string | null = null;

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
    this.lastTouchedPath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(process.cwd(), filePath);
  }

  /**
   * Get the last touched file path
   *
   * @returns Absolute path to the last touched file, or null if none
   */
  getLastTouched(): string | null {
    return this.lastTouchedPath;
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
    this.lastTouchedPath = null;
  }
}
