/**
 * WriteTool - Write content to files
 *
 * Creates new files or overwrites existing ones with optional backup creation.
 */

import { BaseTool } from './BaseTool.js';
import { ToolResult, FunctionDefinition } from '../types/index.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { ServiceRegistry } from '../services/ServiceRegistry.js';
import { FocusManager } from '../services/FocusManager.js';
import { ReadStateManager } from '../services/ReadStateManager.js';
import { resolvePath } from '../utils/pathUtils.js';
import { formatError } from '../utils/errorUtils.js';
import { checkFileAfterModification } from '../utils/fileCheckUtils.js';
import { isPathWithinCwd } from '../security/PathSecurity.js';
import * as fs from 'fs/promises';
import * as path from 'path';

export class WriteTool extends BaseTool {
  readonly name = 'write';
  readonly description = 'Create a new file with the specified content. By default FAILS if file already exists (use edit or line-edit instead). Set overwrite=true to replace existing files.';
  readonly requiresConfirmation = true; // Destructive operation
  readonly hideOutput = true; // Hide output from result preview

  constructor(activityStream: ActivityStream) {
    super(activityStream);
  }

  /**
   * Validate WriteTool arguments
   */
  validateArgs(args: Record<string, unknown>): { valid: boolean; error?: string; error_type?: string; suggestion?: string } | null {
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

    return null;
  }

  /**
   * Validate before permission request
   * Checks if file already exists (unless overwrite=true)
   */
  async validateBeforePermission(args: any): Promise<ToolResult | null> {
    const filePath = args.file_path as string;
    const overwrite = args.overwrite === true;
    const absolutePath = resolvePath(filePath);

    // If overwrite is true, allow existing files
    if (overwrite) {
      return null;
    }

    try {
      // Check if file exists
      await fs.access(absolutePath);
      // File exists and overwrite is false - fail without requesting permission
      return this.formatErrorResponse(
        `File already exists: ${absolutePath}`,
        'file_error',
        'Use edit or line-edit to modify existing files, or set overwrite=true to replace the file.'
      );
    } catch {
      // File doesn't exist - validation passed
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
              description: 'Path to the file to write',
            },
            content: {
              type: 'string',
              description: 'Complete file content for the new file.',
            },
            overwrite: {
              type: 'boolean',
              description: 'If true, overwrite existing file. If false (default), fail if file exists.',
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
    const overwrite = args.overwrite === true;

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
          // File exists
          if (overwrite) {
            // Overwrite mode - show existing content vs new content
            try {
              const existingContent = await fs.readFile(absolutePath, 'utf-8');
              return { oldContent: existingContent, newContent: content };
            } catch {
              return { oldContent: '[Could not read existing file]', newContent: content };
            }
          } else {
            // No overwrite - write will fail
            return { oldContent: '[File exists - write will fail]', newContent: content };
          }
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
    const overwrite = args.overwrite === true;

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

    // Validate focus constraint if active
    const registry = ServiceRegistry.getInstance();
    const focusManager = registry.get<FocusManager>('focus_manager');

    if (focusManager && focusManager.isFocused()) {
      const validation = await focusManager.validatePathInFocus(absolutePath);
      if (!validation.success) {
        return this.formatErrorResponse(
          validation.message,
          'permission_error'
        );
      }
    }

    try {
      // Check if file exists and read existing content if overwriting
      let fileExists = false;
      let existingContent = '';
      try {
        await fs.access(absolutePath);
        fileExists = true;

        // If overwriting, read existing content for patch creation
        if (overwrite) {
          try {
            existingContent = await fs.readFile(absolutePath, 'utf-8');
          } catch {
            // If we can't read the file, proceed with empty existing content
            existingContent = '';
          }
        }
      } catch {
        fileExists = false;
      }

      // Fail if file already exists and overwrite=false (default behavior)
      if (fileExists && !overwrite) {
        return this.formatErrorResponse(
          `File already exists: ${absolutePath}`,
          'file_error',
          'Use edit or line-edit to modify existing files, or set overwrite=true to replace the file.'
        );
      }

      // Create parent directory if it doesn't exist
      const directory = path.dirname(absolutePath);
      await fs.mkdir(directory, { recursive: true });

      // Write the file
      await fs.writeFile(absolutePath, content, 'utf-8');

      // Track the written content as read (model knows what it wrote)
      // This allows immediate edits to the newly created file without requiring a separate read
      const readStateManager = registry.get<ReadStateManager>('read_state_manager');
      if (readStateManager && content.length > 0) {
        const lines = content.split('\n');
        readStateManager.trackRead(absolutePath, 1, lines.length);
      }

      // Capture the operation as a patch for undo functionality
      const patchNumber = await this.captureOperationPatch(
        'write',
        absolutePath,
        existingContent, // Use existing content if overwriting, empty string if new file
        content
      );

      const stats = await fs.stat(absolutePath);

      const successMessage = fileExists
        ? `Overwrote file ${absolutePath} (${stats.size} bytes)`
        : `Created new file ${absolutePath} (${stats.size} bytes)`;

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
   * Format subtext for display in UI
   * Shows description if provided, falls back to filename
   */
  formatSubtext(args: Record<string, any>): string | null {
    const description = args.description as string;
    if (description) return description;

    const filePath = args.file_path as string;
    if (!filePath) return null;

    const parts = filePath.split('/');
    return parts[parts.length - 1] || filePath;
  }

  /**
   * Get parameters shown in subtext
   */
  getSubtextParameters(): string[] {
    return ['description', 'file_path'];
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
