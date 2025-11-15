/**
 * LsTool - List directory contents
 *
 * Provides detailed directory listing with file type indicators,
 * sizes, and sorting options.
 */

import { BaseTool } from './BaseTool.js';
import { ToolResult, FunctionDefinition } from '../types/index.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { resolvePath } from '../utils/pathUtils.js';
import { validateIsDirectory } from '../utils/pathValidator.js';
import { TOOL_LIMITS, TOOL_OUTPUT_ESTIMATES } from '../config/toolDefaults.js';
import { FORMATTING } from '../config/constants.js';
import { formatError } from '../utils/errorUtils.js';
import * as fs from 'fs/promises';
import * as path from 'path';

interface FileEntry {
  name: string;
  path: string;
  type: 'file' | 'directory' | 'symlink';
  size?: number;
  modified?: number;
  permissions?: string;
  isExecutable?: boolean;
}

export class LsTool extends BaseTool {
  readonly name = 'ls';
  readonly displayName = 'List';
  readonly description =
    'List files and directories with sizes, types, and modification times';
  readonly requiresConfirmation = false; // Read-only operation

  constructor(activityStream: ActivityStream) {
    super(activityStream);
  }

  /**
   * Provide custom function definition
   */
  getFunctionDefinition(): FunctionDefinition {
    return {
      type: 'function',
      function: {
        name: this.name,
        description: this.description,
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Directory path to list (default: current directory)',
            },
            type: {
              type: 'string',
              description: 'Filter by type: "files", "dirs", "all" (default: all)',
            },
            extensions: {
              type: 'array',
              items: { type: 'string' },
              description: 'Filter by file extensions (e.g., ["ts", "tsx", "js"])',
            },
            all: {
              type: 'boolean',
              description: 'Include hidden files (starting with .)',
            },
            long: {
              type: 'boolean',
              description: 'Show detailed information (size, permissions, modified time)',
            },
            sort_by: {
              type: 'string',
              description: 'Sort by: "name", "size", "time" (default: name)',
            },
          },
        },
      },
    };
  }

  protected async executeImpl(args: any): Promise<ToolResult> {
    // Capture parameters
    this.captureParams(args);

    // Extract and validate parameters
    const dirPath = (args.path as string) || '.';
    const typeFilter = (args.type as string) || 'all';
    const extensions = (args.extensions as string[]) || [];
    const showAll = Boolean(args.all);
    const longFormat = Boolean(args.long);
    const sortBy = (args.sort_by as string) || 'name';

    // Validate type parameter
    if (!['files', 'dirs', 'all'].includes(typeFilter)) {
      return this.formatErrorResponse(
        `Invalid type value: ${typeFilter}`,
        'validation_error',
        'Valid values are: "files", "dirs", "all"'
      );
    }

    // Validate sort_by parameter
    if (!['name', 'size', 'time'].includes(sortBy)) {
      return this.formatErrorResponse(
        `Invalid sort_by value: ${sortBy}`,
        'validation_error',
        'Valid values are: "name", "size", "time"'
      );
    }

    try {
      // Resolve path
      const absolutePath = resolvePath(dirPath);

      // Validate that it's a directory
      const validation = await validateIsDirectory(absolutePath);
      if (!validation.valid) {
        return this.formatErrorResponse(
          validation.error!,
          'validation_error',
          'ls requires a directory path'
        );
      }

      // Read directory contents
      let entries: string[];
      try {
        entries = await fs.readdir(absolutePath);
      } catch (error) {
        return this.formatErrorResponse(
          `Permission denied: Cannot read directory ${dirPath}`,
          'permission_error'
        );
      }

      // Filter hidden files if not showing all
      if (!showAll) {
        entries = entries.filter((entry) => !entry.startsWith('.'));
      }

      // Get detailed information for each entry
      const fileEntries: FileEntry[] = [];
      for (const entry of entries) {
        const entryPath = path.join(absolutePath, entry);

        try {
          const entryStats = await fs.lstat(entryPath); // Use lstat to detect symlinks

          let type: 'file' | 'directory' | 'symlink';
          if (entryStats.isSymbolicLink()) {
            type = 'symlink';
          } else if (entryStats.isDirectory()) {
            type = 'directory';
          } else {
            type = 'file';
          }

          const fileEntry: FileEntry = {
            name: entry,
            path: entryPath,
            type,
          };

          if (longFormat) {
            fileEntry.size = type === 'file' ? entryStats.size : undefined;
            fileEntry.modified = entryStats.mtimeMs;
            fileEntry.permissions = this.formatPermissions(entryStats.mode);
            fileEntry.isExecutable = this.isExecutable(entryStats.mode);
          }

          fileEntries.push(fileEntry);
        } catch {
          // Skip entries we can't stat
          continue;
        }
      }

      // Apply type filter
      let filteredEntries = fileEntries;
      if (typeFilter === 'files') {
        filteredEntries = fileEntries.filter(e => e.type === 'file');
      } else if (typeFilter === 'dirs') {
        filteredEntries = fileEntries.filter(e => e.type === 'directory');
      }

      // Apply extensions filter
      if (extensions.length > 0) {
        filteredEntries = filteredEntries.filter(entry => {
          if (entry.type !== 'file') return false;
          const ext = path.extname(entry.name).slice(1); // Remove leading dot
          return extensions.includes(ext);
        });
      }

      // Sort entries
      this.sortEntries(filteredEntries, sortBy);

      // Apply limit
      const totalCount = filteredEntries.length;
      const truncated = totalCount > TOOL_LIMITS.MAX_DIRECTORY_ENTRIES;
      const results = filteredEntries.slice(0, TOOL_LIMITS.MAX_DIRECTORY_ENTRIES);

      // Format as human-readable content
      const contentLines: string[] = [];
      for (const entry of results) {
        const typeIndicator =
          entry.type === 'directory' ? '/' : entry.type === 'symlink' ? '@' : '';
        if (longFormat) {
          const size =
            entry.size !== undefined
              ? `${entry.size}B`.padStart(FORMATTING.LS_COLUMN_WIDTH)
              : ''.padStart(FORMATTING.LS_COLUMN_WIDTH);
          const perms = entry.permissions || ''.padStart(FORMATTING.LS_COLUMN_WIDTH);
          contentLines.push(`${perms} ${size} ${entry.name}${typeIndicator}`);
        } else {
          contentLines.push(`${entry.name}${typeIndicator}`);
        }
      }

      const content = contentLines.join('\n');

      return this.formatSuccessResponse({
        content, // Human-readable output for LLM
        entries: results, // Structured data
        total_count: totalCount,
        shown_count: results.length,
        directory_path: absolutePath,
        truncated,
      });
    } catch (error) {
      return this.formatErrorResponse(
        `Error listing directory: ${formatError(error)}`,
        'system_error'
      );
    }
  }

  /**
   * Sort file entries
   */
  private sortEntries(entries: FileEntry[], sortBy: string): void {
    entries.sort((a, b) => {
      // Always sort directories before files
      if (a.type === 'directory' && b.type !== 'directory') return -1;
      if (a.type !== 'directory' && b.type === 'directory') return 1;

      // Then sort by requested criterion
      switch (sortBy) {
        case 'size':
          return (b.size ?? 0) - (a.size ?? 0);
        case 'time':
          return (b.modified ?? 0) - (a.modified ?? 0);
        case 'name':
        default:
          return a.name.localeCompare(b.name);
      }
    });
  }

  /**
   * Format Unix permissions as a string
   */
  private formatPermissions(mode: number): string {
    // Extract permission bits (rwxrwxrwx) using 0o777 mask
    const octal = (mode & 0o777)
      .toString(8)
      .padStart(FORMATTING.OCTAL_PERMISSION_WIDTH, '0');
    return octal;
  }

  /**
   * Check if file is executable
   */
  private isExecutable(mode: number): boolean {
    // Check if owner, group, or others have execute permission
    return (mode & 0o111) !== 0;
  }


  /**
   * Get truncation guidance for ls output
   */
  getTruncationGuidance(): string {
    return 'Use a more specific path or add filters to the command';
  }

  /**
   * Get estimated output size for ls operations
   */
  getEstimatedOutputSize(): number {
    return TOOL_OUTPUT_ESTIMATES.LS;
  }

  /**
   * Custom result preview
   */
  getResultPreview(result: ToolResult, maxLines: number = 3): string[] {
    if (!result.success) {
      return super.getResultPreview(result, maxLines);
    }

    const entries = result.entries as FileEntry[] | undefined;
    const totalCount = result.total_count ?? 0;
    const truncated = result.truncated ?? false;

    if (!entries || entries.length === 0) {
      return ['Directory is empty'];
    }

    const lines: string[] = [];
    if (truncated) {
      lines.push(`Found ${totalCount} items (showing first ${result.shown_count})`);
    } else {
      lines.push(`Found ${totalCount} item(s)`);
    }

    const previewCount = Math.min(entries.length, maxLines - 1);
    for (let i = 0; i < previewCount; i++) {
      const entry = entries[i];
      if (entry) {
        const typeIndicator =
          entry.type === 'directory' ? '/' : entry.type === 'symlink' ? '@' : '';
        lines.push(`${entry.name}${typeIndicator}`);
      }
    }

    if (entries.length > previewCount) {
      lines.push('...');
    }

    return lines;
  }
}
