/**
 * LineEditTool - Line-based file editing (Batch-only design)
 *
 * Performs precise line-based operations: insert, delete, replace.
 * Uses 1-indexed line numbers (human-friendly).
 * All edits are processed as batches for atomicity and consistency.
 */

import { BaseTool } from './BaseTool.js';
import { ToolResult, FunctionDefinition } from '../types/index.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { formatError } from '../utils/errorUtils.js';
import { resolvePath } from '../utils/pathUtils.js';
import { checkFileAfterModification } from '../utils/fileCheckUtils.js';
import { isPathWithinCwd } from '../security/PathSecurity.js';
import { TEXT_LIMITS, FORMATTING } from '../config/constants.js';
import * as fs from 'fs/promises';
import { ServiceRegistry } from '../services/ServiceRegistry.js';
import { ReadStateManager } from '../services/ReadStateManager.js';

type LineOperation = 'insert' | 'delete' | 'replace';

/**
 * Single edit operation in a batch
 */
interface EditOperation {
  operation: LineOperation;
  line_number: number;
  content?: string;      // Required for insert/replace
  num_lines?: number;    // For delete/replace, default: 1
}

export class LineEditTool extends BaseTool {
  readonly name = 'line-edit';
  readonly displayName = 'Edit Line';
  readonly description =
    'Edit files by line number with insert, delete, and replace operations. Always accepts an array of edits for atomic processing. Line numbers are 1-indexed. Edits are automatically sorted and applied bottom-to-top to prevent line shifting issues.';
  readonly requiresConfirmation = true; // Destructive operation
  readonly hideOutput = true; // Hide output from result preview

  constructor(activityStream: ActivityStream) {
    super(activityStream);
  }

  /**
   * Validate LineEditTool arguments
   */
  validateArgs(args: Record<string, unknown>): { valid: boolean; error?: string; error_type?: string; suggestion?: string } | null {
    // Validate path
    const filePath = args.file_path;
    if (!filePath || typeof filePath !== 'string') {
      return null; // Let other validation catch this
    }

    try {
      const absolutePath = resolvePath(filePath);
      if (!isPathWithinCwd(absolutePath)) {
        return {
          valid: false,
          error: 'Path is outside the current working directory',
          error_type: 'security_error',
          suggestion: 'File paths must be within the current working directory. Use relative paths like "src/file.ts"',
        };
      }
    } catch (error) {
      // Path resolution failed - let the tool handle it
      return null;
    }

    // Validate line_number parameter
    if (args.line_number !== undefined && args.line_number !== null) {
      const lineNumber = Number(args.line_number);
      if (isNaN(lineNumber) || lineNumber < 1) {
        return {
          valid: false,
          error: 'line_number must be >= 1 (line numbers are 1-indexed)',
          error_type: 'validation_error',
          suggestion: 'Line numbers are 1-indexed. Example: line_number=10',
        };
      }
      if (lineNumber > 1000000) {
        return {
          valid: false,
          error: 'line_number is unreasonably large (max 1000000)',
          error_type: 'validation_error',
          suggestion: 'Check that line_number is correct',
        };
      }
    }

    // Validate num_lines for delete operation
    if (args.operation === 'delete' && args.num_lines !== undefined && args.num_lines !== null) {
      const numLines = Number(args.num_lines);
      if (isNaN(numLines) || numLines < 1) {
        return {
          valid: false,
          error: 'num_lines must be >= 1 for delete operation',
          error_type: 'validation_error',
          suggestion: 'Example: num_lines=5 (delete 5 lines)',
        };
      }
    }

    return null;
  }

  /**
   * Validate before permission request
   * Checks if target lines have been read for all edits in the batch
   */
  async validateBeforePermission(args: any): Promise<ToolResult | null> {
    const filePath = args.file_path as string;
    const edits = args.edits as EditOperation[] | undefined;

    if (!edits || !Array.isArray(edits) || edits.length === 0) {
      return null; // Skip validation if no edits provided (will be caught in executeImpl)
    }

    const absolutePath = resolvePath(filePath);
    const registry = ServiceRegistry.getInstance();
    const readStateManager = registry.get<ReadStateManager>('read_state_manager');

    if (!readStateManager) {
      return null; // No read state manager, skip validation
    }

    try {
      const fileContent = await fs.readFile(absolutePath, 'utf-8');
      const totalLines = fileContent.split('\n').length;

      // Validate read state for each edit
      for (let i = 0; i < edits.length; i++) {
        const edit = edits[i];
        const editNum = i + 1;

        if (!edit || !edit.operation || !edit.line_number) {
          continue; // Skip invalid edits (will be caught in executeImpl)
        }

        // Special case: inserting into an empty file
        if (edit.operation === 'insert' && fileContent.length === 0 && edit.line_number === 1) {
          continue; // Skip validation for empty file insert at line 1
        }

        const numLinesRaw = Number(edit.num_lines);
        const numLines = edit.num_lines === undefined || edit.num_lines === null || isNaN(numLinesRaw) ? 1 : numLinesRaw;

        const validationRange = this.getValidationRange(edit.operation, edit.line_number, numLines, totalLines);
        const validation = readStateManager.validateLinesRead(
          absolutePath,
          validationRange.start,
          validationRange.end
        );

        if (!validation.success) {
          const rangeDesc = validationRange.start === validationRange.end
            ? `line ${validationRange.start}`
            : `lines ${validationRange.start}-${validationRange.end}`;

          return this.formatErrorResponse(
            `Edit ${editNum}: Lines not read. Cannot ${edit.operation} ${rangeDesc} without reading first. Use read(file_paths=["${filePath}"], offset=${validationRange.start}, limit=${validationRange.end - validationRange.start + 1})`,
            'validation_error'
          );
        }
      }

      return null; // All validations passed
    } catch (error) {
      // File doesn't exist or can't be read - let executeImpl handle this
      return null;
    }
  }

  /**
   * Provide custom function definition (Batch-only design)
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
              description: 'Absolute or relative path to the file to edit',
            },
            edits: {
              type: 'array',
              description: 'Array of edit operations to apply atomically. Edits are sorted and applied bottom-to-top automatically to prevent line shifting issues. Each edit requires: operation (insert/delete/replace), line_number (1-indexed), content (for insert/replace), num_lines (for delete/replace, default 1).',
              items: {
                type: 'object',
                properties: {
                  operation: {
                    type: 'string',
                    description: 'Operation: insert, delete, or replace',
                  },
                  line_number: {
                    type: 'integer',
                    description: 'Line number (1-indexed)',
                  },
                  content: {
                    type: 'string',
                    description: 'Content for insert/replace operations',
                  },
                  num_lines: {
                    type: 'integer',
                    description: 'Number of lines to delete/replace (default: 1)',
                  },
                },
                required: ['operation', 'line_number'],
              },
            },
            show_updated_context: {
              type: 'boolean',
              description: 'Include the updated file content in the response (default: false). Useful to see results immediately without re-reading the file.',
            },
          },
          required: ['file_path', 'edits'],
        },
      },
    };
  }

  /**
   * Preview batch edits by applying them in memory and showing the diff
   */
  async previewChanges(args: any, callId?: string): Promise<void> {
    await super.previewChanges(args, callId);

    const filePath = args.file_path as string;
    const edits = args.edits as EditOperation[] | undefined;

    if (!filePath || !edits || !Array.isArray(edits) || edits.length === 0) {
      return; // Skip preview if invalid args
    }

    const absolutePath = resolvePath(filePath);

    await this.safelyEmitDiffPreview(
      absolutePath,
      async () => {
        await fs.access(absolutePath);
        const fileContent = await fs.readFile(absolutePath, 'utf-8');

        // Detect line ending style
        const hasWindowsLineEndings = fileContent.includes('\r\n');
        const lineEnding = hasWindowsLineEndings ? '\r\n' : '\n';

        // Split into lines
        const lines = fileContent.split('\n').map((line, index, arr) => {
          if (index === arr.length - 1 && !fileContent.endsWith('\n')) {
            return line;
          }
          return line.replace(/\r$/, '');
        });

        // Sort edits descending by line number
        const sortedEdits = [...edits].sort((a, b) => b.line_number - a.line_number);

        // Apply all edits in memory for preview
        let modifiedLines = [...lines];

        for (const edit of sortedEdits) {
          const content = (edit.content as string) ?? '';
          const numLinesRaw = Number(edit.num_lines);
          const numLines = edit.num_lines === undefined || edit.num_lines === null || isNaN(numLinesRaw) ? 1 : numLinesRaw;

          switch (edit.operation) {
            case 'insert':
              modifiedLines = this.performInsert(modifiedLines, edit.line_number, content);
              break;
            case 'delete':
              const deleteResult = this.performDelete(modifiedLines, edit.line_number, numLines, modifiedLines.length);
              if (deleteResult.error) {
                throw new Error('Delete operation would fail');
              }
              modifiedLines = deleteResult.lines!;
              break;
            case 'replace':
              const replaceResult = this.performReplace(modifiedLines, edit.line_number, content, numLines, modifiedLines.length);
              if (replaceResult.error) {
                throw new Error('Replace operation would fail');
              }
              modifiedLines = replaceResult.lines!;
              break;
            default:
              throw new Error('Invalid operation');
          }
        }

        const modifiedContent = modifiedLines.join(lineEnding);
        return { oldContent: fileContent, newContent: modifiedContent };
      },
      'line-edit',
      edits.length
    );
  }

  /**
   * Execute batch edits - single code path for all edits
   */
  protected async executeImpl(args: any): Promise<ToolResult> {
    this.captureParams(args);

    const filePath = args.file_path as string;
    const edits = args.edits as EditOperation[] | undefined;
    const showUpdatedContext = args.show_updated_context === true;

    // Validate required parameters
    if (!filePath) {
      return this.formatErrorResponse(
        'file_path parameter is required',
        'validation_error',
        'Example: line_edit(file_path="foo.ts", edits=[{operation:"replace", line_number:10, content:"new"}])'
      );
    }

    if (!edits || !Array.isArray(edits) || edits.length === 0) {
      return this.formatErrorResponse(
        'edits array required with at least one operation',
        'validation_error',
        'Example: line_edit(file_path="foo.ts", edits=[{operation:"replace", line_number:10, content:"new"}])'
      );
    }

    // Execute batch edits (everything goes through this)
    return this.executeBatchEdits(filePath, edits, showUpdatedContext);
  }

  /**
   * Execute batch edits atomically
   * All edits are validated upfront, sorted by line number descending, then applied
   */
  private async executeBatchEdits(
    filePath: string,
    edits: EditOperation[],
    showUpdatedContext: boolean
  ): Promise<ToolResult> {
    // Step 1: Resolve absolute path
    const absolutePath = resolvePath(filePath);

    try {
      // Step 2: Validate file exists and is a file
      try {
        await fs.access(absolutePath);
      } catch {
        return this.formatErrorResponse(
          `File not found: ${filePath}`,
          'user_error',
          'Check that the file path is correct'
        );
      }

      const stats = await fs.stat(absolutePath);
      if (!stats.isFile()) {
        return this.formatErrorResponse(
          `Not a file: ${filePath}`,
          'validation_error'
        );
      }

      // Step 3: Read original file content and detect line endings
      const fileContent = await fs.readFile(absolutePath, 'utf-8');

      // Detect line ending style (CRLF vs LF)
      const hasWindowsLineEndings = fileContent.includes('\r\n');
      const lineEnding = hasWindowsLineEndings ? '\r\n' : '\n';

      // Split into lines, removing any \r from line endings
      const lines = fileContent.split('\n').map((line, index, arr) => {
        if (index === arr.length - 1 && !fileContent.endsWith('\n')) {
          return line;
        }
        return line.replace(/\r$/, '');
      });
      const totalLines = lines.length;

      // Step 4: Validate ALL edits atomically
      const validationErrors: string[] = [];
      const registry = ServiceRegistry.getInstance();
      const readStateManager = registry.get<ReadStateManager>('read_state_manager');

      // Loop through all edits and collect ALL validation errors
      for (let i = 0; i < edits.length; i++) {
        const edit = edits[i];
        const editNum = i + 1; // Use 1-based numbering for user-facing errors

        // Validate edit object exists
        if (!edit) {
          validationErrors.push(`Edit ${editNum}: undefined edit object`);
          continue;
        }

        // Validate operation is valid
        if (!edit.operation || !['insert', 'delete', 'replace'].includes(edit.operation)) {
          validationErrors.push(`Edit ${editNum}: Invalid operation '${edit.operation}' (must be insert, delete, or replace)`);
          continue;
        }

        // Validate line_number exists and is valid
        if (!edit.line_number || edit.line_number < 1) {
          validationErrors.push(`Edit ${editNum}: line_number must be >= 1`);
          continue;
        }

        // Validate line_number is within file bounds (for insert, allow totalLines+1 to append)
        const maxLineNumber = edit.operation === 'insert' ? totalLines + 1 : totalLines;
        if (edit.line_number > maxLineNumber) {
          validationErrors.push(`Edit ${editNum}: line_number ${edit.line_number} does not exist (file has ${totalLines} line${totalLines !== 1 ? 's' : ''})`);
          continue;
        }

        // Validate content exists for insert/replace
        const content = (edit.content as string) ?? '';
        if ((edit.operation === 'insert' || edit.operation === 'replace') && !content) {
          validationErrors.push(`Edit ${editNum}: content parameter is required for ${edit.operation} operation`);
          continue;
        }

        // Validate num_lines for delete/replace
        const numLinesRaw = Number(edit.num_lines);
        const numLines = edit.num_lines === undefined || edit.num_lines === null || isNaN(numLinesRaw) ? 1 : numLinesRaw;

        if ((edit.operation === 'delete' || edit.operation === 'replace') && numLines < 1) {
          validationErrors.push(`Edit ${editNum}: num_lines must be >= 1 for ${edit.operation} operation`);
          continue;
        }

        // Validate that delete/replace operations don't exceed file bounds
        if (edit.operation === 'delete' || edit.operation === 'replace') {
          const endLine = edit.line_number + numLines - 1;
          if (endLine > totalLines) {
            validationErrors.push(`Edit ${editNum}: Cannot ${edit.operation} ${numLines} line(s) starting at line ${edit.line_number} (file has ${totalLines} line${totalLines !== 1 ? 's' : ''})`);
            continue;
          }
        }

        // Validate read state using ReadStateManager
        if (readStateManager) {
          // Special case: inserting into an empty file at line 1
          if (edit.operation === 'insert' && fileContent.length === 0 && edit.line_number === 1) {
            // Skip read state validation for empty file insert
          } else {
            const validationRange = this.getValidationRange(edit.operation, edit.line_number, numLines, totalLines);
            const validation = readStateManager.validateLinesRead(
              absolutePath,
              validationRange.start,
              validationRange.end
            );

            if (!validation.success) {
              const rangeDesc = validationRange.start === validationRange.end
                ? `line ${validationRange.start}`
                : `lines ${validationRange.start}-${validationRange.end}`;
              validationErrors.push(`Edit ${editNum}: Cannot ${edit.operation} at line ${edit.line_number}: ${rangeDesc} not read`);
            }
          }
        }
      }

      // Step 5: Check for duplicate line numbers across all edits (single-pass O(n))
      const seen = new Set<number>();
      const duplicates = new Set<number>();
      for (const edit of edits) {
        if (seen.has(edit.line_number)) {
          duplicates.add(edit.line_number);
        }
        seen.add(edit.line_number);
      }
      if (duplicates.size > 0) {
        const sortedDuplicates = [...duplicates].sort((a, b) => a - b);
        validationErrors.push(
          `Duplicate line numbers detected: ${sortedDuplicates.join(', ')}. Each line can only be edited once per batch.`
        );
      }

      // If ANY validation failed, return error without applying ANY edits (atomic validation)
      if (validationErrors.length > 0) {
        return this.formatErrorResponse(
          `Batch edit validation failed with ${validationErrors.length} error(s):\n${validationErrors.map(e => `  • ${e}`).join('\n')}`,
          'validation_error',
          'All edits must pass validation before any are applied. If edits fail, try fewer operations to narrow down the issue. Prefer many small tool calls over one monolithic call.'
        );
      }

      // Step 6: Sort edits descending by line number (prevents line shifting issues)
      const sortedEdits = [...edits].sort((a, b) => b.line_number - a.line_number);

      // Step 7: Apply edits sequentially (bottom-to-top)
      let modifiedLines = [...lines];
      const appliedEdits: string[] = [];

      for (const edit of sortedEdits) {
        const content = (edit.content as string) ?? '';
        const numLinesRaw = Number(edit.num_lines);
        const numLines = edit.num_lines === undefined || edit.num_lines === null || isNaN(numLinesRaw) ? 1 : numLinesRaw;

        switch (edit.operation) {
          case 'insert':
            modifiedLines = this.performInsert(modifiedLines, edit.line_number, content);
            const insertedLineCount = content.split('\n').length;
            appliedEdits.push(`Inserted ${insertedLineCount} line(s) at line ${edit.line_number}`);
            break;

          case 'delete':
            const deleteResult = this.performDelete(modifiedLines, edit.line_number, numLines, modifiedLines.length);
            if (deleteResult.error) {
              // This shouldn't happen since we validated upfront, but handle gracefully
              return this.formatErrorResponse(deleteResult.error, 'validation_error');
            }
            modifiedLines = deleteResult.lines!;
            appliedEdits.push(`Deleted ${numLines} line(s) starting at line ${edit.line_number}`);
            break;

          case 'replace':
            const replaceResult = this.performReplace(modifiedLines, edit.line_number, content, numLines, modifiedLines.length);
            if (replaceResult.error) {
              // This shouldn't happen since we validated upfront, but handle gracefully
              return this.formatErrorResponse(replaceResult.error, 'validation_error');
            }
            modifiedLines = replaceResult.lines!;
            const newLineCount = content.split('\n').length;
            appliedEdits.push(
              numLines === 1
                ? `Replaced line ${edit.line_number} with ${newLineCount} line(s)`
                : `Replaced ${numLines} line(s) starting at line ${edit.line_number} with ${newLineCount} line(s)`
            );
            break;
        }
      }

      // Step 8: Finalize the edit (write, patch, diff, track)
      const modifiedContent = modifiedLines.join(lineEnding);
      const { patchNumber, diff } = await this.finalizeEdit({
        absolutePath,
        originalContent: fileContent,
        modifiedContent,
        operationType: 'line-edit',
        showUpdatedContext,
        readStateManager,
      });

      // Step 9: Build success response
      const successMessage =
        `Batch edit completed: ${edits.length} operation(s) applied\n\n` +
        appliedEdits.reverse().join('\n'); // Reverse to show in original order (top-to-bottom)

      const response = this.formatSuccessResponse({
        content: successMessage,
        file_path: absolutePath,
        edits_applied: edits.length,
        lines_before: totalLines,
        lines_after: modifiedLines.length,
        diff,
      });

      // Add system reminder about invalidated lines
      response.system_reminder =
        'All line numbers have been invalidated due to edits. To edit again, either re-read the file or use show_updated_context=true';

      // Add patch information to result if patch was captured
      if (patchNumber !== null) {
        response.patch_number = patchNumber;
      }

      // Include updated file content if requested
      if (showUpdatedContext) {
        response.updated_content = modifiedContent;
      }

      // Step 10: Check file for syntax/parse errors after modification
      const checkResult = await checkFileAfterModification(absolutePath);
      if (checkResult) {
        response.file_check = checkResult;
      }

      return response;
    } catch (error) {
      return this.formatErrorResponse(
        `Failed to perform batch edit: ${formatError(error)}`,
        'system_error'
      );
    }
  }

  /**
   * Get validation range for read-state checking
   * Returns the lines that need to have been read for each operation type
   */
  private getValidationRange(
    operation: LineOperation,
    lineNumber: number,
    numLines: number,
    totalLines: number
  ): { start: number; end: number } {
    switch (operation) {
      case 'insert':
        // For insert, validate we've read the context around insertion point
        return {
          start: Math.max(1, lineNumber - 1),
          end: Math.min(totalLines, lineNumber)
        };

      case 'delete':
        return {
          start: lineNumber,
          end: Math.min(totalLines, lineNumber + numLines - 1)
        };

      case 'replace':
        return {
          start: lineNumber,
          end: Math.min(totalLines, lineNumber + numLines - 1)
        };

      default:
        return { start: lineNumber, end: lineNumber };
    }
  }

  /**
   * Insert lines at the specified position
   */
  private performInsert(lines: string[], lineNumber: number, content: string): string[] {
    const newLines = content.split('\n');
    const beforeLines = lines.slice(0, lineNumber - 1);
    const afterLines = lines.slice(lineNumber - 1);
    return [...beforeLines, ...newLines, ...afterLines];
  }

  /**
   * Delete lines starting at the specified position
   */
  private performDelete(
    lines: string[],
    lineNumber: number,
    numLines: number,
    totalLines: number
  ): { lines?: string[]; error?: string } {
    const endLine = lineNumber + numLines - 1;

    if (endLine > totalLines) {
      const context = this.getLineContext(lines, totalLines, Math.max(1, totalLines - TEXT_LIMITS.LINE_EDIT_CONTEXT_LINES));
      return {
        error: `Cannot delete ${numLines} line(s) starting at line ${lineNumber} (file has ${totalLines} line${totalLines !== 1 ? 's' : ''}).\n\nLast lines of file:\n${context}\n\nUse the Read tool to see the actual file content.`,
      };
    }

    const beforeLines = lines.slice(0, lineNumber - 1);
    const afterLines = lines.slice(lineNumber + numLines - 1);
    return { lines: [...beforeLines, ...afterLines] };
  }

  /**
   * Replace lines at the specified position
   */
  private performReplace(
    lines: string[],
    lineNumber: number,
    content: string,
    numLines: number = 1,
    totalLines: number
  ): { lines?: string[]; error?: string } {
    const endLine = lineNumber + numLines - 1;

    if (endLine > totalLines) {
      const context = this.getLineContext(lines, totalLines, Math.max(1, totalLines - TEXT_LIMITS.LINE_EDIT_CONTEXT_LINES));
      return {
        error: `Cannot replace ${numLines} line(s) starting at line ${lineNumber} (file has ${totalLines} line${totalLines !== 1 ? 's' : ''}).\n\nLast lines of file:\n${context}\n\nUse the Read tool to see the actual file content.`,
      };
    }

    const newLines = content.split('\n');
    const beforeLines = lines.slice(0, lineNumber - 1);
    const afterLines = lines.slice(lineNumber + numLines - 1);
    return { lines: [...beforeLines, ...newLines, ...afterLines] };
  }

  /**
   * Get context lines for error messages
   */
  private getLineContext(
    lines: string[],
    totalLines: number,
    startLine: number,
    maxLines: number = 5
  ): string {
    const endLine = Math.min(totalLines, startLine + maxLines - 1);
    const contextLines: string[] = [];

    for (let i = startLine; i <= endLine; i++) {
      const lineContent = lines[i - 1];
      if (lineContent === undefined) continue; // Skip undefined lines
      const truncated =
        lineContent.length > TEXT_LIMITS.LINE_CONTENT_DISPLAY_MAX ? lineContent.substring(0, TEXT_LIMITS.LINE_CONTENT_DISPLAY_MAX - 3) + '...' : lineContent;
      contextLines.push(`  ${String(i).padStart(FORMATTING.LINE_NUMBER_WIDTH)}: ${truncated}`);
    }

    return contextLines.join('\n');
  }

  /**
   * Custom result preview for line-edit tool
   */
  getResultPreview(result: ToolResult, maxLines: number = 3): string[] {
    if (!result.success) {
      return super.getResultPreview(result, maxLines);
    }

    const lines: string[] = [];
    const editsApplied = result.edits_applied ?? 0;
    const linesBefore = result.lines_before ?? 0;
    const linesAfter = result.lines_after ?? 0;
    const lineDiff = linesAfter - linesBefore;

    lines.push(`Batch edit: ${editsApplied} operation(s) applied`);

    if (lineDiff !== 0) {
      const sign = lineDiff > 0 ? '+' : '';
      lines.push(`Lines: ${linesBefore} → ${linesAfter} (${sign}${lineDiff})`);
    }

    return lines;
  }
}
