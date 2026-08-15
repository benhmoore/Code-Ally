import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ActivityStream } from '../../services/ActivityStream.js';
import { ScheduledTaskManager } from '../../services/ScheduledTaskManager.js';
import { ServiceRegistry } from '../../services/ServiceRegistry.js';
import { ScheduledTasksTool } from '../ScheduledTasksTool.js';

describe('ScheduledTasksTool', () => {
  let dir: string;
  let manager: ScheduledTaskManager;
  let tool: ScheduledTasksTool;

  beforeEach(async () => {
    await ServiceRegistry.getInstance().shutdown();
    dir = await fs.mkdtemp(join(tmpdir(), 'ally-scheduled-tool-'));
    manager = new ScheduledTaskManager(undefined, {
      storeFile: join(dir, 'scheduled_tasks.json'),
      indexFile: join(dir, 'scheduled_tasks_index.json'),
      lockFile: join(dir, 'scheduler.lock'),
    });
    await manager.initialize();
    ServiceRegistry.getInstance().registerInstance('scheduled_task_manager', manager);
    tool = new ScheduledTasksTool(new ActivityStream());
  });

  afterEach(async () => {
    vi.useRealTimers();
    await ServiceRegistry.getInstance().shutdown();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('creates one-off tasks from local wall-clock date and time', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const result = await tool.execute({
      action: 'create',
      title: 'Alert at 2:10 PM',
      run_prompt: 'Trigger an alert dialog.',
      schedule: {
        type: 'once',
        date: '2026-06-22',
        time: '14:10',
        timezone: 'America/Chicago',
      },
      enabled: false,
    });

    expect(result.success).toBe(true);
    expect(result.content).toContain('Runs: once Jun 22, 2026, 2:10 PM CDT');
    expect(result.task.schedule.run_at).toBe('2026-06-22T19:10:00.000Z');
    expect(result.task.schedule.timezone).toBe('America/Chicago');
  });

  it('rejects relative delays when the request contains an absolute clock time', async () => {
    const result = await tool.execute({
      action: 'create',
      title: 'Alert at 2:10 PM',
      run_prompt: 'Trigger an alert dialog at 2:10 PM today.',
      schedule: {
        type: 'once',
        run_in_minutes: 1440,
        timezone: 'America/New_York',
      },
      enabled: false,
      description: 'Schedule alert for 2:10 PM',
    });

    expect(result.success).toBe(false);
    expect(result.error_type).toBe('validation_error');
    expect(result.error).toContain('run_in_minutes is only for relative delays');
    expect(await manager.listAll()).toHaveLength(0);
  });

  it('points empty active schedule lists to scheduled session history', async () => {
    const result = await tool.execute({ action: 'list' });

    expect(result.success).toBe(true);
    expect(result.content).toContain('No active scheduled tasks');
    expect(result.content).toContain('scheduled_<task-id>_<timestamp>');
    expect(result.content).toContain('sessions tool');
  });
});
