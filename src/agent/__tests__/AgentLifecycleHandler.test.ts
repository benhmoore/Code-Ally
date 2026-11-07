import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentLifecycleHandler } from '../AgentLifecycleHandler.js';
import { ServiceRegistry } from '../../services/ServiceRegistry.js';
import type { IdleTaskCoordinator } from '../../services/IdleTaskCoordinator.js';

describe('AgentLifecycleHandler', () => {
  afterEach(() => vi.restoreAllMocks());

  it('holds idle admission through finalization and releases each agent exactly once', async () => {
    const coordinator = {
      cancel: vi.fn(),
      notifyUserMessage: vi.fn(),
      setOllamaActive: vi.fn(),
      checkAndRunIdleTasks: vi.fn().mockResolvedValue(undefined),
    } as unknown as IdleTaskCoordinator;
    vi.spyOn(ServiceRegistry.getInstance(), 'get').mockImplementation(name =>
      name === 'idle_task_coordinator' ? coordinator : null);
    const parent = new AgentLifecycleHandler('parent');
    const child = new AgentLifecycleHandler('child');
    parent.notifyUserMessageStart();
    child.notifyUserMessageStart();
    child.notifyUserMessageStart();
    await child.handlePostResponse([], vi.fn());
    await child.handlePostResponse([], vi.fn());
    expect(coordinator.setOllamaActive).toHaveBeenCalledTimes(2);
    expect(coordinator.cancel).toHaveBeenCalledTimes(2);
    expect(coordinator.checkAndRunIdleTasks).not.toHaveBeenCalled();
    child.notifyOllamaInactive();
    child.notifyOllamaInactive();
    expect(coordinator.setOllamaActive).toHaveBeenCalledTimes(3);
    parent.notifyOllamaInactive();
    expect(vi.mocked(coordinator.setOllamaActive).mock.calls).toEqual([[true], [true], [false], [false]]);
    expect(coordinator.checkAndRunIdleTasks).toHaveBeenCalledOnce();
  });
});
