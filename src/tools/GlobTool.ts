/**
 * GlobTool - Find files matching glob patterns
 *
 * Provides fast file pattern matching with exclusion support,
 * sorted by modification time.
 */

import { BaseTool } from './BaseTool.js';
import { ToolCapability } from './ToolCapability.js';
import { ToolResult, FunctionDefinition } from '../types/index.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { ServiceRegistry } from '../services/ServiceRegistry.js';
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
  readonly displayName = 'Find Files';
  readonly description =
    'Find files by name pattern, newest first. Use instead of ls/tree when the pattern is known.';
  readonly capabilities = [ToolCapability.FsRead] as const;
  readonly isExploratoryTool = true;

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
            patterns: {
              type: 'array',
              items: { type: 'string' },
              description: 'Name globs; batch alternatives in one call.',
            },
            path: {
              type: 'string',
              format: 'local-path',
              description: 'Search root (default: current directory).',
            },
            exclude: {
              type: 'array',
              items: { type: 'string' },
              description: 'Additional excluded patterns.',
            },
            max_results: {
              type: 'integer',
              description: `Maximum results (default: ${TOOL_LIMITS.MAX_SEARCH_RESULTS}).`,
            },
          },
          required: ['patterns'],
        },
      },
    };
  }

  protected async executeImpl(args: any): Promise<ToolResult> {
    // Capture parameters
    this.captureParams(args);

    // Extract and validate parameters
    // `pattern` remains an execution-only legacy alias for saved sessions and
    // older clients. The provider schema exposes batched `patterns` only.
    const patterns: string[] = Array.isArray(args.patterns)
      ? args.patterns
      : typeof args.pattern === 'string'
        ? [args.pattern]
        : [];
    const searchPath = (args.path as string) || '.';
    const excludePatterns = (args.exclude as string[]) || [];
    const maxResults = Math.min(
      Number(args.max_results) || TOOL_LIMITS.MAX_SEARCH_RESULTS,
      TOOL_LIMITS.MAX_SEARCH_RESULTS
    );

    if (patterns.length === 0 || patterns.some(pattern => typeof pattern !== 'string' || pattern.length === 0)) {
      return this.formatErrorResponse(
        'patterns must be a non-empty array of strings',
        'validation_error',
        'Example: patterns=["**/*.ts"]'
      );
    }

    // Validate pattern (basic security check)
    if (patterns.some(pattern => pattern.includes('..'))) {
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
      const focusManager = registry.get('focus_manager');

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

      // Construct absolute globs once; fast-glob evaluates them together and
      // deduplicates files matched by more than one pattern.
      const globPatterns = patterns.map(pattern => path.join(absolutePath, pattern));

      // Find matching files
      const matchedFiles = [...new Set(await fg(globPatterns, {
        dot: false,
        onlyFiles: true,
        ignore: allExcludePatterns,
        absolute: true,
      }))];

      // Filter out excluded files if focus manager has exclusions
      let filteredFiles = matchedFiles;
      if (focusManager) {
        filteredFiles = [];
        for (const filePath of matchedFiles) {
          const validation = await focusManager.validatePathInFocus(filePath);
          if (validation.success) {
            filteredFiles.push(filePath);
          }
        }
      }

      // Get file info with stats (parallel with concurrency limit)
      const STAT_CONCURRENCY = 15; // Optimal concurrency for file stats
      const fileInfos: FileInfo[] = [];

      // Process files in batches to limit concurrency
      for (let i = 0; i < filteredFiles.length; i += STAT_CONCURRENCY) {
        const batch = filteredFiles.slice(i, i + STAT_CONCURRENCY);
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
   * Format subtext for display in UI
   * Shows glob pattern when description is not provided
   */
  formatSubtext(args: Record<string, any>): string | null {
    const description = args.description as string;
    if (description) return description;

    const patterns: string[] = Array.isArray(args.patterns)
      ? args.patterns
      : typeof args.pattern === 'string' ? [args.pattern] : [];
    if (patterns.length === 0) return null;

    return patterns.join(', ');
  }

  /**
   * Get parameters shown in subtext
   */
  getSubtextParameters(): string[] {
    return ['description', 'patterns', 'pattern'];
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
