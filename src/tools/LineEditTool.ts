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
import { TEXT_LIMITS, FORMATTING } from '../config/constants.js';
import * as fs from 'fs/promises';

type LineOperation = 'insert' | 'delete' | 'replace';

export class LineEditTool extends BaseTool {
  readonly name = 'line_edit';
  readonly description =
    'Edit files by line number with insert, delete, and replace operations';
  readonly requiresConfirmation = true; // Destructive operation

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
            file_path: {
              type: 'string',
              description: 'Path to the file to edit',
            },
            operation: {
              type: 'string',
              description: 'Operation to perform: insert, delete, or replace',
            },
            line_number: {
              type: 'integer',
              description: 'Line number to operate on (1-indexed)',
            },
            content: {
              type: 'string',
              description:
                'Content for insert/replace operations. Can contain \\n for multiple lines.',
            },
            num_lines: {
              type: 'integer',
              description: 'Number of lines to delete (only for delete operation, default: 1)',
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
    const numLines = (args.num_lines as number) ?? 1;

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
            modifiedLines = this.performReplace(lines, lineNumber, content);
            break;
          default:
            throw new Error('Invalid operation');
        }

        const modifiedContent = modifiedLines.join(lineEnding);
        return { oldContent: fileContent, newContent: modifiedContent };
      },
      'line_edit'
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
    const numLines = (args.num_lines as number) ?? 1;

    // Validate file_path
    if (!filePath) {
      return this.formatErrorResponse(
        'file_path parameter is required',
        'validation_error',
        'Example: line_edit(file_path="src/main.ts", operation="replace", line_number=10, content="new line")'
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

      // Perform the operation
      let modifiedLines: string[];
      let operationDescription: string;

      switch (operation) {
        case 'insert':
          modifiedLines = this.performInsert(lines, lineNumber, content);
          operationDescription = `Inserted ${content.split('\n').length} line(s) at line ${lineNumber}`;
          break;

        case 'delete':
          const deleteResult = this.performDelete(lines, lineNumber, numLines, totalLines);
          if (deleteResult.error) {
            return this.formatErrorResponse(deleteResult.error, 'validation_error');
          }
          modifiedLines = deleteResult.lines!;
          operationDescription = `Deleted ${numLines} line(s) starting at line ${lineNumber}`;
          break;

        case 'replace':
          modifiedLines = this.performReplace(lines, lineNumber, content);
          operationDescription = `Replaced line ${lineNumber}`;
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

      // Capture the operation as a patch for undo functionality
      const patchNumber = await this.captureOperationPatch(
        'line_edit',
        absolutePath,
        fileContent,
        modifiedContent
      );

      const response = this.formatSuccessResponse({
        content: operationDescription, // Human-readable output for LLM
        file_path: absolutePath,
        operation: operationDescription,
        lines_before: totalLines,
        lines_after: modifiedLines.length,
      });

      // Add patch information to result if patch was captured
      if (patchNumber !== null) {
        response.patch_number = patchNumber;
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
   * Replace line at the specified position
   */
  private performReplace(lines: string[], lineNumber: number, content: string): string[] {
    const newLines = content.split('\n');
    const beforeLines = lines.slice(0, lineNumber - 1);
    const afterLines = lines.slice(lineNumber);
    return [...beforeLines, ...newLines, ...afterLines];
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
   * Custom result preview for line_edit tool
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
