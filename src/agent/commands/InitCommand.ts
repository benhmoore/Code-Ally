/**
 * InitCommand - Run setup wizard
 */

import { Command } from './Command.js';
import { ActivityEventType } from '@shared/index.js';
import type { Message } from '@shared/index.js';
import type { ServiceRegistry } from '@services/ServiceRegistry.js';
import type { CommandResult } from '../CommandHandler.js';
import { CommandRegistry } from './CommandRegistry.js';
import type { CommandMetadata } from './types.js';

export class InitCommand extends Command {
  static readonly metadata: CommandMetadata = {
    name: '/init',
    description: 'Run setup wizard',
    helpCategory: 'Core',
  };

  static {
    CommandRegistry.register(InitCommand.metadata);
  }

  readonly name = InitCommand.metadata.name;
  readonly description = InitCommand.metadata.description;

  async execute(
    _args: string[],
    _messages: Message[],
    serviceRegistry: ServiceRegistry
  ): Promise<CommandResult> {
    const activityStream = serviceRegistry.get('activity_stream');

    if (!activityStream || typeof (activityStream as any).emit !== 'function') {
      return {
        handled: true,
        response: 'Setup wizard not available.',
      };
    }

    // Emit setup wizard request event
    const requestId = `setup_wizard_${Date.now()}`;

    (activityStream as any).emit({
      id: requestId,
      type: ActivityEventType.SETUP_WIZARD_REQUEST,
      timestamp: Date.now(),
      data: {
        requestId,
      },
    });

    return { handled: true };
  }
}
