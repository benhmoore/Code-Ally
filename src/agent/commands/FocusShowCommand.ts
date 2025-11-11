/**
 * FocusShowCommand - Show current focus
 *
 * Displays the currently active directory focus if one is set.
 */

import { Command } from './Command.js';
import type { Message } from '@shared/index.js';
import type { ServiceRegistry } from '@services/ServiceRegistry.js';
import type { CommandResult } from '../CommandHandler.js';
import type { FocusManager } from '@services/FocusManager.js';

export class FocusShowCommand extends Command {
  readonly name = '/focus-show';
  readonly description = 'Show current focus';

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

    const display = focusManager.getFocusDisplay();

    if (display) {
      return this.createResponse(`Current focus: ${display}`);
    } else {
      return this.createResponse('No focus is currently set.');
    }
  }
}
