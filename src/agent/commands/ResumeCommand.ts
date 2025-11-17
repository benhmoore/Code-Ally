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
