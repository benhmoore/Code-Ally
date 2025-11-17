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

export class ResumeCommand extends Command {
  readonly name = '/resume';
  readonly description = 'Resume a previous session';

  async execute(
    _args: string[],
    _messages: Message[],
    serviceRegistry: ServiceRegistry
  ): Promise<CommandResult> {
    // Emit SESSION_SELECT_REQUEST event to trigger UI
    return this.emitActivityEvent(
      serviceRegistry,
      ActivityEventType.SESSION_SELECT_REQUEST,
      {},
      'session_select'
    );
  }
}
