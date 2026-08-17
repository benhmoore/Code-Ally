import { BaseTool } from './BaseTool.js';
import { ToolCapability } from './ToolCapability.js';
import type { ActivityStream } from '../services/ActivityStream.js';
import type { FunctionDefinition, ToolResult } from '../types/index.js';
import { ServiceRegistry } from '../services/ServiceRegistry.js';

export class ReconcileEffectTool extends BaseTool {
  readonly name = 'reconcile-effect';
  readonly description = 'Resolve an unknown non-idempotent tool outcome only after independently verifying whether the effect was applied.';
  readonly capabilities = [ToolCapability.AppStateWrite] as const;
  readonly mainAgentOnly = true;
  readonly visibleInChat = false;
  constructor(activityStream: ActivityStream) { super(activityStream); }
  getFunctionDefinition(): FunctionDefinition {
    return {
      type: 'function',
      function: {
        name: this.name,
        description: this.description,
        parameters: {
          type: 'object',
          properties: {
            call_id: { type: 'string', description: 'Unknown tool call id reported by the completion gate.' },
            resolution: { type: 'string', enum: ['succeeded', 'failed_not_applied'], description: 'Verified external outcome.' },
            evidence: { type: 'string', description: 'Independent read-only evidence used to verify the outcome.' },
          },
          required: ['call_id', 'resolution', 'evidence'],
        },
      },
    };
  }
  protected async executeImpl(args: { call_id: string; resolution: string; evidence: string }): Promise<ToolResult> {
    const supervisor = ServiceRegistry.getInstance().get('run_supervisor');
    if (!supervisor) return this.formatErrorResponse('RunSupervisor is unavailable', 'system_error');
    const reconciled = await supervisor.reconcileToolEffect(args.call_id, args.resolution, args.evidence);
    if (!reconciled) return this.formatErrorResponse(`No unknown effect for ${args.call_id}`, 'validation_error');
    return this.formatSuccessResponse({ content: `Reconciled ${args.call_id} as ${args.resolution}.` });
  }
}
