/**
 * ContextFileLoader - Load context files referenced in compaction summaries
 *
 * Purpose: Load file contents from compaction summaries for injection into
 * system messages, providing relevant context from compacted conversations.
 *
 * Key features:
 * - Loads contextFileReferences from summary message metadata
 * - Respects file priority set by AgentCompactor (edited > written > read)
 * - Enforces 15% token budget allocation from remaining context
 * - Limits files to first 100 lines with truncation indicators
 * - Formats output as markdown code blocks with file paths
 * - Gracefully handles missing/unreadable files
 */

import { TokenManager } from '../agent/TokenManager.js';
import { Message } from '../types/index.js';
import { readFile } from 'fs/promises';
import { extname } from 'path';

/**
 * Map file extensions to markdown language identifiers
 */
function getLanguageFromExtension(filePath: string): string {
  const ext = extname(filePath).toLowerCase();

  const extensionMap: Record<string, string> = {
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.js': 'javascript',
    '.jsx': 'javascript',
    '.py': 'python',
    '.sh': 'bash',
    '.bash': 'bash',
    '.zsh': 'bash',
    '.json': 'json',
    '.html': 'html',
    '.css': 'css',
    '.scss': 'scss',
    '.go': 'go',
    '.rs': 'rust',
    '.java': 'java',
    '.c': 'c',
    '.cpp': 'cpp',
    '.h': 'cpp',
    '.hpp': 'cpp',
    '.rb': 'ruby',
    '.php': 'php',
    '.sql': 'sql',
    '.yaml': 'yaml',
    '.yml': 'yaml',
    '.toml': 'toml',
    '.xml': 'xml',
    '.md': 'markdown',
    '.txt': 'text',
  };

  return extensionMap[ext] || 'text';
}

/**
 * ContextFileLoader loads context files from compaction summaries
 */
export class ContextFileLoader {
  private tokenManager: TokenManager;

  /**
   * Create a new ContextFileLoader
   * @param tokenManager TokenManager instance for budget calculations
   */
  constructor(tokenManager: TokenManager) {
    this.tokenManager = tokenManager;
  }

  /**
   * Load context files referenced in a summary message
   *
   * Extracts file references from summary metadata, prioritizes by edit type,
   * and loads files within a 15% token budget allocation.
   *
   * @param summaryMessage Message containing contextFileReferences metadata
   * @returns Formatted string with file contents, or null if no files/budget
   */
  async loadFromSummary(summaryMessage: Message): Promise<string | null> {
    // Extract context file references from metadata
    const contextFileReferences = summaryMessage.metadata?.contextFileReferences;

    // Early exit if no references
    if (!contextFileReferences || contextFileReferences.length === 0) {
      return null;
    }

    // Calculate 15% budget from remaining tokens
    const remainingTokens = this.tokenManager.getRemainingTokens();
    const budget = Math.floor(remainingTokens * 0.15);

    // Early exit if insufficient budget
    if (budget <= 0) {
      return null;
    }

    // Files are already prioritized (edited > written > read) by AgentCompactor.extractFileReferences()
    // No need to re-prioritize here

    // Load files until budget exhausted
    const loadedFiles: Array<{ path: string; content: string; lineCount: number; truncated: boolean }> = [];
    let usedTokens = 0;

    for (const filePath of contextFileReferences) {
      // Try to load the file
      const fileData = await this.loadFile(filePath);
      if (!fileData) {
        // Skip unreadable files
        continue;
      }

      // Format the file content section
      const formattedSection = this.formatFileSection(
        filePath,
        fileData.content,
        fileData.lineCount,
        fileData.truncated
      );

      // Estimate tokens for this section
      const sectionTokens = this.tokenManager.estimateTokens(formattedSection);

      // Check if adding this file would exceed budget
      if (usedTokens + sectionTokens > budget) {
        // Budget exhausted - stop loading more files
        break;
      }

      // Add to loaded files
      loadedFiles.push({
        path: filePath,
        content: fileData.content,
        lineCount: fileData.lineCount,
        truncated: fileData.truncated,
      });
      usedTokens += sectionTokens;
    }

    // Return null if no files were loaded
    if (loadedFiles.length === 0) {
      return null;
    }

    // Build final formatted output
    return this.formatOutput(loadedFiles);
  }

  /**
   * Load file content from disk
   *
   * Reads first 100 lines of a file. Returns null if file is unreadable.
   *
   * @param filePath Absolute path to file
   * @returns File data with content and metadata, or null if unreadable
   */
  private async loadFile(
    filePath: string
  ): Promise<{ content: string; lineCount: number; truncated: boolean } | null> {
    try {
      // Read file content (will throw if file doesn't exist or isn't readable)
      const fullContent = await readFile(filePath, 'utf-8');

      // Split into lines
      const lines = fullContent.split('\n');
      const totalLines = lines.length;

      // Limit to first 100 lines
      const truncated = totalLines > 100;
      const limitedLines = truncated ? lines.slice(0, 100) : lines;
      const content = limitedLines.join('\n');

      return {
        content,
        lineCount: totalLines,
        truncated,
      };
    } catch {
      // File is unreadable or doesn't exist - return null
      return null;
    }
  }

  /**
   * Format a single file section as markdown
   *
   * @param filePath File path for header
   * @param content File content
   * @param totalLines Total line count
   * @param truncated Whether file was truncated
   * @returns Formatted markdown section
   */
  private formatFileSection(
    filePath: string,
    content: string,
    totalLines: number,
    truncated: boolean
  ): string {
    const language = getLanguageFromExtension(filePath);
    const header = truncated
      ? `### ${filePath} (first 100 of ${totalLines} lines)`
      : `### ${filePath}`;

    return `${header}\n\`\`\`${language}\n${content}\n\`\`\`\n`;
  }

  /**
   * Format the complete output with all loaded files
   *
   * @param files Array of loaded file data
   * @returns Complete formatted output
   */
  private formatOutput(
    files: Array<{ path: string; content: string; lineCount: number; truncated: boolean }>
  ): string {
    const sections = files.map(file =>
      this.formatFileSection(file.path, file.content, file.lineCount, file.truncated)
    );

    return `## Context Files (from compacted conversation)\n\n${sections.join('\n')}`;
  }
}
