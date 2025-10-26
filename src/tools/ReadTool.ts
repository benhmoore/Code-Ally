/**
 * ReadTool - Read multiple file contents at once
 *
 * Reads file contents with line numbering, token estimation, and binary detection.
 */

import { BaseTool } from './BaseTool.js';
import { ToolResult, FunctionDefinition, Config } from '../types/index.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { tokenCounter } from '../services/TokenCounter.js';
import { resolvePath } from '../utils/pathUtils.js';
import { validateIsFile } from '../utils/pathValidator.js';
import { isBinaryContent } from '../utils/fileUtils.js';
import { formatError } from '../utils/errorUtils.js';
import { TOOL_OUTPUT_ESTIMATES } from '../config/toolDefaults.js';
import { TOKEN_MANAGEMENT, CONTEXT_SIZES, FORMATTING } from '../config/constants.js';
import { DEFAULT_CONFIG } from '../config/defaults.js';
import * as fs from 'fs/promises';

export class ReadTool extends BaseTool {
  readonly name = 'read';
  readonly description =
    'Read multiple file contents at once. Use for reading related files together, checking code before editing';
  readonly requiresConfirmation = false; // Read-only operation

  private config?: Config;

  constructor(activityStream: ActivityStream, config?: Config) {
    super(activityStream);
    this.config = config;
  }

  /**
   * Get the maximum allowed tokens for a read operation
   * Capped by both configured limit and context size
   */
  private getMaxTokens(): number {
    const configuredMax = this.config?.read_max_tokens ?? DEFAULT_CONFIG.read_max_tokens;
    const contextSize = this.config?.context_size ?? CONTEXT_SIZES.SMALL;

    // Cap at 20% of context size to leave room for conversation
    const contextBasedMax = Math.floor(contextSize * TOKEN_MANAGEMENT.READ_CONTEXT_MAX_PERCENT);

    return Math.min(configuredMax, contextBasedMax);
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
    this.captureParams(args);

    const filePaths = args.file_paths;
    const limit = args.limit !== undefined ? Number(args.limit) : 0;
    const offset = args.offset !== undefined ? Number(args.offset) : 0;

    if (!Array.isArray(filePaths) || filePaths.length === 0) {
      return this.formatErrorResponse(
        'file_paths must be a non-empty array',
        'validation_error',
        'Example: read(file_paths=["src/main.ts", "package.json"])'
      );
    }

    const estimatedTokens = await this.estimateTokens(filePaths, limit, offset);
    const maxTokens = this.getMaxTokens();

    if (estimatedTokens > maxTokens) {
      const examples = filePaths.length === 1
        ? `read(file_paths=["${filePaths[0]}"], limit=100) or read(file_paths=["${filePaths[0]}"], offset=50, limit=100)`
        : `read(file_paths=["${filePaths[0]}"], limit=100) or read fewer files`;

      return this.formatErrorResponse(
        `File(s) too large: estimated ${estimatedTokens.toFixed(1)} tokens exceeds limit of ${maxTokens}. ` +
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
        const errorMsg = formatError(error);
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
   * Estimate total tokens for files considering limit and offset
   */
  private async estimateTokens(
    filePaths: string[],
    limit: number = 0,
    offset: number = 0
  ): Promise<number> {
    let totalEstimate = 0;

    for (const filePath of filePaths) {
      try {
        if (limit > 0) {
          const content = await this.readFile(filePath, limit, offset);
          totalEstimate += tokenCounter.count(content);
        } else {
          const stats = await fs.stat(filePath);
          const tokenEstimate = Math.ceil(stats.size / 3.5);
          totalEstimate += tokenEstimate;
        }
      } catch {
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
    const absolutePath = resolvePath(filePath);

    // Validate file exists and is a file
    const validation = await validateIsFile(absolutePath);
    if (!validation.valid) {
      throw new Error(validation.error);
    }

    // Read file content
    const content = await fs.readFile(absolutePath, 'utf-8');

    // Check for binary content
    if (isBinaryContent(content)) {
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
      return `${String(lineNum).padStart(FORMATTING.LINE_NUMBER_WIDTH)}\t${line}`;
    });

    return `=== ${absolutePath} ===\n${formattedLines.join('\n')}`;
  }


  /**
   * Get truncation guidance for read output
   */
  getTruncationGuidance(): string {
    return 'Use limit and offset parameters for targeted reading of specific line ranges';
  }

  /**
   * Get estimated output size for read operations
   */
  getEstimatedOutputSize(): number {
    return TOOL_OUTPUT_ESTIMATES.READ;
  }

  /**
   * Custom result preview
   */
  getResultPreview(result: ToolResult, maxLines: number = 3): string[] {
    if (!result.success) {
      return super.getResultPreview(result, maxLines);
    }

    const lines: string[] = [];

    // Show warning for partial failures
    if (result.partial_failure) {
      const failedCount = result.files_failed ?? 0;
      lines.push(`⚠️  Read ${result.files_read} file(s), ${failedCount} failed`);
    } else {
      lines.push(`Read ${result.files_read} file(s)`);
    }

    if (result.content) {
      const contentLines = result.content.split('\n').slice(0, maxLines - lines.length);
      lines.push(...contentLines);

      if (result.content.split('\n').length > contentLines.length) {
        lines.push('...');
      }
    }

    return lines;
  }
}
