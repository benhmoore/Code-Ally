/**
 * ClearCommand - Clear conversation history
 *
 * Removes all messages from the conversation except the system message,
 * clears the UI view completely, and updates the token manager accordingly.
 */

import { Command } from './Command.js';
import { ActivityEventType } from '@shared/index.js';
import type { Message } from '@shared/index.js';
import type { ServiceRegistry } from '@services/ServiceRegistry.js';
import type { CommandResult } from '../CommandHandler.js';
import { CommandRegistry } from './CommandRegistry.js';
import type { CommandExecutionContext, CommandMetadata } from './types.js';

export class ClearCommand extends Command {
  override readonly scope = 'foreground-conversation' as const;
  static readonly metadata: CommandMetadata = {
    name: '/clear',
    description: 'Clear conversation history',
    helpCategory: 'Core',
    useYellowOutput: true,
  };

  static {
    CommandRegistry.register(ClearCommand.metadata);
  }

  readonly name = ClearCommand.metadata.name;
  readonly description = ClearCommand.metadata.description;
  protected readonly useYellowOutput = ClearCommand.metadata.useYellowOutput ?? false;

  async execute(
    _args: string[],
    _messages: Message[],
    _serviceRegistry: ServiceRegistry,
    context: CommandExecutionContext,
  ): Promise<CommandResult> {
    const { agent, activityStream } = context.route;

    // The agent owns both the in-memory reset and its durable replacement. The
    // command must not emit a clear event until both have succeeded.
    await agent.clearConversation();

    // Emit event to reset the UI view completely
    activityStream.emit({
      id: `clear-${Date.now()}`,
      type: ActivityEventType.CONVERSATION_CLEAR,
      timestamp: Date.now(),
      data: {},
    });

    // Return silent success - UI will be completely reset so no message needed
    return this.createSilentResponse();
  }
}
