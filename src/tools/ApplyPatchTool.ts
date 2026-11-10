/** Default apply-patch interface: one unique exact-text replacement. */
import { PreparedTextEditTool, TextEditInputError } from './PreparedTextEditTool.js';
import type { FunctionDefinition } from '../types/index.js';
import { prepareExactTextEdit } from '../utils/exactTextEdit.js';
import { decodeExactTextSource } from '../utils/exactTextReplacement.js';

export class ApplyPatchTool extends PreparedTextEditTool {
  readonly description =
    'Edit one existing file by replacing exact text. Read the target first. old_text must occur exactly once; use empty old_text only for an existing empty file. LF and CRLF are equivalent; all other whitespace and Unicode must match exactly. Use write only for new files.';
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
              description: 'Existing file to edit.',
            },
            old_text: {
              type: 'string',
              description:
                'Unique source text, or empty string only for an existing empty file. LF and CRLF match the same logical newline; all other characters must match exactly.',
            },
            new_text: {
              type: 'string',
              description:
                'Replacement text. Inserted newlines use the matched region’s first newline style, otherwise the file’s first style, otherwise LF. Empty string deletes old_text.',
            },
          },
          required: ['file_path', 'old_text', 'new_text'],
        },
      },
    };
  }
  protected validateInput(args: Record<string, unknown>): void {
    if (
      !args ||
      typeof args !== 'object' ||
      Array.isArray(args) ||
      Object.keys(args).some(key => !['file_path', 'old_text', 'new_text'].includes(key))
    )
      throw new TextEditInputError('Use only file_path, old_text and new_text; do not send unified diff arguments.');
    if (typeof args.file_path !== 'string' || !args.file_path.trim())
      throw new TextEditInputError('file_path is required.');
    if (typeof args.old_text !== 'string')
      throw new TextEditInputError('old_text must be a string; empty text is allowed only for an existing empty file.');
    if (typeof args.new_text !== 'string') throw new TextEditInputError('new_text must be a string.');
    if (args.old_text === args.new_text) throw new TextEditInputError('Replacement makes no changes.');
    if (args.old_text.length + args.new_text.length > 1_000_000)
      throw new TextEditInputError('Exact edit exceeds its size limit.');
    if (args.old_text.includes('\0') || args.new_text.includes('\0'))
      throw new TextEditInputError('Binary text edits are unsupported.');
  }
  protected override decodeSource(bytes: Uint8Array): string {
    try {
      return decodeExactTextSource(bytes);
    } catch (error) {
      throw new TextEditInputError(error instanceof Error ? error.message : String(error));
    }
  }
  protected transformSource(args: Readonly<Record<string, unknown>>, source: string) {
    try {
      return prepareExactTextEdit(source, args.old_text as string, args.new_text as string);
    } catch (error) {
      throw new TextEditInputError(error instanceof Error ? error.message : String(error));
    }
  }
}
