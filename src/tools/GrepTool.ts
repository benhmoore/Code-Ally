/**
 * GrepTool - Search file contents using regex patterns
 *
 * Provides powerful pattern-based search across files with filtering,
 * context lines, line numbering, and multiple output modes.
 */

import { BaseTool } from './BaseTool.js';
import { ToolResult, FunctionDefinition } from '../types/index.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { ServiceRegistry } from '../services/ServiceRegistry.js';
import { FocusManager } from '../services/FocusManager.js';
import { resolvePath } from '../utils/pathUtils.js';
import { validateExists } from '../utils/pathValidator.js';
import { isBinaryContent } from '../utils/fileUtils.js';
import { formatError } from '../utils/errorUtils.js';
import { TOOL_LIMITS, TOOL_OUTPUT_ESTIMATES } from '../config/toolDefaults.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import fg from 'fast-glob';

type OutputMode = 'files_with_matches' | 'content' | 'count';

interface GrepMatch {
  file: string;
  line: number;
  content: string;
  before?: string[];
  after?: string[];
}

interface FileCount {
  file: string;
  count: number;
}

export class GrepTool extends BaseTool {
  readonly name = 'grep';
  readonly description =
    'Search files for text patterns with multiple output modes. Use for finding code patterns, text search across files, regex matching. Supports files_with_matches (default), content (with context), and count modes. Supports multiline regex patterns.';
  readonly requiresConfirmation = false; // Read-only operation
  readonly usageGuidance = `**When to use grep:**
Locate patterns across files or inspect matching lines with regex.
Set output_mode="files_with_matches" for file lists (default), "content" for snippets with context, "count" for per-file totals.

WARNING: Multi-step investigations (grep → read → grep → read) rapidly fill your context, significantly reducing remaining tool calls and forcing premature conversation restart. For exploratory work with unknown scope, use explore() instead to preserve your capacity.`;

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
              description: 'Regex pattern to search',
            },
            path: {
              type: 'string',
              description: 'File or directory to search (default: cwd)',
            },
            glob: {
              type: 'string',
              description: 'Glob pattern to filter files (e.g. "*.js")',
            },
            type: {
              type: 'string',
              description: 'File type: js|py|rust|go|java|ts|tsx',
            },
            '-i': {
              type: 'boolean',
              description: 'Case insensitive search',
            },
            output_mode: {
              type: 'string',
              description: 'Output: content|files_with_matches (default)|count',
            },
            '-A': {
              type: 'number',
              description: 'Lines after match (content mode only)',
            },
            '-B': {
              type: 'number',
              description: 'Lines before match (content mode only)',
            },
            '-C': {
              type: 'number',
              description: 'Lines before+after match (content mode only)',
            },
            multiline: {
              type: 'boolean',
              description: 'Enable multiline mode where . matches newlines',
            },
            max_results: {
              type: 'integer',
              description: `Max results (default: ${GrepTool.MAX_RESULTS})`,
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

    const fileType = args.type as string | undefined;
    let filePattern = (args.glob as string) || '*';

    // Apply file type shortcuts (overrides glob if provided)
    if (fileType) {
      const typeMap: Record<string, string> = {
        ts: '**/*.{ts,tsx}',
        tsx: '**/*.tsx',
        js: '**/*.{js,jsx}',
        jsx: '**/*.jsx',
        py: '**/*.py',
        rust: '**/*.rs',
        go: '**/*.go',
        java: '**/*.java',
        c: '**/*.{c,h}',
        cpp: '**/*.{cpp,hpp,cc,cxx}',
        all_code: '**/*.{ts,tsx,js,jsx,py,go,java,c,cpp,rs,rb}',
      };
      filePattern = typeMap[fileType] || filePattern;
    }

    const caseInsensitive = Boolean(args['-i']);

    const linesAfter = Math.min(
      Math.max(0, Number(args['-A']) || 0),
      GrepTool.MAX_CONTEXT_LINES
    );
    const linesBefore = Math.min(
      Math.max(0, Number(args['-B']) || 0),
      GrepTool.MAX_CONTEXT_LINES
    );
    const linesContext = Math.min(
      Math.max(0, Number(args['-C']) || 0),
      GrepTool.MAX_CONTEXT_LINES
    );

    // If -C is provided, it overrides -A and -B
    const contextAfter = linesContext > 0 ? linesContext : linesAfter;
    const contextBefore = linesContext > 0 ? linesContext : linesBefore;

    const multiline = Boolean(args.multiline);
    const outputMode = (args.output_mode as OutputMode) || 'files_with_matches';

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
      let flags = caseInsensitive ? 'gi' : 'g';
      if (multiline) {
        flags += 's'; // 's' flag makes '.' match newlines
      }
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

      // Validate focus constraint if active
      const registry = ServiceRegistry.getInstance();
      const focusManager = registry.get<FocusManager>('focus_manager');

      if (focusManager && focusManager.isFocused()) {
        const validation = await focusManager.validatePathInFocus(absolutePath);
        if (!validation.success) {
          return this.formatErrorResponse(
            validation.message,
            'permission_error'
          );
        }
      }

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

      // Search files (parallel with concurrency limit)
      const READ_CONCURRENCY = 10; // Optimal concurrency for file reading
      const matches: GrepMatch[] = [];
      const filesWithMatches = new Set<string>();
      const fileCounts = new Map<string, number>();
      let filesSearched = 0;
      let filesSkippedLarge = 0;
      let filesSkippedBinary = 0;
      let filesSkippedError = 0;

      // Process files in batches to limit concurrency
      for (let i = 0; i < filesToSearch.length; i += READ_CONCURRENCY) {
        // For files_with_matches mode, stop when we have enough unique files
        if (outputMode === 'files_with_matches' && filesWithMatches.size >= maxResults) {
          break;
        }
        // For content mode, stop when we have enough matches
        if (outputMode === 'content' && matches.length >= maxResults) {
          break;
        }

        const batch = filesToSearch.slice(i, i + READ_CONCURRENCY);
        const results = await Promise.allSettled(
          batch.map(async (filePath) => {
            // Check file size
            const fileStats = await fs.stat(filePath);
            if (fileStats.size > GrepTool.MAX_FILE_SIZE) {
              return { type: 'skipped_large' as const, filePath };
            }

            // Read file
            const content = await fs.readFile(filePath, { encoding: 'utf-8' });

            // Check for binary content
            if (isBinaryContent(content)) {
              return { type: 'skipped_binary' as const, filePath };
            }

            return { type: 'success' as const, filePath, content };
          })
        );

        // Process results from this batch
        for (const result of results) {
          if (result.status === 'rejected') {
            filesSkippedError++;
            continue;
          }

          const value = result.value;
          if (value.type === 'skipped_large') {
            filesSkippedLarge++;
            continue;
          }
          if (value.type === 'skipped_binary') {
            filesSkippedBinary++;
            continue;
          }

          // Success - process file content
          filesSearched++;
          const { filePath, content } = value;

          // Search based on mode
          if (multiline) {
            // For multiline mode, search entire content at once
            const fileMatches = this.searchMultiline(
              content,
              regex,
              filePath,
              contextBefore,
              contextAfter,
              outputMode === 'content' ? maxResults - matches.length : Number.MAX_SAFE_INTEGER
            );

            if (fileMatches.length > 0) {
              filesWithMatches.add(filePath);
              fileCounts.set(filePath, fileMatches.length);
              if (outputMode === 'content') {
                matches.push(...fileMatches);
              }
            }
          } else {
            // Search line by line
            const lines = content.split('\n');
            const fileMatches = this.searchLines(
              lines,
              regex,
              filePath,
              contextBefore,
              contextAfter,
              outputMode === 'content' ? maxResults - matches.length : Number.MAX_SAFE_INTEGER
            );

            if (fileMatches.length > 0) {
              filesWithMatches.add(filePath);
              fileCounts.set(filePath, fileMatches.length);
              if (outputMode === 'content') {
                matches.push(...fileMatches);
              }
            }
          }
        }
      }

      // Format results based on output mode
      const totalSkipped = filesSkippedLarge + filesSkippedBinary + filesSkippedError;
      let content = '';
      let responseData: any = {
        output_mode: outputMode,
        files_searched: filesSearched,
        files_skipped: totalSkipped,
        files_skipped_large: filesSkippedLarge,
        files_skipped_binary: filesSkippedBinary,
        files_skipped_error: filesSkippedError,
      };

      if (outputMode === 'files_with_matches') {
        // Only return unique file paths
        const fileList = Array.from(filesWithMatches).slice(0, maxResults);
        content = fileList.join('\n');
        responseData.files = fileList;
        responseData.total_files = fileList.length;
        responseData.limited_results = filesWithMatches.size > maxResults;
      } else if (outputMode === 'count') {
        // Return files with their match counts
        const countList: FileCount[] = Array.from(fileCounts.entries())
          .map(([file, count]) => ({ file, count }))
          .slice(0, maxResults);

        const contentLines = countList.map((fc) => `${fc.count}:${fc.file}`);
        content = contentLines.join('\n');
        responseData.file_counts = countList;
        responseData.total_files = countList.length;
        responseData.total_matches = Array.from(fileCounts.values()).reduce((a, b) => a + b, 0);
        responseData.limited_results = fileCounts.size > maxResults;
      } else {
        // content mode - show matching lines with context
        const limitedResults = matches.length > maxResults;
        const matchesToReturn = matches.slice(0, maxResults);

        const contentLines: string[] = [];
        for (const match of matchesToReturn) {
          // Add context before
          if (match.before && match.before.length > 0) {
            for (let i = 0; i < match.before.length; i++) {
              const lineNum = match.line - match.before.length + i;
              contentLines.push(`${match.file}:${lineNum}:${match.before[i]}`);
            }
          }
          // Add matching line
          contentLines.push(`${match.file}:${match.line}:${match.content}`);
          // Add context after
          if (match.after && match.after.length > 0) {
            for (let i = 0; i < match.after.length; i++) {
              const lineNum = match.line + i + 1;
              contentLines.push(`${match.file}:${lineNum}:${match.after[i]}`);
            }
          }
        }

        content = contentLines.join('\n');
        responseData.matches = matchesToReturn;
        responseData.total_matches = matches.length;
        responseData.limited_results = limitedResults;

        // Group matches by file for easier LLM navigation
        const matchesByFile: Record<string, number> = {};
        for (const match of matches) {
          matchesByFile[match.file] = (matchesByFile[match.file] || 0) + 1;
        }
        responseData.matches_by_file = matchesByFile;
      }

      responseData.content = content;

      return this.formatSuccessResponse(responseData);
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
    contextBefore: number,
    contextAfter: number,
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
        if (contextBefore > 0) {
          const beforeStart = Math.max(0, i - contextBefore);
          match.before = lines.slice(beforeStart, i);
        }

        if (contextAfter > 0) {
          const afterEnd = Math.min(lines.length, i + contextAfter + 1);
          match.after = lines.slice(i + 1, afterEnd);
        }

        matches.push(match);
      }
    }

    return matches;
  }

  /**
   * Search content for multiline pattern matches
   */
  private searchMultiline(
    content: string,
    regex: RegExp,
    filePath: string,
    contextBefore: number,
    contextAfter: number,
    maxMatches: number
  ): GrepMatch[] {
    const matches: GrepMatch[] = [];
    const lines = content.split('\n');

    // Find all matches in the content
    let match: RegExpExecArray | null;
    while ((match = regex.exec(content)) !== null && matches.length < maxMatches) {
      // Find which line this match starts on
      const beforeMatch = content.substring(0, match.index);
      const lineNumber = beforeMatch.split('\n').length;

      // Get the matched content (may span multiple lines)
      const matchedText = match[0];

      const grepMatch: GrepMatch = {
        file: filePath,
        line: lineNumber,
        content: matchedText,
      };

      // Add context lines if requested
      if (contextBefore > 0) {
        const beforeStart = Math.max(0, lineNumber - 1 - contextBefore);
        grepMatch.before = lines.slice(beforeStart, lineNumber - 1);
      }

      if (contextAfter > 0) {
        const matchLineCount = matchedText.split('\n').length;
        const afterStart = lineNumber - 1 + matchLineCount;
        const afterEnd = Math.min(lines.length, afterStart + contextAfter);
        grepMatch.after = lines.slice(afterStart, afterEnd);
      }

      matches.push(grepMatch);
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
    return TOOL_OUTPUT_ESTIMATES.GREP;
  }

  getResultPreview(result: ToolResult, maxLines: number = 3): string[] {
    if (!result.success) {
      return super.getResultPreview(result, maxLines);
    }

    const outputMode = result.output_mode as OutputMode;
    const filesSearched = result.files_searched ?? 0;
    const filesSkipped = result.files_skipped ?? 0;

    const lines: string[] = [];

    // Build summary based on output mode
    if (outputMode === 'files_with_matches') {
      const files = result.files as string[] | undefined;
      const totalFiles = result.total_files ?? 0;
      let summary = `Found ${totalFiles} file(s) with matches`;
      if (filesSearched > 0) {
        summary += ` (searched ${filesSearched})`;
      }
      if (filesSkipped > 0) {
        summary += `, ${filesSkipped} skipped`;
      }
      lines.push(summary);

      // Show file list preview
      if (files && files.length > 0) {
        const previewCount = Math.min(files.length, maxLines - lines.length);
        for (let i = 0; i < previewCount; i++) {
          const file = files[i];
          if (file) {
            const relativePath = path.relative(process.cwd(), file);
            lines.push(`  ${relativePath}`);
          }
        }
        if (files.length > previewCount) {
          lines.push('  ...');
        }
      }
    } else if (outputMode === 'count') {
      const fileCounts = result.file_counts as FileCount[] | undefined;
      const totalMatches = result.total_matches ?? 0;
      const totalFiles = result.total_files ?? 0;
      let summary = `Found ${totalMatches} match(es) in ${totalFiles} file(s)`;
      if (filesSkipped > 0) {
        summary += `, ${filesSkipped} skipped`;
      }
      lines.push(summary);

      // Show count preview
      if (fileCounts && fileCounts.length > 0) {
        const previewCount = Math.min(fileCounts.length, maxLines - lines.length);
        for (let i = 0; i < previewCount; i++) {
          const fc = fileCounts[i];
          if (fc) {
            const relativePath = path.relative(process.cwd(), fc.file);
            lines.push(`  ${fc.count}: ${relativePath}`);
          }
        }
        if (fileCounts.length > previewCount) {
          lines.push('  ...');
        }
      }
    } else {
      // content mode
      const matches = result.matches as GrepMatch[] | undefined;
      const totalMatches = result.total_matches ?? 0;
      let summary = `Found ${totalMatches} match(es) in ${filesSearched} file(s)`;
      if (filesSkipped > 0) {
        summary += `, ${filesSkipped} skipped`;
      }
      lines.push(summary);

      // Show match preview
      if (matches && matches.length > 0) {
        const previewCount = Math.min(matches.length, maxLines - lines.length);
        for (let i = 0; i < previewCount; i++) {
          const match = matches[i];
          if (match) {
            const relativePath = path.relative(process.cwd(), match.file);
            lines.push(`  ${relativePath}:${match.line}: ${match.content.trim()}`);
          }
        }
        if (matches.length > previewCount) {
          lines.push('  ...');
        }
      }
    }

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

    return lines;
  }
}
