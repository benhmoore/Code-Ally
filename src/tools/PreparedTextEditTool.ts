/** Shared immutable preparation, scoped preview, and atomic text-edit publication. */

import * as fs from 'fs/promises';
import { assertTextEditContent, decodeTextEditSource } from '../utils/textEditContent.js';
import { BaseTool } from './BaseTool.js';
import { ToolCapability } from './ToolCapability.js';
import type { ToolExecutionContext, ToolResult, FunctionDefinition } from '../types/index.js';
import type { ActivityStream } from '../services/ActivityStream.js';
import { resolvePath } from '../utils/pathUtils.js';
import { validateIsFile } from '../utils/pathValidator.js';
import { type AppliedModelPatch } from '../utils/patchApplier.js';
import { checkFileAfterModification } from '../utils/fileCheckUtils.js';
import { formatError } from '../utils/errorUtils.js';
import { CONTEXT_SIZES, TOKEN_MANAGEMENT } from '../config/constants.js';
import { fileMutationCoordinator } from '../services/FileMutationCoordinator.js';

export interface PreparedTextEdit {
  absolutePath: string;
  originalContent: string;
  modifiedContent: string;
  readRanges: NonNullable<AppliedModelPatch['readRanges']>;
  editRanges: NonNullable<AppliedModelPatch['editRanges']>;
  hunkCount: number;
}

export class TextEditInputError extends Error {
  constructor(
    message: string,
    readonly suggestion?: string
  ) {
    super(message);
  }
}

export abstract class PreparedTextEditTool extends BaseTool {
  override readonly argumentCompaction = {
    payloadPaths: [['patch'], ['old_text'], ['new_text']],
    durableReceipt: 'successful-tool-result',
  } as const;
  readonly name = 'apply-patch';
  abstract readonly description: string;
  readonly capabilities = [ToolCapability.FsRead, ToolCapability.FsWrite] as const;
  readonly hideOutput = true;

  constructor(activityStream: ActivityStream) {
    super(activityStream);
  }

  abstract getFunctionDefinition(): FunctionDefinition;
  protected abstract validateInput(args: Record<string, unknown>): void;
  protected decodeSource(bytes: Uint8Array): string {
    try {
      return decodeTextEditSource(bytes);
    } catch (error) {
      throw new TextEditInputError(error instanceof Error ? error.message : String(error));
    }
  }
  protected abstract transformSource(args: Readonly<Record<string, unknown>>, source: string): AppliedModelPatch;
  private readonly prepared = new WeakMap<
    object,
    {
      signature: string;
      absolutePath: string;
      value: Promise<Readonly<PreparedTextEdit>>;
    }
  >();

  override releasePreparedInvocation(args: Record<string, unknown>): void {
    this.prepared.delete(args);
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
      const context = this.currentExecutionContext;
      if (context?.turnInterruptionSignal?.aborted) throw new Error('Edit preview interrupted');
      const prepared = await this.prepare(args, context);
      if (context?.turnInterruptionSignal?.aborted) throw new Error('Edit preview interrupted');
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

      const signals = [this.currentAbortSignal, executionContext?.turnInterruptionSignal].filter(
        (signal): signal is AbortSignal => !!signal
      );
      const abortSignal = signals.length ? AbortSignal.any(signals) : undefined;
      abortSignal?.throwIfAborted();
      const { patchNumber, diff } = await this.finalizeEdit({
        absolutePath: prepared.absolutePath,
        originalContent: prepared.originalContent,
        modifiedContent: prepared.modifiedContent,
        operationType: 'apply-patch',
        editRanges: prepared.editRanges,
        readStateManager,
        executionContext,
        abortSignal,
      });

      const response = this.formatSuccessResponse({
        content: `Updated ${prepared.absolutePath}`,
        file_path: prepared.absolutePath,
        hunks_applied: prepared.hunkCount,
        diff,
      });
      response.system_reminder =
        'Your read evidence was updated through this edit; other agents must re-read the changed file.';
      if (patchNumber !== null) response.patch_number = patchNumber;

      const checkResult = await checkFileAfterModification(prepared.absolutePath);
      if (checkResult) response.file_check = checkResult;
      if (showUpdatedContext) {
        const candidate = {
          ...response,
          updated_content: prepared.modifiedContent,
          system_reminder: 'Returned source is a snapshot; re-read if the file changed.',
        };
        const contextSize = registry.get('token_manager')?.getContextSize() ?? CONTEXT_SIZES.MEDIUM;
        const allowance = this.getOutputTokenAllowance(
          Math.floor(contextSize * TOKEN_MANAGEMENT.READ_CONTEXT_MAX_PERCENT),
          executionContext
        );
        const admitted = this.admitCompleteResult(candidate, allowance);
        if (admitted) {
          // Admit the complete response before granting observation credit. A
          // concurrent mutation during file checking must not authorize stale bytes.
          await fileMutationCoordinator.run(prepared.absolutePath, async () => {
            const current = await fs.readFile(prepared.absolutePath, 'utf8').catch(() => null);
            if (current === prepared.modifiedContent) {
              readStateManager?.trackRead(
                prepared.absolutePath,
                1,
                current.split('\n').length,
                this.getReadScopeId(executionContext)
              );
            }
          });
          return admitted;
        }
        response.system_reminder +=
          ' Full updated content was omitted because it exceeds the output allowance; read the required region.';
      }
      return response;
    } catch (error) {
      if (this.currentAbortSignal?.aborted || executionContext?.turnInterruptionSignal?.aborted)
        return this.formatErrorResponse('Tool execution interrupted before the edit was committed.', 'interrupted');
      if (error instanceof TextEditInputError) return this.inputError(error);
      return this.formatErrorResponse(
        `Failed to edit file: ${formatError(error)}`,
        'system_error',
        'Re-read the target region and retry with current context.'
      );
    }
  }

  private async prepare(
    args: Record<string, unknown>,
    executionContext?: ToolExecutionContext
  ): Promise<Readonly<PreparedTextEdit>> {
    this.validateInput(args);
    const signature = JSON.stringify(args);
    const absolutePath = resolvePath(args.file_path as string);
    let entry = this.prepared.get(args);
    if (entry && (entry.signature !== signature || entry.absolutePath !== absolutePath))
      throw new TextEditInputError('Edit arguments changed after preparation; submit a new action.');
    if (!entry) {
      const snapshot = Object.freeze(structuredClone(args));
      const value = (async (): Promise<Readonly<PreparedTextEdit>> => {
        const validation = await validateIsFile(absolutePath);
        if (!validation.valid)
          throw new TextEditInputError(
            validation.error ?? 'Target is not a regular file.',
            'Use write to create a new file.'
          );
        const originalContent = this.decodeSource(await fs.readFile(absolutePath));
        const applied = this.transformSource(snapshot, originalContent);
        if (!applied.success || applied.content === undefined)
          throw new TextEditInputError(applied.error ?? 'The edit makes no changes.');
        try {
          assertTextEditContent(applied.content);
        } catch (error) {
          throw new TextEditInputError(error instanceof Error ? error.message : String(error));
        }
        const readRanges = Object.freeze((applied.readRanges ?? []).map(range => Object.freeze({ ...range })));
        const editRanges = Object.freeze((applied.editRanges ?? []).map(range => Object.freeze({ ...range })));
        return Object.freeze({
          absolutePath,
          originalContent,
          modifiedContent: applied.content,
          readRanges,
          editRanges,
          hunkCount: applied.hunkCount ?? 0,
        }) as unknown as Readonly<PreparedTextEdit>;
      })();
      entry = { signature, absolutePath, value };
      this.prepared.set(args, entry);
    }
    const prepared = await entry.value;
    if (JSON.stringify(args) !== entry.signature || resolvePath(args.file_path as string) !== entry.absolutePath)
      throw new TextEditInputError('Edit arguments changed during preparation.');
    const readStateManager = this.getExecutionRegistry(executionContext).get('read_state_manager');
    if (readStateManager) {
      for (const range of prepared.readRanges) {
        const validation = readStateManager.validateLinesRead(
          absolutePath,
          range.start,
          range.end,
          this.getReadScopeId(executionContext)
        );
        if (!validation.success)
          throw new TextEditInputError(
            `Edit targets unread lines ${range.start}-${range.end}. Read that region before editing.`,
            `Use read(file_path="${absolutePath}", offset=${range.start}, limit=${range.end - range.start + 1}) before editing.`
          );
      }
    }
    // The immutable source is rechecked exactly once under the finalizer's CAS lock.
    return prepared;
  }

  private inputError(error: unknown): ToolResult {
    const inputError = error instanceof TextEditInputError ? error : new TextEditInputError(formatError(error));
    return this.formatErrorResponse(
      `Edit rejected before writing. ${inputError.message}`,
      'validation_error',
      inputError.suggestion
    );
  }

  formatSubtext(args: Record<string, unknown>): string | null {
    const filePath = typeof args.file_path === 'string' ? args.file_path : '';
    return filePath.split('/').pop() || filePath || null;
  }

  getSubtextParameters(): string[] {
    return ['file_path'];
  }
}
