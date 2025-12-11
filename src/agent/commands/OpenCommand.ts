/**
 * OpenCommand - Open files in the system default application
 *
 * Opens a file path or URL in the user's default application.
 * When called without arguments, opens the last file the agent touched.
 */

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';
import { Command } from './Command.js';
import type { Message } from '@shared/index.js';
import type { ServiceRegistry } from '@services/ServiceRegistry.js';
import type { CommandResult } from '../CommandHandler.js';
import type { FileInteractionTracker } from '@services/FileInteractionTracker.js';
import { CommandRegistry } from './CommandRegistry.js';
import type { CommandMetadata } from './types.js';

export class OpenCommand extends Command {
  static readonly metadata: CommandMetadata = {
    name: '/open',
    description: 'Open a file or URL in your default application',
    helpCategory: 'Core',
    subcommands: [
      { name: '<path>', description: 'Open file/URL (or last touched file if omitted)' },
    ],
    useYellowOutput: true,
  };

  static {
    CommandRegistry.register(OpenCommand.metadata);
  }

  readonly name = OpenCommand.metadata.name;
  readonly description = OpenCommand.metadata.description;
  protected readonly useYellowOutput = OpenCommand.metadata.useYellowOutput ?? false;

  async execute(
    args: string[],
    _messages: Message[],
    serviceRegistry: ServiceRegistry
  ): Promise<CommandResult> {
    const inputPath = args.join(' ').trim();

    // Determine target: explicit path or last touched file
    let target: string;
    if (inputPath) {
      target = inputPath;
    } else {
      const tracker = serviceRegistry.get<FileInteractionTracker>('file_interaction_tracker');
      const lastTouched = tracker?.getLastTouched();

      if (!lastTouched) {
        return this.createResponse(
          'No file to open. Provide a path or let the agent interact with a file first.\n\n' +
          'Usage: /open <path>'
        );
      }
      target = lastTouched;
    }

    // Resolve path (handles relative paths)
    const resolvedTarget = this.resolveTarget(target);

    // Validate: URLs pass through, files must exist
    if (!this.isUrl(resolvedTarget) && !existsSync(resolvedTarget)) {
      return this.createError(`File not found: ${resolvedTarget}`);
    }

    // Launch in system application
    try {
      await this.launchExternal(resolvedTarget);
      const displayPath = this.formatDisplayPath(resolvedTarget);
      return this.createResponse(`Opened: ${displayPath}`);
    } catch (error) {
      return this.createError(
        `Failed to open: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Resolve a target path to absolute (URLs pass through unchanged)
   */
  private resolveTarget(target: string): string {
    if (this.isUrl(target)) {
      return target;
    }
    return path.isAbsolute(target) ? target : path.resolve(process.cwd(), target);
  }

  /**
   * Check if target is a URL
   */
  private isUrl(target: string): boolean {
    return target.startsWith('http://') || target.startsWith('https://');
  }

  /**
   * Format path for display (use relative if within cwd)
   */
  private formatDisplayPath(target: string): string {
    if (this.isUrl(target)) {
      return target;
    }
    const cwd = process.cwd();
    if (target.startsWith(cwd + path.sep)) {
      return path.relative(cwd, target);
    }
    return target;
  }

  /**
   * Launch target in system default application
   */
  private launchExternal(target: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const command = this.getOpenCommand();
      const args = this.getOpenArgs(target);

      const child = spawn(command, args, {
        detached: process.platform !== 'win32',
        stdio: 'ignore',
      });

      child.on('error', (error) => {
        reject(new Error(`Failed to launch: ${error.message}`));
      });

      // Don't wait for process to exit - resolve after spawn succeeds
      child.unref();

      // Give it a moment to fail on immediate errors
      setTimeout(() => resolve(), 100);
    });
  }

  /**
   * Get platform-specific open command
   */
  private getOpenCommand(): string {
    switch (process.platform) {
      case 'darwin':
        return 'open';
      case 'win32':
        return 'cmd';
      default:
        return 'xdg-open';
    }
  }

  /**
   * Get platform-specific arguments
   */
  private getOpenArgs(target: string): string[] {
    if (process.platform === 'win32') {
      // Windows: cmd /c start "" "target"
      return ['/c', 'start', '""', target];
    }
    return [target];
  }
}
