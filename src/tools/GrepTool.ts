/**
 * GrepTool - Search file contents using regex patterns
 *
 * Provides powerful pattern-based search across files with filtering,
 * context lines, and line numbering.
 */

import { BaseTool } from './BaseTool.js';
import { ToolResult, FunctionDefinition } from '../types/index.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { resolvePath } from '../utils/pathUtils.js';
import { validateExists } from '../utils/pathValidator.js';
import { isBinaryContent } from '../utils/fileUtils.js';
import { formatError } from '../utils/errorUtils.js';
import { TOOL_LIMITS } from '../config/toolDefaults.js';
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
    'Search files for text patterns. Use for finding code patterns, text search across files, regex matching';
  readonly requiresConfirmation = false; // Read-only operation

  private static readonly MAX_RESULTS = TOOL_LIMITS.MAX_SEARCH_RESULTS;
  private static readonly MAX_FILE_SIZE = TOOL_LIMITS.MAX_FILE_SIZE;
  private static readonly MAX_CONTEXT_LINES = TOOL_LIMITS.MAX_CONTEXT_LINES;

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
            glob: {
              type: 'string',
              description: 'Glob pattern to filter files (e.g., "*.ts", "**/*.js")',
            },
            file_type: {
              type: 'string',
              description: 'File type shortcut: "ts", "js", "py", "all_code" (overrides glob if provided)',
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
    const fileType = args.file_type as string | undefined;
    let filePattern = (args.glob as string) || '*';

    // Apply file_type shortcuts (overrides glob if provided)
    if (fileType) {
      const typeMap: Record<string, string> = {
        ts: '**/*.{ts,tsx}',
        js: '**/*.{js,jsx}',
        py: '**/*.py',
        all_code: '**/*.{ts,tsx,js,jsx,py,go,java,c,cpp,rs,rb}',
      };
      filePattern = typeMap[fileType] || filePattern;
    }

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
        `Invalid regex pattern: ${formatError(error)}`,
        'validation_error',
        'Use simpler patterns or escape special characters'
      );
    }

    try {
      // Resolve search path
      const absolutePath = resolvePath(searchPath);

      // Check if path exists
      const validation = await validateExists(absolutePath);
      if (!validation.valid) {
        return this.formatErrorResponse(
          validation.error!,
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
      let filesSkippedLarge = 0;
      let filesSkippedBinary = 0;
      let filesSkippedError = 0;

      for (const filePath of filesToSearch) {
        if (matches.length >= maxResults) {
          break;
        }

        try {
          // Check file size
          const fileStats = await fs.stat(filePath);
          if (fileStats.size > GrepTool.MAX_FILE_SIZE) {
            filesSkippedLarge++;
            continue;
          }

          // Read file
          const content = await fs.readFile(filePath, { encoding: 'utf-8' });

          // Check for binary content
          if (isBinaryContent(content)) {
            filesSkippedBinary++;
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
          filesSkippedError++;
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

      const totalSkipped = filesSkippedLarge + filesSkippedBinary + filesSkippedError;

      // Group matches by file for easier LLM navigation
      const matchesByFile: Record<string, number> = {};
      for (const match of matches) {
        matchesByFile[match.file] = (matchesByFile[match.file] || 0) + 1;
      }

      return this.formatSuccessResponse({
        content, // Human-readable output for LLM
        matches: matchesToReturn, // Structured data
        matches_by_file: matchesByFile, // File -> count mapping
        total_matches: matches.length,
        files_searched: filesSearched,
        files_skipped: totalSkipped,
        files_skipped_large: filesSkippedLarge,
        files_skipped_binary: filesSkippedBinary,
        files_skipped_error: filesSkippedError,
        limited_results: limitedResults,
      });
    } catch (error) {
      return this.formatErrorResponse(
        `Error searching files: ${formatError(error)}`,
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
    const filesSkipped = result.files_skipped ?? 0;

    const lines: string[] = [];

    // Main summary line
    let summary = `Found ${totalMatches} match(es) in ${filesSearched} file(s)`;
    if (filesSkipped > 0) {
      summary += `, ${filesSkipped} skipped`;
    }
    lines.push(summary);

    // Show breakdown of skipped files if any
    if (filesSkipped > 0) {
      const skippedDetails: string[] = [];
      if (result.files_skipped_large) skippedDetails.push(`${result.files_skipped_large} too large`);
      if (result.files_skipped_binary) skippedDetails.push(`${result.files_skipped_binary} binary`);
      if (result.files_skipped_error) skippedDetails.push(`${result.files_skipped_error} unreadable`);
      if (skippedDetails.length > 0) {
        lines.push(`  Skipped: ${skippedDetails.join(', ')}`);
      }
    }

    if (matches && matches.length > 0) {
      const previewCount = Math.min(matches.length, maxLines - lines.length);
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
