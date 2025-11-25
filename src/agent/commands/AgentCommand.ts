/**
 * AgentCommand - Manage agents and agent pool
 *
 * Provides subcommands for:
 * - Managing user-created specialized agents (create, list, show, use, delete)
 * - Managing the agent pool (active, stats, clear)
 */

import { Command } from './Command.js';
import { ActivityEventType } from '@shared/index.js';
import type { Message } from '@shared/index.js';
import type { ServiceRegistry } from '@services/ServiceRegistry.js';
import type { CommandResult } from '../CommandHandler.js';
import type { AgentManager } from '@services/AgentManager.js';
import type { AgentPoolService } from '@services/AgentPoolService.js';

export class AgentCommand extends Command {
  readonly name = '/agent';
  readonly description = 'Manage agents and agent pool';

  // Use yellow output for simple status messages
  protected readonly useYellowOutput = true;

  async execute(
    args: string[],
    _messages: Message[],
    serviceRegistry: ServiceRegistry
  ): Promise<CommandResult> {
    // No args - show help
    if (args.length === 0) {
      return this.showHelp();
    }

    const subcommand = args[0]!; // Safe: args.length === 0 checked above
    const restArgs = args.slice(1);

    switch (subcommand.toLowerCase()) {
      // User-created agent management
      case 'create':
        return this.handleCreate(restArgs.join(' '), serviceRegistry);
      case 'list':
      case 'ls':
        return this.handleList(serviceRegistry);
      case 'show':
        return this.handleShow(restArgs.join(' '), serviceRegistry);
      case 'delete':
        return this.handleDelete(restArgs.join(' '), serviceRegistry);
      case 'use':
        return this.handleUse(restArgs.join(' '), serviceRegistry);

      // Agent pool management
      case 'active':
        return this.handleActive(serviceRegistry);
      case 'stats':
        return this.handleStats(serviceRegistry);
      case 'clear':
        return this.handleClear(restArgs, serviceRegistry);

      default:
        return {
          handled: true,
          response: `Unknown agent subcommand: ${subcommand}`,
        };
    }
  }

  private showHelp(): CommandResult {
    return {
      handled: true,
      response: `**Specialized Agents**
\`/agent create\`  Create new specialized agent
\`/agent list\`  List available agents
\`/agent show <name>\`  Show agent details
\`/agent use <name> <task>\`  Run task with agent
\`/agent delete <name>\`  Delete agent

**Agent Pool**
\`/agent active\`  Show active pooled agents
\`/agent stats\`  Show pool statistics
\`/agent clear [id]\`  Clear specific agent or all`,
    };
  }

  private async handleCreate(description: string, serviceRegistry: ServiceRegistry): Promise<CommandResult> {
    // Trigger agent creation wizard
    return this.emitActivityEvent(
      serviceRegistry,
      ActivityEventType.AGENT_WIZARD_REQUEST,
      { initialDescription: description || '' },
      'agent_wizard'
    );
  }

  private async handleList(serviceRegistry: ServiceRegistry): Promise<CommandResult> {
    const agentManager = serviceRegistry.get<AgentManager>('agent_manager');
    if (!agentManager) {
      return this.createError('Agent manager not available');
    }

    const agents = await agentManager.listAgents();

    if (agents.length === 0) {
      return {
        handled: true,
        response: 'No agents available. Use `/agent create` to create one.',
      };
    }

    let output = '**Available Agents**\n\n';
    output += '| Name | Description |\n';
    output += '|------|-------------|\n';

    for (const agent of agents) {
      output += `| ${agent.name} | ${agent.description} |\n`;
    }

    // Multi-line output, not yellow
    return { handled: true, response: output };
  }

  private async handleShow(name: string, serviceRegistry: ServiceRegistry): Promise<CommandResult> {
    if (!name) {
      return this.createError('Agent name required. Usage: /agent show <name>');
    }

    const agentManager = serviceRegistry.get<AgentManager>('agent_manager');
    if (!agentManager) {
      return this.createError('Agent manager not available');
    }

    const agent = await agentManager.loadAgent(name);

    if (!agent) {
      return {
        handled: true,
        response: `Agent '${name}' not found.`,
      };
    }

    let output = `**Agent: ${agent.name}**\n\n`;
    output += `| Property | Value |\n`;
    output += `|----------|-------|\n`;
    output += `| Description | ${agent.description} |\n`;
    output += `| Created | ${agent.created_at || 'Unknown'} |\n\n`;
    output += `**System Prompt**\n\`\`\`\n${agent.system_prompt}\n\`\`\``;

    // Multi-line output, not yellow
    return { handled: true, response: output };
  }

  private async handleDelete(name: string, serviceRegistry: ServiceRegistry): Promise<CommandResult> {
    if (!name) {
      return this.createError('Agent name required. Usage: /agent delete <name>');
    }

    const agentManager = serviceRegistry.get<AgentManager>('agent_manager');
    if (!agentManager) {
      return this.createError('Agent manager not available');
    }

    const deleted = await agentManager.deleteAgent(name);

    if (deleted) {
      // Use createResponse for yellow output
      return this.createResponse(`Agent '${name}' deleted successfully.`);
    } else {
      return {
        handled: true,
        response: `Failed to delete agent '${name}'. It may not exist or cannot be deleted.`,
      };
    }
  }

  private async handleUse(args: string, serviceRegistry: ServiceRegistry): Promise<CommandResult> {
    if (!args.trim()) {
      return this.createError('Usage: /agent use <name> <task>\nExample: /agent use repo-reviewer Analyze the codebase for quality issues');
    }

    const agentManager = this.getRequiredService<AgentManager>(serviceRegistry, 'agent_manager', 'agent use');
    if ('handled' in agentManager) return agentManager; // Error result

    // Parse arguments: first word is agent name, rest is task
    const parts = args.trim().split(/\s+/);
    const agentName = parts[0]!; // Safe: args.trim() was checked above
    const taskPrompt = parts.slice(1).join(' ');

    if (!taskPrompt) {
      return this.createError(`Task description required.\nUsage: /agent use ${agentName} <task-description>`);
    }

    // Verify agent exists
    const agentExists = await agentManager.agentExists(agentName);
    if (!agentExists) {
      const agents = await agentManager.listAgents();
      const agentNames = agents.map(a => a.name).join(', ');
      return this.createError(`Agent '${agentName}' not found.\nAvailable agents: ${agentNames}`);
    }

    // Emit event to trigger agent execution
    return this.emitActivityEvent(
      serviceRegistry,
      ActivityEventType.AGENT_USE_REQUEST,
      { agentName, taskPrompt },
      'agent_use'
    );
  }

  // ===========================
  // Agent Pool Management
  // ===========================

  /**
   * Show active agents in the pool
   */
  private async handleActive(serviceRegistry: ServiceRegistry): Promise<CommandResult> {
    const agentPool = serviceRegistry.get<AgentPoolService>('agent_pool');
    if (!agentPool) {
      return this.createError('Agent pool not available');
    }

    const agentIds = agentPool.getAgentIds();

    if (agentIds.length === 0) {
      return {
        handled: true,
        response: 'No active agents in the pool.',
      };
    }

    let output = '**Active Agents**\n\n';
    output += '| ID | Status | Type | Age | Last Used | Uses |\n';
    output += '|----|--------|------|-----|-----------|------|\n';

    for (const agentId of agentIds) {
      const metadata = agentPool.getAgentMetadata(agentId);
      if (!metadata) continue;

      const status = metadata.inUse ? 'IN USE' : 'AVAILABLE';
      const type = metadata.config.isSpecializedAgent ? 'Specialized' : 'Standard';
      const age = this.formatDuration(Date.now() - metadata.createdAt);
      const lastUsed = this.formatDuration(Date.now() - metadata.lastAccessedAt);

      output += `| ${agentId} | ${status} | ${type} | ${age} | ${lastUsed} | ${metadata.useCount} |\n`;
    }

    // Multi-line output, not yellow
    return { handled: true, response: output };
  }

  /**
   * Show pool statistics
   */
  private async handleStats(serviceRegistry: ServiceRegistry): Promise<CommandResult> {
    const agentPool = serviceRegistry.get<AgentPoolService>('agent_pool');
    if (!agentPool) {
      return this.createError('Agent pool not available');
    }

    const stats = agentPool.getPoolStats();

    let output = '**Agent Pool Statistics**\n\n';
    output += '| Metric | Value |\n';
    output += '|--------|-------|\n';
    output += `| Total Agents | ${stats.totalAgents}/${stats.maxPoolSize} |\n`;
    output += `| In Use | ${stats.inUseAgents} |\n`;
    output += `| Available | ${stats.availableAgents} |\n`;

    if (stats.oldestAgentAge !== null) {
      output += `| Oldest Agent | ${this.formatDuration(stats.oldestAgentAge)} |\n`;
    }
    if (stats.newestAgentAge !== null) {
      output += `| Newest Agent | ${this.formatDuration(stats.newestAgentAge)} |\n`;
    }

    // Multi-line output, not yellow
    return { handled: true, response: output };
  }

  /**
   * Clear specific agent or all agents from pool
   */
  private async handleClear(args: string[], serviceRegistry: ServiceRegistry): Promise<CommandResult> {
    const agentPool = serviceRegistry.get<AgentPoolService>('agent_pool');
    if (!agentPool) {
      return this.createError('Agent pool not available');
    }

    // If agent_id provided, clear specific agent
    if (args.length > 0) {
      const agentId = args[0]!;

      if (!agentPool.hasAgent(agentId)) {
        return this.createError(`Agent '${agentId}' not found in pool. Use /agent active to see active agents.`);
      }

      const removed = await agentPool.removeAgent(agentId);

      if (removed) {
        return this.createResponse(`Removed agent '${agentId}' from pool.`);
      } else {
        return this.createError(`Cannot clear agent '${agentId}' - currently in use.`);
      }
    }

    // Clear entire pool
    const stats = agentPool.getPoolStats();
    if (stats.totalAgents === 0) {
      return this.createResponse('Pool is already empty.');
    }

    if (stats.inUseAgents > 0) {
      return this.createError(`Cannot clear pool - ${stats.inUseAgents} agent(s) currently in use.`);
    }

    await agentPool.clearPool();
    return this.createResponse(`Cleared ${stats.totalAgents} agent(s) from pool.`);
  }

  /**
   * Format a duration in milliseconds to human-readable string
   */
  private formatDuration(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) {
      return `${days}d ${hours % 24}h`;
    } else if (hours > 0) {
      return `${hours}h ${minutes % 60}m`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    } else {
      return `${seconds}s`;
    }
  }
}
