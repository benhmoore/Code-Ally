/**
 * WriteTool - Write content to files
 *
 * Creates new files or overwrites existing ones with optional backup creation.
 */

import { BaseTool } from './BaseTool.js';
import { ToolResult, FunctionDefinition } from '../types/index.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { resolvePath } from '../utils/pathUtils.js';
import { formatError } from '../utils/errorUtils.js';
import { checkFileAfterModification } from '../utils/fileCheckUtils.js';
import * as fs from 'fs/promises';
import * as path from 'path';

export class WriteTool extends BaseTool {
  readonly name = 'write';
  readonly description = 'Create a new file with the specified content. FAILS if file already exists. Use edit or line_edit to modify existing files.';
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
              description: 'Path to the file to write',
            },
            content: {
              type: 'string',
              description: 'Complete file content for the new file.',
            },
          },
          required: ['file_path', 'content'],
        },
      },
    };
  }

  async previewChanges(args: any, callId?: string): Promise<void> {
    await super.previewChanges(args, callId);

    const filePath = args.file_path as string;
    const content = args.content as string;

    if (!filePath || content === undefined) {
      return; // Skip preview if invalid args
    }

    const absolutePath = resolvePath(filePath);

    await this.safelyEmitDiffPreview(
      absolutePath,
      async () => {
        // Check if file exists
        try {
          await fs.access(absolutePath);
          // File exists - write will fail, so show warning in preview
          return { oldContent: '[File exists - write will fail]', newContent: content };
        } catch {
          // File doesn't exist - show as new file creation
          return { oldContent: '', newContent: content };
        }
      },
      'write'
    );
  }

  protected async executeImpl(args: any): Promise<ToolResult> {
    // Capture parameters
    this.captureParams(args);

    // Extract and validate parameters
    const filePath = args.file_path as string;
    const content = args.content as string;

    if (!filePath) {
      return this.formatErrorResponse(
        'file_path parameter is required',
        'validation_error',
        'Example: write(file_path="src/main.ts", content="...")'
      );
    }

    if (content === undefined || content === null) {
      return this.formatErrorResponse(
        'content parameter is required',
        'validation_error',
        'Example: write(file_path="src/main.ts", content="console.log(\\"hello\\");")'
      );
    }

    // Resolve absolute path
    const absolutePath = resolvePath(filePath);

    try {
      // Check if file exists
      let fileExists = false;
      try {
        await fs.access(absolutePath);
        fileExists = true;
      } catch {
        fileExists = false;
      }

      // Fail if file already exists (prevent accidental overwrites)
      if (fileExists) {
        return this.formatErrorResponse(
          `File already exists: ${absolutePath}`,
          'file_error',
          'Use edit or line_edit to modify existing files. The write tool only creates new files.'
        );
      }

      // Create parent directory if it doesn't exist
      const directory = path.dirname(absolutePath);
      await fs.mkdir(directory, { recursive: true });

      // Write the file
      await fs.writeFile(absolutePath, content, 'utf-8');

      // Capture the operation as a patch for undo functionality
      const patchNumber = await this.captureOperationPatch(
        'write',
        absolutePath,
        '', // No existing content (file is new)
        content
      );

      const stats = await fs.stat(absolutePath);

      const successMessage = `Created new file ${absolutePath} (${stats.size} bytes)`;

      const response = this.formatSuccessResponse({
        content: successMessage, // Human-readable output for LLM
        file_path: absolutePath,
        bytes_written: stats.size,
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
        `Failed to write file: ${formatError(error)}`,
        'system_error'
      );
    }
  }

  /**
   * Custom result preview for write tool
   */
  getResultPreview(result: ToolResult, maxLines: number = 3): string[] {
    if (!result.success) {
      return super.getResultPreview(result, maxLines);
    }

    const lines: string[] = [];
    const bytesWritten = result.bytes_written ?? 0;
    const filePath = result.file_path ?? 'unknown file';

    lines.push(`Wrote ${bytesWritten} bytes to ${filePath}`);

    if (result.backup_created) {
      lines.push('Backup created: .bak');
    }

    return lines;
  }
}
