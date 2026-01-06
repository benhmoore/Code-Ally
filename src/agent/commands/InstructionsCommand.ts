/**
 * InstructionsCommand - Manage profile-level custom instructions
 *
 * Provides management of the profile-specific instructions.md file,
 * which contains custom instructions that apply across all projects
 * when using the current profile.
 */

import { Command } from './Command.js';
import type { Message } from '@shared/index.js';
import type { ServiceRegistry } from '@services/ServiceRegistry.js';
import type { CommandResult } from '../CommandHandler.js';
import { CommandRegistry } from './CommandRegistry.js';
import type { CommandMetadata } from './types.js';
import { getProfileInstructionsFile, getActiveProfile } from '../../config/paths.js';
import fs from 'fs';
import { execSync } from 'child_process';

export class InstructionsCommand extends Command {
  static readonly metadata: CommandMetadata = {
    name: '/instructions',
    description: 'Manage profile-level custom instructions',
    helpCategory: 'Core',
    subcommands: [
      { name: 'view', description: 'View custom instructions' },
      { name: 'edit', description: 'Edit custom instructions' },
    ],
  };

  static {
    CommandRegistry.register(InstructionsCommand.metadata);
  }

  readonly name = InstructionsCommand.metadata.name;
  readonly description = InstructionsCommand.metadata.description;
  protected readonly useYellowOutput = InstructionsCommand.metadata.useYellowOutput ?? false;

  async execute(
    args: string[],
    _messages: Message[],
    _serviceRegistry: ServiceRegistry
  ): Promise<CommandResult> {
    const argString = args.join(' ').trim();

    // No args → show help/usage
    if (!argString) {
      const profileName = getActiveProfile();
      return {
        handled: true,
        response: `Instructions Commands (profile: ${profileName}):
  /instructions view    - View custom instructions
  /instructions edit    - Edit custom instructions
`,
      };
    }

    const parts = argString.split(/\s+/);
    const subcommand = parts[0];
    if (!subcommand) {
      return { handled: true, response: 'Invalid instructions command' };
    }

    switch (subcommand.toLowerCase()) {
      case 'view':
        return this.handleView();
      case 'edit':
        return this.handleEdit();
      default:
        return {
          handled: true,
          response: `Unknown instructions subcommand: ${subcommand}`,
        };
    }
  }

  /**
   * View custom instructions - read and display the instructions file
   */
  private handleView(): CommandResult {
    const profileName = getActiveProfile();
    const filePath = getProfileInstructionsFile();

    if (!fs.existsSync(filePath)) {
      return {
        handled: true,
        response: `No custom instructions found for profile '${profileName}'.\nUse /instructions edit to create instructions.`,
      };
    }

    try {
      const content = fs.readFileSync(filePath, 'utf-8');

      if (!content.trim()) {
        return {
          handled: true,
          response: `Custom instructions for profile '${profileName}' is empty.\nUse /instructions edit to add instructions.`,
        };
      }

      return {
        handled: true,
        response: `Custom instructions for profile '${profileName}':\n\n${content}`,
      };
    } catch (error) {
      return this.createError(`Failed to read instructions: ${error}`);
    }
  }

  /**
   * Edit custom instructions - open in system default editor
   */
  private handleEdit(): CommandResult {
    const profileName = getActiveProfile();
    const filePath = getProfileInstructionsFile();

    // Create file if it doesn't exist
    if (!fs.existsSync(filePath)) {
      try {
        fs.writeFileSync(filePath, '', 'utf-8');
      } catch (error) {
        return this.createError(`Failed to create instructions file: ${error}`);
      }
    }

    // Open in system default editor based on platform
    try {
      let command: string;
      switch (process.platform) {
        case 'darwin':
          command = `open "${filePath}"`;
          break;
        case 'win32':
          command = `start "" "${filePath}"`;
          break;
        default:
          // Linux and others
          command = `xdg-open "${filePath}"`;
          break;
      }

      execSync(command, { stdio: 'ignore' });

      return this.createResponse(`Opening instructions for profile '${profileName}' in editor...`);
    } catch (error) {
      return this.createError(`Failed to open editor: ${error}`);
    }
  }
}
