/**
 * AgentListActiveTool - List all active persistent agents in the pool
 *
 * Provides a view of all currently active agents in the AgentPoolService,
 * including their IDs, types, status, and usage statistics.
 */

import { BaseTool } from './BaseTool.js';
import { ToolResult, FunctionDefinition } from '../types/index.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { ServiceRegistry } from '../services/ServiceRegistry.js';
import { AgentPoolService } from '../services/AgentPoolService.js';

export class AgentListActiveTool extends BaseTool {
  readonly name = 'agent_list_active';
  readonly description =
    'List all active persistent agents in the pool with their IDs, types, and status';
  readonly requiresConfirmation = false; // Read-only operation
  readonly suppressExecutionAnimation = false; // Show execution

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
          properties: {},
          required: [],
        },
      },
    };
  }

  protected async executeImpl(args: any): Promise<ToolResult> {
    this.captureParams(args);

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

    // Get pool stats
    const stats = agentPool.getPoolStats();

    // Get all agent IDs
    const agentIds = agentPool.getAgentIds();

    // Build list of agents with metadata
    const agents: Array<{
      agent_id: string;
      agent_type: string;
      created_at: string;
      last_used_at: string;
      tool_call_count: number;
      in_use: boolean;
    }> = [];

    for (const agentId of agentIds) {
      const metadata = agentPool.getAgentMetadata(agentId);
      if (!metadata) {
        continue; // Should not happen, but skip if metadata is missing
      }

      // Determine agent type from base prompt
      let agentType = 'custom';
      const baseAgentPrompt = metadata.config.baseAgentPrompt;
      if (baseAgentPrompt) {
        if (baseAgentPrompt.includes('code exploration')) {
          agentType = 'explore';
        } else if (baseAgentPrompt.includes('implementation planner')) {
          agentType = 'plan';
        }
      }

      agents.push({
        agent_id: agentId,
        agent_type: agentType,
        created_at: new Date(metadata.createdAt).toISOString(),
        last_used_at: new Date(metadata.lastAccessedAt).toISOString(),
        tool_call_count: metadata.useCount,
        in_use: metadata.inUse,
      });
    }

    // Build summary content
    let content = `Active Agents (${stats.totalAgents}/${stats.maxPoolSize}):\n\n`;

    if (agents.length === 0) {
      content += 'No active agents in pool.\n';
    } else {
      // Sort by last_used_at (most recent first)
      agents.sort((a, b) =>
        new Date(b.last_used_at).getTime() - new Date(a.last_used_at).getTime()
      );

      for (const agent of agents) {
        const status = agent.in_use ? '[IN USE]' : '[IDLE]';
        const type = agent.agent_type.toUpperCase();
        content += `${status} ${agent.agent_id}\n`;
        content += `  Type: ${type}\n`;
        content += `  Created: ${agent.created_at}\n`;
        content += `  Last Used: ${agent.last_used_at}\n`;
        content += `  Tool Calls: ${agent.tool_call_count}\n\n`;
      }
    }

    content += `Pool Stats:\n`;
    content += `  Total: ${stats.totalAgents}\n`;
    content += `  In Use: ${stats.inUseAgents}\n`;
    content += `  Available: ${stats.availableAgents}\n`;
    content += `  Max Pool Size: ${stats.maxPoolSize}\n`;

    return this.formatSuccessResponse({
      content,
      agents,
      pool_stats: stats,
    });
  }
}
