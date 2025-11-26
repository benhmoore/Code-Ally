/**
 * RemoveDirCommand - Remove an additional working directory
 *
 * Removes a directory from the additional directories list, restricting Ally's scope.
 */

import { Command } from './Command.js';
import type { Message } from '@shared/index.js';
import type { ServiceRegistry } from '@services/ServiceRegistry.js';
import type { CommandResult } from '../CommandHandler.js';
import type { AdditionalDirectoriesManager } from '@services/AdditionalDirectoriesManager.js';
import { CommandRegistry } from './CommandRegistry.js';
import type { CommandMetadata } from './types.js';
import { createDirectoryRemovedReminder } from '@utils/messageUtils.js';

export class RemoveDirCommand extends Command {
  static readonly metadata: CommandMetadata = {
    name: '/remove-dir',
    description: 'Remove an additional working directory',
    helpCategory: 'Project',
    subcommands: [
      { name: '<path>', description: 'Path to directory to remove' },
    ],
    useYellowOutput: true,
  };

  static {
    CommandRegistry.register(RemoveDirCommand.metadata);
  }

  readonly name = RemoveDirCommand.metadata.name;
  readonly description = RemoveDirCommand.metadata.description;
  protected readonly useYellowOutput = RemoveDirCommand.metadata.useYellowOutput ?? false;

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
      const displayPaths = additionalDirsManager.getDisplayPaths();
      let message = 'Usage: /remove-dir <path>\n\n';

      if (displayPaths.length === 0) {
        message += 'No additional directories configured.';
      } else {
        message += 'Current additional directories:\n';
        displayPaths.forEach(dir => {
          message += `  ${dir}\n`;
        });
      }

      return this.createResponse(message.trimEnd());
    }

    const result = additionalDirsManager.removeDirectory(path);

    // If directory was successfully removed, add system reminder
    if (result.success && result.path) {
      const systemReminder = createDirectoryRemovedReminder(result.path);
      return {
        handled: true,
        response: result.message,
        updatedMessages: [systemReminder],
      };
    }

    return this.createResponse(result.message);
  }
}
