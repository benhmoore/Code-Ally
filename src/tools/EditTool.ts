/**
 * EditTool - Find and replace text in files
 *
 * Performs exact string matching and replacement with multi-line support.
 */

import { BaseTool } from './BaseTool.js';
import { ToolResult, FunctionDefinition } from '../types/index.js';
import { ActivityStream } from '../services/ActivityStream.js';
import * as fs from 'fs/promises';
import * as path from 'path';

export class EditTool extends BaseTool {
  readonly name = 'edit';
  readonly description =
    'Find and replace text in a file. Performs exact string matching. Use this for precise text replacements.';
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
            old_string: {
              type: 'string',
              description: 'Exact text to find and replace',
            },
            new_string: {
              type: 'string',
              description: 'Text to replace old_string with',
            },
            replace_all: {
              type: 'boolean',
              description: 'Replace all occurrences instead of just one (default: false)',
            },
          },
          required: ['file_path', 'old_string', 'new_string'],
        },
      },
    };
  }

  async previewChanges(args: any, callId?: string): Promise<void> {
    await super.previewChanges(args, callId);

    const filePath = args.file_path as string;
    const oldString = args.old_string as string;
    const newString = args.new_string as string;
    const replaceAll = args.replace_all === true;

    if (!filePath || !oldString || newString === undefined) {
      return; // Skip preview if invalid args
    }

    const absolutePath = path.isAbsolute(filePath)
      ? filePath
      : path.join(process.cwd(), filePath);

    try {
      await fs.access(absolutePath);
      const content = await fs.readFile(absolutePath, 'utf-8');

      // Generate preview of changes
      let modifiedContent: string;
      if (replaceAll) {
        modifiedContent = content.split(oldString).join(newString);
      } else {
        modifiedContent = content.replace(oldString, newString);
      }

      // Emit diff preview
      this.emitDiffPreview(content, modifiedContent, absolutePath, 'edit');
    } catch {
      // Silently fail preview - let actual execute handle errors
    }
  }

  protected async executeImpl(args: any): Promise<ToolResult> {
    // Capture parameters
    this.captureParams(args);

    // Extract and validate parameters
    const filePath = args.file_path as string;
    const oldString = args.old_string as string;
    const newString = args.new_string as string;
    const replaceAll = args.replace_all === true; // Default is false

    if (!filePath) {
      return this.formatErrorResponse(
        'file_path parameter is required',
        'validation_error',
        'Example: edit(file_path="src/main.ts", old_string="old", new_string="new")'
      );
    }

    if (oldString === undefined || oldString === null) {
      return this.formatErrorResponse(
        'old_string parameter is required',
        'validation_error'
      );
    }

    if (newString === undefined || newString === null) {
      return this.formatErrorResponse(
        'new_string parameter is required',
        'validation_error'
      );
    }

    if (oldString === newString) {
      return this.formatErrorResponse(
        'old_string and new_string cannot be the same',
        'validation_error'
      );
    }

    // Resolve absolute path
    const absolutePath = path.isAbsolute(filePath)
      ? filePath
      : path.join(process.cwd(), filePath);

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

      // Read file content
      const content = await fs.readFile(absolutePath, 'utf-8');

      // Check that old_string exists
      const count = this.countOccurrences(content, oldString);
      if (count === 0) {
        const suggestions = this.findSimilarStrings(content, oldString, 3);
        let suggestionText = 'Use the Read tool to see the current file content.';

        if (suggestions.length > 0) {
          suggestionText += '\n\nSimilar strings found:';
          for (const [match, reason] of suggestions) {
            suggestionText += `\n- "${this.truncate(match, 100)}" (${reason})`;
          }
        }

        return this.formatErrorResponse(
          `old_string not found in file: "${this.truncate(oldString, 100)}"`,
          'user_error',
          suggestionText
        );
      }

      // Check uniqueness if not replace_all
      if (!replaceAll && count > 1) {
        return this.formatErrorResponse(
          `old_string appears ${count} times in file. Must be unique or use replace_all=true`,
          'user_error',
          'Set replace_all=true to replace all occurrences, or provide a unique old_string'
        );
      }

      // Perform replacement
      let modifiedContent: string;
      if (replaceAll) {
        modifiedContent = content.split(oldString).join(newString);
      } else {
        modifiedContent = content.replace(oldString, newString);
      }

      // Write the modified content
      await fs.writeFile(absolutePath, modifiedContent, 'utf-8');

      const successMessage = `Made ${replaceAll ? count : 1} replacement(s) in ${absolutePath}`;

      return this.formatSuccessResponse({
        content: successMessage, // Human-readable output for LLM
        file_path: absolutePath,
        replacements_made: replaceAll ? count : 1,
      });
    } catch (error) {
      return this.formatErrorResponse(
        `Failed to edit file: ${error instanceof Error ? error.message : String(error)}`,
        'system_error'
      );
    }
  }

  /**
   * Count occurrences of a substring
   */
  private countOccurrences(text: string, substring: string): number {
    if (substring.length === 0) return 0;
    return text.split(substring).length - 1;
  }

  /**
   * Truncate a string for display
   */
  private truncate(str: string, maxLength: number): string {
    if (str.length <= maxLength) return str;
    return str.substring(0, maxLength - 3) + '...';
  }

  /**
   * Find similar strings in text
   */
  private findSimilarStrings(
    text: string,
    target: string,
    maxMatches: number = 3
  ): Array<[string, string]> {
    const matches: Array<[string, string]> = [];

    // Handle multi-line targets
    if (target.includes('\n')) {
      const targetNormalized = target.split(/\s+/).join(' ');
      const textNormalized = text.split(/\s+/).join(' ');

      if (textNormalized.includes(targetNormalized)) {
        matches.push([
          target.substring(0, 100),
          'Multi-line string with whitespace differences',
        ]);
      }
      return matches;
    }

    // Single-line: check lines
    const lines = text.split('\n');
    for (let i = 0; i < lines.length && matches.length < maxMatches; i++) {
      const line = lines[i];
      if (!line) continue; // Skip undefined lines

      // Check for whitespace/indentation differences
      if (line.trim() === target.trim()) {
        matches.push([`Line ${i + 1}: ${line}`, 'Whitespace/indentation difference']);
        continue;
      }

      // Check for case differences
      if (line.toLowerCase() === target.toLowerCase()) {
        matches.push([`Line ${i + 1}: ${line}`, 'Capitalization difference']);
        continue;
      }

      // Check for internal whitespace differences
      if (line.split(/\s+/).join(' ') === target.split(/\s+/).join(' ')) {
        matches.push([`Line ${i + 1}: ${line}`, 'Internal whitespace difference']);
        continue;
      }

      // Check for substring matches
      if (target.length > 5 && (line.includes(target) || target.includes(line))) {
        matches.push([`Line ${i + 1}: ${line}`, 'Partial match (substring)']);
        continue;
      }
    }

    return matches;
  }

  /**
   * Custom result preview for edit tool
   */
  getResultPreview(result: ToolResult, maxLines: number = 3): string[] {
    if (!result.success) {
      return super.getResultPreview(result, maxLines);
    }

    const lines: string[] = [];
    const replacementsMade = result.replacements_made ?? 0;
    const filePath = result.file_path ?? 'unknown file';

    lines.push(
      `Made ${replacementsMade} replacement${replacementsMade !== 1 ? 's' : ''} in ${filePath}`
    );

    return lines;
  }
}
