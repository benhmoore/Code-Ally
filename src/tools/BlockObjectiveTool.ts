import { BaseTool } from './BaseTool.js';
import { ToolCapability } from './ToolCapability.js';
import type { FunctionDefinition, ToolResult } from '../types/index.js';
import type { ActivityStream } from '../services/ActivityStream.js';
import { ServiceRegistry } from '../services/ServiceRegistry.js';

/** Explicit terminal state for a durable objective with no safe automatic path. */
export class BlockObjectiveTool extends BaseTool {
  readonly name = 'block-objective';
  readonly description =
    'Stop a durable objective as blocked only when no safe automatic alternative remains, configuration/authentication is permanently invalid, or an unsafe side effect has an unknown outcome.';
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
            reason: { type: 'string', description: 'Concrete blocker and attempted safe alternatives.' },
          },
          required: ['reason'],
        },
      },
    };
  }

  protected async executeImpl(args: { reason: string }): Promise<ToolResult> {
    const supervisor = ServiceRegistry.getInstance().get('run_supervisor');
    if (!supervisor) return this.formatErrorResponse('RunSupervisor is unavailable', 'system_error');
    await supervisor.block(args.reason);
    return this.formatSuccessResponse({ content: 'Durable objective marked blocked.', reason: args.reason });
  }
}
