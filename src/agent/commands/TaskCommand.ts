/**
 * TaskCommand - Manage background bash processes
 *
 * Provides commands to list and kill background processes started with
 * bash(run_in_background=true).
 */

import { Command } from './Command.js';
import type { Message } from '@shared/index.js';
import type { ServiceRegistry } from '@services/ServiceRegistry.js';
import type { CommandResult } from '../CommandHandler.js';
import type { BashProcessManager } from '@services/BashProcessManager.js';
import { formatDuration } from '../../ui/utils/timeUtils.js';
import { CommandRegistry } from './CommandRegistry.js';
import type { CommandMetadata } from './types.js';

export class TaskCommand extends Command {
  static readonly metadata: CommandMetadata = {
    name: '/task',
    description: 'Manage background tasks',
    helpCategory: 'Tasks',
    subcommands: [
      { name: 'list', description: 'List background tasks' },
      { name: 'kill', description: 'Kill a task', args: '<id>' },
    ],
    useYellowOutput: true,
  };

  static {
    CommandRegistry.register(TaskCommand.metadata);
  }

  readonly name = TaskCommand.metadata.name;
  readonly description = TaskCommand.metadata.description;
  protected readonly useYellowOutput = TaskCommand.metadata.useYellowOutput ?? false;

  async execute(
    args: string[],
    _messages: Message[],
    serviceRegistry: ServiceRegistry
  ): Promise<CommandResult> {
    const argString = args.join(' ').trim();

    // No args → show usage
    if (!argString) {
      return this.showHelp();
    }

    const parts = argString.split(/\s+/);
    const subcommand = parts[0];

    if (!subcommand) {
      return this.showHelp();
    }

    switch (subcommand.toLowerCase()) {
      case 'list':
        return this.handleList(serviceRegistry);

      case 'kill':
        return this.handleKill(parts.slice(1), serviceRegistry);

      default:
        return this.createError(`Unknown subcommand: ${subcommand}\n\n${this.getUsageText()}`);
    }
  }

  /**
   * Show help text
   */
  private showHelp(): CommandResult {
    return {
      handled: true,
      response: this.getUsageText(),
    };
  }

  /**
   * Get usage text
   */
  private getUsageText(): string {
    const meta = TaskCommand.metadata;
    const lines = meta.subcommands!.map(sub => {
      const cmd = sub.args
        ? `${meta.name} ${sub.name} ${sub.args}`
        : `${meta.name} ${sub.name}`;
      return `\`${cmd}\`  ${sub.description}`;
    });

    return `**${meta.helpCategory}**
${lines.join('\n')}

**Examples**
\`/task list\`
\`/task kill shell-1234567890-abc123\``;
  }

  /**
   * Handle /task list - List all running background processes
   */
  private async handleList(serviceRegistry: ServiceRegistry): Promise<CommandResult> {
    const processManager = serviceRegistry.get<BashProcessManager>('bash_process_manager');

    if (!processManager) {
      return this.createError('Background process manager not available');
    }

    const allProcesses = processManager.listProcesses();
    const runningProcesses = allProcesses.filter(p => p.exitCode === null);

    if (runningProcesses.length === 0) {
      return {
        handled: true,
        response: 'No background processes running.',
      };
    }

    let output = `**Background Processes** (${runningProcesses.length} running)\n\n`;
    output += '| # | ID | Command | PID | Running |\n';
    output += '|---|-----|---------|-----|----------|\n';

    const now = Date.now();
    runningProcesses.forEach((proc, index) => {
      const elapsed = formatDuration(now - proc.startTime);
      // Extract meaningful part of shell ID for display
      // Format: shell-1234567890-abc123 → 12345678
      const shortId = proc.id.startsWith('shell-')
        ? proc.id.substring(6, 14) // Show first 8 digits after "shell-"
        : proc.id;

      output += `| ${index + 1} | \`${shortId}\` | ${proc.command} | ${proc.pid} | ${elapsed} |\n`;
    });

    output += '\n---\n\n';
    output += '**Commands**\n';
    output += '`/task kill <full-id>`  Kill a process\n';
    output += '`bash-output(shell_id="<id>")`  Read process output';

    return {
      handled: true,
      response: output,
    };
  }

  /**
   * Handle /task kill - Kill a background process
   */
  private async handleKill(
    args: string[],
    serviceRegistry: ServiceRegistry
  ): Promise<CommandResult> {
    const processManager = serviceRegistry.get<BashProcessManager>('bash_process_manager');

    if (!processManager) {
      return this.createError('Background process manager not available');
    }

    if (args.length === 0) {
      return this.createError('Shell ID required. Usage: /task kill <shell_id>\n\nUse /task list to see running processes.');
    }

    const shellId = args[0]!; // Safe: args.length checked above

    // Get process info before killing
    const processInfo = processManager.getProcess(shellId);

    if (!processInfo) {
      return this.createError(`Background process ${shellId} not found.\n\nUse /task list to see running processes.`);
    }

    // Check if already exited
    if (processInfo.exitCode !== null) {
      return this.createError(
        `Process ${shellId} already exited with code ${processInfo.exitCode}.\n\n` +
        `Use bash-output(shell_id="${shellId}") to read final output.`
      );
    }

    // Kill the process
    const killed = processManager.killProcess(shellId, 'SIGTERM');

    if (!killed) {
      return this.createError(`Failed to kill process ${shellId}`);
    }

    const elapsed = formatDuration(Date.now() - processInfo.startTime);

    return {
      handled: true,
      response: `Killed background process ${shellId}\nCommand: ${processInfo.command}\nRunning time: ${elapsed}`,
    };
  }
}
