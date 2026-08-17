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
import { atomicWriteFile } from '../utils/atomicFile.js';
import { migrateRecord, stampVersion, SchemaTooNewError } from '../utils/versionedStore.js';
import { SCHEDULED_TASK_SCHEMA } from '../config/schemas.js';

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
  /**
   * Only literal match kinds exist. There is deliberately no `regex` kind:
   * an allow-rule expressed as a regex is fail-open (`.*` grants everything),
   * and the matcher in TrustManager treats any unrecognized kind as no match.
   */
  match: 'exact' | 'prefix';
  value: string;
};

export interface ScheduledTaskPermissionPolicy {
  allowed_tools?: string[];
  allowed_bash_commands?: ScheduledCommandRule[];
  /** Regex denials are fail-closed (a broken/broad pattern only denies more). */
  denied_bash_patterns?: string[];
}

/**
 * The closed, code-owned set of permission policies a scheduled task may run
 * under. Tasks persist the preset *name*; the grants are re-derived from the
 * code below on every run, so an edited store file or a stale record can never
 * widen what an unattended run is allowed to do. New capabilities are added by
 * adding a preset here — never by letting a caller describe one.
 */
export const POLICY_PRESETS = ['none', 'git_push_only', 'docker_tests'] as const;
export type PolicyPreset = (typeof POLICY_PRESETS)[number];

export function isPolicyPreset(value: unknown): value is PolicyPreset {
  return typeof value === 'string' && (POLICY_PRESETS as readonly string[]).includes(value);
}

/** Resolve a preset name to its grants. Unknown/missing names grant nothing. */
export function presetPolicy(preset: PolicyPreset | undefined): ScheduledTaskPermissionPolicy {
  switch (preset) {
    case 'git_push_only':
      return {
        allowed_bash_commands: [
          { match: 'exact', value: 'git status' },
          { match: 'prefix', value: 'git status ' },
          { match: 'exact', value: 'git rev-parse --is-inside-work-tree' },
          { match: 'prefix', value: 'git rev-parse ' },
          { match: 'prefix', value: 'git branch ' },
          { match: 'prefix', value: 'git log ' },
          { match: 'exact', value: 'git push' },
          { match: 'prefix', value: 'git push ' },
        ],
        denied_bash_patterns: [
          '\\bgit\\s+(add|commit|reset|checkout|clean|merge|rebase|cherry-pick|stash|pull)\\b',
        ],
      };
    case 'docker_tests':
      return {
        allowed_bash_commands: [
          { match: 'exact', value: 'docker info' },
          { match: 'prefix', value: 'docker info ' },
          { match: 'exact', value: 'docker ps' },
          { match: 'prefix', value: 'docker ps ' },
          { match: 'exact', value: 'open -a Docker' },
          { match: 'prefix', value: 'open -a Docker ' },
          { match: 'exact', value: 'systemctl start docker' },
          { match: 'exact', value: 'systemctl --user start docker' },
          { match: 'prefix', value: 'powershell -NoProfile -Command "Start-Process' },
          { match: 'exact', value: 'npm test' },
          { match: 'prefix', value: 'npm test ' },
          { match: 'exact', value: 'npm run test' },
          { match: 'prefix', value: 'npm run test ' },
        ],
        denied_bash_patterns: [
          '\\b(rm|git\\s+commit|git\\s+add|git\\s+reset|git\\s+clean)\\b',
        ],
      };
    case 'none':
    default:
      return {};
  }
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
  /** Name of the code-owned preset this task runs under. Never inline rules. */
  policy_preset: PolicyPreset;
  next_run_at: string;
  last_run_at?: string;
  last_status: ScheduledTaskStatus;
  last_session_id?: string;
  created_at: string;
  updated_at: string;
  history: ScheduledRunRecord[];
}

/**
 * The store no longer carries its own `version` field: `schema_version` (see
 * src/utils/versionedStore.ts) is the single version key, and the v0 -> v1
 * migration in SCHEDULED_TASK_SCHEMA drops the legacy field from old files.
 */
interface ScheduledTaskStore {
  schema_version?: number;
  tasks: ScheduledTask[];
}

interface ScheduledTaskIndexEntry {
  task_id: string;
  project_dir: string;
  profile: string;
}

interface ScheduledTaskIndex {
  schema_version?: number;
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
  policy_preset?: PolicyPreset;
  enabled?: boolean;
  project_dir?: string;
  profile?: string;
}

export interface UpdateScheduledTaskInput {
  title?: string;
  run_prompt?: string;
  schedule?: Partial<CreateScheduledTaskDailySchedule> | Partial<CreateScheduledTaskOnceSchedule>;
  policy_preset?: PolicyPreset;
  enabled?: boolean;
}

export interface ScheduledTaskManagerConfig {
  storeFile?: string;
  indexFile?: string;
  lockFile?: string;
}

const DEFAULT_GRACE_MINUTES = 10;
const MAX_HISTORY = 20;
const LOCK_STALE_MS = 15 * 60 * 1000;
const LOCK_HEARTBEAT_MS = 30 * 1000;

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
  return { tasks: [] };
}

function emptyIndex(): ScheduledTaskIndex {
  return { tasks: [] };
}

/**
 * Strip anything a persisted record may carry that is no longer code-owned.
 *
 * Records written by older builds contain a free-form `permission_policy`
 * object, and a hand-edited store file could contain one too. It is dropped
 * here rather than tolerated: grants come only from `policy_preset`, and an
 * unrecognized preset name degrades to `none` (no grants) instead of throwing.
 */
function sanitizePersistedTask(task: ScheduledTask): ScheduledTask {
  const { permission_policy: _ignoredLegacyPolicy, ...rest } = task as ScheduledTask & {
    permission_policy?: unknown;
  };
  return {
    ...rest,
    policy_preset: isPolicyPreset(rest.policy_preset) ? rest.policy_preset : 'none',
  };
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
      policy_preset: isPolicyPreset(input.policy_preset) ? input.policy_preset : 'none',
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
      ...(isPolicyPreset(input.policy_preset) ? { policy_preset: input.policy_preset } : {}),
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
      // Claim this generation before spawning the worker so an overlapping
      // scheduler tick cannot launch the same due occurrence again.
      enabled: task.schedule.type === 'once' ? false : task.enabled,
      next_run_at: task.schedule.type === 'once'
        ? task.next_run_at
        : computeNextRunAt(task.schedule, new Date(started)),
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
    const owner = `${process.pid}-${Date.now()}-${generateShortId()}`;

    try {
      const handle = await fs.open(effectiveLockPath, 'wx');
      await handle.writeFile(JSON.stringify({ owner, pid: process.pid, created_at: nowIso(), heartbeat_at: nowIso() }));
      await handle.close();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const stale = await this.isLockStale(effectiveLockPath);
      if (!stale) {
        throw new Error('Scheduler is already running');
      }
      await fs.unlink(effectiveLockPath).catch(() => {});
      const handle = await fs.open(effectiveLockPath, 'wx');
      await handle.writeFile(JSON.stringify({ owner, pid: process.pid, created_at: nowIso(), heartbeat_at: nowIso(), recovered_stale: true }));
      await handle.close();
    }

    const heartbeat = setInterval(() => {
      void this.refreshLock(effectiveLockPath, owner);
    }, LOCK_HEARTBEAT_MS);
    heartbeat.unref?.();

    try {
      return await fn();
    } finally {
      clearInterval(heartbeat);
      await this.releaseLock(effectiveLockPath, owner);
    }
  }

  private async isLockStale(lockPath: string): Promise<boolean> {
    try {
      const contents = await fs.readFile(lockPath, 'utf8').catch(() => '');
      const lock = contents ? JSON.parse(contents) as { pid?: number } : {};
      if (typeof lock.pid === 'number' && this.isProcessAlive(lock.pid)) return false;
      const stat = await fs.stat(lockPath);
      return Date.now() - stat.mtimeMs > LOCK_STALE_MS;
    } catch {
      return true;
    }
  }

  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
  }

  private async refreshLock(lockPath: string, owner: string): Promise<void> {
    try {
      const lock = JSON.parse(await fs.readFile(lockPath, 'utf8')) as Record<string, unknown>;
      if (lock.owner !== owner) return;
      await fs.writeFile(lockPath, JSON.stringify({ ...lock, heartbeat_at: nowIso() }), { mode: 0o600 });
    } catch (error) {
      logger.warn('[SCHEDULER] Failed to refresh scheduler lease:', error);
    }
  }

  private async releaseLock(lockPath: string, owner: string): Promise<void> {
    try {
      const lock = JSON.parse(await fs.readFile(lockPath, 'utf8')) as { owner?: string };
      if (lock.owner === owner) await fs.unlink(lockPath);
    } catch {
      // Missing/replaced lock belongs to nobody or another owner; never unlink it.
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
      // Files written before schema versioning (and files carrying the legacy
      // `version: 1` field) read as v0 and are migrated forward with their
      // tasks intact. A file from a newer build throws SchemaTooNewError, which
      // propagates so no caller can follow up with a store-emptying write.
      const parsed = migrateRecord<ScheduledTaskStore>(JSON.parse(raw), SCHEDULED_TASK_SCHEMA);
      if (!Array.isArray(parsed.tasks)) {
        return emptyStore();
      }
      return { ...parsed, tasks: parsed.tasks.map(sanitizePersistedTask) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyStore();
      if (error instanceof SchemaTooNewError) {
        logger.error(`[ScheduledTaskManager] ${error.message}`);
        throw error;
      }
      logger.warn('[ScheduledTaskManager] Failed to load scheduled tasks:', error);
      return emptyStore();
    }
  }

  private async saveStore(projectDir: string, store: ScheduledTaskStore): Promise<void> {
    const file = this.getStoreFile(projectDir);
    await fs.mkdir(dirname(file), { recursive: true });
    await atomicWriteFile(file, JSON.stringify(stampVersion(store, SCHEDULED_TASK_SCHEMA), null, 2));
  }

  private async loadIndex(): Promise<ScheduledTaskIndex> {
    const file = this.getIndexFile();
    try {
      const raw = await fs.readFile(file, 'utf-8');
      const parsed = migrateRecord<ScheduledTaskIndex>(JSON.parse(raw), SCHEDULED_TASK_SCHEMA);
      if (!Array.isArray(parsed.tasks)) {
        return emptyIndex();
      }
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyIndex();
      if (error instanceof SchemaTooNewError) {
        logger.error(`[ScheduledTaskManager] ${error.message}`);
        throw error;
      }
      logger.warn('[ScheduledTaskManager] Failed to load scheduled task index:', error);
      return emptyIndex();
    }
  }

  private async saveIndex(index: ScheduledTaskIndex): Promise<void> {
    const file = this.getIndexFile();
    await fs.mkdir(dirname(file), { recursive: true });
    await atomicWriteFile(file, JSON.stringify(stampVersion(index, SCHEDULED_TASK_SCHEMA), null, 2));
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
