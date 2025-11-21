/**
 * LineEditTool - Line-based file editing
 *
 * Performs precise line-based operations: insert, delete, replace.
 * Uses 1-indexed line numbers (human-friendly).
 */

import { BaseTool } from './BaseTool.js';
import { ToolResult, FunctionDefinition } from '../types/index.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { formatError } from '../utils/errorUtils.js';
import { resolvePath } from '../utils/pathUtils.js';
import { checkFileAfterModification } from '../utils/fileCheckUtils.js';
import { createUnifiedDiff } from '../utils/diffUtils.js';
import { TEXT_LIMITS, FORMATTING } from '../config/constants.js';
import * as fs from 'fs/promises';
import { ServiceRegistry } from '../services/ServiceRegistry.js';
import { ReadStateManager } from '../services/ReadStateManager.js';

type LineOperation = 'insert' | 'delete' | 'replace';

export class LineEditTool extends BaseTool {
  readonly name = 'line-edit';
  readonly displayName = 'Edit Line';
  readonly description =
    'Edit files by line number with insert, delete, and replace operations. Line numbers are 1-indexed and will shift after edits that change line count.';
  readonly requiresConfirmation = true; // Destructive operation
  readonly hideOutput = true; // Hide output from result preview

  constructor(activityStream: ActivityStream) {
    super(activityStream);
  }

  /**
   * Validate before permission request
   * Checks if target lines have been read
   */
  async validateBeforePermission(args: any): Promise<ToolResult | null> {
    const filePath = args.file_path as string;
    const operation = args.operation as LineOperation;
    const lineNumber = args.line_number as number;
    // Convert to number, default to 1 if undefined/null/NaN
    const numLinesRaw = Number(args.num_lines);
    const numLines = args.num_lines === undefined || args.num_lines === null || isNaN(numLinesRaw) ? 1 : numLinesRaw;

    const absolutePath = resolvePath(filePath);
    const registry = ServiceRegistry.getInstance();
    const readStateManager = registry.get<ReadStateManager>('read_state_manager');

    if (!readStateManager) {
      return null; // No read state manager, skip validation
    }

    try {
      const fileContent = await fs.readFile(absolutePath, 'utf-8');
      const totalLines = fileContent.split('\n').length;

      // Special case: inserting into an empty file
      if (operation === 'insert' && fileContent.length === 0 && lineNumber === 1) {
        return null; // Skip validation for empty file insert
      }

      // Determine which lines need validation
      let validationStartLine: number;
      let validationEndLine: number;

      switch (operation) {
        case 'insert':
          validationStartLine = Math.max(1, lineNumber - 1);
          validationEndLine = Math.min(totalLines, lineNumber);
          break;
        case 'delete':
          validationStartLine = lineNumber;
          validationEndLine = Math.min(totalLines, lineNumber + numLines - 1);
          break;
        case 'replace':
          validationStartLine = lineNumber;
          validationEndLine = Math.min(totalLines, lineNumber + numLines - 1);
          break;
        default:
          return null;
      }

      const validation = readStateManager.validateLinesRead(
        absolutePath,
        validationStartLine,
        validationEndLine
      );

      if (!validation.success) {
        const rangeDesc = validationStartLine === validationEndLine
          ? `line ${validationStartLine}`
          : `lines ${validationStartLine}-${validationEndLine}`;

        return this.formatErrorResponse(
          `Lines not read: Cannot ${operation} ${rangeDesc} without reading first. Use read(file_paths=["${filePath}"], offset=${validationStartLine}, limit=${validationEndLine - validationStartLine + 1})`,
          'validation_error'
        );
      }

      return null; // Validation passed
    } catch (error) {
      // File doesn't exist or can't be read - let executeImpl handle this
      return null;
    }
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
              description: 'Absolute or relative path to the file to edit',
            },
            operation: {
              type: 'string',
              description: 'Operation to perform: insert, delete, or replace',
            },
            line_number: {
              type: 'integer',
              description: 'Line number to operate on (1-indexed). Line numbers shift when edits change line count.',
            },
            content: {
              type: 'string',
              description:
                'Content for insert/replace operations. Can contain \\n for multiple lines.',
            },
            num_lines: {
              type: 'integer',
              description: 'Number of existing lines to remove starting at line_number (default: 1). For replace, new content can be any number of lines.',
            },
            show_updated_context: {
              type: 'boolean',
              description: 'Include the updated file content in the response (default: false). Recommended when making multiple edits to avoid using stale line numbers.',
            },
          },
          required: ['file_path', 'operation', 'line_number'],
        },
      },
    };
  }

  async previewChanges(args: any, callId?: string): Promise<void> {
    await super.previewChanges(args, callId);

    const filePath = args.file_path as string;
    const operation = args.operation as LineOperation;
    const lineNumber = args.line_number as number;
    const content = (args.content as string) ?? '';
    // Convert to number, default to 1 if undefined/null/NaN
    const numLinesRaw = Number(args.num_lines);
    const numLines = args.num_lines === undefined || args.num_lines === null || isNaN(numLinesRaw) ? 1 : numLinesRaw;

    if (!filePath || !operation || !lineNumber) {
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

        // Perform operation for preview
        let modifiedLines: string[];
        switch (operation) {
          case 'insert':
            modifiedLines = this.performInsert(lines, lineNumber, content);
            break;
          case 'delete':
            const deleteResult = this.performDelete(lines, lineNumber, numLines, lines.length);
            if (deleteResult.error) {
              throw new Error('Delete operation would fail'); // Skip preview
            }
            modifiedLines = deleteResult.lines!;
            break;
          case 'replace':
            const replacePreviewResult = this.performReplace(lines, lineNumber, content, numLines, lines.length);
            if (replacePreviewResult.error) {
              throw new Error('Replace operation would fail'); // Skip preview
            }
            modifiedLines = replacePreviewResult.lines!;
            break;
          default:
            throw new Error('Invalid operation');
        }

        const modifiedContent = modifiedLines.join(lineEnding);
        return { oldContent: fileContent, newContent: modifiedContent };
      },
      'line-edit'
    );
  }

  protected async executeImpl(args: any): Promise<ToolResult> {
    // Capture parameters
    this.captureParams(args);

    // Extract and validate parameters
    const filePath = args.file_path as string;
    const operation = args.operation as LineOperation;
    const lineNumber = args.line_number as number;
    const content = (args.content as string) ?? '';
    // Convert to number, default to 1 if undefined/null/NaN, but preserve explicit 0 for validation
    const numLinesRaw = Number(args.num_lines);
    const numLines = args.num_lines === undefined || args.num_lines === null || isNaN(numLinesRaw) ? 1 : numLinesRaw;
    const showUpdatedContext = args.show_updated_context === true; // Default is false

    // Validate file_path
    if (!filePath) {
      return this.formatErrorResponse(
        'file_path parameter is required',
        'validation_error',
        'Example: line-edit(file_path="src/main.ts", operation="replace", line_number=10, content="new line")'
      );
    }

    // Validate operation
    if (!operation) {
      return this.formatErrorResponse(
        'operation parameter is required',
        'validation_error',
        'Must be one of: insert, delete, replace'
      );
    }

    if (!['insert', 'delete', 'replace'].includes(operation)) {
      return this.formatErrorResponse(
        `Invalid operation: ${operation}`,
        'validation_error',
        'Must be one of: insert, delete, replace'
      );
    }

    // Validate line_number
    if (!lineNumber || lineNumber < 1) {
      return this.formatErrorResponse(
        'line_number must be >= 1',
        'validation_error',
        'Line numbers are 1-indexed'
      );
    }

    // Validate content for insert/replace operations
    if ((operation === 'insert' || operation === 'replace') && !content) {
      return this.formatErrorResponse(
        `content parameter is required for ${operation} operation`,
        'validation_error'
      );
    }

    // Validate num_lines for delete operation
    if (operation === 'delete' && numLines < 1) {
      return this.formatErrorResponse(
        'num_lines must be >= 1 for delete operation',
        'validation_error'
      );
    }

    // Resolve absolute path
    const absolutePath = resolvePath(filePath);

    try {
      // Check if file exists
      try {
        await fs.access(absolutePath);
      } catch {
        return this.formatErrorResponse(
          `File not found: ${filePath}`,
          'user_error',
          'Check that the file path is correct'
        );
      }

      // Check if it's a file (not a directory)
      const stats = await fs.stat(absolutePath);
      if (!stats.isFile()) {
        return this.formatErrorResponse(
          `Not a file: ${filePath}`,
          'validation_error'
        );
      }

      // Read file content preserving line endings
      const fileContent = await fs.readFile(absolutePath, 'utf-8');

      // Detect line ending style BEFORE splitting
      const hasWindowsLineEndings = fileContent.includes('\r\n');
      const lineEnding = hasWindowsLineEndings ? '\r\n' : '\n';

      // Split lines preserving the original line ending in each line
      // For Windows files, each line will end with \r (since we split on \n)
      const lines = fileContent.split('\n').map((line, index, arr) => {
        // Last line doesn't need ending preserved if file doesn't end with newline
        if (index === arr.length - 1 && !fileContent.endsWith('\n')) {
          return line;
        }
        // Remove \r if present (will be added back later)
        return line.replace(/\r$/, '');
      });
      const totalLines = lines.length;

      // Validate line number exists (for insert, allow totalLines+1 to append)
      const maxLineNumber = operation === 'insert' ? totalLines + 1 : totalLines;
      if (lineNumber > maxLineNumber) {
        const context = this.getLineContext(lines, totalLines, Math.max(1, totalLines - TEXT_LIMITS.LINE_EDIT_CONTEXT_LINES));
        return this.formatErrorResponse(
          `line_number ${lineNumber} does not exist (file has ${totalLines} line${totalLines !== 1 ? 's' : ''})`,
          'validation_error',
          `Last lines of file:\n${context}\n\nUse the Read tool to see the actual file content.`
        );
      }

      // Validate that target lines have been read
      const registry = ServiceRegistry.getInstance();
      const readStateManager = registry.get<ReadStateManager>('read_state_manager');

      if (readStateManager) {
        // Special case: inserting into an empty file
        if (operation === 'insert' && fileContent.length === 0 && lineNumber === 1) {
          // Skip validation for empty file insert at line 1
        } else {
          // Determine which lines need validation
          let validationStartLine: number;
          let validationEndLine: number;

          switch (operation) {
            case 'insert':
              // For insert, validate we've read the context around insertion point
              validationStartLine = Math.max(1, lineNumber - 1);
              validationEndLine = Math.min(totalLines, lineNumber);
              break;

            case 'delete':
              validationStartLine = lineNumber;
              validationEndLine = Math.min(totalLines, lineNumber + numLines - 1);
              break;

            case 'replace':
              validationStartLine = lineNumber;
              validationEndLine = Math.min(totalLines, lineNumber + numLines - 1);
              break;
          }

          const validation = readStateManager.validateLinesRead(
            absolutePath,
            validationStartLine,
            validationEndLine
          );

          if (!validation.success) {
            const rangeDesc = validationStartLine === validationEndLine
              ? `line ${validationStartLine}`
              : `lines ${validationStartLine}-${validationEndLine}`;

            // Check if this is likely due to previous edit invalidation
            const readState = readStateManager.getReadState(absolutePath);
            const hasPartialReadState = readState && readState.length > 0;

            let guidanceMessage: string;
            if (hasPartialReadState) {
              // File has been read before - likely invalidated by previous edit
              guidanceMessage = `Lines ${validationStartLine}-${validationEndLine} were invalidated by a previous edit.

Use one of these approaches:
  • Re-read the file: read(file_paths=["${filePath}"])
  • Use show_updated_context=true in your edits to see changes immediately
  • Read specific lines: read(file_paths=["${filePath}"], offset=${validationStartLine}, limit=${validationEndLine - validationStartLine + 1})`;
            } else {
              // File has never been read
              guidanceMessage = `Use read(file_paths=["${filePath}"], offset=${validationStartLine}, limit=${validationEndLine - validationStartLine + 1}) to read ${rangeDesc} first.`;
            }

            return this.formatErrorResponse(
              `Cannot ${operation} at line ${lineNumber}: File has not been read`,
              'validation_error',
              guidanceMessage
            );
          }
        }
      }

      // Perform the operation
      let modifiedLines: string[];
      let operationDescription: string;
      let detailedDescription: string;

      switch (operation) {
        case 'insert':
          const insertedLineCount = content.split('\n').length;
          modifiedLines = this.performInsert(lines, lineNumber, content);
          operationDescription = `Inserted ${insertedLineCount} line(s) at line ${lineNumber}`;
          detailedDescription = this.buildDetailedDescription(
            operation,
            lineNumber,
            0, // INSERT removes 0 lines
            insertedLineCount,
            totalLines
          );
          break;

        case 'delete':
          const deleteResult = this.performDelete(lines, lineNumber, numLines, totalLines);
          if (deleteResult.error) {
            return this.formatErrorResponse(deleteResult.error, 'validation_error');
          }
          modifiedLines = deleteResult.lines!;
          operationDescription = `Deleted ${numLines} line(s) starting at line ${lineNumber}`;
          detailedDescription = this.buildDetailedDescription(
            operation,
            lineNumber,
            numLines,
            0,
            totalLines
          );
          break;

        case 'replace':
          const replaceResult = this.performReplace(lines, lineNumber, content, numLines, totalLines);
          if (replaceResult.error) {
            return this.formatErrorResponse(replaceResult.error, 'validation_error');
          }
          modifiedLines = replaceResult.lines!;
          const newLineCount = content.split('\n').length;
          operationDescription = numLines === 1
            ? `Replaced line ${lineNumber}`
            : `Replaced ${numLines} line(s) starting at line ${lineNumber}`;
          detailedDescription = this.buildDetailedDescription(
            operation,
            lineNumber,
            numLines,
            newLineCount,
            totalLines
          );
          break;

        default:
          return this.formatErrorResponse(
            `Unknown operation: ${operation}`,
            'validation_error'
          );
      }

      // Join lines back with original line ending style
      const modifiedContent = modifiedLines.join(lineEnding);

      // Write the modified content
      await fs.writeFile(absolutePath, modifiedContent, 'utf-8');

      // Invalidate affected line numbers after edit
      if (readStateManager) {
        // Calculate line delta based on operation
        let lineDelta: number;

        switch (operation) {
          case 'insert':
            const insertedLineCount = content.split('\n').length;
            lineDelta = insertedLineCount;
            break;

          case 'delete':
            lineDelta = -numLines;
            break;

          case 'replace':
            const newLineCount = content.split('\n').length;
            lineDelta = newLineCount - numLines;
            break;

          default:
            lineDelta = 0;
        }

        // Invalidate if line count changed
        if (lineDelta !== 0) {
          readStateManager.invalidateAfterEdit(absolutePath, lineNumber, lineDelta);
        }
      }

      // Capture the operation as a patch for undo functionality
      const patchNumber = await this.captureOperationPatch(
        'line-edit',
        absolutePath,
        fileContent,
        modifiedContent
      );

      // Generate unified diff to show what changed
      const diff = createUnifiedDiff(fileContent, modifiedContent, absolutePath);

      const response = this.formatSuccessResponse({
        content: detailedDescription, // Human-readable output for LLM
        file_path: absolutePath,
        operation: operationDescription,
        lines_before: totalLines,
        lines_after: modifiedLines.length,
        diff, // Include diff so model can see what changed
      });

      // Add patch information to result if patch was captured
      if (patchNumber !== null) {
        response.patch_number = patchNumber;
      }

      // Include updated file content if requested
      if (showUpdatedContext) {
        response.updated_content = modifiedContent;
      }

      // Check file for syntax/parse errors after modification
      // Matches Python CodeAlly pattern exactly
      const checkResult = await checkFileAfterModification(absolutePath);
      if (checkResult) {
        response.file_check = checkResult;
      }

      return response;
    } catch (error) {
      return this.formatErrorResponse(
        `Failed to edit file: ${formatError(error)}`,
        'system_error'
      );
    }
  }

  /**
   * Build detailed description of operation including line shift information
   */
  private buildDetailedDescription(
    operation: LineOperation,
    lineNumber: number,
    numLinesRemoved: number,
    numLinesAdded: number,
    totalLines: number
  ): string {
    const parts: string[] = [];

    // Main operation description
    switch (operation) {
      case 'insert':
        parts.push(`Inserted ${numLinesAdded} line(s) at line ${lineNumber}`);
        break;
      case 'delete':
        parts.push(`Deleted ${numLinesRemoved} line(s) starting at line ${lineNumber}`);
        break;
      case 'replace':
        parts.push(
          numLinesRemoved === 1
            ? `Replaced line ${lineNumber} with ${numLinesAdded} line(s)`
            : `Replaced ${numLinesRemoved} line(s) starting at line ${lineNumber} with ${numLinesAdded} line(s)`
        );
        break;
    }

    // Calculate line shift and add warnings
    const netChange = numLinesAdded - numLinesRemoved;

    if (netChange !== 0) {
      // For INSERT: lines after the insertion point are affected
      // For DELETE/REPLACE: lines after the modified range are affected
      const firstAffectedLine = operation === 'insert'
        ? lineNumber + numLinesAdded
        : lineNumber + numLinesRemoved;

      // Only show warning if there are lines that got shifted
      if (firstAffectedLine <= totalLines) {
        const direction = netChange > 0 ? 'down' : 'up';
        const absChange = Math.abs(netChange);
        parts.push(`Lines ${firstAffectedLine}+ shifted ${direction} by ${absChange} lines`);

        // Proactive warning about invalidation
        parts.push(`\n\n⚠️  Lines ${firstAffectedLine}+ were invalidated due to line shift. To edit these lines again, either re-read the file or use show_updated_context=true`);
      }
      // If appending to end, no warning needed (no lines to shift)
    }

    return parts.join('. ');
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
    const operation = result.operation ?? 'unknown operation';
    const linesBefore = result.lines_before ?? 0;
    const linesAfter = result.lines_after ?? 0;
    const lineDiff = linesAfter - linesBefore;

    lines.push(operation);

    if (lineDiff !== 0) {
      const sign = lineDiff > 0 ? '+' : '';
      lines.push(`Lines: ${linesBefore} → ${linesAfter} (${sign}${lineDiff})`);
    }

    return lines;
  }
}
