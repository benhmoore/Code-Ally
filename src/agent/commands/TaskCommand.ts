/**
 * TaskCommand - Manage background tasks (bash processes and agents)
 *
 * Provides commands to list and kill background tasks started with
 * bash(run_in_background=true) or agent(run_in_background=true).
 */

import { Command } from './Command.js';
import type { Message } from '@shared/index.js';
import type { ServiceRegistry } from '@services/ServiceRegistry.js';
import type { CommandResult } from '../CommandHandler.js';
import type { BashProcessManager } from '@services/BashProcessManager.js';
import type { BackgroundAgentManager } from '@services/BackgroundAgentManager.js';
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
    return this.createResponse(this.getUsageText());
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
\`/task kill shell-1234567890-abc123\`
\`/task kill bg-agent-1234567890-abc123\``;
  }

  /**
   * Handle /task list - List all running background tasks (processes and agents)
   */
  private async handleList(serviceRegistry: ServiceRegistry): Promise<CommandResult> {
    const processManager = serviceRegistry.get<BashProcessManager>('bash_process_manager');
    const agentManager = serviceRegistry.get<BackgroundAgentManager>('background_agent_manager');

    const now = Date.now();
    let output = '';
    let totalRunning = 0;

    // List background shell processes
    if (processManager) {
      const allProcesses = processManager.listProcesses();
      const runningProcesses = allProcesses.filter(p => p.exitCode === null);

      if (runningProcesses.length > 0) {
        totalRunning += runningProcesses.length;
        output += `**Background Shells** (${runningProcesses.length})\n\n`;
        output += '| # | ID | Command | PID | Running |\n';
        output += '|---|-----|---------|-----|----------|\n';

        runningProcesses.forEach((proc, index) => {
          const elapsed = formatDuration(now - proc.startTime);
          const shortId = proc.id.startsWith('shell-')
            ? proc.id.substring(6, 14)
            : proc.id;
          output += `| ${index + 1} | \`${shortId}\` | ${proc.command} | ${proc.pid} | ${elapsed} |\n`;
        });
        output += '\n';
      }
    }

    // List background agents
    if (agentManager) {
      const allAgents = agentManager.listAgents();
      const runningAgents = allAgents.filter(a => a.status === 'executing');

      if (runningAgents.length > 0) {
        totalRunning += runningAgents.length;
        output += `**Background Agents** (${runningAgents.length})\n\n`;
        output += '| # | ID | Type | Task | Running |\n';
        output += '|---|-----|------|------|----------|\n';

        runningAgents.forEach((agent, index) => {
          const elapsed = formatDuration(now - agent.startTime);
          const shortId = agent.id.startsWith('bg-agent-')
            ? agent.id.substring(9, 17)
            : agent.id;
          const taskPreview = agent.taskPrompt.length > 40
            ? agent.taskPrompt.substring(0, 37) + '...'
            : agent.taskPrompt;
          output += `| ${index + 1} | \`${shortId}\` | ${agent.agentType} | ${taskPreview} | ${elapsed} |\n`;
        });
        output += '\n';
      }
    }

    if (totalRunning === 0) {
      return this.createResponse('No background tasks running.');
    }

    output += '---\n\n';
    output += '**Commands**\n';
    output += '`/task kill <full-id>`  Kill a task (use full ID starting with `shell-` or `bg-agent-`)';

    return this.createResponse(output);
  }

  /**
   * Handle /task kill - Kill a background task (process or agent)
   */
  private async handleKill(
    args: string[],
    serviceRegistry: ServiceRegistry
  ): Promise<CommandResult> {
    if (args.length === 0) {
      return this.createError('Task ID required. Usage: /task kill <id>\n\nUse /task list to see running tasks.');
    }

    const taskId = args[0]!;

    // Determine if this is a shell process or background agent by ID prefix
    if (taskId.startsWith('bg-agent-')) {
      return this.killAgent(taskId, serviceRegistry);
    } else {
      return this.killProcess(taskId, serviceRegistry);
    }
  }

  /**
   * Kill a background shell process
   */
  private async killProcess(shellId: string, serviceRegistry: ServiceRegistry): Promise<CommandResult> {
    const processManager = serviceRegistry.get<BashProcessManager>('bash_process_manager');

    if (!processManager) {
      return this.createError('Background process manager not available');
    }

    const processInfo = processManager.getProcess(shellId);

    if (!processInfo) {
      return this.createError(`Background process ${shellId} not found.\n\nUse /task list to see running tasks.`);
    }

    if (processInfo.exitCode !== null) {
      return this.createError(
        `Process ${shellId} already exited with code ${processInfo.exitCode}.\n\n` +
        `Use bash-output(shell_id="${shellId}") to read final output.`
      );
    }

    const killed = processManager.killProcess(shellId, 'SIGTERM');

    if (!killed) {
      return this.createError(`Failed to kill process ${shellId}`);
    }

    const elapsed = formatDuration(Date.now() - processInfo.startTime);

    return this.createResponse(
      `Killed background process ${shellId}\nCommand: ${processInfo.command}\nRunning time: ${elapsed}`
    );
  }

  /**
   * Kill a background agent
   */
  private async killAgent(agentId: string, serviceRegistry: ServiceRegistry): Promise<CommandResult> {
    const agentManager = serviceRegistry.get<BackgroundAgentManager>('background_agent_manager');

    if (!agentManager) {
      return this.createError('Background agent manager not available');
    }

    const agentInfo = agentManager.getAgent(agentId);

    if (!agentInfo) {
      return this.createError(`Background agent ${agentId} not found.\n\nUse /task list to see running tasks.`);
    }

    if (agentInfo.status !== 'executing') {
      return this.createError(
        `Agent ${agentId} is not running (status: ${agentInfo.status}).\n\n` +
        `Use agent-output(agent_id="${agentId}") to read results.`
      );
    }

    const killed = agentManager.killAgent(agentId);

    if (!killed) {
      return this.createError(`Failed to kill agent ${agentId}`);
    }

    const elapsed = formatDuration(Date.now() - agentInfo.startTime);

    return this.createResponse(
      `Killed background agent ${agentId}\nType: ${agentInfo.agentType}\nTask: ${agentInfo.taskPrompt}\nRunning time: ${elapsed}`
    );
  }
}
