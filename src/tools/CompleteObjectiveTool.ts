import { BaseTool } from './BaseTool.js';
import { ToolCapability } from './ToolCapability.js';
import type { FunctionDefinition, ToolResult } from '../types/index.js';
import type { ActivityStream } from '../services/ActivityStream.js';
import { ServiceRegistry } from '../services/ServiceRegistry.js';

interface CompleteObjectiveArgs {
  summary: string;
  evidence?: string[];
  remaining_risks?: string[];
}

/** Structured terminal claim for automatic, durable objectives. */
export class CompleteObjectiveTool extends BaseTool {
  readonly name = 'complete-objective';
  readonly description =
    'Mark the durable objective complete only after all required work, background dependencies, todos, and verification are finished. Ordinary prose does not complete an automatic run.';
  readonly capabilities = [ToolCapability.AppStateWrite] as const;
  readonly mainAgentOnly = true;
  readonly visibleInChat = false;

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
            summary: { type: 'string', description: 'Concise completed outcome.' },
            evidence: {
              type: 'array',
              items: { type: 'string' },
              description: 'Tests, checks, or concrete evidence supporting completion.',
            },
            remaining_risks: {
              type: 'array',
              items: { type: 'string' },
              description: 'Known non-blocking risks disclosed to the user.',
            },
          },
          required: ['summary'],
        },
      },
    };
  }

  protected async executeImpl(args: CompleteObjectiveArgs): Promise<ToolResult> {
    const supervisor = ServiceRegistry.getInstance().get('run_supervisor');
    if (!supervisor) return this.formatErrorResponse('RunSupervisor is unavailable', 'system_error');
    const result = await supervisor.claimComplete(args.summary, args.evidence ?? []);
    if (!result.accepted) {
      return this.formatErrorResponse(
        `Completion rejected: ${result.blockers.join('; ')}`,
        'validation_error',
        'Finish the listed work before claiming completion.',
        { blockers: result.blockers }
      );
    }
    return this.formatSuccessResponse({
      content: 'Durable objective accepted as complete.',
      summary: args.summary,
      evidence: args.evidence ?? [],
      remaining_risks: args.remaining_risks ?? [],
    });
  }
}
