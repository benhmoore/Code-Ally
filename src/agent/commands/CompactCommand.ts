/**
 * CompactCommand - Compact conversation context
 */

import { Command } from './Command.js';
import type { Message } from '@shared/index.js';
import type { ServiceRegistry } from '@services/ServiceRegistry.js';
import type { CommandResult } from '../CommandHandler.js';
import { CommandRegistry } from './CommandRegistry.js';
import type { CommandMetadata } from './types.js';

export class CompactCommand extends Command {
  static readonly metadata: CommandMetadata = {
    name: '/compact',
    description: 'Compact conversation context',
    helpCategory: 'Core',
    subcommands: [
      { name: '<instructions>', description: 'Custom compaction instructions' },
    ],
  };

  static {
    CommandRegistry.register(CompactCommand.metadata);
  }

  readonly name = CompactCommand.metadata.name;
  readonly description = CompactCommand.metadata.description;

  async execute(
    args: string[],
    _messages: Message[],
    serviceRegistry: ServiceRegistry
  ): Promise<CommandResult> {
    // Get agent from service registry
    const agent = serviceRegistry.get('agent');

    if (!agent) {
      return {
        handled: true,
        response: 'Error: Agent not available for compaction',
      };
    }

    // Extract custom instructions if provided
    const customInstructions = args.join(' ').trim() || undefined;

    try {
      if (typeof (agent as any).compactCurrentConversation !== 'function') {
        throw new Error('Active agent does not support compaction');
      }

      await (agent as any).compactCurrentConversation({
        customInstructions,
      });

      return {
        handled: true,
        response: '',
      };
    } catch (error) {
      return {
        handled: true,
        response: `Error compacting conversation: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  }
}
