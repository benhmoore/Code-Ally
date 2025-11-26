/**
 * ResumeCommand - Resume a previous session
 *
 * Triggers the session selection UI to allow users to pick a session to resume.
 */

import { Command } from './Command.js';
import type { Message } from '@shared/index.js';
import { ActivityEventType } from '@shared/index.js';
import type { ServiceRegistry } from '@services/ServiceRegistry.js';
import type { CommandResult } from '../CommandHandler.js';
import { CommandRegistry } from './CommandRegistry.js';
import type { CommandMetadata } from './types.js';

export class ResumeCommand extends Command {
  static readonly metadata: CommandMetadata = {
    name: '/resume',
    description: 'Resume a previous session',
    helpCategory: 'Core',
    subcommands: [
      { name: '<session>', description: 'Resume specified session' },
    ],
  };

  static {
    CommandRegistry.register(ResumeCommand.metadata);
  }

  readonly name = ResumeCommand.metadata.name;
  readonly description = ResumeCommand.metadata.description;
  protected readonly useYellowOutput = ResumeCommand.metadata.useYellowOutput ?? false;

  async execute(
    args: string[],
    _messages: Message[],
    serviceRegistry: ServiceRegistry
  ): Promise<CommandResult> {
    // If session ID provided, directly resume that session
    if (args.length > 0 && args[0]) {
      const sessionId = args[0];

      // Emit SESSION_SELECT_RESPONSE event to directly resume the session
      return this.emitActivityEvent(
        serviceRegistry,
        ActivityEventType.SESSION_SELECT_RESPONSE,
        {
          requestId: `session_select_${Date.now()}`,
          sessionId: sessionId,
          cancelled: false,
        },
        'session_select_response'
      );
    }

    // No session ID provided - show session selection UI
    return this.emitActivityEvent(
      serviceRegistry,
      ActivityEventType.SESSION_SELECT_REQUEST,
      {},
      'session_select'
    );
  }
}
