/**
 * MemoryCommand - Inspect and manage autonomous project memory
 *
 * The agent maintains memory on its own via the memory tool; this command gives
 * the user a window into that store and a way to prune it. Memory lives globally
 * under ~/.ally/projects/<key>/memory, separate from the committed ALLY.md.
 */

import { Command } from './Command.js';
import type { Message } from '@shared/index.js';
import type { ServiceRegistry } from '@services/ServiceRegistry.js';
import type { CommandResult } from '../CommandHandler.js';
import type { MemoryService } from '@services/MemoryService.js';
import { CommandRegistry } from './CommandRegistry.js';
import type { CommandMetadata } from './types.js';

export class MemoryCommand extends Command {
  static readonly metadata: CommandMetadata = {
    name: '/memory',
    description: 'Inspect and manage project memory',
    helpCategory: 'Memory',
    subcommands: [
      { name: 'list', description: 'List all remembered facts' },
      { name: 'show', description: 'Show one memory in full', args: '<name>' },
      { name: 'forget', description: 'Delete a memory', args: '<name>' },
    ],
  };

  static {
    CommandRegistry.register(MemoryCommand.metadata);
  }

  readonly name = MemoryCommand.metadata.name;
  readonly description = MemoryCommand.metadata.description;

  async execute(
    args: string[],
    _messages: Message[],
    serviceRegistry: ServiceRegistry,
  ): Promise<CommandResult> {
    const memoryService = this.getRequiredService<MemoryService>(serviceRegistry, 'memory_service', 'Memory');
    if ('handled' in memoryService) {
      return memoryService;
    }

    const subcommand = (args[0] || 'list').toLowerCase();
    const target = args.slice(1).join(' ').trim();

    switch (subcommand) {
      case 'list':
        return this.handleList(memoryService);
      case 'show':
        return this.handleShow(memoryService, target);
      case 'forget':
      case 'delete':
        return this.handleForget(memoryService, target);
      default:
        return this.createError(`Unknown memory subcommand: ${subcommand}. Try list, show, or forget.`);
    }
  }

  private async handleList(memoryService: MemoryService): Promise<CommandResult> {
    const records = await memoryService.list();
    if (records.length === 0) {
      return { handled: true, response: 'No memories yet. Ally saves them automatically as it learns about this project.' };
    }

    let output = `**Project Memory** (${records.length})\n\n`;
    let currentType = '';
    for (const record of records) {
      if (record.type !== currentType) {
        currentType = record.type;
        output += `**${currentType}**\n`;
      }
      output += `\`${record.name}\`  ${record.description}\n`;
    }
    output += `\nStored in ${memoryService.getMemoryDir()}`;
    return { handled: true, response: output };
  }

  private async handleShow(memoryService: MemoryService, name: string): Promise<CommandResult> {
    if (!name) {
      return this.createError('Usage: /memory show <name>');
    }
    const [record] = await memoryService.recall({ name });
    if (!record) {
      return this.createError(`No memory named "${name}". Use /memory list to see what's stored.`);
    }
    return {
      handled: true,
      response: `**${record.name}** (${record.type})\n${record.description}\n\n${record.body}`,
    };
  }

  private async handleForget(memoryService: MemoryService, name: string): Promise<CommandResult> {
    if (!name) {
      return this.createError('Usage: /memory forget <name>');
    }
    const removed = await memoryService.delete(name);
    return removed
      ? this.createResponse(`Forgot: ${name}`)
      : this.createError(`No memory named "${name}".`);
  }
}
