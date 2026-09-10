import { BaseTool } from './BaseTool.js';
import { ToolCapability } from './ToolCapability.js';
import { emptySemanticCheckpoint } from '../agent/compaction/types.js';
import type { FunctionDefinition, ToolExecutionContext, ToolResult } from '../types/index.js';

const sections = Object.keys(emptySemanticCheckpoint()).filter(key => key !== 'schemaVersion');

/** Read the calling agent's authoritative checkpoint without expanding its model window. */
export class ReadCheckpointTool extends BaseTool {
  readonly name = 'read-checkpoint';
  readonly description = 'Read durable checkpoint requirements, decisions, or other task state omitted from the compact conversation view. Returns bounded JSON text pages; inspect requirements before final verification.';
  readonly capabilities = [ToolCapability.FsRead] as const;
  readonly isExploratoryTool = true;

  getFunctionDefinition(): FunctionDefinition {
    return {
      type: 'function',
      function: {
        name: this.name, description: this.description,
        parameters: {
          type: 'object',
          properties: {
            section: { type: 'string', enum: sections, description: 'Checkpoint section to read.' },
            checkpoint_id: { type: 'string', description: 'Identity returned by the first page; required when offset is nonzero.' },
            offset: { type: 'integer', description: 'Nonnegative Unicode character offset. Use next_offset from the prior page; default 0.' },
            limit: { type: 'integer', description: 'Maximum characters requested (1–8000), default 2000. Pages may be smaller to fit the output budget.' },
          },
          required: ['section'],
        },
      },
    };
  }

  protected async executeImpl(
    args: { section: string; checkpoint_id?: string; offset?: number; limit?: number },
    _callId?: string, _userInitiated?: boolean, _contextFile?: boolean,
    executionContext?: ToolExecutionContext,
  ): Promise<ToolResult> {
    const offset = args.offset ?? 0;
    const limit = args.limit ?? 2000;
    if (!sections.includes(args.section) || !Number.isSafeInteger(offset) || offset < 0
      || !Number.isSafeInteger(limit) || limit < 1 || limit > 8000
      || (offset > 0 && !args.checkpoint_id)) {
      return this.formatErrorResponse('Invalid checkpoint page request.', 'validation_error',
        'Choose a listed section. Continue pages using checkpoint_id and next_offset from the prior result.');
    }
    const registry = this.getExecutionRegistry(executionContext);
    const agent = registry.get('agent');
    if (!agent) return this.formatErrorResponse('No owning agent is available.', 'system_error');
    const checkpoint = agent.getConversationManager().getCheckpoint();
    if (!checkpoint) return this.formatErrorResponse('This agent has no checkpoint yet.', 'validation_error');
    if (args.checkpoint_id && args.checkpoint_id !== checkpoint.id) {
      return this.formatErrorResponse('Checkpoint changed during pagination.', 'validation_error',
        'Restart at offset 0 to read the current generation.');
    }
    const section = args.section as keyof typeof checkpoint.semanticState;
    const characters = Array.from(JSON.stringify(checkpoint.semanticState[section], null, 2));
    if (offset > characters.length) return this.formatErrorResponse('Offset exceeds the section length.', 'validation_error');
    const budget = this.getOutputTokenAllowance(1024, executionContext);
    let count = Math.min(limit, characters.length - offset);
    while (true) {
      const end = offset + count;
      const result = this.formatSuccessResponse({
        checkpoint_id: checkpoint.id, generation: checkpoint.generation, section,
        offset, next_offset: end < characters.length ? end : null,
        total_characters: characters.length,
        content: characters.slice(offset, end).join(''),
      });
      const admitted = this.admitCompleteResult(result, budget);
      if (admitted) return admitted;
      if (count <= 1) return this.formatErrorResponse('Insufficient output budget for a checkpoint page.', 'validation_error',
        'Read this checkpoint separately from other tool calls.');
      count = Math.floor(count / 2);
    }
  }
}
