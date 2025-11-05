/**
 * AgentKillTool - Remove a persistent agent from the pool
 *
 * Provides a simple interface to remove agents from the AgentPoolService.
 * Removes a specific agent from the pool by ID.
 */

import { BaseTool } from './BaseTool.js';
import { ToolResult, FunctionDefinition } from '../types/index.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { ServiceRegistry } from '../services/ServiceRegistry.js';
import { AgentPoolService } from '../services/AgentPoolService.js';

export class AgentKillTool extends BaseTool {
  readonly name = 'agent_kill';
  readonly description =
    'Remove a persistent agent from the pool. Use this to clean up agents that are no longer needed.';
  readonly requiresConfirmation = false; // Pool management is safe

  constructor(activityStream: ActivityStream) {
    super(activityStream);
  }

  /**
   * Provide custom function definition
   */
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
              description: 'ID of the agent to remove (from explore/plan/agent, which automatically persist)',
            },
          },
          required: ['agent_id'],
        },
      },
    };
  }

  protected async executeImpl(args: any): Promise<ToolResult> {
    this.captureParams(args);

    const agentId = args.agent_id;

    // Validate agent_id parameter
    if (!agentId || typeof agentId !== 'string') {
      return this.formatErrorResponse(
        'agent_id parameter is required and must be a string',
        'validation_error',
        'Example: agent_kill(agent_id="pool-agent-1234567890-abc")'
      );
    }

    // Get AgentPoolService from registry
    const registry = ServiceRegistry.getInstance();
    const agentPool = registry.get<AgentPoolService>('agent_pool');

    if (!agentPool) {
      return this.formatErrorResponse(
        'Agent pool service not available',
        'system_error',
        'AgentPoolService must be registered in ServiceRegistry'
      );
    }

    // Check if agent exists
    if (!agentPool.hasAgent(agentId)) {
      return this.formatErrorResponse(
        `Agent not found: ${agentId}`,
        'validation_error',
        'Use agent_list_active to see active agents'
      );
    }

    // Try to remove agent
    const removed = await agentPool.removeAgent(agentId);

    if (removed) {
      return this.formatSuccessResponse({
        content: `Successfully removed agent ${agentId} from pool.`,
        agent_id: agentId,
        removed: true,
      });
    } else {
      return this.formatErrorResponse(
        `Cannot remove agent ${agentId} - currently in use`,
        'execution_error',
        'Wait for the agent to complete its current task and try again'
      );
    }
  }
}
