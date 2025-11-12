/**
 * GlobTool - Find files matching glob patterns
 *
 * Provides fast file pattern matching with exclusion support,
 * sorted by modification time.
 */

import { BaseTool } from './BaseTool.js';
import { ToolResult, FunctionDefinition } from '../types/index.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { ServiceRegistry } from '../services/ServiceRegistry.js';
import { FocusManager } from '../services/FocusManager.js';
import { resolvePath } from '../utils/pathUtils.js';
import { FILE_EXCLUSIONS, TOOL_LIMITS, TOOL_OUTPUT_ESTIMATES } from '../config/toolDefaults.js';
import { formatError } from '../utils/errorUtils.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import fg from 'fast-glob';

interface FileInfo {
  path: string;
  relativePath: string;
  size: number;
  modified: number;
}

export class GlobTool extends BaseTool {
  readonly name = 'glob';
  readonly description =
    'Find files using glob patterns, sorted by modification time (newest first). Examples: \'*.ts\' (TypeScript files), \'**/*.test.js\' (test files recursively). Use * for wildcards, ** for recursive';
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
            pattern: {
              type: 'string',
              description:
                'Glob pattern to match files (e.g., "*.ts", "**/*.js", "src/**/*test*")',
            },
            path: {
              type: 'string',
              description: 'Search root directory (default: current directory)',
            },
            exclude: {
              type: 'array',
              items: { type: 'string' },
              description:
                'Patterns to exclude (default: node_modules, .git, dist, build)',
            },
            max_results: {
              type: 'integer',
              description: `Maximum number of results (default: ${TOOL_LIMITS.MAX_SEARCH_RESULTS})`,
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
    const excludePatterns = (args.exclude as string[]) || [];
    const maxResults = Math.min(
      Number(args.max_results) || TOOL_LIMITS.MAX_SEARCH_RESULTS,
      TOOL_LIMITS.MAX_SEARCH_RESULTS
    );

    if (!pattern) {
      return this.formatErrorResponse(
        'pattern parameter is required',
        'validation_error',
        'Example: glob(pattern="**/*.ts")'
      );
    }

    // Validate pattern (basic security check)
    if (pattern.includes('..')) {
      return this.formatErrorResponse(
        'Pattern contains invalid path traversal (..)',
        'security_error',
        'Use patterns without .. for security'
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
      try {
        await fs.access(absolutePath);
      } catch {
        return this.formatErrorResponse(
          `Path not found: ${searchPath}`,
          'validation_error'
        );
      }

      // Check if it's a directory
      const stats = await fs.stat(absolutePath);
      if (!stats.isDirectory()) {
        return this.formatErrorResponse(
          `Not a directory: ${searchPath}`,
          'validation_error',
          'glob requires a directory path'
        );
      }

      // Combine default and user-provided exclude patterns
      const allExcludePatterns = [...FILE_EXCLUSIONS.DEFAULT, ...excludePatterns];

      // Construct the full glob pattern
      const globPattern = path.join(absolutePath, pattern);

      // Find matching files
      const matchedFiles = await fg(globPattern, {
        dot: false,
        onlyFiles: true,
        ignore: allExcludePatterns,
        absolute: true,
      });

      // Get file info with stats (parallel with concurrency limit)
      const STAT_CONCURRENCY = 15; // Optimal concurrency for file stats
      const fileInfos: FileInfo[] = [];

      // Process files in batches to limit concurrency
      for (let i = 0; i < matchedFiles.length; i += STAT_CONCURRENCY) {
        const batch = matchedFiles.slice(i, i + STAT_CONCURRENCY);
        const results = await Promise.allSettled(
          batch.map(async (filePath) => {
            const fileStats = await fs.stat(filePath);
            return {
              path: filePath,
              relativePath: path.relative(process.cwd(), filePath),
              size: fileStats.size,
              modified: fileStats.mtimeMs,
            };
          })
        );

        // Collect successful results
        for (const result of results) {
          if (result.status === 'fulfilled') {
            fileInfos.push(result.value);
          }
          // Skip files that can't be stat'd (rejected promises)
        }
      }

      // Sort by modification time (newest first)
      fileInfos.sort((a, b) => b.modified - a.modified);

      // Apply limit
      const totalMatches = fileInfos.length;
      const limitedResults = totalMatches > maxResults;
      const results = fileInfos.slice(0, maxResults);

      // Extract just the paths for the main result
      const filePaths = results.map((info) => info.relativePath);

      // Format as human-readable content
      const content = filePaths.join('\n');

      return this.formatSuccessResponse({
        content, // Human-readable output for LLM
        files: filePaths, // Structured data
        total_matches: totalMatches,
        limited_results: limitedResults,
        file_details: results,
      });
    } catch (error) {
      return this.formatErrorResponse(
        `Error searching files: ${formatError(error)}`,
        'system_error'
      );
    }
  }

  /**
   * Get truncation guidance for glob output
   */
  getTruncationGuidance(): string {
    return 'Use more specific glob patterns to narrow down the file list';
  }

  /**
   * Get estimated output size for glob operations
   */
  getEstimatedOutputSize(): number {
    return TOOL_OUTPUT_ESTIMATES.GLOB;
  }

  /**
   * Custom result preview
   */
  getResultPreview(result: ToolResult, maxLines: number = 3): string[] {
    if (!result.success) {
      return super.getResultPreview(result, maxLines);
    }

    const files = result.files as string[] | undefined;
    const totalMatches = result.total_matches ?? 0;

    if (!files || files.length === 0) {
      return ['No files found'];
    }

    const lines: string[] = [];
    lines.push(`Found ${totalMatches} file(s)`);

    const previewCount = Math.min(files.length, maxLines - 1);
    for (let i = 0; i < previewCount; i++) {
      const file = files[i];
      if (file) {
        lines.push(file);
      }
    }

    if (files.length > previewCount) {
      lines.push('...');
    }

    return lines;
  }
}
