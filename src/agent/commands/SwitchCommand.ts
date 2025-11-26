/**
 * SwitchCommand - Switch the main agent to a different agent type
 *
 * Allows users to switch between different agent types (e.g., custom agents)
 * or return to the default main agent using 'task' or 'ally'.
 */

import { Command } from './Command.js';
import type { Message } from '@shared/index.js';
import type { ServiceRegistry } from '@services/ServiceRegistry.js';
import type { CommandResult } from '../CommandHandler.js';
import { switchAgent } from '@services/AgentSwitcher.js';
import { ActivityEventType } from '@shared/index.js';
import { ActivityStream } from '@services/ActivityStream.js';
import { logger } from '@services/Logger.js';
import { CommandRegistry } from './CommandRegistry.js';
import type { CommandMetadata } from './types.js';

export class SwitchCommand extends Command {
  static readonly metadata: CommandMetadata = {
    name: '/switch',
    description: 'Switch to a different agent',
    helpCategory: 'Agents',
    subcommands: [
      { name: '<agent>', description: 'Switch to named agent' },
      { name: 'ally', description: 'Switch to main Ally agent' },
    ],
    useYellowOutput: true,
  };

  static {
    CommandRegistry.register(SwitchCommand.metadata);
  }

  readonly name = SwitchCommand.metadata.name;
  readonly description = SwitchCommand.metadata.description;
  protected readonly useYellowOutput = SwitchCommand.metadata.useYellowOutput ?? false;

  async execute(
    args: string[],
    _messages: Message[],
    serviceRegistry: ServiceRegistry
  ): Promise<CommandResult> {
    const argString = args.join(' ').trim();

    // No args → show usage
    if (!argString) {
      return this.showHelp();
    }

    const agentName = argString;

    try {
      // Call switchAgent from AgentSwitcher (returns new agent instance)
      const newAgent = await switchAgent(agentName, serviceRegistry);

      // Update currentAgent state in AppContext via activity stream
      const activityStream = serviceRegistry.get<ActivityStream>('activity_stream');
      if (activityStream) {
        activityStream.emit({
          id: `agent_switch_${Date.now()}`,
          type: ActivityEventType.AGENT_SWITCHED,
          timestamp: Date.now(),
          data: {
            agentName, // Use the agent name as typed by user
            agentId: newAgent.getInstanceId(), // Include ID for validation
            agentModel: newAgent.getModelClient().modelName, // Include model for status display
          },
        });
      }

      logger.debug('[SWITCH_CMD]', 'Successfully switched to agent:', agentName);

      // Return without adding a message to conversation
      return { handled: true };
    } catch (error) {
      // Handle errors (agent not found, switch failure, etc.)
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('[SWITCH_CMD]', 'Failed to switch agent:', errorMessage);

      return this.createError(errorMessage);
    }
  }

  /**
   * Show help text
   */
  private showHelp(): CommandResult {
    return {
      handled: true,
      response: this.getUsageText(),
    };
  }

  /**
   * Get usage text
   */
  private getUsageText(): string {
    const meta = SwitchCommand.metadata;
    const lines = meta.subcommands!.map(sub => {
      const cmd = `${meta.name} ${sub.name}`;
      return `\`${cmd}\`  ${sub.description}`;
    });

    return `**${meta.helpCategory}**
${lines.join('\n')}

Use \`/agent list\` to see available agents.`;
  }
}
