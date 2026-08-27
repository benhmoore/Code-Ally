/**
 * ReadTool - Read one file or line range
 *
 * Reads file contents with line numbering, token estimation, and binary detection.
 */

import { BaseTool } from './BaseTool.js';
import { ToolCapability } from './ToolCapability.js';
import { Message, ToolExecutionContext, ToolResult, FunctionDefinition } from '../types/index.js';
import type { ReadCacheEntry, ReadSelection } from '../services/ReadCache.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { ServiceRegistry } from '../services/ServiceRegistry.js';
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
    'Read file text by line and column.';
  readonly capabilities = [ToolCapability.FsRead] as const;
  readonly isExploratoryTool = true;
  readonly requiresReservedContext = true;
  readonly hideOutput = true; // Hide file content from user, show summary in subtext

  readonly usageGuidance = `**When to use read:**
Locate before loading: use tree/glob to discover files and grep to find symbols or usages, then read the smallest relevant line range. Expand the range only when surrounding behavior is needed; read a whole file when it is small or the task is genuinely cross-cutting.
Default reads stay in context. Use ephemeral=true only for one-time large file inspection (content removed after one turn).
For an exceptionally long line, select it with offset/limit and inspect bounded slices with column_offset/column_limit.
For multi-file exploration, prefer explore() to preserve context. Parallelize only known-small, bounded reads whose combined output is modest; for unknown or large files, grep first and read narrow ranges sequentially.`;

  constructor(activityStream: ActivityStream) {
    super(activityStream);
  }

  /**
   * Validate ReadTool arguments
   */
  validateArgs(args: Record<string, unknown>): { valid: boolean; error?: string; error_type?: string; suggestion?: string } | null {
    if (typeof args.file_path !== 'string' || args.file_path.length === 0) {
      return {
        valid: false,
        error: 'file_path must be one file path',
        error_type: 'validation_error',
        suggestion: 'Issue one read per path. Parallelize only known-small, bounded ranges; otherwise grep first and read narrowly or sequentially.',
      };
    }

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

    for (const [name, minimum] of [['column_offset', 0], ['column_limit', 1]] as const) {
      if (args[name] === undefined || args[name] === null) continue;
      const value = Number(args[name]);
      if (!Number.isInteger(value) || value < minimum) {
        return {
          valid: false,
          error: `${name} must be an integer greater than or equal to ${minimum}`,
          error_type: 'validation_error',
          suggestion: name === 'column_offset'
            ? 'Use column_offset=0 to start at the beginning of each selected line'
            : 'Use column_limit with limit=1 to inspect a bounded slice of an exceptionally long line',
        };
      }
    }

    return null;
  }

  /**
   * The conversation space this read must fit inside.
   *
   * Prefer the owning agent's published budget: it accounts for the fixed
   * request overhead (system prompt + tool schemas + dynamic context) that a
   * raw context-window fraction ignores. On a 16k window that overhead can be
   * ~45% of the window, so a "20% of context" cap exceeds half of the space
   * actually available — a single legal read then cannot survive compaction,
   * and the agent loops re-reading what it just lost.
   *
   * Falls back to the raw window when no agent has published a budget (direct
   * tool invocation and tests), where there is no conversation to protect.
   */
  private getBudget(executionContext?: ToolExecutionContext): {
    usable: number;
    maxToolResult: number;
  } {
    const registry = this.getExecutionRegistry(executionContext);
    const tokenManager = registry.get('token_manager');
    const contextSize = tokenManager?.getContextSize() ?? CONTEXT_SIZES.SMALL;
    const published = registry.get('context_budget')?.get(this.getReadScopeId(executionContext));
    if (published && published.usableBudget > 0) {
      return { usable: published.usableBudget, maxToolResult: published.maxToolResultTokens };
    }
    return {
      usable: contextSize,
      maxToolResult: Math.floor(contextSize * TOKEN_MANAGEMENT.READ_CONTEXT_MAX_PERCENT),
    };
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
   * Maximum tokens for an agent-initiated read: the largest result that is
   * guaranteed to survive the next compaction.
   */
  private getMaxTokens(executionContext?: ToolExecutionContext): number {
    return this.getBudget(executionContext).maxToolResult;
  }

  /**
   * Ephemeral reads are removed after one turn, so they may use most of the
   * usable space — but never more, or the request cannot be sent at all.
   */
  private getEphemeralMaxTokens(executionContext?: ToolExecutionContext): number {
    return Math.floor(this.getBudget(executionContext).usable * TOKEN_MANAGEMENT.EPHEMERAL_READ_MAX_PERCENT);
  }

  /**
   * Get the maximum allowed tokens for user-initiated reads via file mentions
   * The user explicitly asked for this file, so allow nearly all usable space.
   */
  private getUserInitiatedMaxTokens(executionContext?: ToolExecutionContext): number {
    return Math.floor(this.getBudget(executionContext).usable * TOKEN_MANAGEMENT.USER_INITIATED_READ_MAX_PERCENT);
  }

  /**
   * Get the maximum allowed tokens for context file reads
   * Middle ground between user-initiated and agent-initiated reads.
   */
  private getContextFileMaxTokens(executionContext?: ToolExecutionContext): number {
    return Math.floor(this.getBudget(executionContext).usable * TOKEN_MANAGEMENT.CONTEXT_FILE_READ_MAX_PERCENT);
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
            file_path: {
              type: 'string',
              format: 'local-path',
              description: 'Path to file',
            },
            limit: {
              type: 'integer',
              description: 'Line count (0 = all)',
            },
            offset: {
              type: 'integer',
              description: 'Start line (1-based; negative from end)',
            },
            column_offset: {
              type: 'integer',
              description: 'Start column (0-based code points)',
            },
            column_limit: {
              type: 'integer',
              description: 'Code points per line',
            },
            ephemeral: {
              type: 'boolean',
              description: 'Allow a larger one-turn result, then discard it',
            },
          },
          required: ['file_path'],
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

    const filePath = args.file_path;
    const limit = args.limit !== undefined ? Number(args.limit) : 0;
    const offset = args.offset !== undefined ? Number(args.offset) : 0;
    const columnOffset = args.column_offset !== undefined ? Number(args.column_offset) : 0;
    const columnLimit = args.column_limit !== undefined ? Number(args.column_limit) : 0;
    const selection: ReadSelection = {
      lineOffset: offset,
      lineLimit: limit,
      columnOffset,
      columnLimit,
    };
    const ephemeral = args.ephemeral === true;

    if (typeof filePath !== 'string' || filePath.length === 0) {
      return this.formatErrorResponse(
        'file_path must be one file path',
        'validation_error',
        'Issue one read per path. Parallelize only known-small, bounded ranges; otherwise grep first and read narrowly or sequentially.'
      );
    }

    const estimatedTokens = await this.estimateTokens(filePath, selection);

    // Check if we have enough remaining context for the non-truncatable result
    // Get remaining context from ServiceRegistry's TokenManager if available
    const registry = this.getExecutionRegistry(executionContext);
    const tokenManager = registry.get('token_manager');
    if (tokenManager) {
      const remainingTokens = this.getRemainingContext(tokenManager);
      if (remainingTokens < estimatedTokens) {
        const examples = this.getNarrowReadExamples(filePath, remainingTokens);

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
      maxTokens = this.getContextFileMaxTokens(executionContext);
    } else if (isUserInitiated) {
      maxTokens = this.getUserInitiatedMaxTokens(executionContext);
    } else {
      maxTokens = ephemeral
        ? this.getEphemeralMaxTokens(executionContext)
        : this.getMaxTokens(executionContext);
    }

    if (estimatedTokens > maxTokens) {
      const examples = this.getNarrowReadExamples(filePath, maxTokens);

      const ephemeralHint = !ephemeral && !isUserInitiated && !isContextFile
        ? ' As a LAST RESORT for one-time inspection only: ephemeral=true (WARNING: content removed after one turn, you will lose access).'
        : '';

      // Suggest a line budget that actually fits, rather than a fixed 100.
      // Source averages roughly 12 tokens per line; leave headroom under the cap.
      const suggestedLimit = Math.max(20, Math.floor((maxTokens * 0.85) / 12));
      const targeted = `first locate the relevant symbol with grep, then read(file_path="${filePath}", offset=<matching line>, limit=${suggestedLimit})`;

      return this.formatErrorResponse(
        `File too large: estimated ${estimatedTokens.toFixed(1)} tokens exceeds the ${maxTokens}-token limit for this read. ` +
        `This is a per-result retention limit derived from the available conversation budget; it does not mean the overall context is exhausted. ` +
        `Do not page through the file by default: ${targeted}. ` +
        `Use sequential offset/limit chunks only when the task genuinely requires whole-file inspection. ` +
        `For an exceptionally long single line, use column_offset and column_limit to inspect a bounded slice. ` +
        `Alternative: ${examples}.${ephemeralHint}`,
        'validation_error',
        `Locate with grep/glob, then read the smallest relevant offset/limit range`
      );
    }

    let content: string;
    let totalLines: number;
    try {
      const read = await this.readFile(filePath, selection, executionContext);
      content = read.content;
      totalLines = read.lineCount;
    } catch (error) {
      return this.formatErrorResponse(
        `Failed to read ${filePath}: ${formatError(error)}`,
        'file_error'
      );
    }

    const result = this.formatSuccessResponse({
      content,
      files_read: 1,
      files_failed: 0,
      partial_failure: false,
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
   * Estimate tokens for the requested file range.
   */
  private async estimateTokens(
    filePath: string,
    selection: ReadSelection,
  ): Promise<number> {
    try {
      const { lineLimit, lineOffset, columnOffset, columnLimit } = selection;
      if (lineLimit > 0 || columnOffset > 0 || columnLimit > 0) {
        // Read raw content directly to bypass read cache (cache stubs have wrong token counts)
        const absolutePath = resolvePath(filePath);
        const raw = await fs.readFile(absolutePath, 'utf-8');
        const lines = raw.split('\n');
        const startLine = lineOffset > 0
          ? lineOffset - 1
          : lineOffset < 0
            ? Math.max(0, lines.length + lineOffset)
            : 0;
        const endLine = lineLimit > 0 ? startLine + lineLimit : lines.length;
        const selected = lines.slice(startLine, endLine);
        return tokenCounter.count(this.selectColumns(selected, columnOffset, columnLimit).join('\n'));
      }
      const stats = await fs.stat(filePath);
      return Math.ceil(stats.size / this.getBytesPerToken(filePath));
    } catch {
      return 0;
    }
  }

  private getNarrowReadExamples(filePath: string, tokenBudget: number): string {
    // Leave ample room for the result envelope, path header, and line number.
    // The subsequent exact token estimate remains authoritative.
    const suggestedColumns = Math.max(64, Math.floor(tokenBudget * 0.5));
    return `read(file_path="${filePath}", limit=100), ` +
      `read(file_path="${filePath}", offset=-100, limit=100) for the last 100 lines, or ` +
      `read(file_path="${filePath}", offset=<line>, limit=1, column_offset=0, column_limit=${suggestedColumns}) for one long line`;
  }

  private selectColumns(lines: string[], columnOffset: number, columnLimit: number): string[] {
    if (columnOffset === 0 && columnLimit === 0) return lines;
    const end = columnLimit > 0 ? columnOffset + columnLimit : undefined;
    return lines.map(line => [...line].slice(columnOffset, end).join(''));
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
    limit: number,
    columnOffset: number = 0,
    columnLimit: number = 0,
  ): string {
    const endLine = startLine + selectedLines.length;

    let header = `=== ${absolutePath} ===`;
    if (offset !== 0 || (limit > 0 && endLine < totalLines)) {
      header += `\n[Showing lines ${startLine + 1}-${Math.min(endLine, totalLines)} of ${totalLines} total lines]`;
    } else {
      header += `\n[${totalLines} line${totalLines !== 1 ? 's' : ''}]`;
    }
    if (columnOffset > 0 || columnLimit > 0) {
      const end = columnLimit > 0 ? columnOffset + columnLimit : 'end';
      header += `\n[Showing columns ${columnOffset}-${end} of each selected line; partial lines do not authorize edits]`;
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
   * A cached read may be served as a dedup stub only while the tool-result
   * message that carried the content is still in the owning agent's active
   * context. Compaction (and ephemeral-read cleanup) can remove it; after that
   * the stub would falsely claim the content is available.
   *
   * When no owning conversation can be resolved (direct invocation, tests),
   * legacy mtime-only dedup applies — without a model conversation there is no
   * context the stub can lie about.
   */
  private isCachedReadStillVisible(
    cached: ReadCacheEntry,
    registry: Pick<ServiceRegistry, 'get'>,
  ): boolean {
    const agent = registry.get('agent') as
      | { getConversationManager?: () => { getMessages(): readonly Message[] } }
      | undefined;
    const conversation = agent?.getConversationManager?.();
    if (!conversation) return true;
    if (!cached.toolCallId) return false;
    return conversation.getMessages().some(message =>
      message.role === 'tool'
      && message.tool_call_id === cached.toolCallId
      && !message.metadata?.contentEvicted);
  }

  /**
   * Read a single file with line numbers
   */
  private async readFile(
    filePath: string,
    selection: ReadSelection,
    executionContext?: ToolExecutionContext
  ): Promise<{ content: string; lineCount: number }> {
    const { lineLimit: limit, lineOffset: offset, columnOffset, columnLimit } = selection;
    // Resolve absolute path
    const absolutePath = resolvePath(filePath);

    // Validate focus constraint if active
    const registry = this.getExecutionRegistry(executionContext);
    const readScopeId = this.getReadScopeId(executionContext);
    const focusManager = registry.get('focus_manager');

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
        `read(file_path="${filePath}", offset=1, limit=200) for the first 200 lines.`
      );
    }

    // Check read deduplication cache — return stub if file unchanged since last read
    // AND the earlier read's content is still present in the active conversation.
    // Compaction can remove the message that carried the content; serving the
    // "already in conversation context" stub after that strands the model with
    // no way to recover the file. Correctness beats token savings: fall through
    // to a fresh read whenever visibility cannot be confirmed.
    const readCache = registry.get('read_cache');
    if (readCache) {
      const cached = readCache.check(absolutePath, stat.mtimeMs, selection, readScopeId);
      if (cached && !this.isCachedReadStillVisible(cached, registry)) {
        readCache.invalidate(absolutePath, readScopeId);
      } else if (cached) {
        // Still track read state so patch validation works
        const readStateManager = registry.get('read_state_manager');
        if (readStateManager && columnOffset === 0 && columnLimit === 0) {
          const cachedStartLine = offset < 0
            ? Math.max(1, cached.totalLines + offset + 1)
            : offset > 0 ? offset : 1;
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

      const selectedLines = this.selectColumns(streamedLines, columnOffset, columnLimit);
      const formattedContent = this.formatLinesWithNumbers(
        selectedLines, streamedStart, streamedTotal, absolutePath, offset, limit, columnOffset, columnLimit
      );

      // Track read state
      const readStateManager = registry.get('read_state_manager');
      if (readStateManager && columnOffset === 0 && columnLimit === 0) {
        readStateManager.trackRead(absolutePath, streamedStart + 1, streamedStart + streamedLines.length, readScopeId);
      }

      // Record in read cache
      if (readCache) {
        readCache.record({
          scopeId: readScopeId,
          filePath: absolutePath,
          mtimeMs: stat.mtimeMs,
          selection,
          lineCount: selectedLines.length,
          totalLines: streamedTotal,
          lastAccessTime: Date.now(),
          toolCallId: this.currentCallId,
        });
      }

      return { content: formattedContent, lineCount: selectedLines.length };
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
    const selectedLines = this.selectColumns(lines.slice(startLine, endLine), columnOffset, columnLimit);

    // Use shared formatting helper
    const formattedContent = this.formatLinesWithNumbers(
      selectedLines, startLine, totalLines, absolutePath, offset, limit, columnOffset, columnLimit
    );

    // Track read state for apply-patch validation
    const readStateManager = registry.get('read_state_manager');
    if (readStateManager && columnOffset === 0 && columnLimit === 0) {
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
        selection,
        lineCount: selectedLines.length,
        totalLines,
        lastAccessTime: Date.now(),
        toolCallId: this.currentCallId,
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
    const filePath = args.file_path;
    const description = args.description as string;

    if (typeof filePath !== 'string' || filePath.length === 0) {
      return null;
    }

    const parts = filePath.split('/');
    const filename = parts[parts.length - 1] || filePath;

    // Build line count info
    let lineCountInfo = '';
    if (result?.total_lines !== undefined) {
      // Use actual line count from result
      const count = result.total_lines;
      lineCountInfo = ` - ${count} line${count !== 1 ? 's' : ''}`;
    }

    const filenameText = `(${filename}${lineCountInfo})`;

    // If description exists, show it first
    if (description) {
      return `${description} ${filenameText}`;
    }

    return filenameText;
  }

  /**
   * Get parameters shown in subtext
   * ReadTool shows both 'file_path' and 'description' in subtext
   */
  getSubtextParameters(): string[] {
    return ['file_path', 'description'];
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
