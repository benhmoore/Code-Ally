/**
 * ExitCommand - Exit the application
 */

import { Command } from './Command.js';
import type { Message } from '@shared/index.js';
import type { ServiceRegistry } from '@services/ServiceRegistry.js';
import type { CommandResult } from '../CommandHandler.js';
import { CommandRegistry } from './CommandRegistry.js';
import type { CommandMetadata } from './types.js';

export class ExitCommand extends Command {
  override readonly scope = 'application' as const;
  static readonly metadata: CommandMetadata = {
    name: '/exit',
    description: 'Exit the application',
    helpCategory: 'Core',
  };

  static {
    CommandRegistry.register(ExitCommand.metadata);
  }

  readonly name = ExitCommand.metadata.name;
  readonly description = ExitCommand.metadata.description;

  async execute(
    _args: string[],
    _messages: Message[],
    serviceRegistry: ServiceRegistry
  ): Promise<CommandResult> {
    // Slash-command exits bypass the CLI's signal handlers, so explicitly run
    // the same registered service lifecycle before terminating. In particular,
    // this prevents supervised background shells from becoming orphans.
    await serviceRegistry.shutdown();
    process.exit(0);
  }
}
