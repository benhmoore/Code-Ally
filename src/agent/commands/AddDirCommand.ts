/**
 * AddDirCommand - Add an additional working directory
 *
 * Adds a new directory to extend Ally's accessible scope beyond the current working directory.
 */

import { Command } from './Command.js';
import type { Message } from '@shared/index.js';
import type { ServiceRegistry } from '@services/ServiceRegistry.js';
import type { CommandResult } from '../CommandHandler.js';
import type { AdditionalDirectoriesManager } from '@services/AdditionalDirectoriesManager.js';
import { CommandRegistry } from './CommandRegistry.js';
import type { CommandMetadata } from './types.js';
import { createDirectoryAddedReminder } from '@utils/messageUtils.js';

export class AddDirCommand extends Command {
  static readonly metadata: CommandMetadata = {
    name: '/add-dir',
    description: 'Add an additional working directory',
    helpCategory: 'Project',
    subcommands: [
      { name: '<path>', description: 'Path to directory to add' },
    ],
    useYellowOutput: true,
  };

  static {
    CommandRegistry.register(AddDirCommand.metadata);
  }

  readonly name = AddDirCommand.metadata.name;
  readonly description = AddDirCommand.metadata.description;
  protected readonly useYellowOutput = AddDirCommand.metadata.useYellowOutput ?? false;

  async execute(
    args: string[],
    _messages: Message[],
    serviceRegistry: ServiceRegistry
  ): Promise<CommandResult> {
    const additionalDirsManager = serviceRegistry.get<AdditionalDirectoriesManager>('additional_dirs_manager');
    if (!additionalDirsManager) {
      return this.createError('Additional directories feature not available');
    }

    const path = args.join(' ').trim();

    if (!path) {
      return this.createResponse('Usage: /add-dir <path>\n\nAdd a directory to extend accessible scope.');
    }

    const result = await additionalDirsManager.addDirectory(path);

    // If directory was successfully added (not already in CWD), add system reminder
    if (result.success && result.path) {
      const systemReminder = createDirectoryAddedReminder(result.path);
      return {
        handled: true,
        response: result.message,
        updatedMessages: [systemReminder],
      };
    }

    return this.createResponse(result.message);
  }
}
