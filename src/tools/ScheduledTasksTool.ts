/**
 * ScheduledTasksTool - Ally-facing management of durable scheduled tasks
 */

import { BaseTool } from './BaseTool.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { FunctionDefinition, ToolResult } from '../types/index.js';
import { ServiceRegistry } from '../services/ServiceRegistry.js';
import {
  getDefaultTimeZone,
  isPolicyPreset,
  POLICY_PRESETS,
  resolveZonedDateTimeToUtc,
  ScheduledTaskManager,
  ScheduledTask,
} from '../services/ScheduledTaskManager.js';
import { SchedulerInstaller } from '../services/SchedulerInstaller.js';
import { ToolCapability } from './ToolCapability.js';
import { spawn } from 'child_process';

const ACTIONS = ['list', 'create', 'update', 'delete', 'delete_all', 'enable', 'disable', 'run_now'] as const;
type ScheduledTaskAction = (typeof ACTIONS)[number];

const SCHEDULED_SESSION_HINT =
  'No active scheduled tasks. Completed one-off runs are saved in session history as `scheduled_<task-id>_<timestamp>` sessions; use the sessions tool to inspect them.';

type ToolScheduleInput = Record<string, any>;
type NormalizedToolScheduleResult =
  | { ok: true; schedule: ToolScheduleInput }
  | { ok: false; error: string };

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

function hasAbsoluteClockCue(args: Record<string, any>): boolean {
  const text = [args.title, args.run_prompt, args.description]
    .filter((value) => typeof value === 'string')
    .join(' ');
  return /\b(today|tomorrow|tonight|morning|afternoon|evening|noon|midnight)\b/i.test(text) ||
    /\b(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)\b/i.test(text);
}

function ensureOneOffNotStale(runAt: Date, schedule: ToolScheduleInput, now: Date): string | null {
  const graceMinutes = Math.max(1, Math.floor(schedule.grace_minutes ?? 10));
  if (runAt.getTime() < now.getTime() - graceMinutes * 60_000) {
    return `One-off schedule time ${runAt.toISOString()} has already passed outside the ${graceMinutes} minute grace window. Ask the user for a future time instead of guessing.`;
  }
  return null;
}

function validateTimeZone(timezone: string): string | null {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
    return null;
  } catch {
    return `Invalid timezone: ${timezone}`;
  }
}

function normalizeToolSchedule(args: Record<string, any>, schedule: ToolScheduleInput, now: Date = new Date()): NormalizedToolScheduleResult {
  if (!schedule || typeof schedule !== 'object') {
    return { ok: false, error: 'schedule must be an object' };
  }

  if (schedule.type !== 'daily' && schedule.type !== 'once') {
    return { ok: false, error: 'Schedule type must be daily or once' };
  }

  const timezone = schedule.timezone || getDefaultTimeZone();
  const timezoneError = validateTimeZone(timezone);
  if (timezoneError) return { ok: false, error: timezoneError };

  if (schedule.type !== 'once') return { ok: true, schedule: { ...schedule, timezone } };

  const hasRunAt = typeof schedule.run_at === 'string' && schedule.run_at.trim().length > 0;
  const hasRunInMinutes = schedule.run_in_minutes !== undefined;
  const hasLocalWallTime = schedule.date !== undefined || schedule.time !== undefined;
  const modes = [hasRunAt, hasRunInMinutes, hasLocalWallTime].filter(Boolean).length;
  if (modes !== 1) {
    return {
      ok: false,
      error: 'One-off schedule requires exactly one timing mode: run_at, run_in_minutes, or date plus time.',
    };
  }

  if (hasRunInMinutes) {
    if (hasAbsoluteClockCue(args)) {
      return {
        ok: false,
        error: 'run_in_minutes is only for relative delays like "in ten minutes". This request mentions an absolute clock time; use schedule.date plus schedule.time in the local timezone instead.',
      };
    }
    const minutes = Number(schedule.run_in_minutes);
    if (!Number.isFinite(minutes) || minutes <= 0) {
      return { ok: false, error: 'run_in_minutes must be a positive number of minutes' };
    }
    const runAt = new Date(now.getTime() + minutes * 60_000);
    return { ok: true, schedule: { ...schedule, run_at: runAt.toISOString(), timezone } };
  }

  if (hasLocalWallTime) {
    if (typeof schedule.date !== 'string' || typeof schedule.time !== 'string') {
      return {
        ok: false,
        error: 'One-off local wall-clock schedules require both date (YYYY-MM-DD) and time (HH:mm).',
      };
    }
    let runAt: Date;
    try {
      runAt = new Date(resolveZonedDateTimeToUtc(schedule.date, schedule.time, timezone));
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    const staleError = ensureOneOffNotStale(runAt, schedule, now);
    if (staleError) return { ok: false, error: staleError };
    return { ok: true, schedule: { ...schedule, run_at: runAt.toISOString(), timezone } };
  }

  const runAt = new Date(schedule.run_at);
  if (Number.isNaN(runAt.getTime())) {
    return { ok: false, error: 'One-off schedule run_at must be a valid ISO datetime' };
  }
  const staleError = ensureOneOffNotStale(runAt, schedule, now);
  if (staleError) return { ok: false, error: staleError };
  return { ok: true, schedule: { ...schedule, run_at: runAt.toISOString(), timezone } };
}

function taskCreatedContent(task: ScheduledTask, installMessage: string): string {
  return `Created scheduled task ${task.id}: ${task.title}\nRuns: ${formatSchedule(task)}${installMessage}`;
}

function taskUpdatedContent(task: ScheduledTask, installMessage: string, cleanupMessage: string): string {
  return `Updated scheduled task ${task.id}: ${task.title}\nRuns: ${formatSchedule(task)}${installMessage}${cleanupMessage}`;
}

async function ensureSchedulerInstalledIfNeeded(enabledBefore: number, enabled: boolean): Promise<string> {
  if (!enabled || enabledBefore !== 0) return '';
  const installer = new SchedulerInstaller();
  try {
    const status = await installer.status();
    if (status.installed) return '';
    const installed = await installer.install();
    return `\nScheduler install: ${installed.installed ? 'installed' : 'not installed'} (${installed.platform}) ${installed.detail}`;
  } catch (error) {
    return `\nScheduler install failed: ${error instanceof Error ? error.message : String(error)}`;
  }
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

export class ScheduledTasksTool extends BaseTool {
  readonly name = 'scheduled-tasks';
  readonly description =
    'List, create, update, delete, enable, disable, and run durable scheduled Ally tasks. ' +
    'Use this when the user asks to schedule recurring or one-off work, inspect scheduled tasks, or remove schedules. ' +
    'This tool lists active schedules, not completed run history. Completed one-off runs are saved as sessions named scheduled_<task-id>_<timestamp>; use the sessions tool to inspect whether a completed scheduled run worked. ' +
    'For one-offs with absolute clock times like "today at 2:10 PM", use type="once" with date="YYYY-MM-DD" and time="HH:mm" in the local timezone; do not calculate UTC offsets yourself. ' +
    'For one-offs like "ten minutes from now", use type="once" with run_in_minutes=10. Do not use run_in_minutes for clock-time requests. ' +
    'If the user says "every morning" without a time, ask for a time before creating the task.';
  /**
   * Persists task definitions into Code-Ally's own state, and `run_now` spawns
   * `process.execPath` to execute a task. ShellExec makes this tool confirmable,
   * which closes a self-escalation loop: a scheduled run that was granted
   * nothing could otherwise create a broader successor task unprompted.
   */
  readonly capabilities = [ToolCapability.AppStateWrite, ToolCapability.ShellExec] as const;
  readonly mainAgentOnly = true;
  readonly displayColor = 'cyan';

  constructor(activityStream: ActivityStream) {
    super(activityStream);
  }

  getFunctionDefinition(): FunctionDefinition {
    return {
      type: 'function',
      function: {
        name: this.name,
        description: this.description,
        parameters: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: [...ACTIONS],
              description: 'Management action to perform.',
            },
            task_id: {
              type: 'string',
              description: 'Scheduled task id for update/delete/enable/disable/run_now.',
            },
            title: {
              type: 'string',
              description: 'Short title for create/update.',
            },
            run_prompt: {
              type: 'string',
              description: 'Full prompt Ally should run unattended each time.',
            },
            schedule: {
              type: 'object',
              description: 'Schedule object. Supports daily { type: "daily", time: "HH:mm", timezone?: "America/Chicago", grace_minutes?: 10 } or one-off { type: "once", date: "YYYY-MM-DD", time: "HH:mm", timezone?: "America/Chicago", grace_minutes?: 10 }, { type: "once", run_at: ISO datetime }, or { type: "once", run_in_minutes: number }. Use run_in_minutes only for relative delays.',
              properties: {
                type: { type: 'string', enum: ['daily', 'once'] },
                time: { type: 'string', description: '24-hour HH:mm time.' },
                date: { type: 'string', description: 'YYYY-MM-DD date for one-off local wall-clock runs.' },
                run_at: { type: 'string', description: 'ISO datetime for a one-off run.' },
                run_in_minutes: { type: 'number', description: 'Relative one-off delay in minutes. Converted to run_at when created.' },
                timezone: { type: 'string', description: 'IANA timezone; defaults to local timezone.' },
                grace_minutes: { type: 'integer', description: 'Late-run grace window before the run is skipped.' },
              },
            },
            enabled: {
              type: 'boolean',
              description: 'Whether the task should be enabled.',
            },
            policy_preset: {
              type: 'string',
              enum: [...POLICY_PRESETS],
              description:
                'Permission preset the unattended run executes under. One of the presets defined in code: ' +
                'none (no permissions), git_push_only, docker_tests. Defaults to none. ' +
                'Presets cannot be described or extended here; a capability that no preset covers requires a new preset in code.',
            },
            all_projects: {
              type: 'boolean',
              description: 'For list only: show all projects instead of the current project/profile.',
            },
          },
          required: ['action'],
        },
      },
    };
  }

  protected async executeImpl(args: any): Promise<ToolResult> {
    this.captureParams(args);
    const action = args.action as ScheduledTaskAction;
    if (!ACTIONS.includes(action)) {
      return this.formatErrorResponse(`Invalid action: ${String(args.action)}`, 'validation_error');
    }

    const registry = ServiceRegistry.getInstance();
    const manager = registry.get('scheduled_task_manager');
    if (!manager) {
      return this.formatErrorResponse('ScheduledTaskManager not available', 'system_error');
    }

    try {
      switch (action) {
        case 'list': {
          const tasks = args.all_projects ? await manager.listAll() : await manager.listCurrentProject();
          return this.formatSuccessResponse({ content: renderTasks(tasks), tasks });
        }

        case 'create': {
          if (!args.title || !args.run_prompt || !args.schedule) {
            return this.formatErrorResponse('create requires title, run_prompt, and schedule', 'validation_error');
          }
          const enabled = args.enabled !== false;
          const enabledBefore = (await manager.listAll()).filter((task) => task.enabled).length;
          const normalizedSchedule = normalizeToolSchedule(args, args.schedule);
          if (!normalizedSchedule.ok) {
            return this.formatErrorResponse(normalizedSchedule.error, 'validation_error');
          }
          const task = await manager.create({
            title: args.title,
            run_prompt: args.run_prompt,
            schedule: normalizedSchedule.schedule as any,
            enabled,
            policy_preset: isPolicyPreset(args.policy_preset) ? args.policy_preset : 'none',
          });
          const installMessage = await ensureSchedulerInstalledIfNeeded(enabledBefore, enabled);
          return this.formatSuccessResponse({
            content: taskCreatedContent(task, installMessage),
            task,
          });
        }

        case 'update': {
          if (!args.task_id) return this.formatErrorResponse('update requires task_id', 'validation_error');
          const enabledBefore = await manager.countEnabledAll();
          const normalizedSchedule = args.schedule ? normalizeToolSchedule(args, args.schedule) : null;
          if (normalizedSchedule && !normalizedSchedule.ok) {
            return this.formatErrorResponse(normalizedSchedule.error, 'validation_error');
          }
          const task = await manager.update(args.task_id, {
            title: args.title,
            run_prompt: args.run_prompt,
            schedule: normalizedSchedule?.schedule as any,
            enabled: args.enabled,
            policy_preset: isPolicyPreset(args.policy_preset) ? args.policy_preset : undefined,
          });
          if (!task) return this.formatErrorResponse(`Scheduled task not found: ${args.task_id}`, 'user_error');
          const installMessage = await ensureSchedulerInstalledIfNeeded(enabledBefore, task.enabled);
          const cleanupMessage = await uninstallSchedulerIfIdle(manager);
          return this.formatSuccessResponse({ content: taskUpdatedContent(task, installMessage, cleanupMessage), task });
        }

        case 'delete': {
          if (!args.task_id) return this.formatErrorResponse('delete requires task_id', 'validation_error');
          const removed = await manager.delete(args.task_id);
          const cleanupMessage = removed ? await uninstallSchedulerIfIdle(manager) : '';
          return removed
            ? this.formatSuccessResponse({ content: `Deleted scheduled task ${args.task_id}${cleanupMessage}` })
            : this.formatErrorResponse(`Scheduled task not found: ${args.task_id}`, 'user_error');
        }

        case 'delete_all': {
          const count = await manager.deleteAllCurrentProject();
          const cleanupMessage = await uninstallSchedulerIfIdle(manager);
          return this.formatSuccessResponse({ content: `Deleted ${count} scheduled task${count === 1 ? '' : 's'} from this project.${cleanupMessage}` });
        }

        case 'enable':
        case 'disable': {
          if (!args.task_id) return this.formatErrorResponse(`${action} requires task_id`, 'validation_error');
          const enabledBefore = await manager.countEnabledAll();
          const task = await manager.update(args.task_id, { enabled: action === 'enable' });
          if (!task) return this.formatErrorResponse(`Scheduled task not found: ${args.task_id}`, 'user_error');
          const installMessage = await ensureSchedulerInstalledIfNeeded(enabledBefore, task.enabled);
          const cleanupMessage = await uninstallSchedulerIfIdle(manager);
          return this.formatSuccessResponse({ content: `${action === 'enable' ? 'Enabled' : 'Disabled'} scheduled task ${task.id}${installMessage}${cleanupMessage}`, task });
        }

        case 'run_now': {
          if (!args.task_id) return this.formatErrorResponse('run_now requires task_id', 'validation_error');
          const result = await runViaSchedulerCli(args.task_id);
          const cleanupMessage = await uninstallSchedulerIfIdle(manager);
          return this.formatSuccessResponse({
            content: `Scheduled task ${args.task_id} finished with exit code ${result.exitCode ?? 'unknown'}${cleanupMessage}.\n${result.output || '(no output)'}`,
            task_id: args.task_id,
            exit_code: result.exitCode,
          });
        }
      }
    } catch (error) {
      return this.formatErrorResponse(error instanceof Error ? error.message : String(error), 'system_error');
    }
  }

  formatSubtext(args: Record<string, any>): string | null {
    return args.action ? String(args.action) : null;
  }
}
