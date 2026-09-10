import { describe, expect, it, vi } from 'vitest';
import { runFleetDelegation, type FleetDelegationParams } from '../fleetDelegation.js';
import { BackgroundAgentManager } from '../../services/BackgroundAgentManager.js';
import { ActivityStream } from '../../services/ActivityStream.js';
import { ActivityEventType } from '../../types/index.js';

function fixture(): FleetDelegationParams {
  return { manager: new BackgroundAgentManager(), activityStream: new ActivityStream(),
    agentType: 'test', taskPrompt: 'work', callId: 'call', subAgent: { interrupt: vi.fn() } as any,
    pooledAgent: null, runInBackground: false, run: vi.fn(async () => 'verified'), cleanup: vi.fn(async () => {}) };
}

describe('delegation settlement ownership', () => {
  it.each([false, true])('keeps ownership through slow cleanup (background: %s)', async background => {
    vi.useFakeTimers();
    const params = fixture();
    params.runInBackground = background;
    let finish!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    params.cleanup = vi.fn(() => { entered(); return new Promise<void>(resolve => { finish = resolve; }); });
    const operation = runFleetDelegation(params);
    await ready;
    const task = params.manager.listTasks()[0];
    let stopped = false;
    const shutdown = params.manager.shutdown().then(() => { stopped = true; });
    try {
      await vi.advanceTimersByTimeAsync(6000);
      expect(stopped).toBe(false);
      expect(task.status).toBe('running');
      expect(params.manager.getCount()).toBe(1);
      finish();
      await operation;
      await shutdown;
      expect(task.status).toBe('done');
      expect(params.cleanup).toHaveBeenCalledOnce();
    } finally { finish(); vi.useRealTimers(); }
  });

  it('detaches during cleanup without duplicating cleanup or completion publication', async () => {
    const params = fixture();
    const emit = vi.spyOn(params.activityStream, 'emit');
    let finish!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    params.cleanup = vi.fn(() => { entered(); return new Promise<void>(resolve => { finish = resolve; }); });
    const operation = runFleetDelegation(params);
    await ready;
    const task = params.manager.listTasks()[0];
    task.detach();
    expect((await operation).backgrounded).toBe(true);
    finish();
    await task.promise;
    expect(params.cleanup).toHaveBeenCalledOnce();
    expect(emit.mock.calls.filter(([event]) => event.type === ActivityEventType.AGENT_BACKGROUND_COMPLETE)).toHaveLength(1);
    await params.manager.shutdown();
  });

  it('retains and reports detached cleanup failure through shutdown', async () => {
    const params = fixture();
    params.runInBackground = true;
    params.cleanup = vi.fn(async () => { throw new Error('release failed'); });
    await runFleetDelegation(params);
    const task = params.manager.listTasks()[0];
    await expect(task.promise).rejects.toThrow('Delegation cleanup failed');
    expect(task.status).toBe('error');
    expect(task.error).toContain('release failed');
    await expect(params.manager.shutdown()).rejects.toThrow('Background agent shutdown failed');
    expect(params.manager.getCount()).toBe(1);
    expect(params.cleanup).toHaveBeenCalledOnce();
  });

  it('owns admission-failure cleanup without starting the model', async () => {
    const params = fixture();
    await params.manager.shutdown();
    await expect(runFleetDelegation(params)).rejects.toThrow('shutting down');
    expect(params.run).not.toHaveBeenCalled();
    expect(params.cleanup).toHaveBeenCalledOnce();
  });
});
