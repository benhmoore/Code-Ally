import { describe, expect, it } from 'vitest';
import { ScheduleCommand } from '../commands/ScheduleCommand.js';

describe('ScheduleCommand', () => {
  it('renders scheduled tasks as compact details, not a wide table', async () => {
    const command = new ScheduleCommand();
    const result = await command.execute(['list'], [], {
      get: (name: string) => {
        if (name !== 'scheduled_task_manager') return null;
        return {
          listCurrentProject: async () => [
            {
              id: 'sched-1782068055821-73754010',
              title: 'Start Safari',
              enabled: true,
              project_dir: '/tmp/project',
              profile: 'default',
              schedule: {
                type: 'daily',
                time: '14:00',
                timezone: 'America/Chicago',
                grace_minutes: 10,
              },
              run_prompt: 'Start Safari.',
              policy_preset: 'none',
              next_run_at: '2026-06-22T19:00:00.000Z',
              last_run_at: '2026-06-21T19:00:18.000Z',
              last_status: 'success',
              created_at: '2026-06-21T18:59:00.000Z',
              updated_at: '2026-06-21T19:00:18.000Z',
              history: [],
            },
          ],
        };
      },
    } as any);

    expect(result.response).toContain('**Start Safari**');
    expect(result.response).toContain('ID: `sched-1782068055821-73754010`');
    expect(result.response).toContain('Schedule: daily 14:00 America/Chicago');
    expect(result.response).not.toContain('| ID | Title | State | Schedule | Next | Last |');
    expect(result.metadata).toBeUndefined();
  });
});
