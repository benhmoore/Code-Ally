/**
 * DefocusCommand - Clear current focus
 *
 * Removes any active directory focus restrictions.
 */

import { Command } from './Command.js';
import type { Message } from '../../types/index.js';
import type { ServiceRegistry } from '../../services/ServiceRegistry.js';
import type { CommandResult } from '../CommandHandler.js';
import type { FocusManager } from '../../services/FocusManager.js';

export class DefocusCommand extends Command {
  readonly name = '/defocus';
  readonly description = 'Clear current focus';

  // Use yellow output for simple status messages
  protected readonly useYellowOutput = true;

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
