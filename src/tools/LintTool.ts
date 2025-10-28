/**
 * Lint tool for syntax and parse checking
 *
 * Allows explicit linting of files on demand using the file checking system.
 */

import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import { BaseTool } from './BaseTool.js';
import { ToolResult, FunctionDefinition } from '../types/index.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { ensureRegistryInitialized, getDefaultRegistry } from '../checkers/CheckerRegistry.js';
import { formatError } from '../utils/errorUtils.js';

interface FileCheckResult {
  file_path: string;
  checker_available: boolean;
  checker?: string;
  passed?: boolean;
  errors?: Array<{
    line: number;
    column?: number;
    message: string;
    code?: string;
    severity: string;
  }>;
  warnings?: Array<{
    line: number;
    column?: number;
    message: string;
    code?: string;
    severity: string;
  }>;
  error_count?: number;
  warning_count?: number;
  check_time_ms?: number;
  message?: string;
  error?: string;
}

export class LintTool extends BaseTool {
  readonly name = 'lint';
  readonly description =
    'Check files for syntax and parse errors. Supports TypeScript, JavaScript, JSON, and YAML. Returns detailed error and warning information';
  readonly requiresConfirmation = false; // NON-DESTRUCTIVE: Read-only operation

  constructor(activityStream: ActivityStream) {
    super(activityStream);
  }

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
              description: 'List of file paths to lint (required)',
              items: {
                type: 'string',
              },
            },
          },
          required: ['file_paths'],
        },
      },
    };
  }

  protected async executeImpl(args: any): Promise<ToolResult> {
    this.captureParams(args);

    const filePaths = args.file_paths as string[];

    // Validate input
    if (!filePaths || !Array.isArray(filePaths) || filePaths.length === 0) {
      return this.formatErrorResponse(
        'file_paths parameter is required and must contain at least one file path',
        'validation_error'
      );
    }

    // Validate each file path
    const validatedPaths: string[] = [];
    for (let i = 0; i < filePaths.length; i++) {
      const filePath = filePaths[i];

      if (typeof filePath !== 'string' || !filePath.trim()) {
        return this.formatErrorResponse(
          `File path at index ${i} must be a non-empty string`,
          'validation_error'
        );
      }

      // Validate file path
      const validation = this.validateFilePath(filePath);
      if (!validation.valid) {
        return this.formatErrorResponse(
          `Invalid file path '${filePath}': ${validation.error}`,
          'validation_error',
          validation.suggestion || 'Check the file path and ensure the file exists'
        );
      }
      const absPath = validation.path!;

      validatedPaths.push(absPath);
    }

    // Ensure registry is initialized
    await ensureRegistryInitialized();

    // Process each file
    const registry = getDefaultRegistry();
    const fileResults: FileCheckResult[] = [];
    let filesChecked = 0;
    let totalErrors = 0;
    let totalWarnings = 0;

    for (const absPath of validatedPaths) {
      const fileResult: FileCheckResult = { file_path: absPath, checker_available: false };

      try {
        // Read file content
        const content = await fs.readFile(absPath, 'utf-8');

        // Check file with registry
        const checkResult = await registry.checkFile(absPath, content);

        if (!checkResult) {
          // No checker available for this file type
          const ext = path.extname(absPath);
          const fileType = ext ? ext.slice(1) : 'unknown';

          fileResult.checker_available = false;
          fileResult.message = `No linter available for ${fileType} files`;
          fileResults.push(fileResult);
          continue;
        }

        // Format errors and warnings
        const errorsFormatted = checkResult.errors.map((error) => ({
          line: error.line,
          column: error.column,
          message: error.message,
          code: error.code,
          severity: error.severity,
        }));

        const warningsFormatted = checkResult.warnings.map((warning) => ({
          line: warning.line,
          column: warning.column,
          message: warning.message,
          code: warning.code,
          severity: warning.severity,
        }));

        fileResult.checker_available = true;
        fileResult.checker = checkResult.checker;
        fileResult.passed = checkResult.passed;
        fileResult.errors = errorsFormatted;
        fileResult.warnings = warningsFormatted;
        fileResult.check_time_ms = checkResult.checkTimeMs;
        fileResult.error_count = checkResult.errors.length;
        fileResult.warning_count = checkResult.warnings.length;

        filesChecked++;
        totalErrors += checkResult.errors.length;
        totalWarnings += checkResult.warnings.length;
        fileResults.push(fileResult);
      } catch (error: any) {
        if (error.code === 'ENOENT') {
          fileResult.error = `File not found: ${absPath}`;
        } else if (error.message?.includes('binary')) {
          fileResult.error = 'File appears to be binary or has encoding issues';
        } else {
          fileResult.error = `Error reading file: ${formatError(error)}`;
        }
        fileResults.push(fileResult);
      }
    }

    // Return aggregated results
    return this.formatSuccessResponse({
      files_checked: filesChecked,
      files: fileResults,
      total_errors: totalErrors,
      total_warnings: totalWarnings,
    });
  }

  /**
   * Validate a file path and return absolute path
   *
   * @param filePath - File path to validate
   * @returns Validation result with path or error
   */
  private validateFilePath(filePath: string): {
    valid: boolean;
    path?: string;
    error?: string;
    suggestion?: string;
  } {
    try {
      const absPath = path.resolve(filePath);

      // Check if file exists synchronously
      if (!fsSync.existsSync(absPath)) {
        return {
          valid: false,
          error: `file not found at resolved path: ${absPath}`,
          suggestion: `Current working directory: ${process.cwd()}. Ensure the file path is correct relative to this directory.`,
        };
      }

      // Check if it's a file (not a directory)
      const stats = fsSync.statSync(absPath);
      if (!stats.isFile()) {
        return {
          valid: false,
          error: `path exists but is not a file (it's a ${stats.isDirectory() ? 'directory' : 'other'})`,
          suggestion: 'Provide a path to a file, not a directory',
        };
      }

      return { valid: true, path: absPath };
    } catch (error: any) {
      return {
        valid: false,
        error: `error accessing path: ${error.message}`,
        suggestion: 'Check file permissions and path syntax',
      };
    }
  }

  /**
   * Get a custom preview for lint results
   */
  getResultPreview(result: ToolResult, maxLines: number = 3): string[] {
    // Handle errors
    if (!result.success) {
      return super.getResultPreview(result, maxLines);
    }

    // Handle batch results
    const filesChecked = result.files_checked || 0;
    const totalErrors = result.total_errors || 0;
    const totalWarnings = result.total_warnings || 0;

    const previewLines: string[] = [];

    // Summary line
    previewLines.push(`Checked ${filesChecked} file${filesChecked !== 1 ? 's' : ''}`);

    // Error/warning counts
    if (totalErrors > 0) {
      previewLines.push(`${totalErrors} error${totalErrors !== 1 ? 's' : ''} found`);
    }

    if (totalWarnings > 0) {
      previewLines.push(`${totalWarnings} warning${totalWarnings !== 1 ? 's' : ''} found`);
    }

    if (totalErrors === 0 && totalWarnings === 0) {
      previewLines.push('All files passed');
    }

    return previewLines.slice(0, maxLines);
  }
}
