/**
 * ProjectCommand - Manage project context
 *
 * Provides project management functionality including initialization,
 * viewing, clearing, and editing project context.
 */

import { Command } from './Command.js';
import type { Message } from '@shared/index.js';
import { ActivityEventType } from '@shared/index.js';
import type { ServiceRegistry } from '@services/ServiceRegistry.js';
import type { CommandResult } from '../CommandHandler.js';
import { CommandRegistry } from './CommandRegistry.js';
import type { CommandMetadata } from './types.js';
import { getProjectInstructionsFile } from '../../config/paths.js';
import { readFile, rm } from 'node:fs/promises';

export class ProjectCommand extends Command {
  static readonly metadata: CommandMetadata = {
    name: '/project',
    description: 'Manage project configuration',
    helpCategory: 'Project',
    completion: { enterBehavior: 'insert' },
    subcommands: [
      { name: 'init', description: 'Initialize ALLY.md' },
      { name: 'edit', description: 'Edit ALLY.md' },
      { name: 'view', description: 'View ALLY.md' },
      { name: 'clear', description: 'Clear project context' },
    ],
  };

  static {
    CommandRegistry.register(ProjectCommand.metadata);
  }

  readonly name = ProjectCommand.metadata.name;
  readonly description = ProjectCommand.metadata.description;
  protected readonly useYellowOutput = ProjectCommand.metadata.useYellowOutput ?? false;

  async execute(
    args: string[],
    _messages: Message[],
    serviceRegistry: ServiceRegistry
  ): Promise<CommandResult> {
    const argString = args.join(' ').trim();

    // No args → show help/usage
    if (!argString) {
      return {
        handled: true,
        response: `Project Commands:
  /project init    - Initialize project context
  /project edit    - Edit project file
  /project view    - View project file
  /project clear   - Clear project context
`,
      };
    }

    const parts = argString.split(/\s+/);
    const subcommand = parts[0];
    if (!subcommand) {
      return { handled: true, response: 'Invalid project command' };
    }

    switch (subcommand.toLowerCase()) {
      case 'init':
        return this.handleInit(serviceRegistry);
      case 'view':
        return this.handleView();
      case 'clear':
        return this.handleClear();
      case 'edit':
        return this.handleEdit();
      default:
        return {
          handled: true,
          response: `Unknown project subcommand: ${subcommand}`,
        };
    }
  }

  /**
   * Initialize project context - shows modal UI
   */
  private async handleInit(serviceRegistry: ServiceRegistry): Promise<CommandResult> {
    // Emit project wizard request event
    return this.emitActivityEvent(
      serviceRegistry,
      ActivityEventType.PROJECT_WIZARD_REQUEST,
      {},
      'project_wizard'
    );
  }

  /**
   * View ALLY.md contents - multi-line output, not yellow
   */
  private async handleView(): Promise<CommandResult> {
    const allyPath = getProjectInstructionsFile();

    let content: string;
    try {
      content = await readFile(allyPath, 'utf-8');
    } catch {
      return {
        handled: true,
        response: 'No ALLY.md found. Use /project init to create one.',
      };
    }

    return { handled: true, response: `${allyPath}\n\n${content.trim()}` };
  }

  /**
   * Delete ALLY.md - yellow output
   */
  private async handleClear(): Promise<CommandResult> {
    const allyPath = getProjectInstructionsFile();
    try {
      await rm(allyPath);
    } catch {
      return this.createResponse('No ALLY.md to clear.');
    }
    return this.createResponse(`Removed ${allyPath}.`);
  }

  /**
   * Edit project - not yet implemented
   */
  private async handleEdit(): Promise<CommandResult> {
    return {
      handled: true,
      response: 'Project editing not yet implemented',
    };
  }
}
