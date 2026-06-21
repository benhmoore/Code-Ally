import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  computeNextRunAt,
  resolveZonedDateTimeToUtc,
  ScheduledTaskManager,
  ScheduledTaskPermissionPolicy,
} from '../ScheduledTaskManager.js';

describe('ScheduledTaskManager', () => {
  let dir: string;
  let manager: ScheduledTaskManager;

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'ally-scheduler-'));
    manager = new ScheduledTaskManager(undefined, {
      storeFile: join(dir, 'scheduled_tasks.json'),
      indexFile: join(dir, 'scheduled_tasks_index.json'),
      lockFile: join(dir, 'scheduler.lock'),
    });
    await manager.initialize();
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('computes the next daily run in the requested timezone', () => {
    expect(computeNextRunAt(
      { type: 'daily', time: '05:00', timezone: 'UTC', grace_minutes: 10 },
      new Date('2026-06-21T04:00:00.000Z'),
    )).toBe('2026-06-21T05:00:00.000Z');

    expect(computeNextRunAt(
      { type: 'daily', time: '05:00', timezone: 'UTC', grace_minutes: 10 },
      new Date('2026-06-21T06:00:00.000Z'),
    )).toBe('2026-06-22T05:00:00.000Z');
  });

  it('uses the exact run_at for one-off schedules', () => {
    expect(computeNextRunAt(
      { type: 'once', run_at: '2026-06-21T12:10:00.000Z', timezone: 'UTC', grace_minutes: 10 },
      new Date('2026-06-21T12:00:00.000Z'),
    )).toBe('2026-06-21T12:10:00.000Z');
  });

  it('converts one-off local wall time in the requested timezone', async () => {
    expect(resolveZonedDateTimeToUtc('2026-06-21', '14:10', 'America/Chicago'))
      .toBe('2026-06-21T19:10:00.000Z');

    const task = await manager.create({
      title: 'Local alert',
      run_prompt: 'Trigger a dialog.',
      schedule: { type: 'once', date: '2026-06-21', time: '14:10', timezone: 'America/Chicago' },
      project_dir: dir,
      profile: 'default',
    });

    expect(task.schedule).toMatchObject({
      type: 'once',
      run_at: '2026-06-21T19:10:00.000Z',
      timezone: 'America/Chicago',
    });
    expect(task.next_run_at).toBe('2026-06-21T19:10:00.000Z');
  });

  it('creates, lists, updates, and deletes project tasks', async () => {
    const policy: ScheduledTaskPermissionPolicy = {
      allowed_bash_commands: [{ match: 'exact', value: 'git push' }],
    };
    const task = await manager.create({
      title: 'Push commits',
      run_prompt: 'Push unpushed commits only.',
      schedule: { type: 'daily', time: '06:00', timezone: 'UTC' },
      permission_policy: policy,
      project_dir: dir,
      profile: 'default',
    });

    expect(task.id).toMatch(/^sched-/);
    expect((await manager.listCurrentProject({ projectDir: dir }))).toHaveLength(1);
    expect((await manager.listAll())).toHaveLength(1);

    const updated = await manager.update(task.id, { enabled: false, title: 'Push if needed' }, dir);
    expect(updated?.enabled).toBe(false);
    expect(updated?.title).toBe('Push if needed');

    expect(await manager.delete(task.id, dir)).toBe(true);
    expect(await manager.listAll()).toHaveLength(0);
  });

  it('returns due tasks inside grace and marks stale missed runs as skipped', async () => {
    const task = await manager.create({
      title: 'Daily tests',
      run_prompt: 'Run tests.',
      schedule: { type: 'daily', time: '05:00', timezone: 'UTC', grace_minutes: 10 },
      project_dir: dir,
      profile: 'default',
    });

    await manager.update(task.id, { schedule: { type: 'daily', time: '05:00', timezone: 'UTC', grace_minutes: 10 } }, dir);
    const storePath = join(dir, 'scheduled_tasks.json');
    const store = JSON.parse(await fs.readFile(storePath, 'utf-8'));
    store.tasks[0].next_run_at = '2026-06-21T05:00:00.000Z';
    await fs.writeFile(storePath, JSON.stringify(store, null, 2));

    const due = await manager.getDueTasks(new Date('2026-06-21T05:05:00.000Z'));
    expect(due[0]?.due).toBe(true);
    expect(due[0]?.skipped).toBe(false);

    const missed = await manager.getDueTasks(new Date('2026-06-21T05:20:00.000Z'));
    expect(missed[0]?.due).toBe(false);
    expect(missed[0]?.skipped).toBe(true);

    const skipped = await manager.markSkipped(missed[0]!.task, 'missed grace window', new Date('2026-06-21T05:20:00.000Z'));
    expect(skipped?.last_status).toBe('skipped');
    expect(skipped?.history[0]?.status).toBe('skipped');
  });

  it('records run start and finish with bounded history fields', async () => {
    const task = await manager.create({
      title: 'Run tests',
      run_prompt: 'Run npm test.',
      schedule: { type: 'daily', time: '05:00', timezone: 'UTC' },
      project_dir: dir,
      profile: 'default',
    });

    await manager.recordRunStart(task.id, 'run-1', 'scheduled-session', dir);
    const finished = await manager.recordRunFinish(task.id, dir, 'run-1', {
      status: 'success',
      sessionId: 'scheduled-session',
      summary: 'ok',
      exitCode: 0,
    });

    expect(finished?.last_status).toBe('success');
    expect(finished?.last_session_id).toBe('scheduled-session');
    expect(finished?.history[0]?.summary).toBe('ok');
  });

  it('removes one-off tasks after they finish', async () => {
    const task = await manager.create({
      title: 'One-time check',
      run_prompt: 'Check once.',
      schedule: { type: 'once', run_at: '2026-06-21T12:10:00.000Z', timezone: 'UTC' },
      project_dir: dir,
      profile: 'default',
    });

    await manager.recordRunStart(task.id, 'run-once', 'scheduled-once', dir);
    const finished = await manager.recordRunFinish(task.id, dir, 'run-once', {
      status: 'success',
      sessionId: 'scheduled-once',
      summary: 'done',
      exitCode: 0,
    });

    expect(finished?.last_status).toBe('success');
    expect(await manager.getTask(task.id, dir)).toBeNull();
    expect(await manager.listAll()).toHaveLength(0);
  });

  it('removes one-off tasks when they are missed and skipped', async () => {
    const task = await manager.create({
      title: 'Missable one-time check',
      run_prompt: 'Check once.',
      schedule: { type: 'once', run_at: '2026-06-21T12:10:00.000Z', timezone: 'UTC', grace_minutes: 5 },
      project_dir: dir,
      profile: 'default',
    });

    const missed = await manager.getDueTasks(new Date('2026-06-21T12:20:01.000Z'));
    expect(missed[0]?.skipped).toBe(true);
    await manager.markSkipped(missed[0]!.task, 'missed grace window', new Date('2026-06-21T12:20:01.000Z'));

    expect(await manager.getTask(task.id, dir)).toBeNull();
    expect(await manager.listAll()).toHaveLength(0);
  });

  it('prevents overlapping global locks', async () => {
    let release!: () => void;
    let ready!: () => void;
    const firstReady = new Promise<void>((resolve) => { ready = resolve; });
    const first = manager.withGlobalLock(() => new Promise<void>((resolve) => {
      release = resolve;
      ready();
    }));
    await firstReady;

    await expect(manager.withGlobalLock(async () => undefined)).rejects.toThrow('already running');
    release();
    await first;

    await expect(manager.withGlobalLock(async () => 'ok')).resolves.toBe('ok');
  });
});
