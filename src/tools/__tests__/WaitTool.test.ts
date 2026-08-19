import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActivityStream } from '../../services/ActivityStream.js';
import { ServiceRegistry } from '../../services/ServiceRegistry.js';
import { WaitTool } from '../WaitTool.js';

describe('WaitTool', () => {
  beforeEach(async () => {
    await ServiceRegistry.getInstance().shutdown();
  });

  afterEach(async () => {
    await ServiceRegistry.getInstance().shutdown();
  });

  it('yields to a turn interjection without cancelling the background task', async () => {
    const task = {
      id: 'agent-1',
      kind: 'agent',
      label: 'test agent',
      status: 'running',
      startTime: Date.now(),
      endTime: null,
      result: null,
      error: null,
      watched: false,
      blocksCompletion: true,
    } as const;
    let observedSignal: AbortSignal | undefined;
    const waitFor = vi.fn(async (_target: unknown, opts: { signal?: AbortSignal }) => {
      observedSignal = opts.signal;
      await new Promise<void>((resolve) => {
        if (opts.signal?.aborted) resolve();
        else opts.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      return [task];
    });
    ServiceRegistry.getInstance().registerInstance('background_task_registry', {
      get: () => task,
      waitFor,
    } as any);

    const controller = new AbortController();
    const tool = new WaitTool(new ActivityStream());
    const waiting = tool.execute(
      { all: true },
      'wait-call',
      undefined,
      false,
      false,
      { turnInterruptionSignal: controller.signal },
    );
    await vi.waitFor(() => expect(observedSignal).toBe(controller.signal));

    controller.abort();

    const result = await waiting;
    expect(result.success).toBe(true);
    expect(result.content).toContain('Wait interrupted by user');
    expect(result.content).toContain('still running');
    expect(task.status).toBe('running');
  });
});
