/**
 * ReadTool - Read multiple file contents at once
 *
 * Reads file contents with line numbering, token estimation, and binary detection.
 */

import { BaseTool } from './BaseTool.js';
import { ToolResult, FunctionDefinition } from '../types/index.js';
import { ActivityStream } from '../services/ActivityStream.js';
import * as fs from 'fs/promises';
import * as path from 'path';

export class ReadTool extends BaseTool {
  readonly name = 'read';
  readonly description =
    'Read contents of one or more files. Returns file contents with line numbers. Use this to examine code, configuration, or any text files.';
  readonly requiresConfirmation = false; // Read-only operation

  private static readonly MAX_ESTIMATED_TOKENS = 2500;
  private static readonly LINE_NUMBER_WIDTH = 6;

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
            file_paths: {
              type: 'array',
              description: 'Array of file paths to read',
              items: {
                type: 'string',
              },
            },
            limit: {
              type: 'integer',
              description: 'Maximum lines to read per file (0 = all lines)',
            },
            offset: {
              type: 'integer',
              description: 'Start reading from this line number (1-based)',
            },
          },
          required: ['file_paths'],
        },
      },
    };
  }

  protected async executeImpl(args: any): Promise<ToolResult> {
    // Capture parameters
    this.captureParams(args);

    // Extract parameters
    const filePaths = args.file_paths;
    const limit = args.limit !== undefined ? Number(args.limit) : 0;
    const offset = args.offset !== undefined ? Number(args.offset) : 0;

    // Validate file_paths
    if (!Array.isArray(filePaths) || filePaths.length === 0) {
      return this.formatErrorResponse(
        'file_paths must be a non-empty array',
        'validation_error',
        'Example: read(file_paths=["src/main.ts", "package.json"])'
      );
    }

    // Token estimation check
    const estimatedTokens = await this.estimateTokens(filePaths);
    if (estimatedTokens > ReadTool.MAX_ESTIMATED_TOKENS) {
      const examples = filePaths.length === 1
        ? `read(file_paths=["${filePaths[0]}"], limit=100) or read(file_paths=["${filePaths[0]}"], offset=50, limit=100)`
        : `read(file_paths=["${filePaths[0]}"], limit=100) or read fewer files`;

      return this.formatErrorResponse(
        `File(s) too large: estimated ${estimatedTokens.toFixed(1)} tokens exceeds limit of ${ReadTool.MAX_ESTIMATED_TOKENS}. ` +
        `Use grep/glob to search for specific content, or use limit/offset for targeted reading. ` +
        `Example: ${examples}`,
        'validation_error',
        `Use targeted reading with limit parameter or search within files first using grep`
      );
    }

    // Read files
    const results: string[] = [];
    const errors: string[] = [];
    let filesRead = 0;

    for (const filePath of filePaths) {
      try {
        const content = await this.readFile(filePath, limit, offset);
        results.push(content);
        filesRead++;
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        errors.push(`${filePath}: ${errorMsg}`);
        results.push(
          `=== ${filePath} ===\nError: ${errorMsg}`
        );
      }
    }

    // If ALL files failed, return an error
    if (filesRead === 0) {
      return this.formatErrorResponse(
        `Failed to read ${errors.length} file${errors.length !== 1 ? 's' : ''}: ${errors.join(', ')}`,
        'file_error'
      );
    }

    const combinedContent = results.join('\n\n');

    // If some files failed, include warning in content but still succeed
    return this.formatSuccessResponse({
      content: combinedContent,
      files_read: filesRead,
      files_failed: errors.length,
      partial_failure: errors.length > 0,
    });
  }

  /**
   * Estimate total tokens for files
   */
  private async estimateTokens(filePaths: string[]): Promise<number> {
    let totalEstimate = 0;

    for (const filePath of filePaths) {
      try {
        const stats = await fs.stat(filePath);
        // Rough estimate: 1 token per 4 characters + line number overhead
        const tokenEstimate = Math.ceil(stats.size / 4) + stats.size / 80; // Assume ~80 chars per line
        totalEstimate += tokenEstimate;
      } catch {
        // If we can't stat, skip estimation
        continue;
      }
    }

    return totalEstimate;
  }

  /**
   * Read a single file with line numbers
   */
  private async readFile(
    filePath: string,
    limit: number,
    offset: number
  ): Promise<string> {
    // Resolve absolute path
    const absolutePath = path.isAbsolute(filePath)
      ? filePath
      : path.join(process.cwd(), filePath);

    // Check if file exists
    try {
      await fs.access(absolutePath);
    } catch {
      throw new Error(`File not found: ${filePath}`);
    }

    // Check if it's a file (not a directory)
    const stats = await fs.stat(absolutePath);
    if (!stats.isFile()) {
      throw new Error(`Not a file: ${filePath}`);
    }

    // Read file content
    const content = await fs.readFile(absolutePath, 'utf-8');

    // Check for binary content
    if (this.isBinary(content)) {
      return `=== ${absolutePath} ===\n[Binary file - content not displayed]`;
    }

    // Split into lines
    const lines = content.split('\n');

    // Apply offset and limit
    const startLine = offset > 0 ? offset - 1 : 0;
    const endLine = limit > 0 ? startLine + limit : lines.length;
    const selectedLines = lines.slice(startLine, endLine);

    // Format with line numbers
    const formattedLines = selectedLines.map((line, index) => {
      const lineNum = startLine + index + 1;
      return `${String(lineNum).padStart(ReadTool.LINE_NUMBER_WIDTH)}\t${line}`;
    });

    return `=== ${absolutePath} ===\n${formattedLines.join('\n')}`;
  }

  /**
   * Check if content appears to be binary
   */
  private isBinary(content: string): boolean {
    // Check for null bytes in first 1KB
    const sample = content.substring(0, 1024);
    return sample.includes('\0');
  }

  /**
   * Custom result preview
   */
  getResultPreview(result: ToolResult, maxLines: number = 3): string[] {
    if (!result.success) {
      return super.getResultPreview(result, maxLines);
    }

    const lines: string[] = [];
    lines.push(`Read ${result.files_read} file(s)`);

    if (result.content) {
      const contentLines = result.content.split('\n').slice(0, maxLines - 1);
      lines.push(...contentLines);

      if (result.content.split('\n').length > maxLines - 1) {
        lines.push('...');
      }
    }

    return lines;
  }
}
