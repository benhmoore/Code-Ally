/**
 * HelpCommand - Show help information
 */

import { Command } from './Command.js';
import type { Message } from '@shared/index.js';
import type { ServiceRegistry } from '@services/ServiceRegistry.js';
import type { CommandResult } from '../CommandHandler.js';
import { CommandRegistry } from './CommandRegistry.js';
import type { CommandMetadata, HelpCategory } from './types.js';

export class HelpCommand extends Command {
  static readonly metadata: CommandMetadata = {
    name: '/help',
    description: 'Show help information',
    helpCategory: 'Core',
    subcommands: [
      { name: '<topic>', description: 'Filter help by topic' },
    ],
  };

  static {
    CommandRegistry.register(HelpCommand.metadata);
  }

  readonly name = HelpCommand.metadata.name;
  readonly description = HelpCommand.metadata.description;

  async execute(
    args: string[],
    _messages: Message[],
    _serviceRegistry: ServiceRegistry
  ): Promise<CommandResult> {
    // Input modes section (not commands, so defined here)
    const inputModesSection = {
      name: 'Input Modes' as HelpCategory,
      content: `\`!\`  Run bash command
\`#\`  Save memory to ALLY.md
\`@\`  Mention file or directory
\`+\`  Enable plugin for session
\`-\`  Disable plugin for session`,
    };

    // Get command sections from registry
    const commandSections = CommandRegistry.generateHelpSections();

    // Combine: input modes first, then command sections
    const allSections = [inputModesSection, ...commandSections];

    const formatSection = (section: { name: string; content: string }) =>
      `**${section.name}**\n${section.content}`;

    // No filter - return all sections
    const filter = args.join(' ').toLowerCase().trim();
    if (!filter) {
      return {
        handled: true,
        response: allSections.map(formatSection).join('\n\n'),
      };
    }

    // Filter sections by name or content match
    const matching = allSections.filter(
      (section) =>
        section.name.toLowerCase().includes(filter) ||
        section.content.toLowerCase().includes(filter)
    );

    if (matching.length === 0) {
      return {
        handled: true,
        response: `No help found for "${filter}". Type \`/help\` to see all commands.`,
      };
    }

    return {
      handled: true,
      response: matching.map(formatSection).join('\n\n'),
    };
  }
}
