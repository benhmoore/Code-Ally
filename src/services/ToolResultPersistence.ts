/**
 * ToolResultPersistence - Persist large tool outputs to disk
 *
 * When tool output exceeds context limits and must be truncated, the full output
 * is saved to disk so it can be retrieved later. The model sees a preview with
 * a file path reference instead of losing the data entirely.
 *
 * Follows the PatchManager pattern: <sessions-dir>/{sessionId}/tool-results/
 */

import * as path from 'path';
import { promises as fs } from 'fs';
import { getProjectSessionsDir } from '../config/paths.js';

export class ToolResultPersistence {
  private sessionsDir: string;
  private getSessionId: () => string | null;

  constructor(getSessionId: () => string | null, sessionsDir?: string) {
    this.getSessionId = getSessionId;
    this.sessionsDir = sessionsDir ?? getProjectSessionsDir();
  }

  /**
   * Get the tool-results directory for the current session
   */
  private getResultsDir(): string | null {
    const sessionId = this.getSessionId();
    if (!sessionId) return null;
    return path.join(this.sessionsDir, sessionId, 'tool-results');
  }

  /**
   * Persist a large tool result to disk.
   * Returns the file path where the content was saved, or null if unable to save.
   */
  async persistResult(toolCallId: string, content: string): Promise<string | null> {
    const resultsDir = this.getResultsDir();
    if (!resultsDir) return null;

    try {
      await fs.mkdir(resultsDir, { recursive: true });
      // Sanitize toolCallId for use as filename
      const safeId = toolCallId.replace(/[^a-zA-Z0-9_-]/g, '_');
      const filePath = path.join(resultsDir, `${safeId}.txt`);
      await fs.writeFile(filePath, content, 'utf-8');
      return filePath;
    } catch {
      return null;
    }
  }

  /**
   * Read a previously persisted result
   */
  async readResult(toolCallId: string): Promise<string | null> {
    const resultsDir = this.getResultsDir();
    if (!resultsDir) return null;

    try {
      const safeId = toolCallId.replace(/[^a-zA-Z0-9_-]/g, '_');
      const filePath = path.join(resultsDir, `${safeId}.txt`);
      return await fs.readFile(filePath, 'utf-8');
    } catch {
      return null;
    }
  }

  /**
   * Get the path to a persisted result without reading it
   */
  getResultPath(toolCallId: string): string | null {
    const resultsDir = this.getResultsDir();
    if (!resultsDir) return null;
    const safeId = toolCallId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(resultsDir, `${safeId}.txt`);
  }
}
