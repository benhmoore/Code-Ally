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
    const child = new AgentLifecycleHandler('child', false);
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
    expect(coordinator.checkAndRunIdleTasks).not.toHaveBeenCalled();
  });

  it('leaves root session cleanup metadata untouched when a child completes', async () => {
    const session = { getCurrentSession: () => 'root', loadSession: vi.fn().mockResolvedValue({ metadata: { pendingToolCleanups: ['root-call'] } }), updateMetadata: vi.fn() };
    vi.spyOn(ServiceRegistry.getInstance(), 'get').mockImplementation(name => name === 'session_manager' ? session as any : name === 'auto_tool_cleanup' ? {} as any : null);
    const queue = vi.fn();
    await new AgentLifecycleHandler('child', false).handlePostResponse([], queue);
    expect(session.loadSession).not.toHaveBeenCalled();
    expect(session.updateMetadata).not.toHaveBeenCalled();
    expect(queue).not.toHaveBeenCalled();
    await new AgentLifecycleHandler('root').handlePostResponse([], queue);
    expect(queue).toHaveBeenCalledWith(['root-call']);
    expect(session.updateMetadata).toHaveBeenCalledWith('root', { pendingToolCleanups: [] });
  });
});
