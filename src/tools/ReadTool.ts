/**
 * ReadTool - Read multiple file contents at once
 *
 * Reads file contents with line numbering, token estimation, and binary detection.
 */

import { BaseTool } from './BaseTool.js';
import { ToolResult, FunctionDefinition, Config } from '../types/index.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { ServiceRegistry } from '../services/ServiceRegistry.js';
import { FocusManager } from '../services/FocusManager.js';
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

  readonly usageGuidance = `**When to use read:**
Regular reads (default) keep file content in context for future reference - prefer this for most use cases.
ONLY use ephemeral=true when file exceeds normal token limit AND you need one-time inspection.
WARNING: Ephemeral content is automatically removed after one turn - you'll lose access to it.

For exploratory work (unknown file locations, multi-file pattern analysis), use explore() to preserve your context and tool call capacity.`;

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
   * Get the maximum allowed tokens for ephemeral reads
   * Allows up to 90% of context size for temporary large file reads
   */
  private getEphemeralMaxTokens(): number {
    const contextSize = this.config?.context_size ?? CONTEXT_SIZES.SMALL;
    return Math.floor(contextSize * TOKEN_MANAGEMENT.EPHEMERAL_READ_MAX_PERCENT);
  }

  /**
   * Get the maximum allowed tokens for user-initiated reads via file mentions
   * Uses full context size since user is explicitly requesting the file
   */
  private getUserInitiatedMaxTokens(): number {
    const contextSize = this.config?.context_size ?? CONTEXT_SIZES.SMALL;
    // Use 95% of context to leave room for user's message and response
    return Math.floor(contextSize * TOKEN_MANAGEMENT.USER_INITIATED_READ_MAX_PERCENT);
  }

  /**
   * Get the maximum allowed tokens for context file reads
   * Middle ground between user (95%) and agent (20%) initiated reads
   */
  private getContextFileMaxTokens(): number {
    const contextSize = this.config?.context_size ?? CONTEXT_SIZES.SMALL;
    // Use 40% of context for context files
    return Math.floor(contextSize * TOKEN_MANAGEMENT.CONTEXT_FILE_READ_MAX_PERCENT);
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
              description: 'File paths to read',
              items: {
                type: 'string',
              },
            },
            limit: {
              type: 'integer',
              description: 'Max lines per file (0=all)',
            },
            offset: {
              type: 'integer',
              description: 'Start line (1-based). Negative = from end (e.g. -20)',
            },
            ephemeral: {
              type: 'boolean',
              description: 'Allow large files (90% context). WARNING: Content removed after one turn.',
            },
          },
          required: ['file_paths'],
        },
      },
    };
  }

  protected async executeImpl(args: any, _toolCallId?: string, isUserInitiated: boolean = false, isContextFile: boolean = false): Promise<ToolResult> {
    this.captureParams(args);

    const filePaths = args.file_paths;
    const limit = args.limit !== undefined ? Number(args.limit) : 0;
    const offset = args.offset !== undefined ? Number(args.offset) : 0;
    const ephemeral = args.ephemeral === true;

    if (!Array.isArray(filePaths) || filePaths.length === 0) {
      return this.formatErrorResponse(
        'file_paths must be a non-empty array',
        'validation_error',
        'Example: read(file_paths=["src/main.ts", "package.json"])'
      );
    }

    const estimatedTokens = await this.estimateTokens(filePaths, limit, offset);

    // Determine max tokens based on read type
    let maxTokens: number;
    if (isContextFile) {
      maxTokens = this.getContextFileMaxTokens(); // 40% for context files
    } else if (isUserInitiated) {
      maxTokens = this.getUserInitiatedMaxTokens(); // 95% for user mentions
    } else {
      maxTokens = ephemeral ? this.getEphemeralMaxTokens() : this.getMaxTokens(); // 20% or 90% for agents
    }

    if (estimatedTokens > maxTokens) {
      const examples = filePaths.length === 1
        ? `read(file_paths=["${filePaths[0]}"], limit=100) or read(file_paths=["${filePaths[0]}"], offset=-100, limit=100) for last 100 lines`
        : `read(file_paths=["${filePaths[0]}"], limit=100) or read fewer files`;

      const ephemeralHint = !ephemeral && !isUserInitiated && !isContextFile
        ? ' As a LAST RESORT for one-time inspection only: ephemeral=true (WARNING: content removed after one turn, you will lose access).'
        : '';

      // Customize error message based on context
      const limitDescription = isContextFile
        ? '40% of context'
        : isUserInitiated
          ? '95% of context'
          : ephemeral
            ? '90% of context'
            : '20% of context';

      return this.formatErrorResponse(
        `File(s) too large: estimated ${estimatedTokens.toFixed(1)} tokens exceeds limit of ${maxTokens} (${limitDescription}). ` +
        `FIRST try: Use grep/glob to search for specific content, or use limit/offset for targeted reading. ` +
        `Example: ${examples}.${ephemeralHint}`,
        'validation_error',
        `Prefer targeted reading with limit/offset or search with grep/glob over ephemeral reads`
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
    const result = this.formatSuccessResponse({
      content: combinedContent,
      files_read: filesRead,
      files_failed: errors.length,
      partial_failure: errors.length > 0,
    });

    // Mark result as ephemeral if requested
    if (ephemeral) {
      (result as any)._ephemeral = true;
      (result as any)._ephemeral_warning =
        '[EPHEMERAL READ: This content will be removed from conversation after current turn. ' +
        'If you need it later, use a regular read or save key information in your response.]';
    }

    return result;
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

    // Validate focus constraint if active
    const registry = ServiceRegistry.getInstance();
    const focusManager = registry.get<FocusManager>('focus_manager');

    if (focusManager && focusManager.isFocused()) {
      const validation = await focusManager.validatePathInFocus(absolutePath);
      if (!validation.success) {
        throw new Error(validation.message);
      }
    }

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
    const totalLines = lines.length;

    // Calculate actual start line
    // Negative offset: count from end (e.g., -20 = start 20 lines from end)
    // Positive offset: 1-based line number (offset=1 is first line)
    // Zero offset: start from beginning
    let startLine: number;
    if (offset < 0) {
      // Negative offset: count from end
      // -1 = last line, -20 = 20 lines from end
      startLine = Math.max(0, totalLines + offset);
    } else if (offset > 0) {
      // Positive offset: 1-based line number
      startLine = offset - 1;

      // Validate positive offset isn't beyond file
      if (startLine >= totalLines) {
        const lastPageStart = Math.max(1, totalLines - (limit || 50));
        return `=== ${absolutePath} ===\n` +
          `[Cannot read from offset ${offset}: file only has ${totalLines} line${totalLines !== 1 ? 's' : ''}. ` +
          `Try reading from the beginning (offset=1)` +
          (limit ? `, or offset=${lastPageStart} to read the last ${Math.min(limit, totalLines)} lines.` : '.') +
          `]`;
      }
    } else {
      // Zero offset: start from beginning
      startLine = 0;
    }

    // Apply limit
    const endLine = limit > 0 ? startLine + limit : lines.length;
    const selectedLines = lines.slice(startLine, endLine);

    // Add informational header if only showing a slice
    let header = `=== ${absolutePath} ===`;
    if (offset !== 0 || (limit > 0 && endLine < totalLines)) {
      header += `\n[Showing lines ${startLine + 1}-${Math.min(endLine, totalLines)} of ${totalLines} total lines]`;
    }

    // Format with line numbers
    const formattedLines = selectedLines.map((line, index) => {
      const lineNum = startLine + index + 1;
      return `${String(lineNum).padStart(FORMATTING.LINE_NUMBER_WIDTH)}\t${line}`;
    });

    return `${header}\n${formattedLines.join('\n')}`;
  }


  /**
   * Format subtext for display in UI
   * Shows: [description] (file1.txt, file2.txt) or just (filenames) if no description
   * Includes line range information when limit/offset are used
   */
  formatSubtext(args: Record<string, any>): string | null {
    const filePaths = args.file_paths;
    const description = args.description as string;
    const limit = args.limit !== undefined ? Number(args.limit) : 0;
    const offset = args.offset !== undefined ? Number(args.offset) : 0;

    if (!filePaths) {
      return null;
    }

    // Extract filenames (basename only)
    const paths = Array.isArray(filePaths) ? filePaths : [filePaths];
    const filenames = paths.map((p: string) => {
      const parts = p.split('/');
      return parts[parts.length - 1] || p;
    });

    // Build line range info if applicable
    let rangeInfo = '';
    if (limit > 0 || offset !== 0) {
      if (offset < 0) {
        // Negative offset: reading from end
        if (limit > 0) {
          rangeInfo = ` - last ${limit} lines`;
        } else {
          rangeInfo = ` - last ${Math.abs(offset)} lines`;
        }
      } else if (offset > 0) {
        // Positive offset: reading from specific line
        const startLine = offset;
        if (limit > 0) {
          const endLine = startLine + limit - 1;
          rangeInfo = ` - lines ${startLine}-${endLine}`;
        } else {
          rangeInfo = ` - from line ${startLine}`;
        }
      } else {
        // offset = 0: reading from beginning
        if (limit > 0) {
          rangeInfo = ` - first ${limit} lines`;
        }
      }
    }

    const filenamesStr = `(${filenames.join(', ')}${rangeInfo})`;

    // If description exists, show it first
    if (description) {
      return `${description} ${filenamesStr}`;
    }

    return filenamesStr;
  }

  /**
   * Get parameters shown in subtext
   * ReadTool shows both 'file_paths' and 'description' in subtext
   */
  getSubtextParameters(): string[] {
    return ['file_paths', 'description'];
  }

  /**
   * Get truncation guidance for read output
   */
  getTruncationGuidance(): string {
    return 'The file has MORE content that was cut off. Use offset=-50 and limit=50 to read the last 50 lines, or use grep to search for specific content';
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
