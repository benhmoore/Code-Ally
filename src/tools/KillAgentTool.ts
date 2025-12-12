/**
 * KillAgentTool - Terminate background agents
 *
 * Kills agents started with agent(run_in_background=true).
 * Interrupts the agent and removes it from tracking.
 */

import { BaseTool } from './BaseTool.js';
import { ToolResult, FunctionDefinition } from '../types/index.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { ServiceRegistry } from '../services/ServiceRegistry.js';
import { BackgroundAgentManager } from '../services/BackgroundAgentManager.js';

export class KillAgentTool extends BaseTool {
  readonly name = 'kill-agent';
  readonly description = 'Stop and remove a background agent';
  readonly requiresConfirmation = false; // Quick operation
  readonly hideOutput = false;

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
            agent_id: {
              type: 'string',
              description: 'Agent ID returned from agent(run_in_background=true)',
            },
          },
          required: ['agent_id'],
        },
      },
    };
  }

  protected async executeImpl(args: any): Promise<ToolResult> {
    this.captureParams(args);

    const agentId = args.agent_id as string;

    // Validate parameter
    if (!agentId) {
      return this.formatErrorResponse(
        'agent_id parameter is required',
        'validation_error',
        'Example: kill-agent(agent_id="bg-agent-xxx")'
      );
    }

    // Get BackgroundAgentManager from registry
    const registry = ServiceRegistry.getInstance();
    const manager = registry.get<BackgroundAgentManager>('background_agent_manager');

    if (!manager) {
      return this.formatErrorResponse(
        'BackgroundAgentManager not available',
        'system_error'
      );
    }

    // Kill the agent
    const success = manager.killAgent(agentId);

    if (!success) {
      return this.formatErrorResponse(
        `Background agent ${agentId} not found`,
        'user_error',
        'Check agent IDs in system reminders.'
      );
    }

    return this.formatSuccessResponse({
      message: `Background agent ${agentId} has been stopped and removed`,
      agent_id: agentId,
    });
  }

  formatSubtext(args: Record<string, any>): string | null {
    const agentId = args.agent_id as string;
    if (!agentId) return null;
    const shortId = agentId.startsWith('bg-agent-')
      ? agentId.substring(9, 17)
      : agentId;
    return shortId;
  }

  getSubtextParameters(): string[] {
    return ['agent_id'];
  }
}
