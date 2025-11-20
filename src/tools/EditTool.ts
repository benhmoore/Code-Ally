/**
 * EditTool - Find and replace text in files
 *
 * Performs exact string matching and replacement with multi-line support.
 */

import { BaseTool } from './BaseTool.js';
import { ToolResult, FunctionDefinition } from '../types/index.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { ServiceRegistry } from '../services/ServiceRegistry.js';
import { FocusManager } from '../services/FocusManager.js';
import { ReadStateManager } from '../services/ReadStateManager.js';
import { resolvePath } from '../utils/pathUtils.js';
import { validateIsFile } from '../utils/pathValidator.js';
import { formatError } from '../utils/errorUtils.js';
import { checkFileAfterModification } from '../utils/fileCheckUtils.js';
import { TEXT_LIMITS } from '../config/constants.js';
import * as fs from 'fs/promises';

export class EditTool extends BaseTool {
  readonly name = 'edit';
  readonly description = 'Make edits to a single file using find-and-replace';
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
            show_updated_context: {
              type: 'boolean',
              description: 'Include the updated file content in the response (default: false). Useful for verifying changes or making follow-up edits without a separate Read call.',
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

    const absolutePath = resolvePath(filePath);

    await this.safelyEmitDiffPreview(
      absolutePath,
      async () => {
        await fs.access(absolutePath);
        const content = await fs.readFile(absolutePath, 'utf-8');

        // Generate preview of changes
        const modifiedContent = replaceAll
          ? content.split(oldString).join(newString)
          : content.replace(oldString, newString);

        return { oldContent: content, newContent: modifiedContent };
      },
      'edit'
    );
  }

  protected async executeImpl(args: any): Promise<ToolResult> {
    // Capture parameters
    this.captureParams(args);

    // Extract and validate parameters
    const filePath = args.file_path as string;
    const oldString = args.old_string as string;
    const newString = args.new_string as string;
    const replaceAll = args.replace_all === true; // Default is false
    const showUpdatedContext = args.show_updated_context === true; // Default is false

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

    if (oldString.length === 0) {
      return this.formatErrorResponse(
        'old_string cannot be empty',
        'validation_error'
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
      // Validate that the path is a file
      const validation = await validateIsFile(absolutePath);
      if (!validation.valid) {
        return this.formatErrorResponse(
          validation.error!,
          'user_error',
          'Check that the file path is correct'
        );
      }

      // Read file content
      const content = await fs.readFile(absolutePath, 'utf-8');

      // EditTool requires reading the entire file for safe string-based operations
      const readStateManager = registry.get<ReadStateManager>('read_state_manager');

      if (readStateManager) {
        const totalLines = content.split('\n').length;
        const validation = readStateManager.validateLinesRead(absolutePath, 1, totalLines);

        if (!validation.success) {
          return this.formatErrorResponse(
            `Lines not read: EditTool requires reading the entire file before editing. Use the Read tool first: read(file_paths=["${filePath}"])`,
            'validation_error'
          );
        }
      }

      // Check that old_string exists
      const count = this.countOccurrences(content, oldString);
      if (count === 0) {
        const suggestions = this.findSimilarStrings(content, oldString, 3);
        let suggestionText = 'Use the Read tool to see the current file content.';

        if (suggestions.length > 0) {
          suggestionText += '\n\nSimilar strings found:';
          for (const [match, reason] of suggestions) {
            suggestionText += `\n- "${this.truncate(match, TEXT_LIMITS.EDIT_TARGET_PREVIEW_MAX)}" (${reason})`;
          }
        }

        return this.formatErrorResponse(
          `old_string not found in file: "${this.truncate(oldString, TEXT_LIMITS.EDIT_TARGET_PREVIEW_MAX)}"`,
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

      // Clear read state after EditTool execution
      // File content has changed, so cached read state is stale
      if (readStateManager) {
        readStateManager.clearFile(absolutePath);
      }

      // Capture the operation as a patch for undo functionality
      const patchNumber = await this.captureOperationPatch(
        'edit',
        absolutePath,
        content,
        modifiedContent
      );

      // Build success message with proactive warning if needed
      let successMessage = `Made ${replaceAll ? count : 1} replacement(s) in ${absolutePath}`;

      // Add proactive warning if line count changed and context not shown
      const oldLines = oldString.split('\n').length;
      const newLines = newString.split('\n').length;
      const lineDelta = newLines - oldLines;

      if (lineDelta !== 0 && !showUpdatedContext) {
        successMessage += `\n\n⚠️  Lines affected by this edit were invalidated. To edit again, either re-read the file or use show_updated_context=true`;
      }

      const response = this.formatSuccessResponse({
        content: successMessage, // Human-readable output for LLM
        file_path: absolutePath,
        replacements_made: replaceAll ? count : 1,
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
    return str.substring(0, maxLength - TEXT_LIMITS.ELLIPSIS_LENGTH) + '...';
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
          target.substring(0, TEXT_LIMITS.EDIT_TARGET_PREVIEW_MAX),
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
      if (target.length > TEXT_LIMITS.EDIT_TARGET_MIN_LENGTH && (line.includes(target) || target.includes(line))) {
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
