/**
 * GlobTool - Find files matching glob patterns
 *
 * Provides fast file pattern matching with exclusion support,
 * sorted by modification time.
 */

import { BaseTool } from './BaseTool.js';
import { ToolResult, FunctionDefinition } from '../types/index.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { resolvePath } from '../utils/pathUtils.js';
import { FILE_EXCLUSIONS, TOOL_LIMITS } from '../config/toolDefaults.js';
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
    'Find files using glob patterns. Examples: \'*.ts\' (TypeScript files), \'**/*.test.js\' (test files recursively). Use * for wildcards, ** for recursive';
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
            preset: {
              type: 'string',
              description:
                'Pattern preset: "tests", "configs", "all_ts", "all_js", "components" (overrides pattern if provided)',
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
            sort_by: {
              type: 'string',
              description: 'Sort order: "modified" for newest first (default), "name" for alphabetical',
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
    const preset = args.preset as string | undefined;
    let pattern = args.pattern as string;

    // Apply preset patterns (overrides pattern if provided)
    if (preset) {
      const presetMap: Record<string, string> = {
        tests: '**/*{.test,.spec}.{ts,tsx,js,jsx,py}',
        configs: '**/*.{json,yaml,yml,toml,ini,config.js,config.ts}',
        all_ts: '**/*.{ts,tsx}',
        all_js: '**/*.{js,jsx}',
        components: '**/{components,component}/**/*.{ts,tsx,js,jsx}',
      };
      pattern = presetMap[preset] || pattern;
    }

    const searchPath = (args.path as string) || '.';
    const excludePatterns = (args.exclude as string[]) || [];
    const maxResults = Math.min(
      Number(args.max_results) || TOOL_LIMITS.MAX_SEARCH_RESULTS,
      TOOL_LIMITS.MAX_SEARCH_RESULTS
    );
    const sortBy = (args.sort_by as string) || 'modified'; // Default: newest first

    if (!pattern && !preset) {
      return this.formatErrorResponse(
        'pattern or preset parameter is required',
        'validation_error',
        'Example: glob(pattern="**/*.ts") or glob(preset="tests")'
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

      // Get file info with stats
      const fileInfos: FileInfo[] = [];
      for (const filePath of matchedFiles) {
        try {
          const fileStats = await fs.stat(filePath);
          fileInfos.push({
            path: filePath,
            relativePath: path.relative(process.cwd(), filePath),
            size: fileStats.size,
            modified: fileStats.mtimeMs,
          });
        } catch {
          // Skip files that can't be stat'd
          continue;
        }
      }

      // Sort based on sort_by parameter
      if (sortBy === 'name') {
        // Alphabetical sort
        fileInfos.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
      } else {
        // Default: modification time (newest first)
        fileInfos.sort((a, b) => b.modified - a.modified);
      }

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
    return 300; // Glob typically produces smaller output (file paths only)
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
