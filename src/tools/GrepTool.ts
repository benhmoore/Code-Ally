/**
 * GrepTool - Search file contents using regex patterns
 *
 * Provides pattern-based search across files with filtering,
 * context lines, line numbering, and multiple output modes.
 */

import { BaseTool } from './BaseTool.js';
import { ToolResult, FunctionDefinition } from '../types/index.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { ServiceRegistry } from '../services/ServiceRegistry.js';
import { FocusManager } from '../services/FocusManager.js';
import { resolvePath } from '../utils/pathUtils.js';
import { validateExists } from '../utils/pathValidator.js';
import { formatError } from '../utils/errorUtils.js';
import { TOOL_LIMITS, TOOL_OUTPUT_ESTIMATES } from '../config/toolDefaults.js';
import { rgPath } from '@vscode/ripgrep';
import { spawn } from 'child_process';
import * as path from 'path';

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
  readonly displayName = 'Search';
  readonly description =
    'Search files for text patterns using ripgrep. Use for finding code patterns, text search across files, regex matching. Supports files_with_matches (default), content (with context), and count modes. Supports multiline regex patterns.';
  readonly requiresConfirmation = false; // Read-only operation
  readonly isExploratoryTool = true;
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
   * Validate GrepTool arguments
   */
  validateArgs(args: Record<string, unknown>): { valid: boolean; error?: string; error_type?: string; suggestion?: string } | null {
    // Note: Regex pattern validation is deferred to ripgrep execution
    // since JS RegExp and Rust regex have different syntax rules.
    // Invalid patterns will be caught and reported by ripgrep.

    // Validate context line parameters
    const contextParams = ['-A', '-B', '-C'];
    for (const param of contextParams) {
      if (args[param] !== undefined && args[param] !== null) {
        const value = Number(args[param]);
        if (isNaN(value) || value < 0) {
          return {
            valid: false,
            error: `${param} must be a non-negative number`,
            error_type: 'validation_error',
            suggestion: `Example: ${param}=3 (show 3 context lines)`,
          };
        }
        if (value > 20) {
          return {
            valid: false,
            error: `${param} cannot exceed 20 (max context lines)`,
            error_type: 'validation_error',
            suggestion: 'Maximum context is 20 lines',
          };
        }
      }
    }

    return null;
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
              description: 'Regex pattern to search (Rust regex syntax, compatible with most PCRE patterns)',
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
            pcre2: {
              type: 'boolean',
              description: 'Enable PCRE2 engine for backreferences and lookahead/lookbehind',
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
    const filePattern = args.glob as string | undefined;
    const caseInsensitive = Boolean(args['-i']);
    const multiline = Boolean(args.multiline);
    const pcre2 = Boolean(args.pcre2);
    const outputMode = (args.output_mode as OutputMode) || 'files_with_matches';

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

      // Build ripgrep arguments
      const rgArgs: string[] = [
        '--json',
        '--no-ignore', // Don't use gitignore (we control filtering)
        '-e', pattern,
      ];

      // Add case insensitive flag
      if (caseInsensitive) {
        rgArgs.push('-i');
      }

      // Add multiline flags
      if (multiline) {
        rgArgs.push('-U', '--multiline-dotall');
      }

      // Enable PCRE2 for advanced patterns (backreferences, lookahead/lookbehind)
      if (pcre2) {
        rgArgs.push('--pcre2');
      }

      // Add context flags
      if (contextAfter > 0) {
        rgArgs.push('-A', contextAfter.toString());
      }
      if (contextBefore > 0) {
        rgArgs.push('-B', contextBefore.toString());
      }

      // Add glob pattern if provided
      if (filePattern) {
        rgArgs.push('-g', filePattern);
      }

      // Add type filter if provided (ripgrep has built-in types)
      if (fileType) {
        rgArgs.push('-t', fileType);
      }

      // Add standard exclusions
      rgArgs.push('--glob', '!node_modules/**');
      rgArgs.push('--glob', '!.git/**');
      rgArgs.push('--glob', '!dist/**');
      rgArgs.push('--glob', '!build/**');

      // Limit file size
      rgArgs.push('--max-filesize', `${GrepTool.MAX_FILE_SIZE}`);

      // Add search path
      rgArgs.push(absolutePath);

      // Spawn ripgrep process
      const rgResult = await this.executeRipgrep(rgArgs);

      // Parse JSON output
      const rawMatches = this.parseRipgrepJson(rgResult.stdout);

      // Apply focus manager filtering if active
      let filteredMatches = rawMatches;
      if (focusManager && focusManager.isFocused()) {
        filteredMatches = [];
        for (const match of rawMatches) {
          const validation = await focusManager.validatePathInFocus(match.file);
          if (validation.success) {
            filteredMatches.push(match);
          }
        }
      }

      // Apply max_results limit globally
      const matches = filteredMatches.slice(0, maxResults);

      // Count statistics
      const filesWithMatches = new Set<string>();
      const fileCounts = new Map<string, number>();

      for (const match of matches) {
        filesWithMatches.add(match.file);
        fileCounts.set(match.file, (fileCounts.get(match.file) || 0) + 1);
      }

      // Format results based on output mode
      let content = '';
      let responseData: any = {
        output_mode: outputMode,
        files_searched: filesWithMatches.size,
        files_skipped: 0,
        files_skipped_large: 0,
        files_skipped_binary: 0,
        files_skipped_error: 0,
      };

      if (outputMode === 'files_with_matches') {
        const fileList = Array.from(filesWithMatches);
        content = fileList.join('\n');
        responseData.files = fileList;
        responseData.total_files = fileList.length;
        responseData.limited_results = filteredMatches.length > maxResults;
      } else if (outputMode === 'count') {
        const countList: FileCount[] = Array.from(fileCounts.entries())
          .map(([file, count]) => ({ file, count }));

        const contentLines = countList.map((fc) => `${fc.count}:${fc.file}`);
        content = contentLines.join('\n');
        responseData.file_counts = countList;
        responseData.total_files = countList.length;
        responseData.total_matches = Array.from(fileCounts.values()).reduce((a, b) => a + b, 0);
        responseData.limited_results = filteredMatches.length > maxResults;
      } else {
        // content mode - show matching lines with context
        const contentLines: string[] = [];
        for (const match of matches) {
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
        responseData.matches = matches;
        responseData.total_matches = matches.length;
        responseData.limited_results = filteredMatches.length > maxResults;

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
      const errorMsg = formatError(error);

      // Check if it's a regex parse error from ripgrep
      if (errorMsg.includes('regex parse error') || errorMsg.includes('error: unclosed')) {
        return this.formatErrorResponse(
          `Invalid regex pattern: ${errorMsg}`,
          'validation_error',
          'Use simpler patterns or escape special characters'
        );
      }

      return this.formatErrorResponse(
        `Error searching files: ${errorMsg}`,
        'system_error'
      );
    }
  }

  /**
   * Execute ripgrep and return stdout/stderr
   */
  private executeRipgrep(args: string[]): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const process = spawn(rgPath, args, { shell: false });

      let stdout = '';
      let stderr = '';

      process.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      process.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      process.on('close', (code) => {
        // Exit codes: 0 = matches found, 1 = no matches, 2+ = error
        if (code === 0 || code === 1) {
          resolve({ stdout, stderr });
        } else {
          reject(new Error(`ripgrep exited with code ${code}: ${stderr}`));
        }
      });

      process.on('error', (error) => {
        reject(error);
      });
    });
  }

  /**
   * Parse ripgrep JSON output into GrepMatch array
   */
  private parseRipgrepJson(stdout: string): GrepMatch[] {
    const matches: GrepMatch[] = [];
    const lines = stdout.split('\n').filter((line) => line.trim() !== '');

    let currentMatch: GrepMatch | null = null;
    let contextBefore: string[] = [];

    for (const line of lines) {
      try {
        const json = JSON.parse(line);

        if (json.type === 'match') {
          // Save previous match if exists
          if (currentMatch) {
            matches.push(currentMatch);
            contextBefore = [];
          }

          const filePath = json.data.path.text;
          const lineNumber = json.data.line_number;
          const content = json.data.lines.text.replace(/\n$/, ''); // Remove trailing newline

          currentMatch = {
            file: filePath,
            line: lineNumber,
            content: content,
          };

          // Add context before if we collected any
          if (contextBefore.length > 0) {
            currentMatch.before = contextBefore;
            contextBefore = [];
          }
        } else if (json.type === 'context') {
          const contextLine = json.data.lines.text.replace(/\n$/, '');

          if (currentMatch) {
            // Context after a match
            if (!currentMatch.after) {
              currentMatch.after = [];
            }
            currentMatch.after.push(contextLine);
          } else {
            // Context before a match
            contextBefore.push(contextLine);
          }
        }
      } catch (error) {
        // Skip lines that don't parse as JSON
        continue;
      }
    }

    // Don't forget the last match
    if (currentMatch) {
      matches.push(currentMatch);
    }

    return matches;
  }


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
