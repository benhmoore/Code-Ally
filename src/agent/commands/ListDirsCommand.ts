/**
 * ListDirsCommand - List all additional working directories
 *
 * Displays all directories that have been added to extend Ally's accessible scope.
 */

import { Command } from './Command.js';
import type { Message } from '@shared/index.js';
import type { ServiceRegistry } from '@services/ServiceRegistry.js';
import type { CommandResult } from '../CommandHandler.js';
import type { AdditionalDirectoriesManager } from '@services/AdditionalDirectoriesManager.js';
import { CommandRegistry } from './CommandRegistry.js';
import type { CommandMetadata } from './types.js';

export class ListDirsCommand extends Command {
  static readonly metadata: CommandMetadata = {
    name: '/list-dirs',
    description: 'List all additional working directories',
    helpCategory: 'Project',
    useYellowOutput: true,
  };

  static {
    CommandRegistry.register(ListDirsCommand.metadata);
  }

  readonly name = ListDirsCommand.metadata.name;
  readonly description = ListDirsCommand.metadata.description;
  protected readonly useYellowOutput = ListDirsCommand.metadata.useYellowOutput ?? false;

  async execute(
    _args: string[],
    _messages: Message[],
    serviceRegistry: ServiceRegistry
  ): Promise<CommandResult> {
    const additionalDirsManager = serviceRegistry.get<AdditionalDirectoriesManager>('additional_dirs_manager');
    if (!additionalDirsManager) {
      return this.createError('Additional directories feature not available');
    }

    const displayPaths = additionalDirsManager.getDisplayPaths();

    if (displayPaths.length === 0) {
      return this.createResponse('No additional directories configured.');
    }

    let message = 'Additional working directories:\n';
    displayPaths.forEach(dir => {
      message += `  ${dir}\n`;
    });

    return this.createResponse(message.trimEnd());
  }
}
