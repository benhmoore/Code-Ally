import { BaseTool } from './BaseTool.js';
import { ToolCapability } from './ToolCapability.js';
import type { FunctionDefinition, ToolResult } from '../types/index.js';
import { ServiceRegistry } from '../services/ServiceRegistry.js';
import type { ArchitectureUpdate } from '../services/ObjectiveArchitecture.js';

/** Optional structured state for objectives that span multiple implementation steps. */
export class ObjectiveStateTool extends BaseTool {
  readonly name = 'objective-state';
  readonly description = 'Inspect or update durable acceptance criteria, constraints, architectural decisions, assumptions, and next actions. Use for substantial objectives; simple tasks need no setup. Criteria are verified by successful foreground bash commands against unchanged declared source/test artifacts. Later edits make that evidence stale.';
  readonly capabilities = [ToolCapability.AppStateWrite] as const;
  readonly mainAgentOnly = true;

  getFunctionDefinition(): FunctionDefinition {
    const strings = { type: 'array' as const, items: { type: 'string' as const } };
    return { type: 'function', function: {
      name: this.name, description: this.description,
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          action: { type: 'string', enum: ['inspect', 'update'] },
          criteria: { type: 'array', items: {
            type: 'object', additionalProperties: false,
            properties: {
              id: { type: 'string' }, description: { type: 'string' },
              command: { type: 'string', description: 'Exact foreground bash verification command to run after recording this criterion.' },
              artifacts: { ...strings, description: 'Project-relative source, test and configuration files covered by this check. Include relevant dependencies.' },
            }, required: ['id', 'description', 'command', 'artifacts'],
          } },
          constraints: { ...strings, description: 'Append durable constraints.' },
          decisions: { type: 'array', items: { type: 'object', properties: {
            decision: { type: 'string' }, rationale: { type: 'string' },
          }, required: ['decision', 'rationale'], additionalProperties: false } },
          assumptions: { ...strings, description: 'Append assumptions that still need validation.' },
          nextActions: { ...strings, description: 'Replace the next-action list.' },
        }, required: ['action'],
      },
    } };
  }

  protected async executeImpl(args: ArchitectureUpdate & { action: 'inspect' | 'update' }): Promise<ToolResult> {
    const supervisor = ServiceRegistry.getInstance().get('run_supervisor');
    if (!supervisor?.getActiveRun()) return this.formatErrorResponse('No active durable objective', 'validation_error');
    try {
      if (args.action === 'update') {
        const { action: _action, ...update } = args;
        await supervisor.updateArchitecture(update);
      }
      const architecture = await supervisor.inspectArchitecture();
      return this.formatSuccessResponse({ content: JSON.stringify(architecture ?? { criteria: [], nextActions: [] }), architecture });
    } catch (error) {
      return this.formatErrorResponse(error instanceof Error ? error.message : String(error), 'validation_error');
    }
  }
}
