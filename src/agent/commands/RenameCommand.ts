/**
 * RenameCommand - Manually rename the current conversation
 *
 * Allows users to set a custom title for the current session.
 * When set manually, auto-regeneration is disabled to preserve the user's choice.
 */

import { Command } from './Command.js';
import type { Message } from '@shared/index.js';
import type { ServiceRegistry } from '@services/ServiceRegistry.js';
import type { CommandResult } from '../CommandHandler.js';
import type { SessionManager } from '@services/SessionManager.js';
import { setTerminalTitle } from '../../utils/terminal.js';
import { logger } from '@services/Logger.js';
import { CommandRegistry } from './CommandRegistry.js';
import type { CommandMetadata } from './types.js';

export class RenameCommand extends Command {
  static readonly metadata: CommandMetadata = {
    name: '/rename',
    description: 'Rename the current conversation',
    helpCategory: 'Core',
    subcommands: [
      { name: '<title>', description: 'New title for this conversation' },
    ],
    useYellowOutput: true,
  };

  static {
    CommandRegistry.register(RenameCommand.metadata);
  }

  readonly name = RenameCommand.metadata.name;
  readonly description = RenameCommand.metadata.description;
  protected readonly useYellowOutput = RenameCommand.metadata.useYellowOutput ?? false;

  async execute(
    args: string[],
    _messages: Message[],
    serviceRegistry: ServiceRegistry
  ): Promise<CommandResult> {
    const newTitle = args.join(' ').trim();

    if (!newTitle) {
      return this.createError('Usage: /rename <title>');
    }

    const sessionManager = serviceRegistry.get<SessionManager>('session_manager');
    if (!sessionManager) {
      return this.createError('Session manager not available');
    }

    const currentSession = sessionManager.getCurrentSession();
    if (!currentSession) {
      return this.createError('No active session');
    }

    try {
      // Update title and set userSetTitle flag to disable auto-regeneration
      const success = await sessionManager.updateMetadata(currentSession, {
        title: newTitle,
        userSetTitle: true,
        lastTitleGeneratedAt: Date.now(),
      });

      if (!success) {
        return this.createError('Failed to update session title');
      }

      // Update terminal title to reflect the change
      setTerminalTitle(newTitle);

      logger.debug('[RENAME_CMD]', `Renamed session to: "${newTitle}"`);

      return this.createResponse(`Renamed to: ${newTitle}`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('[RENAME_CMD]', 'Failed to rename session:', errorMessage);
      return this.createError(`Failed to rename: ${errorMessage}`);
    }
  }
}
