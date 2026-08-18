/** ApplyPatchTool - apply contextual unified-diff hunks to one existing file. */

import * as fs from 'fs/promises';
import { BaseTool } from './BaseTool.js';
import { ToolCapability } from './ToolCapability.js';
import type { ToolExecutionContext, ToolResult, FunctionDefinition } from '../types/index.js';
import type { ActivityStream } from '../services/ActivityStream.js';
import { resolvePath } from '../utils/pathUtils.js';
import { validateIsFile } from '../utils/pathValidator.js';
import { applyModelPatch, type AppliedModelPatch } from '../utils/patchApplier.js';
import { checkFileAfterModification } from '../utils/fileCheckUtils.js';
import { formatError } from '../utils/errorUtils.js';

const MAX_PATCH_CHARS = 1_000_000;

interface PreparedPatch {
  absolutePath: string;
  originalContent: string;
  modifiedContent: string;
  readRanges: NonNullable<AppliedModelPatch['readRanges']>;
  updatedReadRanges: NonNullable<AppliedModelPatch['updatedReadRanges']>;
  hunkCount: number;
}

class PatchInputError extends Error {
  constructor(message: string, readonly suggestion?: string) {
    super(message);
  }
}

export class ApplyPatchTool extends BaseTool {
  readonly name = 'apply-patch';
  readonly description =
    'Modify one existing text file with contextual unified-diff hunks. Read each target region first. Use write only to create new files.';
  readonly capabilities = [ToolCapability.FsRead, ToolCapability.FsWrite] as const;
  readonly hideOutput = true;

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
            file_path: {
              type: 'string',
              format: 'local-path',
              description: 'Existing text file to modify.',
            },
            patch: {
              type: 'string',
              description:
                'Unified-diff hunks, for example: @@ -1,3 +1,3 @@\\n unchanged\\n-old\\n+new\\n unchanged. File headers are optional; hunk line counts are derived from the body.',
            },
            show_updated_context: {
              type: 'boolean',
              description: 'Return and track the complete updated file as read (default false).',
            },
          },
          required: ['file_path', 'patch'],
        },
      },
    };
  }

  async validateBeforePermission(
    args: Record<string, unknown>,
    executionContext?: ToolExecutionContext
  ): Promise<ToolResult | null> {
    try {
      await this.prepare(args, executionContext);
      return null;
    } catch (error) {
      return this.inputError(error);
    }
  }

  async previewChanges(args: Record<string, unknown>, callId?: string): Promise<void> {
    await super.previewChanges(args, callId);
    try {
      const prepared = await this.prepare(args);
      await this.safelyEmitDiffPreview(
        prepared.absolutePath,
        async () => ({
          oldContent: prepared.originalContent,
          newContent: prepared.modifiedContent,
        }),
        'apply-patch',
        prepared.hunkCount
      );
    } catch {
      // Execution returns the actionable validation error.
    }
  }

  protected async executeImpl(
    args: Record<string, unknown>,
    _toolCallId?: string,
    _isUserInitiated?: boolean,
    _isContextFile?: boolean,
    executionContext?: ToolExecutionContext
  ): Promise<ToolResult> {
    this.captureParams(args);

    try {
      const prepared = await this.prepare(args, executionContext);
      const registry = this.getExecutionRegistry(executionContext);
      const readStateManager = registry.get('read_state_manager');
      const showUpdatedContext = args.show_updated_context === true;

      const { patchNumber, diff } = await this.finalizeEdit({
        absolutePath: prepared.absolutePath,
        originalContent: prepared.originalContent,
        modifiedContent: prepared.modifiedContent,
        operationType: 'apply-patch',
        showUpdatedContext,
        knownUpdatedRanges: prepared.updatedReadRanges,
        readStateManager,
        executionContext,
      });

      const response = this.formatSuccessResponse({
        content: `Applied ${prepared.hunkCount} patch hunk(s) to ${prepared.absolutePath}`,
        file_path: prepared.absolutePath,
        hunks_applied: prepared.hunkCount,
        diff,
      });
      response.system_reminder = showUpdatedContext
        ? 'The returned updated content is tracked as read for the next patch.'
        : 'Previous read evidence is stale; only updated lines represented by this patch remain tracked as read.';
      if (patchNumber !== null) response.patch_number = patchNumber;
      if (showUpdatedContext) response.updated_content = prepared.modifiedContent;

      const checkResult = await checkFileAfterModification(prepared.absolutePath);
      if (checkResult) response.file_check = checkResult;
      return response;
    } catch (error) {
      if (error instanceof PatchInputError) return this.inputError(error);
      return this.formatErrorResponse(
        `Failed to apply patch: ${formatError(error)}`,
        'system_error',
        'Re-read the target region and retry with current context.'
      );
    }
  }

  private async prepare(
    args: Record<string, unknown>,
    executionContext?: ToolExecutionContext
  ): Promise<PreparedPatch> {
    const filePath = typeof args.file_path === 'string' ? args.file_path : '';
    const patch = typeof args.patch === 'string' ? args.patch : '';
    if (!filePath) throw new PatchInputError('file_path parameter is required');
    if (!patch) throw new PatchInputError('patch parameter is required');
    if (patch.length > MAX_PATCH_CHARS) {
      throw new PatchInputError(`patch exceeds the ${MAX_PATCH_CHARS}-character limit`, 'Split it into smaller, focused patches.');
    }

    const absolutePath = resolvePath(filePath);
    const fileValidation = await validateIsFile(absolutePath);
    if (!fileValidation.valid) {
      throw new PatchInputError(fileValidation.error ?? `File not found: ${filePath}`, 'Use write to create a new file.');
    }

    const originalContent = await fs.readFile(absolutePath, 'utf-8');
    const applied = applyModelPatch(patch, originalContent);
    if (!applied.success || applied.content === undefined) {
      throw new PatchInputError(
        applied.error ?? 'Patch could not be applied',
        'Re-read the exact target region and retry with a smaller contextual hunk. Do not delete and recreate the file.'
      );
    }

    const registry = this.getExecutionRegistry(executionContext);
    const readStateManager = registry.get('read_state_manager');
    if (readStateManager) {
      const readScopeId = this.getReadScopeId(executionContext);
      for (const range of applied.readRanges ?? []) {
        const validation = readStateManager.validateLinesRead(
          absolutePath,
          range.start,
          range.end,
          readScopeId
        );
        if (!validation.success) {
          throw new PatchInputError(
            `Patch targets unread lines ${range.start}-${range.end} in ${filePath}`,
            `Use read(file_path="${filePath}", offset=${range.start}, limit=${range.end - range.start + 1}) before patching.`
          );
        }
      }
    }

    return {
      absolutePath,
      originalContent,
      modifiedContent: applied.content,
      readRanges: applied.readRanges ?? [],
      updatedReadRanges: applied.updatedReadRanges ?? [],
      hunkCount: applied.hunkCount ?? 0,
    };
  }

  private inputError(error: unknown): ToolResult {
    const inputError = error instanceof PatchInputError
      ? error
      : new PatchInputError(formatError(error));
    return this.formatErrorResponse(
      inputError.message,
      'validation_error',
      inputError.suggestion
    );
  }

  formatSubtext(args: Record<string, unknown>): string | null {
    const filePath = typeof args.file_path === 'string' ? args.file_path : '';
    return filePath.split('/').pop() || filePath || null;
  }

  getSubtextParameters(): string[] {
    return ['file_path', 'patch'];
  }
}
