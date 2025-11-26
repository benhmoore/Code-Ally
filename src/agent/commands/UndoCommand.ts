/**
 * UndoCommand - Undo recent file operations
 *
 * Shows an interactive file list UI for selecting operations to undo.
 */

import { Command } from './Command.js';
import type { Message } from '@shared/index.js';
import { ActivityEventType } from '@shared/index.js';
import type { ServiceRegistry } from '@services/ServiceRegistry.js';
import type { CommandResult } from '../CommandHandler.js';
import type { PatchManager } from '@services/PatchManager.js';
import { formatError } from '@utils/errorUtils.js';
import { CommandRegistry } from './CommandRegistry.js';
import type { CommandMetadata } from './types.js';

export class UndoCommand extends Command {
  static readonly metadata: CommandMetadata = {
    name: '/undo',
    description: 'Undo file operations',
    helpCategory: 'Core',
    useYellowOutput: true,
  };

  static {
    CommandRegistry.register(UndoCommand.metadata);
  }

  readonly name = UndoCommand.metadata.name;
  readonly description = UndoCommand.metadata.description;
  protected readonly useYellowOutput = UndoCommand.metadata.useYellowOutput ?? false;

  async execute(
    _args: string[],
    _messages: Message[],
    serviceRegistry: ServiceRegistry
  ): Promise<CommandResult> {
    // Get PatchManager from service registry
    const patchManager = serviceRegistry.get<PatchManager>('patch_manager');

    if (!patchManager) {
      return this.createError('Undo feature not available (patch manager not initialized)');
    }

    try {
      // Get list of recent file changes
      const fileList = await patchManager.getRecentFileList(10);

      if (fileList.length === 0) {
        return this.createResponse('No operations to undo');
      }

      // Emit UNDO_FILE_LIST_REQUEST event for UI to show file list
      return this.emitActivityEvent(
        serviceRegistry,
        ActivityEventType.UNDO_FILE_LIST_REQUEST,
        { fileList },
        'undo'
      );
    } catch (error) {
      return this.createError(`Error during undo operation: ${formatError(error)}`);
    }
  }
}
