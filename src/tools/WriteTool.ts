/**
 * WriteTool - Write content to files
 *
 * Creates new files. Existing text files are changed with apply-patch.
 */

import { BaseTool } from './BaseTool.js';
import { ToolCapability } from './ToolCapability.js';
import { ToolExecutionContext, ToolResult, FunctionDefinition } from '../types/index.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { resolvePath } from '../utils/pathUtils.js';
import { formatError } from '../utils/errorUtils.js';
import { checkFileAfterModification } from '../utils/fileCheckUtils.js';
import { atomicWriteFile } from '../utils/atomicFile.js';
import { fileMutationCoordinator } from '../services/FileMutationCoordinator.js';
import * as fs from 'fs/promises';
import * as path from 'path';

export class WriteTool extends BaseTool {
  override readonly argumentCompaction = {
    payloadPaths: [['content']],
    durableReceipt: 'successful-tool-result',
  } as const;
  readonly name = 'write';
  readonly description =
    'Create a new file with its complete content. Fails if the path already exists; use apply-patch for existing text files. Keep each write small enough for one model response; decompose large implementations into cohesive modules or extend a created file with bounded patches.';
  readonly capabilities = [ToolCapability.FsWrite] as const;
  readonly hideOutput = true; // Hide output from result preview

  constructor(activityStream: ActivityStream) {
    super(activityStream);
  }

  /**
   * Validate before permission request
   * Checks if the target path already exists.
   */
  async validateBeforePermission(args: any): Promise<ToolResult | null> {
    const filePath = args.file_path as string;
    const absolutePath = resolvePath(filePath);

    try {
      // Check if file exists
      await fs.access(absolutePath);
      // File exists and overwrite is false - fail without requesting permission
      return this.formatErrorResponse(
        `File already exists: ${absolutePath}`,
        'file_error',
        'Use apply-patch to modify an existing text file.'
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
              format: 'local-path',
              description: 'Path to the file to write',
            },
            content: {
              type: 'string',
              description: 'Complete file content for the new file. This argument must fit in one response; split large implementations across modules or bounded follow-up patches.',
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
          return { oldContent: '[File exists - write will fail]', newContent: content };
        } catch {
          // File doesn't exist - show as new file creation
          return { oldContent: '', newContent: content };
        }
      },
      'write'
    );
  }

  protected async executeImpl(
    args: any,
    _toolCallId?: string,
    _isUserInitiated?: boolean,
    _isContextFile?: boolean,
    executionContext?: ToolExecutionContext
  ): Promise<ToolResult> {
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

    // Validate focus constraint if active
    const registry = this.getExecutionRegistry(executionContext);
    const readScopeId = this.getReadScopeId(executionContext);
    const focusManager = registry.get('focus_manager');

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
      return await fileMutationCoordinator.run(absolutePath, async () => {
      // Check if the path already exists. Write is intentionally creation-only.
      let fileExists = false;
      try {
        await fs.access(absolutePath);
        fileExists = true;
      } catch {
        fileExists = false;
      }

      if (fileExists) {
        return this.formatErrorResponse(
          `File already exists: ${absolutePath}`,
          'file_error',
          'Keep the existing file intact. Use apply-patch with a smaller contextual hunk; do not delete and recreate the file to bypass patch validation.'
        );
      }

      // Create parent directory if it doesn't exist
      const directory = path.dirname(absolutePath);
      await fs.mkdir(directory, { recursive: true });

      // Write the file
      await atomicWriteFile(absolutePath, content);

      // Any write makes every agent's previous view of this file stale.
      const readCache = registry.get('read_cache');
      if (readCache) {
        readCache.invalidate(absolutePath);
      }

      // Track the written content as read (model knows what it wrote)
      // This allows immediate edits to the newly created file without requiring a separate read
      const readStateManager = registry.get('read_state_manager');
      if (readStateManager) {
        readStateManager.clearFile(absolutePath);
        if (content.length > 0) {
          const lines = content.split('\n');
          readStateManager.trackRead(absolutePath, 1, lines.length, readScopeId);
        }
      }

      // Capture the operation as a patch for undo functionality
      const patchNumber = await this.captureOperationPatch(
        'write',
        absolutePath,
        '',
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
      });
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
