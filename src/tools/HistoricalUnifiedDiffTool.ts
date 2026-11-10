/** Explicit evaluation adapter for the historical unified-diff interface. Not registered by production. */
import { PreparedTextEditTool, TextEditInputError } from './PreparedTextEditTool.js';
import type { FunctionDefinition } from '../types/index.js';
import { applyModelPatch } from '../utils/patchApplier.js';
export class HistoricalUnifiedDiffTool extends PreparedTextEditTool {
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
    if (typeof args.file_path !== 'string' || !args.file_path.trim())
      throw new TextEditInputError('file_path is required');
    if (typeof args.patch !== 'string' || !args.patch || args.patch.length > 1_000_000)
      throw new TextEditInputError('A nonempty bounded unified diff is required.');
  }
  protected transformSource(args: Readonly<Record<string, unknown>>, source: string) {
    return applyModelPatch(args.patch as string, source);
  }
}
