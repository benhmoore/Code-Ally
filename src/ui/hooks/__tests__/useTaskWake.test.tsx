import React from 'react';
import { EventEmitter } from 'node:events';
import { render } from 'ink';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActivityStream } from '@services/ActivityStream.js';
import { BackgroundTaskRegistry } from '@services/BackgroundTaskRegistry.js';
import { ServiceRegistry } from '@services/ServiceRegistry.js';
import { ActivityEventType } from '@shared/index.js';
import { ActivityProvider } from '../../contexts/ActivityContext.js';
import { useTaskWake } from '../useTaskWake.js';

class FakeStdout extends EventEmitter {
  columns = 100;
  rows = 30;
  isTTY = true;
  write = (): boolean => true;
}

const mounted: Array<{ unmount: () => void }> = [];

afterEach(() => {
  for (const instance of mounted.splice(0)) instance.unmount();
  const registry = ServiceRegistry.getInstance() as any;
  registry._services.clear();
  registry._descriptors.clear();
});

function setup() {
  const task = {
    id: 'agent-review', agentType: 'review', mode: 'background', status: 'done',
    startTime: 1, endTime: 2, result: 'important findings', error: null, consumed: false,
  };
  const manager = {
    listTasks: () => [task],
    drainCompletedResults: vi.fn(() => {
      if (task.consumed) return [];
      task.consumed = true;
      return [task];
    }),
    acknowledgeCompletedResults: vi.fn(() => { task.consumed = true; }),
  };
  const taskRegistry = new BackgroundTaskRegistry(
    manager as any,
    { listProcesses: () => [] } as any,
    { emit: vi.fn() } as any,
  );
  taskRegistry.markWatched(task.id);
  ServiceRegistry.getInstance().registerInstance('background_task_registry', taskRegistry);
  const activityStream = new ActivityStream();
  const submit = vi.fn();

  const Harness = () => {
    useTaskWake({ isThinking: false, activeAgentId: 'main', submit });
    return null;
  };
  const instance = render(
    <ActivityProvider activityStream={activityStream}><Harness /></ActivityProvider>,
    {
      stdout: new FakeStdout() as unknown as NodeJS.WriteStream,
      debug: true,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  );
  mounted.push(instance);
  return { activityStream, manager, submit, task, taskRegistry };
}

describe('useTaskWake', () => {
  it('coalesces duplicate completion events and acknowledges actual delivery', async () => {
    const { activityStream, manager, submit, task, taskRegistry } = setup();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const event = {
      id: 'complete', type: ActivityEventType.AGENT_BACKGROUND_COMPLETE,
      timestamp: Date.now(), data: { taskId: task.id },
    };

    activityStream.emit(event);
    activityStream.emit({ ...event, id: 'duplicate' });
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(submit).toHaveBeenCalledOnce();
    expect(submit).toHaveBeenCalledWith(expect.stringContaining('important findings'));
    expect(manager.acknowledgeCompletedResults).toHaveBeenCalledWith([task.id]);
    expect(taskRegistry.isWatched(task.id)).toBe(false);
  });

  it('drops a queued UI wake after synchronous delivery claims the result', async () => {
    const { activityStream, submit, task, taskRegistry } = setup();
    await new Promise((resolve) => setTimeout(resolve, 0));

    activityStream.emit({
      id: 'complete', type: ActivityEventType.AGENT_BACKGROUND_COMPLETE,
      timestamp: Date.now(), data: { taskId: task.id },
    });
    expect(taskRegistry.drainCompletedAgentResults()).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(submit).not.toHaveBeenCalled();
  });
});
