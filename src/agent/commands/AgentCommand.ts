/**
 * AgentCommand - Manage agents
 *
 * Provides subcommands for creating, listing, showing, using, and deleting agents.
 */

import { Command } from './Command.js';
import type { Message } from '../../types/index.js';
import type { ServiceRegistry } from '../../services/ServiceRegistry.js';
import type { CommandResult } from '../CommandHandler.js';
import type { AgentManager } from '../../services/AgentManager.js';

export class AgentCommand extends Command {
  readonly name = '/agent';
  readonly description = 'Manage agents';

  // Use yellow output for delete subcommand only
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
      case 'create':
        return this.handleCreate(restArgs.join(' '));
      case 'ls':
      case 'list':
        return this.handleList(serviceRegistry);
      case 'show':
        return this.handleShow(restArgs.join(' '), serviceRegistry);
      case 'delete':
      case 'rm':
        return this.handleDelete(restArgs.join(' '), serviceRegistry);
      case 'use':
        return this.handleUse(restArgs.join(' '));
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
      response: `Agent Commands:
  /agent create <description> - Create new specialized agent
  /agent ls                   - List available agents
  /agent show <name>          - Show agent details
  /agent use <name> <task>    - Use specific agent
  /agent delete <name>        - Delete agent
`,
    };
  }

  private async handleCreate(description: string): Promise<CommandResult> {
    if (!description) {
      return {
        handled: true,
        response: 'Description required. Usage: /agent create <description>',
      };
    }

    return {
      handled: true,
      response: 'Agent creation not yet implemented',
    };
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
        response: 'No agents available. Use /agent create to create one.',
      };
    }

    let output = 'Available Agents:\n\n';

    for (const agent of agents) {
      output += `  - ${agent.name}: ${agent.description}\n`;
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

    let output = `Agent: ${agent.name}\n\n`;
    output += `Description: ${agent.description}\n`;
    output += `Created: ${agent.created_at || 'Unknown'}\n\n`;
    output += `System Prompt:\n${agent.system_prompt}\n`;

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

  private async handleUse(args: string): Promise<CommandResult> {
    if (!args) {
      return {
        handled: true,
        response: 'Usage: /agent use <name> <task>',
      };
    }

    return {
      handled: true,
      response: 'Agent delegation not yet implemented',
    };
  }
}
