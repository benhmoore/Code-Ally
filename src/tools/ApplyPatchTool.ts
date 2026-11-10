/** Production apply-patch interface: contextual unified diff with host-owned preparation. */
import { PreparedTextEditTool, TextEditInputError } from './PreparedTextEditTool.js';
import type { FunctionDefinition } from '../types/index.js';
import { assertTextEditContent } from '../utils/textEditContent.js';
import { applyModelPatch } from '../utils/patchApplier.js';
export class ApplyPatchTool extends PreparedTextEditTool {
  readonly description =
    'Modify one existing text file with contextual unified-diff hunks. Read each target region first. Use write only to create new files.';
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
              description: 'Return full updated source if it fits the output budget (default false).',
            },
          },
          required: ['file_path', 'patch'],
        },
      },
    };
  }

  protected validateInput(args: Record<string, unknown>): void {
    if (
      !args ||
      typeof args !== 'object' ||
      Array.isArray(args) ||
      Object.keys(args).some(key => !['file_path', 'patch', 'show_updated_context'].includes(key))
    )
      throw new TextEditInputError('Use only file_path, patch and optional show_updated_context.');
    if (typeof args.file_path !== 'string' || !args.file_path.trim())
      throw new TextEditInputError('file_path is required');
    if (typeof args.patch !== 'string' || !args.patch || args.patch.length > 1_000_000)
      throw new TextEditInputError('A nonempty bounded unified diff is required.');
    try {
      assertTextEditContent(args.patch);
    } catch (error) {
      throw new TextEditInputError(error instanceof Error ? error.message : String(error));
    }
    if (args.show_updated_context !== undefined && typeof args.show_updated_context !== 'boolean')
      throw new TextEditInputError('show_updated_context must be a boolean.');
  }
  protected transformSource(args: Readonly<Record<string, unknown>>, source: string) {
    const applied = applyModelPatch(args.patch as string, source);
    // An existing empty file still requires observation in this agent's scope.
    if (source === '' && applied.success) applied.readRanges = [{ start: 1, end: 1 }];
    return applied;
  }
}
