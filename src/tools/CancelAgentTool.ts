/**
 * CancelAgentTool - Cancel a backgrounded agent run
 *
 * Cancels agents started with agent(run_in_background=true). Signals the
 * sub-agent to stop (graceful cancel via InterruptionManager + tool abort
 * signal); the detached run unwinds and releases its pooled agent itself.
 *
 * Mirrors KillShellTool, the equivalent for backgrounded shell processes.
 */

import { BaseTool } from './BaseTool.js';
import { ToolResult, FunctionDefinition } from '../types/index.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { ServiceRegistry } from '../services/ServiceRegistry.js';
import { BackgroundAgentManager } from '../services/BackgroundAgentManager.js';
import { formatDuration } from '../ui/utils/timeUtils.js';

export class CancelAgentTool extends BaseTool {
  readonly name = 'cancel-agent';
  readonly description = 'Cancel a background agent started with agent(run_in_background=true)';
  readonly requiresConfirmation = true; // Stops in-flight work
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
              description: 'Agent id returned from agent(run_in_background=true), e.g. "agent-1234567890-abc123"',
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
    if (!agentId) {
      return this.formatErrorResponse(
        'agent_id parameter is required',
        'validation_error',
        'Example: cancel-agent(agent_id="agent-1234567890-abc123")'
      );
    }

    const registry = ServiceRegistry.getInstance();
    const manager = registry.get<BackgroundAgentManager>('background_agent_manager');
    if (!manager) {
      return this.formatErrorResponse(
        'BackgroundAgentManager not available',
        'system_error'
      );
    }

    const task = manager.getTask(agentId);
    if (!task) {
      return this.formatErrorResponse(
        `Background agent ${agentId} not found`,
        'user_error',
        'Check agent ids in system reminders. It may have already finished.'
      );
    }

    if (task.status !== 'running') {
      return this.formatErrorResponse(
        `Background agent ${agentId} already ${task.status}`,
        'user_error',
        'The agent has already finished; its result is delivered automatically.'
      );
    }

    const elapsed = formatDuration(Date.now() - task.startTime);
    manager.cancelTask(agentId);

    return this.formatSuccessResponse({
      content: `Cancelled background agent ${agentId} (${task.agentType})`,
      agent_id: agentId,
      agent_type: task.agentType,
      elapsed,
    });
  }

  /**
   * Format subtext for display in UI
   */
  formatSubtext(args: Record<string, any>): string | null {
    const agentId = args.agent_id as string;
    if (!agentId) return null;
    // Shorten id for display (show first 8 chars after "agent-")
    return agentId.startsWith('agent-') ? agentId.substring(6, 14) : agentId;
  }

  getSubtextParameters(): string[] {
    return ['agent_id'];
  }
}
