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

export class SwitchCommand extends Command {
  readonly name = '/switch';
  readonly description = 'Switch to a different agent';
  protected readonly useYellowOutput = true; // Brief status messages

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
    return `Usage:
  /switch <agent-name>    Switch to a different agent

Examples:
  /switch <agent-name>   Switch to any available agent
  /switch ally           Return to main agent

Use '/agent list' to see available agents.`;
  }
}
