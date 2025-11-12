/**
 * WriteTempTool - Write temporary exploration notes to /tmp
 *
 * Specialized tool for explore agents to organize findings during investigation.
 * Enforces write-only access to /tmp directory with namespaced filenames.
 *
 * INTERNAL TOOL: Only available to ExploreTool, not general agent use.
 */

import { BaseTool } from './BaseTool.js';
import { ToolResult, FunctionDefinition } from '../types/index.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { formatError } from '../utils/errorUtils.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

export class WriteTempTool extends BaseTool {
  readonly name = 'write_temp';
  readonly description = 'Write temporary notes to /tmp for organizing exploration findings. Files are automatically namespaced to avoid conflicts.';
  readonly requiresConfirmation = false; // Safe operation - isolated to /tmp
  readonly internalTool = true; // Only available to specific agents (ExploreTool)

  private sessionId: string;

  constructor(activityStream: ActivityStream) {
    super(activityStream);
    // Generate unique session ID for this tool instance
    this.sessionId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
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
            content: {
              type: 'string',
              description: 'Content to write to the temporary file.',
            },
            filename: {
              type: 'string',
              description: 'Simple filename (e.g., "notes.txt", "architecture.txt"). No paths allowed - file will be created in /tmp with safe namespacing.',
            },
          },
          required: ['content', 'filename'],
        },
      },
    };
  }

  protected async executeImpl(args: any): Promise<ToolResult> {
    // Capture parameters
    this.captureParams(args);

    // Extract and validate parameters
    const content = args.content as string;
    const filename = args.filename as string;

    if (content === undefined || content === null) {
      return this.formatErrorResponse(
        'content parameter is required',
        'validation_error',
        'Example: write_temp(content="Architecture notes...", filename="notes.txt")'
      );
    }

    if (!filename) {
      return this.formatErrorResponse(
        'filename parameter is required',
        'validation_error',
        'Example: write_temp(content="...", filename="notes.txt")'
      );
    }

    // Validate filename safety
    const validation = this.validateFilename(filename);
    if (!validation.valid) {
      return this.formatErrorResponse(
        validation.error || 'Invalid filename',
        'validation_error',
        'Use simple filenames only (e.g., "notes.txt"). No paths or special characters allowed.'
      );
    }

    try {
      // Get system temp directory
      const tmpDir = os.tmpdir();

      // Create safe namespaced path
      const safeFilename = `explore-${this.sessionId}-${filename}`;
      const absolutePath = path.join(tmpDir, safeFilename);

      // Ensure we're still in tmpDir (defense in depth)
      const resolvedPath = path.resolve(absolutePath);
      if (!resolvedPath.startsWith(path.resolve(tmpDir))) {
        return this.formatErrorResponse(
          'Security violation: path escapes /tmp directory',
          'security_error'
        );
      }

      // Write the file
      await fs.writeFile(absolutePath, content, 'utf-8');

      const stats = await fs.stat(absolutePath);

      const successMessage = `Wrote ${stats.size} bytes to ${absolutePath}`;

      return this.formatSuccessResponse({
        content: successMessage, // Human-readable output for LLM
        file_path: absolutePath,
        bytes_written: stats.size,
        system_reminder: 'You can read this file back with read(file_path="' + absolutePath + '") to review your notes.',
      });
    } catch (error) {
      return this.formatErrorResponse(
        `Failed to write temporary file: ${formatError(error)}`,
        'system_error'
      );
    }
  }

  /**
   * Validate filename is safe (no path traversal, no special chars)
   */
  private validateFilename(filename: string): { valid: boolean; error?: string } {
    // Check for path separators
    if (filename.includes('/') || filename.includes('\\')) {
      return { valid: false, error: 'Filename cannot contain path separators (/ or \\)' };
    }

    // Check for path traversal
    if (filename.includes('..')) {
      return { valid: false, error: 'Filename cannot contain ".." (path traversal)' };
    }

    // Check for hidden files
    if (filename.startsWith('.')) {
      return { valid: false, error: 'Filename cannot start with "." (hidden files not allowed)' };
    }

    // Check length
    if (filename.length === 0 || filename.length > 255) {
      return { valid: false, error: 'Filename must be between 1 and 255 characters' };
    }

    // Must have an extension (good practice for temp files)
    if (!filename.includes('.')) {
      return { valid: false, error: 'Filename should have an extension (e.g., ".txt", ".md")' };
    }

    return { valid: true };
  }

  /**
   * Custom result preview for write_temp tool
   */
  getResultPreview(result: ToolResult, maxLines: number = 3): string[] {
    if (!result.success) {
      return super.getResultPreview(result, maxLines);
    }

    const lines: string[] = [];
    const bytesWritten = result.bytes_written ?? 0;
    const filePath = result.file_path ?? 'unknown file';

    lines.push(`Wrote ${bytesWritten} bytes to temp: ${path.basename(filePath)}`);

    return lines;
  }
}
