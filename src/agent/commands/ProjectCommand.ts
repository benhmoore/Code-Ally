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
import type { ProjectManager } from '@services/ProjectManager.js';
import { CommandRegistry } from './CommandRegistry.js';
import type { CommandMetadata } from './types.js';

export class ProjectCommand extends Command {
  static readonly metadata: CommandMetadata = {
    name: '/project',
    description: 'Manage project configuration',
    helpCategory: 'Project',
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

    const projectManager = serviceRegistry.get<ProjectManager>('project_manager');
    if (!projectManager && subcommand.toLowerCase() !== 'init') {
      return this.createError('Project manager not available');
    }

    switch (subcommand.toLowerCase()) {
      case 'init':
        return this.handleInit(serviceRegistry);
      case 'view':
        return this.handleView(projectManager!);
      case 'clear':
        return this.handleClear(projectManager!);
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
   * View project context - multi-line output, not yellow
   */
  private async handleView(projectManager: ProjectManager): Promise<CommandResult> {
    const context = await projectManager.getContext();

    if (!context) {
      return {
        handled: true,
        response: 'No project context found. Use /project init to create one.',
      };
    }

    let output = `Project: ${context.name}\n\n`;
    output += `Description: ${context.description}\n`;
    output += `Files: ${context.files.length}\n`;
    output += `Created: ${new Date(context.created).toLocaleString()}\n`;
    output += `Updated: ${new Date(context.updated).toLocaleString()}\n`;

    return { handled: true, response: output };
  }

  /**
   * Clear project context - yellow output
   */
  private async handleClear(projectManager: ProjectManager): Promise<CommandResult> {
    await projectManager.clearContext();
    return this.createResponse('Project context cleared.');
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
