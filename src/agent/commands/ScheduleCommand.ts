/**
 * ScheduleCommand - Inspect and manage durable scheduled tasks
 */

import { Command } from './Command.js';
import type { Message } from '@shared/index.js';
import type { ServiceRegistry } from '@services/ServiceRegistry.js';
import type { CommandResult } from '../CommandHandler.js';
import { CommandRegistry } from './CommandRegistry.js';
import type { CommandMetadata } from './types.js';
import type { ScheduledTaskManager, ScheduledTask } from '@services/ScheduledTaskManager.js';
import { SchedulerInstaller } from '@services/SchedulerInstaller.js';
import { spawn } from 'child_process';

const SCHEDULED_SESSION_HINT =
  'No active scheduled tasks. Completed one-off runs are saved in session history as `scheduled_<task-id>_<timestamp>` sessions.';

function renderTasks(tasks: ScheduledTask[]): string {
  if (tasks.length === 0) return SCHEDULED_SESSION_HINT;
  return `**Scheduled Tasks** (${tasks.length})\n\n${tasks.map(renderTask).join('\n\n')}`;
}

function renderTask(task: ScheduledTask): string {
  const state = task.enabled ? 'enabled' : 'disabled';
  const last = task.last_run_at
    ? `${task.last_status} ${new Date(task.last_run_at).toLocaleString()}`
    : task.last_status;

  return [
    `**${task.title}**`,
    `ID: \`${task.id}\``,
    `State: ${state}`,
    `Schedule: ${formatSchedule(task)}`,
    `Next: ${new Date(task.next_run_at).toLocaleString()}`,
    `Last: ${last}`,
  ].join('\n');
}

function formatSchedule(task: ScheduledTask): string {
  if (task.schedule.type === 'once') {
    return `once ${formatInstantInTimeZone(task.schedule.run_at, task.schedule.timezone)}`;
  }
  return `daily ${task.schedule.time} ${task.schedule.timezone}`;
}

function formatInstantInTimeZone(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(iso));
}

async function uninstallSchedulerIfIdle(manager: ScheduledTaskManager): Promise<string> {
  if (await manager.countEnabledAll() !== 0) return '';
  try {
    const status = await new SchedulerInstaller().uninstall();
    return `\nScheduler cleanup: uninstalled (${status.platform}) ${status.detail}`;
  } catch (error) {
    return `\nScheduler cleanup failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function appendBounded(buffer: string, chunk: Buffer | string, maxChars: number = 80_000): string {
  const next = buffer + chunk.toString();
  return next.length <= maxChars ? next : next.slice(next.length - maxChars);
}

async function runViaSchedulerCli(taskId: string): Promise<{ exitCode: number | null; output: string }> {
  const scriptPath = process.argv[1];
  if (!scriptPath) throw new Error('Unable to resolve Code Ally entrypoint');
  const child = spawn(process.execPath, [scriptPath, 'scheduler', 'run', taskId], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk) => { stdout = appendBounded(stdout, chunk); });
  child.stderr?.on('data', (chunk) => { stderr = appendBounded(stderr, chunk); });
  const exitCode = await new Promise<number | null>((resolve) => {
    child.on('close', (code) => resolve(code));
    child.on('error', () => resolve(1));
  });
  return { exitCode, output: [stdout.trim(), stderr.trim()].filter(Boolean).join('\n\n') };
}

export class ScheduleCommand extends Command {
  static readonly metadata: CommandMetadata = {
    name: '/schedule',
    description: 'Manage scheduled tasks',
    helpCategory: 'Tasks',
    subcommands: [
      { name: 'list', description: 'List scheduled tasks' },
      { name: 'status', description: 'Show scheduler install status' },
      { name: 'install', description: 'Install the OS scheduler tick job' },
      { name: 'uninstall', description: 'Uninstall the OS scheduler tick job' },
      { name: 'run', description: 'Run a scheduled task now', args: '<id>' },
      { name: 'delete', description: 'Delete a scheduled task', args: '<id>' },
      { name: 'delete-all', description: 'Delete all scheduled tasks for this project' },
    ],
    useYellowOutput: true,
  };

  static {
    CommandRegistry.register(ScheduleCommand.metadata);
  }

  readonly name = ScheduleCommand.metadata.name;
  readonly description = ScheduleCommand.metadata.description;
  protected readonly useYellowOutput = ScheduleCommand.metadata.useYellowOutput ?? false;

  async execute(
    args: string[],
    _messages: Message[],
    serviceRegistry: ServiceRegistry,
  ): Promise<CommandResult> {
    const manager = this.getRequiredService(serviceRegistry, 'scheduled_task_manager', 'Scheduled tasks');
    if ('handled' in manager) return manager;

    const subcommand = (args[0] || 'list').toLowerCase();
    switch (subcommand) {
      case 'list':
        return { handled: true, response: renderTasks(await manager.listCurrentProject()) };
      case 'status':
        return this.handleStatus(manager);
      case 'install':
        return this.handleInstall();
      case 'uninstall':
        return this.handleUninstall();
      case 'run':
        return this.handleRun(manager, args[1]);
      case 'delete':
      case 'remove':
        return this.handleDelete(manager, args[1]);
      case 'delete-all':
      case 'remove-all':
      case 'clear':
        return this.handleDeleteAll(manager);
      default:
        return this.createError(`Unknown schedule subcommand: ${subcommand}`);
    }
  }

  private async handleStatus(manager: ScheduledTaskManager): Promise<CommandResult> {
    const status = await new SchedulerInstaller().status();
    const enabled = (await manager.listCurrentProject()).filter((task) => task.enabled).length;
    return this.createResponse(
      `Scheduler ${status.installed ? 'installed' : 'not installed'} (${status.platform}): ${status.detail}\n` +
      `${enabled} enabled scheduled task${enabled === 1 ? '' : 's'} in this project.`
    );
  }

  private async handleInstall(): Promise<CommandResult> {
    const status = await new SchedulerInstaller().install();
    return this.createResponse(`Scheduler ${status.installed ? 'installed' : 'not installed'} (${status.platform}): ${status.detail}`);
  }

  private async handleUninstall(): Promise<CommandResult> {
    const status = await new SchedulerInstaller().uninstall();
    return this.createResponse(`Scheduler uninstalled (${status.platform}): ${status.detail}`);
  }

  private async handleRun(manager: ScheduledTaskManager, taskId?: string): Promise<CommandResult> {
    if (!taskId) return this.createError('Usage: /schedule run <id>');
    const result = await runViaSchedulerCli(taskId);
    const cleanupMessage = await uninstallSchedulerIfIdle(manager);
    return this.createResponse(
      `Scheduled task ${taskId} finished with exit code ${result.exitCode ?? 'unknown'}${cleanupMessage}.\n${result.output || '(no output)'}`
    );
  }

  private async handleDelete(manager: ScheduledTaskManager, taskId?: string): Promise<CommandResult> {
    if (!taskId) return this.createError('Usage: /schedule delete <id>');
    const removed = await manager.delete(taskId);
    const cleanupMessage = removed ? await uninstallSchedulerIfIdle(manager) : '';
    return removed
      ? this.createResponse(`Deleted scheduled task ${taskId}${cleanupMessage}`)
      : this.createError(`Scheduled task not found: ${taskId}`);
  }

  private async handleDeleteAll(manager: ScheduledTaskManager): Promise<CommandResult> {
    const count = await manager.deleteAllCurrentProject();
    const cleanupMessage = await uninstallSchedulerIfIdle(manager);
    return this.createResponse(`Deleted ${count} scheduled task${count === 1 ? '' : 's'} from this project.${cleanupMessage}`);
  }
}
