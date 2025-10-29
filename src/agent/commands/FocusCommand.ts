/**
 * FocusCommand - Set focus to a specific path or directory
 *
 * Restricts file operations to a specific directory or path.
 */

import { Command } from './Command.js';
import type { Message } from '../../types/index.js';
import type { ServiceRegistry } from '../../services/ServiceRegistry.js';
import type { CommandResult } from '../CommandHandler.js';
import type { FocusManager } from '../../services/FocusManager.js';

export class FocusCommand extends Command {
  readonly name = '/focus';
  readonly description = 'Set focus to a specific path or directory';

  // Use yellow output for simple status messages
  protected readonly useYellowOutput = true;

  async execute(
    args: string[],
    _messages: Message[],
    serviceRegistry: ServiceRegistry
  ): Promise<CommandResult> {
    const focusManager = serviceRegistry.get<FocusManager>('focus_manager');
    if (!focusManager) {
      return this.createError('Focus feature not available');
    }

    const path = args.join(' ').trim();

    if (!path) {
      const focused = focusManager.isFocused();

      if (focused) {
        const display = focusManager.getFocusDisplay();
        return this.createResponse(
          `Currently focused on: ${display}\n\nUsage:\n  /focus <path>  - Set focus\n  /defocus       - Clear focus`
        );
      } else {
        return this.createResponse('No focus is currently set.\n\nUsage: /focus <path>');
      }
    }

    const result = await focusManager.setFocus(path);
    return this.createResponse(result.message);
  }
}
