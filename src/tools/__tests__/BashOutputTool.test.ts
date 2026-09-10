import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BashOutputTool } from '../BashOutputTool.js';
import { BashProcessManager, CircularBuffer } from '../../services/BashProcessManager.js';
import { BackgroundTaskRegistry } from '../../services/BackgroundTaskRegistry.js';
import { ActivityStream } from '../../services/ActivityStream.js';
import { ServiceRegistry } from '../../services/ServiceRegistry.js';

describe('BashOutputTool result delivery', () => {
  beforeEach(() => {
    const registry = ServiceRegistry.getInstance() as any;
    registry._services.clear();
    registry._descriptors.clear();
  });

  it.each(['running', 'stopping', 'exited'] as const)('coordinates retention and wake acknowledgment for %s shells', async status => {
    const stream = new ActivityStream();
    const processes = new BashProcessManager(1);
    const outputBuffer = new CircularBuffer();
    outputBuffer.append('verification output');
    const info = {
      id: 'shell-test', pid: 0, command: 'verification', process: {} as any,
      outputBuffer, startTime: 1, status, exitCode: status === 'exited' ? 0 : null,
      exitSignal: null, terminationSignal: null, blocksCompletion: true,
      exitTime: status === 'exited' ? 2 : null,
    };
    processes.addProcess(info);
    const tasks = new BackgroundTaskRegistry({ listTasks: () => [], acknowledgeCompletedResults: vi.fn() } as any, processes, stream);
    tasks.markWatched(info.id);
    const registry = ServiceRegistry.getInstance();
    registry.registerInstance('bash_process_manager', processes);
    registry.registerInstance('background_task_registry', tasks);

    const result = await new BashOutputTool(stream).execute({ shell_id: info.id });
    expect(result.success).toBe(true);
    expect(result.content).toBe('verification output');
    expect(tasks.isWatched(info.id)).toBe(status !== 'exited');
    const replace = () => processes.addProcess({ ...info, id: 'next' });
    if (status === 'exited') expect(replace).not.toThrow();
    else expect(replace).toThrow();
  });
});
