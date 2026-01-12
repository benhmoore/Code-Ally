/**
 * SkillCommand - Manage skills
 *
 * Provides subcommands for:
 * - list: List all available skills
 * - show: Show detailed instructions for a skill
 * - reload: Reload skills from disk
 */

import { Command } from './Command.js';
import type { Message } from '@shared/index.js';
import type { ServiceRegistry } from '@services/ServiceRegistry.js';
import type { CommandResult } from '../CommandHandler.js';
import { CommandRegistry } from './CommandRegistry.js';
import type { CommandMetadata } from './types.js';

export class SkillCommand extends Command {
  static readonly metadata: CommandMetadata = {
    name: '/skill',
    description: 'Manage skills',
    helpCategory: 'Core',
    subcommands: [
      { name: 'list', description: 'List available skills' },
      { name: 'show', description: 'Show skill details', args: '<name>' },
      { name: 'reload', description: 'Reload skills from disk' },
    ],
    useYellowOutput: true,
  };

  static {
    CommandRegistry.register(SkillCommand.metadata);
  }

  readonly name = SkillCommand.metadata.name;
  readonly description = SkillCommand.metadata.description;

  protected readonly useYellowOutput = SkillCommand.metadata.useYellowOutput ?? false;

  async execute(
    args: string[],
    _messages: Message[],
    serviceRegistry: ServiceRegistry
  ): Promise<CommandResult> {
    // No args - show help
    if (args.length === 0) {
      return this.showHelp();
    }

    const subcommand = args[0]!;
    const restArgs = args.slice(1);

    switch (subcommand.toLowerCase()) {
      case 'list':
      case 'ls':
        return this.handleList(serviceRegistry);
      case 'show':
        return this.handleShow(restArgs.join(' '), serviceRegistry);
      case 'reload':
        return this.handleReload(serviceRegistry);
      default:
        return {
          handled: true,
          response: `Unknown skill subcommand: ${subcommand}. Use /skill for help.`,
        };
    }
  }

  private showHelp(): CommandResult {
    const meta = SkillCommand.metadata;

    const lines = meta.subcommands!.map(sub => {
      const cmd = sub.args
        ? `${meta.name} ${sub.name} ${sub.args}`
        : `${meta.name} ${sub.name}`;
      return `\`${cmd}\`  ${sub.description}`;
    });

    return {
      handled: true,
      response: `**Skill Commands**\n${lines.join('\n')}`,
    };
  }

  private async handleList(serviceRegistry: ServiceRegistry): Promise<CommandResult> {
    const skillManager = serviceRegistry.getSkillManager();
    if (!skillManager) {
      return this.createError('Skill system not available');
    }

    const skills = await skillManager.listSkills();

    if (skills.length === 0) {
      return {
        handled: true,
        response: 'No skills available.',
      };
    }

    let output = '**Available Skills**\n\n';
    output += '| Name | Source | Description |\n';
    output += '|------|--------|-------------|\n';

    for (const skill of skills) {
      output += `| ${skill.name} | ${skill.source} | ${skill.description} |\n`;
    }

    // Multi-line output, not yellow
    return { handled: true, response: output };
  }

  private async handleShow(name: string, serviceRegistry: ServiceRegistry): Promise<CommandResult> {
    if (!name) {
      return this.createError('Skill name required. Usage: /skill show <name>');
    }

    const skillManager = serviceRegistry.getSkillManager();
    if (!skillManager) {
      return this.createError('Skill system not available');
    }

    const skill = await skillManager.getSkill(name);

    if (!skill) {
      return {
        handled: true,
        response: `Skill '${name}' not found.`,
      };
    }

    let output = `**Skill: ${skill.name}**\n\n`;
    output += `| Property | Value |\n`;
    output += `|----------|-------|\n`;
    output += `| Source | ${skill.source} |\n`;
    output += `| Directory | ${skill.directory} |\n`;
    output += `| Description | ${skill.description} |\n\n`;
    output += `**Instructions**\n\n${skill.instructions}`;

    // Multi-line output, not yellow
    return { handled: true, response: output };
  }

  private async handleReload(serviceRegistry: ServiceRegistry): Promise<CommandResult> {
    const skillManager = serviceRegistry.getSkillManager();
    if (!skillManager) {
      return this.createError('Skill system not available');
    }

    await skillManager.reload();
    const count = skillManager.getSkillCount();

    return this.createResponse(`Reloaded ${count} skill(s) from disk.`);
  }
}
