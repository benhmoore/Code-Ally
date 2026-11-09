/** Runtime-only experiment. Production ApplyPatchTool and its schema remain unchanged. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { readFile } from 'node:fs/promises';
import { createPatch } from 'diff';
import { BaseTool } from '../tools/BaseTool.js';
import { ApplyPatchTool } from '../tools/ApplyPatchTool.js';
import type { ActivityStream } from '../services/ActivityStream.js';
import type { FunctionDefinition, ToolExecutionContext, ToolResult } from '../types/index.js';
import { resolvePath } from '../utils/pathUtils.js';
import { checkFileAfterModification } from '../utils/fileCheckUtils.js';
import { applyModelPatch } from '../utils/patchApplier.js';
import { decodeExactTextSource, replaceExactText } from '../utils/exactTextReplacement.js';

const MAX_EXACT_TEXT_CHARS = 1_000_000;
interface PreparedReplacement {
  signature: string;
  absolutePath: string;
  original: string;
  replacement: string;
  patchArgs: { file_path: string; patch: string };
}

/** Reuse the original finalizer while binding its CAS baseline to reviewed source. */
export class PinnedApplyPatchTool extends ApplyPatchTool {
  private readonly pinnedSource = new AsyncLocalStorage<{ original: string; replacement: string }>();

  withSource<T>(original: string, replacement: string, operation: () => Promise<T>): Promise<T> {
    return this.pinnedSource.run({ original, replacement }, operation);
  }

  private async preparePinned(args: Record<string, unknown>, context?: ToolExecutionContext) {
    const expected = this.pinnedSource.getStore();
    if (!expected) throw new Error('Exact edit has no prepared source');
    const absolutePath = resolvePath(String(args.file_path));
    const original = decodeExactTextSource(await readFile(absolutePath));
    if (original !== expected.original)
      throw new Error('Exact edit target changed after preparation; re-read before editing');
    // The ordinary patch applier cannot apply mixed-EOL files. Derive only its
    // line-based evidence/mappings from logical source; commit the raw helper result.
    const applied = applyModelPatch(String(args.patch), original.replace(/\r\n/g, '\n'));
    if (!applied.success || applied.content !== expected.replacement.replace(/\r\n/g, '\n'))
      throw new Error('Generated patch does not realize the prepared exact replacement');
    const reads = this.getExecutionRegistry(context).get('read_state_manager');
    for (const range of applied.readRanges ?? []) {
      const validation = reads?.validateLinesRead(absolutePath, range.start, range.end, this.getReadScopeId(context));
      if (validation && !validation.success)
        throw new Error(`Exact edit targets unread lines ${range.start}-${range.end}`);
    }
    return { absolutePath, original, replacement: expected.replacement, applied, reads };
  }

  override async validateBeforePermission(
    args: Record<string, unknown>,
    context?: ToolExecutionContext
  ): Promise<ToolResult | null> {
    try {
      await this.preparePinned(args, context);
      return null;
    } catch (error) {
      return this.formatErrorResponse(String(error), 'validation_error');
    }
  }

  override async previewChanges(args: Record<string, unknown>): Promise<void> {
    try {
      const prepared = await this.preparePinned(args, this.currentExecutionContext);
      await this.safelyEmitDiffPreview(
        prepared.absolutePath,
        async () => ({
          oldContent: prepared.original,
          newContent: prepared.replacement,
        }),
        'apply-patch',
        prepared.applied.hunkCount
      );
    } catch {
      /* Invalid/unread targets never emit an authorization preview. */
    }
  }

  protected override async executeImpl(
    args: Record<string, unknown>,
    _callId?: string,
    _isUserInitiated = false,
    _isContextFile = false,
    context?: ToolExecutionContext
  ): Promise<ToolResult> {
    try {
      const prepared = await this.preparePinned(args, context);
      // Shared production finalizer owns CAS, atomic write, journaling and read-state publication.
      const { patchNumber, diff } = await this.finalizeEdit({
        absolutePath: prepared.absolutePath,
        originalContent: prepared.original,
        modifiedContent: prepared.replacement,
        operationType: 'apply-patch',
        editRanges: prepared.applied.editRanges,
        readStateManager: prepared.reads,
        executionContext: context,
      });
      const result = this.formatSuccessResponse({
        content: `Applied exact text replacement to ${prepared.absolutePath}`,
        file_path: prepared.absolutePath,
        hunks_applied: prepared.applied.hunkCount,
        diff,
      });
      if (patchNumber !== null) result.patch_number = patchNumber;
      result.system_reminder =
        'Your read evidence was updated through this edit; other agents must re-read the changed file.';
      const check = await checkFileAfterModification(prepared.absolutePath);
      if (check) result.file_check = check;
      return result;
    } catch (error) {
      return this.formatErrorResponse(String(error), 'validation_error');
    }
  }
}

/** Permission callers retain the original exact-text args; conversion is private. */
export class ExactEditExperimentTool extends BaseTool {
  readonly name = 'apply-patch';
  readonly description =
    'Edit one existing file by replacing exact text. Read the target first. old_text must occur exactly once. LF and CRLF are equivalent; all other text and whitespace must match exactly. Use write only for new files.';
  readonly capabilities;
  readonly hideOutput = true;
  override readonly argumentCompaction = {
    payloadPaths: [['old_text'], ['new_text']],
    durableReceipt: 'successful-tool-result',
  } as const;
  private readonly prepared = new WeakMap<object, PreparedReplacement>();

  constructor(
    stream: ActivityStream,
    private readonly delegate: PinnedApplyPatchTool = new PinnedApplyPatchTool(stream)
  ) {
    super(stream);
    this.capabilities = delegate.capabilities;
  }

  getFunctionDefinition(): FunctionDefinition {
    return {
      type: 'function',
      function: {
        name: this.name,
        description: this.description,
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            file_path: { type: 'string', format: 'local-path', description: 'Existing file to edit.' },
            old_text: {
              type: 'string',
              description:
                'Nonempty source text, unique including whitespace and Unicode. LF and CRLF match the same logical newline; include more context to disambiguate.',
            },
            new_text: {
              type: 'string',
              description:
                'Replacement text; LF or CRLF newlines use the matched region’s first newline style, otherwise the file’s first style, otherwise LF. Empty string deletes old_text.',
            },
          },
          required: ['file_path', 'old_text', 'new_text'],
        },
      },
    };
  }

  private async prepare(args: Record<string, unknown>): Promise<PreparedReplacement> {
    if (!args || typeof args !== 'object' || Array.isArray(args))
      throw new Error('Expected an exact-text edit argument object');
    if (Object.keys(args).some(key => !['file_path', 'old_text', 'new_text'].includes(key)))
      throw new Error('Use only file_path, old_text, and new_text; do not send unified diff patch arguments');
    if (typeof args.file_path !== 'string' || !args.file_path.trim())
      throw new Error('file_path must name one existing file');
    if (typeof args.old_text !== 'string' || args.old_text.length === 0)
      throw new Error('old_text must be nonempty exact source text');
    if (typeof args.new_text !== 'string') throw new Error('new_text must be a string');
    if (args.old_text === args.new_text) throw new Error('Replacement makes no changes');
    if (args.old_text.length + args.new_text.length > MAX_EXACT_TEXT_CHARS)
      throw new Error('Exact edit exceeds its size limit');
    const signature = JSON.stringify(args);
    const absolutePath = resolvePath(args.file_path);
    const original = decodeExactTextSource(await readFile(absolutePath));
    const prior = this.prepared.get(args);
    if (prior) {
      if (prior.signature !== signature || prior.absolutePath !== absolutePath || prior.original !== original)
        throw new Error('Exact edit arguments or target changed after preparation; re-read and submit a new edit');
      return prior;
    }
    const replacement = replaceExactText(original, args.old_text, args.new_text).content;
    const patch = createPatch(
      'exact-edit',
      original.replace(/\r\n/g, '\n'),
      replacement.replace(/\r\n/g, '\n'),
      '',
      '',
      { context: 0 }
    );
    const applied = applyModelPatch(patch, original.replace(/\r\n/g, '\n'));
    if (!applied.success || applied.content?.replace(/\r\n/g, '\n') !== replacement.replace(/\r\n/g, '\n'))
      throw new Error('Replacement cannot be represented byte-exactly by the patch pipeline; no changes made');
    const prepared = {
      signature,
      absolutePath,
      original,
      replacement,
      patchArgs: { file_path: args.file_path, patch },
    };
    this.prepared.set(args, prepared);
    return prepared;
  }

  private rejected(error: unknown): ToolResult {
    return this.formatErrorResponse(
      `Exact edit rejected before writing: ${error instanceof Error ? error.message : String(error)}`,
      'validation_error',
      'Read the current target and supply one unique exact old_text/new_text replacement.'
    );
  }

  async validateBeforePermission(
    args: Record<string, unknown>,
    context?: ToolExecutionContext
  ): Promise<ToolResult | null> {
    try {
      const prepared = await this.prepare(args);
      const result = await this.delegate.withSource(prepared.original, prepared.replacement, () =>
        this.delegate.validateBeforePermission(prepared.patchArgs, context)
      );
      if (result) this.prepared.delete(args);
      return result;
    } catch (error) {
      if (args && typeof args === 'object') this.prepared.delete(args);
      return this.rejected(error);
    }
  }

  async previewChanges(args: Record<string, unknown>, callId?: string): Promise<void> {
    try {
      const context = this.currentExecutionContext;
      if (this.currentAbortSignal?.aborted || context?.turnInterruptionSignal?.aborted)
        throw new Error('AbortError: Exact edit preview interrupted');
      const prepared = await this.prepare(args);
      await this.delegate.withSource(prepared.original, prepared.replacement, () =>
        this.delegate.runPreview(prepared.patchArgs, callId, context)
      );
      if (this.currentAbortSignal?.aborted || context?.turnInterruptionSignal?.aborted)
        throw new Error('AbortError: Exact edit preview interrupted');
    } catch (error) {
      if (args && typeof args === 'object') this.prepared.delete(args);
      throw error;
    }
  }

  protected async executeImpl(
    args: Record<string, unknown>,
    callId?: string,
    isUserInitiated = false,
    isContextFile = false,
    context?: ToolExecutionContext
  ): Promise<ToolResult> {
    this.captureParams(args);
    try {
      const prepared = await this.prepare(args);
      // Existing tool owns scoped read validation, atomic CAS, patch journal, and read-state updates.
      return await this.delegate.withSource(prepared.original, prepared.replacement, () =>
        this.delegate.execute(
          prepared.patchArgs,
          callId,
          this.currentAbortSignal,
          isUserInitiated,
          isContextFile,
          context
        )
      );
    } catch (error) {
      return this.rejected(error);
    } finally {
      if (args && typeof args === 'object') this.prepared.delete(args);
    }
  }

  getSubtextParameters(): string[] {
    return ['file_path'];
  }
}
