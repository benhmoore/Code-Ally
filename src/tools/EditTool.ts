/**
 * EditTool - Find and replace text in files (Batch-only design)
 *
 * Performs exact string matching and replacement with multi-line support.
 * All edits are processed as batches for atomicity and consistency.
 * Edits are applied sequentially - each edit sees the cumulative result of previous edits.
 */

import { BaseTool } from './BaseTool.js';
import { ToolResult, FunctionDefinition } from '../types/index.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { ServiceRegistry } from '../services/ServiceRegistry.js';
import { ReadStateManager } from '../services/ReadStateManager.js';
import { resolvePath } from '../utils/pathUtils.js';
import { validateIsFile } from '../utils/pathValidator.js';
import { formatError } from '../utils/errorUtils.js';
import { checkFileAfterModification } from '../utils/fileCheckUtils.js';
import { createUnifiedDiff } from '../utils/diffUtils.js';
import { TEXT_LIMITS } from '../config/constants.js';
import * as fs from 'fs/promises';

/**
 * Single edit operation in a batch
 */
interface EditOperation {
  old_string: string;
  new_string: string;
  replace_all?: boolean; // Default: false
}

export class EditTool extends BaseTool {
  readonly name = 'edit';
  readonly description = 'Make edits to a file using find-and-replace. Always accepts an array of edits for atomic processing. Edits are applied sequentially - each edit sees the cumulative result of previous edits.';
  readonly requiresConfirmation = true; // Destructive operation
  readonly hideOutput = true; // Hide output from result preview

  constructor(activityStream: ActivityStream) {
    super(activityStream);
  }

  /**
   * Validate before permission request
   * Checks if target strings have been read for all edits in the batch
   */
  async validateBeforePermission(args: any): Promise<ToolResult | null> {
    const filePath = args.file_path as string;
    const edits = args.edits as EditOperation[] | undefined;

    if (!edits || !Array.isArray(edits) || edits.length === 0) {
      return null; // Skip validation if no edits provided (will be caught in executeImpl)
    }

    const absolutePath = resolvePath(filePath);
    const registry = ServiceRegistry.getInstance();
    const readStateManager = registry.get<ReadStateManager>('read_state_manager');

    if (!readStateManager) {
      return null; // No read state manager, skip validation
    }

    try {
      const content = await fs.readFile(absolutePath, 'utf-8');

      // Validate read state for each edit
      for (let i = 0; i < edits.length; i++) {
        const edit = edits[i];
        const editNum = i + 1;

        if (!edit || !edit.old_string) {
          continue; // Skip invalid edits (will be caught in executeImpl)
        }

        // Check for no-op edit
        if (edit.old_string === edit.new_string) {
          return this.formatErrorResponse(
            `Edit ${editNum}: old_string and new_string cannot be the same`,
            'validation_error'
          );
        }

        const linesToEdit = this.findLinesToEdit(content, edit.old_string);

        if (linesToEdit) {
          const validation = readStateManager.validateLinesRead(
            absolutePath,
            linesToEdit.start,
            linesToEdit.end
          );

          if (!validation.success) {
            return this.formatErrorResponse(
              `Edit ${editNum}: Lines not read. EditTool requires reading the lines being edited. Use read(file_paths=["${filePath}"], offset=${linesToEdit.start}, limit=${linesToEdit.end - linesToEdit.start + 1})`,
              'validation_error'
            );
          }
        }
      }

      return null; // All validations passed
    } catch (error) {
      // File doesn't exist or can't be read - let executeImpl handle this
      return null;
    }
  }

  /**
   * Provide custom function definition (Batch-only design)
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
            edits: {
              type: 'array',
              description: 'Array of edit operations to apply atomically. Edits are applied sequentially - each edit sees the cumulative result of previous edits. Each edit requires: old_string (text to find), new_string (replacement text), and optional replace_all (default: false).',
              items: {
                type: 'object',
                properties: {
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
                required: ['old_string', 'new_string'],
              },
            },
            show_updated_context: {
              type: 'boolean',
              description: 'Include the updated file content in the response (default: false). Useful for verifying changes or making follow-up edits without a separate Read call.',
            },
          },
          required: ['file_path', 'edits'],
        },
      },
    };
  }

  /**
   * Preview batch edits by applying them in memory and showing the diff
   */
  async previewChanges(args: any, callId?: string): Promise<void> {
    await super.previewChanges(args, callId);

    const filePath = args.file_path as string;
    const edits = args.edits as EditOperation[] | undefined;

    if (!filePath || !edits || !Array.isArray(edits) || edits.length === 0) {
      return; // Skip preview if invalid args
    }

    const absolutePath = resolvePath(filePath);

    await this.safelyEmitDiffPreview(
      absolutePath,
      async () => {
        await fs.access(absolutePath);
        const content = await fs.readFile(absolutePath, 'utf-8');

        // Apply all edits sequentially in memory for preview
        let modifiedContent = content;

        for (const edit of edits) {
          const oldString = edit.old_string;
          const newString = edit.new_string;
          const replaceAll = edit.replace_all === true;

          if (!oldString || newString === undefined) {
            continue; // Skip invalid edits
          }

          // Apply replacement
          modifiedContent = replaceAll
            ? modifiedContent.split(oldString).join(newString)
            : modifiedContent.replace(oldString, newString);
        }

        return { oldContent: content, newContent: modifiedContent };
      },
      'edit'
    );
  }

  /**
   * Execute batch edits - single code path for all edits
   */
  protected async executeImpl(args: any): Promise<ToolResult> {
    this.captureParams(args);

    const filePath = args.file_path as string;
    const edits = args.edits as EditOperation[] | undefined;
    const showUpdatedContext = args.show_updated_context === true;

    // Validate required parameters
    if (!filePath) {
      return this.formatErrorResponse(
        'file_path parameter is required',
        'validation_error',
        'Example: edit(file_path="foo.ts", edits=[{old_string:"foo", new_string:"bar"}])'
      );
    }

    if (!edits || !Array.isArray(edits) || edits.length === 0) {
      return this.formatErrorResponse(
        'edits array required with at least one operation',
        'validation_error',
        'Example: edit(file_path="foo.ts", edits=[{old_string:"foo", new_string:"bar"}])'
      );
    }

    // Execute batch edits (everything goes through this)
    return this.executeBatchEdits(filePath, edits, showUpdatedContext);
  }

  /**
   * Execute batch edits atomically
   * All edits are validated upfront, then applied sequentially
   */
  private async executeBatchEdits(
    filePath: string,
    edits: EditOperation[],
    showUpdatedContext: boolean
  ): Promise<ToolResult> {
    // Step 1: Resolve absolute path
    const absolutePath = resolvePath(filePath);

    try {
      // Step 2: Validate file exists and is a file
      const validation = await validateIsFile(absolutePath);
      if (!validation.valid) {
        return this.formatErrorResponse(
          validation.error!,
          'user_error',
          'Check that the file path is correct'
        );
      }

      // Step 3: Read original file content
      const content = await fs.readFile(absolutePath, 'utf-8');

      // Step 4: Validate ALL edits atomically
      const validationErrors: string[] = [];
      const registry = ServiceRegistry.getInstance();
      const readStateManager = registry.get<ReadStateManager>('read_state_manager');

      // Track cumulative content for validation (each edit sees previous edits' results)
      let cumulativeContent = content;

      // Loop through all edits and collect ALL validation errors
      for (let i = 0; i < edits.length; i++) {
        const edit = edits[i];
        const editNum = i + 1; // Use 1-based numbering for user-facing errors

        // Validate edit object exists
        if (!edit) {
          validationErrors.push(`Edit ${editNum}: undefined edit object`);
          continue;
        }

        // Validate old_string exists and is not empty
        if (!edit.old_string || edit.old_string.length === 0) {
          validationErrors.push(`Edit ${editNum}: old_string is required and cannot be empty`);
          continue;
        }

        // Validate new_string exists (can be empty string if replacing with nothing)
        if (edit.new_string === undefined || edit.new_string === null) {
          validationErrors.push(`Edit ${editNum}: new_string is required`);
          continue;
        }

        // Validate old_string !== new_string (no-op check)
        if (edit.old_string === edit.new_string) {
          validationErrors.push(`Edit ${editNum}: old_string and new_string cannot be the same`);
          continue;
        }

        // Validate old_string exists in cumulative content
        const count = this.countOccurrences(cumulativeContent, edit.old_string);
        if (count === 0) {
          const suggestions = this.findSimilarStrings(cumulativeContent, edit.old_string, 3);
          let suggestionText = `old_string not found: "${this.truncate(edit.old_string, TEXT_LIMITS.EDIT_TARGET_PREVIEW_MAX)}"`;

          if (suggestions.length > 0) {
            suggestionText += '. Similar strings found:';
            for (const [match, reason] of suggestions) {
              suggestionText += `\n  - "${this.truncate(match, TEXT_LIMITS.EDIT_TARGET_PREVIEW_MAX)}" (${reason})`;
            }
          }

          validationErrors.push(`Edit ${editNum}: ${suggestionText}`);
          continue;
        }

        // Check uniqueness if not replace_all
        const replaceAll = edit.replace_all === true;
        if (!replaceAll && count > 1) {
          validationErrors.push(
            `Edit ${editNum}: old_string appears ${count} times. Must be unique or use replace_all=true`
          );
          continue;
        }

        // Validate read state using ReadStateManager (check in original content)
        if (readStateManager) {
          const linesToEdit = this.findLinesToEdit(content, edit.old_string);

          if (linesToEdit) {
            const validation = readStateManager.validateLinesRead(
              absolutePath,
              linesToEdit.start,
              linesToEdit.end
            );

            if (!validation.success) {
              validationErrors.push(
                `Edit ${editNum}: Lines ${linesToEdit.start}-${linesToEdit.end} not read. Use read(file_paths=["${filePath}"], offset=${linesToEdit.start}, limit=${linesToEdit.end - linesToEdit.start + 1})`
              );
            }
          }
        }

        // Always update cumulative content for accurate validation of subsequent edits
        cumulativeContent = replaceAll
          ? cumulativeContent.split(edit.old_string).join(edit.new_string)
          : cumulativeContent.replace(edit.old_string, edit.new_string);
      }

      // If ANY validation failed, return error without applying ANY edits (atomic validation)
      if (validationErrors.length > 0) {
        return this.formatErrorResponse(
          `Batch edit validation failed with ${validationErrors.length} error(s):\n${validationErrors.map(e => `  • ${e}`).join('\n')}`,
          'validation_error',
          'All edits must pass validation before any are applied. Fix the errors and try again.'
        );
      }

      // Step 5: Apply edits sequentially
      let modifiedContent = content;
      const appliedEdits: string[] = [];
      let totalReplacements = 0;

      for (let i = 0; i < edits.length; i++) {
        const edit = edits[i];
        if (!edit) continue; // Skip undefined edits (shouldn't happen after validation)

        const editNum = i + 1;
        const replaceAll = edit.replace_all === true;

        // Count occurrences in current state
        const count = this.countOccurrences(modifiedContent, edit.old_string);

        // Apply replacement
        modifiedContent = replaceAll
          ? modifiedContent.split(edit.old_string).join(edit.new_string)
          : modifiedContent.replace(edit.old_string, edit.new_string);

        const replacements = replaceAll ? count : 1;
        totalReplacements += replacements;

        appliedEdits.push(
          `Edit ${editNum}: Made ${replacements} replacement(s) of "${this.truncate(edit.old_string, 30)}" → "${this.truncate(edit.new_string, 30)}"`
        );
      }

      // Step 6: Write modified content to file
      await fs.writeFile(absolutePath, modifiedContent, 'utf-8');

      // Step 7: Update read state - clear entire file
      if (readStateManager) {
        readStateManager.clearFile(absolutePath);
      }

      // Step 8: Capture patch for undo functionality
      const patchNumber = await this.captureOperationPatch(
        'edit',
        absolutePath,
        content,
        modifiedContent
      );

      // Step 9: Generate unified diff
      const diff = createUnifiedDiff(content, modifiedContent, absolutePath);

      // Step 10: Build success response
      const successMessage =
        `Batch edit completed: ${edits.length} operation(s) applied (${totalReplacements} total replacement(s))\n\n` +
        appliedEdits.join('\n');

      const response = this.formatSuccessResponse({
        content: successMessage,
        file_path: absolutePath,
        edits_applied: edits.length,
        total_replacements: totalReplacements,
        diff,
      });

      // Add system reminder about invalidated content
      response.system_reminder =
        'All content has been invalidated due to edits. To edit again, either re-read the file or use show_updated_context=true';

      // Add patch information to result if patch was captured
      if (patchNumber !== null) {
        response.patch_number = patchNumber;
      }

      // Include updated file content if requested
      if (showUpdatedContext) {
        response.updated_content = modifiedContent;
      }

      // Step 11: Check file for syntax/parse errors after modification
      const checkResult = await checkFileAfterModification(absolutePath);
      if (checkResult) {
        response.file_check = checkResult;
      }

      return response;
    } catch (error) {
      return this.formatErrorResponse(
        `Failed to perform batch edit: ${formatError(error)}`,
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
   * Find the line range containing the old_string to be edited
   * Returns null if old_string is not found
   */
  private findLinesToEdit(
    content: string,
    oldString: string
  ): { start: number; end: number } | null {
    // Find the first occurrence of old_string
    const index = content.indexOf(oldString);
    if (index === -1) {
      return null; // String not found
    }

    // Convert character index to line numbers
    const beforeMatch = content.substring(0, index);
    const startLine = beforeMatch.split('\n').length; // 1-indexed

    // Count newlines in the old_string to find end line
    const newlinesInMatch = (oldString.match(/\n/g) || []).length;
    const endLine = startLine + newlinesInMatch;

    return { start: startLine, end: endLine };
  }

  /**
   * Custom result preview for edit tool
   */
  getResultPreview(result: ToolResult, maxLines: number = 3): string[] {
    if (!result.success) {
      return super.getResultPreview(result, maxLines);
    }

    const lines: string[] = [];
    const editsApplied = result.edits_applied ?? 0;
    const totalReplacements = result.total_replacements ?? 0;
    const filePath = result.file_path ?? 'unknown file';

    lines.push(
      `Batch edit: ${editsApplied} operation(s) applied, ${totalReplacements} total replacement(s) in ${filePath}`
    );

    return lines;
  }
}
