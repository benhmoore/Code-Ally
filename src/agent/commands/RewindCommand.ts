/**
 * RewindCommand - Rewind conversation to earlier point
 */

import { Command } from './Command.js';
import type { Message } from '@shared/index.js';
import type { ServiceRegistry } from '@services/ServiceRegistry.js';
import type { CommandResult } from '../CommandHandler.js';
import { CommandRegistry } from './CommandRegistry.js';
import type { CommandMetadata } from './types.js';

export class RewindCommand extends Command {
  static readonly metadata: CommandMetadata = {
    name: '/rewind',
    description: 'Rewind conversation',
    helpCategory: 'Core',
  };

  static {
    CommandRegistry.register(RewindCommand.metadata);
  }

  readonly name = RewindCommand.metadata.name;
  readonly description = RewindCommand.metadata.description;

  async execute(
    _args: string[],
    _messages: Message[],
    serviceRegistry: ServiceRegistry
  ): Promise<CommandResult> {
    const activityStream = serviceRegistry.get('activity_stream');

    if (!activityStream || typeof (activityStream as any).emit !== 'function') {
      return {
        handled: true,
        response: 'Rewind feature not available (activity stream not found).',
      };
    }

    // Emit rewind request event
    const requestId = `rewind_${Date.now()}`;

    (activityStream as any).emit({
      id: requestId,
      type: 'rewind_request',
      timestamp: Date.now(),
      data: {
        requestId,
      },
    });

    return { handled: true };
  }
}
