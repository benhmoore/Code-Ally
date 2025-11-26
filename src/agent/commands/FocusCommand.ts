/**
 * FocusCommand - Set focus to a specific path or directory
 *
 * Restricts file operations to a specific directory or path.
 */

import { Command } from './Command.js';
import type { Message } from '@shared/index.js';
import type { ServiceRegistry } from '@services/ServiceRegistry.js';
import type { CommandResult } from '../CommandHandler.js';
import type { FocusManager } from '@services/FocusManager.js';
import { CommandRegistry } from './CommandRegistry.js';
import type { CommandMetadata } from './types.js';

export class FocusCommand extends Command {
  static readonly metadata: CommandMetadata = {
    name: '/focus',
    description: 'Set focus to a specific path',
    helpCategory: 'Project',
    subcommands: [
      { name: '<path>', description: 'Set focus to directory' },
    ],
    useYellowOutput: true,
  };

  static {
    CommandRegistry.register(FocusCommand.metadata);
  }

  readonly name = FocusCommand.metadata.name;
  readonly description = FocusCommand.metadata.description;
  protected readonly useYellowOutput = FocusCommand.metadata.useYellowOutput ?? false;

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
