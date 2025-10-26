/**
 * Format tool for automatic code formatting and fixing
 *
 * Formats code files using appropriate language-specific formatters.
 */

import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { BaseTool } from './BaseTool.js';
import { ToolResult, FunctionDefinition } from '../types/index.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { ensureRegistryInitialized, getDefaultRegistry } from '../checkers/CheckerRegistry.js';
import { formatError } from '../utils/errorUtils.js';
import { API_TIMEOUTS, BUFFER_SIZES, FORMATTING } from '../config/constants.js';

interface FormatResult {
  file_path: string;
  formatters_applied?: string[];
  changes_made: boolean;
  error?: string;
  suggestion?: string;
  file_check?: {
    checker: string;
    passed: boolean;
    errors: Array<{
      line: number;
      column?: number;
      message: string;
      source?: string;
      marker?: string;
    }>;
  };
}

interface FormatterInfo {
  available: boolean;
  message?: string;
  suggestion?: string;
  formatters?: Array<[string, (filePath: string, content: string) => Promise<string>]>;
}

export class FormatTool extends BaseTool {
  readonly name = 'format';
  readonly description =
    'Format and auto-fix code files in batch. Supports TypeScript/JavaScript (prettier, eslint --fix), JSON, and YAML. Shows diff preview before changes';
  readonly requiresConfirmation = true; // SENSITIVE: Modifies files

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
              description: 'List of file paths to format (required)',
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

  async previewChanges(args: any, callId?: string): Promise<void> {
    this.currentCallId = callId;

    const filePaths = args.file_paths as string[];
    if (!filePaths || !Array.isArray(filePaths)) {
      return;
    }

    // Generate previews for each file
    for (const filePath of filePaths) {
      await this.safelyEmitDiffPreview(
        filePath,
        async () => {
          const absPath = path.resolve(filePath);
          const oldContent = await fs.readFile(absPath, 'utf-8');
          const newContent = await this.formatFileContent(absPath, oldContent);
          return { oldContent, newContent };
        },
        'edit'
      );
    }
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

      const absPath = this.validateFilePath(filePath);
      if (absPath === null) {
        return this.formatErrorResponse(
          `Invalid file path '${filePath}': file not found or not accessible`,
          'validation_error',
          'Check the file path and ensure the file exists'
        );
      }

      validatedPaths.push(absPath);
    }

    // Process each file
    const fileResults: FormatResult[] = [];
    let filesFormatted = 0;
    let totalChanges = 0;

    for (const absPath of validatedPaths) {
      const fileResult: FormatResult = { file_path: absPath, changes_made: false };

      try {
        // Read original content
        const originalContent = await fs.readFile(absPath, 'utf-8');

        // Detect file type and get formatters
        const fileType = this.detectFileType(absPath);
        const formattersInfo = await this.getFormattersForType(fileType);

        if (!formattersInfo.available) {
          fileResult.error = formattersInfo.message;
          fileResult.suggestion = formattersInfo.suggestion;
          fileResults.push(fileResult);
          continue;
        }

        // Format the file
        let formattedContent = originalContent;
        const formattersApplied: string[] = [];
        const errors: string[] = [];

        for (const [formatterName, formatterFunc] of formattersInfo.formatters!) {
          try {
            formattedContent = await formatterFunc(absPath, formattedContent);
            formattersApplied.push(formatterName);
          } catch (error) {
            const errorMsg = `${formatterName} failed: ${formatError(error)}`;
            console.warn(`[FormatTool] ${errorMsg}`);
            errors.push(errorMsg);
          }
        }

        if (formattersApplied.length === 0) {
          fileResult.error = `All formatters failed. Errors: ${errors.join('; ')}`;
          fileResults.push(fileResult);
          continue;
        }

        // Check if changes were made
        const changesMade = formattedContent !== originalContent;

        fileResult.formatters_applied = formattersApplied;
        fileResult.changes_made = changesMade;

        if (changesMade) {
          // Write formatted content
          await fs.writeFile(absPath, formattedContent, 'utf-8');

          // Re-check file after formatting
          const checkResult = await this.checkFileAfterModification(absPath);
          if (checkResult) {
            fileResult.file_check = checkResult;
          }

          filesFormatted++;
          totalChanges++;
        }

        fileResults.push(fileResult);
      } catch (error: any) {
        fileResult.error = `Error: ${formatError(error)}`;
        fileResults.push(fileResult);
      }
    }

    return this.formatSuccessResponse({
      files_formatted: filesFormatted,
      files: fileResults,
      total_changes: totalChanges,
    });
  }

  /**
   * Format file content using appropriate formatters
   */
  private async formatFileContent(filePath: string, content: string): Promise<string> {
    const fileType = this.detectFileType(filePath);
    const formattersInfo = await this.getFormattersForType(fileType);

    if (!formattersInfo.available || !formattersInfo.formatters) {
      return content;
    }

    let formattedContent = content;
    for (const [, formatterFunc] of formattersInfo.formatters) {
      try {
        formattedContent = await formatterFunc(filePath, formattedContent);
      } catch {
        // Silently fail for preview
      }
    }

    return formattedContent;
  }

  /**
   * Detect file type from extension
   */
  private detectFileType(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();

    const typeMap: Record<string, string> = {
      '.ts': 'typescript',
      '.tsx': 'typescript',
      '.js': 'javascript',
      '.jsx': 'javascript',
      '.mjs': 'javascript',
      '.cjs': 'javascript',
      '.json': 'json',
      '.yml': 'yaml',
      '.yaml': 'yaml',
    };

    return typeMap[ext] || 'unknown';
  }

  /**
   * Get available formatters for a file type
   */
  private async getFormattersForType(fileType: string): Promise<FormatterInfo> {
    switch (fileType) {
      case 'typescript':
      case 'javascript': {
        const formatters: Array<[string, (fp: string, c: string) => Promise<string>]> = [];

        if (await this.isCommandAvailable('prettier')) {
          formatters.push(['prettier', this.formatWithPrettier.bind(this)]);
        }

        if (await this.isCommandAvailable('eslint')) {
          formatters.push(['eslint', this.formatWithEslint.bind(this)]);
        }

        if (formatters.length > 0) {
          return { available: true, formatters };
        }

        return {
          available: false,
          message: `No ${fileType} formatters available`,
          suggestion:
            'Install prettier and/or eslint: npm install -g prettier eslint (or add to project)',
        };
      }

      case 'json':
        return {
          available: true,
          formatters: [['json', this.formatJSON.bind(this)]],
        };

      case 'yaml':
        return {
          available: true,
          formatters: [['yaml', this.formatYAML.bind(this)]],
        };

      default:
        return {
          available: false,
          message: `No formatters available for ${fileType} files`,
          suggestion:
            'Supported types: TypeScript (.ts, .tsx), JavaScript (.js, .jsx), JSON (.json), YAML (.yml, .yaml)',
        };
    }
  }

  /**
   * Format with prettier
   */
  private async formatWithPrettier(filePath: string, content: string): Promise<string> {
    const { stdout } = await this.runCommand('prettier', ['--stdin-filepath', filePath], {
      input: content,
      timeout: API_TIMEOUTS.PRETTIER_FORMAT_TIMEOUT,
    });
    return stdout;
  }

  /**
   * Format with eslint --fix
   */
  private async formatWithEslint(filePath: string, content: string): Promise<string> {
    // Write to temp file in same directory (for config discovery)
    const fileDir = path.dirname(path.resolve(filePath));
    const fileName = path.basename(filePath);
    const baseName = path.parse(fileName).name;
    const ext = path.extname(fileName);

    const tmpPath = path.join(fileDir, `.${baseName}_eslint_${Date.now()}${ext}`);

    try {
      await fs.writeFile(tmpPath, content, 'utf-8');

      await this.runCommand('eslint', ['--fix', tmpPath], {
        cwd: fileDir,
        timeout: API_TIMEOUTS.ESLINT_FIX_TIMEOUT,
        ignoreErrors: true, // eslint returns non-zero on warnings
      });

      const fixed = await fs.readFile(tmpPath, 'utf-8');
      return fixed;
    } finally {
      await fs.unlink(tmpPath).catch(() => {});
    }
  }

  /**
   * Format JSON
   */
  private async formatJSON(_filePath: string, content: string): Promise<string> {
    const data = JSON.parse(content);
    return JSON.stringify(data, null, FORMATTING.JSON_INDENT_SPACES) + '\n';
  }

  /**
   * Format YAML
   */
  private async formatYAML(_filePath: string, content: string): Promise<string> {
    try {
      const yaml = await import('yaml');
      const data = yaml.parse(content);
      return yaml.stringify(data, { indent: FORMATTING.YAML_INDENT_SPACES, lineWidth: FORMATTING.YAML_LINE_WIDTH });
    } catch (error) {
      throw new Error(`YAML formatting failed: ${formatError(error)}`);
    }
  }

  /**
   * Check file after modification
   */
  private async checkFileAfterModification(
    filePath: string
  ): Promise<FormatResult['file_check'] | null> {
    try {
      await ensureRegistryInitialized();
      const content = await fs.readFile(filePath, 'utf-8');
      const registry = getDefaultRegistry();
      const result = await registry.checkFile(filePath, content);

      if (!result) {
        return null;
      }

      // Only include errors (not warnings) and limit to first 10
      const errors = result.errors.slice(0, BUFFER_SIZES.MAX_ERROR_DISPLAY);

      // Read content for error context
      const contentLines = content.split('\n');

      return {
        checker: result.checker,
        passed: result.passed,
        errors: errors.map((error) => {
          const formatted: any = {
            line: error.line,
            message: error.message,
          };

          if (error.column) {
            formatted.column = error.column;
          }

          // Add source code context
          if (error.line && error.line >= 1 && error.line <= contentLines.length) {
            const errorLine = contentLines[error.line - 1];
            if (errorLine) {
              formatted.source = errorLine.trim();

              // Add column marker
              if (error.column && error.column > 0) {
                const originalLine = contentLines[error.line - 1];
                if (originalLine) {
                  const leadingSpaces = originalLine.length - originalLine.trimStart().length;
                  const markerPos = Math.max(0, error.column - leadingSpaces - 1);
                  formatted.marker = ' '.repeat(markerPos) + '^';
                }
              }
            }
          }

          return formatted;
        }),
      };
    } catch {
      return null;
    }
  }

  /**
   * Check if a command is available
   */
  private async isCommandAvailable(command: string): Promise<boolean> {
    try {
      await this.runCommand(command, ['--version'], { timeout: API_TIMEOUTS.VERSION_CHECK });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Run a command and capture output
   */
  private runCommand(
    command: string,
    args: string[],
    options: {
      cwd?: string;
      timeout?: number;
      input?: string;
      ignoreErrors?: boolean;
    } = {}
  ): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const proc = spawn(command, args, {
        cwd: options.cwd,
      });

      let stdout = '';
      let stderr = '';

      if (options.input) {
        proc.stdin?.write(options.input);
        proc.stdin?.end();
      }

      proc.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      const timeout = options.timeout
        ? setTimeout(() => {
            proc.kill();
            reject(new Error('Command timeout'));
          }, options.timeout)
        : null;

      proc.on('close', (code) => {
        if (timeout) clearTimeout(timeout);

        if (code !== 0 && !options.ignoreErrors) {
          reject(new Error(`Command exited with code ${code}: ${stderr}`));
        } else {
          resolve({ stdout, stderr });
        }
      });

      proc.on('error', (error) => {
        if (timeout) clearTimeout(timeout);
        reject(error);
      });
    });
  }

  /**
   * Validate file path
   */
  private validateFilePath(filePath: string): string | null {
    try {
      const absPath = path.resolve(filePath);

      if (!fsSync.existsSync(absPath)) {
        return null;
      }

      const stats = fsSync.statSync(absPath);
      if (!stats.isFile()) {
        return null;
      }

      return absPath;
    } catch {
      return null;
    }
  }

  /**
   * Get result preview
   */
  getResultPreview(result: ToolResult, maxLines: number = 3): string[] {
    if (!result.success) {
      return super.getResultPreview(result, maxLines);
    }

    const previewLines: string[] = [];
    const filesFormatted = result.files_formatted || 0;
    const totalChanges = result.total_changes || 0;

    if (filesFormatted > 0) {
      previewLines.push(`Formatted ${filesFormatted} file${filesFormatted !== 1 ? 's' : ''}`);

      if (totalChanges > 0) {
        previewLines.push(`${totalChanges} file${totalChanges !== 1 ? 's' : ''} with changes`);
      }
    } else {
      previewLines.push('All files already formatted correctly');
    }

    return previewLines.slice(0, maxLines);
  }
}
