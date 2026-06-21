/**
 * ScheduledTaskManager - Durable project-scoped scheduled Ally runs
 *
 * Scheduled tasks are persisted outside the repo under ~/.ally/projects/<key>.
 * A small global index under ~/.ally lets `ally scheduler tick` discover all
 * enabled tasks without scanning every project store.
 */

import { promises as fs } from 'fs';
import { dirname } from 'path';
import {
  getActiveProfile,
  getProjectScheduledTasksFile,
  getScheduledTasksIndexFile,
  getSchedulerLockFile,
} from '../config/paths.js';
import { ActivityEventType, IService } from '../types/index.js';
import type { ActivityStream } from './ActivityStream.js';
import { generateShortId } from '../utils/id.js';
import { logger } from './Logger.js';

export type ScheduledTaskStatus = 'never_run' | 'running' | 'success' | 'error' | 'skipped';
export type ScheduledTaskRunStatus = 'running' | 'success' | 'error' | 'skipped';
export type ScheduledTaskDailySchedule = {
  type: 'daily';
  /** 24-hour local wall time, HH:mm */
  time: string;
  /** IANA time zone. Defaults to the user's current time zone. */
  timezone: string;
  /** Due grace window. Late runs outside this window are skipped. */
  grace_minutes?: number;
};
export type ScheduledTaskOnceSchedule = {
  type: 'once';
  /** Absolute run time. Stored as ISO 8601 UTC. */
  run_at: string;
  /** IANA time zone for display/context. Defaults to the user's current time zone. */
  timezone: string;
  /** Due grace window. Late runs outside this window are skipped and removed. */
  grace_minutes?: number;
};
export type ScheduledTaskSchedule = ScheduledTaskDailySchedule | ScheduledTaskOnceSchedule;
export type CreateScheduledTaskDailySchedule = {
  type: 'daily';
  /** 24-hour local wall time, HH:mm */
  time: string;
  timezone?: string;
  grace_minutes?: number;
};
export type CreateScheduledTaskOnceSchedule = {
  type: 'once';
  /** Absolute ISO datetime. */
  run_at?: string;
  /** Local calendar date, YYYY-MM-DD, interpreted in timezone. */
  date?: string;
  /** 24-hour local wall time, HH:mm, interpreted in timezone. */
  time?: string;
  timezone?: string;
  grace_minutes?: number;
};

export type ScheduledCommandRule = {
  match: 'exact' | 'prefix' | 'regex';
  value: string;
};

export interface ScheduledTaskPermissionPolicy {
  allowed_tools?: string[];
  allowed_bash_commands?: ScheduledCommandRule[];
  denied_bash_patterns?: string[];
}

export interface ScheduledRunRecord {
  run_id: string;
  started_at: string;
  finished_at?: string;
  status: ScheduledTaskRunStatus;
  session_id?: string;
  summary?: string;
  exit_code?: number | null;
}

export interface ScheduledTask {
  id: string;
  title: string;
  enabled: boolean;
  project_dir: string;
  profile: string;
  schedule: ScheduledTaskSchedule;
  run_prompt: string;
  permission_policy: ScheduledTaskPermissionPolicy;
  next_run_at: string;
  last_run_at?: string;
  last_status: ScheduledTaskStatus;
  last_session_id?: string;
  created_at: string;
  updated_at: string;
  history: ScheduledRunRecord[];
}

interface ScheduledTaskStore {
  version: 1;
  tasks: ScheduledTask[];
}

interface ScheduledTaskIndexEntry {
  task_id: string;
  project_dir: string;
  profile: string;
}

interface ScheduledTaskIndex {
  version: 1;
  tasks: ScheduledTaskIndexEntry[];
}

export interface DueScheduledTask {
  task: ScheduledTask;
  due: boolean;
  skipped: boolean;
  reason?: string;
}

export interface CreateScheduledTaskInput {
  title: string;
  run_prompt: string;
  schedule: CreateScheduledTaskDailySchedule | CreateScheduledTaskOnceSchedule;
  permission_policy?: ScheduledTaskPermissionPolicy;
  enabled?: boolean;
  project_dir?: string;
  profile?: string;
}

export interface UpdateScheduledTaskInput {
  title?: string;
  run_prompt?: string;
  schedule?: Partial<CreateScheduledTaskDailySchedule> | Partial<CreateScheduledTaskOnceSchedule>;
  permission_policy?: ScheduledTaskPermissionPolicy;
  enabled?: boolean;
}

export interface ScheduledTaskManagerConfig {
  storeFile?: string;
  indexFile?: string;
  lockFile?: string;
}

const STORE_VERSION = 1 as const;
const DEFAULT_GRACE_MINUTES = 10;
const MAX_HISTORY = 20;
const LOCK_STALE_MS = 15 * 60 * 1000;

function nowIso(): string {
  return new Date().toISOString();
}

export function getDefaultTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

function validateDailyTime(time: string): void {
  if (!/^\d{2}:\d{2}$/.test(time)) {
    throw new Error('Schedule time must use HH:mm in 24-hour format');
  }
  const [hour, minute] = time.split(':').map(Number);
  if (hour == null || minute == null || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new Error('Schedule time must be a valid 24-hour time');
  }
}

function parseWallTime(time: string): { hour: number; minute: number } {
  validateDailyTime(time);
  const [hour, minute] = time.split(':').map(Number) as [number, number];
  return { hour, minute };
}

function parseLocalDate(date: string): { year: number; month: number; day: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) {
    throw new Error('One-off schedule date must use YYYY-MM-DD format');
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const normalized = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  if (
    normalized.getUTCFullYear() !== year ||
    normalized.getUTCMonth() + 1 !== month ||
    normalized.getUTCDate() !== day
  ) {
    throw new Error('One-off schedule date must be a valid calendar date');
  }

  return { year, month, day };
}

function normalizeSchedule(schedule: CreateScheduledTaskInput['schedule'] | ScheduledTaskSchedule): ScheduledTaskSchedule {
  if (schedule.type === 'daily') {
    validateDailyTime(schedule.time);
    return {
      type: 'daily',
      time: schedule.time,
      timezone: schedule.timezone || getDefaultTimeZone(),
      grace_minutes: Math.max(1, Math.floor(schedule.grace_minutes ?? DEFAULT_GRACE_MINUTES)),
    };
  }

  if (schedule.type === 'once') {
    const timezone = schedule.timezone || getDefaultTimeZone();
    let runAt: Date | null = null;

    if (schedule.run_at) {
      runAt = new Date(schedule.run_at);
      if (Number.isNaN(runAt.getTime())) {
        throw new Error('One-off schedule run_at must be a valid ISO datetime');
      }
    } else if ('date' in schedule || 'time' in schedule) {
      if (!schedule.date || !schedule.time) {
        throw new Error('One-off schedule with local wall time requires both date and time');
      }
      runAt = new Date(resolveZonedDateTimeToUtc(schedule.date, schedule.time, timezone));
    }

    if (!runAt) throw new Error('One-off schedule requires run_at or date plus time');

    return {
      type: 'once',
      run_at: runAt.toISOString(),
      timezone,
      grace_minutes: Math.max(1, Math.floor(schedule.grace_minutes ?? DEFAULT_GRACE_MINUTES)),
    };
  }

  throw new Error('Schedule type must be daily or once');
}

function mergeScheduleUpdate(current: ScheduledTaskSchedule, update: UpdateScheduledTaskInput['schedule']): ScheduledTaskSchedule {
  if (!update) return current;
  if (update.type && update.type !== current.type) {
    if (update.type === 'daily' && typeof update.time !== 'string') {
      throw new Error('Changing a schedule to daily requires time');
    }
    if (
      update.type === 'once' &&
      typeof update.run_at !== 'string' &&
      !(typeof update.date === 'string' && typeof update.time === 'string')
    ) {
      throw new Error('Changing a schedule to once requires run_at or date plus time');
    }
    return normalizeSchedule(update as CreateScheduledTaskInput['schedule']);
  }

  if (current.type === 'daily') {
    return normalizeSchedule({ ...current, ...update, type: 'daily' } as CreateScheduledTaskInput['schedule']);
  }
  const merged = { ...current, ...update, type: 'once' } as CreateScheduledTaskOnceSchedule;
  if (('date' in update && update.date) || ('time' in update && update.time)) {
    delete merged.run_at;
  }
  return normalizeSchedule(merged);
}

function getZonedParts(date: Date, timeZone: string): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);

  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const hourRaw = Number(byType.hour);
  return {
    year: Number(byType.year),
    month: Number(byType.month),
    day: Number(byType.day),
    hour: hourRaw === 24 ? 0 : hourRaw,
    minute: Number(byType.minute),
    second: Number(byType.second),
  };
}

function getTimeZoneOffsetMs(date: Date, timeZone: string): number {
  const parts = getZonedParts(date, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - date.getTime();
}

function zonedTimeToUtc(parts: { year: number; month: number; day: number; hour: number; minute: number }, timeZone: string): Date {
  const utcGuess = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0);
  const offset = getTimeZoneOffsetMs(new Date(utcGuess), timeZone);
  return new Date(utcGuess - offset);
}

export function resolveZonedDateTimeToUtc(date: string, time: string, timeZone: string): string {
  const { year, month, day } = parseLocalDate(date);
  const { hour, minute } = parseWallTime(time);
  return zonedTimeToUtc({ year, month, day, hour, minute }, timeZone).toISOString();
}

function addDays(parts: { year: number; month: number; day: number }, days: number): { year: number; month: number; day: number } {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days, 12, 0, 0));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

export function computeNextRunAt(schedule: ScheduledTaskSchedule, from: Date = new Date()): string {
  const normalized = normalizeSchedule(schedule);
  if (normalized.type === 'once') {
    return new Date(normalized.run_at).toISOString();
  }

  const [hour, minute] = normalized.time.split(':').map(Number) as [number, number];
  const zonedNow = getZonedParts(from, normalized.timezone);
  let day = { year: zonedNow.year, month: zonedNow.month, day: zonedNow.day };
  let candidate = zonedTimeToUtc({ ...day, hour, minute }, normalized.timezone);

  if (candidate.getTime() <= from.getTime()) {
    day = addDays(day, 1);
    candidate = zonedTimeToUtc({ ...day, hour, minute }, normalized.timezone);
  }

  return candidate.toISOString();
}

function emptyStore(): ScheduledTaskStore {
  return { version: STORE_VERSION, tasks: [] };
}

function emptyIndex(): ScheduledTaskIndex {
  return { version: STORE_VERSION, tasks: [] };
}

function conciseOutput(output: string, maxChars: number = 4000): string {
  const trimmed = output.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars)}\n...`;
}

export class ScheduledTaskManager implements IService {
  constructor(
    private readonly activityStream?: ActivityStream,
    private readonly config: ScheduledTaskManagerConfig = {},
  ) {}

  async initialize(): Promise<void> {
    await fs.mkdir(dirname(this.getStoreFile()), { recursive: true });
    await fs.mkdir(dirname(this.getIndexFile()), { recursive: true });
    await fs.mkdir(dirname(this.config.lockFile ?? getSchedulerLockFile()), { recursive: true });
  }

  async cleanup(): Promise<void> {}

  async create(input: CreateScheduledTaskInput): Promise<ScheduledTask> {
    if (!input.title?.trim()) throw new Error('Scheduled task title is required');
    if (!input.run_prompt?.trim()) throw new Error('Scheduled task prompt is required');

    const projectDir = input.project_dir || process.cwd();
    const profile = input.profile || getActiveProfile();
    const schedule = normalizeSchedule(input.schedule);
    const timestamp = nowIso();
    const task: ScheduledTask = {
      id: `sched-${Date.now()}-${generateShortId()}`,
      title: input.title.trim(),
      enabled: input.enabled ?? true,
      project_dir: projectDir,
      profile,
      schedule,
      run_prompt: input.run_prompt.trim(),
      permission_policy: input.permission_policy ?? {},
      next_run_at: computeNextRunAt(schedule),
      last_status: 'never_run',
      created_at: timestamp,
      updated_at: timestamp,
      history: [],
    };

    const store = await this.loadStore(projectDir);
    store.tasks.push(task);
    await this.saveStore(projectDir, store);
    await this.upsertIndex(task);
    this.emitUpdated();
    return task;
  }

  async update(taskId: string, input: UpdateScheduledTaskInput, projectDir: string = process.cwd()): Promise<ScheduledTask | null> {
    const store = await this.loadStore(projectDir);
    const index = store.tasks.findIndex((task) => task.id === taskId);
    if (index === -1) return null;

    const current = store.tasks[index]!;
    const schedule = mergeScheduleUpdate(current.schedule, input.schedule);
    const updated: ScheduledTask = {
      ...current,
      ...(input.title !== undefined ? { title: input.title.trim() } : {}),
      ...(input.run_prompt !== undefined ? { run_prompt: input.run_prompt.trim() } : {}),
      ...(input.permission_policy !== undefined ? { permission_policy: input.permission_policy } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      schedule,
      next_run_at: input.schedule || input.enabled === true ? computeNextRunAt(schedule) : current.next_run_at,
      updated_at: nowIso(),
    };

    store.tasks[index] = updated;
    await this.saveStore(projectDir, store);
    await this.upsertIndex(updated);
    this.emitUpdated();
    return updated;
  }

  async delete(taskId: string, projectDir: string = process.cwd()): Promise<boolean> {
    const store = await this.loadStore(projectDir);
    const next = store.tasks.filter((task) => task.id !== taskId);
    if (next.length === store.tasks.length) return false;
    await this.saveStore(projectDir, { ...store, tasks: next });
    await this.removeFromIndex(taskId);
    this.emitUpdated();
    return true;
  }

  async deleteAllCurrentProject(projectDir: string = process.cwd(), profile: string = getActiveProfile()): Promise<number> {
    const store = await this.loadStore(projectDir);
    const removed = store.tasks.filter((task) => task.profile === profile);
    if (removed.length === 0) return 0;
    const remaining = store.tasks.filter((task) => task.profile !== profile);
    await this.saveStore(projectDir, { ...store, tasks: remaining });
    for (const task of removed) {
      await this.removeFromIndex(task.id);
    }
    this.emitUpdated();
    return removed.length;
  }

  async listCurrentProject(opts: { projectDir?: string; profile?: string; allProfiles?: boolean } = {}): Promise<ScheduledTask[]> {
    const projectDir = opts.projectDir || process.cwd();
    const store = await this.loadStore(projectDir);
    const profile = opts.profile || getActiveProfile();
    return store.tasks
      .filter((task) => opts.allProfiles || task.profile === profile)
      .sort((a, b) => a.next_run_at.localeCompare(b.next_run_at));
  }

  async listAll(): Promise<ScheduledTask[]> {
    const index = await this.loadIndex();
    const tasks: ScheduledTask[] = [];
    const staleIds: string[] = [];

    for (const entry of index.tasks) {
      const task = await this.getTask(entry.task_id, entry.project_dir);
      if (task) {
        tasks.push(task);
      } else {
        staleIds.push(entry.task_id);
      }
    }

    for (const staleId of staleIds) {
      await this.removeFromIndex(staleId);
    }

    return tasks.sort((a, b) => a.next_run_at.localeCompare(b.next_run_at));
  }

  async countEnabledAll(): Promise<number> {
    return (await this.listAll()).filter((task) => task.enabled).length;
  }

  async getTask(taskId: string, projectDir: string = process.cwd()): Promise<ScheduledTask | null> {
    const store = await this.loadStore(projectDir);
    return store.tasks.find((task) => task.id === taskId) ?? null;
  }

  async findTask(taskId: string): Promise<ScheduledTask | null> {
    const index = await this.loadIndex();
    const entry = index.tasks.find((item) => item.task_id === taskId);
    if (!entry) return this.getTask(taskId);
    return this.getTask(taskId, entry.project_dir);
  }

  async getDueTasks(now: Date = new Date()): Promise<DueScheduledTask[]> {
    const tasks = (await this.listAll()).filter((task) => task.enabled);
    return tasks
      .filter((task) => new Date(task.next_run_at).getTime() <= now.getTime())
      .map((task) => {
        const graceMs = (task.schedule.grace_minutes ?? DEFAULT_GRACE_MINUTES) * 60 * 1000;
        const lateness = now.getTime() - new Date(task.next_run_at).getTime();
        if (lateness > graceMs) {
          return { task, due: false, skipped: true, reason: 'missed grace window' };
        }
        return { task, due: true, skipped: false };
      });
  }

  async recordRunStart(taskId: string, runId: string, sessionId: string, projectDir: string): Promise<ScheduledTask | null> {
    const task = await this.getTask(taskId, projectDir);
    if (!task) return null;
    const started = nowIso();
    return this.replaceTask(projectDir, {
      ...task,
      last_run_at: started,
      last_status: 'running',
      last_session_id: sessionId,
      updated_at: started,
      history: this.pushHistory(task.history, {
        run_id: runId,
        started_at: started,
        status: 'running',
        session_id: sessionId,
      }),
    });
  }

  async recordRunFinish(
    taskId: string,
    projectDir: string,
    runId: string,
    result: { status: 'success' | 'error'; sessionId: string; summary: string; exitCode: number | null },
  ): Promise<ScheduledTask | null> {
    const task = await this.getTask(taskId, projectDir);
    if (!task) return null;
    const finished = nowIso();
    const history = task.history.map((record) =>
      record.run_id === runId
        ? {
            ...record,
            finished_at: finished,
            status: result.status,
            session_id: result.sessionId,
            summary: conciseOutput(result.summary),
            exit_code: result.exitCode,
          }
        : record,
    );
    const updated = await this.replaceTask(projectDir, {
      ...task,
      last_run_at: finished,
      last_status: result.status,
      last_session_id: result.sessionId,
      next_run_at: task.schedule.type === 'once'
        ? task.next_run_at
        : computeNextRunAt(task.schedule, new Date(finished)),
      updated_at: finished,
      history,
    });
    if (task.schedule.type === 'once') {
      await this.delete(task.id, projectDir);
    }
    return updated;
  }

  async markSkipped(task: ScheduledTask, reason: string, now: Date = new Date()): Promise<ScheduledTask | null> {
    const skippedAt = now.toISOString();
    const updated = await this.replaceTask(task.project_dir, {
      ...task,
      last_run_at: skippedAt,
      last_status: 'skipped',
      next_run_at: task.schedule.type === 'once'
        ? task.next_run_at
        : computeNextRunAt(task.schedule, now),
      updated_at: skippedAt,
      history: this.pushHistory(task.history, {
        run_id: `skip-${Date.now()}-${generateShortId()}`,
        started_at: skippedAt,
        finished_at: skippedAt,
        status: 'skipped',
        summary: reason,
      }),
    });
    if (task.schedule.type === 'once') {
      await this.delete(task.id, task.project_dir);
    }
    return updated;
  }

  async withGlobalLock<T>(fn: () => Promise<T>): Promise<T> {
    const lockPath = getSchedulerLockFile();
    const effectiveLockPath = this.config.lockFile ?? lockPath;
    await fs.mkdir(dirname(effectiveLockPath), { recursive: true });
    let handle: fs.FileHandle | null = null;

    try {
      handle = await fs.open(effectiveLockPath, 'wx');
      await handle.writeFile(JSON.stringify({ pid: process.pid, created_at: nowIso() }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const stale = await this.isLockStale(effectiveLockPath);
      if (!stale) {
        throw new Error('Scheduler is already running');
      }
      await fs.unlink(effectiveLockPath).catch(() => {});
      handle = await fs.open(effectiveLockPath, 'wx');
      await handle.writeFile(JSON.stringify({ pid: process.pid, created_at: nowIso(), recovered_stale: true }));
    }

    try {
      return await fn();
    } finally {
      await handle?.close().catch(() => {});
      await fs.unlink(effectiveLockPath).catch(() => {});
    }
  }

  private async isLockStale(lockPath: string): Promise<boolean> {
    try {
      const stat = await fs.stat(lockPath);
      return Date.now() - stat.mtimeMs > LOCK_STALE_MS;
    } catch {
      return true;
    }
  }

  private pushHistory(history: ScheduledRunRecord[], record: ScheduledRunRecord): ScheduledRunRecord[] {
    return [record, ...history].slice(0, MAX_HISTORY);
  }

  private async replaceTask(projectDir: string, task: ScheduledTask): Promise<ScheduledTask> {
    const store = await this.loadStore(projectDir);
    const index = store.tasks.findIndex((item) => item.id === task.id);
    if (index === -1) {
      store.tasks.push(task);
    } else {
      store.tasks[index] = task;
    }
    await this.saveStore(projectDir, store);
    await this.upsertIndex(task);
    this.emitUpdated();
    return task;
  }

  private async loadStore(projectDir: string = process.cwd()): Promise<ScheduledTaskStore> {
    const file = this.getStoreFile(projectDir);
    try {
      const raw = await fs.readFile(file, 'utf-8');
      const parsed = JSON.parse(raw) as ScheduledTaskStore;
      if (parsed.version !== STORE_VERSION || !Array.isArray(parsed.tasks)) {
        return emptyStore();
      }
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyStore();
      logger.warn('[ScheduledTaskManager] Failed to load scheduled tasks:', error);
      return emptyStore();
    }
  }

  private async saveStore(projectDir: string, store: ScheduledTaskStore): Promise<void> {
    const file = this.getStoreFile(projectDir);
    await fs.mkdir(dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(store, null, 2), 'utf-8');
  }

  private async loadIndex(): Promise<ScheduledTaskIndex> {
    const file = this.getIndexFile();
    try {
      const raw = await fs.readFile(file, 'utf-8');
      const parsed = JSON.parse(raw) as ScheduledTaskIndex;
      if (parsed.version !== STORE_VERSION || !Array.isArray(parsed.tasks)) {
        return emptyIndex();
      }
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyIndex();
      logger.warn('[ScheduledTaskManager] Failed to load scheduled task index:', error);
      return emptyIndex();
    }
  }

  private async saveIndex(index: ScheduledTaskIndex): Promise<void> {
    const file = this.getIndexFile();
    await fs.mkdir(dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(index, null, 2), 'utf-8');
  }

  private async upsertIndex(task: ScheduledTask): Promise<void> {
    const index = await this.loadIndex();
    const without = index.tasks.filter((entry) => entry.task_id !== task.id);
    without.push({ task_id: task.id, project_dir: task.project_dir, profile: task.profile });
    await this.saveIndex({ ...index, tasks: without });
  }

  private async removeFromIndex(taskId: string): Promise<void> {
    const index = await this.loadIndex();
    const tasks = index.tasks.filter((entry) => entry.task_id !== taskId);
    if (tasks.length !== index.tasks.length) {
      await this.saveIndex({ ...index, tasks });
    }
  }

  private emitUpdated(): void {
    this.activityStream?.emit({
      id: `scheduled_tasks_${Date.now()}`,
      type: ActivityEventType.SCHEDULED_TASKS_UPDATED,
      timestamp: Date.now(),
      data: {},
    });
  }

  private getStoreFile(projectDir: string = process.cwd()): string {
    return this.config.storeFile ?? getProjectScheduledTasksFile(projectDir);
  }

  private getIndexFile(): string {
    return this.config.indexFile ?? getScheduledTasksIndexFile();
  }
}
