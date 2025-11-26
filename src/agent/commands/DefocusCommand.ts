/**
 * DefocusCommand - Clear current focus
 *
 * Removes any active directory focus restrictions.
 */

import { Command } from './Command.js';
import type { Message } from '@shared/index.js';
import type { ServiceRegistry } from '@services/ServiceRegistry.js';
import type { CommandResult } from '../CommandHandler.js';
import type { FocusManager } from '@services/FocusManager.js';
import { CommandRegistry } from './CommandRegistry.js';
import type { CommandMetadata } from './types.js';

export class DefocusCommand extends Command {
  static readonly metadata: CommandMetadata = {
    name: '/defocus',
    description: 'Clear current focus',
    helpCategory: 'Project',
    useYellowOutput: true,
  };

  static {
    CommandRegistry.register(DefocusCommand.metadata);
  }

  readonly name = DefocusCommand.metadata.name;
  readonly description = DefocusCommand.metadata.description;
  protected readonly useYellowOutput = DefocusCommand.metadata.useYellowOutput ?? false;

  async execute(
    _args: string[],
    _messages: Message[],
    serviceRegistry: ServiceRegistry
  ): Promise<CommandResult> {
    const focusManager = serviceRegistry.get<FocusManager>('focus_manager');
    if (!focusManager) {
      return this.createError('Focus feature not available');
    }

    const result = focusManager.clearFocus();
    return this.createResponse(result.message);
  }
}
