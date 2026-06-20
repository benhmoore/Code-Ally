/**
 * ReadTool - Read multiple file contents at once
 *
 * Reads file contents with line numbering, token estimation, and binary detection.
 */

import { BaseTool } from './BaseTool.js';
import { ToolExecutionContext, ToolResult, FunctionDefinition } from '../types/index.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { ServiceRegistry } from '../services/ServiceRegistry.js';
import { ReadCache } from '../services/ReadCache.js';
import { FocusManager } from '../services/FocusManager.js';
import { ReadStateManager } from '../services/ReadStateManager.js';
import { tokenCounter } from '../services/TokenCounter.js';
import { resolvePath } from '../utils/pathUtils.js';
import { validateIsFile, isBlockedDevicePath } from '../utils/pathValidator.js';
import { isBinaryContent } from '../utils/fileUtils.js';
import { formatError } from '../utils/errorUtils.js';
import { TOOL_OUTPUT_ESTIMATES, TOOL_LIMITS } from '../config/toolDefaults.js';
import { TOKEN_MANAGEMENT, CONTEXT_SIZES, FORMATTING, BYTE_CONVERSIONS } from '../config/constants.js';
import * as fs from 'fs/promises';
import { createReadStream } from 'fs';
import * as path from 'path';
import * as readline from 'readline';

export class ReadTool extends BaseTool {
  readonly name = 'read';
  readonly description =
    'Read multiple file contents at once. Use for reading related files together, checking code before editing';
  readonly requiresConfirmation = false; // Read-only operation
  readonly isExploratoryTool = true;
  readonly hideOutput = true; // Hide file content from user, show summary in subtext

  readonly usageGuidance = `**When to use read:**
Default reads stay in context. Use ephemeral=true only for one-time large file inspection (content removed after one turn).
For multi-file exploration, prefer explore() to preserve context.`;

  constructor(activityStream: ActivityStream) {
    super(activityStream);
  }

  /**
   * Validate ReadTool arguments
   */
  validateArgs(args: Record<string, unknown>): { valid: boolean; error?: string; error_type?: string; suggestion?: string } | null {
    // Validate limit parameter
    if (args.limit !== undefined && args.limit !== null) {
      const limit = Number(args.limit);
      if (isNaN(limit) || limit < 0) {
        return {
          valid: false,
          error: 'limit must be a non-negative number',
          error_type: 'validation_error',
          suggestion: 'Example: limit=100 (or 0 for all lines)',
        };
      }
    }

    // Validate offset parameter
    if (args.offset !== undefined && args.offset !== null) {
      const offset = Number(args.offset);
      if (isNaN(offset)) {
        return {
          valid: false,
          error: 'offset must be a number (positive: 1-based line number, negative: count from end)',
          error_type: 'validation_error',
          suggestion: 'Example: offset=1 (starts at line 1) or offset=-20 (last 20 lines with limit=20)',
        };
      }
    }

    return null;
  }

  /**
   * Get remaining context budget from TokenManager
   * Uses same calculation as ToolResultManager
   */
  private getRemainingContext(tokenManager: any): number {
    const totalContext = tokenManager.getContextSize();
    const usedTokens = tokenManager.getCurrentTokenCount();
    const bufferTokens = Math.floor(totalContext * TOKEN_MANAGEMENT.SAFETY_BUFFER_PERCENT); // 10% buffer for safety

    return Math.max(0, totalContext - usedTokens - bufferTokens);
  }

  /**
   * Get the maximum allowed tokens for a read operation
   * Capped by both configured limit and context size
   */
  private getMaxTokens(): number {
    // Get context size from TokenManager (authoritative source)
    const registry = ServiceRegistry.getInstance();
    const tokenManager = registry.get<any>('token_manager');
    const contextSize = tokenManager?.getContextSize() ?? CONTEXT_SIZES.SMALL;

    // Cap at 20% of context size to leave room for conversation
    const contextBasedMax = Math.floor(contextSize * TOKEN_MANAGEMENT.READ_CONTEXT_MAX_PERCENT);

    return contextBasedMax;
  }

  /**
   * Get the maximum allowed tokens for ephemeral reads
   * Allows up to 90% of context size for temporary large file reads
   */
  private getEphemeralMaxTokens(): number {
    // Get context size from TokenManager (authoritative source)
    const registry = ServiceRegistry.getInstance();
    const tokenManager = registry.get<any>('token_manager');
    const contextSize = tokenManager?.getContextSize() ?? CONTEXT_SIZES.SMALL;

    return Math.floor(contextSize * TOKEN_MANAGEMENT.EPHEMERAL_READ_MAX_PERCENT);
  }

  /**
   * Get the maximum allowed tokens for user-initiated reads via file mentions
   * Uses full context size since user is explicitly requesting the file
   */
  private getUserInitiatedMaxTokens(): number {
    // Get context size from TokenManager (authoritative source)
    const registry = ServiceRegistry.getInstance();
    const tokenManager = registry.get<any>('token_manager');
    const contextSize = tokenManager?.getContextSize() ?? CONTEXT_SIZES.SMALL;

    // Use 95% of context to leave room for user's message and response
    return Math.floor(contextSize * TOKEN_MANAGEMENT.USER_INITIATED_READ_MAX_PERCENT);
  }

  /**
   * Get the maximum allowed tokens for context file reads
   * Middle ground between user (95%) and agent (20%) initiated reads
   */
  private getContextFileMaxTokens(): number {
    // Get context size from TokenManager (authoritative source)
    const registry = ServiceRegistry.getInstance();
    const tokenManager = registry.get<any>('token_manager');
    const contextSize = tokenManager?.getContextSize() ?? CONTEXT_SIZES.SMALL;

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

  protected async executeImpl(
    args: any,
    _toolCallId?: string,
    isUserInitiated: boolean = false,
    isContextFile: boolean = false,
    executionContext?: ToolExecutionContext
  ): Promise<ToolResult> {
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

    // Check if we have enough remaining context for the non-truncatable result
    // Get remaining context from ServiceRegistry's TokenManager if available
    const registry = this.getExecutionRegistry(executionContext);
    const tokenManager = registry.get<any>('token_manager');
    if (tokenManager) {
      const remainingTokens = this.getRemainingContext(tokenManager);
      if (remainingTokens < estimatedTokens) {
        const examples = filePaths.length === 1
          ? `read(file_paths=["${filePaths[0]}\"], limit=100) or read(file_paths=["${filePaths[0]}\"], offset=-100, limit=100) for last 100 lines`
          : `read(file_paths=["${filePaths[0]}\"], limit=100) or read fewer files`;

        return this.formatErrorResponse(
          `Insufficient context available: read would require ${estimatedTokens.toFixed(1)} tokens but only ${remainingTokens.toFixed(1)} remain. ` +
          `Read results cannot be truncated - you must reduce the read size. ` +
          `Use limit/offset for targeted reading or search with grep/glob. ` +
          `Example: ${examples}`,
          'validation_error',
          `Read operations require full context space - use limit/offset to read smaller sections`
        );
      }
    }

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
    let totalLines = 0;

    for (const filePath of filePaths) {
      try {
        const { content, lineCount } = await this.readFile(filePath, limit, offset, executionContext);
        results.push(content);
        filesRead++;
        totalLines += lineCount;
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
      total_lines: totalLines,
    });

    // Mark result as non-truncatable - read results must never be truncated
    (result as any)._non_truncatable = true;

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
          // Read raw content directly to bypass read cache (cache stubs have wrong token counts)
          const absolutePath = resolvePath(filePath);
          const raw = await fs.readFile(absolutePath, 'utf-8');
          const lines = raw.split('\n');
          const startLine = offset > 0 ? offset - 1 : offset < 0 ? Math.max(0, lines.length + offset) : 0;
          const endLine = startLine + limit;
          const selected = lines.slice(startLine, endLine).join('\n');
          totalEstimate += tokenCounter.count(selected);
        } else {
          const stats = await fs.stat(filePath);
          const tokenEstimate = Math.ceil(stats.size / this.getBytesPerToken(filePath));
          totalEstimate += tokenEstimate;
        }
      } catch {
        continue;
      }
    }

    return totalEstimate;
  }

  /**
   * Get bytes-per-token estimate based on file type.
   * JSON is token-dense (~2 bytes/token due to short keys, braces, colons).
   * Other files average ~4 bytes/token.
   */
  private getBytesPerToken(filePath: string): number {
    const ext = path.extname(filePath).toLowerCase();
    return (ext === '.json' || ext === '.jsonl' || ext === '.jsonc') ? 2 : 4;
  }

  /**
   * Format a byte count as a human-readable size string
   */
  private formatFileSize(bytes: number): string {
    if (bytes >= BYTE_CONVERSIONS.BYTES_PER_MB) {
      return `${(bytes / BYTE_CONVERSIONS.BYTES_PER_MB).toFixed(1)} MB`;
    }
    if (bytes >= BYTE_CONVERSIONS.BYTES_PER_KB) {
      return `${(bytes / BYTE_CONVERSIONS.BYTES_PER_KB).toFixed(1)} KB`;
    }
    return `${bytes} bytes`;
  }

  /**
   * Format selected lines with line numbers (shared by both read paths)
   */
  private formatLinesWithNumbers(
    selectedLines: string[],
    startLine: number,
    totalLines: number,
    absolutePath: string,
    offset: number,
    limit: number
  ): string {
    const endLine = startLine + selectedLines.length;

    let header = `=== ${absolutePath} ===`;
    if (offset !== 0 || (limit > 0 && endLine < totalLines)) {
      header += `\n[Showing lines ${startLine + 1}-${Math.min(endLine, totalLines)} of ${totalLines} total lines]`;
    } else {
      header += `\n[${totalLines} line${totalLines !== 1 ? 's' : ''}]`;
    }

    const formattedLines = selectedLines.map((line, index) => {
      const lineNum = startLine + index + 1;
      return `${String(lineNum).padStart(FORMATTING.LINE_NUMBER_WIDTH)}\t${line}`;
    });

    return `${header}\n${formattedLines.join('\n')}`;
  }

  /**
   * Read a file using streaming for large files (>10MB) with offset/limit.
   * Only accumulates lines in the requested range, avoiding loading the full file into memory.
   */
  private async readFileStreaming(
    absolutePath: string,
    offset: number,
    limit: number
  ): Promise<{ lines: string[]; totalLines: number; startLine: number }> {
    // For negative offset, we need total line count first (two-pass)
    if (offset < 0) {
      const totalLines = await this.countLinesStreaming(absolutePath);
      const startLine = Math.max(0, totalLines + offset);
      const endLine = limit > 0 ? startLine + limit : totalLines;
      const lines = await this.readLinesInRange(absolutePath, startLine, endLine);
      return { lines, totalLines, startLine };
    }

    // Single-pass for positive/zero offset
    const startLine = offset > 0 ? offset - 1 : 0;
    const endLine = limit > 0 ? startLine + limit : Infinity;
    const selectedLines: string[] = [];
    let lineIndex = 0;
    let totalLines = 0;

    const rl = readline.createInterface({
      input: createReadStream(absolutePath, { encoding: 'utf-8' }),
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (lineIndex >= startLine && lineIndex < endLine) {
        // Check binary content on first line
        if (selectedLines.length === 0 && lineIndex === 0) {
          if (isBinaryContent(line.slice(0, 1024))) {
            rl.close();
            return { lines: [], totalLines: 0, startLine: 0 };
          }
        }
        selectedLines.push(line);
      }
      lineIndex++;

      // If we've collected all needed lines and don't need total count,
      // we can stop early (but we need totalLines for the header)
      // Continue counting for accurate total
    }
    totalLines = lineIndex;

    return { lines: selectedLines, totalLines, startLine };
  }

  /**
   * Count total lines in a file via streaming (for negative offset on large files)
   */
  private async countLinesStreaming(absolutePath: string): Promise<number> {
    let count = 0;
    const rl = readline.createInterface({
      input: createReadStream(absolutePath, { encoding: 'utf-8' }),
      crlfDelay: Infinity,
    });
    for await (const _ of rl) {
      count++;
    }
    return count;
  }

  /**
   * Read specific line range from file via streaming
   */
  private async readLinesInRange(absolutePath: string, startLine: number, endLine: number): Promise<string[]> {
    const lines: string[] = [];
    let lineIndex = 0;
    const rl = readline.createInterface({
      input: createReadStream(absolutePath, { encoding: 'utf-8' }),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      if (lineIndex >= startLine && lineIndex < endLine) {
        lines.push(line);
      }
      if (lineIndex >= endLine) {
        rl.close();
        break;
      }
      lineIndex++;
    }
    return lines;
  }

  /**
   * Read a single file with line numbers
   */
  private async readFile(
    filePath: string,
    limit: number,
    offset: number,
    executionContext?: ToolExecutionContext
  ): Promise<{ content: string; lineCount: number }> {
    // Resolve absolute path
    const absolutePath = resolvePath(filePath);

    // Validate focus constraint if active
    const registry = this.getExecutionRegistry(executionContext);
    const readScopeId = this.getReadScopeId(executionContext);
    const focusManager = registry.get<FocusManager>('focus_manager');

    if (focusManager && focusManager.isFocused()) {
      const validation = await focusManager.validatePathInFocus(absolutePath);
      if (!validation.success) {
        throw new Error(validation.message);
      }
    }

    // Block device files that could hang or produce infinite output
    if (isBlockedDevicePath(absolutePath)) {
      throw new Error(
        `Cannot read device file: ${absolutePath}. Device files like /dev/zero or /dev/random ` +
        `produce infinite output or block indefinitely.`
      );
    }

    // Validate file exists and is a file
    const validation = await validateIsFile(absolutePath);
    if (!validation.valid) {
      throw new Error(validation.error);
    }

    // Pre-read size gate — reject files over absolute max before reading into memory
    const stat = await fs.stat(absolutePath);
    if (stat.size > TOOL_LIMITS.ABSOLUTE_MAX_FILE_SIZE) {
      throw new Error(
        `File too large: ${absolutePath} is ${this.formatFileSize(stat.size)} ` +
        `(exceeds ${this.formatFileSize(TOOL_LIMITS.ABSOLUTE_MAX_FILE_SIZE)} limit). ` +
        `Use offset and limit to read specific portions, e.g., ` +
        `read(file_paths=["${filePath}"], offset=1, limit=200) for the first 200 lines.`
      );
    }

    // Check read deduplication cache — return stub if file unchanged since last read
    const readCache = registry.get<ReadCache>('read_cache');
    if (readCache) {
      const cached = readCache.check(absolutePath, stat.mtimeMs, offset, limit, readScopeId);
      if (cached) {
        // Still track read state so edit validation works
        const readStateManager = registry.get<ReadStateManager>('read_state_manager');
        if (readStateManager) {
          const cachedStartLine = offset <= 0 ? 1 : offset;
          const cachedEndLine = limit > 0
            ? Math.min(cachedStartLine + limit - 1, cached.totalLines)
            : cached.totalLines;
          readStateManager.trackRead(absolutePath, cachedStartLine, cachedEndLine, readScopeId);
        }
        return {
          content: `=== ${absolutePath} ===\n[File unchanged since last read (${cached.lineCount} lines). Content already in conversation context.]`,
          lineCount: 0, // Signal to UI that this is a cache hit
        };
      }
    }

    // Use streaming path for large files with offset/limit to avoid loading into memory
    if (stat.size >= TOOL_LIMITS.STREAMING_THRESHOLD && (limit > 0 || offset !== 0)) {
      const { lines: streamedLines, totalLines: streamedTotal, startLine: streamedStart } =
        await this.readFileStreaming(absolutePath, offset, limit);

      // Binary file detected during streaming
      if (streamedLines.length === 0 && streamedTotal === 0) {
        return {
          content: `=== ${absolutePath} ===\n[Binary file - content not displayed]`,
          lineCount: 0,
        };
      }

      const formattedContent = this.formatLinesWithNumbers(
        streamedLines, streamedStart, streamedTotal, absolutePath, offset, limit
      );

      // Track read state
      const readStateManager = registry.get<ReadStateManager>('read_state_manager');
      if (readStateManager) {
        readStateManager.trackRead(absolutePath, streamedStart + 1, streamedStart + streamedLines.length, readScopeId);
      }

      // Record in read cache
      if (readCache) {
        readCache.record({
          scopeId: readScopeId,
          filePath: absolutePath,
          mtimeMs: stat.mtimeMs,
          offset,
          limit,
          lineCount: streamedLines.length,
          totalLines: streamedTotal,
          lastAccessTime: Date.now(),
        });
      }

      return { content: formattedContent, lineCount: streamedLines.length };
    }

    // Read file content (standard path for files < 10MB)
    const content = await fs.readFile(absolutePath, 'utf-8');

    // Check for binary content
    if (isBinaryContent(content)) {
      return {
        content: `=== ${absolutePath} ===\n[Binary file - content not displayed]`,
        lineCount: 0,
      };
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
        return {
          content: `=== ${absolutePath} ===\n` +
            `[Cannot read from offset ${offset}: file only has ${totalLines} line${totalLines !== 1 ? 's' : ''}. ` +
            `Try reading from the beginning (offset=1)` +
            (limit ? `, or offset=${lastPageStart} to read the last ${Math.min(limit, totalLines)} lines.` : '.') +
            `]`,
          lineCount: totalLines,
        };
      }
    } else {
      // Zero offset: start from beginning
      startLine = 0;
    }

    // Apply limit
    const endLine = limit > 0 ? startLine + limit : lines.length;
    const selectedLines = lines.slice(startLine, endLine);

    // Use shared formatting helper
    const formattedContent = this.formatLinesWithNumbers(
      selectedLines, startLine, totalLines, absolutePath, offset, limit
    );

    // Track read state for validation by edit tools
    const readStateManager = registry.get<ReadStateManager>('read_state_manager');
    if (readStateManager) {
      // Track the lines that were read (1-indexed)
      const startLineNumber = startLine + 1;
      const endLineNumber = Math.min(endLine, totalLines);
      readStateManager.trackRead(absolutePath, startLineNumber, endLineNumber, readScopeId);
    }

    // Record in read cache for future deduplication
    if (readCache) {
      readCache.record({
        scopeId: readScopeId,
        filePath: absolutePath,
        mtimeMs: stat.mtimeMs,
        offset,
        limit,
        lineCount: selectedLines.length,
        totalLines,
        lastAccessTime: Date.now(),
      });
    }

    return {
      content: formattedContent,
      lineCount: selectedLines.length,
    };
  }


  /**
   * Format subtext for display in UI
   * Shows: [description] (file1.txt - N lines) or (file1.txt, file2.txt - N lines)
   * Uses actual line count from result when available
   */
  formatSubtext(args: Record<string, any>, result?: any): string | null {
    const filePaths = args.file_paths;
    const description = args.description as string;

    if (!filePaths) {
      return null;
    }

    // Extract filenames (basename only)
    const paths = Array.isArray(filePaths) ? filePaths : [filePaths];
    const filenames = paths.map((p: string) => {
      const parts = p.split('/');
      return parts[parts.length - 1] || p;
    });

    // Build line count info
    let lineCountInfo = '';
    if (result?.total_lines !== undefined) {
      // Use actual line count from result
      const count = result.total_lines;
      lineCountInfo = ` - ${count} line${count !== 1 ? 's' : ''}`;
    }

    const filenamesStr = filenames.length === 1
      ? `(${filenames[0]}${lineCountInfo})`
      : `(${filenames.join(', ')}${lineCountInfo})`;

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
