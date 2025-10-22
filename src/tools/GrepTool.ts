/**
 * GrepTool - Search file contents using regex patterns
 *
 * Provides powerful pattern-based search across files with filtering,
 * context lines, and line numbering.
 */

import { BaseTool } from './BaseTool.js';
import { ToolResult, FunctionDefinition } from '../types/index.js';
import { ActivityStream } from '../services/ActivityStream.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import fg from 'fast-glob';

interface GrepMatch {
  file: string;
  line: number;
  content: string;
  before?: string[];
  after?: string[];
}

export class GrepTool extends BaseTool {
  readonly name = 'grep';
  readonly description =
    'Search for patterns in files using regex. Supports file type filtering, context lines, and case-insensitive search. Use for finding code patterns, text search across files, or regex matching.';
  readonly requiresConfirmation = false; // Read-only operation

  private static readonly MAX_RESULTS = 100;
  private static readonly MAX_FILE_SIZE = 1024 * 1024; // 1MB
  private static readonly MAX_CONTEXT_LINES = 10;

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
            pattern: {
              type: 'string',
              description: 'Regex pattern to search for',
            },
            path: {
              type: 'string',
              description: 'File or directory path to search (default: current directory)',
            },
            file_pattern: {
              type: 'string',
              description: 'Glob pattern to filter files (e.g., "*.ts", "**/*.js")',
            },
            case_insensitive: {
              type: 'boolean',
              description: 'Perform case-insensitive search (default: false)',
            },
            context_lines: {
              type: 'integer',
              description: 'Number of context lines to show before and after matches (default: 0, max: 10)',
            },
            max_results: {
              type: 'integer',
              description: `Maximum number of results to return (default: ${GrepTool.MAX_RESULTS})`,
            },
          },
          required: ['pattern'],
        },
      },
    };
  }

  protected async executeImpl(args: any): Promise<ToolResult> {
    // Capture parameters
    this.captureParams(args);

    // Extract and validate parameters
    const pattern = args.pattern as string;
    const searchPath = (args.path as string) || '.';
    const filePattern = (args.file_pattern as string) || '*';
    const caseInsensitive = Boolean(args.case_insensitive);
    const contextLines = Math.min(
      Math.max(0, Number(args.context_lines) || 0),
      GrepTool.MAX_CONTEXT_LINES
    );
    const maxResults = Math.min(
      Number(args.max_results) || GrepTool.MAX_RESULTS,
      GrepTool.MAX_RESULTS
    );

    if (!pattern) {
      return this.formatErrorResponse(
        'pattern parameter is required',
        'validation_error',
        'Example: grep(pattern="class.*Test", path="src/")'
      );
    }

    // Compile regex
    let regex: RegExp;
    try {
      const flags = caseInsensitive ? 'i' : '';
      regex = new RegExp(pattern, flags);
    } catch (error) {
      return this.formatErrorResponse(
        `Invalid regex pattern: ${error instanceof Error ? error.message : String(error)}`,
        'validation_error',
        'Use simpler patterns or escape special characters'
      );
    }

    try {
      // Resolve search path
      const absolutePath = path.isAbsolute(searchPath)
        ? searchPath
        : path.join(process.cwd(), searchPath);

      // Check if path exists
      try {
        await fs.access(absolutePath);
      } catch {
        return this.formatErrorResponse(
          `Path not found: ${searchPath}`,
          'validation_error'
        );
      }

      // Determine if searching a single file or directory
      const stats = await fs.stat(absolutePath);
      let filesToSearch: string[];

      if (stats.isFile()) {
        filesToSearch = [absolutePath];
      } else if (stats.isDirectory()) {
        // Use fast-glob to find matching files
        const globPattern = path.join(absolutePath, '**', filePattern);
        filesToSearch = await fg(globPattern, {
          dot: false,
          onlyFiles: true,
          ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**'],
        });
      } else {
        return this.formatErrorResponse(
          `Not a file or directory: ${searchPath}`,
          'validation_error'
        );
      }

      // Search files
      const matches: GrepMatch[] = [];
      let filesSearched = 0;

      for (const filePath of filesToSearch) {
        if (matches.length >= maxResults) {
          break;
        }

        try {
          // Check file size
          const fileStats = await fs.stat(filePath);
          if (fileStats.size > GrepTool.MAX_FILE_SIZE) {
            continue; // Skip large files
          }

          // Read file
          const content = await fs.readFile(filePath, { encoding: 'utf-8' });

          // Check for binary content
          if (this.isBinary(content)) {
            continue;
          }

          filesSearched++;

          // Search line by line
          const lines = content.split('\n');
          const fileMatches = this.searchLines(
            lines,
            regex,
            filePath,
            contextLines,
            maxResults - matches.length
          );

          matches.push(...fileMatches);
        } catch {
          // Skip files that can't be read
          continue;
        }
      }

      // Format results
      const limitedResults = matches.length > maxResults;
      const matchesToReturn = matches.slice(0, maxResults);

      // Format as human-readable content
      const contentLines: string[] = [];
      for (const match of matchesToReturn) {
        contentLines.push(`${match.file}:${match.line}:${match.content}`);
        if (match.before && match.before.length > 0) {
          for (const line of match.before) {
            contentLines.push(`  ${line}`);
          }
        }
        if (match.after && match.after.length > 0) {
          for (const line of match.after) {
            contentLines.push(`  ${line}`);
          }
        }
      }

      const content = contentLines.join('\n');

      return this.formatSuccessResponse({
        content, // Human-readable output for LLM
        matches: matchesToReturn, // Structured data
        total_matches: matches.length,
        files_searched: filesSearched,
        limited_results: limitedResults,
      });
    } catch (error) {
      return this.formatErrorResponse(
        `Error searching files: ${error instanceof Error ? error.message : String(error)}`,
        'system_error'
      );
    }
  }

  /**
   * Search lines for pattern matches
   */
  private searchLines(
    lines: string[],
    regex: RegExp,
    filePath: string,
    contextLines: number,
    maxMatches: number
  ): GrepMatch[] {
    const matches: GrepMatch[] = [];

    for (let i = 0; i < lines.length && matches.length < maxMatches; i++) {
      const line = lines[i];
      if (line !== undefined && regex.test(line)) {
        const match: GrepMatch = {
          file: filePath,
          line: i + 1,
          content: line,
        };

        // Add context lines if requested
        if (contextLines > 0) {
          const beforeStart = Math.max(0, i - contextLines);
          match.before = lines.slice(beforeStart, i);

          const afterEnd = Math.min(lines.length, i + contextLines + 1);
          match.after = lines.slice(i + 1, afterEnd);
        }

        matches.push(match);
      }
    }

    return matches;
  }

  /**
   * Check if content appears to be binary
   */
  private isBinary(content: string): boolean {
    const sample = content.substring(0, 1024);
    return sample.includes('\0');
  }

  /**
   * Custom result preview
   */
  /**
   * Get truncation guidance for grep output
   */
  getTruncationGuidance(): string {
    return 'Refine your search pattern or use the glob parameter to filter files';
  }

  /**
   * Get estimated output size for grep operations
   */
  getEstimatedOutputSize(): number {
    return 600; // Grep typically produces moderate to large output (search results)
  }

  getResultPreview(result: ToolResult, maxLines: number = 3): string[] {
    if (!result.success) {
      return super.getResultPreview(result, maxLines);
    }

    const matches = result.matches as GrepMatch[] | undefined;
    const totalMatches = result.total_matches ?? 0;
    const filesSearched = result.files_searched ?? 0;

    const lines: string[] = [];
    lines.push(`Found ${totalMatches} match(es) in ${filesSearched} file(s)`);

    if (matches && matches.length > 0) {
      const previewCount = Math.min(matches.length, maxLines - 1);
      for (let i = 0; i < previewCount; i++) {
        const match = matches[i];
        if (match) {
          const relativePath = path.relative(process.cwd(), match.file);
          lines.push(`${relativePath}:${match.line}: ${match.content.trim()}`);
        }
      }

      if (matches.length > previewCount) {
        lines.push('...');
      }
    }

    return lines;
  }
}
